const crypto = require('crypto');
const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, verifyPassword, hashPassword } = require('../../db');
const { verifyTotp } = require('../totp');
const logger = require('../logger');
const { getClientIP, isRateLimited } = require('../rateLimit');
const {
  getSessionToken,
  buildSessionCookie,
  createSession,
  destroySession,
  SESSION_MAX_AGE_SECONDS
} = require('../session');

// Необязательный IP allowlist для входа в админку.
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

// Параметры конкретных rate-limit'ов (попыток / минимальный интервал между ними, мс)
const LOGIN_RATE_LIMIT = { maxAttempts: 8, minIntervalMs: 1800 };
const REGISTER_RATE_LIMIT = { maxAttempts: 3, minIntervalMs: 40000 };
const CHECK_USERNAME_RATE_LIMIT = { maxAttempts: 20, minIntervalMs: 1200 };

// Короткоживущие токены между "пароль принят" и "код 2FA подтверждён".
// Полноценную сессию не выдаём, пока не введён код.
const pendingTwoFactorLogins = new Map(); // pendingToken -> { userId, expires }
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

function issueSession(req, res, userRow) {
  const { token } = createSession(userRow);
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

// Login (с защитой от брутфорса)
async function login(req, res) {
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
}

// Завершение входа вторым фактором (TOTP-код из приложения-аутентификатора)
async function loginTwoFactor(req, res) {
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
}

// === Регистрация (с защитой от ботов) ===
async function register(req, res) {
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

              // Автоматически логиним пользователя (без отдельной записи "Вход
              // в систему" — регистрация уже залогирована выше как своё действие).
              const { token } = createSession({ id: newUserId, username, role: 'User' });

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
}

// Проверка доступности username (с защитой от перебора)
async function checkUsername(req, res, parsedUrl) {
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
}

function me(req, res, user) {
  if (!user) {
    return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  }
  return sendJson(res, 200, { success: true, user });
}

function logout(req, res) {
  const token = getSessionToken(req);
  if (token) {
    destroySession(token);
  }
  res.writeHead(200, {
    'Set-Cookie': buildSessionCookie('', req, { clear: true }),
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify({ success: true }));
}

module.exports = async function handleAuth(req, res, user, parsedUrl, method) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/auth/login' && method === 'POST') return login(req, res);
  if (pathname === '/api/auth/login-2fa' && method === 'POST') return loginTwoFactor(req, res);
  if (pathname === '/api/auth/register' && method === 'POST') return register(req, res);
  if (pathname === '/api/auth/check-username' && method === 'GET') return checkUsername(req, res, parsedUrl);
  if (pathname === '/api/auth/me' && method === 'GET') return me(req, res, user);
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(req, res);

  return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
};
