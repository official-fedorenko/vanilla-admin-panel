const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, verifyPassword } = require('./db');

const PORT = 3080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLIENT_DIR = path.join(__dirname, 'client');

// Создаем папку uploads, если ее нет
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Сессии в оперативной памяти (токен -> user_details)
const sessions = new Map();

// MIME-типы для раздачи статических файлов
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

// Функция парсинга Cookies
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

// Проверка авторизации
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies.session;
  if (sessionToken && sessions.has(sessionToken)) {
    return sessions.get(sessionToken);
  }
  return null;
}

// Вспомогательная функция чтения JSON-тела запроса
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

// Отправка JSON-ответа
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// Логирование действий
function logAction(user, action) {
  db.run("INSERT INTO logs (user, action) VALUES (?, ?)", [user, action], (err) => {
    if (err) console.error("Ошибка записи лога:", err);
  });
}

// Простой парсер multipart/form-data для загрузки файлов
function handleMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      return reject(new Error('No boundary in multipart/form-data'));
    }
    const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]);
    
    let buffer = Buffer.alloc(0);
    req.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
    });
    
    req.on('end', () => {
      try {
        const parts = [];
        let index = buffer.indexOf(boundary);
        
        while (index !== -1) {
          const nextIndex = buffer.indexOf(boundary, index + boundary.length);
          if (nextIndex === -1) break;
          
          const partBuffer = buffer.slice(index + boundary.length + 2, nextIndex - 2); // убираем \r\n
          parts.push(partBuffer);
          index = nextIndex;
        }

        const uploadedFiles = [];
        
        for (const part of parts) {
          if (part.length === 0) continue;
          
          const headerEndIndex = part.indexOf('\r\n\r\n');
          if (headerEndIndex === -1) continue;
          
          const headersText = part.slice(0, headerEndIndex).toString();
          const bodyBuffer = part.slice(headerEndIndex + 4);
          
          // Проверяем, файл ли это
          const filenameMatch = headersText.match(/filename="([^"]+)"/i);
          const nameMatch = headersText.match(/name="([^"]+)"/i);
          const mimeMatch = headersText.match(/Content-Type:\s*([^\r\n]+)/i);
          
          if (filenameMatch) {
            const filename = filenameMatch[1];
            const mimeType = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
            
            // Генерируем уникальное имя файла для избежания перезаписи
            const fileExt = path.extname(filename);
            const safeName = crypto.randomBytes(16).toString('hex') + fileExt;
            const filePath = path.join(UPLOADS_DIR, safeName);
            
            fs.writeFileSync(filePath, bodyBuffer);
            
            uploadedFiles.push({
              filename: filename,
              filePath: filePath,
              fileUrl: `/uploads/${safeName}`,
              fileSize: bodyBuffer.length,
              mimeType: mimeType
            });
          }
        }
        resolve(uploadedFiles);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Создаем сервер
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  console.log(`[Request] ${method} ${pathname}`);

  // --- API ЭНДПОИНТЫ ---

  // 1. Вход (API Auth Login)
  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const { username, password } = await getJsonBody(req);
      if (!username || !password) {
        return sendJson(res, 400, { success: false, message: 'Имя пользователя и пароль обязательны' });
      }

      db.get("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [username], (err, user) => {
        if (err || !user) {
          return sendJson(res, 401, { success: false, message: 'Неверное имя пользователя или пароль' });
        }

        const isValid = verifyPassword(password, user.password_hash);
        if (!isValid) {
          return sendJson(res, 401, { success: false, message: 'Неверное имя пользователя или пароль' });
        }

        // Создаем токен сессии
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, {
          id: user.id,
          username: user.username,
          role: user.role
        });

        logAction(user.username, 'Вход в систему');

        // Устанавливаем куку
        res.writeHead(200, {
          'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
          'Content-Type': 'application/json; charset=utf-8'
        });
        res.end(JSON.stringify({ success: true, user: { username: user.username, role: user.role } }));
      });
    } catch (e) {
      sendJson(res, 500, { success: false, message: 'Внутренняя ошибка сервера' });
    }
    return;
  }

  // 2. Выход (API Auth Logout)
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    const token = cookies.session;
    if (token) {
      sessions.delete(token);
    }
    res.writeHead(200, {
      'Set-Cookie': 'session=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 3. Проверка текущей сессии
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = getSessionUser(req);
    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    }
    return sendJson(res, 200, { success: true, user });
  }

  // 3.4 Проверка доступности имени пользователя (публичный)
  if (pathname === '/api/auth/check-username' && method === 'GET') {
    const username = parsedUrl.searchParams.get('username');
    if (!username) {
      return sendJson(res, 400, { success: false, message: 'Имя пользователя не указано' });
    }
    const cleanUsername = username.trim();
    if (!/^[a-zA-Z0-9_]{3,}$/.test(cleanUsername)) {
      return sendJson(res, 400, { success: false, message: 'Неверный формат имени пользователя' });
    }
    db.get("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [cleanUsername], (err, row) => {
      if (err) {
        return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      }
      return sendJson(res, 200, { success: true, available: !row });
    });
    return;
  }

  // 3.5 Регистрация нового пользователя (публичный)
  if (pathname === '/api/auth/register' && method === 'POST') {
    try {
      const { username, email, password } = await getJsonBody(req);
      if (!username || !email || !password) {
        return sendJson(res, 400, { success: false, message: 'Все поля обязательны' });
      }
      if (password.length < 6) {
        return sendJson(res, 400, { success: false, message: 'Пароль должен содержать минимум 6 символов' });
      }

      // Проверяем, разрешена ли регистрация
      db.get("SELECT value FROM settings WHERE key = 'allow_registration'", [], (err, row) => {
        if (err || !row || row.value !== 'true') {
          return sendJson(res, 403, { success: false, message: 'Регистрация на данный момент закрыта' });
        }

        const { hashPassword } = require('./db');
        const passwordHash = hashPassword(password);

        db.get(
          "SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
          [username.trim(), email.trim().toLowerCase()],
          (err, existingUser) => {
            if (err) {
              return sendJson(res, 500, { success: false, message: 'Ошибка сервера при проверке имени' });
            }
            if (existingUser) {
              return sendJson(res, 400, { success: false, message: 'Пользователь с таким именем или email уже существует' });
            }

            db.run(
              "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
              [username.trim(), email.trim().toLowerCase(), passwordHash, 'User'],
              function(err) {
                if (err) {
                  if (err.message.includes('UNIQUE')) {
                    return sendJson(res, 400, { success: false, message: 'Пользователь с таким именем или email уже существует' });
                  }
                  return sendJson(res, 500, { success: false, message: 'Ошибка сервера при создании пользователя' });
                }
                const newUserId = this.lastID;
                // Автоматически входим в систему
                const token = crypto.randomBytes(32).toString('hex');
                sessions.set(token, { id: newUserId, username: username.trim(), role: 'User' });
                logAction(username.trim(), 'Зарегистрировался в системе');

                res.writeHead(201, {
                  'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict`,
                  'Content-Type': 'application/json; charset=utf-8'
                });
                res.end(JSON.stringify({ success: true, user: { username: username.trim(), role: 'User' } }));
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

  // ВСЕ ЭНДПОИНТЫ НИЖЕ ТРЕБУЮТ АВТОРИЗАЦИИ
  const user = getSessionUser(req);

  // 3.6 API: Личный кабинет — просмотр профиля
  if (pathname === '/api/cabinet/me' && method === 'GET') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [user.id], (err, row) => {
      if (err || !row) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
      sendJson(res, 200, { success: true, user: row });
    });
    return;
  }

  // 3.7 API: Личный кабинет — обновление профиля
  if (pathname === '/api/cabinet/profile' && method === 'PUT') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    try {
      const { email, password, currentPassword } = await getJsonBody(req);

      // Сначала получаем текущие данные пользователя (включая хеш пароля)
      db.get("SELECT * FROM users WHERE id = ?", [user.id], (err, dbUser) => {
        if (err || !dbUser) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });

        // Если меняем пароль — нужно подтвердить старый
        if (password) {
          const { verifyPassword, hashPassword } = require('./db');
          if (!currentPassword || !verifyPassword(currentPassword, dbUser.password_hash)) {
            return sendJson(res, 400, { success: false, message: 'Неверный текущий пароль' });
          }
          if (password.length < 6) {
            return sendJson(res, 400, { success: false, message: 'Новый пароль должен содержать минимум 6 символов' });
          }
          const newHash = hashPassword(password);
          const newEmail = email ? email.trim().toLowerCase() : dbUser.email;

          db.run("UPDATE users SET email = ?, password_hash = ? WHERE id = ?", [newEmail, newHash, user.id], (err) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления профиля' });
            logAction(user.username, 'Обновил профиль (с изменением пароля)');
            sendJson(res, 200, { success: true, message: 'Профиль успешно обновлён' });
          });
        } else {
          // Меняем только email
          if (!email) return sendJson(res, 400, { success: false, message: 'Нет данных для обновления' });
          db.run("UPDATE users SET email = ? WHERE id = ?", [email.trim().toLowerCase(), user.id], (err) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления email' });
            logAction(user.username, 'Обновил email профиля');
            sendJson(res, 200, { success: true, message: 'Email успешно обновлён' });
          });
        }
      });
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // 4. API: Статистика Dashboard
  if (pathname === '/api/dashboard/stats' && method === 'GET') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    
    db.get("SELECT COUNT(*) as count FROM users", (err, usersRow) => {
      db.get("SELECT COUNT(*) as count FROM articles", (err, articlesRow) => {
        db.get("SELECT COUNT(*) as count FROM media", (err, mediaRow) => {
          sendJson(res, 200, {
            users: usersRow ? usersRow.count : 0,
            articles: articlesRow ? articlesRow.count : 0,
            mediaFiles: mediaRow ? mediaRow.count : 0
          });
        });
      });
    });
    return;
  }

  // 4.5 API: Логи активности
  if (pathname === '/api/logs') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    
    if (method === 'GET') {
      const limit = parsedUrl.searchParams.get('limit') || '500';
      db.all("SELECT * FROM logs ORDER BY id DESC LIMIT ?", [limit], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } 
    else if (method === 'DELETE') {
      if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Только Superadmin может удалять логи' });
      db.run("DELETE FROM logs", [], (err) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка при очистке логов' });
        logAction(user.username, 'Очищена история логов действий');
        sendJson(res, 200, { success: true });
      });
    }
    return;
  }

  // 4.6 API: Управление пользователями (только для роли Superadmin)
  if (pathname === '/api/users') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Только Superadmin может управлять пользователями' });

    if (method === 'GET') {
      db.all("SELECT id, username, email, role, avatar_url, created_at FROM users ORDER BY id DESC", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    }
    else if (method === 'POST') {
      try {
        const { username, email, password, role } = await getJsonBody(req);
        if (!username || !email || !password || !role) {
          return sendJson(res, 400, { success: false, message: 'Все поля обязательны' });
        }
        const { hashPassword } = require('./db');
        const passwordHash = hashPassword(password);
        db.run(
          "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
          [username, email, passwordHash, role],
          function(err) {
            if (err) {
              if (err.message.includes('UNIQUE')) {
                return sendJson(res, 400, { success: false, message: 'Пользователь с таким именем или email уже существует' });
              }
              return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            }
            logAction(user.username, `Создан новый пользователь: ${username} (роль: ${role})`);
            sendJson(res, 201, { success: true, id: this.lastID });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный JSON' });
      }
    }
    else if (method === 'PUT') {
      try {
        const id = parsedUrl.searchParams.get('id');
        if (!id) return sendJson(res, 400, { success: false, message: 'ID не указан' });
        const { username, email, password, role } = await getJsonBody(req);
        if (!username || !email || !role) {
          return sendJson(res, 400, { success: false, message: 'Обязательные поля отсутствуют' });
        }
        
        if (password) {
          const { hashPassword } = require('./db');
          const passwordHash = hashPassword(password);
          db.run(
            "UPDATE users SET username = ?, email = ?, password_hash = ?, role = ? WHERE id = ?",
            [username, email, passwordHash, role, id],
            function(err) {
              if (err) {
                if (err.message.includes('UNIQUE')) {
                  return sendJson(res, 400, { success: false, message: 'Имя пользователя или email уже заняты' });
                }
                return sendJson(res, 500, { success: false, message: 'Ошибка при обновлении пользователя' });
              }
              logAction(user.username, `Обновлен пользователь: ${username} (с изменением пароля, роль: ${role})`);
              sendJson(res, 200, { success: true });
            }
          );
        } else {
          db.run(
            "UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?",
            [username, email, role, id],
            function(err) {
              if (err) {
                if (err.message.includes('UNIQUE')) {
                  return sendJson(res, 400, { success: false, message: 'Имя пользователя или email уже заняты' });
                }
                return sendJson(res, 500, { success: false, message: 'Ошибка при обновлении пользователя' });
              }
              logAction(user.username, `Обновлен пользователь: ${username} (роль: ${role})`);
              sendJson(res, 200, { success: true });
            }
          );
        }
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный JSON' });
      }
    }
    else if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) return sendJson(res, 400, { success: false, message: 'ID не указан' });
      
      if (parseInt(id, 10) === parseInt(user.id, 10)) {
        return sendJson(res, 400, { success: false, message: 'Вы не можете удалить самого себя' });
      }

      db.get("SELECT username FROM users WHERE id = ?", [id], (err, targetUser) => {
        if (err || !targetUser) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
        db.run("DELETE FROM users WHERE id = ?", [id], function(err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных при удалении' });
          logAction(user.username, `Удален пользователь: ${targetUser.username}`);
          sendJson(res, 200, { success: true });
        });
      });
    }
    return;
  }

  // --- API ЧАТА ПОДДЕРЖКИ ---
  if (pathname === '/api/support/send' && method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const { message, ticketId } = body;
      if (!message) return sendJson(res, 400, { success: false, message: 'Сообщение не может быть пустым' });

      let tId = ticketId;
      let senderName = body.name || 'Гость';
      let senderEmail = body.email || '';
      let userId = null;
      let role = 'Guest';

      if (user) {
        tId = 'user_' + user.id;
        senderName = user.username;
        userId = user.id;
        role = user.role;
      } else {
        if (!tId) tId = 'guest_' + crypto.randomBytes(8).toString('hex');
      }

      db.run(
        "INSERT INTO support_messages (ticket_id, user_id, name, email, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [tId, userId, senderName, senderEmail, message, role, 0],
        function(err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения сообщения' });
          if (user) logAction(user.username, 'Отправил сообщение в поддержку');
          sendJson(res, 201, { success: true, ticketId: tId, messageId: this.lastID });
        }
      );
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  if (pathname === '/api/support/messages' && method === 'GET') {
    let tId = parsedUrl.searchParams.get('ticketId');
    if (user && user.role !== 'Admin' && user.role !== 'Superadmin') {
      tId = 'user_' + user.id; // Обычный пользователь видит только свой чат
    } else if (user && (user.role === 'Admin' || user.role === 'Superadmin')) {
      if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
    } else {
      if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
    }

    db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC", [tId], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, messages: rows });
    });
    return;
  }

  if (pathname === '/api/support/tickets' && method === 'GET') {
    if (!user || (user.role !== 'Admin' && user.role !== 'Superadmin')) {
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

  if (pathname === '/api/support/reply' && method === 'POST') {
    if (!user || (user.role !== 'Admin' && user.role !== 'Superadmin')) {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    try {
      const { ticketId, message } = await getJsonBody(req);
      if (!ticketId || !message) return sendJson(res, 400, { success: false, message: 'Неверные данные' });

      db.run(
        "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
        [ticketId, user.id, user.username, message, user.role, 0],
        function(err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения ответа' });
          logAction(user.username, `Ответил в тикете ${ticketId}`);
          sendJson(res, 201, { success: true, messageId: this.lastID });
        }
      );
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  if (pathname === '/api/support/read' && method === 'POST') {
    try {
      const { ticketId } = await getJsonBody(req);
      if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
      if (!user || (user.role !== 'Admin' && user.role !== 'Superadmin')) {
        db.run("UPDATE support_messages SET is_read = 1 WHERE ticket_id = ? AND (sender_role = 'Admin' OR sender_role = 'Superadmin')", [ticketId], () => {
          sendJson(res, 200, { success: true });
        });
      } else {
        db.run("UPDATE support_messages SET is_read = 1 WHERE ticket_id = ? AND sender_role != 'Admin' AND sender_role != 'Superadmin'", [ticketId], () => {
          sendJson(res, 200, { success: true });
        });
      }
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }


  // 5. API: Динамический CRUD
  if (pathname.startsWith('/api/crud/')) {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    
    const table = pathname.replace('/api/crud/', '');
    const allowedTables = ['articles']; // Добавляй новые таблицы сюда!
    
    if (!allowedTables.includes(table)) {
      return sendJson(res, 400, { message: 'Таблица не разрешена для CRUD' });
    }

    if (method === 'GET') {
      db.all(`SELECT * FROM ${table} ORDER BY id DESC`, [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } 
    else if (method === 'POST') {
      try {
        const body = await getJsonBody(req);
        if (Object.keys(body).length === 0) return sendJson(res, 400, { message: 'Пустые данные' });

        const keys = Object.keys(body);
        const values = Object.values(body);
        const placeholders = keys.map(() => '?').join(', ');

        db.run(
          `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
          values,
          function(err) {
            if (err) return sendJson(res, 500, { message: 'Ошибка создания записи' });
            logAction(user.username, `Создана запись в ${table} (ID: ${this.lastID})`);
            sendJson(res, 201, { id: this.lastID, success: true });
          }
        );
      } catch (e) {
        sendJson(res, 400, { message: 'Невалидный JSON' });
      }
    } 
    else if (method === 'PUT') {
      try {
        const id = parsedUrl.searchParams.get('id');
        if (!id) return sendJson(res, 400, { message: 'ID не указан' });

        const body = await getJsonBody(req);
        const keys = Object.keys(body);
        const values = Object.values(body);
        const assignments = keys.map(k => `${k} = ?`).join(', ');

        db.run(
          `UPDATE ${table} SET ${assignments} WHERE id = ?`,
          [...values, id],
          function(err) {
            if (err) return sendJson(res, 500, { message: 'Ошибка обновления' });
            logAction(user.username, `Обновлена запись в ${table} (ID: ${id})`);
            sendJson(res, 200, { success: true });
          }
        );
      } catch (e) {
        sendJson(res, 400, { message: 'Невалидный JSON' });
      }
    } 
    else if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) return sendJson(res, 400, { message: 'ID не указан' });

      db.run(`DELETE FROM ${table} WHERE id = ?`, [id], function(err) {
        if (err) return sendJson(res, 500, { message: 'Ошибка удаления' });
        logAction(user.username, `Удалена запись из ${table} (ID: ${id})`);
        sendJson(res, 200, { success: true });
      });
    }
    return;
  }

  // 6. API: Системные настройки
  if (pathname === '/api/settings') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (method === 'GET') {
      db.all("SELECT * FROM settings", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
        sendJson(res, 200, rows);
      });
    } 
    else if (method === 'POST') {
      try {
        const settings = await getJsonBody(req);
        const stmt = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
        
        db.serialize(() => {
          for (const [key, value] of Object.entries(settings)) {
            stmt.run(value, key);
          }
          stmt.finalize();
          sendJson(res, 200, { success: true });
        });
      } catch (e) {
        sendJson(res, 500, { message: 'Ошибка сохранения настроек' });
      }
    }
    return;
  }

  // 7. API: Медиафайлы (Загрузка / Просмотр / Удаление)
  if (pathname === '/api/media') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

    if (method === 'GET') {
      db.all("SELECT * FROM media ORDER BY id DESC", [], (err, rows) => {
        if (err) return sendJson(res, 500, { message: 'Ошибка БД' });
        
        // Преобразуем пути
        const formatted = rows.map(r => ({
          id: r.id,
          filename: r.filename,
          file_url: r.file_path, // отдаем URL
          mime_type: r.mime_type,
          file_size: r.file_size
        }));
        sendJson(res, 200, formatted);
      });
    } 
    else if (method === 'POST') {
      try {
        const files = await handleMultipartUpload(req);
        if (files.length === 0) {
          return sendJson(res, 400, { message: 'Файлы не найдены' });
        }

        const stmt = db.prepare("INSERT INTO media (filename, file_path, file_size, mime_type) VALUES (?, ?, ?, ?)");
        
        db.serialize(() => {
          files.forEach(f => {
            stmt.run(f.filename, f.fileUrl, f.fileSize, f.mimeType);
            logAction(user.username, `Загружен файл ${f.filename}`);
          });
          stmt.finalize();
          sendJson(res, 201, { success: true, count: files.length });
        });
      } catch (err) {
        console.error(err);
        sendJson(res, 500, { message: 'Ошибка обработки загрузки' });
      }
    } 
    else if (method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) return sendJson(res, 400, { message: 'ID не указан' });

      db.get("SELECT * FROM media WHERE id = ?", [id], (err, file) => {
        if (err || !file) return sendJson(res, 404, { message: 'Файл не найден' });
        
        // Удаляем физический файл с диска
        const filename = path.basename(file.file_path);
        const fullPath = path.join(UPLOADS_DIR, filename);
        
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }

        db.run("DELETE FROM media WHERE id = ?", [id], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка удаления из БД' });
          logAction(user.username, `Удален файл ${filename}`);
          sendJson(res, 200, { success: true });
        });
      });
    }
    return;
  }

  // --- ПУБЛИЧНЫЕ ЭНДПОИНТЫ ---
  if (pathname === '/api/public/articles' && method === 'GET') {
    db.all("SELECT id, title, content, created_at FROM articles WHERE status = 'published' ORDER BY id DESC", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
    return;
  }

  if (pathname === '/api/public/settings' && method === 'GET') {
    db.all("SELECT key, value FROM settings", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
    return;
  }

  // --- РАЗДАЧА СТАТИЧЕСКИХ ФАЙЛОВ ---
  
  // Маршрут к загруженным картинкам (/uploads/*)
  if (pathname.startsWith('/uploads/')) {
    const filename = pathname.replace('/uploads/', '');
    const safePath = path.join(UPLOADS_DIR, path.basename(filename));
    
    fs.access(safePath, fs.constants.F_OK, (err) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      const ext = path.extname(safePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(safePath).pipe(res);
    });
    return;
  }

  // Раздача статики (Клиент и Админка)
  let fullStaticPath;
  let staticPath = pathname;

  if (pathname.startsWith('/admin')) {
    // Раздаем админку из папки public
    staticPath = pathname.replace('/admin', '') || '/index.html';
    if (staticPath === '/') staticPath = '/index.html';
    fullStaticPath = path.join(PUBLIC_DIR, staticPath);

    // Редиректы авторизации для страниц HTML
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
    // Раздаем клиентский сайт из папки client
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

// Запуск сервера
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`Админка успешно запущена!`);
  console.log(`Перейдите по ссылке: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
