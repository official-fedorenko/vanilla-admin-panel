const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');

/**
 * Учёт инструмента + закрепление за сотрудниками (модель «выдача-возврат»).
 *
 * Маршруты:
 *   GET/POST/PUT/DELETE /api/crud/tools[?id=]   — CRUD инвентаря
 *   POST                /api/tools/issue         — выдать инструмент сотруднику
 *   POST                /api/tools/return        — принять инструмент назад
 *   GET                 /api/tools/history?tool_id=  — история закреплений
 *
 * Права: чтение — любой авторизованный; изменения/выдача/возврат — Admin/Superadmin.
 */

const ALLOWED_STATUSES = ['available', 'assigned', 'repair', 'written_off'];

function parseId(parsedUrl, key = 'id') {
  const id = parseInt(parsedUrl.searchParams.get(key), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canWrite(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

const DUP_FIELD_LABEL = { serial_number: 'серийным номером', inventory_number: 'инвентарным номером' };

// Ищет инструмент с таким же серийным/инвентарным номером (без учёта регистра),
// исключая сам редактируемый инструмент. cb(err, conflict|null),
// conflict = { field, value, tool: {id, name} }. Пустые значения пропускаются.
function findDuplicate(values, excludeId, cb) {
  const checks = [];
  if (values.serial_number) checks.push(['serial_number', values.serial_number]);
  if (values.inventory_number) checks.push(['inventory_number', values.inventory_number]);
  if (!checks.length) return cb(null, null);

  let i = 0;
  const next = () => {
    if (i >= checks.length) return cb(null, null);
    const [field, val] = checks[i++];
    db.get(
      `SELECT id, name FROM tools WHERE ${field} = ? COLLATE NOCASE AND id != ?`,
      [val, excludeId || -1],
      (err, row) => {
        if (err) return cb(err);
        if (row) return cb(null, { field, value: val, tool: row });
        next();
      }
    );
  };
  next();
}

function duplicateMessage(conflict) {
  return `Инструмент с ${DUP_FIELD_LABEL[conflict.field]} «${conflict.value}» уже есть: «${conflict.tool.name}» (ID ${conflict.tool.id})`;
}

function extractToolFields(body) {
  const name = (body.name || '').trim();
  if (name.length < 1) return { error: 'Название инструмента обязательно' };

  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'available';
  const purchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(body.purchase_date || '') ? body.purchase_date : null;

  const str = (v) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, 300) : null;
  };

  // photo_url принимаем только как внутренний путь: загруженный файл
  // (/uploads/...) или картинку из каталога (/catalog/images/*.svg).
  // Защита от подстановки внешних/произвольных URL.
  const rawPhoto = (body.photo_url == null ? '' : String(body.photo_url)).trim();
  const isUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto);
  const isCatalogImg = /^\/catalog\/images\/[A-Za-z0-9._-]+\.svg$/.test(rawPhoto);
  const photoUrl = (isUpload || isCatalogImg) ? rawPhoto : null;

  return {
    values: {
      name: name.slice(0, 200),
      category: str(body.category),
      brand: str(body.brand),
      model: str(body.model),
      serial_number: str(body.serial_number),
      inventory_number: str(body.inventory_number),
      status,
      purchase_date: purchaseDate,
      photo_url: photoUrl,
      notes: str(body.notes)
    }
  };
}

// ---- CRUD инвентаря (/api/crud/tools) ----
async function handleCrud(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    // Текущий держатель = открытое закрепление (returned_at IS NULL)
    const sql = `
      SELECT t.*,
        a.employee_id AS current_employee_id,
        a.issued_at   AS current_issued_at,
        CASE WHEN e.id IS NOT NULL
             THEN e.last_name || ' ' || e.first_name END AS current_holder
      FROM tools t
      LEFT JOIN tool_assignments a ON a.tool_id = t.id AND a.returned_at IS NULL
      LEFT JOIN employees e ON e.id = a.employee_id
      ORDER BY t.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM tools", [], (err2, countRow) => {
        res.setHeader('X-Total-Count', String((countRow && countRow.count) || 0));
        sendJson(res, 200, rows);
      });
    });
    return;
  }

  if (!canWrite(user)) {
    return sendJson(res, 403, { success: false, message: 'Недостаточно прав (нужен Admin или Superadmin)' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const { error, values } = extractToolFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      findDuplicate(values, null, (dupErr, conflict) => {
        if (dupErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (conflict) return sendJson(res, 409, { success: false, message: duplicateMessage(conflict) });

      db.run(
        `INSERT INTO tools (name, category, brand, model, serial_number, inventory_number, status, purchase_date, photo_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.name, values.category, values.brand, values.model, values.serial_number,
         values.inventory_number, values.status, values.purchase_date, values.photo_url, values.notes],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка создания инструмента' });
          logAction(user.username, `Добавлен инструмент «${values.name}»`);
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
      }); // findDuplicate
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'PUT') {
    try {
      const id = parseId(parsedUrl);
      if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
      const body = await getJsonBody(req);
      const { error, values } = extractToolFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      findDuplicate(values, id, (dupErr, conflict) => {
        if (dupErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (conflict) return sendJson(res, 409, { success: false, message: duplicateMessage(conflict) });

      db.run(
        `UPDATE tools SET name = ?, category = ?, brand = ?, model = ?, serial_number = ?,
           inventory_number = ?, status = ?, purchase_date = ?, photo_url = ?, notes = ? WHERE id = ?`,
        [values.name, values.category, values.brand, values.model, values.serial_number,
         values.inventory_number, values.status, values.purchase_date, values.photo_url, values.notes, id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
          if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });
          logAction(user.username, `Обновлён инструмент id=${id}`);
          sendJson(res, 200, { success: true });
        }
      );
      }); // findDuplicate
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    // FK ON DELETE CASCADE не срабатывает без PRAGMA foreign_keys=ON,
    // поэтому чистим историю закреплений явно, чтобы не осталось «сирот».
    db.run("DELETE FROM tool_assignments WHERE tool_id = ?", [id], () => {
      db.run("DELETE FROM tools WHERE id = ?", [id], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
        if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });
        logAction(user.username, `Удалён инструмент id=${id}`);
        sendJson(res, 200, { success: true });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// ---- Выдать инструмент (/api/tools/issue) ----
async function handleIssue(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!toolId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать инструмент и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name, status FROM tools WHERE id = ?", [toolId], (err, tool) => {
      if (err || !tool) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });
      if (tool.status === 'written_off') {
        return sendJson(res, 400, { success: false, message: 'Инструмент списан — выдать нельзя' });
      }
      // Проверяем, что инструмент не на руках (нет открытого закрепления)
      db.get("SELECT id FROM tool_assignments WHERE tool_id = ? AND returned_at IS NULL", [toolId], (err2, open) => {
        if (open) return sendJson(res, 409, { success: false, message: 'Инструмент уже выдан — сначала верните его' });

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (err3, emp) => {
          if (err3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          db.run(
            "INSERT INTO tool_assignments (tool_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
            [toolId, employeeId, user.username, notes],
            function (err4) {
              if (err4) return sendJson(res, 500, { success: false, message: 'Ошибка выдачи' });
              db.run("UPDATE tools SET status = 'assigned' WHERE id = ?", [toolId]);
              logAction(user.username, `Выдан инструмент «${tool.name}» → ${emp.last_name} ${emp.first_name}`);
              sendJson(res, 201, { success: true, id: this.lastID });
            }
          );
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Вернуть инструмент (/api/tools/return) ----
async function handleReturn(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан инструмент' });

    db.get("SELECT id FROM tool_assignments WHERE tool_id = ? AND returned_at IS NULL", [toolId], (err, open) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!open) return sendJson(res, 400, { success: false, message: 'Инструмент и так на складе' });

      db.run("UPDATE tool_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], function (err2) {
        if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка возврата' });
        db.run("UPDATE tools SET status = 'available' WHERE id = ?", [toolId]);
        logAction(user.username, `Возвращён инструмент id=${toolId}`);
        sendJson(res, 200, { success: true });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Передать инструмент другому сотруднику (/api/tools/transfer) ----
// Атомарно: закрывает текущее закрепление и открывает новое, минуя склад.
async function handleTransfer(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!toolId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать инструмент и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name FROM tools WHERE id = ?", [toolId], (err, tool) => {
      if (err || !tool) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });

      db.get("SELECT id, employee_id FROM tool_assignments WHERE tool_id = ? AND returned_at IS NULL", [toolId], (e2, open) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!open) return sendJson(res, 400, { success: false, message: 'Инструмент на складе — используйте выдачу' });
        if (open.employee_id === employeeId) {
          return sendJson(res, 400, { success: false, message: 'Инструмент уже закреплён за этим сотрудником' });
        }

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (e3, emp) => {
          if (e3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          // Закрываем текущее закрепление и сразу открываем новое
          db.run("UPDATE tool_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e4) => {
            if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
            db.run(
              "INSERT INTO tool_assignments (tool_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
              [toolId, employeeId, user.username, notes],
              function (e5) {
                if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
                db.run("UPDATE tools SET status = 'assigned' WHERE id = ?", [toolId]);
                logAction(user.username, `Передан инструмент «${tool.name}» → ${emp.last_name} ${emp.first_name}`);
                sendJson(res, 200, { success: true, id: this.lastID });
              }
            );
          });
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Проверка дублей в реальном времени (/api/tools/check-dup) ----
// GET ?serial=..&inventory=..&exclude_id=.. → { serial: null|{id,name}, inventory: null|{id,name} }
function handleCheckDup(req, res, user, parsedUrl) {
  const serial = (parsedUrl.searchParams.get('serial') || '').trim();
  const inventory = (parsedUrl.searchParams.get('inventory') || '').trim();
  const excludeId = parseInt(parsedUrl.searchParams.get('exclude_id'), 10) || -1;

  const lookup = (field, val, cb) => {
    if (!val) return cb(null);
    db.get(`SELECT id, name FROM tools WHERE ${field} = ? COLLATE NOCASE AND id != ?`, [val, excludeId], (err, row) => {
      cb(err ? null : (row || null));
    });
  };

  lookup('serial_number', serial, (serialHit) => {
    lookup('inventory_number', inventory, (invHit) => {
      sendJson(res, 200, { success: true, serial: serialHit, inventory: invHit });
    });
  });
}

// ---- История закреплений инструмента (/api/tools/history) ----
function handleHistory(req, res, user, parsedUrl) {
  const toolId = parseId(parsedUrl, 'tool_id');
  if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан tool_id' });
  const sql = `
    SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
      CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
           ELSE '— (сотрудник удалён)' END AS employee_name
    FROM tool_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.tool_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [toolId], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

// ---- Справочник категорий (/api/crud/tool-categories) ----
async function handleCategories(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    db.all("SELECT id, name, is_default FROM tool_categories ORDER BY name COLLATE NOCASE", [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, rows || []);
    });
    return;
  }

  // Изменять список категорий может только Superadmin
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Управлять категориями может только Superadmin' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const name = (body.name || '').trim();
      if (name.length < 2) return sendJson(res, 400, { success: false, message: 'Название категории слишком короткое' });

      db.run("INSERT INTO tool_categories (name, is_default) VALUES (?, 0)", [name.slice(0, 100)], function (err) {
        if (err) {
          const msg = err.message.includes('UNIQUE') ? 'Такая категория уже есть' : 'Ошибка создания категории';
          return sendJson(res, 400, { success: false, message: msg });
        }
        logAction(user.username, `Добавлена категория инструмента «${name}»`);
        sendJson(res, 201, { success: true, id: this.lastID, name });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    db.get("SELECT is_default FROM tool_categories WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Категория не найдена' });
      if (row.is_default) return sendJson(res, 400, { success: false, message: 'Стандартную категорию удалить нельзя' });
      db.run("DELETE FROM tool_categories WHERE id = ?", [id], function (dErr) {
        if (dErr) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
        logAction(user.username, `Удалена категория инструмента id=${id}`);
        sendJson(res, 200, { success: true });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

module.exports = async function handleTools(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/crud/tool-categories')) return handleCategories(req, res, user, parsedUrl, method);
  if (pathname.startsWith('/api/crud/tools')) return handleCrud(req, res, user, parsedUrl, method);
  if (pathname === '/api/tools/issue' && method === 'POST') return handleIssue(req, res, user);
  if (pathname === '/api/tools/return' && method === 'POST') return handleReturn(req, res, user);
  if (pathname === '/api/tools/transfer' && method === 'POST') return handleTransfer(req, res, user);
  if (pathname === '/api/tools/check-dup' && method === 'GET') return handleCheckDup(req, res, user, parsedUrl);
  if (pathname === '/api/tools/history' && method === 'GET') return handleHistory(req, res, user, parsedUrl);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
