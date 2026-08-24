/**
 * Схема полей каталога по категориям — модалка «Добавить модель» адаптивна:
 * для каждой категории показываются свои характеристики.
 *
 * Базовые поля (категория, бренд, модель, название, линейка, картинка) —
 * всегда, задаются в разметке. Здесь — характеристики.
 *
 * Часть полей backed колонками catalog_models (col:true) — они и раньше
 * использовались пикером/каталогом. Остальные (узкоспециальные) хранятся в
 * JSON-поле catalog_models.specs.
 */

// Определения полей. type: text | number | select | checkbox. suggest — подсказки для text.
const FIELD_DEFS = {
  // Колоночные (общие)
  power_type: { label: 'Тип питания', type: 'select', options: [['corded', 'Сетевой'], ['cordless', 'Аккумуляторный']], col: true },
  power_w:    { label: 'Мощность, Вт', type: 'number', col: true },
  voltage_v:  { label: 'Напряжение, В', type: 'number', col: true },
  chuck:      { label: 'Патрон', type: 'text', suggest: ['SDS-plus', 'SDS-max', 'SDS-quick', '13 мм', '10 мм'], col: true },
  disc_mm:    { label: 'Диск, мм', type: 'number', col: true },
  brushless:  { label: 'Бесщёточный', type: 'checkbox', col: true },
  impact:     { label: 'Ударный', type: 'checkbox', col: true },
  // Специальные (JSON specs)
  impact_energy_j: { label: 'Энергия удара, Дж', type: 'number' },
  max_drill_mm:    { label: 'Макс. Ø бурения, мм', type: 'number' },
  bpm:             { label: 'Частота ударов, уд/мин', type: 'number' },
  weight_kg:       { label: 'Вес, кг', type: 'number' }
};

// Набор по умолчанию (для категорий без своей схемы) — прежние общие поля.
const DEFAULT_FIELDS = ['power_type', 'power_w', 'voltage_v', 'chuck', 'disc_mm', 'brushless', 'impact'];

// Переопределения по категориям.
const CATEGORY_FIELDS = {
  'Перфоратор': ['power_type', 'power_w', 'voltage_v', 'chuck', 'impact_energy_j', 'max_drill_mm', 'bpm', 'weight_kg']
};

function fieldKeysFor(category) {
  return CATEGORY_FIELDS[category] || DEFAULT_FIELDS;
}

// Раскрытые определения полей категории (для рендера/валидации).
function fieldsFor(category) {
  return fieldKeysFor(category)
    .filter((k) => FIELD_DEFS[k])
    .map((k) => ({ name: k, ...FIELD_DEFS[k] }));
}

// Ключи колоночных полей категории (backed колонками).
function columnFieldsFor(category) {
  return fieldsFor(category).filter((f) => f.col).map((f) => f.name);
}

// Санитизация значения по типу поля.
function coerce(def, v) {
  if (v == null || v === '') return null;
  if (def.type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (def.type === 'checkbox') return (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;
  if (def.type === 'select') return def.options.some((o) => o[0] === String(v)) ? String(v) : null;
  return String(v).slice(0, 120);
}

// Только специальные (не колоночные) поля категории → объект для specs JSON.
function sanitizeSpecs(category, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  fieldsFor(category).forEach((f) => {
    if (f.col) return; // колоночные поля не в specs
    const val = coerce(f, input[f.name]);
    if (val !== null && val !== '') out[f.name] = val;
  });
  return out;
}

module.exports = { FIELD_DEFS, CATEGORY_FIELDS, DEFAULT_FIELDS, fieldsFor, fieldKeysFor, columnFieldsFor, sanitizeSpecs, coerce };
