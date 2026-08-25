const { sendJson } = require('../utils');
const { db } = require('../../db');

/**
 * Отдаёт справочник моделей стандартного инструмента фронтенду для подсказок
 * при добавлении инструмента (и в админке, и в заявке). Источник — таблица
 * catalog_models (редактируется из админпанели). Только чтение, требует
 * авторизации.
 *
 * Картинки категорий могут переопределяться в category_icons.
 * Формат ответа сохранён прежним, чтобы пикер на фронтенде не менять.
 */
function toDisplay(url) {
  if (!url) return null;
  // Каталожные SVG кэшируем с версией (как было раньше); /uploads/ — как есть.
  if (/^\/catalog\//.test(url) && !url.includes('?')) return url + '?v=2';
  return url;
}

module.exports = function handleToolCatalog(req, res, user) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  db.all("SELECT category, image_url FROM category_icons", [], (err, iconRows) => {
    const overrides = {};
    (iconRows || []).forEach((r) => { overrides[r.category] = r.image_url; });

    // Единый список категорий берём из справочника tool_categories, чтобы пикер
    // показывал все категории (даже без моделей) — синхронно с остальным UI.
    db.all("SELECT name FROM tool_categories ORDER BY name COLLATE NOCASE", [], (eC, catRows) => {
      const dictOrder = (catRows || []).map((r) => r.name);

      db.all(
        "SELECT * FROM catalog_models ORDER BY category COLLATE NOCASE, brand COLLATE NOCASE, model COLLATE NOCASE",
        [],
        (e2, models) => {
          if (e2) return sendJson(res, 500, { success: false, message: 'Ошибка базы данных' });

          const byCat = new Map();
          (models || []).forEach((m) => {
            if (!byCat.has(m.category)) byCat.set(m.category, []);
            byCat.get(m.category).push(m);
          });
          // Добавляем категории из справочника, даже если у них нет моделей.
          dictOrder.forEach((name) => { if (!byCat.has(name)) byCat.set(name, []); });
          // Порядок: как в справочнике, затем категории моделей вне справочника.
          const orderedNames = [...dictOrder, ...[...byCat.keys()].filter((n) => !dictOrder.includes(n))];

          const categories = orderedNames.map((category) => {
            const list = byCat.get(category) || [];
            const catImage = overrides[category] || toDisplay(list[0] && list[0].image_url);
            return {
            category,
            image: catImage,
            models: list.map((m) => ({
              brand: m.brand,
              model: m.model,
              name: m.name || `${m.brand} ${m.model}`,
              line: m.line || null,
              powerType: m.power_type || null,
              powerW: m.power_w || null,
              voltageV: m.voltage_v || null,
              brushless: !!m.brushless,
              impact: !!m.impact,
              chuck: m.chuck || null,
              discMm: m.disc_mm || null,
              image: overrides[category] || toDisplay(m.image_url) || catImage
            }))
          };
        });

          sendJson(res, 200, { success: true, categories });
        }
      );
    });
  });
};
