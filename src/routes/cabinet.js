const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, verifyPassword, hashPassword } = require('../../db');

function getMe(req, res, user) {
  db.get("SELECT id, username, email, role, account_type, avatar_url, created_at FROM users WHERE id = ?", [user.id], (err, row) => {
    if (err || !row) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
    sendJson(res, 200, { success: true, user: row });
  });
}

// Карточка сотрудника, привязанная к текущему аккаунту (read-only для
// самого сотрудника — редактирование пока только из админки). У клиентов
// без карточки вернётся card: null.
function getMyCard(req, res, user) {
  db.get(
    `SELECT id, first_name, last_name, position, department, phone, email,
            hire_date, status, notes, photo_url, created_at
     FROM employees WHERE user_id = ?`,
    [user.id],
    (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      sendJson(res, 200, { success: true, card: row || null });
    }
  );
}

// Сотрудник загружает своё фото в собственную карточку (файл заранее
// загружен через /api/media, сюда приходит готовый внутренний URL).
async function setMyEmployeePhoto(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const rawPhoto = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto)) {
      return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });
    }
    db.run("UPDATE employees SET photo_url = ? WHERE user_id = ?", [rawPhoto, user.id], function (err) {
      if (err) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });
      if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'У вас нет карточки сотрудника' });
      logAction(user.username, 'Обновил фото своей карточки сотрудника');
      sendJson(res, 200, { success: true, photo_url: rawPhoto });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// Инструмент, закреплённый за сотрудником, привязанным к текущему аккаунту.
// Клиенты (без карточки в employees) просто получают пустой список.
function getMyTools(req, res, user) {
  const sql = `
    SELECT t.id, t.name, t.category, t.brand, t.model, t.serial_number, t.inventory_number,
           t.photo_url, a.issued_at
    FROM employees e
    JOIN tool_assignments a ON a.employee_id = e.id AND a.returned_at IS NULL
    JOIN tools t ON t.id = a.tool_id
    WHERE e.user_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [user.id], (err, tools) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!tools || tools.length === 0) {
      return sendJson(res, 200, { success: true, tools: [] });
    }

    const toolIds = tools.map(t => t.id);
    const placeholders = toolIds.map(() => '?').join(',');
    const photoSql = `SELECT tool_id, photo_url FROM tool_photos WHERE tool_id IN (${placeholders}) ORDER BY created_at ASC`;
    db.all(photoSql, toolIds, (err2, photos) => {
      if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка загрузки фото галереи' });
      
      const photosByTool = {};
      (photos || []).forEach(p => {
        if (!photosByTool[p.tool_id]) photosByTool[p.tool_id] = [];
        photosByTool[p.tool_id].push(p.photo_url);
      });

      tools.forEach(t => {
        t.gallery_photos = photosByTool[t.id] || [];
      });

      sendJson(res, 200, { success: true, tools: tools });
    });
  });
}

// Сотрудник добавляет фото в галерею ТОЛЬКО у инструмента, который сейчас на нём.
// Файл заранее загружается через /api/media, сюда приходит уже готовый URL.
async function setToolPhoto(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const toolId = parseInt(body.tool_id, 10);
    const rawPhoto = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!toolId) return sendJson(res, 400, { success: false, message: 'Не указан инструмент' });
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto)) {
      return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });
    }

    // Проверяем, что этот инструмент действительно закреплён за сотрудником
    // текущего пользователя (открытое закрепление).
    const checkSql = `
      SELECT a.id FROM tool_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.tool_id = ? AND a.returned_at IS NULL AND e.user_id = ?`;
    db.get(checkSql, [toolId, user.id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 403, { success: false, message: 'Этот инструмент сейчас не закреплён за вами' });

      db.run("INSERT INTO tool_photos (tool_id, photo_url, uploaded_by) VALUES (?, ?, ?)", [toolId, rawPhoto, user.id], function (uErr) {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });
        logAction(user.username, `Добавил фото к инструменту id=${toolId} в галерею`);
        // Первое фото инструмента автоматически становится аватаром.
        db.run("UPDATE tools SET photo_url = ? WHERE id = ? AND (photo_url IS NULL OR photo_url = '')",
          [rawPhoto, toolId], () => {
            sendJson(res, 200, { success: true, photo_url: rawPhoto });
          });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// Авто, закреплённое за сотрудником, привязанным к текущему аккаунту.
function getMyVehicles(req, res, user) {
  const sql = `
    SELECT v.id, v.name, v.category, v.brand, v.model, v.year, v.plate_number, v.vin,
           v.photo_url, a.issued_at
    FROM employees e
    JOIN vehicle_assignments a ON a.employee_id = e.id AND a.returned_at IS NULL
    JOIN vehicles v ON v.id = a.vehicle_id
    WHERE e.user_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [user.id], (err, vehicles) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!vehicles || vehicles.length === 0) {
      return sendJson(res, 200, { success: true, vehicles: [] });
    }

    const ids = vehicles.map(v => v.id);
    const placeholders = ids.map(() => '?').join(',');
    const photoSql = `SELECT vehicle_id, photo_url FROM vehicle_photos WHERE vehicle_id IN (${placeholders}) ORDER BY created_at ASC`;
    db.all(photoSql, ids, (err2, photos) => {
      if (err2) return sendJson(res, 500, { success: false, message: 'Ошибка загрузки фото галереи' });

      const photosByVehicle = {};
      (photos || []).forEach(p => {
        if (!photosByVehicle[p.vehicle_id]) photosByVehicle[p.vehicle_id] = [];
        photosByVehicle[p.vehicle_id].push(p.photo_url);
      });

      vehicles.forEach(v => { v.gallery_photos = photosByVehicle[v.id] || []; });

      sendJson(res, 200, { success: true, vehicles });
    });
  });
}

// Квартира(ы), закреплённая за сотрудником, привязанным к текущему аккаунту.
// own_housing — сотрудник живёт в своём жилье и не нуждается в закреплении.
function getMyApartment(req, res, user) {
  const sql = `
    SELECT ap.id, ap.name, ap.category, ap.address, ap.house, ap.floor, ap.unit_number,
           ap.rooms, ap.area, ap.photo_url, ap.notes, ap.contact_type, ap.contact_info, a.issued_at
    FROM employees e
    JOIN apartment_assignments a ON a.employee_id = e.id AND a.returned_at IS NULL
    JOIN apartments ap ON ap.id = a.apartment_id
    WHERE e.user_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [user.id], (err, apartments) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    // Контакты владельца/риелтора показываем сотрудникам, только если это
    // разрешено в настройках недвижимости; примечания (домофон/код) — всегда.
    db.get("SELECT value FROM settings WHERE key = 'apartment_show_owner_contacts'", [], (sErr, setting) => {
      const showContacts = !sErr && setting && setting.value === 'true';
      const list = (apartments || []).map(a => showContacts ? a : { ...a, contact_type: null, contact_info: null });
      db.get("SELECT own_housing FROM employees WHERE user_id = ?", [user.id], (e2, emp) => {
        sendJson(res, 200, {
          success: true,
          apartments: list,
          own_housing: !!(emp && emp.own_housing)
        });
      });
    });
  });
}

// Строительные объекты, на которые сейчас направлен сотрудник, привязанный
// к текущему аккаунту (можно работать на нескольких объектах одновременно).
function getMyConstructionSites(req, res, user) {
  const sql = `
    SELECT s.id, s.name, s.category, s.address, s.customer, s.status, a.issued_at, e.id AS my_employee_id,
           f.id AS foreman_id, f.first_name AS foreman_first_name, f.last_name AS foreman_last_name
    FROM employees e
    JOIN construction_site_assignments a ON a.employee_id = e.id AND a.returned_at IS NULL
    JOIN construction_sites s ON s.id = a.site_id
    LEFT JOIN employees f ON f.id = s.foreman_id
    WHERE e.user_id = ?
    ORDER BY a.issued_at DESC`;
  db.all(sql, [user.id], (err, sites) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const withForeman = (sites || []).map(s => ({
      ...s,
      foreman_name: s.foreman_id ? [s.foreman_last_name, s.foreman_first_name].filter(Boolean).join(' ') : null
    }));
    if (!withForeman.length) return sendJson(res, 200, { success: true, sites: withForeman });

    // Бригада, в которой сейчас состоит сам сотрудник — на каждом из его
    // объектов (если он туда включён бригадиром), + с кем именно.
    const myEmployeeId = withForeman[0].my_employee_id;
    const siteIds = [...new Set(withForeman.map(s => s.id))];
    const ph = siteIds.map(() => '?').join(',');
    const myCrewSql = `
      SELECT sc.id, sc.name, sc.site_id FROM site_crew_members m
      JOIN site_crews sc ON sc.id = m.crew_id
      WHERE sc.site_id IN (${ph}) AND m.employee_id = ?`;
    db.all(myCrewSql, [...siteIds, myEmployeeId], (e2, myCrews) => {
      if (e2 || !myCrews || !myCrews.length) return sendJson(res, 200, { success: true, sites: withForeman });
      const crewIds = myCrews.map(c => c.id);
      const ph2 = crewIds.map(() => '?').join(',');
      db.all(
        `SELECT m.crew_id, e.first_name, e.last_name FROM site_crew_members m
         JOIN employees e ON e.id = m.employee_id
         WHERE m.crew_id IN (${ph2}) AND m.employee_id != ?`,
        [...crewIds, myEmployeeId],
        (e3, mateRows) => {
          const matesByCrew = {};
          (mateRows || []).forEach(r => {
            (matesByCrew[r.crew_id] = matesByCrew[r.crew_id] || []).push([r.last_name, r.first_name].filter(Boolean).join(' ') || '—');
          });
          const crewBySite = {};
          myCrews.forEach(c => { crewBySite[c.site_id] = { id: c.id, name: c.name, mates: matesByCrew[c.id] || [] }; });
          const sitesWithCrew = withForeman.map(s => ({ ...s, my_crew: crewBySite[s.id] || null }));
          sendJson(res, 200, { success: true, sites: sitesWithCrew });
        }
      );
    });
  });
}

// Коллеги, направленные на тот же объект, что и текущий пользователь —
// для быстрого перехода в чат с ними. Возвращает только тех, у кого есть
// личный аккаунт (иначе не с кем открыть переписку).
function getSiteColleagues(req, res, user, parsedUrl) {
  const siteId = parseInt(parsedUrl.searchParams.get('site_id'), 10);
  if (!(siteId > 0)) return sendJson(res, 400, { success: false, message: 'Не указан объект' });

  // Убеждаемся, что сам пользователь сейчас направлен на этот объект —
  // иначе список коллег по чужому объекту утекал бы кому угодно. Заодно
  // узнаём его employee.id и является ли он бригадиром объекта (нужно
  // фронту, чтобы показать кнопку «Бригады» только бригадиру).
  const checkSql = `
    SELECT e.id AS my_employee_id, s.foreman_id
    FROM construction_site_assignments a
    JOIN employees e ON e.id = a.employee_id
    JOIN construction_sites s ON s.id = a.site_id
    WHERE a.site_id = ? AND a.returned_at IS NULL AND e.user_id = ?`;
  db.get(checkSql, [siteId, user.id], (err, me) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!me) return sendJson(res, 403, { success: false, message: 'Вы сейчас не направлены на этот объект' });
    const isForeman = !!(me.foreman_id && me.foreman_id === me.my_employee_id);

    const sql = `
      SELECT e.id AS employee_id, e.user_id, e.first_name, e.last_name, e.position,
             CASE WHEN s.foreman_id = e.id THEN 1 ELSE 0 END AS is_foreman
      FROM construction_site_assignments a
      JOIN employees e ON e.id = a.employee_id
      JOIN construction_sites s ON s.id = a.site_id
      WHERE a.site_id = ? AND a.returned_at IS NULL AND e.user_id IS NOT NULL AND e.user_id != ?
      ORDER BY is_foreman DESC, e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`;
    db.all(sql, [siteId, user.id], (e2, rows) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      const colleagues = (rows || []).map(r => ({
        employee_id: r.employee_id,
        user_id: r.user_id,
        name: [r.last_name, r.first_name].filter(Boolean).join(' ') || '—',
        position: r.position || '',
        is_foreman: !!r.is_foreman
      }));
      sendJson(res, 200, { success: true, colleagues, is_foreman: isForeman, my_employee_id: me.my_employee_id });
    });
  });
}

// ================= Бригады объекта (только бригадир) =================

function requireForeman(siteId, user, cb) {
  db.get("SELECT id FROM employees WHERE id = (SELECT foreman_id FROM construction_sites WHERE id = ?) AND user_id = ?",
    [siteId, user.id], (err, row) => cb(err, !!row));
}

function listSiteCrews(req, res, user, parsedUrl) {
  const siteId = parseInt(parsedUrl.searchParams.get('site_id'), 10);
  if (!(siteId > 0)) return sendJson(res, 400, { success: false, message: 'Не указан объект' });
  // Смотреть бригады может любой, кто сейчас направлен на объект.
  const checkSql = `
    SELECT 1 FROM construction_site_assignments a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.site_id = ? AND a.returned_at IS NULL AND e.user_id = ?`;
  db.get(checkSql, [siteId, user.id], (err, row) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!row) return sendJson(res, 403, { success: false, message: 'Вы сейчас не направлены на этот объект' });

    db.all("SELECT id, name FROM site_crews WHERE site_id = ? ORDER BY id ASC", [siteId], (e2, crews) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!crews || !crews.length) return sendJson(res, 200, { success: true, crews: [] });
      const crewIds = crews.map(c => c.id);
      const ph = crewIds.map(() => '?').join(',');
      db.all(
        `SELECT m.crew_id, e.id AS employee_id, e.first_name, e.last_name
         FROM site_crew_members m JOIN employees e ON e.id = m.employee_id
         WHERE m.crew_id IN (${ph}) ORDER BY e.last_name COLLATE NOCASE, e.first_name COLLATE NOCASE`,
        crewIds,
        (e3, members) => {
          if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          const empIds = [...new Set((members || []).map(m => m.employee_id))];
          // Электроинструмент, сейчас закреплённый за каждым членом бригады —
          // чтобы бригадир видел, чей инструмент собран у бригады и на ком он числится.
          const attachTools = (toolsByEmp) => {
            const byCrew = {};
            (members || []).forEach(m => {
              (byCrew[m.crew_id] = byCrew[m.crew_id] || []).push({
                employee_id: m.employee_id,
                name: [m.last_name, m.first_name].filter(Boolean).join(' ') || '—',
                tools: toolsByEmp[m.employee_id] || []
              });
            });
            sendJson(res, 200, { success: true, crews: crews.map(c => ({ ...c, members: byCrew[c.id] || [] })) });
          };
          if (!empIds.length) return attachTools({});
          const ph2 = empIds.map(() => '?').join(',');
          db.all(
            `SELECT a.employee_id, t.name, t.brand, t.model
             FROM tool_assignments a JOIN tools t ON t.id = a.tool_id
             WHERE a.employee_id IN (${ph2}) AND a.returned_at IS NULL`,
            empIds,
            (e4, toolRows) => {
              if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
              const toolsByEmp = {};
              (toolRows || []).forEach(t => {
                const label = [t.brand, t.model].filter(Boolean).join(' ') || t.name;
                (toolsByEmp[t.employee_id] = toolsByEmp[t.employee_id] || []).push(label);
              });
              attachTools(toolsByEmp);
            }
          );
        }
      );
    });
  });
}

async function createSiteCrew(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const siteId = parseInt(body.site_id, 10);
    const name = (body.name || '').trim().slice(0, 100);
    if (!(siteId > 0)) return sendJson(res, 400, { success: false, message: 'Не указан объект' });
    if (!name) return sendJson(res, 400, { success: false, message: 'Укажите название бригады' });
    requireForeman(siteId, user, (err, ok) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!ok) return sendJson(res, 403, { success: false, message: 'Бригады формирует только бригадир объекта' });
      db.run("INSERT INTO site_crews (site_id, name, created_by) VALUES (?, ?, ?)", [siteId, name, user.id], function (insErr) {
        if (insErr) return sendJson(res, 500, { success: false, message: 'Не удалось создать бригаду' });
        logAction(user.username, `Создал бригаду «${name}» на объекте id=${siteId}`);
        sendJson(res, 201, { success: true, id: this.lastID });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

function deleteSiteCrew(req, res, user, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!(id > 0)) return sendJson(res, 400, { success: false, message: 'Не указана бригада' });
  db.get("SELECT site_id, name FROM site_crews WHERE id = ?", [id], (err, crew) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!crew) return sendJson(res, 404, { success: false, message: 'Бригада не найдена' });
    requireForeman(crew.site_id, user, (e2, ok) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!ok) return sendJson(res, 403, { success: false, message: 'Бригады управляет только бригадир объекта' });
      db.run("DELETE FROM site_crews WHERE id = ?", [id], (dErr) => {
        if (dErr) return sendJson(res, 500, { success: false, message: 'Не удалось удалить бригаду' });
        logAction(user.username, `Удалил бригаду «${crew.name}»`);
        sendJson(res, 200, { success: true });
      });
    });
  });
}

async function addSiteCrewMember(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const crewId = parseInt(body.crew_id, 10);
    const employeeId = parseInt(body.employee_id, 10);
    if (!(crewId > 0) || !(employeeId > 0)) return sendJson(res, 400, { success: false, message: 'Некорректные данные' });
    db.get("SELECT site_id FROM site_crews WHERE id = ?", [crewId], (err, crew) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!crew) return sendJson(res, 404, { success: false, message: 'Бригада не найдена' });
      requireForeman(crew.site_id, user, (e2, ok) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        if (!ok) return sendJson(res, 403, { success: false, message: 'Бригады управляет только бригадир объекта' });
        // Сотрудник должен реально быть направлен на этот же объект.
        const memberCheckSql = `
          SELECT 1 FROM construction_site_assignments
          WHERE site_id = ? AND employee_id = ? AND returned_at IS NULL`;
        db.get(memberCheckSql, [crew.site_id, employeeId], (e3, onSite) => {
          if (e3) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
          if (!onSite) return sendJson(res, 400, { success: false, message: 'Сотрудник не направлен на этот объект' });
          // Один человек — только в одной бригаде объекта одновременно.
          const otherCrewSql = `
            SELECT sc.name FROM site_crew_members m
            JOIN site_crews sc ON sc.id = m.crew_id
            WHERE sc.site_id = ? AND m.employee_id = ? AND m.crew_id != ?`;
          db.get(otherCrewSql, [crew.site_id, employeeId, crewId], (e4, other) => {
            if (e4) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
            if (other) return sendJson(res, 400, { success: false, message: `Уже состоит в бригаде «${other.name}»` });
            db.run("INSERT OR IGNORE INTO site_crew_members (crew_id, employee_id) VALUES (?, ?)", [crewId, employeeId], (iErr) => {
              if (iErr) return sendJson(res, 500, { success: false, message: 'Не удалось добавить в бригаду' });
              sendJson(res, 200, { success: true });
            });
          });
        });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

function removeSiteCrewMember(req, res, user, parsedUrl) {
  const crewId = parseInt(parsedUrl.searchParams.get('crew_id'), 10);
  const employeeId = parseInt(parsedUrl.searchParams.get('employee_id'), 10);
  if (!(crewId > 0) || !(employeeId > 0)) return sendJson(res, 400, { success: false, message: 'Некорректные данные' });
  db.get("SELECT site_id FROM site_crews WHERE id = ?", [crewId], (err, crew) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!crew) return sendJson(res, 404, { success: false, message: 'Бригада не найдена' });
    requireForeman(crew.site_id, user, (e2, ok) => {
      if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!ok) return sendJson(res, 403, { success: false, message: 'Бригады управляет только бригадир объекта' });
      db.run("DELETE FROM site_crew_members WHERE crew_id = ? AND employee_id = ?", [crewId, employeeId], (dErr) => {
        if (dErr) return sendJson(res, 500, { success: false, message: 'Не удалось убрать из бригады' });
        sendJson(res, 200, { success: true });
      });
    });
  });
}

// Сотрудник добавляет фото в галерею ТОЛЬКО у авто, которое сейчас на нём.
async function setVehiclePhoto(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const vehicleId = parseInt(body.vehicle_id, 10);
    const rawPhoto = (body.photo_url == null ? '' : String(body.photo_url)).trim();
    if (!vehicleId) return sendJson(res, 400, { success: false, message: 'Не указано авто' });
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(rawPhoto)) {
      return sendJson(res, 400, { success: false, message: 'Некорректный адрес фото' });
    }

    const checkSql = `
      SELECT a.id FROM vehicle_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.vehicle_id = ? AND a.returned_at IS NULL AND e.user_id = ?`;
    db.get(checkSql, [vehicleId, user.id], (err, row) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!row) return sendJson(res, 403, { success: false, message: 'Это авто сейчас не закреплено за вами' });

      db.run("INSERT INTO vehicle_photos (vehicle_id, photo_url, uploaded_by) VALUES (?, ?, ?)", [vehicleId, rawPhoto, user.id], function (uErr) {
        if (uErr) return sendJson(res, 500, { success: false, message: 'Не удалось сохранить фото' });
        logAction(user.username, `Добавил фото к авто id=${vehicleId} в галерею`);
        db.run("UPDATE vehicles SET photo_url = ? WHERE id = ? AND (photo_url IS NULL OR photo_url = '')",
          [rawPhoto, vehicleId], () => {
            sendJson(res, 200, { success: true, photo_url: rawPhoto });
          });
      });
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

// Обновление профиля пользователя (email, пароль, avatar_url)
async function updateProfile(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const { email, password, currentPassword, avatar_url } = body;

    db.get("SELECT * FROM users WHERE id = ?", [user.id], (err, dbUser) => {
      if (err || !dbUser) {
        return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });
      }

      const fields = [];
      const values = [];

      if (email && email !== dbUser.email) {
        fields.push('email = ?');
        values.push(email);
      }

      if (avatar_url) {
        fields.push('avatar_url = ?');
        values.push(avatar_url);
      }

      if (password) {
        if (!currentPassword) {
          return sendJson(res, 400, { success: false, message: 'Для смены пароля укажите текущий пароль' });
        }
        if (password.length < 8) {
          return sendJson(res, 400, { success: false, message: 'Пароль должен быть минимум 8 символов' });
        }
        const ok = verifyPassword(currentPassword, dbUser.password_hash);
        if (!ok) {
          return sendJson(res, 400, { success: false, message: 'Неверный текущий пароль' });
        }
        fields.push('password_hash = ?');
        values.push(hashPassword(password));
      }

      if (fields.length === 0) {
        return sendJson(res, 400, { success: false, message: 'Нет изменений для сохранения' });
      }

      values.push(user.id);

      db.run(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
        values,
        function (updateErr) {
          if (updateErr) {
            const msg = updateErr.message.includes('UNIQUE') ? 'Такой email уже используется' : 'Ошибка сохранения профиля';
            return sendJson(res, 400, { success: false, message: msg });
          }
          logAction(user.username, 'Обновил свой профиль');
          // Вернём свежие данные
          db.get("SELECT id, username, email, role, avatar_url, created_at FROM users WHERE id = ?", [user.id], (e2, fresh) => {
            sendJson(res, 200, { success: true, message: 'Профиль обновлён', user: fresh });
          });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
  }
}

module.exports = async function handleCabinet(req, res, user, parsedUrl, method) {
  if (!user) {
    return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  }

  const pathname = parsedUrl.pathname;

  if (pathname === '/api/cabinet/me' && method === 'GET') return getMe(req, res, user);
  if (pathname === '/api/cabinet/profile' && method === 'PUT') return updateProfile(req, res, user);
  if (pathname === '/api/cabinet/my-card' && method === 'GET') return getMyCard(req, res, user);
  if (pathname === '/api/cabinet/employee-photo' && method === 'POST') return setMyEmployeePhoto(req, res, user);
  if (pathname === '/api/cabinet/my-tools' && method === 'GET') return getMyTools(req, res, user);
  if (pathname === '/api/cabinet/tool-photo' && method === 'POST') return setToolPhoto(req, res, user);
  if (pathname === '/api/cabinet/my-vehicles' && method === 'GET') return getMyVehicles(req, res, user);
  if (pathname === '/api/cabinet/my-apartment' && method === 'GET') return getMyApartment(req, res, user);
  if (pathname === '/api/cabinet/my-construction-sites' && method === 'GET') return getMyConstructionSites(req, res, user);
  if (pathname === '/api/cabinet/site-colleagues' && method === 'GET') return getSiteColleagues(req, res, user, parsedUrl);
  if (pathname === '/api/cabinet/site-crews' && method === 'GET') return listSiteCrews(req, res, user, parsedUrl);
  if (pathname === '/api/cabinet/site-crews' && method === 'POST') return createSiteCrew(req, res, user);
  if (pathname === '/api/cabinet/site-crews' && method === 'DELETE') return deleteSiteCrew(req, res, user, parsedUrl);
  if (pathname === '/api/cabinet/site-crews/members' && method === 'POST') return addSiteCrewMember(req, res, user);
  if (pathname === '/api/cabinet/site-crews/members' && method === 'DELETE') return removeSiteCrewMember(req, res, user, parsedUrl);
  if (pathname === '/api/cabinet/vehicle-photo' && method === 'POST') return setVehiclePhoto(req, res, user);

  return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
};
