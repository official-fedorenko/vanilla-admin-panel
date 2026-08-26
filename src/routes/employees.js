const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db, hashPassword } = require('../../db');

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

const ALLOWED_STATUSES = ['active', 'vacation', 'sick_leave', 'inactive', 'fired'];

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

// ================= Связка «сотрудник ↔ аккаунт» =================
// Все под /api/crud/employees/... — навигация и связывание карточки сотрудника
// с учётной записью. Просмотр/связывание — Admin+Superadmin; создание аккаунта
// (задаёт пароль) — только Superadmin.

// Инфо о связке: по employee_id ИЛИ user_id вернуть карточку и аккаунт (если есть).
function getLinkInfo(res, parsedUrl) {
  const empId = parseInt(parsedUrl.searchParams.get('employee_id'), 10);
  const usrId = parseInt(parsedUrl.searchParams.get('user_id'), 10);
  const accountFields = 'id, username, email, role, account_type';
  const empFields = 'id, first_name, last_name, position, status, user_id';
  const send = (emp, acc) => sendJson(res, 200, { success: true, employee: emp || null, account: acc || null });

  if (Number.isInteger(empId) && empId > 0) {
    db.get(`SELECT ${empFields} FROM employees WHERE id = ?`, [empId], (e, emp) => {
      if (e) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
      if (!emp.user_id) return send(emp, null);
      db.get(`SELECT ${accountFields} FROM users WHERE id = ?`, [emp.user_id], (e2, acc) => send(emp, acc || null));
    });
  } else if (Number.isInteger(usrId) && usrId > 0) {
    db.get(`SELECT ${accountFields} FROM users WHERE id = ?`, [usrId], (e, acc) => {
      if (e) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!acc) return sendJson(res, 404, { success: false, message: 'Аккаунт не найден' });
      db.get(`SELECT ${empFields} FROM employees WHERE user_id = ?`, [usrId], (e2, emp) => send(emp || null, acc));
    });
  } else {
    sendJson(res, 400, { success: false, message: 'Укажите employee_id или user_id' });
  }
}

// Кандидаты для привязки: for=account → аккаунты без карточки; for=card → карточки без аккаунта.
function getCandidates(res, parsedUrl) {
  const kind = parsedUrl.searchParams.get('for');
  if (kind === 'account') {
    db.all(
      `SELECT id, username, email, role, account_type FROM users
       WHERE id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL)
       ORDER BY username COLLATE NOCASE`, [],
      (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, users: rows || [] });
      });
  } else if (kind === 'card') {
    db.all(
      `SELECT id, first_name, last_name, position FROM employees
       WHERE user_id IS NULL
       ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`, [],
      (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, employees: rows || [] });
      });
  } else {
    sendJson(res, 400, { success: false, message: 'Параметр for: account | card' });
  }
}

// Привязать существующий аккаунт к карточке.
async function linkAccount(req, res, user) {
  const body = await getJsonBody(req);
  const empId = parseInt(body.employee_id, 10);
  const usrId = parseInt(body.user_id, 10);
  if (!(empId > 0) || !(usrId > 0)) return sendJson(res, 400, { success: false, message: 'Нужны employee_id и user_id' });
  db.get("SELECT id FROM employees WHERE user_id = ? AND id != ?", [usrId, empId], (e, other) => {
    if (e) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (other) return sendJson(res, 409, { success: false, message: 'Этот аккаунт уже привязан к другому сотруднику' });
    db.run("UPDATE employees SET user_id = ? WHERE id = ?", [usrId, empId], function (uErr) {
      if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось привязать' });
      if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
      db.run("UPDATE users SET account_type = 'employee' WHERE id = ?", [usrId], () => {
        logAction(user.username, `Привязал аккаунт user_id=${usrId} к сотруднику id=${empId}`);
        sendJson(res, 200, { success: true });
      });
    });
  });
}

// Отвязать аккаунт от карточки (сам аккаунт и карточка остаются).
async function unlinkAccount(req, res, user) {
  const body = await getJsonBody(req);
  const empId = parseInt(body.employee_id, 10);
  if (!(empId > 0)) return sendJson(res, 400, { success: false, message: 'Нужен employee_id' });
  db.run("UPDATE employees SET user_id = NULL WHERE id = ?", [empId], function (err) {
    if (err) return sendJson(res, 500, { success: false, message: 'Не удалось отвязать' });
    if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
    logAction(user.username, `Отвязал аккаунт от сотрудника id=${empId}`);
    sendJson(res, 200, { success: true });
  });
}

// Создать карточку сотрудника для аккаунта, который её ещё не имеет.
async function createCardForUser(req, res, user) {
  const body = await getJsonBody(req);
  const usrId = parseInt(body.user_id, 10);
  if (!(usrId > 0)) return sendJson(res, 400, { success: false, message: 'Нужен user_id' });
  db.get("SELECT id, username, email FROM users WHERE id = ?", [usrId], (e, u) => {
    if (e) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!u) return sendJson(res, 404, { success: false, message: 'Аккаунт не найден' });
    db.get("SELECT id FROM employees WHERE user_id = ?", [usrId], (e2, existing) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (existing) return sendJson(res, 409, { success: false, message: 'У аккаунта уже есть карточка сотрудника' });
      db.run(
        "INSERT INTO employees (first_name, last_name, email, user_id, status) VALUES (?, '', ?, ?, 'active')",
        [u.username, u.email, usrId],
        function (insErr) {
          if (insErr) return sendJson(res, 500, { success: false, message: 'Не удалось создать карточку' });
          db.run("UPDATE users SET account_type = 'employee' WHERE id = ?", [usrId], () => {
            logAction(user.username, `Создал карточку сотрудника для аккаунта user_id=${usrId} (id=${this.lastID})`);
            sendJson(res, 201, { success: true, id: this.lastID });
          });
        }
      );
    });
  });
}

// Создать аккаунт для карточки сотрудника и сразу привязать. Только Superadmin.
async function createAccountForEmployee(req, res, user) {
  const body = await getJsonBody(req);
  const empId = parseInt(body.employee_id, 10);
  const username = (body.username || '').trim();
  const email = (body.email || '').trim();
  const password = String(body.password || '');
  const role = ['User', 'Admin', 'Superadmin'].includes(body.role) ? body.role : 'User';
  if (!(empId > 0)) return sendJson(res, 400, { success: false, message: 'Нужен employee_id' });
  if (!username || !email || !password) return sendJson(res, 400, { success: false, message: 'Логин, email и пароль обязательны' });
  if (password.length < 8) return sendJson(res, 400, { success: false, message: 'Пароль минимум 8 символов' });

  db.get("SELECT id, user_id FROM employees WHERE id = ?", [empId], (e, emp) => {
    if (e) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
    if (emp.user_id) return sendJson(res, 409, { success: false, message: 'У сотрудника уже есть аккаунт' });
    db.run(
      "INSERT INTO users (username, email, password_hash, role, account_type) VALUES (?, ?, ?, ?, 'employee')",
      [username, email, hashPassword(password), role],
      function (insErr) {
        if (insErr) {
          const msg = insErr.message.includes('UNIQUE') ? 'Логин или email уже заняты' : 'Не удалось создать аккаунт';
          return sendJson(res, 400, { success: false, message: msg });
        }
        const newUserId = this.lastID;
        db.run("UPDATE employees SET user_id = ? WHERE id = ?", [newUserId, empId], (uErr) => {
          if (uErr) return sendJson(res, 500, { success: false, message: 'Аккаунт создан, но не удалось привязать' });
          logAction(user.username, `Создал аккаунт ${username} (${role}) и привязал к сотруднику id=${empId}`);
          sendJson(res, 201, { success: true, user_id: newUserId });
        });
      }
    );
  });
}

async function handleEmployees(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  // --- Под-маршруты связки «сотрудник ↔ аккаунт» ---
  const p = parsedUrl.pathname;
  if (p === '/api/crud/employees/link' && method === 'GET') return getLinkInfo(res, parsedUrl);
  if (p === '/api/crud/employees/candidates' && method === 'GET') return getCandidates(res, parsedUrl);
  if (p.startsWith('/api/crud/employees/') && method === 'POST') {
    if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
    if (p === '/api/crud/employees/link') return linkAccount(req, res, user);
    if (p === '/api/crud/employees/unlink') return unlinkAccount(req, res, user);
    if (p === '/api/crud/employees/create-card') return createCardForUser(req, res, user);
    if (p === '/api/crud/employees/create-account') {
      if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Создавать аккаунты может только Superadmin' });
      return createAccountForEmployee(req, res, user);
    }
    return sendJson(res, 404, { success: false, message: 'Не найдено' });
  }

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
