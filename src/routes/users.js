const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, hashPassword } = require('../../db');

module.exports = async function handleUsers(req, res, user, parsedUrl, method) {
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
};
