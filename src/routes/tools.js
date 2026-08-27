const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Автогенерация инвентарного номера: INV-D + дата(ГГММДД) + крипто-случайность.
// Пример: INV-D260821A1B2C3. Дата — для читаемости, hex — против совпадений.
function genInventory() {
  const d = new Date();
  const datePart = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `INV-D${datePart}${rand}`;
}

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

const ALLOWED_STATUSES = ['available', 'assigned', 'repair', 'lost', 'written_off'];

function parseId(parsedUrl, key = 'id') {
  const id = parseInt(parsedUrl.searchParams.get(key), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canWrite(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

// Журнал смены статуса — кто изменил (админ вручную или заявление сотрудника).
function logToolStatus(toolId, status, opts = {}) {
  db.run(
    "INSERT INTO tool_status_log (tool_id, status, changed_by, source, request_id, requested_by_username, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [toolId, status, opts.changedBy || null, opts.source || 'admin', opts.requestId || null, opts.requestedByUsername || null, opts.note || null],
    () => {}
  );
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
  // Отрезаем query (?v=…) и якорь — каталожные иконки приходят с версией
  // для сброса кэша, но в БД храним чистый путь.
  const rawPhotoRaw = (body.photo_url == null ? '' : String(body.photo_url)).trim();
  const rawPhoto = rawPhotoRaw.split('?')[0].split('#')[0];
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
      // Пустой инвентарный номер генерируем автоматически (INV-D…).
      inventory_number: str(body.inventory_number) || genInventory(),
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
    // Инструмент можно закрепить за несколькими сотрудниками одновременно —
    // агрегируем все активные (returned_at IS NULL) закрепления в один список
    // «occupants» ('assignment_id|employee_id|issued_at|Фамилия Имя', разделитель ';;').
    const sql = `
      SELECT t.*,
        GROUP_CONCAT(
          a.id || '|' || a.employee_id || '|' || a.issued_at || '|' ||
          replace(replace(e.last_name || ' ' || e.first_name, '|', ''), ';;', ''),
          ';;'
        ) AS occupants
      FROM tools t
      LEFT JOIN tool_assignments a ON a.tool_id = t.id AND a.returned_at IS NULL
      LEFT JOIN employees e ON e.id = a.employee_id
      GROUP BY t.id
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

      db.get("SELECT status FROM tools WHERE id = ?", [id], (prevErr, prevRow) => {
      db.run(
        `UPDATE tools SET name = ?, category = ?, brand = ?, model = ?, serial_number = ?,
           inventory_number = ?, status = ?, purchase_date = ?, photo_url = ?, notes = ? WHERE id = ?`,
        [values.name, values.category, values.brand, values.model, values.serial_number,
         values.inventory_number, values.status, values.purchase_date, values.photo_url, values.notes, id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
          if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });
          if (!prevErr && prevRow && prevRow.status !== values.status) {
            logToolStatus(id, values.status, { changedBy: user.username, source: 'admin' });
          }
          logAction(user.username, `Обновлён инструмент id=${id}`);
          sendJson(res, 200, { success: true });
        }
      );
      }); // db.get prevRow
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

// Статус инструмента пересчитывается по числу оставшихся активных закреплений:
// есть хоть одно — 'assigned', ни одного — 'available' ('written_off'/'lost' не трогаем).
function recomputeToolStatus(toolId, cb) {
  db.get(
    "SELECT COUNT(*) AS c FROM tool_assignments WHERE tool_id = ? AND returned_at IS NULL",
    [toolId],
    (err, row) => {
      const newStatus = row && row.c > 0 ? 'assigned' : 'available';
      db.run("UPDATE tools SET status = ? WHERE id = ? AND status NOT IN ('written_off', 'lost')", [newStatus, toolId], () => cb && cb());
    }
  );
}

// ---- Выдать инструмент (/api/tools/issue) ----
// Инструмент можно выдать нескольким сотрудникам одновременно — блокируем
// только повторную выдачу одному и тому же сотруднику.
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
      if (tool.status === 'lost') {
        return sendJson(res, 400, { success: false, message: 'Инструмент числится утерянным — выдать нельзя' });
      }
      db.get(
        "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
        [toolId, employeeId],
        (err2, already) => {
          if (already) return sendJson(res, 409, { success: false, message: 'Этому сотруднику инструмент уже выдан' });

          db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (err3, emp) => {
            if (err3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

            db.run(
              "INSERT INTO tool_assignments (tool_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
              [toolId, employeeId, user.username, notes],
              function (err4) {
                if (err4) return sendJson(res, 500, { success: false, message: 'Ошибка выдачи' });
                const insertedId = this.lastID;
                recomputeToolStatus(toolId, () => {
                  logAction(user.username, `Выдан инструмент «${tool.name}» → ${emp.last_name} ${emp.first_name}`);
                  sendJson(res, 201, { success: true, id: insertedId });
                });
              }
            );
          });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Вернуть инструмент от конкретного сотрудника (/api/tools/return) ----
async function handleReturn(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!toolId || !employeeId) return sendJson(res, 400, { success: false, message: 'Нужно указать инструмент и сотрудника' });

    db.get(
      "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
      [toolId, employeeId],
      (err, open) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!open) return sendJson(res, 400, { success: false, message: 'У этого сотрудника нет данного инструмента' });

        db.run("UPDATE tool_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], function (err2) {
          if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка возврата' });
          recomputeToolStatus(toolId, () => {
            logAction(user.username, `Возвращён инструмент id=${toolId} от сотрудника id=${employeeId}`);
            sendJson(res, 200, { success: true });
          });
        });
      }
    );
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Заменить одного держателя другим (/api/tools/transfer) ----
// from_employee_id — у кого забираем, employee_id — кому выдаём взамен.
async function handleTransfer(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const fromEmployeeId = parseInt(body.from_employee_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!toolId || !fromEmployeeId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать инструмент, текущего и нового сотрудника' });
    }
    if (fromEmployeeId === employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нельзя передать инструмент тому же сотруднику' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name FROM tools WHERE id = ?", [toolId], (err, tool) => {
      if (err || !tool) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });

      db.get(
        "SELECT id FROM tool_assignments WHERE tool_id = ? AND employee_id = ? AND returned_at IS NULL",
        [toolId, fromEmployeeId],
        (e2, open) => {
          if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          if (!open) return sendJson(res, 400, { success: false, message: 'У этого сотрудника нет данного инструмента' });

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
                  const insertedId = this.lastID;
                  recomputeToolStatus(toolId, () => {
                    logAction(user.username, `Передан инструмент «${tool.name}» → ${emp.last_name} ${emp.first_name}`);
                    sendJson(res, 200, { success: true, id: insertedId });
                  });
                }
              );
            });
          });
        }
      );
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

// ---- Журнал смены статуса инструмента (/api/tools/status-log) ----
function handleStatusLog(req, res, user, parsedUrl) {
  const toolId = parseId(parsedUrl, 'tool_id');
  if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан tool_id' });
  db.all(
    "SELECT status, changed_by, source, request_id, requested_by_username, note, created_at FROM tool_status_log WHERE tool_id = ? ORDER BY id DESC",
    [toolId],
    (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, rows || []);
    }
  );
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

  // Переименование категории: новое имя распространяется на все места, где
  // категория используется по названию (инструменты, каталог, иконки) — чтобы
  // список категорий оставался единым и синхронным.
  if (method === 'PUT') {
    try {
      const id = parseId(parsedUrl);
      if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
      const body = await getJsonBody(req);
      const newName = (body.name || '').trim().slice(0, 100);
      if (newName.length < 2) return sendJson(res, 400, { success: false, message: 'Название категории слишком короткое' });

      db.get("SELECT name FROM tool_categories WHERE id = ?", [id], (err, row) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!row) return sendJson(res, 404, { success: false, message: 'Категория не найдена' });
        const oldName = row.name;
        if (oldName === newName) return sendJson(res, 200, { success: true, name: newName });

        db.run("UPDATE tool_categories SET name = ? WHERE id = ?", [newName, id], function (uErr) {
          if (uErr) {
            const msg = uErr.message.includes('UNIQUE') ? 'Такая категория уже есть' : 'Ошибка переименования';
            return sendJson(res, 400, { success: false, message: msg });
          }
          // Распространяем новое имя на все ссылки по названию.
          db.serialize(() => {
            db.run("UPDATE tools SET category = ? WHERE category = ?", [newName, oldName]);
            db.run("UPDATE catalog_models SET category = ? WHERE category = ?", [newName, oldName]);
            db.run("UPDATE category_icons SET category = ? WHERE category = ?", [newName, oldName], () => {
              logAction(user.username, `Категория переименована «${oldName}» → «${newName}»`);
              sendJson(res, 200, { success: true, name: newName });
            });
          });
        });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    db.get("SELECT name FROM tool_categories WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Категория не найдена' });
      const name = row.name;
      // Не удаляем категорию, пока она используется — иначе появятся «висячие»
      // категории у инструментов и моделей каталога.
      db.get(
        "SELECT (SELECT COUNT(*) FROM tools WHERE category = ?) + (SELECT COUNT(*) FROM catalog_models WHERE category = ?) AS c",
        [name, name],
        (e2, cnt) => {
          if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          const used = (cnt && cnt.c) || 0;
          if (used > 0) return sendJson(res, 409, { success: false, message: `Категория используется (${used}). Сначала переназначьте инструменты и модели каталога.` });
          db.serialize(() => {
            db.run("DELETE FROM tool_categories WHERE id = ?", [id]);
            db.run("DELETE FROM category_icons WHERE category = ?", [name], function (dErr) {
              if (dErr) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
              logAction(user.username, `Удалена категория инструмента «${name}»`);
              sendJson(res, 200, { success: true });
            });
          });
        }
      );
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// ---- Полная карточка инструмента (/api/tools/details?id=) ----
// Собирает инструмент + галерею фото + историю закреплений + статистику.
function handleDetails(req, res, user, parsedUrl) {
  const toolId = parseId(parsedUrl);
  if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан id' });

  const toolSql = `
    SELECT t.*,
      GROUP_CONCAT(
        a.id || '|' || a.employee_id || '|' || a.issued_at || '|' ||
        replace(replace(e.last_name || ' ' || e.first_name, '|', ''), ';;', ''),
        ';;'
      ) AS occupants
    FROM tools t
    LEFT JOIN tool_assignments a ON a.tool_id = t.id AND a.returned_at IS NULL
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE t.id = ?
    GROUP BY t.id`;

  db.get(toolSql, [toolId], (err, tool) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!tool) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });

    const photoSql = `
      SELECT tp.id, tp.photo_url, tp.created_at, u.username AS uploaded_by_name
      FROM tool_photos tp
      LEFT JOIN users u ON u.id = tp.uploaded_by
      WHERE tp.tool_id = ? ORDER BY tp.created_at DESC`;

    db.all(photoSql, [toolId], (e2, photos) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });

      const histSql = `
        SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
          CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
               ELSE '— (сотрудник удалён)' END AS employee_name,
          a.employee_id
        FROM tool_assignments a
        LEFT JOIN employees e ON e.id = a.employee_id
        WHERE a.tool_id = ? ORDER BY a.issued_at DESC`;

      db.all(histSql, [toolId], (e3, history) => {
        if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        history = history || [];

        // Статистика по использованию.
        const DAY = 1000 * 60 * 60 * 24;
        const holders = new Set();
        history.forEach(h => { if (h.employee_id) holders.add(h.employee_id); });

        // Дни в эксплуатации — от даты покупки (или от даты добавления в систему)
        // до настоящего времени.
        const baseRaw = tool.purchase_date || (tool.created_at ? String(tool.created_at).split(' ')[0] : null);
        let daysInService = 0;
        if (baseRaw && /^\d{4}-\d{2}-\d{2}/.test(baseRaw)) {
          const start = new Date(baseRaw.slice(0, 10) + 'T00:00:00Z').getTime();
          daysInService = Math.max(0, Math.round((Date.now() - start) / DAY));
        }

        const stats = {
          times_issued: history.length,
          days_in_service: daysInService,
          service_from: baseRaw ? baseRaw.slice(0, 10) : null,
          unique_holders: holders.size,
          photos_count: (photos || []).length,
          is_out: history.some(h => !h.returned_at)
        };

        sendJson(res, 200, { success: true, tool, photos: photos || [], history, stats });
      });
    });
  });
}

// ---- Галерея фото инструмента ----
// POST /api/tools/photo       — добавить фото в галерею (первое станет аватаром)
// POST /api/tools/set-avatar  — назначить аватаром фото ИЗ галереи этого инструмента

const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;

async function addToolPhoto(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const photoUrl = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан инструмент' });
    if (!UPLOAD_PATH_RE.test(photoUrl)) return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });

    db.get("SELECT id, name, photo_url FROM tools WHERE id = ?", [toolId], (err, tool) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!tool) return sendJson(res, 404, { success: false, message: 'Инструмент не найден' });

      db.run("INSERT INTO tool_photos (tool_id, photo_url, uploaded_by) VALUES (?, ?, ?)", [toolId, photoUrl, user.id], function (e2) {
        if (e2) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });

        // Первое фото инструмента автоматически становится аватаром.
        const isFirst = !tool.photo_url;
        const finish = () => {
          logAction(user.username, `Добавил фото к инструменту «${tool.name}»${isFirst ? ' (стало аватаром)' : ''}`);
          sendJson(res, 200, { success: true, photo_url: photoUrl, is_avatar: isFirst });
        };
        if (isFirst) db.run("UPDATE tools SET photo_url = ? WHERE id = ?", [photoUrl, toolId], finish);
        else finish();
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

async function setToolAvatar(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const photoUrl = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!toolId || !photoUrl) return sendJson(res, 400, { success: false, message: 'Не указаны данные' });

    // Аватаром можно назначить ТОЛЬКО фото из галереи этого инструмента.
    db.get("SELECT id FROM tool_photos WHERE tool_id = ? AND photo_url = ?", [toolId, photoUrl], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 400, { success: false, message: 'Это фото не из галереи инструмента' });

      db.run("UPDATE tools SET photo_url = ? WHERE id = ?", [photoUrl, toolId], function (e2) {
        if (e2) return sendJson(res, 500, { success: false, message: 'Не удалось обновить аватар' });
        logAction(user.username, `Сменил аватар инструмента id=${toolId}`);
        sendJson(res, 200, { success: true, photo_url: photoUrl });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

// ---- QR-код инструмента (/api/tools/qr?id=) ----
// Возвращает SVG, кодирующий ссылку на карточку инструмента (для наклейки).
function handleQr(req, res, user, parsedUrl) {
  const toolId = parseId(parsedUrl);
  if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан id' });

  const host = req.headers.host || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  // QR ведёт на ПУБЛИЧНУЮ карточку (без авторизации): любой, кто отсканирует
  // наклейку, увидит только данные для идентификации инструмента. Полная
  // карточка с историей и статистикой доступна админам через /admin/?tool=.
  const link = `${proto}://${host}/tool.html?id=${toolId}`;

  QRCode.toString(link, { type: 'svg', margin: 1, width: 220,
    color: { dark: '#111111', light: '#ffffff' } }, (err, svg) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка QR' });
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(svg);
  });
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
  if (pathname === '/api/tools/status-log' && method === 'GET') return handleStatusLog(req, res, user, parsedUrl);
  if (pathname === '/api/tools/details' && method === 'GET') return handleDetails(req, res, user, parsedUrl);
  if (pathname === '/api/tools/qr' && method === 'GET') return handleQr(req, res, user, parsedUrl);
  if (pathname === '/api/tools/photo' && method === 'POST') return addToolPhoto(req, res, user);
  if (pathname === '/api/tools/set-avatar' && method === 'POST') return setToolAvatar(req, res, user);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};

// Экспортируем вспомогалки для модуля заявлений (requests.js), чтобы
// одобрение заявления «Добавить инструмент» создавало инструмент по тем же
// правилам валидации и проверки дублей.
module.exports.extractToolFields = extractToolFields;
module.exports.findDuplicate = findDuplicate;
module.exports.duplicateMessage = duplicateMessage;
module.exports.logToolStatus = logToolStatus;
