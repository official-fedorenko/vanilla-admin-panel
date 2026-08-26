const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');

/**
 * Учёт строительных объектов + закрепление бригады сотрудников — та же
 * модель «выдача-возврат», что у инструмента, автопарка и недвижимости.
 *
 * Маршруты:
 *   GET/POST/PUT/DELETE /api/crud/construction-sites[?id=]        — CRUD объектов
 *   GET/POST/PUT/DELETE /api/crud/construction-site-categories     — справочник типов объектов
 *   POST                /api/construction-sites/issue              — направить сотрудника на объект (можно нескольких сразу)
 *   POST                /api/construction-sites/return              — снять конкретного сотрудника с объекта
 *   POST                /api/construction-sites/transfer             — заменить одного сотрудника другим
 *   GET                 /api/construction-sites/history?site_id=     — история закреплений бригады
 *
 * На объекте может одновременно работать несколько сотрудников —
 * construction_site_assignments может иметь больше одной активной
 * (returned_at IS NULL) строки на один объект.
 *
 * Права: чтение — любой авторизованный; изменения/направление/снятие — Admin/Superadmin.
 */

const ALLOWED_STATUSES = ['planning', 'active', 'paused', 'completed'];

function parseId(parsedUrl, key = 'id') {
  const id = parseInt(parsedUrl.searchParams.get(key), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canWrite(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

function extractSiteFields(body) {
  const name = (body.name || '').trim();
  if (name.length < 1) return { error: 'Название объекта обязательно' };

  const status = ALLOWED_STATUSES.includes(body.status) ? body.status : 'planning';
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const startDate = isDate(body.start_date) ? body.start_date : null;
  const endDate = isDate(body.end_date) ? body.end_date : null;

  const str = (v, max = 300) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, max) : null;
  };

  const budget = parseFloat(body.budget);
  const validBudget = Number.isFinite(budget) && budget >= 0 ? budget : null;

  const foremanId = parseInt(body.foreman_id, 10);
  const validForemanId = Number.isInteger(foremanId) && foremanId > 0 ? foremanId : null;

  const rawPhotoRaw = (body.photo_url == null ? '' : String(body.photo_url)).trim();
  const rawPhoto = rawPhotoRaw.split('?')[0].split('#')[0];
  const isUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto);
  const photoUrl = isUpload ? rawPhoto : null;

  return {
    values: {
      name: name.slice(0, 200),
      category: str(body.category),
      address: str(body.address, 400),
      customer: str(body.customer, 200),
      foreman_id: validForemanId,
      status,
      start_date: startDate,
      end_date: endDate,
      budget: validBudget,
      photo_url: photoUrl,
      notes: str(body.notes, 2000)
    }
  };
}

// ---- CRUD объектов (/api/crud/construction-sites) ----
async function handleCrud(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    // На объекте может работать несколько сотрудников одновременно —
    // агрегируем все активные (returned_at IS NULL) закрепления в один список
    // «crew» ('assignment_id|employee_id|issued_at|Фамилия Имя', разделитель ';;').
    const sql = `
      SELECT s.*,
        CASE WHEN fe.id IS NOT NULL THEN fe.last_name || ' ' || fe.first_name END AS foreman_name,
        GROUP_CONCAT(
          a.id || '|' || a.employee_id || '|' || a.issued_at || '|' ||
          replace(replace(e.last_name || ' ' || e.first_name, '|', ''), ';;', ''),
          ';;'
        ) AS crew
      FROM construction_sites s
      LEFT JOIN employees fe ON fe.id = s.foreman_id
      LEFT JOIN construction_site_assignments a ON a.site_id = s.id AND a.returned_at IS NULL
      LEFT JOIN employees e ON e.id = a.employee_id
      GROUP BY s.id
      ORDER BY s.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    db.all(sql, [limit, offset], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      db.get("SELECT COUNT(*) as count FROM construction_sites", [], (err2, countRow) => {
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
      const { error, values } = extractSiteFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });
      // Новый объект ещё ни за кем не закреплён — бригадира назначить нельзя.
      if (values.foreman_id) {
        return sendJson(res, 400, { success: false, message: 'Бригадиром может быть только сотрудник, направленный на этот объект' });
      }

      db.run(
        `INSERT INTO construction_sites (name, category, address, customer, foreman_id, status, start_date, end_date, budget, photo_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.name, values.category, values.address, values.customer, values.foreman_id, values.status,
         values.start_date, values.end_date, values.budget, values.photo_url, values.notes],
        function (err) {
          if (err) return sendJson(res, 500, { success: false, message: 'Ошибка создания объекта' });
          logAction(user.username, `Добавлен строительный объект «${values.name}»`);
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
      const { error, values } = extractSiteFields(body);
      if (error) return sendJson(res, 400, { success: false, message: error });

      const applyUpdate = () => {
        db.run(
          `UPDATE construction_sites SET name = ?, category = ?, address = ?, customer = ?, foreman_id = ?, status = ?,
             start_date = ?, end_date = ?, budget = ?, photo_url = ?, notes = ? WHERE id = ?`,
          [values.name, values.category, values.address, values.customer, values.foreman_id, values.status,
           values.start_date, values.end_date, values.budget, values.photo_url, values.notes, id],
          function (err) {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка обновления' });
            if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Объект не найден' });
            logAction(user.username, `Обновлён строительный объект id=${id}`);
            sendJson(res, 200, { success: true });
          }
        );
      };

      // Бригадиром может быть только тот, кто сейчас числится на объекте.
      if (values.foreman_id) {
        db.get(
          "SELECT id FROM construction_site_assignments WHERE site_id = ? AND employee_id = ? AND returned_at IS NULL",
          [id, values.foreman_id],
          (chkErr, row) => {
            if (chkErr) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            if (!row) return sendJson(res, 400, { success: false, message: 'Бригадиром может быть только сотрудник, направленный на этот объект' });
            applyUpdate();
          }
        );
      } else {
        applyUpdate();
      }
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
    }
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан корректный id' });
    db.run("DELETE FROM construction_site_assignments WHERE site_id = ?", [id], () => {
      db.run("DELETE FROM construction_sites WHERE id = ?", [id], function (err) {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
        if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Объект не найден' });
        logAction(user.username, `Удалён строительный объект id=${id}`);
        sendJson(res, 200, { success: true });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

// Статус объекта не пересчитывается автоматически (в отличие от квартир/авто/
// инструмента) — 'planning'/'active'/'paused'/'completed' отражают стадию
// проекта, а не занятость, и меняются администратором вручную.

// ---- Направить сотрудника на объект (/api/construction-sites/issue) ----
async function handleIssue(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const siteId = parseInt(body.site_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!siteId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать объект и сотрудника' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name, status FROM construction_sites WHERE id = ?", [siteId], (err, site) => {
      if (err || !site) return sendJson(res, 404, { success: false, message: 'Объект не найден' });
      if (site.status === 'completed') {
        return sendJson(res, 400, { success: false, message: 'Объект завершён — направить сотрудника нельзя' });
      }
      db.get(
        "SELECT id FROM construction_site_assignments WHERE site_id = ? AND employee_id = ? AND returned_at IS NULL",
        [siteId, employeeId],
        (err2, already) => {
          if (already) return sendJson(res, 409, { success: false, message: 'Этот сотрудник уже направлен на объект' });

          db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (err3, emp) => {
            if (err3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

            db.run(
              "INSERT INTO construction_site_assignments (site_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
              [siteId, employeeId, user.username, notes],
              function (err4) {
                if (err4) return sendJson(res, 500, { success: false, message: 'Ошибка направления' });
                logAction(user.username, `Сотрудник ${emp.last_name} ${emp.first_name} направлен на объект «${site.name}»`);
                sendJson(res, 201, { success: true, id: this.lastID });
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

// Бригадиром может быть только тот, кто сейчас числится на объекте — если
// снимаемый/заменяемый сотрудник был бригадиром, сбрасываем поле, вместо
// того чтобы оставлять «висячую» ссылку на человека, которого там уже нет.
function clearForemanIfMatches(siteId, employeeId, cb) {
  db.run(
    "UPDATE construction_sites SET foreman_id = NULL WHERE id = ? AND foreman_id = ?",
    [siteId, employeeId],
    () => cb && cb()
  );
}

// ---- Снять конкретного сотрудника с объекта (/api/construction-sites/return) ----
async function handleReturn(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const siteId = parseInt(body.site_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!siteId || !employeeId) return sendJson(res, 400, { success: false, message: 'Нужно указать объект и сотрудника' });

    db.get(
      "SELECT id FROM construction_site_assignments WHERE site_id = ? AND employee_id = ? AND returned_at IS NULL",
      [siteId, employeeId],
      (err, open) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!open) return sendJson(res, 400, { success: false, message: 'Этот сотрудник не направлен на объект' });

        db.run("UPDATE construction_site_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], function (err2) {
          if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка снятия' });
          clearForemanIfMatches(siteId, employeeId, () => {
            logAction(user.username, `Снят сотрудник id=${employeeId} с объекта id=${siteId}`);
            sendJson(res, 200, { success: true });
          });
        });
      }
    );
  } catch (e) {
    sendJson(res, 400, { success: false, message: e.message || 'Невалидный JSON' });
  }
}

// ---- Заменить одного сотрудника другим (/api/construction-sites/transfer) ----
// from_employee_id — кого снимаем, employee_id — кого направляем взамен.
async function handleTransfer(req, res, user) {
  if (!canWrite(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const siteId = parseInt(body.site_id, 10);
    const fromEmployeeId = parseInt(body.from_employee_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!siteId || !fromEmployeeId || !employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нужно указать объект, текущего и нового сотрудника' });
    }
    if (fromEmployeeId === employeeId) {
      return sendJson(res, 400, { success: false, message: 'Нельзя заменить сотрудника им же самим' });
    }
    const notes = (body.notes || '').toString().trim().slice(0, 300) || null;

    db.get("SELECT id, name FROM construction_sites WHERE id = ?", [siteId], (err, site) => {
      if (err || !site) return sendJson(res, 404, { success: false, message: 'Объект не найден' });

      db.get(
        "SELECT id FROM construction_site_assignments WHERE site_id = ? AND employee_id = ? AND returned_at IS NULL",
        [siteId, fromEmployeeId],
        (e2, open) => {
          if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          if (!open) return sendJson(res, 400, { success: false, message: 'Этот сотрудник не направлен на объект' });

          db.get("SELECT id, first_name, last_name FROM employees WHERE id = ?", [employeeId], (e3, emp) => {
            if (e3 || !emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });

            db.run("UPDATE construction_site_assignments SET returned_at = CURRENT_TIMESTAMP WHERE id = ?", [open.id], (e4) => {
              if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка замены' });
              db.run(
                "INSERT INTO construction_site_assignments (site_id, employee_id, issued_by, notes) VALUES (?, ?, ?, ?)",
                [siteId, employeeId, user.username, notes],
                function (e5) {
                  if (e5) return sendJson(res, 500, { success: false, message: 'Ошибка замены' });
                  clearForemanIfMatches(siteId, fromEmployeeId, () => {});
                  logAction(user.username, `На объекте «${site.name}» сотрудник заменён на ${emp.last_name} ${emp.first_name}`);
                  sendJson(res, 200, { success: true, id: this.lastID });
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

// ---- История закреплений бригады (/api/construction-sites/history) ----
function handleHistory(req, res, user, parsedUrl) {
  const siteId = parseId(parsedUrl, 'site_id');
  if (!siteId) return sendJson(res, 400, { success: false, message: 'Не указан site_id' });
  const sql = `
    SELECT a.id, a.issued_at, a.returned_at, a.issued_by, a.notes,
      CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name
           ELSE '— (сотрудник удалён)' END AS employee_name
    FROM construction_site_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.site_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [siteId], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    sendJson(res, 200, rows);
  });
}

// ---- Справочник типов объектов (/api/crud/construction-site-categories) ----
async function handleCategories(req, res, user, parsedUrl, method) {
  if (method === 'GET') {
    db.all("SELECT id, name, is_default FROM construction_site_categories ORDER BY name COLLATE NOCASE", [], (err, rows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, rows || []);
    });
    return;
  }

  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Управлять типами объектов может только Superadmin' });
  }

  if (method === 'POST') {
    try {
      const body = await getJsonBody(req);
      const name = (body.name || '').trim();
      if (name.length < 2) return sendJson(res, 400, { success: false, message: 'Название типа слишком короткое' });

      db.run("INSERT INTO construction_site_categories (name, is_default) VALUES (?, 0)", [name.slice(0, 100)], function (err) {
        if (err) {
          const msg = err.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка создания типа';
          return sendJson(res, 400, { success: false, message: msg });
        }
        logAction(user.username, `Добавлен тип объекта «${name}»`);
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

      db.get("SELECT name FROM construction_site_categories WHERE id = ?", [id], (err, row) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
        const oldName = row.name;
        if (oldName === newName) return sendJson(res, 200, { success: true, name: newName });

        db.run("UPDATE construction_site_categories SET name = ? WHERE id = ?", [newName, id], function (uErr) {
          if (uErr) {
            const msg = uErr.message.includes('UNIQUE') ? 'Такой тип уже есть' : 'Ошибка переименования';
            return sendJson(res, 400, { success: false, message: msg });
          }
          db.run("UPDATE construction_sites SET category = ? WHERE category = ?", [newName, oldName], () => {
            logAction(user.username, `Тип объекта переименован «${oldName}» → «${newName}»`);
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
    db.get("SELECT name, is_default FROM construction_site_categories WHERE id = ?", [id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 404, { success: false, message: 'Тип не найден' });
      if (row.is_default) return sendJson(res, 400, { success: false, message: 'Стандартный тип удалить нельзя' });
      db.run("UPDATE construction_sites SET category = NULL WHERE category = ?", [row.name], () => {
        db.run("DELETE FROM construction_site_categories WHERE id = ?", [id], (dErr) => {
          if (dErr) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
          logAction(user.username, `Удалён тип объекта «${row.name}»`);
          sendJson(res, 200, { success: true });
        });
      });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
}

module.exports = async function handleConstructionSites(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/crud/construction-site-categories')) return handleCategories(req, res, user, parsedUrl, method);
  if (pathname.startsWith('/api/crud/construction-sites')) return handleCrud(req, res, user, parsedUrl, method);
  if (pathname === '/api/construction-sites/issue' && method === 'POST') return handleIssue(req, res, user);
  if (pathname === '/api/construction-sites/return' && method === 'POST') return handleReturn(req, res, user);
  if (pathname === '/api/construction-sites/transfer' && method === 'POST') return handleTransfer(req, res, user);
  if (pathname === '/api/construction-sites/history' && method === 'GET') return handleHistory(req, res, user, parsedUrl);

  return sendJson(res, 404, { success: false, message: 'Construction sites endpoint не найден' });
};
