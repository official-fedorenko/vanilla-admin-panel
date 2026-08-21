const { sendJson } = require('../utils');
const catalog = require('../../data/tool-catalog');

/**
 * Отдаёт справочник моделей (data/tool-catalog) фронтенду для подсказок при
 * добавлении инструмента. Только чтение, требует авторизации.
 *
 * Относительные пути картинок ("images/x.svg") превращаются в служебный
 * URL "/catalog/images/x.svg" (его раздаёт server.js).
 */
function toUrl(img) {
  return img ? '/catalog/' + String(img).replace(/^\/+/, '') : null;
}

module.exports = function handleToolCatalog(req, res, user) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  const categories = catalog.raw.categories.map(c => ({
    category: c.category,
    slug: c.slugEn,
    image: toUrl(c.image),
    models: c.tools.map(t => ({
      brand: t.brand,
      model: t.model,
      name: t.name,
      line: t.line || null,
      powerType: t.powerType || null,
      powerW: t.powerW || null,
      voltageV: t.voltageV || null,
      brushless: !!t.brushless,
      impact: !!t.impact,
      chuck: t.chuck || null,
      discMm: t.discMm || null,
      image: toUrl(t.image || c.image)
    }))
  }));

  sendJson(res, 200, { success: true, categories });
};
