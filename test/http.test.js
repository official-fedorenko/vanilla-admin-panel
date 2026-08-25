/**
 * Live HTTP tests for the auth/cabinet flows (login, 2FA, register, logout).
 * Runs the real server against an isolated, disposable SQLite file and a
 * random free port, so it doesn't touch the developer's db.sqlite or clash
 * with a server already running on PORT.
 *
 * TRUST_PROXY is turned on here so each test group can use a distinct
 * X-Forwarded-For IP and get its own rate-limit bucket, instead of tests
 * tripping each other's login/register rate limits.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const dbPath = path.join(os.tmpdir(), `vanilla-admin-test-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_PATH = dbPath;
process.env.TRUST_PROXY = 'true';

const server = require('../server');
const { db, dbReady } = require('../db');
const { totp } = require('../src/totp');

let baseUrl;
// id инструмента, который тесты публичной карточки создают для себя сами:
// автосид демо-инструмента отключён, поэтому на свежей БД tools пустая.
let publicToolId;

before(async () => {
  // Schema creation + default-user/article seeding in db.js is async — wait
  // for it, otherwise the first request or two can race an empty database.
  await dbReady;

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  // Инструмент для тестов публичной карточки (/api/public/tool).
  publicToolId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tools (name, category, brand, model, serial_number,
                          inventory_number, status, purchase_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'available', '2024-01-15', ?)`,
      ['Тестовый перфоратор', 'Перфоратор', 'Bosch', 'GBH 2-28',
       'TEST-SN-0001', 'INV-TEST-0001', 'Служебная заметка (не для публичной карточки)'],
      function (err) { err ? reject(err) : resolve(this.lastID); }
    );
  });
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.promises.rm(dbPath + suffix, { force: true }).catch(() => {});
  }
});

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

async function api(urlPath, { method = 'GET', body, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['X-Forwarded-For'] = ip;

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }

  return { status: res.status, json, cookie: extractCookie(res) };
}

test('public articles endpoint returns the seeded article without auth', async () => {
  const { status, json } = await api('/api/public/articles');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.some(a => a.title.includes('Добро пожаловать')));
});

test('public settings endpoint returns key/value pairs without auth', async () => {
  const { status, json } = await api('/api/public/settings');
  assert.strictEqual(status, 200);
  assert.ok(json.some(s => s.key === 'site_name'));
});

test('public tool card endpoint returns identification fields without auth and hides service data', async () => {
  const { status, json } = await api(`/api/public/tool?id=${publicToolId}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.ok(json.tool);
  assert.strictEqual(json.tool.id, publicToolId);
  assert.ok(json.tool.name);
  // Служебные данные не должны утекать в публичную карточку.
  assert.strictEqual(json.tool.notes, undefined);
  assert.strictEqual(json.history, undefined);
  assert.strictEqual(json.stats, undefined);
});

test('public tool card endpoint returns 404 for a missing tool', async () => {
  const { status } = await api('/api/public/tool?id=999999');
  assert.strictEqual(status, 404);
});

test('login rejects a wrong password', async () => {
  const { status, json } = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.1.1',
    body: { username: 'superadmin', password: 'wrong-password' }
  });
  assert.strictEqual(status, 401);
  assert.strictEqual(json.success, false);
});

let superadminCookie;

test('login succeeds with correct credentials, sets a session cookie, and warns about the default account', async () => {
  const { status, json, cookie } = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.1.2',
    body: { username: 'superadmin', password: '1234qwer' }
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.user.username, 'superadmin');
  assert.ok(json.securityWarning, 'default account should carry a security warning');
  assert.ok(cookie && cookie.startsWith('session='));
  superadminCookie = cookie;
});

test('auth/me rejects requests without a session cookie', async () => {
  const { status } = await api('/api/auth/me');
  assert.strictEqual(status, 401);
});

test('auth/me returns the logged-in user for a valid session cookie', async () => {
  const { status, json } = await api('/api/auth/me', { cookie: superadminCookie });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.user.username, 'superadmin');
  assert.strictEqual(json.user.role, 'Superadmin');
});

test('cabinet/me returns the full profile for the logged-in user', async () => {
  const { status, json } = await api('/api/cabinet/me', { cookie: superadminCookie });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.user.email, 'superadmin@example.com');
});

test('superadmin-only /api/users works with a superadmin session', async () => {
  const { status, json } = await api('/api/users', { cookie: superadminCookie });
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.some(u => u.username === 'superadmin'));
});

test('logout invalidates the session server-side, not just on the client', async () => {
  const loggedOut = await api('/api/auth/logout', { method: 'POST', cookie: superadminCookie });
  assert.strictEqual(loggedOut.status, 200);

  const after2 = await api('/api/cabinet/me', { cookie: superadminCookie });
  assert.strictEqual(after2.status, 401, 'the old cookie must be rejected once the session is destroyed server-side');
});

test('rapid repeated login attempts from the same IP get rate-limited', async () => {
  const first = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.2.1',
    body: { username: 'superadmin', password: 'wrong' }
  });
  assert.strictEqual(first.status, 401);

  const second = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.2.1',
    body: { username: 'superadmin', password: 'wrong' }
  });
  assert.strictEqual(second.status, 429);
});

test('check-username reports an existing username as unavailable', async () => {
  const { status, json } = await api('/api/auth/check-username?username=superadmin', { ip: '10.0.4.1' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.available, false);
});

test('check-username reports a fresh username as available', async () => {
  const { status, json } = await api('/api/auth/check-username?username=brandnewuser', { ip: '10.0.4.2' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.available, true);
});

test('register rejects honeypot-filled submissions as bot traffic', async () => {
  const { status, json } = await api('/api/auth/register', {
    method: 'POST', ip: '10.0.3.1',
    body: {
      username: 'botuser', email: 'bot@example.com', password: 'password123',
      website: 'http://spam.example' // honeypot field a real user would never fill in
    }
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(json.success, false);
});

test('register creates the account and logs the user in when validation passes', async () => {
  const { status, json, cookie } = await api('/api/auth/register', {
    method: 'POST', ip: '10.0.3.2',
    body: {
      username: 'freshtestuser', email: 'freshtestuser@example.com', password: 'password123',
      botNum1: 5, botNum2: 3, botOp: '+', botAnswer: 8
    }
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.user.role, 'User');
  assert.ok(cookie && cookie.startsWith('session='));
});

test('register rejects a duplicate username', async () => {
  const { status, json } = await api('/api/auth/register', {
    method: 'POST', ip: '10.0.3.3',
    body: {
      username: 'freshtestuser', email: 'someoneelse@example.com', password: 'password123',
      botNum1: 2, botNum2: 2, botOp: '+', botAnswer: 4
    }
  });
  assert.strictEqual(status, 409);
  assert.strictEqual(json.success, false);
});

test('full 2FA setup + login flow works end-to-end', async () => {
  const login1 = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.5.1',
    body: { username: 'user', password: '1234qwer' }
  });
  assert.strictEqual(login1.status, 200);
  assert.strictEqual(login1.json.requires2FA, undefined);
  const cookie = login1.cookie;

  const setup = await api('/api/cabinet/2fa/setup', {
    method: 'POST', cookie,
    body: { currentPassword: '1234qwer' }
  });
  assert.strictEqual(setup.status, 200);
  const { secret } = setup.json;
  assert.ok(secret);

  const verify = await api('/api/cabinet/2fa/verify', {
    method: 'POST', cookie,
    body: { code: totp(secret) }
  });
  assert.strictEqual(verify.status, 200);
  assert.strictEqual(verify.json.success, true);

  await api('/api/auth/logout', { method: 'POST', cookie });

  // Different IP for the second login so it isn't rate-limited by the first.
  const login2 = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.5.2',
    body: { username: 'user', password: '1234qwer' }
  });
  assert.strictEqual(login2.status, 200);
  assert.strictEqual(login2.json.requires2FA, true);
  assert.ok(login2.json.pendingToken);
  assert.strictEqual(login2.cookie, null, 'no session should be issued before the 2FA code is verified');

  const finish = await api('/api/auth/login-2fa', {
    method: 'POST',
    body: { pendingToken: login2.json.pendingToken, code: totp(secret) }
  });
  assert.strictEqual(finish.status, 200);
  assert.strictEqual(finish.json.success, true);
  assert.ok(finish.cookie && finish.cookie.startsWith('session='));

  const me = await api('/api/auth/me', { cookie: finish.cookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.username, 'user');
});

test('admin static pages redirect to login when there is no session', async () => {
  const res = await fetch(`${baseUrl}/admin/`, { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.ok(res.headers.get('location').includes('/admin/login.html'));
});

test('public tool card respects GLOBAL visibility settings and enable switch', async () => {
  // Свежий логин админа (superadmin-сессию к этому моменту уже разлогинили).
  const login = await api('/api/auth/login', {
    method: 'POST', ip: '10.0.9.9',
    body: { username: 'admin', password: '1234qwer' }
  });
  assert.strictEqual(login.status, 200);
  const cookie = login.cookie;

  // По умолчанию карточка включена и показывает все поля.
  const def = await api(`/api/public/tool?id=${publicToolId}`);
  assert.strictEqual(def.status, 200);
  assert.ok(def.json.tool.serial_number);

  // Глобально прячем серийный/инвентарный номера и статус.
  const saved = await api('/api/settings', {
    method: 'POST', cookie,
    body: {
      public_card_enabled: 'true',
      public_card_show_serial: 'false',
      public_card_show_inventory: 'false',
      public_card_show_status: 'false'
    }
  });
  assert.strictEqual(saved.status, 200);

  // Публичная карточка больше не отдаёт скрытые поля, но имя/бренд на месте.
  const pub = await api(`/api/public/tool?id=${publicToolId}`);
  assert.strictEqual(pub.status, 200);
  assert.ok(pub.json.tool.name);
  assert.ok(pub.json.tool.brand);
  assert.strictEqual(pub.json.tool.serial_number, undefined);
  assert.strictEqual(pub.json.tool.inventory_number, undefined);
  assert.strictEqual(pub.json.tool.status, undefined);

  // Глобально выключаем карточку — публичный доступ закрыт (404).
  const off = await api('/api/settings', {
    method: 'POST', cookie, body: { public_card_enabled: 'false' }
  });
  assert.strictEqual(off.status, 200);
  const pubOff = await api(`/api/public/tool?id=${publicToolId}`);
  assert.strictEqual(pubOff.status, 404);
});

test('worklogs: user adds own entry, sees it; admin sees summary; user is forbidden from summary', async () => {
  // Регистрируем свежего пользователя (у дефолтного `user` включена 2FA
  // предыдущим тестом, поэтому берём чистый аккаунт без 2FA).
  const reg = await api('/api/auth/register', {
    method: 'POST', ip: '10.20.1.1',
    body: {
      username: 'worker_wl', email: 'worker_wl@example.com', password: 'password123',
      botNum1: 4, botNum2: 3, botOp: '+', botAnswer: 7
    }
  });
  assert.strictEqual(reg.status, 200);
  const uc = reg.cookie;
  assert.ok(uc && uc.startsWith('session='));

  // Добавляем запись
  const add = await api('/api/worklogs', {
    method: 'POST', cookie: uc,
    body: { work_date: '2026-08-22', hours: 8, note: 'Тест' }
  });
  assert.strictEqual(add.status, 201);

  // Некорректные часы отклоняются
  const bad = await api('/api/worklogs', {
    method: 'POST', cookie: uc, body: { work_date: '2026-08-22', hours: 99 }
  });
  assert.strictEqual(bad.status, 400);

  // Свои записи + итог
  const mine = await api('/api/worklogs/mine', { cookie: uc });
  assert.strictEqual(mine.status, 200);
  assert.ok(mine.json.entries.length >= 1);
  assert.ok(mine.json.total >= 8);

  // Пользователю нельзя смотреть сводку по всем
  const denied = await api('/api/worklogs/summary', { cookie: uc });
  assert.strictEqual(denied.status, 403);

  // Админ видит сводку с этим пользователем
  const alogin = await api('/api/auth/login', {
    method: 'POST', ip: '10.20.2.2',
    body: { username: 'admin', password: '1234qwer' }
  });
  assert.strictEqual(alogin.status, 200);
  const sum = await api('/api/worklogs/summary', { cookie: alogin.cookie });
  assert.strictEqual(sum.status, 200);
  assert.ok(sum.json.users.some(u => u.username === 'worker_wl' && u.total_hours >= 8));
});
