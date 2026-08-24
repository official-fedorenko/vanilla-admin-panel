const { sendJson, logAction } = require('../utils');
const { db, hashPassword, TEST_EMPLOYEES } = require('../../db');

/**
 * Управление тестовыми (демо) сотрудниками — только Superadmin.
 *   POST /api/admin/test-employees/add     — добавить набор демо-сотрудников
 *   POST /api/admin/test-employees/remove  — удалить их (сотрудник + аккаунт)
 *
 * Идентифицируем демо-сотрудников по известным email из TEST_EMPLOYEES,
 * поэтому реальные записи не затрагиваются.
 */

const EMAILS = TEST_EMPLOYEES.map(e => e.email);

function addTestEmployees(req, res, user) {
  const pass = hashPassword('1234qwer');
  let added = 0;
  db.serialize(() => {
    TEST_EMPLOYEES.forEach(e => {
      // Пропускаем, если сотрудник с таким email уже есть.
      db.get("SELECT id FROM employees WHERE email = ?", [e.email], (err, exists) => {
        if (err || exists) return;
        db.run(
          "INSERT OR IGNORE INTO users (username, email, password_hash, role, account_type) VALUES (?, ?, ?, 'User', 'employee')",
          [e.username, e.email, pass],
          function () {
            const uid = this.lastID || null;
            const findUser = uid
              ? Promise.resolve(uid)
              : new Promise(r => db.get("SELECT id FROM users WHERE email = ?", [e.email], (er, u) => r(u ? u.id : null)));
            Promise.resolve(findUser).then(userId => {
              db.run(
                "INSERT INTO employees (first_name, last_name, position, department, phone, email, hire_date, status, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
                [e.first, e.last, e.position, e.department, e.phone, e.email, e.hire, userId]
              );
              added++;
            });
          }
        );
      });
    });
    // Ответ отдаём после короткой паузы, чтобы вставки успели пройти.
    setTimeout(() => {
      logAction(user.username, 'Добавил тестовых сотрудников');
      sendJson(res, 200, { success: true, message: 'Тестовые сотрудники добавлены' });
    }, 200);
  });
}

function removeTestEmployees(req, res, user) {
  const placeholders = EMAILS.map(() => '?').join(',');
  db.serialize(() => {
    // Сначала сотрудники, затем их аккаунты (только account_type='employee').
    db.run(`DELETE FROM employees WHERE email IN (${placeholders})`, EMAILS, function () {
      db.run(
        `DELETE FROM users WHERE email IN (${placeholders}) AND account_type = 'employee' AND role = 'User'`,
        EMAILS,
        function () {
          logAction(user.username, 'Удалил тестовых сотрудников');
          sendJson(res, 200, { success: true, message: 'Тестовые сотрудники удалены' });
        }
      );
    });
  });
}

module.exports = function handleTestEmployees(req, res, user, parsedUrl, method) {
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
  }
  const p = parsedUrl.pathname;
  if (p === '/api/admin/test-employees/add' && method === 'POST') return addTestEmployees(req, res, user);
  if (p === '/api/admin/test-employees/remove' && method === 'POST') return removeTestEmployees(req, res, user);
  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
