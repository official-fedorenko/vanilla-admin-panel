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
const { dbReady } = require('../db');
const { totp } = require('../src/totp');

let baseUrl;

before(async () => {
  // Schema creation + default-user/article seeding in db.js is async — wait
  // for it, otherwise the first request or two can race an empty database.
  await dbReady;

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
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
