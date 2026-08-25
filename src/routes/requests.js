const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');
const tools = require('./tools');

/**
 * Универсальные заявления пользователей.
 *
 *   GET  /api/request-types            — реестр типов и их полей (для форм)
 *   POST /api/requests                 — создать заявление (любой авторизованный)
 *   GET  /api/requests/mine            — свои заявления
 *   GET  /api/requests[?status=]       — все заявления (Admin/Superadmin)
 *   POST /api/requests/approve?id=     — одобрить (Admin/Superadmin)
 *   POST /api/requests/reject?id=      — отклонить (Admin/Superadmin)
 *
 * Добавить новый тип заявления = добавить запись в REQUEST_TYPES (+ при
 * необходимости побочный эффект одобрения в approveSideEffect).
 */

// Реестр типов. fields.type: text | textarea | number | date | category | photo
const REQUEST_TYPES = {
  tool_add: {
    label: 'Добавить инструмент',
    icon: 'wrench',
    fields: [
      { name: 'name', label: 'Название', type: 'text', required: true },
      { name: 'category', label: 'Категория', type: 'category' },
      { name: 'brand', label: 'Бренд', type: 'text' },
      { name: 'model', label: 'Модель', type: 'text' },
      { name: 'serial_number', label: 'Серийный №', type: 'text' },
      { name: 'inventory_number', label: 'Инвентарный №', type: 'text' },
      { name: 'photo_url', label: 'Фото', type: 'photo' },
      { name: 'notes', label: 'Комментарий', type: 'textarea' }
    ]
  },
  tool_order: {
    label: 'Заказать инструмент',
    icon: 'shopping-cart',
    fields: [
      { name: 'name', label: 'Что заказать', type: 'text', required: true },
      { name: 'category', label: 'Категория', type: 'category' },
      { name: 'quantity', label: 'Количество', type: 'number' },
      { name: 'notes', label: 'Обоснование', type: 'textarea' }
    ]
  },
  vehicle_order: {
    label: 'Заказать авто',
    icon: 'car',
    fields: [
      { name: 'name', label: 'Цель / куда', type: 'text', required: true },
      { name: 'category', label: 'Тип авто', type: 'category', source: 'vehicle' },
      { name: 'start_date', label: 'С', type: 'date' },
      { name: 'end_date', label: 'По', type: 'date' },
      { name: 'notes', label: 'Комментарий', type: 'textarea' }
    ]
  },
  vacation: {
    label: 'Заявление на отпуск',
    icon: 'palmtree',
    fields: [
      { name: 'start_date', label: 'С', type: 'date', required: true },
      { name: 'end_date', label: 'По', type: 'date', required: true },
      { name: 'notes', label: 'Комментарий', type: 'textarea' }
    ]
  },
  resignation: {
    label: 'Заявление на увольнение',
    icon: 'log-out',
    fields: [
      { name: 'last_day', label: 'Последний рабочий день', type: 'date' },
      { name: 'reason', label: 'Причина', type: 'textarea' }
    ]
  }
};

function canReview(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}
function parseId(parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function str(v, max = 500) {
  const s = (v == null ? '' : String(v)).trim();
  return s.length ? s.slice(0, max) : '';
}
function cleanPhoto(v) {
  const raw = (v == null ? '' : String(v)).trim().split('?')[0].split('#')[0];
  const ok = /^\/uploads\/[A-Za-z0-9._-]+$/.test(raw) || /^\/catalog\/images\/[A-Za-z0-9._-]+\.svg$/.test(raw);
  return ok ? raw : '';
}

// Собирает payload по описанию полей типа + валидирует обязательные.
function buildPayload(typeDef, body) {
  const payload = {};
  for (const f of typeDef.fields) {
    let val = body[f.name];
    if (f.type === 'photo') val = cleanPhoto(val);
    else if (f.type === 'number') { const n = parseInt(val, 10); val = Number.isFinite(n) ? n : ''; }
    else if (f.type === 'date') val = /^\d{4}-\d{2}-\d{2}$/.test(String(val || '')) ? val : '';
    else val = str(val, f.type === 'textarea' ? 2000 : 300);
    if (f.required && (val === '' || val == null)) {
      return { error: `Поле «${f.label}» обязательно` };
    }
    payload[f.name] = val;
  }
  return { payload };
}

// Краткий заголовок заявления для списков.
function buildTitle(type, payload) {
  switch (type) {
    case 'tool_add':    return payload.name || 'Инструмент';
    case 'tool_order':  return (payload.name || 'Инструмент') + (payload.quantity ? ` ×${payload.quantity}` : '');
    case 'vehicle_order': return 'Авто: ' + (payload.name || '—') + (payload.start_date ? ` (${payload.start_date}${payload.end_date ? ' — ' + payload.end_date : ''})` : '');
    case 'vacation':    return `Отпуск: ${payload.start_date || '?'} — ${payload.end_date || '?'}`;
    case 'resignation': return 'Увольнение' + (payload.last_day ? ` с ${payload.last_day}` : '');
    default:            return REQUEST_TYPES[type] ? REQUEST_TYPES[type].label : type;
  }
}

// --- Создание ---
async function createRequest(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const type = String(body.type || '');
    const typeDef = REQUEST_TYPES[type];
    if (!typeDef) return sendJson(res, 400, { success: false, message: 'Неизвестный тип заявления' });

    const { payload, error } = buildPayload(typeDef, body.payload || body);
    if (error) return sendJson(res, 400, { success: false, message: error });

    const title = buildTitle(type, payload);
    db.run(
      "INSERT INTO requests (type, title, payload, requested_by) VALUES (?, ?, ?, ?)",
      [type, title, JSON.stringify(payload), user.id],
      function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Не удалось создать заявление' });
        logAction(user.username, `Создал заявление «${typeDef.label}»: ${title} (id=${this.lastID})`);
        sendJson(res, 201, { success: true, id: this.lastID });
      }
    );
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

function mapRow(r) {
  let payload = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch (e) { payload = {}; }
  return {
    id: r.id, type: r.type, type_label: (REQUEST_TYPES[r.type] || {}).label || r.type,
    title: r.title, payload, status: r.status,
    review_note: r.review_note, reviewed_at: r.reviewed_at, created_at: r.created_at,
    requested_by_name: r.requested_by_name, reviewed_by_name: r.reviewed_by_name,
    result_ref: r.result_ref, received_at: r.received_at
  };
}

// --- Свои ---
function listMine(req, res, user) {
  db.all("SELECT * FROM requests WHERE requested_by = ? ORDER BY id DESC", [user.id], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, { success: true, requests: (rows || []).map(mapRow) });
  });
}

// --- Все (админ) ---
function listAll(req, res, user, parsedUrl) {
  const { limit, offset } = parsePagination(parsedUrl);
  const status = parsedUrl.searchParams.get('status');
  const type = parsedUrl.searchParams.get('type');
  const where = [], params = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) { where.push('r.status = ?'); params.push(status); }
  if (type && REQUEST_TYPES[type]) { where.push('r.type = ?'); params.push(type); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT r.*, u.username AS requested_by_name, rv.username AS reviewed_by_name
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    ${whereSql}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC
    LIMIT ? OFFSET ?`;
  db.all(sql, [...params, limit, offset], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    db.get("SELECT COUNT(*) AS c FROM requests WHERE status='pending'", [], (e2, cnt) => {
      sendJson(res, 200, { success: true, requests: (rows || []).map(mapRow), pending: (cnt && cnt.c) || 0 });
    });
  });
}

// --- Сводка отпусков (админ): кто и когда в отпуске ---
// Возвращает заявления type='vacation' со статусами approved + pending,
// с ФИО сотрудника (если есть карточка) и разобранными датами, по возрастанию
// даты начала. Отдаётся без пагинации — отпусков в компании немного.
function listVacations(req, res, user) {
  const sql = `
    SELECT r.id, r.payload, r.status, r.created_at, r.reviewed_at,
           u.username AS requested_by_name,
           e.first_name AS emp_first, e.last_name AS emp_last
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN employees e ON e.user_id = r.requested_by
    WHERE r.type = 'vacation' AND r.status IN ('approved', 'pending')
    ORDER BY r.status DESC, r.id DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const today = new Date().toISOString().slice(0, 10);
    const vacations = (rows || []).map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch (e) {}
      const start = payload.start_date || '';
      const end = payload.end_date || '';
      const name = (r.emp_first || r.emp_last)
        ? [r.emp_first, r.emp_last].filter(Boolean).join(' ')
        : (payload.employee_name || r.requested_by_name || '—');
      // Фаза относительно сегодняшнего дня (для меток в UI).
      let phase = 'unknown';
      if (start && end) {
        if (today < start) phase = 'upcoming';
        else if (today > end) phase = 'past';
        else phase = 'current';
      }
      return {
        id: r.id, name, start_date: start, end_date: end,
        notes: payload.notes || '', status: r.status, phase,
        created_at: r.created_at, reviewed_at: r.reviewed_at
      };
    });
    // Пересортировка по дате начала (по возрастанию), пустые даты — в конец.
    vacations.sort((a, b) => {
      if (!a.start_date) return 1;
      if (!b.start_date) return -1;
      return a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0;
    });
    sendJson(res, 200, { success: true, vacations });
  });
}

// --- Оформление отпуска админом за сотрудника ---
// Создаёт сразу одобренный отпуск (type='vacation', status='approved').
// requested_by = user_id сотрудника (если есть аккаунт), имя дублируется в
// payload.employee_name на случай сотрудника без учётной записи.
async function createVacationForEmployee(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const empId = parseInt(body.employee_id, 10);
    if (!Number.isInteger(empId) || empId <= 0) {
      return sendJson(res, 400, { success: false, message: 'Не выбран сотрудник' });
    }
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || '')) ? body.start_date : '';
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || '')) ? body.end_date : '';
    if (!start || !end) return sendJson(res, 400, { success: false, message: 'Укажите даты начала и окончания' });
    if (end < start) return sendJson(res, 400, { success: false, message: 'Дата окончания раньше даты начала' });
    const notes = str(body.notes, 2000);

    db.get("SELECT id, first_name, last_name, user_id FROM employees WHERE id = ?", [empId], (err, emp) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

      const empName = [emp.first_name, emp.last_name].filter(Boolean).join(' ');
      const payload = { start_date: start, end_date: end, notes, employee_id: emp.id, employee_name: empName };
      const title = buildTitle('vacation', payload);
      db.run(
        `INSERT INTO requests (type, title, payload, status, requested_by, reviewed_by, reviewed_at)
         VALUES ('vacation', ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
        [title, JSON.stringify(payload), emp.user_id || null, user.id],
        function (insErr) {
          if (insErr) return sendJson(res, 500, { success: false, message: 'Не удалось создать отпуск' });
          logAction(user.username, `Оформил отпуск сотруднику ${empName}: ${start} — ${end} (id=${this.lastID})`);
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// --- Сводка заказов инструмента (админ): кому и что одобрили ---
// Только одобренные заявки type='tool_order' (отклонённые «исчезают»).
// received_at показывает, отметил ли сотрудник получение.
function listToolOrders(req, res, user) {
  const sql = `
    SELECT r.id, r.payload, r.title, r.created_at, r.reviewed_at, r.received_at,
           u.username AS requested_by_name,
           rv.username AS reviewed_by_name,
           e.first_name AS emp_first, e.last_name AS emp_last
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN employees e ON e.user_id = r.requested_by
    WHERE r.type = 'tool_order' AND r.status = 'approved'
    ORDER BY CASE WHEN r.received_at IS NULL THEN 0 ELSE 1 END, r.reviewed_at DESC, r.id DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const orders = (rows || []).map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch (e) {}
      const name = (r.emp_first || r.emp_last)
        ? [r.emp_first, r.emp_last].filter(Boolean).join(' ')
        : (r.requested_by_name || '—');
      return {
        id: r.id, name, title: r.title || '',
        item: payload.name || '', category: payload.category || '',
        quantity: payload.quantity || '', notes: payload.notes || '',
        reviewed_by_name: r.reviewed_by_name || '',
        reviewed_at: r.reviewed_at, received_at: r.received_at,
        received: !!r.received_at
      };
    });
    sendJson(res, 200, { success: true, orders });
  });
}

// --- Сводка заказов авто (админ): кому и что одобрили ---
// Только одобренные заявки type='vehicle_order' (отклонённые «исчезают»).
// received_at показывает, отметил ли сотрудник получение.
function listVehicleOrders(req, res, user) {
  const sql = `
    SELECT r.id, r.payload, r.title, r.created_at, r.reviewed_at, r.received_at,
           u.username AS requested_by_name,
           rv.username AS reviewed_by_name,
           e.first_name AS emp_first, e.last_name AS emp_last
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN employees e ON e.user_id = r.requested_by
    WHERE r.type = 'vehicle_order' AND r.status = 'approved'
    ORDER BY CASE WHEN r.received_at IS NULL THEN 0 ELSE 1 END, r.reviewed_at DESC, r.id DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const orders = (rows || []).map(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch (e) {}
      const name = (r.emp_first || r.emp_last)
        ? [r.emp_first, r.emp_last].filter(Boolean).join(' ')
        : (r.requested_by_name || '—');
      return {
        id: r.id, name, title: r.title || '',
        purpose: payload.name || '', category: payload.category || '',
        start_date: payload.start_date || '', end_date: payload.end_date || '',
        notes: payload.notes || '',
        reviewed_by_name: r.reviewed_by_name || '',
        reviewed_at: r.reviewed_at, received_at: r.received_at,
        received: !!r.received_at
      };
    });
    sendJson(res, 200, { success: true, orders });
  });
}

// --- Отметка получения (сотрудник): «Получил» ---
// Разрешено только автору заявки, только для одобренных tool_order/vehicle_order,
// которые ещё не получены.
function receiveRequest(req, res, user, parsedUrl) {
  const id = parseId(parsedUrl);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  db.get("SELECT * FROM requests WHERE id = ?", [id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
    if (row.requested_by !== user.id) return sendJson(res, 403, { success: false, message: 'Это не ваша заявка' });
    if (row.type !== 'tool_order' && row.type !== 'vehicle_order') {
      return sendJson(res, 400, { success: false, message: 'Неприменимо к этому типу' });
    }
    if (row.status !== 'approved') return sendJson(res, 409, { success: false, message: 'Заявка ещё не одобрена' });
    if (row.received_at) return sendJson(res, 409, { success: false, message: 'Уже отмечено как получено' });
    db.run(
      "UPDATE requests SET received_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id],
      (uErr) => {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить' });
        logAction(user.username, `Отметил получение заказа id=${id}: ${row.title || ''}`);
        sendJson(res, 200, { success: true });
      }
    );
  });
}

// Побочный эффект одобрения по типу. cb(err|null, resultRef|null).
// requestRow нужен, чтобы узнать заявителя (requested_by) и закрепить за ним
// инструмент, если он сотрудник.
function approveSideEffect(type, payload, requestRow, reviewer, cb) {
  if (type === 'tool_add') {
    const { error, values } = tools.extractToolFields(payload);
    if (error) return cb({ message: error });
    tools.findDuplicate(values, null, (dupErr, conflict) => {
      if (dupErr) return cb({ message: 'Ошибка базы данных' });
      if (conflict) return cb({ message: tools.duplicateMessage(conflict) });
      db.run(
        `INSERT INTO tools (name, category, brand, model, serial_number, inventory_number, status, purchase_date, photo_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
        [values.name, values.category, values.brand, values.model, values.serial_number,
         values.inventory_number, values.purchase_date, values.photo_url, values.notes],
        function (insErr) {
          if (insErr) return cb({ message: 'Не удалось создать инструмент' });
          const newToolId = this.lastID;

          // Если заявитель — сотрудник, сразу закрепляем инструмент за ним
          // (появится в разделе «Мой инструмент»). Иначе остаётся на складе.
          db.get("SELECT id FROM employees WHERE user_id = ?", [requestRow.requested_by], (empErr, emp) => {
            if (empErr || !emp) return cb(null, String(newToolId));
            db.run(
              "INSERT INTO tool_assignments (tool_id, employee_id, issued_by) VALUES (?, ?, ?)",
              [newToolId, emp.id, reviewer.username],
              (asgErr) => {
                if (asgErr) return cb(null, String(newToolId));
                db.run("UPDATE tools SET status = 'assigned' WHERE id = ?", [newToolId], () => {
                  cb(null, String(newToolId));
                });
              }
            );
          });
        }
      );
    });
    return;
  }
  // Остальные типы: одобрение — просто отметка, без автосоздания сущностей.
  cb(null, null);
}

// --- Одобрение ---
function approve(req, res, user, parsedUrl) {
  const id = parseId(parsedUrl);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  db.get("SELECT * FROM requests WHERE id = ?", [id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
    if (row.status !== 'pending') return sendJson(res, 409, { success: false, message: 'Заявление уже обработано' });

    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (e) {}

    approveSideEffect(row.type, payload, row, user, (sideErr, resultRef) => {
      if (sideErr) return sendJson(res, 409, { success: false, message: sideErr.message || 'Не удалось одобрить' });
      db.run(
        "UPDATE requests SET status='approved', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, result_ref=? WHERE id=?",
        [user.id, resultRef, id],
        (uErr) => {
          if (uErr) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
          logAction(user.username, `Одобрил заявление id=${id} (${row.type})`);
          sendJson(res, 200, { success: true, result_ref: resultRef });
        }
      );
    });
  });
}

// --- Отклонение ---
async function reject(req, res, user, parsedUrl) {
  const id = parseId(parsedUrl);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  let note = '';
  try { note = str((await getJsonBody(req)).review_note, 500); } catch (e) {}
  db.get("SELECT status FROM requests WHERE id = ?", [id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
    if (row.status !== 'pending') return sendJson(res, 409, { success: false, message: 'Заявление уже обработано' });
    db.run(
      "UPDATE requests SET status='rejected', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?",
      [user.id, note || null, id],
      (uErr) => {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось отклонить' });
        logAction(user.username, `Отклонил заявление id=${id}`);
        sendJson(res, 200, { success: true });
      }
    );
  });
}

module.exports = function handleRequests(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  if (p === '/api/request-types' && method === 'GET') {
    return sendJson(res, 200, { success: true, types: REQUEST_TYPES });
  }
  if (p === '/api/requests' && method === 'POST') return createRequest(req, res, user);
  if (p === '/api/requests/mine' && method === 'GET') return listMine(req, res, user);

  if (p === '/api/requests/vacations' && method === 'GET') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return listVacations(req, res, user);
  }
  if (p === '/api/requests/vacation-for' && method === 'POST') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return createVacationForEmployee(req, res, user);
  }
  if (p === '/api/requests/tool-orders' && method === 'GET') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return listToolOrders(req, res, user);
  }
  if (p === '/api/requests/vehicle-orders' && method === 'GET') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return listVehicleOrders(req, res, user);
  }
  if (p === '/api/requests/receive' && method === 'POST') return receiveRequest(req, res, user, parsedUrl);

  if (p === '/api/requests' && method === 'GET') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return listAll(req, res, user, parsedUrl);
  }
  if (p === '/api/requests/approve' && method === 'POST') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return approve(req, res, user, parsedUrl);
  }
  if (p === '/api/requests/reject' && method === 'POST') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return reject(req, res, user, parsedUrl);
  }

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};

module.exports.REQUEST_TYPES = REQUEST_TYPES;
