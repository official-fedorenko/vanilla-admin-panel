const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, verifyPassword, hashPassword } = require('../../db');

function getMe(req, res, user) {
  db.get("SELECT id, username, email, role, account_type, avatar_url, created_at FROM users WHERE id = ?", [user.id], (err, row) => {
    if (err || !row) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
    sendJson(res, 200, { success: true, user: row });
  });
}

// Карточка сотрудника, привязанная к текущему аккаунту (read-only для
// самого сотрудника — редактирование пока только из админки). У клиентов
// без карточки вернётся card: null.
function getMyCard(req, res, user) {
  db.get(
    `SELECT id, first_name, last_name, position, department, phone, email,
            hire_date, status, notes, created_at
     FROM employees WHERE user_id = ?`,
    [user.id],
    (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, card: row || null });
    }
  );
}

// Инструмент, закреплённый за сотрудником, привязанным к текущему аккаунту.
// Клиенты (без карточки в employees) просто получают пустой список.
function getMyTools(req, res, user) {
  const sql = `
    SELECT t.id, t.name, t.category, t.brand, t.model, t.serial_number, t.inventory_number,
           t.photo_url, a.issued_at
    FROM employees e
    JOIN tool_assignments a ON a.employee_id = e.id AND a.returned_at IS NULL
    JOIN tools t ON t.id = a.tool_id
    WHERE e.user_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [user.id], (err, tools) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!tools || tools.length === 0) {
      return sendJson(res, 200, { success: true, tools: [] });
    }

    const toolIds = tools.map(t => t.id);
    const placeholders = toolIds.map(() => '?').join(',');
    const photoSql = `SELECT tool_id, photo_url FROM tool_photos WHERE tool_id IN (${placeholders}) ORDER BY created_at ASC`;
    db.all(photoSql, toolIds, (err2, photos) => {
      if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка загрузки фото галереи' });
      
      const photosByTool = {};
      (photos || []).forEach(p => {
        if (!photosByTool[p.tool_id]) photosByTool[p.tool_id] = [];
        photosByTool[p.tool_id].push(p.photo_url);
      });

      tools.forEach(t => {
        t.gallery_photos = photosByTool[t.id] || [];
      });

      sendJson(res, 200, { success: true, tools: tools });
    });
  });
}

// Сотрудник добавляет фото в галерею ТОЛЬКО у инструмента, который сейчас на нём.
// Файл заранее загружается через /api/media, сюда приходит уже готовый URL.
async function setToolPhoto(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const rawPhoto = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан инструмент' });
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto)) {
      return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });
    }

    // Проверяем, что этот инструмент действительно закреплён за сотрудником
    // текущего пользователя (открытое закрепление).
    const checkSql = `
      SELECT a.id FROM tool_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.tool_id = ? AND a.returned_at IS NULL AND e.user_id = ?`;
    db.get(checkSql, [toolId, user.id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 403, { success: false, message: 'Этот инструмент сейчас не закреплён за вами' });

      db.run("INSERT INTO tool_photos (tool_id, photo_url, uploaded_by) VALUES (?, ?, ?)", [toolId, rawPhoto, user.id], function (uErr) {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });
        logAction(user.username, `Добавил фото к инструменту id=${toolId} в галерею`);
        sendJson(res, 200, { success: true, photo_url: rawPhoto });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// Обновление профиля пользователя (email, пароль, avatar_url)
async function updateProfile(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const { email, password, currentPassword, avatar_url } = body;

    db.get("SELECT * FROM users WHERE id = ?", [user.id], (err, dbUser) => {
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

      values.push(user.id);

      db.run(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
        values,
        function (updateErr) {
          if (updateErr) {
            const msg = updateErr.message.includes('UNIQUE') ? 'Такой email уже используется' : 'Ошибка сохранения профиля';
            return sendJson(res, 400, { success: false, message: msg });
          }
          logAction(user.username, 'Обновил свой профиль');
          // Вернём свежие данные
          db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [user.id], (e2, fresh) => {
            sendJson(res, 200, { success: true, message: 'Профиль обновлён', user: fresh });
          });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

module.exports = async function handleCabinet(req, res, user, parsedUrl, method) {
  if (!user) {
    return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  }

  const pathname = parsedUrl.pathname;

  if (pathname === '/api/cabinet/me' && method === 'GET') return getMe(req, res, user);
  if (pathname === '/api/cabinet/profile' && method === 'PUT') return updateProfile(req, res, user);
  if (pathname === '/api/cabinet/my-card' && method === 'GET') return getMyCard(req, res, user);
  if (pathname === '/api/cabinet/my-tools' && method === 'GET') return getMyTools(req, res, user);
  if (pathname === '/api/cabinet/tool-photo' && method === 'POST') return setToolPhoto(req, res, user);

  return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
};
