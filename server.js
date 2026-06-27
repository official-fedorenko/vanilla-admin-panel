const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, verifyPassword, hashPassword, saveSession, loadSessionsIntoMap, deleteSession, cleanupExpiredSessions } = require('./db');
const logger = require('./src/logger');

// === Modular route handlers (light split from monolithic server.js) ===
const { sendJson, getJsonBody, logAction } = require('./src/utils');
const handleDashboard = require('./src/routes/dashboard');
const handleArticles = require('./src/routes/articles');
const handleMedia = require('./src/routes/media');
const handleSettings = require('./src/routes/settings');
const handleSupport = require('./src/routes/support');
const handleUsers = require('./src/routes/users');
const handleLogs = require('./src/routes/logs');
const handleResetDemo = require('./src/routes/resetDemo');
const handleBackup = require('./src/routes/backup');
const handleTwoFactor = require('./src/routes/twoFactor');
const { verifyTotp } = require('./src/totp');

const PORT = parseInt(process.env.PORT, 10) || 3080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLIENT_DIR = path.join(__dirname, 'client');
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60; // сутки

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const sessions = new Map();
loadSessionsIntoMap(sessions);
cleanupExpiredSessions();

// Короткоживущие токены между "пароль принят" и "код 2FA подтверждён".
// Полноценную сессию не выдаём, пока не введён код.
const pendingTwoFactorLogins = new Map(); // pendingToken -> { userId, expires }
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

function issueSession(req, res, userRow) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionUser = { id: userRow.id, username: userRow.username, role: userRow.role };
  sessions.set(token, sessionUser);
  saveSession(token, sessionUser);

  logAction(userRow.username, 'Вход в систему');

  const isDefaultAccount = ['superadmin', 'admin', 'user'].includes(userRow.username.toLowerCase());
  const securityNote = isDefaultAccount
    ? '⚠️ This is a default account. Change the password immediately via the Users section (Superadmin) or profile.'
    : null;

  res.writeHead(200, {
    'Set-Cookie': buildSessionCookie(token, req, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS }),
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify({
    success: true,
    user: { username: userRow.username, role: userRow.role },
    securityWarning: securityNote
  }));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

// HTML отдаём без кэша (доступ зависит от сессии: логин/редиректы),
// статичные ассеты — с умеренным кэшем и обязательной ревалидацией,
// т.к. у файлов нет версионирования в имени (cache-busting).
const NO_CACHE_EXTENSIONS = new Set(['.html']);
const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';
const NO_CACHE_CONTROL = 'no-cache';

function getStaticCacheControl(ext) {
  return NO_CACHE_EXTENSIONS.has(ext) ? NO_CACHE_CONTROL : STATIC_ASSET_CACHE_CONTROL;
}

function parseCookies(request) {
  const list = {};
  const rc = request.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies.session;
  if (sessionToken && sessions.has(sessionToken)) {
    return sessions.get(sessionToken);
  }
  return null;
}

// Сервер сам по себе работает по HTTP — HTTPS обычно терминируется на
// reverse-proxy (nginx и т.п.). Доверяем заголовку X-Forwarded-Proto только
// если оператор явно включил TRUST_PROXY=true в .env (иначе заголовок легко
// подделать и он не дает реальной гарантии шифрования соединения).
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

function isHttpsRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') return true;
  return false;
}

function buildSessionCookie(token, req, { maxAgeSeconds, clear = false } = {}) {
  const parts = [`session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (clear) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join('; ');
}

// === Необязательный IP allowlist для входа в админку ===
// Если переменная задана, вход (и регистрация) разрешён только с этих IP.
// Полезно для приватных/внутренних установок. Пусто/не задано — без ограничений.
const ADMIN_IP_ALLOWLIST = (process.env.ADMIN_IP_ALLOWLIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isIpAllowed(ip) {
  if (ADMIN_IP_ALLOWLIST.length === 0) return true;
  return ADMIN_IP_ALLOWLIST.includes(ip);
}

// === Простая защита от ботов (rate limit + honeypot) ===
const rateLimits = new Map(); // key -> { attempts, first, last }

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // окно, через которое счётчик попыток сбрасывается
const RATE_LIMIT_ENTRY_TTL_MS = 2 * 60 * 60 * 1000; // возраст записи, после которого её можно удалить
const RATE_LIMIT_CLEANUP_PROBABILITY = 0.03; // шанс запуска очистки старых записей на каждый вызов

// Параметры конкретных rate-limit'ов (попыток / минимальный интервал между ними, мс)
const LOGIN_RATE_LIMIT = { maxAttempts: 8, minIntervalMs: 1800 };
const REGISTER_RATE_LIMIT = { maxAttempts: 3, minIntervalMs: 40000 };
const CHECK_USERNAME_RATE_LIMIT = { maxAttempts: 20, minIntervalMs: 1200 };

function getClientIP(req) {
  // X-Forwarded-For подделывается клиентом сколь угодно легко — доверяем ему
  // только когда оператор подтвердил (TRUST_PROXY=true), что сервер стоит за
  // reverse-proxy, который сам устанавливает этот заголовок. Иначе rate-limit
  // и IP allowlist можно было бы обойти одним заголовком в запросе.
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip, action = 'register', maxAttempts = 5, minIntervalMs = 30000) {
  const now = Date.now();
  const key = `${ip}:${action}`;
  let entry = rateLimits.get(key);

  if (!entry) {
    entry = { attempts: 0, first: now, last: 0 };
    rateLimits.set(key, entry);
  }

  if (now - entry.first > RATE_LIMIT_WINDOW_MS) {
    entry.attempts = 0;
    entry.first = now;
  }

  // Слишком частые попытки
  if (now - entry.last < minIntervalMs) {
    return { limited: true, reason: 'too_fast' };
  }

  if (entry.attempts >= maxAttempts) {
    return { limited: true, reason: 'max_attempts' };
  }

  entry.attempts += 1;
  entry.last = now;

  // Редкая очистка
  if (Math.random() < RATE_LIMIT_CLEANUP_PROBABILITY) {
    for (const [k, e] of rateLimits) {
      if (now - e.first > RATE_LIMIT_ENTRY_TTL_MS) rateLimits.delete(k);
    }
  }

  return { limited: false };
}

// === Settings cache (for maintenance_mode etc) + helpers ===
let cachedSettings = {};

function reloadSettingsCache() {
  db.all("SELECT key, value FROM settings", [], (err, rows) => {
    if (!err && rows) {
      cachedSettings = {};
      rows.forEach(r => { cachedSettings[r.key] = r.value; });
    }
  });
}
reloadSettingsCache();

// === Базовые security-заголовки (применяются ко всем ответам) ===
// Внимание: страницы используют инлайн onclick="" и style="", а также
// подключают Quill/Lucide с CDN, поэтому 'unsafe-inline' для script/style
// оставлен осознанно — полностью убрать его можно только после рефакторинга
// фронтенда на addEventListener и внешние стили.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com https://cdn.quilljs.com 'unsafe-inline'",
  "style-src 'self' https://cdn.quilljs.com 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
}

function sendHtml404(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Страница не найдена</title><style>body{font-family:Inter,system-ui,sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{text-align:center;padding:48px 32px;background:rgba(20,20,28,.85);border:1px solid rgba(255,255,255,.08);border-radius:20px;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.5)}.code{font-size:96px;font-weight:800;line-height:1;margin:0 0 8px;background:linear-gradient(135deg,#8a2be2,#00d2ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.msg{color:#a0a0ab;margin-bottom:28px;font-size:15px} .links a{color:#00d2ff;text-decoration:none;margin:0 8px} .links a:hover{text-decoration:underline}</style></head><body><div class="box"><div class="code">404</div><div class="msg">Страница не найдена или была перемещена</div><div class="links"><a href="/">На главную</a><a href="/admin/">В админ-панель</a></div></div></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  applySecurityHeaders(res);

  // Страницы сами объявляют свою иконку через <link rel="icon" data:...>,
  // отдельного favicon.ico в проекте нет — отвечаем тихо, без шумных 404 в логах.
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Basic global error boundary for uncaught errors in handlers
  try {

  // Логируем только важное (или включи DEBUG=true для всех запросов)
  if (process.env.DEBUG || pathname.startsWith('/api/')) {
    // console.log(`[Request] ${method} ${pathname}`);
  }

  const user = getSessionUser(req);

  // Maintenance mode — affects public visitors (admins always have access)
  const isMaintenance = cachedSettings['maintenance_mode'] === 'true';
  const isPublicNonApi = !pathname.startsWith('/admin') &&
                         !pathname.startsWith('/api/') &&
                         !pathname.startsWith('/uploads/') &&
                         pathname !== '/favicon.ico';

  if (isMaintenance && !user && isPublicNonApi) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>На обслуживании</title><style>body{font-family:Inter,system-ui,sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.m{padding:48px 40px;background:rgba(20,20,28,.85);border:1px solid rgba(255,255,255,.08);border-radius:20px;text-align:center;max-width:420px}.icon{font-size:48px;margin-bottom:12px}.title{font-size:22px;font-weight:700;margin-bottom:8px;color:#ff6b6b}.desc{color:#a0a0ab;font-size:14px;line-height:1.5} .admin-link{color:#00d2ff;text-decoration:none} .admin-link:hover{text-decoration:underline}</style></head><body><div class="m"><div class="icon">🛠️</div><div class="title">Технические работы</div><div class="desc">Сайт временно недоступен для посетителей.<br>Администраторы могут войти через панель управления.</div><div style="margin-top:20px"><a class="admin-link" href="/admin/">Перейти в админ-панель →</a></div></div></body></html>`);
    return;
  }

  // Public articles
  if (pathname === '/api/public/articles' && method === 'GET') {
    db.all("SELECT id, title, content, created_at FROM articles WHERE status = 'published' ORDER BY id DESC LIMIT 1000", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
    return;
  }

  // Public settings
  if (pathname === '/api/public/settings' && method === 'GET') {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
    return;
  }

  // Login (с защитой от брутфорса)
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const ip = getClientIP(req);
      if (!isIpAllowed(ip)) {
        return sendJson(res, 403, { success: false, message: 'Вход с этого IP-адреса запрещён' });
      }
      const loginLimit = isRateLimited(ip, 'login', LOGIN_RATE_LIMIT.maxAttempts, LOGIN_RATE_LIMIT.minIntervalMs);
      if (loginLimit.limited) {
        return sendJson(res, 429, { success: false, message: 'Слишком много попыток входа. Подождите немного.' });
      }

      const { username, password } = await getJsonBody(req);
      if (!username || !password) {
        return sendJson(res, 400, { success: false, message: 'Имя пользователя и пароль обязательны' });
      }

      db.get("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [username], (err, userRow) => {
        if (err || !userRow) {
          return sendJson(res, 401, { success: false, message: 'Неверное имя пользователя или пароль' });
        }

        const isValid = verifyPassword(password, userRow.password_hash);
        if (!isValid) {
          return sendJson(res, 401, { success: false, message: 'Неверное имя пользователя или пароль' });
        }

        if (userRow.two_factor_enabled) {
          // Заодно выметаем просроченные записи — карта живёт долго, а
          // отдельного таймера для неё нет смысла заводить.
          const now = Date.now();
          for (const [k, v] of pendingTwoFactorLogins) {
            if (v.expires < now) pendingTwoFactorLogins.delete(k);
          }

          const pendingToken = crypto.randomBytes(32).toString('hex');
          pendingTwoFactorLogins.set(pendingToken, { userId: userRow.id, expires: now + PENDING_2FA_TTL_MS });
          return sendJson(res, 200, { success: true, requires2FA: true, pendingToken });
        }

        issueSession(req, res, userRow);
      });
    } catch (e) {
      sendJson(res, 500, { success: false, message: 'Внутренняя ошибка сервера' });
    }
    return;
  }

  // Завершение входа вторым фактором (TOTP-код из приложения-аутентификатора)
  if (pathname === '/api/auth/login-2fa' && method === 'POST') {
    try {
      const { pendingToken, code } = await getJsonBody(req);
      const pending = pendingToken && pendingTwoFactorLogins.get(pendingToken);

      if (!pending || pending.expires < Date.now()) {
        if (pendingToken) pendingTwoFactorLogins.delete(pendingToken);
        return sendJson(res, 400, { success: false, message: 'Сессия подтверждения истекла, войдите заново' });
      }

      db.get("SELECT * FROM users WHERE id = ?", [pending.userId], (err, userRow) => {
        if (err || !userRow || !userRow.two_factor_enabled) {
          pendingTwoFactorLogins.delete(pendingToken);
          return sendJson(res, 400, { success: false, message: 'Сессия подтверждения истекла, войдите заново' });
        }

        if (!verifyTotp(userRow.two_factor_secret, code)) {
          return sendJson(res, 400, { success: false, message: 'Неверный код подтверждения' });
        }

        pendingTwoFactorLogins.delete(pendingToken);
        issueSession(req, res, userRow);
      });
    } catch (e) {
      sendJson(res, 500, { success: false, message: 'Внутренняя ошибка сервера' });
    }
    return;
  }

  // === Регистрация (с защитой от ботов) ===
  if (pathname === '/api/auth/register' && method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const { username, email, password, hp, website, address } = body; // hp, website, address — honeypot поля

      // 1. Honeypot — если заполнено, это бот
      if (hp || website || address) {
        return sendJson(res, 400, { success: false, message: 'Ошибка регистрации' });
      }

      // 2. Rate limiting (усилено)
      const ip = getClientIP(req);
      const limitCheck = isRateLimited(ip, 'register', REGISTER_RATE_LIMIT.maxAttempts, REGISTER_RATE_LIMIT.minIntervalMs);
      if (limitCheck.limited) {
        return sendJson(res, 429, { 
          success: false, 
          message: 'Слишком много попыток регистрации. Попробуйте позже.' 
        });
      }

      // 3. Проверка случайного вопроса защиты от ботов (серверная верификация)
      const { botNum1, botNum2, botOp, botAnswer } = body;
      if (!botNum1 || !botNum2 || !botOp || !botAnswer) {
        return sendJson(res, 400, { success: false, message: 'Не пройдена проверка защиты от ботов' });
      }
      const n1 = parseInt(botNum1, 10);
      const n2 = parseInt(botNum2, 10);
      const expected = botOp === '+' ? (n1 + n2) : (n1 - n2);
      if (parseInt(botAnswer, 10) !== expected || n1 < 1 || n2 < 1 || n1 > 20 || n2 > 20) {
        return sendJson(res, 400, { success: false, message: 'Неверный ответ на вопрос защиты от ботов' });
      }

      // 4. Проверка, разрешена ли регистрация (из настроек)
      db.get("SELECT value FROM settings WHERE key = 'allow_registration'", [], (err, row) => {
        const allowed = row && row.value === 'true';
        if (!allowed) {
          return sendJson(res, 403, { success: false, message: 'Регистрация сейчас отключена' });
        }

        // Валидация
        if (!username || !email || !password) {
          return sendJson(res, 400, { success: false, message: 'Все поля обязательны' });
        }
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
          return sendJson(res, 400, { success: false, message: 'Имя пользователя: 3-20 символов, только буквы, цифры и _' });
        }
        if (password.length < 8) {
          return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 8 символов' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return sendJson(res, 400, { success: false, message: 'Некорректный email' });
        }

        // Проверяем уникальность
        db.get(
          "SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
          [username, email],
          (err2, existing) => {
            if (existing) {
              return sendJson(res, 409, { success: false, message: 'Пользователь с таким именем или email уже существует' });
            }

            const password_hash = hashPassword(password);

            db.run(
              "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'User')",
              [username, email, password_hash],
              function (err3) {
                if (err3) {
                  logger.error('Register error:', err3);
                  return sendJson(res, 500, { success: false, message: 'Не удалось создать аккаунт' });
                }

                const newUserId = this.lastID;
                logAction(username, 'Регистрация нового пользователя');

                // Автоматически логиним пользователя
                const token = crypto.randomBytes(32).toString('hex');
                const sessionUser = { id: newUserId, username, role: 'User' };
                sessions.set(token, sessionUser);
                saveSession(token, sessionUser);

                res.writeHead(200, {
                  'Set-Cookie': buildSessionCookie(token, req, { maxAgeSeconds: SESSION_MAX_AGE_SECONDS }),
                  'Content-Type': 'application/json; charset=utf-8'
                });
                res.end(JSON.stringify({
                  success: true,
                  user: { username, role: 'User' }
                }));
              }
            );
          }
        );
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // Проверка доступности username (с защитой от перебора)
  if (pathname === '/api/auth/check-username' && method === 'GET') {
    const username = parsedUrl.searchParams.get('username') || '';
    const ip = getClientIP(req);

    // Лёгкий rate limit на проверку имён (чтобы не спамили)
    const limitCheck = isRateLimited(ip, 'check-username', CHECK_USERNAME_RATE_LIMIT.maxAttempts, CHECK_USERNAME_RATE_LIMIT.minIntervalMs);
    if (limitCheck.limited) {
      return sendJson(res, 429, { success: false, available: false });
    }

    if (!/^[a-zA-Z0-9_]{3,}$/.test(username)) {
      return sendJson(res, 200, { success: true, available: false });
    }

    db.get(
      "SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)",
      [username],
      (err, row) => {
        sendJson(res, 200, { success: true, available: !row });
      }
    );
    return;
  }

  // Auth check endpoints (needed for cabinet after login)
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = getSessionUser(req);
    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    }
    return sendJson(res, 200, { success: true, user });
  }

  if (pathname === '/api/cabinet/me' && method === 'GET') {
    const user = getSessionUser(req);
    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    }
    db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [user.id], (err, row) => {
      if (err || !row) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
      sendJson(res, 200, { success: true, user: row });
    });
    return;
  }

  // Обновление профиля пользователя (email, пароль, avatar_url)
  if (pathname === '/api/cabinet/profile' && method === 'PUT') {
    const current = getSessionUser(req);
    if (!current) {
      return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    }

    (async () => {
      try {
        const body = await getJsonBody(req);
        const { email, password, currentPassword, avatar_url } = body;

        db.get("SELECT * FROM users WHERE id = ?", [current.id], (err, dbUser) => {
          if (err || !dbUser) {
            return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
          }

          const fields = [];
          const values = [];

          if (email && email !== dbUser.email) {
            fields.push('email = ?');
            values.push(email);
          }

          if (avatar_url) {
            fields.push('avatar_url = ?');
            values.push(avatar_url);
          }

          if (password) {
            if (!currentPassword) {
              return sendJson(res, 400, { success: false, message: 'Для смены пароля укажите текущий пароль' });
            }
            if (password.length < 8) {
              return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 8 символов' });
            }
            const ok = verifyPassword(currentPassword, dbUser.password_hash);
            if (!ok) {
              return sendJson(res, 400, { success: false, message: 'Неверный текущий пароль' });
            }
            fields.push('password_hash = ?');
            values.push(hashPassword(password));
          }

          if (fields.length === 0) {
            return sendJson(res, 400, { success: false, message: 'Нет изменений для сохранения' });
          }

          values.push(current.id);

          db.run(
            `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
            values,
            function (updateErr) {
              if (updateErr) {
                const msg = updateErr.message.includes('UNIQUE') ? 'Такой email уже используется' : 'Ошибка сохранения профиля';
                return sendJson(res, 400, { success: false, message: msg });
              }
              logAction(current.username, 'Обновил свой профиль');
              // Вернём свежие данные
              db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [current.id], (e2, fresh) => {
                sendJson(res, 200, { success: true, message: 'Профиль обновлён', user: fresh });
              });
            }
          );
        });
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  // === Full admin API handlers (restored for full functionality) ===

  // Logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    const token = cookies.session;
    if (token) {
      sessions.delete(token);
      deleteSession(token);
    }
    res.writeHead(200, {
      'Set-Cookie': buildSessionCookie('', req, { clear: true }),
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Dashboard stats
  if (pathname === '/api/dashboard/stats' && method === 'GET') {
    return handleDashboard(req, res, user);
  }

  // CRUD articles
  if (pathname.startsWith('/api/crud/articles')) {
    return handleArticles(req, res, user, parsedUrl, method);
  }

  // Media
  if (pathname === '/api/media') {
    return handleMedia(req, res, user, parsedUrl, method, { UPLOADS_DIR });
  }

  // Settings
  if (pathname === '/api/settings') {
    return handleSettings(req, res, user, parsedUrl, method, { reloadSettingsCache });
  }

  // Support
  if (pathname.startsWith('/api/support/')) {
    return handleSupport(req, res, user, parsedUrl, method);
  }

  // Two-factor authentication (setup/verify/disable/status)
  if (pathname.startsWith('/api/cabinet/2fa/')) {
    return handleTwoFactor(req, res, user, parsedUrl, method);
  }

  // Users (superadmin only)
  if (pathname === '/api/users') {
    return handleUsers(req, res, user, parsedUrl, method);
  }

  // Logs
  if (pathname === '/api/logs') {
    return handleLogs(req, res, user, parsedUrl, method);
  }

  // Superadmin-only: reset demo data
  if (pathname === '/api/admin/reset-demo' && method === 'POST') {
    return handleResetDemo(req, res, user, parsedUrl, method, { UPLOADS_DIR, reloadSettingsCache });
  }

  // Superadmin-only: download a full backup of the SQLite database
  if (pathname === '/api/admin/backup' && method === 'GET') {
    return handleBackup(req, res, user, parsedUrl, method);
  }

  // Other API fall to 404 for now
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
  }

  // Serve uploaded media files (avatars, article images, media library URLs)
  // This was missing — files were saved but 404 on direct access
  if (pathname.startsWith('/uploads/')) {
    const rel = pathname.replace(/^\/uploads\//, '');
    const fullPath = path.join(UPLOADS_DIR, rel);

    fs.access(fullPath, fs.constants.F_OK, (err) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Файл не найден (404)');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    return;
  }

  // Static files
  let fullStaticPath;
  let staticPath = pathname;

  if (pathname.startsWith('/admin')) {
    staticPath = pathname.replace('/admin', '') || '/index.html';
    if (staticPath === '/') staticPath = '/index.html';
    fullStaticPath = path.join(PUBLIC_DIR, staticPath);

    if (staticPath.endsWith('.html') || staticPath === '/index.html') {
      if (!user && staticPath !== '/login.html') {
        res.writeHead(302, { 'Location': '/admin/login.html' });
        res.end();
        return;
      }
      if (user && staticPath === '/login.html') {
        res.writeHead(302, { 'Location': '/admin/' });
        res.end();
        return;
      }
    }
  } else {
    staticPath = pathname === '/' ? '/index.html' : pathname;
    fullStaticPath = path.join(CLIENT_DIR, staticPath);
  }

  fs.access(fullStaticPath, fs.constants.F_OK, (err) => {
    if (err) {
      sendHtml404(res);
      return;
    }

    const ext = path.extname(fullStaticPath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': getStaticCacheControl(ext)
    });
    fs.createReadStream(fullStaticPath).pipe(res);
  });

  } catch (err) {
    logger.error('Unhandled error in request handler:', err);
    try {
      sendJson(res, 500, { success: false, message: 'Internal server error' });
    } catch (_) {
      // last resort
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Internal server error' }));
      }
    }
  }
});

server.listen(PORT, () => {
  console.log(`Админка успешно запущена на http://localhost:${PORT}`);
  console.log('='.repeat(70));
  console.log('🚨  BETA RELEASE — SECURITY WARNING');
  console.log('   Default accounts are EXTREMELY insecure. Change passwords IMMEDIATELY:');
  console.log('');
  console.log('     superadmin / 1234qwer   (Superadmin — полный доступ)');
  console.log('     admin      / 1234qwer   (Admin)');
  console.log('     user       / 1234qwer   (User)');
  console.log('');
  console.log('   Recommended first actions:');
  console.log('     1. Login as superadmin');
  console.log('     2. Go to "Пользователи" (Users) and change ALL passwords');
  console.log('     3. (Optional) Disable registration in Settings');
  console.log('');
  console.log('   To completely reset demo data:');
  console.log('     1. Stop the server');
  console.log('     2. Delete db.sqlite');
  console.log('     3. Restart (fresh DB + demo data will be created)');
  console.log('');
  console.log('   Never expose this directly to the internet without a reverse proxy + HTTPS.');
  console.log('='.repeat(70));
});
