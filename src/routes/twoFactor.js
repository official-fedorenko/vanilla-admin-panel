const { sendJson, getJsonBody, logAction } = require('../utils');
const { db, verifyPassword } = require('../../db');
const { generateSecret, verifyTotp, buildOtpAuthUri } = require('../totp');

function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

module.exports = async function handleTwoFactor(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const currentPath = parsedUrl.pathname;

  if (currentPath === '/api/cabinet/2fa/status' && method === 'GET') {
    const dbUser = await getUserById(user.id);
    return sendJson(res, 200, { success: true, enabled: !!(dbUser && dbUser.two_factor_enabled) });
  }

  if (method !== 'POST') return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });

  // Начинает настройку 2FA: генерирует секрет, но НЕ включает его, пока
  // пользователь не подтвердит код из приложения-аутентификатора.
  if (currentPath === '/api/cabinet/2fa/setup') {
    try {
      const { currentPassword } = await getJsonBody(req);
      const dbUser = await getUserById(user.id);
      if (!dbUser) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });

      if (!currentPassword || !verifyPassword(currentPassword, dbUser.password_hash)) {
        return sendJson(res, 400, { success: false, message: 'Неверный текущий пароль' });
      }

      const secret = generateSecret();
      db.run("UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE id = ?", [secret, user.id], (err) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Не удалось начать настройку 2FA' });
        sendJson(res, 200, {
          success: true,
          secret,
          otpauthUri: buildOtpAuthUri(secret, dbUser.username)
        });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // Подтверждает настройку: проверяет код из приложения и включает 2FA.
  if (currentPath === '/api/cabinet/2fa/verify') {
    try {
      const { code } = await getJsonBody(req);
      const dbUser = await getUserById(user.id);
      if (!dbUser || !dbUser.two_factor_secret) {
        return sendJson(res, 400, { success: false, message: 'Сначала запустите настройку 2FA' });
      }

      if (!verifyTotp(dbUser.two_factor_secret, code)) {
        return sendJson(res, 400, { success: false, message: 'Неверный код подтверждения' });
      }

      db.run("UPDATE users SET two_factor_enabled = 1 WHERE id = ?", [user.id], (err) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Не удалось включить 2FA' });
        logAction(user.username, 'Включил двухфакторную аутентификацию');
        sendJson(res, 200, { success: true, message: 'Двухфакторная аутентификация включена' });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  // Отключает 2FA — требует и пароль, и текущий код (двойное подтверждение,
  // чтобы похищенной сессии было недостаточно для снятия защиты).
  if (currentPath === '/api/cabinet/2fa/disable') {
    try {
      const { currentPassword, code } = await getJsonBody(req);
      const dbUser = await getUserById(user.id);
      if (!dbUser) return sendJson(res, 404, { success: false, message: 'Пользователь не найден' });

      if (!currentPassword || !verifyPassword(currentPassword, dbUser.password_hash)) {
        return sendJson(res, 400, { success: false, message: 'Неверный текущий пароль' });
      }
      if (!dbUser.two_factor_enabled) {
        return sendJson(res, 400, { success: false, message: '2FA не включена' });
      }
      if (!verifyTotp(dbUser.two_factor_secret, code)) {
        return sendJson(res, 400, { success: false, message: 'Неверный код подтверждения' });
      }

      db.run("UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?", [user.id], (err) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Не удалось отключить 2FA' });
        logAction(user.username, 'Отключил двухфакторную аутентификацию');
        sendJson(res, 200, { success: true, message: 'Двухфакторная аутентификация отключена' });
      });
    } catch (e) {
      sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
    }
    return;
  }

  sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
};
