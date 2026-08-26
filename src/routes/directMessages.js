const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

// Личные чаты между сотрудниками (не путать с чатом поддержки в support.js —
// там переписка user<->admin, здесь — сотрудник<->сотрудник напрямую).

// SSE pub/sub по диалогам, тот же паттерн, что в support.js.
const conversationSubscribers = new Map(); // conversation_id -> Set<res>
function subscribe(conversationId, res) {
  if (!conversationSubscribers.has(conversationId)) conversationSubscribers.set(conversationId, new Set());
  conversationSubscribers.get(conversationId).add(res);
}
function unsubscribe(conversationId, res) {
  const set = conversationSubscribers.get(conversationId);
  if (!set) return;
  set.delete(res);
  if (!set.size) conversationSubscribers.delete(conversationId);
}
function publish(conversationId, payload) {
  const set = conversationSubscribers.get(conversationId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  set.forEach(res => { try { res.write(data); } catch (e) {} });
}
setInterval(() => {
  conversationSubscribers.forEach((set, conversationId) => {
    set.forEach(res => {
      try { res.write(': ping\n\n'); } catch (e) { unsubscribe(conversationId, res); }
    });
  });
}, 20000).unref();

function conversationId(a, b) {
  const [x, y] = [a, b].sort((n1, n2) => n1 - n2);
  return `dm_${x}_${y}`;
}

// Личные чаты доступны только сотрудникам (account_type='employee') — клиенты
// в этот функционал не допускаются вовсе.
function requireEmployee(user, cb) {
  db.get("SELECT account_type FROM users WHERE id = ?", [user.id], (err, row) => {
    if (err || !row) return cb(false);
    cb(row.account_type === 'employee');
  });
}

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return full || row.username;
}

module.exports = function handleDirectMessages(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  requireEmployee(user, (isEmployee) => {
    if (!isEmployee) return sendJson(res, 403, { success: false, message: 'Личные чаты доступны только сотрудникам' });

    // GET /api/dm/contacts — список коллег с последним сообщением/непрочитанным.
    if (p === '/api/dm/contacts' && method === 'GET') {
      const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
      db.all(
        `SELECT u.id, u.username, u.avatar_url, e.first_name, e.last_name
         FROM users u LEFT JOIN employees e ON e.user_id = u.id
         WHERE u.account_type = 'employee' AND u.id != ?
         ORDER BY u.username COLLATE NOCASE ASC`,
        [user.id],
        (err, rows) => {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          const agg = `
            SELECT
              CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id,
              MAX(created_at) AS last_activity,
              (SELECT m2.message FROM direct_messages m2
                WHERE m2.conversation_id = direct_messages.conversation_id
                ORDER BY m2.id DESC LIMIT 1) AS last_message,
              (SELECT m3.sender_id FROM direct_messages m3
                WHERE m3.conversation_id = direct_messages.conversation_id
                ORDER BY m3.id DESC LIMIT 1) AS last_sender_id,
              SUM(CASE WHEN recipient_id = ? AND is_read = 0 THEN 1 ELSE 0 END) AS unread_count
            FROM direct_messages
            WHERE sender_id = ? OR recipient_id = ?
            GROUP BY other_id`;
          db.all(agg, [user.id, user.id, user.id, user.id], (e2, aggRows) => {
            if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            const byOther = {};
            (aggRows || []).forEach(a => { byOther[a.other_id] = a; });
            let contacts = (rows || []).map(r => {
              const a = byOther[r.id] || {};
              return {
                user_id: r.id,
                name: displayName(r),
                avatar_url: r.avatar_url || null,
                last_message: a.last_message || null,
                last_from_me: a.last_sender_id === user.id,
                last_activity: a.last_activity || null,
                unread_count: a.unread_count || 0
              };
            });
            if (q) contacts = contacts.filter(c => c.name.toLowerCase().includes(q));
            contacts.sort((a, b) => {
              if ((b.unread_count || 0) !== (a.unread_count || 0)) return (b.unread_count || 0) - (a.unread_count || 0);
              const ta = a.last_activity ? Date.parse(String(a.last_activity).replace(' ', 'T')) : 0;
              const tb = b.last_activity ? Date.parse(String(b.last_activity).replace(' ', 'T')) : 0;
              if (tb !== ta) return tb - ta;
              return a.name.localeCompare(b.name, 'ru');
            });
            sendJson(res, 200, { success: true, contacts });
          });
        }
      );
      return;
    }

    // GET /api/dm/unread-count — суммарный бейдж по всем диалогам.
    if (p === '/api/dm/unread-count' && method === 'GET') {
      db.get(
        "SELECT COUNT(*) AS c FROM direct_messages WHERE recipient_id = ? AND is_read = 0",
        [user.id],
        (err, row) => {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          sendJson(res, 200, { success: true, unread: row ? row.c : 0 });
        }
      );
      return;
    }

    // GET /api/dm/messages?with=<userId>
    if (p === '/api/dm/messages' && method === 'GET') {
      const withId = parseInt(parsedUrl.searchParams.get('with'), 10);
      if (!Number.isInteger(withId) || withId <= 0) return sendJson(res, 400, { success: false, message: 'Не указан собеседник' });
      const cId = conversationId(user.id, withId);
      db.all(
        "SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY id ASC",
        [cId],
        (err, rows) => {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          sendJson(res, 200, { success: true, messages: rows || [] });
        }
      );
      return;
    }

    // GET /api/dm/stream?with=<userId> — SSE новых сообщений диалога.
    if (p === '/api/dm/stream' && method === 'GET') {
      const withId = parseInt(parsedUrl.searchParams.get('with'), 10);
      if (!Number.isInteger(withId) || withId <= 0) return sendJson(res, 400, { success: false, message: 'Не указан собеседник' });
      const cId = conversationId(user.id, withId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');
      subscribe(cId, res);
      req.on('close', () => unsubscribe(cId, res));
      return;
    }

    // POST /api/dm/send {to, message}
    if (p === '/api/dm/send' && method === 'POST') {
      (async () => {
        try {
          const body = await getJsonBody(req);
          const to = parseInt(body.to, 10);
          const message = String(body.message || '').trim().slice(0, 2000);
          if (!Number.isInteger(to) || to <= 0 || to === user.id) {
            return sendJson(res, 400, { success: false, message: 'Некорректный получатель' });
          }
          if (!message) return sendJson(res, 400, { success: false, message: 'Сообщение не может быть пустым' });

          db.get("SELECT account_type FROM users WHERE id = ?", [to], (err, row) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            if (!row || row.account_type !== 'employee') {
              return sendJson(res, 404, { success: false, message: 'Получатель не найден' });
            }
            const cId = conversationId(user.id, to);
            db.run(
              "INSERT INTO direct_messages (conversation_id, sender_id, recipient_id, message) VALUES (?, ?, ?, ?)",
              [cId, user.id, to, message],
              function (insErr) {
                if (insErr) return sendJson(res, 500, { success: false, message: 'Ошибка' });
                const messageId = this.lastID;
                db.get("SELECT * FROM direct_messages WHERE id = ?", [messageId], (e2, msgRow) => {
                  if (msgRow) publish(cId, msgRow);
                });
                sendJson(res, 201, { success: true, messageId });
              }
            );
          });
        } catch (e) {
          sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
        }
      })();
      return;
    }

    // POST /api/dm/read {with}
    if (p === '/api/dm/read' && method === 'POST') {
      (async () => {
        try {
          const body = await getJsonBody(req);
          const withId = parseInt(body.with, 10);
          if (!Number.isInteger(withId) || withId <= 0) return sendJson(res, 400, { success: false, message: 'Не указан собеседник' });
          db.run(
            "UPDATE direct_messages SET is_read = 1 WHERE recipient_id = ? AND sender_id = ? AND is_read = 0",
            [user.id, withId],
            (err) => {
              if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
              sendJson(res, 200, { success: true });
            }
          );
        } catch (e) {
          sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
        }
      })();
      return;
    }

    return sendJson(res, 404, { success: false, message: 'Не найдено' });
  });
};
