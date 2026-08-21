const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');

/**
 * CRUD сотрудников — базовый справочник персонала компании.
 *
 * Права доступа:
 *   - GET (просмотр списка/карточки) — любой авторизованный пользователь;
 *   - POST/PUT/DELETE (изменения) — только Admin и Superadmin.
 *
 * Модель намеренно простая и расширяемая: позже к employees.id привяжутся
 * закреплённый инструмент, учёт времени, отпуска и документы.
 */

const ALLOWED_STATUSES = ['active', 'vacation', 'inactive', 'fired'];

function parseId(parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canWrite(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

// Приводит тело запроса к безопасному набору полей карточки сотрудника.
// Возвращает { error } при провале валидации либо { values } с готовыми
// значениями в порядке колонок (first_name … notes).
function extractEmployeeFields(body) {
  const firstName = (body.first_name || '').trim();
  const lastName = (body.last_name || '').trim();

  if (firstName.length < 1 || lastName.length < 1) {
    return { error: 'Имя и фамилия обязательны' };
  }

  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'active';

  // user_id: либо положительное целое, либо NULL (нет привязки к аккаунту)
  let userId = parseInt(body.user_id, 10);
  if (!Number.isInteger(userId) || userId <= 0) userId = null;

  // hire_date: принимаем только YYYY-MM-DD, иначе NULL
  const hireDate = /^\d{4}-\d{2}-\d{2}$/.test(body.hire_date || '') ? body.hire_date : null;

  const str = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, 500) : null;
  };

  return {
    values: {
      first_name: firstName.slice(0, 120),
      last_name: lastName.slice(0, 120),
      position: str(body.position),
      department: str(body.department),
      phone: str(body.phone),
      email: str(body.email),
      hire_date: hireDate,
      status,
      user_id: userId,
      notes: str(body.notes)
    }
  };
}

async function handleEmployees(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    // LEFT JOIN на users — чтобы вернуть логин привязанного аккаунта (если есть)
    const sql = `
      SELECT e.*, u.username AS account_username
      FROM employees e
      LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM employees", [], (err2, countRow) => {
        res.setHeader('X-Total-Count', String((countRow && countRow.count) || 0));
        sendJson(res, 200, rows);
      });
    });
    return;
  }

  // Дальше — только изменяющие операции, требуют роли Admin/Superadmin
  if (!canWrite(user)) {
    return sendJson(res, 403, { success: false, message: 'Недостаточно прав (нужен Admin или Superadmin)' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const { error, values } = extractEmployeeFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      db.run(
        `INSERT INTO employees
          (first_name, last_name, position, department, phone, email, hire_date, status, user_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.first_name, values.last_name, values.position, values.department,
         values.phone, values.email, values.hire_date, values.status, values.user_id, values.notes],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка создания сотрудника' });
          logAction(user.username, `Добавлен сотрудник ${values.last_name} ${values.first_name}`);
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'PUT') {
    try {
      const id = parseId(parsedUrl);
      if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });

      const body = await getJsonBody(req);
      const { error, values } = extractEmployeeFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      // user_id намеренно НЕ трогаем: привязка к аккаунту задаётся при
      // регистрации/смене типа аккаунта, а форма редактирования сотрудника
      // её не передаёт — иначе связь с личным кабинетом обнулялась бы.
      db.run(
        `UPDATE employees SET
          first_name = ?, last_name = ?, position = ?, department = ?,
          phone = ?, email = ?, hire_date = ?, status = ?, notes = ?
         WHERE id = ?`,
        [values.first_name, values.last_name, values.position, values.department,
         values.phone, values.email, values.hire_date, values.status, values.notes, id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
          if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
          logAction(user.username, `Обновлён сотрудник id=${id}`);
          sendJson(res, 200, { success: true });
        }
      );
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });

    db.run("DELETE FROM employees WHERE id = ?", [id], function (err) {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
      if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
      logAction(user.username, `Удалён сотрудник id=${id}`);
      sendJson(res, 200, { success: true });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

module.exports = handleEmployees;
