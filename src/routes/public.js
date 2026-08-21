const { sendJson } = require('../utils');
const { db } = require('../../db');

function getArticles(req, res) {
  db.all("SELECT id, title, content, created_at FROM articles WHERE status = 'published' ORDER BY id DESC LIMIT 1000", [], (err, rows) => {
    if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

function getSettings(req, res) {
  db.all("SELECT key, value FROM settings", [], (err, rows) => {
    if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

// Публичная (урезанная) карточка инструмента — то, что открывается по QR-коду
// любым человеком без авторизации. Отдаём ТОЛЬКО данные для идентификации
// (название, категория, бренд/модель, серийный/инвентарный номер, статус,
// главное фото). Служебные данные (история передач, кому и сколько раз
// выдавался, наработка, заметки) сюда НЕ попадают.
function getToolPublic(req, res, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!id || id < 1) return sendJson(res, 400, { message: 'Не указан id' });

  const sql = `SELECT id, name, category, brand, model, serial_number,
                      inventory_number, status, photo_url
               FROM tools WHERE id = ?`;
  db.get(sql, [id], (err, tool) => {
    if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
    if (!tool) return sendJson(res, 404, { message: 'Инструмент не найден' });
    sendJson(res, 200, { success: true, tool });
  });
}

module.exports = async function handlePublic(req, res, parsedUrl, method) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/public/articles' && method === 'GET') return getArticles(req, res);
  if (pathname === '/api/public/settings' && method === 'GET') return getSettings(req, res);
  if (pathname === '/api/public/tool' && method === 'GET') return getToolPublic(req, res, parsedUrl);

  return sendJson(res, 404, { message: 'API endpoint не найден' });
};
