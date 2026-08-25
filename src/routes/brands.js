const { sendJson, getJsonBody, isInternalPath } = require('../utils');
const { db } = require('../../db');

/**
 * Реестр брендов инструмента с иконками (таблица brands).
 *
 *   GET    /api/brands        — список всех брендов (любой авторизованный)
 *   POST   /api/brands        — добавить бренд (Superadmin)
 *   PUT    /api/brands?id=    — изменить бренд (Superadmin)
 *   DELETE /api/brands?id=    — удалить бренд (Superadmin)
 *
 * brand на tools/catalog_models остаётся обычной строкой без FK — этот
 * реестр лишь сопоставляет известным названиям иконку. Удаление бренда
 * отсюда не портит уже сохранённые записи, просто пропадает иконка
 * (рендер откатывается на иконку категории / generic-заглушку).
 */

function parseId(parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanName(v) {
  const s = (v == null ? '' : String(v)).trim();
  return s.length ? s.slice(0, 80) : null;
}

function cleanIcon(v) {
  const s = (v == null ? '' : String(v)).trim().split('#')[0];
  if (!s) return null;
  return isInternalPath(s) ? s : null;
}

module.exports = function handleBrands(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    db.all("SELECT id, name, icon_url, is_preset FROM brands ORDER BY name COLLATE NOCASE", [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка БД' });
      sendJson(res, 200, { success: true, brands: rows || [] });
    });
    return;
  }

  // Изменения — только Superadmin.
  if (user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Бренды может менять только Superadmin' });
  }

  if (method === 'POST') {
    getJsonBody(req).then(body => {
      const name = cleanName(body.name);
      if (!name) return sendJson(res, 400, { success: false, message: 'Укажите название бренда' });
      const iconUrl = body.icon_url ? cleanIcon(body.icon_url) : null;
      if (body.icon_url && !iconUrl) return sendJson(res, 400, { success: false, message: 'Недопустимый путь иконки' });

      db.run(
        "INSERT INTO brands (name, icon_url, is_preset, created_by) VALUES (?, ?, 0, ?)",
        [name, iconUrl, user.id],
        function (err) {
          if (err) {
            if (String(err.message || '').includes('UNIQUE')) {
              return sendJson(res, 409, { success: false, message: 'Бренд с таким названием уже существует' });
            }
            return sendJson(res, 500, { success: false, message: 'Не удалось добавить бренд' });
          }
          sendJson(res, 201, { success: true, id: this.lastID, name, icon_url: iconUrl });
        }
      );
    }).catch(() => sendJson(res, 400, { success: false, message: 'Невалидный запрос' }));
    return;
  }

  if (method === 'PUT') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
    getJsonBody(req).then(body => {
      const updates = [];
      const vals = [];
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) return sendJson(res, 400, { success: false, message: 'Укажите название бренда' });
        updates.push('name = ?');
        vals.push(name);
      }
      if (body.icon_url !== undefined) {
        const iconUrl = body.icon_url ? cleanIcon(body.icon_url) : null;
        if (body.icon_url && !iconUrl) return sendJson(res, 400, { success: false, message: 'Недопустимый путь иконки' });
        updates.push('icon_url = ?');
        vals.push(iconUrl);
      }
      if (!updates.length) return sendJson(res, 400, { success: false, message: 'Нечего обновлять' });
      updates.push('updated_at = CURRENT_TIMESTAMP');
      vals.push(id);

      db.run(`UPDATE brands SET ${updates.join(', ')} WHERE id = ?`, vals, function (err) {
        if (err) {
          if (String(err.message || '').includes('UNIQUE')) {
            return sendJson(res, 409, { success: false, message: 'Бренд с таким названием уже существует' });
          }
          return sendJson(res, 500, { success: false, message: 'Не удалось изменить бренд' });
        }
        if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Бренд не найден' });
        sendJson(res, 200, { success: true });
      });
    }).catch(() => sendJson(res, 400, { success: false, message: 'Невалидный запрос' }));
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
    db.run("DELETE FROM brands WHERE id = ?", [id], function (err) {
      if (err) return sendJson(res, 500, { success: false, message: 'Не удалось удалить бренд' });
      if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Бренд не найден' });
      sendJson(res, 200, { success: true });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
};
