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
                      inventory_number, status, photo_url, purchase_date, notes
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

      // Название показывается всегда (это заголовок карточки). Остальные поля —
      // по глобальным настройкам, чтобы супер-админ решал, что видно.
      const out = { id: tool.id, name: tool.name };
      if (on('public_card_show_category'))      out.category = tool.category;
      if (on('public_card_show_photo'))         out.photo_url = tool.photo_url;
      if (on('public_card_show_brand'))         out.brand = tool.brand;
      if (on('public_card_show_model'))         out.model = tool.model;
      if (on('public_card_show_serial'))        out.serial_number = tool.serial_number;
      if (on('public_card_show_inventory'))     out.inventory_number = tool.inventory_number;
      if (on('public_card_show_status'))        out.status = tool.status;
      if (on('public_card_show_purchase_date')) out.purchase_date = tool.purchase_date;
      if (on('public_card_show_notes'))         out.notes = tool.notes;

      if (on('public_card_show_holder')) {
        const holderSql = `
          SELECT e.first_name, e.last_name FROM tool_assignments a
          JOIN employees e ON e.id = a.employee_id
          WHERE a.tool_id = ? AND a.returned_at IS NULL
          ORDER BY a.issued_at DESC LIMIT 1`;
        db.get(holderSql, [id], (e3, holder) => {
          if (holder) out.holder_name = [holder.last_name, holder.first_name].filter(Boolean).join(' ') || null;
          sendJson(res, 200, { success: true, tool: out });
        });
        return;
      }

      sendJson(res, 200, { success: true, tool: out });
    });
  });
}

// Публичная (урезанная) карточка авто — то же самое, что getToolPublic,
// только источник — vehicles и настройки public_vehicle_card_*.
function getVehiclePublic(req, res, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!id || id < 1) return sendJson(res, 400, { message: 'Не указан id' });

  const sql = `SELECT id, name, category, brand, model, year, plate_number,
                      vin, status, photo_url, mileage, purchase_date, notes
               FROM vehicles WHERE id = ?`;
  db.get(sql, [id], (err, vehicle) => {
    if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
    if (!vehicle) return sendJson(res, 404, { message: 'Авто не найдено' });

    db.all("SELECT key, value FROM settings WHERE key LIKE 'public_vehicle_card_%'", [], (e2, rows) => {
      if (e2) return sendJson(res, 500, { message: 'Ошибка базы данных' });

      const cfg = {};
      (rows || []).forEach(r => { cfg[r.key] = r.value; });
      const on = (key) => (cfg[key] === undefined ? true : cfg[key] === 'true');

      if (!on('public_vehicle_card_enabled')) {
        return sendJson(res, 404, { message: 'Карточка недоступна' });
      }

      const out = { id: vehicle.id, name: vehicle.name };
      if (on('public_vehicle_card_show_category'))      out.category = vehicle.category;
      if (on('public_vehicle_card_show_photo'))         out.photo_url = vehicle.photo_url;
      if (on('public_vehicle_card_show_brand'))         out.brand = vehicle.brand;
      if (on('public_vehicle_card_show_model'))         out.model = vehicle.model;
      if (on('public_vehicle_card_show_year'))          out.year = vehicle.year;
      if (on('public_vehicle_card_show_plate'))         out.plate_number = vehicle.plate_number;
      if (on('public_vehicle_card_show_vin'))           out.vin = vehicle.vin;
      if (on('public_vehicle_card_show_status'))        out.status = vehicle.status;
      if (on('public_vehicle_card_show_mileage'))       out.mileage = vehicle.mileage;
      if (on('public_vehicle_card_show_purchase_date')) out.purchase_date = vehicle.purchase_date;
      if (on('public_vehicle_card_show_notes'))         out.notes = vehicle.notes;

      if (on('public_vehicle_card_show_holder')) {
        const holderSql = `
          SELECT e.first_name, e.last_name FROM vehicle_assignments a
          JOIN employees e ON e.id = a.employee_id
          WHERE a.vehicle_id = ? AND a.returned_at IS NULL
          ORDER BY a.issued_at DESC LIMIT 1`;
        db.get(holderSql, [id], (e3, holder) => {
          if (holder) out.holder_name = [holder.last_name, holder.first_name].filter(Boolean).join(' ') || null;
          sendJson(res, 200, { success: true, vehicle: out });
        });
        return;
      }

      sendJson(res, 200, { success: true, vehicle: out });
    });
  });
}

module.exports = async function handlePublic(req, res, parsedUrl, method) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/public/articles' && method === 'GET') return getArticles(req, res);
  if (pathname === '/api/public/settings' && method === 'GET') return getSettings(req, res);
  if (pathname === '/api/public/tool' && method === 'GET') return getToolPublic(req, res, parsedUrl);
  if (pathname === '/api/public/vehicle' && method === 'GET') return getVehiclePublic(req, res, parsedUrl);

  return sendJson(res, 404, { message: 'API endpoint не найден' });
};
