const sanitizeHtml = require('sanitize-html');
const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

const ALLOWED_STATUSES = ['draft', 'published'];

// Разрешённые теги/атрибуты соответствуют тому, что реально производит редактор Quill
const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
    'span', 'img'
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt'],
    span: ['class'],
    li: ['class'],
    p: ['class']
  },
  allowedSchemes: ['http', 'https', 'data'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] }
};

function sanitizeContent(content) {
  return sanitizeHtml(content || '', SANITIZE_OPTIONS);
}

function parseId(parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function handleArticles(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    // Пока без полноценной пагинации в UI — жёсткий потолок защищает от
    // отдачи всей таблицы целиком при большом количестве статей.
    db.all("SELECT * FROM articles ORDER BY id DESC LIMIT 1000", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
  } else if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      if (!body.title || body.title.trim().length < 3) {
        return sendJson(res, 400, { message: 'Название статьи обязательно (минимум 3 символа)' });
      }
      const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'draft';
      db.run("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)",
        [body.title.trim(), sanitizeContent(body.content), status], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка создания' });
          sendJson(res, 201, { id: this.lastID, success: true });
        });
    } catch (e) {
      sendJson(res, 400, { message: e.message || 'Невалидный JSON' });
    }
  } else if (method === 'PUT') {
    try {
      const id = parseId(parsedUrl);
      if (!id) return sendJson(res, 400, { message: 'Не указан корректный id' });

      const body = await getJsonBody(req);
      if (!body.title || body.title.trim().length < 3) {
        return sendJson(res, 400, { message: 'Название статьи обязательно (минимум 3 символа)' });
      }
      const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'draft';

      db.run("UPDATE articles SET title = ?, content = ?, status = ? WHERE id = ?",
        [body.title.trim(), sanitizeContent(body.content), status, id], function(err) {
          if (err) return sendJson(res, 500, { message: 'Ошибка обновления' });
          if (this.changes === 0) return sendJson(res, 404, { message: 'Статья не найдена' });
          sendJson(res, 200, { success: true });
        });
    } catch (e) {
      sendJson(res, 400, { message: e.message || 'Невалидный JSON' });
    }
  } else if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { message: 'Не указан корректный id' });

    db.run("DELETE FROM articles WHERE id = ?", [id], function(err) {
      if (err) return sendJson(res, 500, { message: 'Ошибка удаления' });
      if (this.changes === 0) return sendJson(res, 404, { message: 'Статья не найдена' });
      sendJson(res, 200, { success: true });
    });
  } else {
    sendJson(res, 405, { message: 'Метод не поддерживается' });
  }
}

module.exports = handleArticles;
module.exports.sanitizeContent = sanitizeContent;
