const { sendJson, getJsonBody, isInternalPath } = require('../utils');
const { db } = require('../../db');
const catalog = require('../../data/tool-catalog');
const CATEGORY_ICONS = require('../../data/tool-catalog/categoryIcons.json');

// Версия набора иконок — добавляется в URL, чтобы сбросить кэш браузера
// при обновлении картинок (у файлов те же имена, поэтому нужен ?v=).
const ICONS_VERSION = '2';

// Относительный путь картинки каталога ("images/x.svg") → служебный URL.
function catalogUrl(img) {
  return img ? '/catalog/' + String(img).replace(/^\/+/, '') + '?v=' + ICONS_VERSION : null;
}

// Обобщённая иконка для категорий, у которых нет своей картинки.
const GENERIC_ICON = '/catalog/images/generic.svg?v=' + ICONS_VERSION;

// Строит карту "название/алиас категории (lowercase)" → URL иконки.
// Приоритет: явная карта categoryIcons.json → алиасы каталога.
function buildCatalogIconMap() {
  const map = {};
  catalog.raw.categories.forEach(c => {
    const url = catalogUrl(c.image);
    if (!url) return;
    const keys = [c.category, ...(c.aliases || [])];
    keys.forEach(k => { map[String(k).toLowerCase()] = url; });
  });
  // Явные соответствия «категория → своя иконка» перекрывают каталог.
  Object.entries(CATEGORY_ICONS).forEach(([name, img]) => {
    map[String(name).toLowerCase()] = catalogUrl(img);
  });
  return map;
}

// Дефолтная иконка для категории: из карты (по имени/алиасу) либо общая.
function defaultIconFor(categoryName, catalogMap) {
  return catalogMap[String(categoryName).toLowerCase()] || GENERIC_ICON;
}

/**
 * Управление иконками категорий инструментов.
 *   GET    /api/category-icons                — список категорий с иконками
 *   PUT    /api/category-icons {category,image_url} — задать override (Superadmin)
 *   DELETE /api/category-icons?category=...    — сбросить к дефолту (Superadmin)
 */
module.exports = function handleCategoryIcons(req, res, user, parsedUrl, method) {
  if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });

  if (method === 'GET') {
    // Источник списка — общий справочник tool_categories (стандартные + свои).
    // Дефолтная иконка берётся из каталога по имени/алиасу, иначе — общая.
    db.all("SELECT name FROM tool_categories ORDER BY name COLLATE NOCASE", [], (err, catRows) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка БД' });

      db.all("SELECT category, image_url FROM category_icons", [], (err2, iconRows) => {
        const overrides = {};
        (iconRows || []).forEach(r => { overrides[r.category] = r.image_url; });
        const catalogMap = buildCatalogIconMap();

        const categories = (catRows || []).map(row => {
          const name = row.name;
          const def = defaultIconFor(name, catalogMap);
          const override = overrides[name] || null;
          return {
            category: name,
            default_image: def,
            override_image: override,
            image: override || def,        // эффективная иконка
            is_custom: !!override
          };
        });
        sendJson(res, 200, { success: true, categories });
      });
    });
    return;
  }

  if (method === 'PUT') {
    if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    getJsonBody(req).then(body => {
      const category = String(body.category || '').trim();
      const imageUrl = String(body.image_url || '').trim();
      if (!category || !imageUrl) return sendJson(res, 400, { success: false, message: 'Неверные параметры' });
      if (!isInternalPath(imageUrl)) return sendJson(res, 400, { success: false, message: 'Недопустимый путь картинки' });

      db.get("SELECT 1 FROM tool_categories WHERE name = ?", [category], (kErr, known) => {
        if (kErr) return sendJson(res, 500, { success: false, message: 'Ошибка БД' });
        if (!known) return sendJson(res, 404, { success: false, message: 'Категория не найдена' });

        db.run(
          `INSERT INTO category_icons (category, image_url, updated_by) VALUES (?, ?, ?)
           ON CONFLICT(category) DO UPDATE SET image_url = excluded.image_url, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
          [category, imageUrl, user.id],
          (err) => {
            if (err) return sendJson(res, 500, { success: false, message: 'Ошибка БД' });
            sendJson(res, 200, { success: true, image: imageUrl });
          }
        );
      });
    }).catch(() => sendJson(res, 400, { success: false, message: 'Ошибка запроса' }));
    return;
  }

  if (method === 'DELETE') {
    if (user.role !== 'Superadmin') return sendJson(res, 403, { success: false, message: 'Нет доступа' });
    const category = parsedUrl.searchParams.get('category');
    if (!category) return sendJson(res, 400, { success: false, message: 'Не указана категория' });
    db.run("DELETE FROM category_icons WHERE category = ?", [category], (err) => {
      if (err) return sendJson(res, 500, { success: false, message: 'Ошибка БД' });
      sendJson(res, 200, { success: true });
    });
    return;
  }

  sendJson(res, 405, { success: false, message: 'Метод не поддерживается' });
};
