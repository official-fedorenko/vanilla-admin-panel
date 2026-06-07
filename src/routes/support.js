const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

module.exports = async function handleSupport(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const currentPath = parsedUrl.pathname;

  // GET /api/support/tickets
  if (currentPath === '/api/support/tickets' && method === 'GET') {
    if (user.role !== 'Admin' && user.role !== 'Superadmin') {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    const query = `
      SELECT ticket_id, name, email, MAX(created_at) as last_activity,
             SUM(CASE WHEN is_read = 0 AND sender_role != 'Admin' AND sender_role != 'Superadmin' THEN 1 ELSE 0 END) as unread_count
      FROM support_messages 
      GROUP BY ticket_id 
      ORDER BY last_activity DESC
    `;
    db.all(query, [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, tickets: rows });
    });
    return;
  }

  // GET /api/support/messages
  if (currentPath === '/api/support/messages' && method === 'GET') {
    let tId = parsedUrl.searchParams.get('ticketId');
    if (user.role !== 'Admin' && user.role !== 'Superadmin') {
      tId = 'user_' + user.id;
    }
    if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
    db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC", [tId], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, messages: rows });
    });
    return;
  }

  // POST /api/support/reply
  if (currentPath === '/api/support/reply' && method === 'POST') {
    if (user.role !== 'Admin' && user.role !== 'Superadmin') {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    try {
      const { ticketId, message } = await getJsonBody(req);
      db.run(
        "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
        [ticketId, user.id, user.username, message, user.role, 0],
        function(err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
          sendJson(res, 201, { success: true, messageId: this.lastID });
        }
      );
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // POST /api/support/send
  if (currentPath === '/api/support/send' && method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const { message, ticketId } = body;
      if (!message) return sendJson(res, 400, { success: false, message: 'Сообщение не может быть пустым' });
      let tId = ticketId || (user ? 'user_' + user.id : 'guest_' + Date.now());
      let senderName = user ? user.username : (body.name || 'Гость');
      let role = user ? user.role : 'Guest';
      db.run(
        "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
        [tId, user ? user.id : null, senderName, message, role, 0],
        function(err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
          sendJson(res, 201, { success: true, ticketId: tId, messageId: this.lastID });
        }
      );
    } catch(e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // POST /api/support/read
  if (currentPath === '/api/support/read' && method === 'POST') {
    try {
      const { ticketId } = await getJsonBody(req);
      if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });

      let targetTicket = ticketId;
      if (user.role !== 'Admin' && user.role !== 'Superadmin') {
        targetTicket = 'user_' + user.id;
      }

      db.run(
        `UPDATE support_messages 
         SET is_read = 1 
         WHERE ticket_id = ? AND sender_role NOT IN ('Admin', 'Superadmin')`,
        [targetTicket],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
          sendJson(res, 200, { success: true });
        }
      );
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // POST /api/support/create (light ensure ticket)
  if (currentPath === '/api/support/create' && method === 'POST') {
    try {
      const { targetUserId } = await getJsonBody(req);
      const ticketId = targetUserId ? 'user_' + targetUserId : null;
      sendJson(res, 200, { success: true, ticketId: ticketId || 'ok' });
    } catch (e) {
      sendJson(res, 200, { success: true });
    }
    return;
  }

  return sendJson(res, 404, { success: false, message: 'Support endpoint не реализован полностью' });
};
