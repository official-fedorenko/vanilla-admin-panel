const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, verifyPassword, hashPassword, saveSession, loadSessionsIntoMap, deleteSession, cleanupExpiredSessions } = require('./db');

const PORT = 3080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLIENT_DIR = path.join(__dirname, 'client');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const sessions = new Map();
loadSessionsIntoMap(sessions);
cleanupExpiredSessions();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8'
};

// === Загрузка файлов через base64 (то, что уже использует фронтенд) ===
async function handleBase64Upload(req) {
  const body = await getJsonBody(req);
  const inputFiles = Array.isArray(body.files) ? body.files : [];
  const result = [];

  const MAX_FILES = 6;
  const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ после декодирования

  if (inputFiles.length > MAX_FILES) {
    throw new Error('Слишком много файлов за раз (макс. ' + MAX_FILES + ')');
  }

  for (const f of inputFiles) {
    if (!f || !f.data || !f.filename) continue;

    let buffer;
    try {
      buffer = Buffer.from(f.data, 'base64');
    } catch (e) {
      continue;
    }

    if (buffer.length === 0 || buffer.length > MAX_SIZE_BYTES) {
      throw new Error(`Файл "${f.filename}" слишком большой (макс 8 МБ)`);
    }

    // Простая защита имени файла
    const safeOriginal = String(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const uniqueName = Date.now() + '-' + Math.floor(Math.random() * 1e10) + '-' + safeOriginal;
    const fullPath = path.join(UPLOADS_DIR, uniqueName);

    await fs.promises.writeFile(fullPath, buffer);

    result.push({
      filename: f.filename,
      fileUrl: '/uploads/' + uniqueName,
      fileSize: buffer.length,
      mimeType: f.mimeType || 'application/octet-stream'
    });
  }

  return result;
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

function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function logAction(user, action) {
  db.run("INSERT INTO logs (user, action) VALUES (?, ?)", [user, action], (err) => {
    if (err) console.error("Ошибка записи лога:", err);
  });
}

// === Простая защита от ботов (rate limit + honeypot) ===
const rateLimits = new Map(); // key -> { attempts, first, last }

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
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

  // Сбрасываем счётчик через 1 час
  if (now - entry.first > 60 * 60 * 1000) {
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
  if (Math.random() < 0.03) {
    for (const [k, e] of rateLimits) {
      if (now - e.first > 2 * 60 * 60 * 1000) rateLimits.delete(k);
    }
  }

  return { limited: false };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Логируем только важное (или включи DEBUG=true для всех запросов)
  if (process.env.DEBUG || pathname.startsWith('/api/')) {
    // console.log(`[Request] ${method} ${pathname}`);
  }

  const user = getSessionUser(req);

  // Public articles
  if (pathname === '/api/public/articles' && method === 'GET') {
    db.all("SELECT id, title, content, created_at FROM articles WHERE status = 'published' ORDER BY id DESC", [], (err, rows) => {
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
      const loginLimit = isRateLimited(ip, 'login', 8, 1800); // max 8 попыток, 1.8 сек между
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

        const token = crypto.randomBytes(32).toString('hex');
        const sessionUser = { id: userRow.id, username: userRow.username, role: userRow.role };
        sessions.set(token, sessionUser);
        saveSession(token, sessionUser);

        logAction(userRow.username, 'Вход в систему');

        res.writeHead(200, {
          'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
          'Content-Type': 'application/json; charset=utf-8'
        });
        res.end(JSON.stringify({ success: true, user: { username: userRow.username, role: userRow.role } }));
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
      const limitCheck = isRateLimited(ip, 'register', 3, 40000); // max 3 попытки, минимум 40 сек между
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
        if (password.length < 6) {
          return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 6 символов' });
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
                  console.error('Register error:', err3);
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
                  'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
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
    const limitCheck = isRateLimited(ip, 'check-username', 20, 1200);
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
      'Set-Cookie': 'session=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Dashboard stats (параллельно вместо вложенных колбэков)
  if (pathname === '/api/dashboard/stats' && method === 'GET') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    Promise.all([
      new Promise(res => db.get("SELECT COUNT(*) as count FROM users", (e, r) => res(r ? r.count : 0))),
      new Promise(res => db.get("SELECT COUNT(*) as count FROM articles", (e, r) => res(r ? r.count : 0))),
      new Promise(res => db.get("SELECT COUNT(*) as count FROM media", (e, r) => res(r ? r.count : 0)))
    ]).then(([users, articles, mediaFiles]) => {
      sendJson(res, 200, { users, articles, mediaFiles });
    }).catch(() => sendJson(res, 200, { users: 0, articles: 0, mediaFiles: 0 }));

    return;
  }

  // CRUD articles (used heavily in admin)
  if (pathname.startsWith('/api/crud/articles')) {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (method === 'GET') {
      db.all("SELECT * FROM articles ORDER BY id DESC", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } else if (method === 'POST') {
      try {
        const body = await getJsonBody(req);
        db.run("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)", 
          [body.title, body.content, body.status || 'draft'], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка создания' });
          sendJson(res, 201, { id: this.lastID, success: true });
        });
      } catch (e) {
        sendJson(res, 400, { message: 'Невалидный JSON' });
      }
    } else if (method === 'PUT') {
      try {
        const id = parsedUrl.searchParams.get('id');
        const body = await getJsonBody(req);
        db.run("UPDATE articles SET title = ?, content = ?, status = ? WHERE id = ?", 
          [body.title, body.content, body.status, id], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка обновления' });
          sendJson(res, 200, { success: true });
        });
      } catch (e) {
        sendJson(res, 400, { message: 'Невалидный JSON' });
      }
    } else if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      db.run("DELETE FROM articles WHERE id = ?", [id], function(err) {
        if (err) return sendJson(res, 500, { message: 'Ошибка удаления' });
        sendJson(res, 200, { success: true });
      });
    }
    return;
  }

  // Media
  if (pathname === '/api/media') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (method === 'GET') {
      db.all("SELECT * FROM media ORDER BY id DESC", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка БД' });
        const formatted = rows.map(r => ({
          id: r.id, filename: r.filename, file_url: r.file_path,
          mime_type: r.mime_type, file_size: r.file_size
        }));
        sendJson(res, 200, formatted);
      });
    } else if (method === 'POST') {
      try {
        const files = await handleBase64Upload(req);
        if (files.length === 0) return sendJson(res, 400, { message: 'Файлы не найдены' });

        const stmt = db.prepare("INSERT INTO media (filename, file_path, file_size, mime_type) VALUES (?, ?, ?, ?)");
        db.serialize(() => {
          files.forEach(f => {
            stmt.run(f.filename, f.fileUrl, f.fileSize, f.mimeType);
          });
          stmt.finalize();

          // Возвращаем и count, и urls — чтобы работало и в админке, и в кабинете (аватар)
          sendJson(res, 201, {
            success: true,
            count: files.length,
            urls: files.map(f => f.fileUrl)
          });
        });
      } catch (err) {
        sendJson(res, 500, { message: err.message || 'Ошибка загрузки' });
      }
    } else if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      db.get("SELECT * FROM media WHERE id = ?", [id], async (err, file) => {
        if (err || !file) return sendJson(res, 404, { message: 'Файл не найден' });

        try {
          const filename = path.basename(file.file_path);
          const fullPath = path.join(UPLOADS_DIR, filename);
          await fs.promises.unlink(fullPath).catch(() => {}); // не падаем, если файла уже нет
        } catch (e) { /* ignore */ }

        db.run("DELETE FROM media WHERE id = ?", [id], () => {
          sendJson(res, 200, { success: true });
        });
      });
    }
    return;
  }

  // Settings
  if (pathname === '/api/settings') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (method === 'GET') {
      db.all("SELECT * FROM settings", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } else if (method === 'POST') {
      try {
        const settings = await getJsonBody(req);
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        db.serialize(() => {
          for (const [key, value] of Object.entries(settings)) {
            stmt.run(key, value);
          }
          stmt.finalize();
          sendJson(res, 200, { success: true });
        });
      } catch (e) {
        sendJson(res, 500, { message: 'Ошибка сохранения' });
      }
    }
    return;
  }

  // Support (tickets, messages, reply, etc.)
  if (pathname.startsWith('/api/support/')) {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (pathname === '/api/support/tickets' && method === 'GET') {
      if (user.role !== 'Admin' && user.role !== 'Superadmin') {
        return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
      }
      const query = `
        SELECT ticket_id, name, email, MAX(created_at) as last_activity,
               SUM(CASE WHEN is_read = 0 AND sender_role != 'Admin' AND sender_role != 'Superadmin' THEN 1 ELSE 0 END) as unread_count
        FROM support_messages 
        GROUP BY ticket_id 
        ORDER BY last_activity DESC
      `;
      db.all(query, [], (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, tickets: rows });
      });
      return;
    }

    if (pathname === '/api/support/messages' && method === 'GET') {
      let tId = parsedUrl.searchParams.get('ticketId');
      if (user.role !== 'Admin' && user.role !== 'Superadmin') {
        tId = 'user_' + user.id;
      }
      if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
      db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC", [tId], (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, messages: rows });
      });
      return;
    }

    if (pathname === '/api/support/reply' && method === 'POST') {
      if (user.role !== 'Admin' && user.role !== 'Superadmin') {
        return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
      }
      try {
        const { ticketId, message } = await getJsonBody(req);
        db.run(
          "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
          [ticketId, user.id, user.username, message, user.role, 0],
          function(err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
            sendJson(res, 201, { success: true, messageId: this.lastID });
          }
        );
      } catch(e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
      return;
    }

    if (pathname === '/api/support/send' && method === 'POST') {
      try {
        const body = await getJsonBody(req);
        const { message, ticketId } = body;
        if (!message) return sendJson(res, 400, { success: false, message: 'Сообщение не может быть пустым' });
        let tId = ticketId || (user ? 'user_' + user.id : 'guest_' + Date.now());
        let senderName = user ? user.username : (body.name || 'Гость');
        let role = user ? user.role : 'Guest';
        db.run(
          "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
          [tId, user ? user.id : null, senderName, message, role, 0],
          function(err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
            sendJson(res, 201, { success: true, ticketId: tId, messageId: this.lastID });
          }
        );
      } catch(e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
      return;
    }

    // Отметить сообщения тикета как прочитанные (для пользователя и для админа)
    if (pathname === '/api/support/read' && method === 'POST') {
      try {
        const { ticketId } = await getJsonBody(req);
        if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });

        // Админ может читать любой, обычный пользователь — только свой
        let targetTicket = ticketId;
        if (user.role !== 'Admin' && user.role !== 'Superadmin') {
          targetTicket = 'user_' + user.id;
        }

        db.run(
          `UPDATE support_messages 
           SET is_read = 1 
           WHERE ticket_id = ? AND sender_role NOT IN ('Admin', 'Superadmin')`,
          [targetTicket],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
            sendJson(res, 200, { success: true });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
      return;
    }

    // Лёгкий "ensure ticket" — используется adminStartChat, чтобы не было 404
    if (pathname === '/api/support/create' && method === 'POST') {
      // Просто возвращаем успех. Реальный тикет создаётся при первой отправке сообщения.
      try {
        const { targetUserId } = await getJsonBody(req);
        const ticketId = targetUserId ? 'user_' + targetUserId : null;
        sendJson(res, 200, { success: true, ticketId: ticketId || 'ok' });
      } catch (e) {
        sendJson(res, 200, { success: true }); // всё равно не падаем
      }
      return;
    }

    return sendJson(res, 404, { success: false, message: 'Support endpoint не реализован полностью' });
  }

  // Users (superadmin) — полный CRUD
  if (pathname === '/api/users') {
    if (!user || user.role !== 'Superadmin') {
      return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
    }

    if (method === 'GET') {
      db.all("SELECT id, username, email, role, avatar_url, created_at FROM users ORDER BY id DESC", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
      return;
    }

    if (method === 'POST') {
      (async () => {
        try {
          const body = await getJsonBody(req);
          const { username, email, password, role = 'User' } = body;

          if (!username || !email || !password) {
            return sendJson(res, 400, { success: false, message: 'username, email и password обязательны' });
          }
          if (!['User', 'Admin', 'Superadmin'].includes(role)) {
            return sendJson(res, 400, { success: false, message: 'Недопустимая роль' });
          }

          const password_hash = hashPassword(password);
          db.run(
            "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
            [username, email, password_hash, role],
            function (err) {
              if (err) {
                const msg = err.message.includes('UNIQUE') ? 'Пользователь с таким логином или email уже существует' : 'Ошибка создания пользователя';
                return sendJson(res, 400, { success: false, message: msg });
              }
              logAction(user.username, `Создан пользователь ${username} (${role})`);
              sendJson(res, 201, { success: true, id: this.lastID });
            }
          );
        } catch (e) {
          sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
        }
      })();
      return;
    }

    if (method === 'PUT') {
      (async () => {
        try {
          const id = parsedUrl.searchParams.get('id');
          const body = await getJsonBody(req);
          const { username, email, password, role } = body;

          if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });

          // Собираем динамический UPDATE
          const fields = [];
          const values = [];

          if (username) { fields.push('username = ?'); values.push(username); }
          if (email)    { fields.push('email = ?');    values.push(email); }
          if (role && ['User','Admin','Superadmin'].includes(role)) {
            fields.push('role = ?'); values.push(role);
          }
          if (password) {
            fields.push('password_hash = ?');
            values.push(hashPassword(password));
          }

          if (fields.length === 0) {
            return sendJson(res, 400, { success: false, message: 'Нет данных для обновления' });
          }

          values.push(id);

          db.run(
            `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
            values,
            function (err) {
              if (err) {
                const msg = err.message.includes('UNIQUE') ? 'Логин или email уже заняты' : 'Ошибка обновления';
                return sendJson(res, 400, { success: false, message: msg });
              }
              logAction(user.username, `Обновлён пользователь id=${id}`);
              sendJson(res, 200, { success: true });
            }
          );
        } catch (e) {
          sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
        }
      })();
      return;
    }

    if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });

      if (parseInt(id, 10) === user.id) {
        return sendJson(res, 400, { success: false, message: 'Нельзя удалить самого себя' });
      }

      db.run("DELETE FROM users WHERE id = ?", [id], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
        logAction(user.username, `Удалён пользователь id=${id}`);
        sendJson(res, 200, { success: true });
      });
      return;
    }

    return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
  }

  // Logs
  if (pathname === '/api/logs') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    if (method === 'GET') {
      const limit = parsedUrl.searchParams.get('limit') || '500';
      db.all("SELECT * FROM logs ORDER BY id DESC LIMIT ?", [limit], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } else if (method === 'DELETE' && user.role === 'Superadmin') {
      db.run("DELETE FROM logs", [], () => sendJson(res, 200, { success: true }));
    }
    return;
  }

  // Other API fall to 404 for now
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
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
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Страница не найдена (404)');
      return;
    }

    const ext = path.extname(fullStaticPath);
    const contentType = MIME_TYPES[ext] || 'text/plain';
    
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(fullStaticPath).pipe(res);
  });

});

server.listen(PORT, () => {
  console.log(`Админка успешно запущена на http://localhost:${PORT}`);
});
