const { sendJson, getJsonBody, logAction } = require('../utils');
const { db } = require('../../db');

/**
 * Планировщик задач сотрудников.
 *
 *  Сотрудник (свои задачи, в личном кабинете — календарь):
 *    POST   /api/tasks           — поставить себе задачу { title, notes, due_date }
 *    GET    /api/tasks/mine       — свои задачи
 *    PUT    /api/tasks?id=        — изменить свою задачу { title, notes, due_date, done }
 *    DELETE /api/tasks?id=        — удалить свою задачу
 *
 *  Админ (Admin/Superadmin) — раздел «Планировщик задач сотрудников»:
 *    GET    /api/tasks/all              — все задачи всех сотрудников
 *    POST   /api/tasks/assign           — поставить задачу сотруднику { employee_id, title, notes, due_date }
 *    PUT    /api/tasks?id=               — тоже доступно админу (правит любую задачу)
 *    DELETE /api/tasks?id=               — тоже доступно админу (удаляет любую)
 *
 * Напоминания: при создании/переносе даты задачи создаются обычные строки
 * в notifications с scheduled_at = due_date-2д и due_date-1д (те, что уже в
 * прошлом — не создаются). Существующая лента уведомлений в кабинете сама
 * фильтрует по scheduled_at, доп. логики не требуется.
 */

function isAdmin(user) {
  return user && (user.role === 'Admin' || user.role === 'Superadmin');
}

function myEmployeeId(userId, cb) {
  db.get("SELECT id FROM employees WHERE user_id = ?", [userId], (err, row) => cb(err, row ? row.id : null));
}

function parseDueDate(raw) {
  const s = String(raw || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00')) ? s : null;
}

// Пересоздаёт напоминания за 2 и 1 день до due_date для задачи (сначала
// убирая старые — на случай переноса даты/удаления).
function scheduleTaskReminders(taskId, employeeId, title, dueDate) {
  db.run("DELETE FROM notifications WHERE task_id = ?", [taskId], () => {
    db.get("SELECT user_id FROM employees WHERE id = ?", [employeeId], (err, emp) => {
      if (err || !emp || !emp.user_id) return;
      const due = new Date(dueDate + 'T09:00:00');
      const now = new Date();
      [2, 1].forEach(daysBefore => {
        const when = new Date(due.getTime() - daysBefore * 86400000);
        if (when.getTime() <= now.getTime()) return; // уже прошло — не создаём
        const scheduledAt = when.toISOString().slice(0, 10) + ' ' + when.toTimeString().slice(0, 8);
        const dayWord = daysBefore === 1 ? 'завтра' : `через ${daysBefore} дня`;
        const message = `Напоминание: задача «${title}» — срок ${dayWord} (${dueDate}).`;
        db.run(
          "INSERT INTO notifications (user_id, message, task_id, scheduled_at) VALUES (?, ?, ?, ?)",
          [emp.user_id, message, taskId, scheduledAt],
          () => {}
        );
      });
    });
  });
}

async function createOwn(req, res, user) {
  try {
    const body = await getJsonBody(req);
    const title = (body.title || '').trim().slice(0, 200);
    const notes = (body.notes == null ? '' : String(body.notes)).trim().slice(0, 1000) || null;
    const dueDate = parseDueDate(body.due_date);
    if (!title) return sendJson(res, 400, { success: false, message: 'Укажите название задачи' });
    if (!dueDate) return sendJson(res, 400, { success: false, message: 'Некорректная дата' });

    myEmployeeId(user.id, (err, empId) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!empId) return sendJson(res, 403, { success: false, message: 'Доступно только сотрудникам' });
      db.run(
        "INSERT INTO tasks (employee_id, title, notes, due_date, created_by) VALUES (?, ?, ?, ?, ?)",
        [empId, title, notes, dueDate, user.id],
        function (insErr) {
          if (insErr) return sendJson(res, 500, { success: false, message: 'Не удалось создать задачу' });
          const taskId = this.lastID;
          scheduleTaskReminders(taskId, empId, title, dueDate);
          logAction(user.username, `Поставил себе задачу «${title}» на ${dueDate}`);
          sendJson(res, 201, { success: true, id: taskId });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

function listMine(req, res, user) {
  myEmployeeId(user.id, (err, empId) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    if (!empId) return sendJson(res, 200, { success: true, tasks: [] });
    db.all(
      `SELECT t.id, t.title, t.notes, t.due_date, t.done, t.created_by, t.created_at, cu.username AS created_by_username
       FROM tasks t LEFT JOIN users cu ON cu.id = t.created_by
       WHERE t.employee_id = ? ORDER BY t.due_date ASC, t.id ASC`,
      [empId],
      (e2, rows) => {
        if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        sendJson(res, 200, { success: true, tasks: rows || [] });
      }
    );
  });
}

async function editTask(req, res, user, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  try {
    const body = await getJsonBody(req);

    const lookupSql = isAdmin(user)
      ? "SELECT * FROM tasks WHERE id = ?"
      : "SELECT t.* FROM tasks t JOIN employees e ON e.id = t.employee_id WHERE t.id = ? AND e.user_id = ?";
    const lookupParams = isAdmin(user) ? [id] : [id, user.id];
    db.get(lookupSql, lookupParams, (err, task) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!task) return sendJson(res, 404, { success: false, message: 'Задача не найдена' });

      const title = body.title != null ? (String(body.title).trim().slice(0, 200) || task.title) : task.title;
      const notes = body.notes != null ? (String(body.notes).trim().slice(0, 1000) || null) : task.notes;
      const dueDate = body.due_date != null ? (parseDueDate(body.due_date) || task.due_date) : task.due_date;
      const done = body.done != null ? (body.done ? 1 : 0) : task.done;

      db.run(
        "UPDATE tasks SET title = ?, notes = ?, due_date = ?, done = ? WHERE id = ?",
        [title, notes, dueDate, done, id],
        (uErr) => {
          if (uErr) return sendJson(res, 500, { success: false, message: 'Ошибка сохранения' });
          if (!done) scheduleTaskReminders(id, task.employee_id, title, dueDate);
          else db.run("DELETE FROM notifications WHERE task_id = ?", [id], () => {});
          sendJson(res, 200, { success: true });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

function deleteTask(req, res, user, parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
  const sql = isAdmin(user)
    ? "DELETE FROM tasks WHERE id = ?"
    : "DELETE FROM tasks WHERE id = ? AND employee_id = (SELECT id FROM employees WHERE user_id = ?)";
  const params = isAdmin(user) ? [id] : [id, user.id];
  db.run(sql, params, function (err) {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка удаления' });
    if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Задача не найдена' });
    sendJson(res, 200, { success: true });
  });
}

function listAll(req, res, user) {
  if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  const sql = `
    SELECT t.id, t.title, t.notes, t.due_date, t.done, t.created_at,
      e.id AS employee_id, e.first_name, e.last_name,
      cu.username AS created_by_username
    FROM tasks t
    JOIN employees e ON e.id = t.employee_id
    LEFT JOIN users cu ON cu.id = t.created_by
    ORDER BY t.due_date ASC, t.id ASC LIMIT 1000`;
  db.all(sql, [], (err, rows) => {
    if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
    const tasks = (rows || []).map(r => ({ ...r, employee_name: [r.last_name, r.first_name].filter(Boolean).join(' ') }));
    sendJson(res, 200, { success: true, tasks });
  });
}

async function assignTask(req, res, user) {
  if (!isAdmin(user)) return sendJson(res, 403, { success: false, message: 'Недостаточно прав' });
  try {
    const body = await getJsonBody(req);
    const employeeId = parseInt(body.employee_id, 10);
    const title = (body.title || '').trim().slice(0, 200);
    const notes = (body.notes == null ? '' : String(body.notes)).trim().slice(0, 1000) || null;
    const dueDate = parseDueDate(body.due_date);
    if (!employeeId) return sendJson(res, 400, { success: false, message: 'Выберите сотрудника' });
    if (!title) return sendJson(res, 400, { success: false, message: 'Укажите название задачи' });
    if (!dueDate) return sendJson(res, 400, { success: false, message: 'Некорректная дата' });

    db.get("SELECT id FROM employees WHERE id = ?", [employeeId], (err, emp) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
      if (!emp) return sendJson(res, 404, { success: false, message: 'Сотрудник не найден' });
      db.run(
        "INSERT INTO tasks (employee_id, title, notes, due_date, created_by) VALUES (?, ?, ?, ?, ?)",
        [employeeId, title, notes, dueDate, user.id],
        function (insErr) {
          if (insErr) return sendJson(res, 500, { success: false, message: 'Не удалось создать задачу' });
          const taskId = this.lastID;
          scheduleTaskReminders(taskId, employeeId, title, dueDate);
          logAction(user.username, `Поставил задачу «${title}» сотруднику id=${employeeId} на ${dueDate}`);
          sendJson(res, 201, { success: true, id: taskId });
        }
      );
    });
  } catch (e) {
    sendJson(res, 400, { success: false, message: 'Некорректный запрос' });
  }
}

module.exports = async function handleTasks(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
  const p = parsedUrl.pathname;

  if (p === '/api/tasks' && method === 'POST') return createOwn(req, res, user);
  if (p === '/api/tasks/mine' && method === 'GET') return listMine(req, res, user);
  if (p === '/api/tasks' && method === 'PUT') return editTask(req, res, user, parsedUrl);
  if (p === '/api/tasks' && method === 'DELETE') return deleteTask(req, res, user, parsedUrl);
  if (p === '/api/tasks/all' && method === 'GET') return listAll(req, res, user);
  if (p === '/api/tasks/assign' && method === 'POST') return assignTask(req, res, user);

  return sendJson(res, 404, { success: false, message: 'Не найдено' });
};
