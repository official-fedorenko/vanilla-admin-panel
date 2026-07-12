const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, verifyPassword, hashPassword } = require('../../db');

function getMe(req, res, user) {
  db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [user.id], (err, row) => {
    if (err || !row) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
    sendJson(res, 200, { success: true, user: row });
  });
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

  return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
};
