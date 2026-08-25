const { sendJson, getJsonBody, logAction, parsePagination } = require('../utils');
const { db } = require('../../db');
const { sanitizeSpecs } = require('../catalogSchema');

/**
 * Управление стандартным каталогом инструмента (таблица catalog_models).
 *
 *   GET    /api/catalog-models         — список всех моделей (для экрана управления)
 *   POST   /api/catalog-models         — добавить модель
 *   PUT    /api/catalog-models?id=     — изменить модель
 *   DELETE /api/catalog-models?id=     — удалить модель
 *   POST   /api/catalog-models/clear   — удалить ВСЕ модели справочника (Superadmin)
 *
 * Чтение — любой авторизованный (нужно и для форм). Изменения — только Superadmin.
 */

function parseId(parsedUrl) {
  const id = parseInt(parsedUrl.searchParams.get('id'), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanImage(v) {
  const raw = (v == null ? '' : String(v)).trim().split('#')[0];
  if (!raw) return null;
  const ok = /^\/uploads\/[A-Za-z0-9._-]+$/.test(raw.split('?')[0])
    || /^\/catalog\/images\/[A-Za-z0-9._-]+\.svg$/.test(raw.split('?')[0]);
  return ok ? raw : null;
}

// Приводит тело к безопасным значениям колонок catalog_models.
function extractFields(body) {
  const str = (v, max = 200) => {
    const s = (v == null ? '' : String(v)).trim();
    return s.length ? s.slice(0, max) : null;
  };
  const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

  const category = str(body.category, 120);
  const brand = str(body.brand, 120);
  const model = str(body.model, 120);
  if (!category || !brand || !model) {
    return { error: 'Категория, бренд и модель обязательны' };
  }
  const powerType = ['corded', 'cordless'].includes(body.power_type) ? body.power_type : null;
  // Узкоспециальные характеристики (не колоночные) по схеме категории → JSON.
  const specsObj = sanitizeSpecs(category, body.specs);
  const specs = Object.keys(specsObj).length ? JSON.stringify(specsObj) : null;
  return {
    values: {
      category, brand, model,
      name: str(body.name, 200) || `${brand} ${model}`,
      line: str(body.line, 80),
      power_type: powerType,
      power_w: int(body.power_w),
      voltage_v: int(body.voltage_v),
      brushless: body.brushless ? 1 : 0,
      impact: body.impact ? 1 : 0,
      chuck: str(body.chuck, 80),
      disc_mm: int(body.disc_mm),
      image_url: cleanImage(body.image_url),
      specs
    }
  };
}

function clearCatalogModels(req, res, user) {
  db.run("DELETE FROM catalog_models", [], function (err) {
    if (err) return sendJson(res, 500, { success: false, message: 'Не удалось очистить справочник' });
    const removed = this.changes;
    logAction(user.username, `Очистил справочник моделей каталога (удалено: ${removed})`);
    sendJson(res, 200, { success: true, message: `Справочник моделей очищен, удалено: ${removed}` });
  });
}

module.exports = function handleCatalogModels(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (parsedUrl.pathname === '/api/catalog-models/clear' && method === 'POST') {
    if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Только Superadmin' });
    return clearCatalogModels(req, res, user);
  }

  if (method === 'GET') {
    const { limit, offset } = parsePagination(parsedUrl);
    db.all(
      "SELECT * FROM catalog_models ORDER BY category COLLATE NOCASE, brand COLLATE NOCASE, model COLLATE NOCASE LIMIT ? OFFSET ?",
      [limit, offset],
      (err, rows) => {
        if (err) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });
        (rows || []).forEach((r) => { try { r.specs = r.specs ? JSON.parse(r.specs) : {}; } catch (e) { r.specs = {}; } });
        db.get("SELECT COUNT(*) AS c FROM catalog_models", [], (e2, cnt) => {
          res.setHeader('X-Total-Count', String((cnt && cnt.c) || 0));
          sendJson(res, 200, { success: true, models: rows || [] });
        });
      }
    );
    return;
  }

  // Изменения — только Superadmin.
  if (user.role !== 'Superadmin') {
    return sendJson(res, 403, { success: false, message: 'Каталог может менять только Superadmin' });
  }

  if (method === 'POST' || method === 'PUT') {
    (async () => {
      try {
        const body = await getJsonBody(req);
        const { error, values } = extractFields(body);
        if (error) return sendJson(res, 400, { success: false, message: error });
        const cols = ['category', 'brand', 'model', 'name', 'line', 'power_type', 'power_w', 'voltage_v', 'brushless', 'impact', 'chuck', 'disc_mm', 'image_url', 'specs'];
        const vals = cols.map((c) => values[c]);

        if (method === 'POST') {
          db.run(
            `INSERT INTO catalog_models (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            vals,
            function (err) {
              if (err) return sendJson(res, 500, { success: false, message: 'Не удалось добавить модель' });
              logAction(user.username, `Каталог: добавлена модель ${values.name}`);
              sendJson(res, 201, { success: true, id: this.lastID });
            }
          );
        } else {
          const id = parseId(parsedUrl);
          if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
          db.run(
            `UPDATE catalog_models SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`,
            [...vals, id],
            function (err) {
              if (err) return sendJson(res, 500, { success: false, message: 'Не удалось изменить модель' });
              if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Модель не найдена' });
              logAction(user.username, `Каталог: изменена модель id=${id} (${values.name})`);
              sendJson(res, 200, { success: true });
            }
          );
        }
      } catch (e) {
        sendJson(res, 400, { success: false, message: 'Невалидный запрос' });
      }
    })();
    return;
  }

  if (method === 'DELETE') {
    const id = parseId(parsedUrl);
    if (!id) return sendJson(res, 400, { success: false, message: 'Не указан id' });
    db.run("DELETE FROM catalog_models WHERE id = ?", [id], function (err) {
      if (err) return sendJson(res, 500, { success: false, message: 'Не удалось удалить' });
      if (this.changes === 0) return sendJson(res, 404, { success: false, message: 'Модель не найдена' });
      logAction(user.username, `Каталог: удалена модель id=${id}`);
      sendJson(res, 200, { success: true });
    });
    return;
  }

  return sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
};
