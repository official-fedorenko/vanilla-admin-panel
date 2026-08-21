/**
 * Переиспользуемый загрузчик каталога электроинструмента.
 *
 * Каталог (tools.json) — независимый источник данных: реальные модели
 * Bosch / DeWalt по категориям. Модуль не зависит от остального проекта,
 * его можно скопировать в любую систему учёта.
 *
 * Пример:
 *   const catalog = require('./data/tool-catalog');
 *   catalog.getCategories();            // ['Перфоратор', 'Шуруповёрт', ...]
 *   catalog.getByCategory('Перфоратор'); // [{brand, model, name, ...}, ...]
 *   catalog.flatten();                  // плоский список всех моделей
 *   catalog.getByBrand('Bosch');        // все модели Bosch
 */

const catalog = require('./tools.json');

function getCategories() {
  return catalog.categories.map(c => c.category);
}

function getBrands() {
  return catalog.brands.slice();
}

// Разворачивает одну модель: добавляет category и image (image берётся
// у самой модели, иначе — картинка категории по умолчанию).
function expand(cat, tool) {
  return { category: cat.category, image: cat.image, ...tool };
}

// Плоский список всех инструментов; каждому добавляется поле category и image.
function flatten() {
  return catalog.categories.flatMap(c => c.tools.map(t => expand(c, t)));
}

function getByCategory(category) {
  const found = catalog.categories.find(
    c => c.category === category || (c.aliases || []).includes(category)
  );
  return found ? found.tools.map(t => expand(found, t)) : [];
}

function getByBrand(brand) {
  const b = String(brand || '').toLowerCase();
  return flatten().filter(t => String(t.brand).toLowerCase() === b);
}

module.exports = {
  raw: catalog,
  schemaVersion: catalog.schemaVersion,
  getCategories,
  getBrands,
  getByCategory,
  getByBrand,
  flatten
};
