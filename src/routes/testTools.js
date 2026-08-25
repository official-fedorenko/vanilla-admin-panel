const { sendJson, logAction } = require('../utils');
const { db, TEST_TOOLS } = require('../../db');

/**
 * Управление тестовыми (демо) инструментами — только Superadmin.
 *   POST /api/admin/test-tools/add          — добавить набор демо-инструментов
 *   POST /api/admin/test-tools/remove       — удалить их
 *   POST /api/admin/tools-catalog/clear     — очистить ВЕСЬ каталог (включая реальные записи)
 *
 * Идентифицируем демо-инструменты по известным серийным номерам из TEST_TOOLS,
 * поэтому реальные записи не затрагиваются в add/remove. clear — это отдельная,
 * более мощная и опасная операция, удаляющая всё содержимое таблицы tools.
 */

const SERIAL_NUMBERS = TEST_TOOLS.map(t => t.serial_number);

function addTestTools(req, res, user) {
  let added = 0;
  db.serialize(() => {
    TEST_TOOLS.forEach(t => {
      // Пропускаем, если инструмент с таким серийным номером уже есть.
      db.get("SELECT id FROM tools WHERE serial_number = ?", [t.serial_number], (err, exists) => {
        if (err || exists) return;
        db.run(
          "INSERT INTO tools (name, category, brand, model, serial_number, inventory_number, status, photo_url) VALUES (?, ?, ?, ?, ?, ?, 'available', ?)",
          [t.name, t.category, t.brand, t.model, t.serial_number, t.inventory_number, t.photo_url]
        );
        added++;
      });
    });
    // Ответ отдаём после короткой паузы, чтобы вставки успели пройти.
    setTimeout(() => {
      logAction(user.username, 'Добавил тестовые инструменты');
      sendJson(res, 200, { success: true, message: 'Тестовые инструменты добавлены' });
    }, 200);
  });
}

function removeTestTools(req, res, user) {
  const placeholders = SERIAL_NUMBERS.map(() => '?').join(',');
  db.serialize(() => {
    db.run(`DELETE FROM tools WHERE serial_number IN (${placeholders})`, SERIAL_NUMBERS, function () {
      logAction(user.username, 'Удалил тестовые инструменты');
      sendJson(res, 200, { success: true, message: 'Тестовые инструменты удалены' });
    });
  });
}

function clearToolsCatalog(req, res, user) {
  db.serialize(() => {
    db.run("DELETE FROM tool_assignments", [], function () {
      db.run("DELETE FROM tools", [], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Не удалось очистить каталог' });
        const removed = this.changes;
        logAction(user.username, `Очистил каталог инструментов (удалено: ${removed})`);
        sendJson(res, 200, { success: true, message: `Каталог очищен, удалено инструментов: ${removed}` });
      });
    });
  });
}

module.exports = function handleTestTools(req, res, user, parsedUrl, method) {
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
  }
  const p = parsedUrl.pathname;
  if (p === '/api/admin/test-tools/add' && method === 'POST') return addTestTools(req, res, user);
  if (p === '/api/admin/test-tools/remove' && method === 'POST') return removeTestTools(req, res, user);
  if (p === '/api/admin/tools-catalog/clear' && method === 'POST') return clearToolsCatalog(req, res, user);
  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
