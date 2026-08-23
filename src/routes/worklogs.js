const { sendJson, getJsonBody, logAction } = require('../utils');
const { db } = require('../../db');

/**
 * Учёт рабочего времени.
 *
 *  Пользователь (свои записи):
 *    POST   /api/worklogs           — добавить запись { work_date, hours, note }
 *    GET    /api/worklogs/mine       — свои записи + итог
 *    DELETE /api/worklogs?id=        — удалить свою запись
 *
 *  Админ (по всем):
 *    GET    /api/worklogs/all[?user_id=&from=&to=] — записи всех (или одного)
 *    GET    /api/worklogs/summary                   — итоги по каждому пользователю
 */

function isAdmin(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

// Нормализуем часы: число в диапазоне (0, 24], округляем до 0.25.
function parseHours(raw) {
  const h = Math.round(parseFloat(raw) * 4) / 4;
  if (!Number.isFinite(h) || h <= 0 || h > 24) return null;
  return h;
}

// Дата в формате YYYY-MM-DD (не в будущем дальше сегодняшнего дня).
function parseDate(raw) {
  const s = String(raw || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d)) return null;
  // Не позволяем ставить дату дальше завтрашнего дня (защита от опечаток).
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.getTime() > tomorrow.getTime()) return null;
  return s;
}

async function addOwn(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const workDate = parseDate(body.work_date);
    const hours = parseHours(body.hours);
    const note = (body.note == null ? '' : String(body.note)).trim().slice(0, 300) || null;
    if (!workDate) return sendJson(res, 400, { success: false, message: 'Некорректная дата' });
    if (hours == null) return sendJson(res, 400, { success: false, message: 'Часы: число от 0 до 24' });

    db.run("INSERT INTO work_logs (user_id, work_date, hours, note) VALUES (?, ?, ?, ?)",
      [user.id, workDate, hours, note], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
        logAction(user.username, `Внёс ${hours} ч за ${workDate}`);
        sendJson(res, 201, { success: true, id: this.lastID });
      });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

function listMine(req, res, user) {
  db.all("SELECT id, work_date, hours, note, created_at FROM work_logs WHERE user_id = ? ORDER BY work_date DESC, id DESC LIMIT 500",
    [user.id], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const total = (rows || []).reduce((s, r) => s + (r.hours || 0), 0);
      sendJson(res, 200, { success: true, entries: rows || [], total });
    });
}

async function deleteOwn(req, res, user, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  // Пользователь удаляет только свою запись; админ — любую.
  const sql = isAdmin(user) ? "DELETE FROM work_logs WHERE id = ?" : "DELETE FROM work_logs WHERE id = ? AND user_id = ?";
  const params = isAdmin(user) ? [id] : [id, user.id];
  db.run(sql, params, function (err) {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
    if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Запись не найдена' });
    sendJson(res, 200, { success: true });
  });
}

function listAll(req, res, user, parsedUrl) {
  if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  const where = [];
  const params = [];
  const uid = parseInt(parsedUrl.searchParams.get('user_id'), 10);
  if (uid) { where.push("w.user_id = ?"); params.push(uid); }
  const from = parsedUrl.searchParams.get('from');
  const to = parsedUrl.searchParams.get('to');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push("w.work_date >= ?"); params.push(from); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("w.work_date <= ?"); params.push(to); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const sql = `
    SELECT w.id, w.user_id, u.username, w.work_date, w.hours, w.note, w.created_at
    FROM work_logs w JOIN users u ON u.id = w.user_id
    ${whereSql}
    ORDER BY w.work_date DESC, w.id DESC LIMIT 1000`;
  db.all(sql, params, (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const total = (rows || []).reduce((s, r) => s + (r.hours || 0), 0);
    sendJson(res, 200, { success: true, entries: rows || [], total });
  });
}

function summary(req, res, user) {
  if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  const sql = `
    SELECT u.id AS user_id, u.username,
           COALESCE(SUM(w.hours), 0) AS total_hours,
           COUNT(w.id) AS entries,
           MAX(w.work_date) AS last_date
    FROM users u LEFT JOIN work_logs w ON w.user_id = u.id
    GROUP BY u.id
    HAVING entries > 0
    ORDER BY total_hours DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, { success: true, users: rows || [] });
  });
}

module.exports = async function handleWorklogs(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  if (p === '/api/worklogs' && method === 'POST') return addOwn(req, res, user);
  if (p === '/api/worklogs/mine' && method === 'GET') return listMine(req, res, user);
  if (p === '/api/worklogs' && method === 'DELETE') return deleteOwn(req, res, user, parsedUrl);
  if (p === '/api/worklogs/all' && method === 'GET') return listAll(req, res, user, parsedUrl);
  if (p === '/api/worklogs/summary' && method === 'GET') return summary(req, res, user);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
