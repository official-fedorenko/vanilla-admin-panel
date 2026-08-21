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

    // Общие (глобальные) настройки публичной карточки из settings —
    // единые для всех инструментов. Ключ отсутствует → по умолчанию показываем.
    db.all("SELECT key, value FROM settings WHERE key LIKE 'public_card_%'", [], (e2, rows) => {
      if (e2) return sendJson(res, 500, { message: 'Ошибка базы данных' });

      const cfg = {};
      (rows || []).forEach(r => { cfg[r.key] = r.value; });
      const on = (key) => (cfg[key] === undefined ? true : cfg[key] === 'true');

      // Карточка целиком выключена — наружу инструмент не показываем.
      if (!on('public_card_enabled')) {
        return sendJson(res, 404, { message: 'Карточка недоступна' });
      }

      // Название и категория показываются всегда (это база для идентификации).
      const out = { id: tool.id, name: tool.name, category: tool.category };
      if (on('public_card_show_photo'))     out.photo_url = tool.photo_url;
      if (on('public_card_show_brand'))     out.brand = tool.brand;
      if (on('public_card_show_model'))     out.model = tool.model;
      if (on('public_card_show_serial'))    out.serial_number = tool.serial_number;
      if (on('public_card_show_inventory')) out.inventory_number = tool.inventory_number;
      if (on('public_card_show_status'))    out.status = tool.status;

      sendJson(res, 200, { success: true, tool: out });
    });
  });
}

module.exports = async function handlePublic(req, res, parsedUrl, method) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/public/articles' && method === 'GET') return getArticles(req, res);
  if (pathname === '/api/public/settings' && method === 'GET') return getSettings(req, res);
  if (pathname === '/api/public/tool' && method === 'GET') return getToolPublic(req, res, parsedUrl);

  return sendJson(res, 404, { message: 'API endpoint не найден' });
};
