const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const logger = require('./logger');

/**
 * Shared utilities extracted from the monolithic server.js
 * These are used by the route handlers.
 */

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 2 МБ — достаточно для обычных форм/статей

function getJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        // Не вызываем req.destroy() — обрыв соединения мешает дочитать
        // запрос и отправить клиенту корректный ответ об ошибке.
        const err = new Error('Тело запроса слишком большое');
        err.expected = true;
        reject(err);
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', err => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function logAction(user, action) {
  db.run("INSERT INTO logs (user, action) VALUES (?, ?)", [user, action], (err) => {
    if (err) logger.error("Ошибка записи лога:", err);
  });
}

/**
 * Base64 file upload handler.
 * UPLOADS_DIR is passed in so the route doesn't need to know project layout.
 */
async function handleBase64Upload(req, UPLOADS_DIR) {
  const MAX_FILES = 6;
  const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ после декодирования
  // base64 раздувает размер на ~33% + запас под JSON-обёртку и метаданные файлов
  const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_FILES * MAX_SIZE_BYTES * 1.4);

  const body = await getJsonBody(req, MAX_UPLOAD_BODY_BYTES);
  const inputFiles = Array.isArray(body.files) ? body.files : [];
  const result = [];

  if (inputFiles.length > MAX_FILES) {
    const err = new Error('Слишком много файлов за раз (макс. ' + MAX_FILES + ')');
    err.expected = true;
    throw err;
  }

  for (const f of inputFiles) {
    if (!f || !f.data || !f.filename) continue;

    let buffer;
    try {
      buffer = Buffer.from(f.data, 'base64');
    } catch (e) {
      continue;
    }

    if (buffer.length === 0 || buffer.length > MAX_SIZE_BYTES) {
      const err = new Error(`Файл "${f.filename}" слишком большой (макс 8 МБ)`);
      err.expected = true;
      throw err;
    }

    // Простая защита имени файла
    const safeOriginal = String(f.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const uniqueName = Date.now() + '-' + Math.floor(Math.random() * 1e10) + '-' + safeOriginal;
    const fullPath = path.join(UPLOADS_DIR, uniqueName);

    await fs.promises.writeFile(fullPath, buffer);

    result.push({
      filename: f.filename,
      fileUrl: '/uploads/' + uniqueName,
      fileSize: buffer.length,
      mimeType: f.mimeType || 'application/octet-stream'
    });
  }

  return result;
}

module.exports = {
  getJsonBody,
  sendJson,
  logAction,
  handleBase64Upload
};
