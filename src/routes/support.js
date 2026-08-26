const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

// --- SSE pub/sub: подписчики на события конкретного тикета и общий
// админский канал (обновления бейджей по всем тикетам сразу). Чисто
// in-memory — переживает только время жизни процесса, это ок для чата
// (при перезапуске клиенты просто переподключатся).
const ticketSubscribers = new Map(); // ticket_id -> Set<res>
const adminSubscribers = new Set();  // Set<res>

function subscribeTicket(ticketId, res) {
  if (!ticketSubscribers.has(ticketId)) ticketSubscribers.set(ticketId, new Set());
  ticketSubscribers.get(ticketId).add(res);
}
function unsubscribeTicket(ticketId, res) {
  const set = ticketSubscribers.get(ticketId);
  if (!set) return;
  set.delete(res);
  if (!set.size) ticketSubscribers.delete(ticketId);
}
function publishToTicket(ticketId, payload) {
  const set = ticketSubscribers.get(ticketId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  set.forEach(res => { try { res.write(data); } catch (e) {} });
}
function publishToAdmins(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  adminSubscribers.forEach(res => { try { res.write(data); } catch (e) {} });
}

// Пинг раз в 20с всем подписчикам — держит соединение живым сквозь прокси
// и попутно вычищает мёртвые сокеты (write бросит на закрытом res).
setInterval(() => {
  ticketSubscribers.forEach((set, ticketId) => {
    set.forEach(res => {
      try { res.write(': ping\n\n'); } catch (e) { unsubscribeTicket(ticketId, res); }
    });
  });
  adminSubscribers.forEach(res => {
    try { res.write(': ping\n\n'); } catch (e) { adminSubscribers.delete(res); }
  });
}, 20000).unref();

function isAdmin(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

// Читает пару настроек чата (имя администрации + показывать ли ФИО) одним
// запросом. Не кэшируем — чат отвечает редко относительно чтения.
function getChatDisplaySettings(cb) {
  db.all(
    "SELECT key, value FROM settings WHERE key IN ('support_admin_display_name', 'support_show_employee_name')",
    [],
    (err, rows) => {
      const map = {};
      (rows || []).forEach(r => { map[r.key] = r.value; });
      cb({
        adminDisplayName: map.support_admin_display_name || 'Администрация',
        showEmployeeName: map.support_show_employee_name === 'true'
      });
    }
  );
}

// Подменяет name у сообщений от админов на отображаемое (настройка +
// опционально реальное ФИО), не трогая хранимые данные. Сообщения от
// клиентов/гостей не меняются.
function applyDisplayNames(messages, cb) {
  getChatDisplaySettings(({ adminDisplayName, showEmployeeName }) => {
    const adminMsgs = messages.filter(m => m.sender_role === 'Admin' || m.sender_role === 'Superadmin');
    if (!showEmployeeName || !adminMsgs.length) {
      messages.forEach(m => {
        if (m.sender_role === 'Admin' || m.sender_role === 'Superadmin') m.name = adminDisplayName;
      });
      return cb(messages);
    }
    const userIds = [...new Set(adminMsgs.map(m => m.user_id).filter(Boolean))];
    if (!userIds.length) {
      messages.forEach(m => {
        if (m.sender_role === 'Admin' || m.sender_role === 'Superadmin') m.name = adminDisplayName;
      });
      return cb(messages);
    }
    const placeholders = userIds.map(() => '?').join(',');
    db.all(
      `SELECT user_id, first_name, last_name FROM employees WHERE user_id IN (${placeholders})`,
      userIds,
      (err, empRows) => {
        const namesByUser = {};
        (empRows || []).forEach(e => {
          const full = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
          if (full) namesByUser[e.user_id] = full;
        });
        messages.forEach(m => {
          if (m.sender_role === 'Admin' || m.sender_role === 'Superadmin') {
            m.name = namesByUser[m.user_id] || adminDisplayName;
          }
        });
        cb(messages);
      }
    );
  });
}

function getTicketStatus(ticketId, cb) {
  db.run("INSERT OR IGNORE INTO support_tickets (ticket_id) VALUES (?)", [ticketId], () => {
    db.get("SELECT status FROM support_tickets WHERE ticket_id = ?", [ticketId], (err, row) => {
      cb((row && row.status) || 'open');
    });
  });
}

// При новом сообщении от клиента/гостя — если тикет был закрыт, переоткрыть.
function reopenIfClosed(ticketId, cb) {
  db.run(
    "UPDATE support_tickets SET status='open', closed_at=NULL, closed_by=NULL WHERE ticket_id = ? AND status = 'closed'",
    [ticketId],
    () => cb && cb()
  );
}

module.exports = function handleSupport(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const currentPath = parsedUrl.pathname;

  // GET /api/support/tickets
  if (currentPath === '/api/support/tickets' && method === 'GET') {
    if (!isAdmin(user)) {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    const query = `
      SELECT ticket_id, name, email, MAX(created_at) as last_activity,
             SUM(CASE WHEN is_read = 0 AND sender_role != 'Admin' AND sender_role != 'Superadmin' THEN 1 ELSE 0 END) as unread_count,
             (SELECT m2.message FROM support_messages m2 WHERE m2.ticket_id = support_messages.ticket_id ORDER BY m2.id DESC LIMIT 1) as last_message,
             (SELECT m3.sender_role FROM support_messages m3 WHERE m3.ticket_id = support_messages.ticket_id ORDER BY m3.id DESC LIMIT 1) as last_sender_role,
             (SELECT m5.user_id FROM support_messages m5 WHERE m5.ticket_id = support_messages.ticket_id AND m5.sender_role NOT IN ('Admin','Superadmin') ORDER BY m5.id ASC LIMIT 1) as owner_user_id
      FROM support_messages
      GROUP BY ticket_id
      ORDER BY last_activity DESC
    `;
    db.all(query, [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const ownerIds = [...new Set((rows || []).map(r => r.owner_user_id).filter(Boolean))];
      db.all("SELECT ticket_id, status FROM support_tickets", [], (e1, statusRows) => {
        const statusByTicket = {};
        (statusRows || []).forEach(s => { statusByTicket[s.ticket_id] = s.status; });
        rows.forEach(r => { r.status = statusByTicket[r.ticket_id] || 'open'; });

        // Последнее закрытие каждого тикета (кто закрыл, решён ли вопрос) — для
        // «истории обращений»; для открытых тикетов эти поля просто null.
        db.all(
          `SELECT r1.ticket_id, r1.closed_by_name, r1.closed_at, r1.resolved
           FROM support_resolutions r1
           WHERE r1.id = (SELECT MAX(id) FROM support_resolutions r2 WHERE r2.ticket_id = r1.ticket_id)`,
          [],
          (eRes, resRows) => {
            const resByTicket = {};
            (resRows || []).forEach(rr => { resByTicket[rr.ticket_id] = rr; });
            rows.forEach(r => {
              const rr = resByTicket[r.ticket_id];
              r.closed_by_name = rr ? rr.closed_by_name : null;
              r.resolution_closed_at = rr ? rr.closed_at : null;
              r.resolved = rr ? rr.resolved : null;
            });

            if (!ownerIds.length) return sendJson(res, 200, { success: true, tickets: rows });

            const placeholders = ownerIds.map(() => '?').join(',');
            db.all(
              `SELECT user_id, first_name, last_name FROM employees WHERE user_id IN (${placeholders})`,
              ownerIds,
              (e2, empRows) => {
                const namesByUser = {};
                (empRows || []).forEach(e => {
                  const full = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
                  if (full) namesByUser[e.user_id] = full;
                });
                rows.forEach(r => {
                  const full = namesByUser[r.owner_user_id];
                  if (full) r.name = full;
                  delete r.owner_user_id;
                });
                sendJson(res, 200, { success: true, tickets: rows });
              }
            );
          }
        );
      });
    });
    return;
  }

  // GET /api/support/users — все пользователи + непрочитанные из поддержки,
  // чтобы админ мог не только отвечать, но и сам написать любому.
  if (currentPath === '/api/support/users' && method === 'GET') {
    if (!isAdmin(user)) {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    const aggQuery = `
      SELECT ticket_id,
             MAX(created_at) as last_activity,
             SUM(CASE WHEN is_read = 0 AND sender_role NOT IN ('Admin','Superadmin') THEN 1 ELSE 0 END) as unread_count,
             (SELECT m2.message FROM support_messages m2 WHERE m2.ticket_id = support_messages.ticket_id ORDER BY m2.id DESC LIMIT 1) as last_message,
             (SELECT m3.sender_role FROM support_messages m3 WHERE m3.ticket_id = support_messages.ticket_id ORDER BY m3.id DESC LIMIT 1) as last_sender_role,
             (SELECT m4.name FROM support_messages m4 WHERE m4.ticket_id = support_messages.ticket_id AND m4.sender_role NOT IN ('Admin','Superadmin') ORDER BY m4.id DESC LIMIT 1) as guest_name
      FROM support_messages GROUP BY ticket_id`;

    db.all(
      `SELECT u.id, u.username, u.email, u.avatar_url, e.first_name, e.last_name
       FROM users u LEFT JOIN employees e ON e.user_id = u.id
       ORDER BY u.username COLLATE NOCASE ASC`,
      [], (err, users) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      db.all(aggQuery, [], (e2, aggs) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        db.all("SELECT ticket_id, status FROM support_tickets", [], (e3, statusRows) => {
          const statusByTicket = {};
          (statusRows || []).forEach(s => { statusByTicket[s.ticket_id] = s.status; });

          const byTicket = {};
          (aggs || []).forEach(a => { byTicket[a.ticket_id] = a; });

          const list = [];
          (users || []).forEach(u => {
            const tId = 'user_' + u.id;
            const a = byTicket[tId] || {};
            delete byTicket[tId];
            const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
            list.push({
              ticket_id: tId,
              name: fullName || u.username,
              email: u.email,
              avatar_url: u.avatar_url || null,
              unread_count: a.unread_count || 0,
              last_message: a.last_message || null,
              last_sender_role: a.last_sender_role || null,
              last_activity: a.last_activity || null,
              status: statusByTicket[tId] || 'open'
            });
          });

          // Гостевые диалоги (ticket_id без привязки к аккаунту) — не теряем их.
          Object.values(byTicket).forEach(a => {
            list.push({
              ticket_id: a.ticket_id,
              name: a.guest_name || 'Гость',
              email: null,
              avatar_url: null,
              unread_count: a.unread_count || 0,
              last_message: a.last_message || null,
              last_sender_role: a.last_sender_role || null,
              last_activity: a.last_activity || null,
              status: statusByTicket[a.ticket_id] || 'open',
              is_guest: true
            });
          });

          sendJson(res, 200, { success: true, users: list });
        });
      });
    });
    return;
  }

  // GET /api/support/messages
  if (currentPath === '/api/support/messages' && method === 'GET') {
    let tId = parsedUrl.searchParams.get('ticketId');
    if (!isAdmin(user)) {
      tId = 'user_' + user.id;
    }
    if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
    db.all("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY id ASC", [tId], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      applyDisplayNames(rows || [], (messages) => {
        getTicketStatus(tId, (status) => {
          sendJson(res, 200, { success: true, messages, status });
        });
      });
    });
    return;
  }

  // GET /api/support/stream — SSE-подписка на новые сообщения конкретного тикета.
  if (currentPath === '/api/support/stream' && method === 'GET') {
    let tId = parsedUrl.searchParams.get('ticketId');
    if (!isAdmin(user)) tId = 'user_' + user.id;
    if (!tId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    subscribeTicket(tId, res);
    req.on('close', () => unsubscribeTicket(tId, res));
    return;
  }

  // GET /api/support/stream/admin — широковещательный канал: любое новое
  // сообщение в любом тикете (используется списком тикетов, не открытым чатом).
  if (currentPath === '/api/support/stream/admin' && method === 'GET') {
    if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    adminSubscribers.add(res);
    req.on('close', () => adminSubscribers.delete(res));
    return;
  }

  // POST /api/support/reply
  if (currentPath === '/api/support/reply' && method === 'POST') {
    if (!isAdmin(user)) {
      return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    }
    (async () => {
      try {
        const { ticketId, message } = await getJsonBody(req);
        db.run(
          "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read) VALUES (?, ?, ?, ?, ?, ?)",
          [ticketId, user.id, user.username, message, user.role, 0],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
            const messageId = this.lastID;
            db.get("SELECT * FROM support_messages WHERE id = ?", [messageId], (e2, row) => {
              if (row) {
                applyDisplayNames([row], (msgs) => {
                  publishToTicket(ticketId, msgs[0]);
                  publishToAdmins({ type: 'ticket_updated', ticketId });
                });
              }
            });
            sendJson(res, 201, { success: true, messageId });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  // POST /api/support/send
  if (currentPath === '/api/support/send' && method === 'POST') {
    (async () => {
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
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка' });
            const messageId = this.lastID;
            reopenIfClosed(tId, () => {
              db.get("SELECT * FROM support_messages WHERE id = ?", [messageId], (e2, row) => {
                if (row) {
                  applyDisplayNames([row], (msgs) => {
                    publishToTicket(tId, msgs[0]);
                    publishToAdmins({ type: 'ticket_updated', ticketId: tId });
                  });
                }
              });
              sendJson(res, 201, { success: true, ticketId: tId, messageId });
            });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  // POST /api/support/read
  if (currentPath === '/api/support/read' && method === 'POST') {
    (async () => {
      try {
        const { ticketId } = await getJsonBody(req);
        if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });

        let targetTicket = ticketId;
        if (!isAdmin(user)) {
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
    })();
    return;
  }

  // GET /api/support/unread-count — сколько ответов администрации пользователь
  // ещё не открывал в своём личном чате (для бейджа на плавающем окне).
  if (currentPath === '/api/support/unread-count' && method === 'GET') {
    const tId = 'user_' + user.id;
    db.get(
      "SELECT COUNT(*) as c FROM support_messages WHERE ticket_id = ? AND sender_role IN ('Admin','Superadmin') AND read_by_user = 0",
      [tId],
      (err, row) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, unread: row ? row.c : 0 });
      }
    );
    return;
  }

  // POST /api/support/read-by-user — пользователь открыл свой чат, отмечаем
  // ответы администрации прочитанными (отдельно от is_read — той колонкой
  // отмечается прочтение админом сообщений пользователя, не наоборот).
  if (currentPath === '/api/support/read-by-user' && method === 'POST') {
    const tId = 'user_' + user.id;
    db.run(
      "UPDATE support_messages SET read_by_user = 1 WHERE ticket_id = ? AND sender_role IN ('Admin','Superadmin')",
      [tId],
      (err) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true });
      }
    );
    return;
  }

  // POST /api/support/create (light ensure ticket)
  if (currentPath === '/api/support/create' && method === 'POST') {
    (async () => {
      try {
        const { targetUserId } = await getJsonBody(req);
        const ticketId = targetUserId ? 'user_' + targetUserId : null;
        sendJson(res, 200, { success: true, ticketId: ticketId || 'ok' });
      } catch (e) {
        sendJson(res, 200, { success: true });
      }
    })();
    return;
  }

  // POST /api/support/close — закрыть обращение (Admin/Superadmin). Заводит
  // запись в истории закрытий и спрашивает пользователя в чате, решён ли вопрос.
  if (currentPath === '/api/support/close' && method === 'POST') {
    if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    (async () => {
      try {
        const { ticketId } = await getJsonBody(req);
        if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
        db.run(
          `INSERT INTO support_tickets (ticket_id, status, closed_at, closed_by) VALUES (?, 'closed', CURRENT_TIMESTAMP, ?)
           ON CONFLICT(ticket_id) DO UPDATE SET status='closed', closed_at=CURRENT_TIMESTAMP, closed_by=excluded.closed_by`,
          [ticketId, user.id],
          (err) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });

            db.run(
              "INSERT INTO support_resolutions (ticket_id, closed_by, closed_by_name) VALUES (?, ?, ?)",
              [ticketId, user.id, user.username],
              () => {
                const askText = 'Обращение закрыто администратором. Помог ли ответ решить ваш вопрос?';
                db.run(
                  "INSERT INTO support_messages (ticket_id, name, message, sender_role, is_read, system_type) VALUES (?, 'Система', ?, 'System', 1, 'resolution_ask')",
                  [ticketId, askText],
                  function (e2) {
                    const messageId = this.lastID;
                    db.get("SELECT * FROM support_messages WHERE id = ?", [messageId], (e3, row) => {
                      if (row) {
                        applyDisplayNames([row], (msgs) => {
                          publishToTicket(ticketId, msgs[0]);
                        });
                      }
                    });
                  }
                );
                // Уведомление в личный кабинет — только для тикетов, привязанных к аккаунту.
                const ownerMatch = /^user_(\d+)$/.exec(ticketId);
                if (ownerMatch) {
                  db.run(
                    "INSERT INTO notifications (user_id, message, created_by) VALUES (?, ?, ?)",
                    [Number(ownerMatch[1]), 'Ваше обращение в поддержку закрыто. Загляните в чат поддержки — помогло ли решение?', user.id],
                    () => {}
                  );
                }
              }
            );

            publishToTicket(ticketId, { type: 'status', status: 'closed' });
            publishToAdmins({ type: 'ticket_updated', ticketId });
            sendJson(res, 200, { success: true });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  // POST /api/support/resolve — пользователь отвечает, решён ли его вопрос
  // после закрытия обращения администратором.
  if (currentPath === '/api/support/resolve' && method === 'POST') {
    (async () => {
      try {
        const { resolved } = await getJsonBody(req);
        if (typeof resolved !== 'boolean') return sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
        if (isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Ответить может только автор обращения' });
        const ticketId = 'user_' + user.id;
        db.run(
          `UPDATE support_resolutions SET resolved = ?, resolved_at = CURRENT_TIMESTAMP
           WHERE id = (SELECT id FROM support_resolutions WHERE ticket_id = ? AND resolved IS NULL ORDER BY id DESC LIMIT 1)`,
          [resolved ? 1 : 0, ticketId],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            const answerText = resolved ? 'Пользователь подтвердил: вопрос решён.' : 'Пользователь сообщил: вопрос не решён.';
            db.run(
              "INSERT INTO support_messages (ticket_id, user_id, name, message, sender_role, is_read, system_type) VALUES (?, ?, 'Система', ?, 'System', 1, 'resolution_answer')",
              [ticketId, user.id, answerText],
              function (e2) {
                const messageId = this.lastID;
                db.get("SELECT * FROM support_messages WHERE id = ?", [messageId], (e3, row) => {
                  if (row) {
                    applyDisplayNames([row], (msgs) => {
                      publishToTicket(ticketId, msgs[0]);
                      publishToAdmins({ type: 'ticket_updated', ticketId });
                    });
                  }
                });
                sendJson(res, 200, { success: true });
              }
            );
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  // POST /api/support/reopen — вручную открыть обращение заново (Admin/Superadmin).
  if (currentPath === '/api/support/reopen' && method === 'POST') {
    if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Доступ запрещен' });
    (async () => {
      try {
        const { ticketId } = await getJsonBody(req);
        if (!ticketId) return sendJson(res, 400, { success: false, message: 'Не указан ticketId' });
        db.run(
          `INSERT INTO support_tickets (ticket_id, status) VALUES (?, 'open')
           ON CONFLICT(ticket_id) DO UPDATE SET status='open', closed_at=NULL, closed_by=NULL`,
          [ticketId],
          (err) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            publishToTicket(ticketId, { type: 'status', status: 'open' });
            publishToAdmins({ type: 'ticket_updated', ticketId });
            sendJson(res, 200, { success: true });
          }
        );
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  return sendJson(res, 404, { success: false, message: 'Support endpoint не реализован полностью' });
};
