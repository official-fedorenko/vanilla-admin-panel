const { sendJson, logAction } = require('../utils');
const { db } = require('../../db');
const path = require('path');
const fs = require('fs');

module.exports = async function handleResetDemo(req, res, user, parsedUrl, method, { UPLOADS_DIR, reloadSettingsCache }) {
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
  }

  try {
    // Remove uploaded files from disk
    db.all("SELECT file_path FROM media", [], (e, rows) => {
      if (rows) {
        rows.forEach(r => {
          const fname = path.basename(r.file_path || '');
          if (fname) fs.promises.unlink(path.join(UPLOADS_DIR, fname)).catch(() => {});
        });
      }
    });

    db.serialize(() => {
      db.run("DELETE FROM articles");
      db.run("DELETE FROM media");
      db.run("DELETE FROM logs");
      db.run("DELETE FROM support_messages");
      db.run("DELETE FROM sessions WHERE username != 'superadmin' AND username != 'admin' AND username != 'user'");

      // Re-seed a couple of demo articles
      const artStmt = db.prepare("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)");
      artStmt.run("Добро пожаловать в новую админку!", "Это демонстрационная статья, созданная автоматически для проверки работы CRUD панели.", "published");
      artStmt.run("Черновик важной публикации", "Контент этой статьи еще не готов для публикации.", "draft");
      artStmt.finalize();

      if (typeof reloadSettingsCache === 'function') {
        reloadSettingsCache();
      }

      logAction(user.username, 'Сброс демо-данных (для показа)');
      sendJson(res, 200, { success: true, message: 'Демо-данные успешно сброшены' });
    });
  } catch (err) {
    sendJson(res, 500, { success: false, message: 'Не удалось выполнить сброс' });
  }
};

