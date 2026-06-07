const fs = require('fs');
const path = require('path');
const { db } = require('../db');

/**
 * Shared utilities extracted from the monolithic server.js
 * These are used by the route handlers.
 */

function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function logAction(user, action) {
  db.run("INSERT INTO logs (user, action) VALUES (?, ?)", [user, action], (err) => {
    if (err) console.error("Ошибка записи лога:", err);
  });
}

/**
 * Base64 file upload handler.
 * UPLOADS_DIR is passed in so the route doesn't need to know project layout.
 */
async function handleBase64Upload(req, UPLOADS_DIR) {
  const body = await getJsonBody(req);
  const inputFiles = Array.isArray(body.files) ? body.files : [];
  const result = [];

  const MAX_FILES = 6;
  const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ после декодирования

  if (inputFiles.length > MAX_FILES) {
    throw new Error('Слишком много файлов за раз (макс. ' + MAX_FILES + ')');
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
      throw new Error(`Файл "${f.filename}" слишком большой (макс 8 МБ)`);
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
