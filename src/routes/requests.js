const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');
const tools = require('./tools');
const apartments = require('./apartments');

// "Сегодня" по местному времени сервера (Europe/Vilnius, см. TZ в server.js) —
// а не по UTC, иначе статус отпуска/больничного мог бы переключаться на пару
// часов раньше/позже фактической местной полуночи.
function todayLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

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
    label: 'Я получил новый инструмент',
    icon: 'wrench',
    fields: [
      { name: 'source', label: 'Как получен', type: 'select', options: ['Получил новый', 'Выдали инструмент'], required: true },
      { name: 'existing_tool_id', label: 'Выберите инструмент со склада', type: 'existing_tool' },
      { name: 'name', label: 'Название', type: 'text' },
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
    label: 'Заказать снабжение',
    icon: 'shopping-cart',
    fields: [
      { name: 'name', label: 'Что заказать', type: 'text', required: true },
      { name: 'category', label: 'Категория', type: 'category' },
      { name: 'quantity', label: 'Количество', type: 'number' },
      { name: 'notes', label: 'Обоснование', type: 'textarea' }
    ]
  },
  vehicle_order: {
    label: 'Заявление на автомобиль',
    icon: 'car',
    fields: [
      { name: 'purpose', label: 'Цель', type: 'select', options: ['По работе', 'В личное пользование'], required: true },
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
  sick_leave: {
    label: 'Заявление на больничный',
    icon: 'thermometer',
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
  },
  relocation: {
    label: 'Заявление на место жительства',
    icon: 'home',
    fields: [
      { name: 'housing_type', label: 'Тип жилья', type: 'select', options: ['От компании', 'Собственное жильё'], required: true },
      { name: 'apartment_id', label: 'Выберите жильё', type: 'apartment' },
      { name: 'desired_date', label: 'Желаемая дата переезда', type: 'date' },
      { name: 'reason', label: 'Причина', type: 'textarea' }
    ]
  },
  tool_service: {
    label: 'Заявление на замену/обслуживание электроинструмента',
    icon: 'wrench',
    fields: [
      { name: 'tool_id', label: 'Выберите инструмент', type: 'assigned_tool', required: true },
      { name: 'issue_type', label: 'Что требуется', type: 'select', options: ['Обслуживание', 'Ремонт', 'Замена'], required: true },
      { name: 'description', label: 'Описание проблемы', type: 'textarea', required: true },
      { name: 'photo_url', label: 'Фото проблемы', type: 'photo' }
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
    else if (f.type === 'number' || f.type === 'apartment' || f.type === 'assigned_tool' || f.type === 'existing_tool') { const n = parseInt(val, 10); val = (Number.isInteger(n) && n > 0) ? n : ''; }
    else if (f.type === 'date') val = /^\d{4}-\d{2}-\d{2}$/.test(String(val || '')) ? val : '';
    else if (f.type === 'select') val = (f.options || []).includes(val) ? val : '';
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
    case 'vehicle_order': return 'Авто: ' + (payload.purpose || '—') + (payload.start_date ? ` (${payload.start_date}${payload.end_date ? ' — ' + payload.end_date : ''})` : '');
    case 'vacation':    return `Отпуск: ${payload.start_date || '?'} — ${payload.end_date || '?'}`;
    case 'sick_leave':  return `Больничный: ${payload.start_date || '?'} — ${payload.end_date || '?'}`;
    case 'resignation': return 'Увольнение' + (payload.last_day ? ` с ${payload.last_day}` : '');
    case 'relocation': return payload.housing_type === 'Собственное жильё'
      ? 'Переезд в собственное жильё'
      : 'Смена жилья: ' + (payload.apartment_name || ('id ' + payload.apartment_id));
    case 'tool_service': return (payload.issue_type || 'Обслуживание') + ': ' + (payload.tool_name || ('id ' + payload.tool_id));
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

    const insertRequest = (finalPayload) => {
      const title = buildTitle(type, finalPayload);
      db.run(
        "INSERT INTO requests (type, title, payload, requested_by) VALUES (?, ?, ?, ?)",
        [type, title, JSON.stringify(finalPayload), user.id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Не удалось создать заявление' });
          logAction(user.username, `Создал заявление «${typeDef.label}»: ${title} (id=${this.lastID})`);
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
    };

    if (type === 'relocation') {
      if (payload.housing_type === 'Собственное жильё') {
        insertRequest({ ...payload, apartment_id: '', apartment_name: '' });
        return;
      }
      if (!payload.apartment_id) return sendJson(res, 400, { success: false, message: 'Выберите жильё' });
      db.get("SELECT id, name, address, status FROM apartments WHERE id = ?", [payload.apartment_id], (aErr, apt) => {
        if (aErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!apt) return sendJson(res, 400, { success: false, message: 'Выбранное жильё не найдено' });
        if (apt.status === 'written_off') return sendJson(res, 400, { success: false, message: 'Это жильё списано' });
        insertRequest({ ...payload, apartment_name: [apt.name, apt.address].filter(Boolean).join(', ') });
      });
      return;
    }

    if (type === 'tool_service') {
      db.get("SELECT id FROM employees WHERE user_id = ?", [user.id], (eErr, emp) => {
        if (eErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!emp) return sendJson(res, 400, { success: false, message: 'За вами не закреплено ни одного инструмента' });
        db.get(
          `SELECT t.id, t.name FROM tool_assignments a
           JOIN tools t ON t.id = a.tool_id
           WHERE a.tool_id = ? AND a.employee_id = ? AND a.returned_at IS NULL`,
          [payload.tool_id, emp.id],
          (tErr, tool) => {
            if (tErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            if (!tool) return sendJson(res, 400, { success: false, message: 'Этот инструмент за вами не закреплён' });
            insertRequest({ ...payload, tool_name: tool.name });
          }
        );
      });
      return;
    }

    if (type === 'tool_add') {
      if (payload.source === 'Выдали инструмент') {
        if (!payload.existing_tool_id) return sendJson(res, 400, { success: false, message: 'Выберите инструмент со склада' });
        db.get("SELECT id, name, status FROM tools WHERE id = ?", [payload.existing_tool_id], (tErr, tool) => {
          if (tErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          if (!tool) return sendJson(res, 400, { success: false, message: 'Инструмент не найден' });
          if (tool.status === 'written_off') return sendJson(res, 400, { success: false, message: 'Этот инструмент списан' });
          insertRequest({ ...payload, name: tool.name });
        });
        return;
      }
      // 'Получил новый' — та же ветка, что раньше: обязательно название нового инструмента.
      if (!payload.name) return sendJson(res, 400, { success: false, message: 'Поле «Название» обязательно' });
      insertRequest(payload);
      return;
    }

    insertRequest(payload);
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
  if (status && ['pending', 'approved', 'rejected', 'countered'].includes(status)) { where.push('r.status = ?'); params.push(status); }
  if (type && REQUEST_TYPES[type]) { where.push('r.type = ?'); params.push(type); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sql = `
    SELECT r.*, u.username AS requested_by_username, rv.username AS reviewed_by_name,
           e.first_name AS req_first, e.last_name AS req_last
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by
    LEFT JOIN employees e ON e.user_id = r.requested_by
    ${whereSql}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'countered' THEN 0 ELSE 1 END, r.id DESC
    LIMIT ? OFFSET ?`;
  db.all(sql, [...params, limit, offset], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    db.get("SELECT COUNT(*) AS c FROM requests WHERE status='pending'", [], (e2, cnt) => {
      const withNames = (rows || []).map(r => {
        r.requested_by_name = [r.req_first, r.req_last].filter(Boolean).join(' ').trim() || r.requested_by_username;
        return r;
      });
      sendJson(res, 200, { success: true, requests: withNames.map(mapRow), pending: (cnt && cnt.c) || 0 });
    });
  });
}

// --- Автосинхронизация статуса сотрудника с одобренными отпусками/больничными ---
// Смотрит на все одобренные заявления type IN ('vacation','sick_leave'),
// у которых сегодняшняя дата попадает в [start_date, end_date], и выставляет
// статус сотрудника 'vacation'/'sick_leave'. Сотрудников без такого периода,
// но всё ещё числящихся 'vacation'/'sick_leave', возвращает в 'active'.
// Ручные статусы 'inactive'/'fired' никогда не трогаются.
function syncEmployeeLeaveStatuses(cb) {
  const sql = `
    SELECT r.payload, r.type, r.requested_by
    FROM requests r
    WHERE r.type IN ('vacation', 'sick_leave') AND r.status = 'approved'`;
  db.all(sql, [], (err, rows) => {
    if (err) return cb && cb(err);
    const today = todayLocal();
    const activeEntries = [];
    (rows || []).forEach(r => {
      let payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch (e) {}
      const start = payload.start_date, end = payload.end_date;
      if (!start || !end || today < start || today > end) return;
      activeEntries.push({ type: r.type, employeeId: payload.employee_id || null, requestedBy: r.requested_by });
    });

    const applyWith = (activeByEmployee) => {
      db.all("SELECT id, status FROM employees WHERE status IN ('active', 'vacation', 'sick_leave')", [], (e2, emps) => {
        if (e2) return cb && cb(e2);
        const updates = (emps || [])
          .map(e => ({ id: e.id, from: e.status, to: activeByEmployee[e.id] || 'active' }))
          .filter(u => u.to !== u.from);
        if (!updates.length) return cb && cb(null, { changed: 0 });
        let done = 0, dbErr = null;
        updates.forEach(u => {
          db.run("UPDATE employees SET status = ? WHERE id = ?", [u.to, u.id], (uErr) => {
            if (uErr) dbErr = uErr;
            if (++done === updates.length) cb && cb(dbErr, { changed: updates.length });
          });
        });
      });
    };

    const activeByEmployee = {};
    const needLookup = [...new Set(activeEntries.filter(e => !e.employeeId && e.requestedBy).map(e => e.requestedBy))];
    activeEntries.forEach(e => { if (e.employeeId && !activeByEmployee[e.employeeId]) activeByEmployee[e.employeeId] = e.type; });
    if (!needLookup.length) return applyWith(activeByEmployee);

    const placeholders = needLookup.map(() => '?').join(',');
    db.all(`SELECT id, user_id FROM employees WHERE user_id IN (${placeholders})`, needLookup, (e3, empRows) => {
      const byUser = {};
      (empRows || []).forEach(e => { byUser[e.user_id] = e.id; });
      activeEntries.forEach(e => {
        const empId = e.employeeId || byUser[e.requestedBy];
        if (empId && !activeByEmployee[empId]) activeByEmployee[empId] = e.type;
      });
      applyWith(activeByEmployee);
    });
  });
}

// --- Сводка отпусков/больничных (админ): кто и когда отсутствует ---
// Возвращает заявления type IN ('vacation','sick_leave') со статусами
// approved + pending, с ФИО сотрудника (если есть карточка) и разобранными
// датами, по возрастанию даты начала. Отдаётся без пагинации — таких
// заявлений в компании немного.
function listVacations(req, res, user) {
  const sql = `
    SELECT r.id, r.type, r.payload, r.status, r.created_at, r.reviewed_at,
           u.username AS requested_by_name,
           e.first_name AS emp_first, e.last_name AS emp_last
    FROM requests r
    LEFT JOIN users u ON u.id = r.requested_by
    LEFT JOIN employees e ON e.user_id = r.requested_by
    WHERE r.type IN ('vacation', 'sick_leave') AND r.status IN ('approved', 'pending')
    ORDER BY r.status DESC, r.id DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const today = todayLocal();
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
        id: r.id, type: r.type,
        type_label: (REQUEST_TYPES[r.type] || {}).label || r.type,
        name, start_date: start, end_date: end,
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
          syncEmployeeLeaveStatuses();
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// --- Редактирование отпуска/больничного (админ) ---
// Меняет только даты и комментарий существующего заявления type IN
// ('vacation','sick_leave') — тип, статус и заявитель не трогаются.
async function editVacation(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { success: false, message: 'Не указан id' });
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || '')) ? body.start_date : '';
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date || '')) ? body.end_date : '';
    if (!start || !end) return sendJson(res, 400, { success: false, message: 'Укажите даты начала и окончания' });
    if (end < start) return sendJson(res, 400, { success: false, message: 'Дата окончания раньше даты начала' });
    const notes = str(body.notes, 2000);

    db.get("SELECT * FROM requests WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row || (row.type !== 'vacation' && row.type !== 'sick_leave')) {
        return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
      }
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch (e) {}
      payload.start_date = start;
      payload.end_date = end;
      payload.notes = notes;
      const title = buildTitle(row.type, payload);
      db.run(
        "UPDATE requests SET payload = ?, title = ? WHERE id = ?",
        [JSON.stringify(payload), title, id],
        (uErr) => {
          if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить' });
          logAction(user.username, `Изменил ${row.type === 'sick_leave' ? 'больничный' : 'отпуск'} (id=${id}): ${start} — ${end}`);
          if (row.status === 'approved') syncEmployeeLeaveStatuses();
          sendJson(res, 200, { success: true });
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
        purpose: payload.purpose || '', category: payload.category || '',
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
  if (type === 'tool_add' && payload.existing_tool_id) {
    // «Выдали инструмент» — предмет уже есть в инвентаре, просто закрепляем
    // его за заявителем вместо создания дубликата записи.
    const toolId = parseInt(payload.existing_tool_id, 10);
    return db.get("SELECT id, status FROM tools WHERE id = ?", [toolId], (tErr, tool) => {
      if (tErr) return cb({ message: 'Ошибка базы данных' });
      if (!tool) return cb({ message: 'Инструмент не найден' });
      if (tool.status === 'written_off') return cb({ message: 'Этот инструмент списан' });
      db.get("SELECT id FROM employees WHERE user_id = ?", [requestRow.requested_by], (empErr, emp) => {
        if (empErr || !emp) return cb({ message: 'Заявитель не найден среди сотрудников' });
        db.get(
          "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
          [toolId, emp.id],
          (chkErr, already) => {
            if (chkErr) return cb({ message: 'Ошибка базы данных' });
            if (already) return cb(null, String(toolId));
            db.run(
              "INSERT INTO tool_assignments (tool_id, employee_id, issued_by) VALUES (?, ?, ?)",
              [toolId, emp.id, reviewer.username],
              (asgErr) => {
                if (asgErr) return cb({ message: 'Не удалось выдать инструмент' });
                db.run("UPDATE tools SET status = 'assigned' WHERE id = ? AND status != 'written_off'", [toolId], () => cb(null, String(toolId)));
              }
            );
          }
        );
      });
    });
  }
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
  if (type === 'relocation' && payload.housing_type === 'Собственное жильё') {
    // Переезд в своё жильё — выселяем из компанейского (если было заселён)
    // и отмечаем сотрудника как «живёт в своей квартире».
    db.get("SELECT id FROM employees WHERE user_id = ?", [requestRow.requested_by], (eErr, emp) => {
      if (eErr) return cb({ message: 'Ошибка базы данных' });
      if (!emp) return cb(null, null);
      db.all(
        "SELECT id, apartment_id FROM apartment_assignments WHERE employee_id = ? AND returned_at IS NULL",
        [emp.id],
        (oErr, openAssignments) => {
          if (oErr) return cb({ message: 'Ошибка базы данных' });
          const affectedIds = [...new Set((openAssignments || []).map(a => a.apartment_id))];
          const closeOld = (done) => {
            if (!openAssignments || !openAssignments.length) return done();
            let n = 0;
            openAssignments.forEach(a => {
              db.run("UPDATE apartment_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [a.id], () => {
                if (++n === openAssignments.length) done();
              });
            });
          };
          closeOld(() => {
            db.run("UPDATE employees SET own_housing = 1 WHERE id = ?", [emp.id], (uErr) => {
              if (uErr) return cb({ message: 'Не удалось сохранить' });
              if (!affectedIds.length) return cb(null, null);
              let done = 0;
              affectedIds.forEach(id => {
                apartments.recomputeApartmentStatus(id, () => {
                  if (++done === affectedIds.length) cb(null, null);
                });
              });
            });
          });
        }
      );
    });
    return;
  }
  if (type === 'relocation') {
    const apartmentId = parseInt(payload.apartment_id, 10);
    if (!Number.isInteger(apartmentId) || apartmentId <= 0) return cb({ message: 'Не указано жильё' });
    db.get("SELECT id, name, status FROM apartments WHERE id = ?", [apartmentId], (aErr, apt) => {
      if (aErr) return cb({ message: 'Ошибка базы данных' });
      if (!apt) return cb({ message: 'Выбранное жильё не найдено' });
      if (apt.status === 'written_off') return cb({ message: 'Это жильё списано' });

      db.get("SELECT id FROM employees WHERE user_id = ?", [requestRow.requested_by], (eErr, emp) => {
        if (eErr) return cb({ message: 'Ошибка базы данных' });
        // Заявитель без карточки сотрудника — одобряем, но заселять некого.
        if (!emp) return cb(null, String(apartmentId));

        db.all(
          "SELECT id, apartment_id FROM apartment_assignments WHERE employee_id = ? AND returned_at IS NULL",
          [emp.id],
          (oErr, openAssignments) => {
            if (oErr) return cb({ message: 'Ошибка базы данных' });
            const oldApartmentIds = [...new Set((openAssignments || []).map(a => a.apartment_id))];

            const closeOld = (done) => {
              if (!openAssignments || !openAssignments.length) return done();
              let n = 0;
              openAssignments.forEach(a => {
                db.run("UPDATE apartment_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [a.id], () => {
                  if (++n === openAssignments.length) done();
                });
              });
            };

            closeOld(() => {
              db.run("UPDATE employees SET own_housing = 0 WHERE id = ?", [emp.id], () => {});
              db.run(
                "INSERT INTO apartment_assignments (apartment_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
                [apartmentId, emp.id, reviewer.username, 'Смена места жительства (заявка)'],
                function (insErr) {
                  if (insErr) return cb({ message: 'Не удалось заселить' });
                  const affectedIds = [...new Set([...oldApartmentIds, apartmentId])];
                  let done = 0;
                  affectedIds.forEach(id => {
                    apartments.recomputeApartmentStatus(id, () => {
                      if (++done === affectedIds.length) cb(null, String(apartmentId));
                    });
                  });
                }
              );
            });
          }
        );
      });
    });
    return;
  }
  if (type === 'tool_service') {
    const toolId = parseInt(payload.tool_id, 10);
    if (!Number.isInteger(toolId) || toolId <= 0) return cb({ message: 'Не указан инструмент' });
    db.get("SELECT id, status FROM tools WHERE id = ?", [toolId], (tErr, tool) => {
      if (tErr) return cb({ message: 'Ошибка базы данных' });
      if (!tool) return cb({ message: 'Инструмент не найден' });
      if (tool.status === 'written_off') return cb({ message: 'Этот инструмент списан' });
      db.run("UPDATE tools SET status = 'repair' WHERE id = ?", [toolId], (uErr) => {
        if (uErr) return cb({ message: 'Не удалось обновить статус инструмента' });
        cb(null, String(toolId));
      });
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
          if (row.type === 'vacation' || row.type === 'sick_leave') syncEmployeeLeaveStatuses();
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

// --- Предложить другие даты (админ) вместо отклонения отпуска/больничного ---
// Переводит заявление в статус 'countered': сохраняет предложенные даты и
// комментарий в payload, оригинальные start_date/end_date не трогает — их
// нужно показать сотруднику для сравнения. Решение — за сотрудником
// (см. counterRespond).
async function counterOffer(req, res, user, parsedUrl) {
  const id = parseId(parsedUrl);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  let body;
  try { body = await getJsonBody(req); } catch (e) { return sendJson(res, 400, { success: false, message: 'Невалидный запрос' }); }
  const altStart = /^\d{4}-\d{2}-\d{2}$/.test(String(body.alt_start_date || '')) ? body.alt_start_date : '';
  const altEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(body.alt_end_date || '')) ? body.alt_end_date : '';
  if (!altStart || !altEnd) return sendJson(res, 400, { success: false, message: 'Укажите обе альтернативные даты' });
  if (altEnd < altStart) return sendJson(res, 400, { success: false, message: 'Дата окончания раньше даты начала' });
  const note = str(body.review_note, 500);

  db.get("SELECT * FROM requests WHERE id = ?", [id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
    if (row.type !== 'vacation' && row.type !== 'sick_leave') {
      return sendJson(res, 400, { success: false, message: 'Альтернативные даты применимы только к отпуску/больничному' });
    }
    if (row.status !== 'pending') return sendJson(res, 409, { success: false, message: 'Заявление уже обработано' });

    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (e) {}
    payload.alt_start_date = altStart;
    payload.alt_end_date = altEnd;
    payload.counter_note = note;

    db.run(
      "UPDATE requests SET status='countered', payload=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, review_note=? WHERE id=?",
      [JSON.stringify(payload), user.id, note || null, id],
      (uErr) => {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить' });
        logAction(user.username, `Предложил другие даты по заявлению id=${id}: ${altStart} — ${altEnd}`);
        sendJson(res, 200, { success: true });
      }
    );
  });
}

// --- Ответ сотрудника на предложенные даты ---
// accept=true: заявление одобряется с предложенными датами (start/end
// заменяются на alt_*, значения alt_* остаются в payload для истории).
// accept=false: заявление отклоняется как есть (сотрудник условия не принял).
async function counterRespond(req, res, user, parsedUrl) {
  const id = parseId(parsedUrl);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  let body;
  try { body = await getJsonBody(req); } catch (e) { return sendJson(res, 400, { success: false, message: 'Невалидный запрос' }); }
  const accept = body.accept === true;

  db.get("SELECT * FROM requests WHERE id = ?", [id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 404, { success: false, message: 'Заявление не найдено' });
    if (row.requested_by !== user.id) return sendJson(res, 403, { success: false, message: 'Это не ваша заявка' });
    if (row.status !== 'countered') return sendJson(res, 409, { success: false, message: 'По этой заявке нет предложенных дат' });

    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (e) {}

    if (!accept) {
      return db.run(
        "UPDATE requests SET status='rejected' WHERE id=?",
        [id],
        (uErr) => {
          if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить' });
          logAction(user.username, `Отклонил предложенные даты по заявлению id=${id}`);
          sendJson(res, 200, { success: true });
        }
      );
    }

    payload.start_date = payload.alt_start_date;
    payload.end_date = payload.alt_end_date;
    const title = buildTitle(row.type, payload);
    db.run(
      "UPDATE requests SET status='approved', payload=?, title=? WHERE id=?",
      [JSON.stringify(payload), title, id],
      (uErr) => {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить' });
        logAction(user.username, `Принял предложенные даты по заявлению id=${id}: ${payload.start_date} — ${payload.end_date}`);
        syncEmployeeLeaveStatuses();
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
  if (p === '/api/requests/vacation-edit' && method === 'POST') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return editVacation(req, res, user);
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
  if (p === '/api/requests/counter' && method === 'POST') {
    if (!canReview(user)) return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    return counterOffer(req, res, user, parsedUrl);
  }
  if (p === '/api/requests/counter-respond' && method === 'POST') return counterRespond(req, res, user, parsedUrl);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};

module.exports.REQUEST_TYPES = REQUEST_TYPES;
module.exports.syncEmployeeLeaveStatuses = syncEmployeeLeaveStatuses;
