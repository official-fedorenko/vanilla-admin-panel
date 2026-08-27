const { sendJson, getJsonBody, logAction } = require('../utils');
const { db } = require('../../db');

/**
 * Передача инструмента/авто напрямую между сотрудниками, без участия
 * администратора: отправитель (текущий держатель) предлагает предмет
 * конкретному сотруднику, тот принимает (закрепление реально переходит)
 * или отклоняет с указанием причины.
 *
 *  Сотрудник:
 *    POST /api/peer-transfers            — предложить передачу { item_type, item_id, to_employee_id }
 *    GET  /api/peer-transfers/incoming    — входящие предложения (ожидающие моего решения)
 *    GET  /api/peer-transfers/outgoing    — мои отправленные предложения (все статусы)
 *    POST /api/peer-transfers/respond     — принять/отклонить { id, action: 'accept'|'decline', reason? }
 *    POST /api/peer-transfers/cancel      — отправитель отменяет своё же предложение, пока оно ожидает { id }
 *
 *  Админ (Admin/Superadmin):
 *    GET  /api/peer-transfers/all         — вся история для раздела «Взаимодействия сотрудников»
 */

function isAdmin(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

function myEmployeeId(userId, cb) {
  db.get("SELECT id FROM employees WHERE user_id = ?", [userId], (err, row) => {
    cb(err, row ? row.id : null);
  });
}

// Кто сейчас держит предмет (для tool — по конкретному сотруднику, для
// vehicle — единственный активный держатель).
function currentHolderAssignment(itemType, itemId, employeeId, cb) {
  if (itemType === 'tool') {
    db.get(
      "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
      [itemId, employeeId], cb
    );
  } else {
    db.get(
      "SELECT id FROM vehicle_assignments WHERE vehicle_id = ? AND employee_id = ? AND returned_at IS NULL",
      [itemId, employeeId], cb
    );
  }
}

function itemName(itemType, itemId, cb) {
  const table = itemType === 'tool' ? 'tools' : 'vehicles';
  db.get(`SELECT name FROM ${table} WHERE id = ?`, [itemId], (err, row) => cb(err, row ? row.name : null));
}

function notifyUserOfEmployee(employeeId, message, fromUserId) {
  db.get("SELECT user_id FROM employees WHERE id = ?", [employeeId], (err, row) => {
    if (err || !row || !row.user_id) return;
    db.run("INSERT INTO notifications (user_id, message, created_by) VALUES (?, ?, ?)", [row.user_id, message, fromUserId], () => {});
  });
}

async function createTransfer(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const itemType = body.item_type === 'vehicle' ? 'vehicle' : (body.item_type === 'tool' ? 'tool' : null);
    const itemId = parseInt(body.item_id, 10);
    const toEmployeeId = parseInt(body.to_employee_id, 10);
    if (!itemType || !itemId || !toEmployeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать предмет и сотрудника-получателя' });
    }

    myEmployeeId(user.id, (err, fromEmployeeId) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!fromEmployeeId) return sendJson(res, 403, { success: false, message: 'Доступно только сотрудникам' });
      if (fromEmployeeId === toEmployeeId) {
        return sendJson(res, 400, { success: false, message: 'Нельзя передать самому себе' });
      }

      db.get("SELECT id FROM employees WHERE id = ?", [toEmployeeId], (e2, toEmp) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!toEmp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

        currentHolderAssignment(itemType, itemId, fromEmployeeId, (e3, holding) => {
          if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          if (!holding) return sendJson(res, 400, { success: false, message: 'Этот предмет сейчас не закреплён за вами' });

          db.get(
            "SELECT id FROM peer_transfers WHERE item_type = ? AND item_id = ? AND from_employee_id = ? AND status = 'pending'",
            [itemType, itemId, fromEmployeeId],
            (e4, existing) => {
              if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
              if (existing) return sendJson(res, 409, { success: false, message: 'По этому предмету уже есть предложение передачи в ожидании' });

              db.run(
                "INSERT INTO peer_transfers (item_type, item_id, from_employee_id, to_employee_id) VALUES (?, ?, ?, ?)",
                [itemType, itemId, fromEmployeeId, toEmployeeId],
                function (e5) {
                  if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка создания предложения' });
                  const insertedId = this.lastID;
                  itemName(itemType, itemId, (e6, name) => {
                    logAction(user.username, `Предложил передать ${itemType === 'tool' ? 'инструмент' : 'авто'} «${name || itemId}» сотруднику id=${toEmployeeId}`);
                    notifyUserOfEmployee(toEmployeeId, `Вам предлагают принять ${itemType === 'tool' ? 'инструмент' : 'авто'} «${name || ''}». Посмотрите в личном кабинете.`, user.id);
                    sendJson(res, 201, { success: true, id: insertedId });
                  });
                }
              );
            }
          );
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

function listIncoming(req, res, user) {
  myEmployeeId(user.id, (err, empId) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!empId) return sendJson(res, 200, { success: true, transfers: [] });
    const sql = `
      SELECT pt.id, pt.item_type, pt.item_id, pt.status, pt.created_at,
        fe.first_name AS from_first, fe.last_name AS from_last,
        COALESCE(t.name, v.name) AS item_name
      FROM peer_transfers pt
      JOIN employees fe ON fe.id = pt.from_employee_id
      LEFT JOIN tools t ON pt.item_type = 'tool' AND t.id = pt.item_id
      LEFT JOIN vehicles v ON pt.item_type = 'vehicle' AND v.id = pt.item_id
      WHERE pt.to_employee_id = ? AND pt.status = 'pending'
      ORDER BY pt.created_at DESC`;
    db.all(sql, [empId], (e2, rows) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const transfers = (rows || []).map(r => ({
        ...r, from_name: [r.from_last, r.from_first].filter(Boolean).join(' ')
      }));
      sendJson(res, 200, { success: true, transfers });
    });
  });
}

function listOutgoing(req, res, user) {
  myEmployeeId(user.id, (err, empId) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!empId) return sendJson(res, 200, { success: true, transfers: [] });
    const sql = `
      SELECT pt.id, pt.item_type, pt.item_id, pt.status, pt.decline_reason, pt.created_at, pt.resolved_at,
        te.first_name AS to_first, te.last_name AS to_last,
        COALESCE(t.name, v.name) AS item_name
      FROM peer_transfers pt
      JOIN employees te ON te.id = pt.to_employee_id
      LEFT JOIN tools t ON pt.item_type = 'tool' AND t.id = pt.item_id
      LEFT JOIN vehicles v ON pt.item_type = 'vehicle' AND v.id = pt.item_id
      WHERE pt.from_employee_id = ?
      ORDER BY pt.created_at DESC LIMIT 30`;
    db.all(sql, [empId], (e2, rows) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const transfers = (rows || []).map(r => ({
        ...r, to_name: [r.to_last, r.to_first].filter(Boolean).join(' ')
      }));
      sendJson(res, 200, { success: true, transfers });
    });
  });
}

// Фактический перенос закрепления (используется только при принятии предложения).
function performHandoff(itemType, itemId, fromEmployeeId, toEmployeeId, username, cb) {
  if (itemType === 'tool') {
    db.get(
      "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
      [itemId, fromEmployeeId],
      (err, open) => {
        if (err) return cb(err);
        if (!open) return cb(null, false); // предмет уже не у отправителя
        db.run("UPDATE tool_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e2) => {
          if (e2) return cb(e2);
          db.run(
            "INSERT INTO tool_assignments (tool_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
            [itemId, toEmployeeId, username, 'Передано напрямую от сотрудника'],
            (e3) => {
              if (e3) return cb(e3);
              db.get("SELECT COUNT(*) AS c FROM tool_assignments WHERE tool_id = ? AND returned_at IS NULL", [itemId], (e4, row) => {
                const newStatus = row && row.c > 0 ? 'assigned' : 'available';
                db.run("UPDATE tools SET status = ? WHERE id = ? AND status != 'written_off'", [newStatus, itemId], () => cb(null, true));
              });
            }
          );
        });
      }
    );
  } else {
    db.get(
      "SELECT id FROM vehicle_assignments WHERE vehicle_id = ? AND employee_id = ? AND returned_at IS NULL",
      [itemId, fromEmployeeId],
      (err, open) => {
        if (err) return cb(err);
        if (!open) return cb(null, false);
        db.run("UPDATE vehicle_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e2) => {
          if (e2) return cb(e2);
          db.run(
            "INSERT INTO vehicle_assignments (vehicle_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
            [itemId, toEmployeeId, username, 'Передано напрямую от сотрудника'],
            (e3) => {
              if (e3) return cb(e3);
              db.run("UPDATE vehicles SET status = 'assigned' WHERE id = ? AND status != 'written_off'", [itemId], () => cb(null, true));
            }
          );
        });
      }
    );
  }
}

async function respond(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const id = parseInt(body.id, 10);
    const action = body.action === 'accept' ? 'accept' : (body.action === 'decline' ? 'decline' : null);
    if (!id || !action) return sendJson(res, 400, { success: false, message: 'Нужно указать id и действие' });
    const reason = (body.reason == null ? '' : String(body.reason)).trim().slice(0, 300) || null;
    if (action === 'decline' && !reason) {
      return sendJson(res, 400, { success: false, message: 'Укажите причину отказа' });
    }

    myEmployeeId(user.id, (err, empId) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!empId) return sendJson(res, 403, { success: false, message: 'Доступно только сотрудникам' });

      db.get("SELECT * FROM peer_transfers WHERE id = ? AND to_employee_id = ? AND status = 'pending'", [id, empId], (e2, pt) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!pt) return sendJson(res, 404, { success: false, message: 'Предложение не найдено или уже обработано' });

        if (action === 'decline') {
          db.run("UPDATE peer_transfers SET status = 'declined', decline_reason = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [reason, id], (e3) => {
            if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
            itemName(pt.item_type, pt.item_id, (e4, name) => {
              logAction(user.username, `Отказался принять ${pt.item_type === 'tool' ? 'инструмент' : 'авто'} «${name || pt.item_id}»: ${reason}`);
              notifyUserOfEmployee(pt.from_employee_id, `Сотрудник отказался принять «${name || ''}». Причина: ${reason}`, user.id);
              sendJson(res, 200, { success: true });
            });
          });
          return;
        }

        // action === 'accept'
        performHandoff(pt.item_type, pt.item_id, pt.from_employee_id, pt.to_employee_id, user.username, (hErr, ok) => {
          if (hErr) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
          if (!ok) {
            db.run("UPDATE peer_transfers SET status = 'cancelled', decline_reason = 'Предмет больше не у отправителя', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [id], () => {
              sendJson(res, 400, { success: false, message: 'Предмет уже не закреплён за отправителем — предложение отменено' });
            });
            return;
          }
          db.run("UPDATE peer_transfers SET status = 'accepted', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [id], (e5) => {
            if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
            itemName(pt.item_type, pt.item_id, (e6, name) => {
              logAction(user.username, `Принял ${pt.item_type === 'tool' ? 'инструмент' : 'авто'} «${name || pt.item_id}» от сотрудника id=${pt.from_employee_id}`);
              notifyUserOfEmployee(pt.from_employee_id, `Сотрудник принял «${name || ''}» — предмет передан.`, user.id);
              sendJson(res, 200, { success: true });
            });
          });
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

async function cancelTransfer(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const id = parseInt(body.id, 10);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });

    myEmployeeId(user.id, (err, empId) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!empId) return sendJson(res, 403, { success: false, message: 'Доступно только сотрудникам' });

      db.get("SELECT * FROM peer_transfers WHERE id = ? AND from_employee_id = ? AND status = 'pending'", [id, empId], (e2, pt) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!pt) return sendJson(res, 404, { success: false, message: 'Предложение не найдено или уже обработано' });

        db.run("UPDATE peer_transfers SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [id], (e3) => {
          if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
          itemName(pt.item_type, pt.item_id, (e4, name) => {
            logAction(user.username, `Отменил своё предложение передать ${pt.item_type === 'tool' ? 'инструмент' : 'авто'} «${name || pt.item_id}»`);
            notifyUserOfEmployee(pt.to_employee_id, `Сотрудник отменил предложение передать «${name || ''}».`, user.id);
            sendJson(res, 200, { success: true });
          });
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

function listAll(req, res, user) {
  if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  const sql = `
    SELECT pt.id, pt.item_type, pt.item_id, pt.status, pt.decline_reason, pt.created_at, pt.resolved_at,
      fe.first_name AS from_first, fe.last_name AS from_last,
      te.first_name AS to_first, te.last_name AS to_last,
      COALESCE(t.name, v.name) AS item_name
    FROM peer_transfers pt
    JOIN employees fe ON fe.id = pt.from_employee_id
    JOIN employees te ON te.id = pt.to_employee_id
    LEFT JOIN tools t ON pt.item_type = 'tool' AND t.id = pt.item_id
    LEFT JOIN vehicles v ON pt.item_type = 'vehicle' AND v.id = pt.item_id
    ORDER BY pt.created_at DESC LIMIT 500`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const transfers = (rows || []).map(r => ({
      ...r,
      from_name: [r.from_last, r.from_first].filter(Boolean).join(' '),
      to_name: [r.to_last, r.to_first].filter(Boolean).join(' ')
    }));
    sendJson(res, 200, { success: true, transfers });
  });
}

module.exports = async function handlePeerTransfers(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  if (p === '/api/peer-transfers' && method === 'POST') return createTransfer(req, res, user);
  if (p === '/api/peer-transfers/incoming' && method === 'GET') return listIncoming(req, res, user);
  if (p === '/api/peer-transfers/outgoing' && method === 'GET') return listOutgoing(req, res, user);
  if (p === '/api/peer-transfers/respond' && method === 'POST') return respond(req, res, user);
  if (p === '/api/peer-transfers/cancel' && method === 'POST') return cancelTransfer(req, res, user);
  if (p === '/api/peer-transfers/all' && method === 'GET') return listAll(req, res, user);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
