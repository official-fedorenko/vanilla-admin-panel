const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db, hashPassword } = require('../../db');

// Гарантирует наличие карточки сотрудника, привязанной к аккаунту.
// Вызывается при account_type='employee'. Если карточки нет — создаёт
// минимальную (имя = логин) со статусом 'inactive', чтобы человек появился
// в разделе «Сотрудники», где админ уточнит ФИО. Идемпотентно.
function ensureEmployeeCard(userId) {
  db.get("SELECT id FROM employees WHERE user_id = ?", [userId], (err, emp) => {
    if (err || emp) return;
    db.get("SELECT username, email FROM users WHERE id = ?", [userId], (e2, u) => {
      if (e2 || !u) return;
      db.run(
        "INSERT INTO employees (first_name, last_name, email, user_id, status) VALUES (?, '', ?, ?, 'inactive')",
        [u.username, u.email, userId]
      );
    });
  });
}

module.exports = async function handleUsers(req, res, user, parsedUrl, method) {
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
  }

  if (method === 'GET') {
    // limit/offset — без параметров ведёт себя как раньше (до 1000 пользователей).
    // Указав offset, можно достать записи за пределами этого потолка, пока
    // в UI не появится полноценная пагинация.
    const { limit, offset } = parsePagination(parsedUrl);
    db.all(
      `SELECT u.id, u.username, u.email, u.role, u.account_type, u.avatar_url, u.created_at,
              e.first_name, e.last_name
       FROM users u
       LEFT JOIN employees e ON e.user_id = u.id
       ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM users", [], (err2, countRow) => {
        res.setHeader('X-Total-Count', String((countRow && countRow.count) || 0));
        sendJson(res, 200, rows);
      });
    });
    return;
  }

  if (method === 'POST') {
    (async () => {
      try {
        const body = await getJsonBody(req);
        const { username, email, password, role = 'User' } = body;
        const accountType = body.account_type === 'employee' ? 'employee' : 'client';

        if (!username || !email || !password) {
          return sendJson(res, 400, { success: false, message: 'username, email и password обязательны' });
        }
        if (password.length < 8) {
          return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 8 символов' });
        }
        if (!['User', 'Admin', 'Superadmin'].includes(role)) {
          return sendJson(res, 400, { success: false, message: 'Недопустимая роль' });
        }

        const password_hash = hashPassword(password);
        db.run(
          "INSERT INTO users (username, email, password_hash, role, account_type) VALUES (?, ?, ?, ?, ?)",
          [username, email, password_hash, role, accountType],
          function (err) {
            if (err) {
              const msg = err.message.includes('UNIQUE') ? 'Пользователь с таким логином или email уже существует' : 'Ошибка создания пользователя';
              return sendJson(res, 400, { success: false, message: msg });
            }
            if (accountType === 'employee') ensureEmployeeCard(this.lastID);
            logAction(user.username, `Создан пользователь ${username} (${role}, ${accountType})`);
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
        const { username, email, password, role, account_type } = body;

        if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });

        const fields = [];
        const values = [];

        if (username) { fields.push('username = ?'); values.push(username); }
        if (email)    { fields.push('email = ?');    values.push(email); }
        if (role && ['User','Admin','Superadmin'].includes(role)) {
          fields.push('role = ?'); values.push(role);
        }
        const willBeEmployee = account_type === 'employee';
        if (account_type === 'client' || account_type === 'employee') {
          fields.push('account_type = ?'); values.push(account_type);
        }
        if (password) {
          if (password.length < 8) {
            return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 8 символов' });
          }
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
            if (willBeEmployee) ensureEmployeeCard(parseInt(id, 10));
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
