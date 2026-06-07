const { sendJson, getJsonBody } = require('../utils');
const { db } = require('../../db');

module.exports = async function handleSettings(req, res, user, parsedUrl, method, { reloadSettingsCache }) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    db.all("SELECT * FROM settings", [], (err, rows) => {
      if (err) return sendJson(res, 500, { message: 'Ошибка базы данных' });
      sendJson(res, 200, rows);
    });
  } else if (method === 'POST') {
    try {
      const settings = await getJsonBody(req);
      const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      db.serialize(() => {
        for (const [key, value] of Object.entries(settings)) {
          stmt.run(key, value);
        }
        stmt.finalize();
        if (typeof reloadSettingsCache === 'function') {
          reloadSettingsCache();
        }
        sendJson(res, 200, { success: true });
      });
    } catch (e) {
      sendJson(res, 500, { message: 'Ошибка сохранения' });
    }
  }
};
