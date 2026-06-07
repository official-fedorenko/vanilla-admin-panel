const { sendJson, getJsonBody, handleBase64Upload } = require('../utils');
const { db } = require('../../db');
const path = require('path');
const fs = require('fs');

module.exports = async function handleMedia(req, res, user, parsedUrl, method, { UPLOADS_DIR }) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    db.all("SELECT * FROM media ORDER BY id DESC", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка БД' });
      const formatted = rows.map(r => ({
        id: r.id, filename: r.filename, file_url: r.file_path,
        mime_type: r.mime_type, file_size: r.file_size
      }));
      sendJson(res, 200, formatted);
    });
  } else if (method === 'POST') {
    try {
      const files = await handleBase64Upload(req, UPLOADS_DIR);
      if (files.length === 0) return sendJson(res, 400, { message: 'Файлы не найдены' });

      const stmt = db.prepare("INSERT INTO media (filename, file_path, file_size, mime_type) VALUES (?, ?, ?, ?)");
      db.serialize(() => {
        files.forEach(f => {
          stmt.run(f.filename, f.fileUrl, f.fileSize, f.mimeType);
        });
        stmt.finalize();

        sendJson(res, 201, {
          success: true,
          count: files.length,
          urls: files.map(f => f.fileUrl)
        });
      });
    } catch (err) {
      sendJson(res, 500, { message: err.message || 'Ошибка загрузки' });
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
        sendJson(res, 200, { success: true });
      });
    });
  }
};
