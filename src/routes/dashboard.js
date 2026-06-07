const { sendJson } = require('../utils');
const { db } = require('../../db');

module.exports = async function handleDashboard(req, res, user) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  Promise.all([
    new Promise(res => db.get("SELECT COUNT(*) as count FROM users", (e, r) => res(r ? r.count : 0))),
    new Promise(res => db.get("SELECT COUNT(*) as count FROM articles", (e, r) => res(r ? r.count : 0))),
    new Promise(res => db.get("SELECT COUNT(*) as count FROM media", (e, r) => res(r ? r.count : 0)))
  ]).then(([users, articles, mediaFiles]) => {
    sendJson(res, 200, { users, articles, mediaFiles });
  }).catch(() => sendJson(res, 200, { users: 0, articles: 0, mediaFiles: 0 }));
};
