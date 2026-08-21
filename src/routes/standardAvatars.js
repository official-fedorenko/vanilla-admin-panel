const { sendJson } = require('../utils');
const fs = require('fs');
const path = require('path');

const AVATARS_DIR = path.join(__dirname, '..', '..', 'client', 'avatars');

/**
 * Отдаёт список стандартных (предустановленных) аватаров — SVG-файлы из
 * client/avatars. Только чтение, требует авторизации.
 */
module.exports = function handleStandardAvatars(req, res, user) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  fs.readdir(AVATARS_DIR, (err, files) => {
    if (err) return sendJson(res, 200, { success: true, avatars: [] });
    const avatars = (files || [])
      .filter(f => /\.svg$/i.test(f))
      .sort()
      .map(f => ({ name: f.replace(/\.svg$/i, ''), url: '/avatars/' + f }));
    sendJson(res, 200, { success: true, avatars });
  });
};
