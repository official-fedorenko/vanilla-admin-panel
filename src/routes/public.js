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

module.exports = async function handlePublic(req, res, parsedUrl, method) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/public/articles' && method === 'GET') return getArticles(req, res);
  if (pathname === '/api/public/settings' && method === 'GET') return getSettings(req, res);

  return sendJson(res, 404, { message: 'API endpoint не найден' });
};
