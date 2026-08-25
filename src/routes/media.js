const { sendJson, getJsonBody, handleBase64Upload, parsePagination } = require('../utils');
const { db } = require('../../db');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

// Для набора URL'ов определяет, к чему/к кому привязан каждый файл:
// - фото инструмента (основное или в галерее) → { type:'tool', label, holder }
// - аватар пользователя → { type:'user', label }
// Возвращает объект { [file_url]: attachment } через колбэк.
function resolveAttachments(urls, cb) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  if (unique.length === 0) return cb({});

  const ph = unique.map(() => '?').join(',');
  const map = {};

  // Инструменты: основное фото + текущий держатель (через активное назначение).
  const toolSql = `
    SELECT t.photo_url AS url, t.name, holder.username AS holder
    FROM tools t
    LEFT JOIN tool_assignments ta ON ta.tool_id = t.id AND ta.returned_at IS NULL
    LEFT JOIN employees e ON e.id = ta.employee_id
    LEFT JOIN users holder ON holder.id = e.user_id
    WHERE t.photo_url IN (${ph})`;

  db.all(toolSql, unique, (e1, toolRows) => {
    (toolRows || []).forEach(r => {
      map[r.url] = { type: 'tool', label: r.name, holder: r.holder || null };
    });

    // Фото из галереи инструмента + кто загрузил.
    const gallerySql = `
      SELECT tp.photo_url AS url, t.name, up.username AS uploader
      FROM tool_photos tp
      JOIN tools t ON t.id = tp.tool_id
      LEFT JOIN users up ON up.id = tp.uploaded_by
      WHERE tp.photo_url IN (${ph})`;

    db.all(gallerySql, unique, (e2, galRows) => {
      (galRows || []).forEach(r => {
        if (!map[r.url]) map[r.url] = { type: 'tool', label: r.name, holder: r.uploader || null };
      });

      // Аватары пользователей.
      db.all(`SELECT avatar_url AS url, username FROM users WHERE avatar_url IN (${ph})`, unique, (e3, userRows) => {
        (userRows || []).forEach(r => {
          if (!map[r.url]) map[r.url] = { type: 'user', label: r.username };
        });
        cb(map);
      });
    });
  });
}

module.exports = async function handleMedia(req, res, user, parsedUrl, method, { UPLOADS_DIR }) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    // limit/offset — без параметров ведёт себя как раньше (до 1000 файлов).
    // Указав offset, можно достать записи за пределами этого потолка, пока
    // в UI не появится полноценная пагинация.
    const { limit, offset } = parsePagination(parsedUrl);
    const categoryFilter = parsedUrl.searchParams.get('category');
    // mine=1 — только файлы, загруженные текущим пользователем. Нужно, чтобы
    // в кабинете каждый видел лишь свои аватары, а не чужие.
    const mineOnly = parsedUrl.searchParams.get('mine') === '1';

    let query = `SELECT m.*, u.username AS uploaded_by_name
                 FROM media m
                 LEFT JOIN users u ON u.id = m.uploaded_by`;
    const params = [];
    const where = [];

    if (categoryFilter && categoryFilter !== 'all') {
      where.push("m.category = ?");
      params.push(categoryFilter);
    }
    if (mineOnly) {
      where.push("m.uploaded_by = ?");
      params.push(user.id);
    }
    if (where.length) query += " WHERE " + where.join(" AND ");

    query += " ORDER BY m.id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    db.all(query, params, (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка БД' });

      // Определяем, к чему/к кому привязано каждое фото (инструмент или аватар),
      // сопоставляя file_path со ссылками в других таблицах.
      resolveAttachments(rows.map(r => r.file_path), (attachByUrl) => {
        const formatted = rows.map(r => ({
          id: r.id, filename: r.filename, file_url: r.file_path,
          mime_type: r.mime_type, file_size: r.file_size, category: r.category,
          uploaded_by_name: r.uploaded_by_name || null,
          created_at: r.created_at,
          attached_to: attachByUrl[r.file_path] || null
        }));

        let countQuery = "SELECT COUNT(*) as count FROM media";
        const countParams = [];
        const countWhere = [];
        if (categoryFilter && categoryFilter !== 'all') {
          countWhere.push("category = ?");
          countParams.push(categoryFilter);
        }
        if (mineOnly) {
          countWhere.push("uploaded_by = ?");
          countParams.push(user.id);
        }
        if (countWhere.length) countQuery += " WHERE " + countWhere.join(" AND ");

        db.get(countQuery, countParams, (err2, countRow) => {
          res.setHeader('X-Total-Count', String((countRow && countRow.count) || 0));
          sendJson(res, 200, formatted);
        });
      });
    });
  } else if (method === 'POST') {
    try {
      const uploadResult = await handleBase64Upload(req, UPLOADS_DIR);
      const files = uploadResult.files;
      const category = uploadResult.category;
      if (files.length === 0) return sendJson(res, 400, { message: 'Файлы не найдены' });

      const stmt = db.prepare("INSERT INTO media (filename, file_path, file_size, mime_type, category, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)");
      let writeError = null;
      db.serialize(() => {
        files.forEach(f => {
          stmt.run(f.filename, f.fileUrl, f.fileSize, f.mimeType, category, user.id,
            (e) => { if (e && !writeError) writeError = e; });
        });
        // Как и в settings: ответ уходит только после finalize(), иначе клиент
        // успевал перезапросить медиатеку до того, как записи появились в БД.
        stmt.finalize((e) => {
          if (writeError || e) return sendJson(res, 500, { message: 'Ошибка сохранения' });

          sendJson(res, 201, {
            success: true,
            count: files.length,
            urls: files.map(f => f.fileUrl)
          });
        });
      });
    } catch (err) {
      // Только ожидаемые (валидационные) ошибки можно показывать клиенту —
      // иначе можно случайно утечь путь на диске или другие детали ФС.
      if (err.expected) {
        sendJson(res, 400, { message: err.message });
      } else {
        logger.error('Ошибка загрузки файла:', err);
        sendJson(res, 500, { message: 'Ошибка загрузки' });
      }
    }
  } else if (method === 'PUT') {
    if (user.role !== 'Superadmin') return sendJson(res, 403, { message: 'Нет доступа' });
    try {
      const body = await getJsonBody(req);
      if (!body.id || !body.category) return sendJson(res, 400, { message: 'Неверные параметры' });
      db.run("UPDATE media SET category = ? WHERE id = ?", [body.category, body.id], function(err) {
        if (err) return sendJson(res, 500, { message: 'Ошибка БД' });
        sendJson(res, 200, { success: true });
      });
    } catch (e) {
      sendJson(res, 400, { message: 'Ошибка запроса' });
    }
  } else if (method === 'DELETE') {
    const id = parsedUrl.searchParams.get('id');
    db.get("SELECT * FROM media WHERE id = ?", [id], async (err, file) => {
      if (err || !file) return sendJson(res, 404, { message: 'Файл не найден' });

      try {
        const filename = path.basename(file.file_path);
        const fullPath = path.join(UPLOADS_DIR, filename);
        await fs.promises.unlink(fullPath).catch(() => {});
      } catch (e) { /* ignore */ }

      db.run("DELETE FROM media WHERE id = ?", [id], () => {
        const fileUrl = file.file_path;
        db.run("UPDATE tools SET photo_url = NULL WHERE photo_url = ?", [fileUrl]);
        db.run("DELETE FROM tool_photos WHERE photo_url = ?", [fileUrl]);
        db.run("UPDATE users SET avatar_url = NULL WHERE avatar_url = ?", [fileUrl]);
        db.run("UPDATE support_messages SET image_url = NULL WHERE image_url = ?", [fileUrl]);
        
        sendJson(res, 200, { success: true });
      });
    });
  }
};
