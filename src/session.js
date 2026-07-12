const crypto = require('crypto');
const { saveSession, loadSessionsIntoMap, deleteSession, cleanupExpiredSessions } = require('../db');
const { TRUST_PROXY } = require('./config');

/**
 * Session storage + cookie helpers, shared by server.js (to resolve the
 * current user on every request) and by the auth/cabinet routes (to
 * create/destroy sessions on login/register/logout).
 */

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60; // сутки

const sessions = new Map();
loadSessionsIntoMap(sessions);
cleanupExpiredSessions();

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function getSessionToken(req) {
  return parseCookies(req).session;
}

function getSessionUser(req) {
  const token = getSessionToken(req);
  if (token && sessions.has(token)) {
    return sessions.get(token);
  }
  return null;
}

// Сервер сам по себе работает по HTTP — HTTPS обычно терминируется на
// reverse-proxy (nginx и т.п.). Доверяем заголовку X-Forwarded-Proto только
// если оператор явно включил TRUST_PROXY=true в .env (иначе заголовок легко
// подделать и он не дает реальной гарантии шифрования соединения).
function isHttpsRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') return true;
  return false;
}

function buildSessionCookie(token, req, { maxAgeSeconds, clear = false } = {}) {
  const parts = [`session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (clear) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join('; ');
}

function createSession(userRow) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionUser = { id: userRow.id, username: userRow.username, role: userRow.role };
  sessions.set(token, sessionUser);
  saveSession(token, sessionUser);
  return { token, sessionUser };
}

function destroySession(token) {
  sessions.delete(token);
  deleteSession(token);
}

module.exports = {
  SESSION_MAX_AGE_SECONDS,
  getSessionUser,
  getSessionToken,
  buildSessionCookie,
  createSession,
  destroySession
};
