const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');

/**
 * Учёт квартир (жильё компании) + закрепление за сотрудниками — та же модель
 * «выдача-возврат», что у инструмента (tools.js) и автопарка (vehicles.js).
 *
 * Маршруты:
 *   GET/POST/PUT/DELETE /api/crud/apartments[?id=]        — CRUD квартир
 *   GET/POST/PUT/DELETE /api/crud/apartment-categories     — справочник типов квартир
 *   POST                /api/apartments/issue              — закрепить за сотрудником
 *   POST                /api/apartments/return              — освободить
 *   POST                /api/apartments/transfer             — передать другому сотруднику
 *   GET                 /api/apartments/history?apartment_id= — история закреплений
 *
 * Права: чтение — любой авторизованный; изменения/выдача/возврат — Admin/Superadmin.
 */

const ALLOWED_STATUSES = ['available', 'occupied', 'repair', 'written_off'];

function parseId(parsedUrl, key = 'id') {
  const id = parseInt(parsedUrl.searchParams.get(key), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canWrite(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

function extractApartmentFields(body) {
  const name = (body.name || '').trim();
  if (name.length < 1) return { error: 'Название/адрес квартиры обязательно' };

  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'available';
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const rentUntil = isDate(body.rent_until) ? body.rent_until : null;

  const str = (v, max = 300) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, max) : null;
  };

  const rooms = parseInt(body.rooms, 10);
  const validRooms = Number.isInteger(rooms) && rooms >= 0 ? rooms : null;
  const area = parseFloat(body.area);
  const validArea = Number.isFinite(area) && area >= 0 ? area : null;

  const rawPhotoRaw = (body.photo_url == null ? '' : String(body.photo_url)).trim();
  const rawPhoto = rawPhotoRaw.split('?')[0].split('#')[0];
  const isUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto);
  const photoUrl = isUpload ? rawPhoto : null;

  return {
    values: {
      name: name.slice(0, 200),
      category: str(body.category),
      address: str(body.address, 400),
      rooms: validRooms,
      area: validArea,
      status,
      rent_until: rentUntil,
      photo_url: photoUrl,
      notes: str(body.notes, 2000)
    }
  };
}

// ---- CRUD квартир (/api/crud/apartments) ----
async function handleCrud(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    const sql = `
      SELECT a.*,
        asn.employee_id AS current_employee_id,
        asn.issued_at   AS current_issued_at,
        CASE WHEN e.id IS NOT NULL
             THEN e.last_name || ' ' || e.first_name END AS current_holder
      FROM apartments a
      LEFT JOIN apartment_assignments asn ON asn.apartment_id = a.id AND asn.returned_at IS NULL
      LEFT JOIN employees e ON e.id = asn.employee_id
      ORDER BY a.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM apartments", [], (err2, countRow) => {
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
      const { error, values } = extractApartmentFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      db.run(
        `INSERT INTO apartments (name, category, address, rooms, area, status, rent_until, photo_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.name, values.category, values.address, values.rooms, values.area,
         values.status, values.rent_until, values.photo_url, values.notes],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка создания квартиры' });
          logAction(user.username, `Добавлена квартира «${values.name}»`);
          sendJson(res, 201, { success: true, id: this.lastID });
        }
      );
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
      const { error, values } = extractApartmentFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      db.run(
        `UPDATE apartments SET name = ?, category = ?, address = ?, rooms = ?, area = ?,
           status = ?, rent_until = ?, photo_url = ?, notes = ? WHERE id = ?`,
        [values.name, values.category, values.address, values.rooms, values.area,
         values.status, values.rent_until, values.photo_url, values.notes, id],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
          if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Квартира не найдена' });
          logAction(user.username, `Обновлена квартира id=${id}`);
          sendJson(res, 200, { success: true });
        }
      );
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    db.run("DELETE FROM apartment_assignments WHERE apartment_id = ?", [id], () => {
      db.run("DELETE FROM apartments WHERE id = ?", [id], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
        if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Квартира не найдена' });
        logAction(user.username, `Удалена квартира id=${id}`);
        sendJson(res, 200, { success: true });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// ---- Закрепить квартиру за сотрудником (/api/apartments/issue) ----
async function handleIssue(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const apartmentId = parseInt(body.apartment_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!apartmentId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать квартиру и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name, status FROM apartments WHERE id = ?", [apartmentId], (err, apartment) => {
      if (err || !apartment) return sendJson(res, 404, { success: false, message: 'Квартира не найдена' });
      if (apartment.status === 'written_off') {
        return sendJson(res, 400, { success: false, message: 'Квартира списана — закрепить нельзя' });
      }
      db.get("SELECT id FROM apartment_assignments WHERE apartment_id = ? AND returned_at IS NULL", [apartmentId], (err2, open) => {
        if (open) return sendJson(res, 409, { success: false, message: 'Квартира уже занята — сначала освободите её' });

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (err3, emp) => {
          if (err3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          db.run(
            "INSERT INTO apartment_assignments (apartment_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
            [apartmentId, employeeId, user.username, notes],
            function (err4) {
              if (err4) return sendJson(res, 500, { success: false, message: 'Ошибка закрепления' });
              db.run("UPDATE apartments SET status = 'occupied' WHERE id = ?", [apartmentId]);
              logAction(user.username, `Квартира «${apartment.name}» закреплена за ${emp.last_name} ${emp.first_name}`);
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

// ---- Освободить квартиру (/api/apartments/return) ----
async function handleReturn(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const apartmentId = parseInt(body.apartment_id, 10);
    if (!apartmentId) return sendJson(res, 400, { success: false, message: 'Не указана квартира' });

    db.get("SELECT id FROM apartment_assignments WHERE apartment_id = ? AND returned_at IS NULL", [apartmentId], (err, open) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!open) return sendJson(res, 400, { success: false, message: 'Квартира и так свободна' });

      db.run("UPDATE apartment_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], function (err2) {
        if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка освобождения' });
        db.run("UPDATE apartments SET status = 'available' WHERE id = ?", [apartmentId]);
        logAction(user.username, `Освобождена квартира id=${apartmentId}`);
        sendJson(res, 200, { success: true });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Передать квартиру другому сотруднику (/api/apartments/transfer) ----
async function handleTransfer(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const apartmentId = parseInt(body.apartment_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!apartmentId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать квартиру и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name FROM apartments WHERE id = ?", [apartmentId], (err, apartment) => {
      if (err || !apartment) return sendJson(res, 404, { success: false, message: 'Квартира не найдена' });

      db.get("SELECT id, employee_id FROM apartment_assignments WHERE apartment_id = ? AND returned_at IS NULL", [apartmentId], (e2, open) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!open) return sendJson(res, 400, { success: false, message: 'Квартира свободна — используйте закрепление' });
        if (open.employee_id === employeeId) {
          return sendJson(res, 400, { success: false, message: 'Квартира уже закреплена за этим сотрудником' });
        }

        db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (e3, emp) => {
          if (e3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

          db.run("UPDATE apartment_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e4) => {
            if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
            db.run(
              "INSERT INTO apartment_assignments (apartment_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
              [apartmentId, employeeId, user.username, notes],
              function (e5) {
                if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка передачи' });
                db.run("UPDATE apartments SET status = 'occupied' WHERE id = ?", [apartmentId]);
                logAction(user.username, `Квартира «${apartment.name}» передана ${emp.last_name} ${emp.first_name}`);
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

// ---- История закреплений квартиры (/api/apartments/history) ----
function handleHistory(req, res, user, parsedUrl) {
  const apartmentId = parseId(parsedUrl, 'apartment_id');
  if (!apartmentId) return sendJson(res, 400, { success: false, message: 'Не указан apartment_id' });
  const sql = `
    SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
      CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
           ELSE '— (сотрудник удалён)' END AS employee_name
    FROM apartment_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.apartment_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [apartmentId], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

// ---- Справочник типов квартир (/api/crud/apartment-categories) ----
async function handleCategories(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    db.all("SELECT id, name, is_default FROM apartment_categories ORDER BY name COLLATE NOCASE", [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, rows || []);
    });
    return;
  }

  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Управлять типами квартир может только Superadmin' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const name = (body.name || '').trim();
      if (name.length < 2) return sendJson(res, 400, { success: false, message: 'Название типа слишком короткое' });

      db.run("INSERT INTO apartment_categories (name, is_default) VALUES (?, 0)", [name.slice(0, 100)], function (err) {
        if (err) {
          const msg = err.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка создания типа';
          return sendJson(res, 400, { success: false, message: msg });
        }
        logAction(user.username, `Добавлен тип квартиры «${name}»`);
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

      db.get("SELECT name FROM apartment_categories WHERE id = ?", [id], (err, row) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
        const oldName = row.name;
        if (oldName === newName) return sendJson(res, 200, { success: true, name: newName });

        db.run("UPDATE apartment_categories SET name = ? WHERE id = ?", [newName, id], function (uErr) {
          if (uErr) {
            const msg = uErr.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка переименования';
            return sendJson(res, 400, { success: false, message: msg });
          }
          db.run("UPDATE apartments SET category = ? WHERE category = ?", [newName, oldName], () => {
            logAction(user.username, `Тип квартиры переименован «${oldName}» → «${newName}»`);
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
    db.get("SELECT name, is_default FROM apartment_categories WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
      if (row.is_default) return sendJson(res, 400, { success: false, message: 'Стандартный тип удалить нельзя' });
      db.run("UPDATE apartments SET category = NULL WHERE category = ?", [row.name], () => {
        db.run("DELETE FROM apartment_categories WHERE id = ?", [id], (dErr) => {
          if (dErr) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
          logAction(user.username, `Удалён тип квартиры «${row.name}»`);
          sendJson(res, 200, { success: true });
        });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

module.exports = async function handleApartments(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/crud/apartment-categories')) return handleCategories(req, res, user, parsedUrl, method);
  if (pathname.startsWith('/api/crud/apartments')) return handleCrud(req, res, user, parsedUrl, method);
  if (pathname === '/api/apartments/issue' && method === 'POST') return handleIssue(req, res, user);
  if (pathname === '/api/apartments/return' && method === 'POST') return handleReturn(req, res, user);
  if (pathname === '/api/apartments/transfer' && method === 'POST') return handleTransfer(req, res, user);
  if (pathname === '/api/apartments/history' && method === 'GET') return handleHistory(req, res, user, parsedUrl);

  return sendJson(res, 404, { success: false, message: 'Apartments endpoint не найден' });
};
