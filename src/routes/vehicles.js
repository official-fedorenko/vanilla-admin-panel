const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');
const QRCode = require('qrcode');

/**
 * Учёт автопарка + закрепление транспорта за сотрудниками (модель «выдача-возврат»).
 * Реализовано по тому же принципу, что и учёт инструмента (см. tools.js).
 *
 * Маршруты:
 *   GET/POST/PUT/DELETE /api/crud/vehicles[?id=]        — CRUD автопарка
 *   GET/POST/PUT/DELETE /api/crud/vehicle-categories     — справочник типов транспорта
 *   POST                /api/vehicles/issue              — выдать авто сотруднику
 *   POST                /api/vehicles/return             — принять авто назад
 *   POST                /api/vehicles/transfer            — передать другому сотруднику
 *   GET                 /api/vehicles/check-dup           — проверка дублей гос.номера/VIN
 *   GET                 /api/vehicles/history?vehicle_id=  — история закреплений
 *   GET                 /api/vehicles/details?id=          — карточка авто (фото+история+статистика)
 *   GET                 /api/vehicles/qr?id=                — QR на публичную карточку
 *   POST                /api/vehicles/photo                 — добавить фото в галерею
 *   POST                /api/vehicles/set-avatar             — назначить аватар из галереи
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

const DUP_FIELD_LABEL = { plate_number: 'гос. номером', vin: 'VIN' };

// Ищет авто с таким же гос.номером/VIN (без учёта регистра), исключая сам
// редактируемый автомобиль. cb(err, conflict|null),
// conflict = { field, value, vehicle: {id, name} }. Пустые значения пропускаются.
function findDuplicate(values, excludeId, cb) {
  const checks = [];
  if (values.plate_number) checks.push(['plate_number', values.plate_number]);
  if (values.vin) checks.push(['vin', values.vin]);
  if (!checks.length) return cb(null, null);

  let i = 0;
  const next = () => {
    if (i >= checks.length) return cb(null, null);
    const [field, val] = checks[i++];
    db.get(
      `SELECT id, name FROM vehicles WHERE ${field} = ? COLLATE NOCASE AND id != ?`,
      [val, excludeId || -1],
      (err, row) => {
        if (err) return cb(err);
        if (row) return cb(null, { field, value: val, vehicle: row });
        next();
      }
    );
  };
  next();
}

function duplicateMessage(conflict) {
  return `Авто с ${DUP_FIELD_LABEL[conflict.field]} «${conflict.value}» уже есть: «${conflict.vehicle.name}» (ID ${conflict.vehicle.id})`;
}

function extractVehicleFields(body) {
  // Поле «Название/обозначение» убрано из формы — генерируем его сами из
  // марки/модели (или гос.номера, если их нет), чтобы поиск/списки/детальная
  // карточка, завязанные на name, продолжали работать без правок.
  const bodyName = (body.name || '').trim();
  const brandModel = [body.brand, body.model].filter(v => (v || '').trim()).map(v => v.trim()).join(' ');
  const name = bodyName || brandModel || (body.plate_number || '').trim() || 'Авто';

  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'available';
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const purchaseDate = isDate(body.purchase_date) ? body.purchase_date : null;
  const insuranceUntil = isDate(body.insurance_until) ? body.insurance_until : null;
  const inspectionUntil = isDate(body.inspection_until) ? body.inspection_until : null;

  const str = (v, max = 300) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, max) : null;
  };

  const year = parseInt(body.year, 10);
  const validYear = Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
  const mileage = parseInt(body.mileage, 10);
  const validMileage = Number.isInteger(mileage) && mileage >= 0 ? mileage : null;

  // photo_url принимаем только как внутренний путь (загруженный файл),
  // защита от подстановки внешних/произвольных URL.
  const rawPhotoRaw = (body.photo_url == null ? '' : String(body.photo_url)).trim();
  const rawPhoto = rawPhotoRaw.split('?')[0].split('#')[0];
  const isUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto);
  const photoUrl = isUpload ? rawPhoto : null;

  return {
    values: {
      name: name.slice(0, 200),
      category: str(body.category),
      brand: str(body.brand),
      model: str(body.model),
      year: validYear,
      plate_number: str(body.plate_number, 20),
      vin: str(body.vin, 32),
      fuel_type: str(body.fuel_type, 40),
      mileage: validMileage,
      status,
      purchase_date: purchaseDate,
      insurance_until: insuranceUntil,
      inspection_until: inspectionUntil,
      photo_url: photoUrl,
      notes: str(body.notes, 2000)
    }
  };
}

// ---- CRUD автопарка (/api/crud/vehicles) ----
async function handleCrud(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    const sql = `
      SELECT v.*,
        a.employee_id AS current_employee_id,
        a.issued_at   AS current_issued_at,
        CASE WHEN e.id IS NOT NULL
             THEN e.last_name || ' ' || e.first_name END AS current_holder
      FROM vehicles v
      LEFT JOIN vehicle_assignments a ON a.vehicle_id = v.id AND a.returned_at IS NULL
      LEFT JOIN employees e ON e.id = a.employee_id
      ORDER BY v.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM vehicles", [], (err2, countRow) => {
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
      const { error, values } = extractVehicleFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      findDuplicate(values, null, (dupErr, conflict) => {
        if (dupErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (conflict) return sendJson(res, 409, { success: false, message: duplicateMessage(conflict) });

        db.run(
          `INSERT INTO vehicles (name, category, brand, model, year, plate_number, vin, fuel_type, mileage,
             status, purchase_date, insurance_until, inspection_until, photo_url, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [values.name, values.category, values.brand, values.model, values.year, values.plate_number,
           values.vin, values.fuel_type, values.mileage, values.status, values.purchase_date,
           values.insurance_until, values.inspection_until, values.photo_url, values.notes],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка создания авто' });
            logAction(user.username, `Добавлено авто «${values.name}»`);
            sendJson(res, 201, { success: true, id: this.lastID });
          }
        );
      });
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
      const { error, values } = extractVehicleFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      findDuplicate(values, id, (dupErr, conflict) => {
        if (dupErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (conflict) return sendJson(res, 409, { success: false, message: duplicateMessage(conflict) });

        db.run(
          `UPDATE vehicles SET name = ?, category = ?, brand = ?, model = ?, year = ?, plate_number = ?,
             vin = ?, fuel_type = ?, mileage = ?, status = ?, purchase_date = ?, insurance_until = ?,
             inspection_until = ?, photo_url = ?, notes = ? WHERE id = ?`,
          [values.name, values.category, values.brand, values.model, values.year, values.plate_number,
           values.vin, values.fuel_type, values.mileage, values.status, values.purchase_date,
           values.insurance_until, values.inspection_until, values.photo_url, values.notes, id],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
            if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });
            logAction(user.username, `Обновлено авто id=${id}`);
            sendJson(res, 200, { success: true });
          }
        );
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    db.run("DELETE FROM vehicle_assignments WHERE vehicle_id = ?", [id], () => {
      db.run("DELETE FROM vehicle_photos WHERE vehicle_id = ?", [id], () => {
        db.run("DELETE FROM vehicles WHERE id = ?", [id], function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
          if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });
          logAction(user.username, `Удалено авто id=${id}`);
          sendJson(res, 200, { success: true });
        });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// ---- Выдать авто (/api/vehicles/issue) ----
async function handleIssue(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!vehicleId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать авто и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name, status FROM vehicles WHERE id = ?", [vehicleId], (err, vehicle) => {
      if (err || !vehicle) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });
      if (vehicle.status === 'written_off') {
        return sendJson(res, 400, { success: false, message: 'Авто списано — выдать нельзя' });
      }
      db.get("SELECT id FROM vehicle_assignments WHERE vehicle_id = ? AND returned_at IS NULL", [vehicleId], (err2, open) => {
        if (open) return sendJson(res, 409, { success: false, message: 'Авто уже выдано — сначала верните его' });

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (err3, emp) => {
          if (err3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          db.run(
            "INSERT INTO vehicle_assignments (vehicle_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
            [vehicleId, employeeId, user.username, notes],
            function (err4) {
              if (err4) return sendJson(res, 500, { success: false, message: 'Ошибка выдачи' });
              db.run("UPDATE vehicles SET status = 'assigned' WHERE id = ?", [vehicleId]);
              logAction(user.username, `Выдано авто «${vehicle.name}» → ${emp.last_name} ${emp.first_name}`);
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

// ---- Вернуть авто (/api/vehicles/return) ----
async function handleReturn(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указано авто' });

    db.get("SELECT id FROM vehicle_assignments WHERE vehicle_id = ? AND returned_at IS NULL", [vehicleId], (err, open) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!open) return sendJson(res, 400, { success: false, message: 'Авто и так на стоянке' });

      db.run("UPDATE vehicle_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], function (err2) {
        if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка возврата' });
        db.run("UPDATE vehicles SET status = 'available' WHERE id = ?", [vehicleId]);
        logAction(user.username, `Возвращено авто id=${vehicleId}`);
        sendJson(res, 200, { success: true });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Передать авто другому сотруднику (/api/vehicles/transfer) ----
async function handleTransfer(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!vehicleId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать авто и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name FROM vehicles WHERE id = ?", [vehicleId], (err, vehicle) => {
      if (err || !vehicle) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });

      db.get("SELECT id, employee_id FROM vehicle_assignments WHERE vehicle_id = ? AND returned_at IS NULL", [vehicleId], (e2, open) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!open) return sendJson(res, 400, { success: false, message: 'Авто на стоянке — используйте выдачу' });
        if (open.employee_id === employeeId) {
          return sendJson(res, 400, { success: false, message: 'Авто уже закреплено за этим сотрудником' });
        }

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (e3, emp) => {
          if (e3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          db.run("UPDATE vehicle_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e4) => {
            if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
            db.run(
              "INSERT INTO vehicle_assignments (vehicle_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
              [vehicleId, employeeId, user.username, notes],
              function (e5) {
                if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
                db.run("UPDATE vehicles SET status = 'assigned' WHERE id = ?", [vehicleId]);
                logAction(user.username, `Передано авто «${vehicle.name}» → ${emp.last_name} ${emp.first_name}`);
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

// ---- Проверка дублей в реальном времени (/api/vehicles/check-dup) ----
function handleCheckDup(req, res, user, parsedUrl) {
  const plate = (parsedUrl.searchParams.get('plate') || '').trim();
  const vin = (parsedUrl.searchParams.get('vin') || '').trim();
  const excludeId = parseInt(parsedUrl.searchParams.get('exclude_id'), 10) || -1;

  const lookup = (field, val, cb) => {
    if (!val) return cb(null);
    db.get(`SELECT id, name FROM vehicles WHERE ${field} = ? COLLATE NOCASE AND id != ?`, [val, excludeId], (err, row) => {
      cb(err ? null : (row || null));
    });
  };

  lookup('plate_number', plate, (plateHit) => {
    lookup('vin', vin, (vinHit) => {
      sendJson(res, 200, { success: true, plate: plateHit, vin: vinHit });
    });
  });
}

// ---- История закреплений авто (/api/vehicles/history) ----
function handleHistory(req, res, user, parsedUrl) {
  const vehicleId = parseId(parsedUrl, 'vehicle_id');
  if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указан vehicle_id' });
  const sql = `
    SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
      CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
           ELSE '— (сотрудник удалён)' END AS employee_name
    FROM vehicle_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.vehicle_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [vehicleId], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

// ---- Справочник типов транспорта (/api/crud/vehicle-categories) ----
async function handleCategories(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    db.all("SELECT id, name, is_default FROM vehicle_categories ORDER BY name COLLATE NOCASE", [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, rows || []);
    });
    return;
  }

  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Управлять типами транспорта может только Superadmin' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const name = (body.name || '').trim();
      if (name.length < 2) return sendJson(res, 400, { success: false, message: 'Название типа слишком короткое' });

      db.run("INSERT INTO vehicle_categories (name, is_default) VALUES (?, 0)", [name.slice(0, 100)], function (err) {
        if (err) {
          const msg = err.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка создания типа';
          return sendJson(res, 400, { success: false, message: msg });
        }
        logAction(user.username, `Добавлен тип транспорта «${name}»`);
        sendJson(res, 201, { success: true, id: this.lastID, name });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  if (method === 'PUT') {
    try {
      const id = parseId(parsedUrl);
      if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
      const body = await getJsonBody(req);
      const newName = (body.name || '').trim().slice(0, 100);
      if (newName.length < 2) return sendJson(res, 400, { success: false, message: 'Название типа слишком короткое' });

      db.get("SELECT name FROM vehicle_categories WHERE id = ?", [id], (err, row) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
        const oldName = row.name;
        if (oldName === newName) return sendJson(res, 200, { success: true, name: newName });

        db.run("UPDATE vehicle_categories SET name = ? WHERE id = ?", [newName, id], function (uErr) {
          if (uErr) {
            const msg = uErr.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка переименования';
            return sendJson(res, 400, { success: false, message: msg });
          }
          db.run("UPDATE vehicles SET category = ? WHERE category = ?", [newName, oldName], () => {
            logAction(user.username, `Тип транспорта переименован «${oldName}» → «${newName}»`);
            sendJson(res, 200, { success: true, name: newName });
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
    db.get("SELECT name FROM vehicle_categories WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
      const name = row.name;
      db.get("SELECT COUNT(*) AS c FROM vehicles WHERE category = ?", [name], (e2, cnt) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        const used = (cnt && cnt.c) || 0;
        if (used > 0) return sendJson(res, 409, { success: false, message: `Тип используется (${used}). Сначала переназначьте авто.` });
        db.run("DELETE FROM vehicle_categories WHERE id = ?", [id], function (dErr) {
          if (dErr) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
          logAction(user.username, `Удалён тип транспорта «${name}»`);
          sendJson(res, 200, { success: true });
        });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// ---- Полная карточка авто (/api/vehicles/details?id=) ----
function handleDetails(req, res, user, parsedUrl) {
  const vehicleId = parseId(parsedUrl);
  if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указан id' });

  const sql = `
    SELECT v.*,
      a.issued_at AS current_issued_at,
      CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name END AS current_holder
    FROM vehicles v
    LEFT JOIN vehicle_assignments a ON a.vehicle_id = v.id AND a.returned_at IS NULL
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE v.id = ?`;

  db.get(sql, [vehicleId], (err, vehicle) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!vehicle) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });

    const photoSql = `
      SELECT vp.id, vp.photo_url, vp.created_at, u.username AS uploaded_by_name
      FROM vehicle_photos vp
      LEFT JOIN users u ON u.id = vp.uploaded_by
      WHERE vp.vehicle_id = ? ORDER BY vp.created_at DESC`;

    db.all(photoSql, [vehicleId], (e2, photos) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });

      const histSql = `
        SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
          CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
               ELSE '— (сотрудник удалён)' END AS employee_name,
          a.employee_id
        FROM vehicle_assignments a
        LEFT JOIN employees e ON e.id = a.employee_id
        WHERE a.vehicle_id = ? ORDER BY a.issued_at DESC`;

      db.all(histSql, [vehicleId], (e3, history) => {
        if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        history = history || [];

        const DAY = 1000 * 60 * 60 * 24;
        const holders = new Set();
        history.forEach(h => { if (h.employee_id) holders.add(h.employee_id); });

        const baseRaw = vehicle.purchase_date || (vehicle.created_at ? String(vehicle.created_at).split(' ')[0] : null);
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

        sendJson(res, 200, { success: true, vehicle, photos: photos || [], history, stats });
      });
    });
  });
}

// ---- Галерея фото авто ----
const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;

async function addVehiclePhoto(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    const photoUrl = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указано авто' });
    if (!UPLOAD_PATH_RE.test(photoUrl)) return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });

    db.get("SELECT id, name, photo_url FROM vehicles WHERE id = ?", [vehicleId], (err, vehicle) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!vehicle) return sendJson(res, 404, { success: false, message: 'Авто не найдено' });

      db.run("INSERT INTO vehicle_photos (vehicle_id, photo_url, uploaded_by) VALUES (?, ?, ?)", [vehicleId, photoUrl, user.id], function (e2) {
        if (e2) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });

        const isFirst = !vehicle.photo_url;
        const finish = () => {
          logAction(user.username, `Добавил фото к авто «${vehicle.name}»${isFirst ? ' (стало аватаром)' : ''}`);
          sendJson(res, 200, { success: true, photo_url: photoUrl, is_avatar: isFirst });
        };
        if (isFirst) db.run("UPDATE vehicles SET photo_url = ? WHERE id = ?", [photoUrl, vehicleId], finish);
        else finish();
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

async function setVehicleAvatar(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    const photoUrl = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!vehicleId || !photoUrl) return sendJson(res, 400, { success: false, message: 'Не указаны данные' });

    db.get("SELECT id FROM vehicle_photos WHERE vehicle_id = ? AND photo_url = ?", [vehicleId, photoUrl], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 400, { success: false, message: 'Это фото не из галереи авто' });

      db.run("UPDATE vehicles SET photo_url = ? WHERE id = ?", [photoUrl, vehicleId], function (e2) {
        if (e2) return sendJson(res, 500, { success: false, message: 'Не удалось обновить аватар' });
        logAction(user.username, `Сменил аватар авто id=${vehicleId}`);
        sendJson(res, 200, { success: true, photo_url: photoUrl });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

// ---- QR-код авто (/api/vehicles/qr?id=) ----
function handleQr(req, res, user, parsedUrl) {
  const vehicleId = parseId(parsedUrl);
  if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указан id' });

  const host = req.headers.host || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const link = `${proto}://${host}/vehicle.html?id=${vehicleId}`;

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

module.exports = async function handleVehicles(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/crud/vehicle-categories')) return handleCategories(req, res, user, parsedUrl, method);
  if (pathname.startsWith('/api/crud/vehicles')) return handleCrud(req, res, user, parsedUrl, method);
  if (pathname === '/api/vehicles/issue' && method === 'POST') return handleIssue(req, res, user);
  if (pathname === '/api/vehicles/return' && method === 'POST') return handleReturn(req, res, user);
  if (pathname === '/api/vehicles/transfer' && method === 'POST') return handleTransfer(req, res, user);
  if (pathname === '/api/vehicles/check-dup' && method === 'GET') return handleCheckDup(req, res, user, parsedUrl);
  if (pathname === '/api/vehicles/history' && method === 'GET') return handleHistory(req, res, user, parsedUrl);
  if (pathname === '/api/vehicles/details' && method === 'GET') return handleDetails(req, res, user, parsedUrl);
  if (pathname === '/api/vehicles/qr' && method === 'GET') return handleQr(req, res, user, parsedUrl);
  if (pathname === '/api/vehicles/photo' && method === 'POST') return addVehiclePhoto(req, res, user);
  if (pathname === '/api/vehicles/set-avatar' && method === 'POST') return setVehicleAvatar(req, res, user);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
