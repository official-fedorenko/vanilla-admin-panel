const { sendJson, getJsonBody, logAction } = require('../utils');
const { db } = require('../../db');

/**
 * Внутренние уведомления от администрации в личном кабинете.
 *
 *   GET  /api/cabinet/notifications            — свои + общие для всех (любой авторизованный)
 *   POST /api/cabinet/notifications/read       — отметить одно прочитанным {id}
 *   POST /api/cabinet/notifications/read-all   — отметить все видимые прочитанными
 *   POST /api/admin/notifications              — отправить {user_id: null|number, message} (Admin/Superadmin)
 *   GET  /api/admin/notifications               — история отправленных (Admin/Superadmin)
 *
 * user_id = NULL на notifications — уведомление для всех. Прочтения хранятся
 * отдельной таблицей (notification_reads), чтобы бродкаст не плодил по
 * строке на каждого адресата.
 */

function canManage(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

const MAX_MESSAGE_LEN = 500;

function getMyNotifications(req, res, user) {
  db.all(
    `SELECT n.id, n.message, n.created_at,
            (nr.notification_id IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
     WHERE n.user_id = ? OR n.user_id IS NULL
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [user.id, user.id],
    (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const notifications = (rows || []).map(r => ({ ...r, is_read: !!r.is_read }));
      sendJson(res, 200, { success: true, notifications });
    }
  );
}

function markRead(req, res, user) {
  getJsonBody(req).then(body => {
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { success: false, message: 'Не указан id' });
    db.run(
      "INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)",
      [id, user.id],
      (err) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true });
      }
    );
  }).catch(() => sendJson(res, 400, { success: false, message: 'Невалидный запрос' }));
}

function markAllRead(req, res, user) {
  db.run(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id)
     SELECT n.id, ? FROM notifications n WHERE n.user_id = ? OR n.user_id IS NULL`,
    [user.id, user.id],
    (err) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true });
    }
  );
}

function sendNotification(req, res, user) {
  getJsonBody(req).then(body => {
    const message = (body.message == null ? '' : String(body.message)).trim().slice(0, MAX_MESSAGE_LEN);
    if (!message) return sendJson(res, 400, { success: false, message: 'Введите текст уведомления' });

    const rawUserId = body.user_id;
    const targetUserId = (rawUserId === null || rawUserId === undefined || rawUserId === '')
      ? null
      : parseInt(rawUserId, 10);
    if (targetUserId !== null && (!Number.isInteger(targetUserId) || targetUserId <= 0)) {
      return sendJson(res, 400, { success: false, message: 'Некорректный получатель' });
    }

    const insert = () => {
      db.run(
        "INSERT INTO notifications (user_id, message, created_by) VALUES (?, ?, ?)",
        [targetUserId, message, user.id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Не удалось отправить уведомление' });
          logAction(user.username, targetUserId ? `Отправил уведомление пользователю id=${targetUserId}` : 'Отправил уведомление всем пользователям');
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
    };

    if (targetUserId === null) return insert();
    db.get("SELECT id FROM users WHERE id = ?", [targetUserId], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Получатель не найден' });
      insert();
    });
  }).catch(() => sendJson(res, 400, { success: false, message: 'Невалидный запрос' }));
}

function getSentHistory(req, res) {
  db.all(
    `SELECT n.id, n.message, n.created_at, n.user_id,
            u.username AS target_username, cb.username AS created_by_username
     FROM notifications n
     LEFT JOIN users u ON u.id = n.user_id
     LEFT JOIN users cb ON cb.id = n.created_by
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [],
    (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, notifications: rows || [] });
    }
  );
}

module.exports = function handleNotifications(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  if (p === '/api/cabinet/notifications' && method === 'GET') return getMyNotifications(req, res, user);
  if (p === '/api/cabinet/notifications/read' && method === 'POST') return markRead(req, res, user);
  if (p === '/api/cabinet/notifications/read-all' && method === 'POST') return markAllRead(req, res, user);

  if (p === '/api/admin/notifications') {
    if (!canManage(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    if (method === 'POST') return sendNotification(req, res, user);
    if (method === 'GET') return getSentHistory(req, res);
  }

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
