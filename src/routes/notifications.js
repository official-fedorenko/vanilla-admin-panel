const { sendJson, getJsonBody, logAction } = require('../utils');
const { db } = require('../../db');

/**
 * Внутренние уведомления от администрации в личном кабинете.
 *
 *   GET    /api/cabinet/notifications            — свои + общие для всех (любой авторизованный)
 *   POST   /api/cabinet/notifications/read       — отметить одно прочитанным {id}
 *   POST   /api/cabinet/notifications/read-all   — отметить все видимые прочитанными
 *   POST   /api/admin/notifications              — отправить {user_id: null|number, message, scheduled_at?} (Admin/Superadmin)
 *   GET    /api/admin/notifications               — история отправленных, с датой/статусом/счётчиком прочтений (Admin/Superadmin)
 *   DELETE /api/admin/notifications?id=           — удалить (Admin/Superadmin)
 *
 * user_id = NULL на notifications — уведомление для всех. Прочтения хранятся
 * отдельной таблицей (notification_reads), чтобы бродкаст не плодил по
 * строке на каждого адресата.
 *
 * scheduled_at = NULL — отправлено сразу. Если задано будущим временем,
 * уведомление появляется у получателя только когда оно наступит — без
 * фонового планировщика, просто фильтр в выборке кабинета.
 */

function canManage(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

const MAX_MESSAGE_LEN = 500;

// 'YYYY-MM-DDTHH:MM' (значение <input type="datetime-local">) → 'YYYY-MM-DD HH:MM:00',
// как SQLite хранит DATETIME по умолчанию в этом проекте.
function parseScheduledAt(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (!m) return null;
  return `${m[1]} ${m[2]}:00`;
}

function getMyNotifications(req, res, user) {
  db.all(
    `SELECT n.id, n.message, n.created_at,
            (nr.notification_id IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = ?
     WHERE (n.user_id = ? OR n.user_id IS NULL)
       AND (n.scheduled_at IS NULL OR n.scheduled_at <= CURRENT_TIMESTAMP)
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
     SELECT n.id, ? FROM notifications n
     WHERE (n.user_id = ? OR n.user_id IS NULL)
       AND (n.scheduled_at IS NULL OR n.scheduled_at <= CURRENT_TIMESTAMP)`,
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

    let scheduledAt = null;
    if (body.scheduled_at) {
      scheduledAt = parseScheduledAt(body.scheduled_at);
      if (!scheduledAt) return sendJson(res, 400, { success: false, message: 'Некорректная дата отправки' });
      if (scheduledAt <= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
        return sendJson(res, 400, { success: false, message: 'Дата отправки должна быть в будущем' });
      }
    }

    const insert = () => {
      db.run(
        "INSERT INTO notifications (user_id, message, created_by, scheduled_at) VALUES (?, ?, ?, ?)",
        [targetUserId, message, user.id, scheduledAt],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Не удалось отправить уведомление' });
          const who = targetUserId ? `пользователю id=${targetUserId}` : 'всем пользователям';
          logAction(user.username, scheduledAt ? `Запланировал уведомление ${who} на ${scheduledAt}` : `Отправил уведомление ${who}`);
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
  db.get("SELECT COUNT(*) AS c FROM users", [], (uErr, uCountRow) => {
    if (uErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const totalUsers = (uCountRow && uCountRow.c) || 0;

    db.all(
      `SELECT n.id, n.message, n.created_at, n.scheduled_at, n.user_id,
              u.username AS target_username, ue.first_name AS target_first_name, ue.last_name AS target_last_name,
              cb.username AS created_by_username,
              (SELECT COUNT(*) FROM notification_reads nr WHERE nr.notification_id = n.id) AS read_count
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       LEFT JOIN employees ue ON ue.user_id = u.id
       LEFT JOIN users cb ON cb.id = n.created_by
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [],
      (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const notifications = (rows || []).map(r => {
          const targetFullName = [r.target_first_name, r.target_last_name].filter(Boolean).join(' ').trim();
          return {
            id: r.id,
            message: r.message,
            created_at: r.created_at,
            scheduled_at: r.scheduled_at,
            is_pending: !!(r.scheduled_at && r.scheduled_at > now),
            user_id: r.user_id,
            target_name: r.user_id ? (targetFullName || r.target_username) : null,
            created_by_username: r.created_by_username,
            read_count: r.read_count || 0,
            total_recipients: r.user_id ? 1 : totalUsers
          };
        });
        sendJson(res, 200, { success: true, notifications });
      }
    );
  });
}

function deleteNotification(req, res, user, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  db.run("DELETE FROM notifications WHERE id = ?", [id], function (err) {
    if (err) return sendJson(res, 500, { success: false, message: 'Не удалось удалить' });
    if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Уведомление не найдено' });
    logAction(user.username, `Удалил уведомление id=${id}`);
    sendJson(res, 200, { success: true });
  });
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
    if (method === 'DELETE') return deleteNotification(req, res, user, parsedUrl);
  }

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
