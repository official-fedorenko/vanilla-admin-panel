const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

module.exports = async function handleArticles(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    db.all("SELECT * FROM articles ORDER BY id DESC", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
  } else if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      if (!body.title || body.title.trim().length < 3) {
        return sendJson(res, 400, { message: 'Название статьи обязательно (минимум 3 символа)' });
      }
      db.run("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)", 
        [body.title.trim(), body.content || '', body.status || 'draft'], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка создания' });
          sendJson(res, 201, { id: this.lastID, success: true });
        });
    } catch (e) {
      sendJson(res, 400, { message: 'Невалидный JSON' });
    }
  } else if (method === 'PUT') {
    try {
      const id = parsedUrl.searchParams.get('id');
      const body = await getJsonBody(req);
      db.run("UPDATE articles SET title = ?, content = ?, status = ? WHERE id = ?", 
        [body.title, body.content, body.status, id], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка обновления' });
          sendJson(res, 200, { success: true });
        });
    } catch (e) {
      sendJson(res, 400, { message: 'Невалидный JSON' });
    }
  } else if (method === 'DELETE') {
    const id = parsedUrl.searchParams.get('id');
    db.run("DELETE FROM articles WHERE id = ?", [id], function(err) {
      if (err) return sendJson(res, 500, { message: 'Ошибка удаления' });
      sendJson(res, 200, { success: true });
    });
  }
};
