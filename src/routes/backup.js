const fs = require('fs');
const { sendJson, logAction } = require('../utils');
const { dbPath } = require('../../db');

/**
 * Полноценное восстановление (приём чужого .sqlite файла через API) сюда
 * намеренно не добавлено: загрузка произвольного файла, который потом
 * подменит рабочую БД — слишком большая поверхность атаки (подмена данных,
 * порча файла при записи поверх открытого соединения SQLite) при небольшой
 * выгоде по сравнению с обычным "остановить сервер → подменить db.sqlite на
 * диске → перезапустить" — эта процедура описана в README.
 */
module.exports = async function handleBackup(req, res, user, parsedUrl, method) {
  if (!user || user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
  }

  if (method !== 'GET') {
    return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
  }

  fs.stat(dbPath, (err, stats) => {
    if (err) {
      return sendJson(res, 500, { success: false, message: 'Файл базы данных не найден' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sqlite`;

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${filename}"`
    });

    const stream = fs.createReadStream(dbPath);
    stream.on('error', () => {
      if (!res.headersSent) sendJson(res, 500, { success: false, message: 'Ошибка чтения файла БД' });
      else res.end();
    });
    stream.pipe(res);

    logAction(user.username, 'Скачал резервную копию базы данных');
  });
};
