const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const logger = require('./src/logger');

// Allows tests to point at an isolated, disposable database file instead of
// the real db.sqlite (which would otherwise get seeded/mutated by every test run).
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbPath);

// Resolves once schema creation + default-data seeding below has finished.
// server.js doesn't wait on this (by the time a real request arrives it's
// long done), but tests that fire requests immediately after startup need it
// to avoid racing the initial seed.
let resolveDbReady;
const dbReady = new Promise((resolve) => { resolveDbReady = resolve; });

// Предустановленный набор известных брендов инструмента с сгенерированными
// плейсхолдер-иконками (монограмма на градиенте, БЕЗ реальных логотипов).
// Иконки лежат в data/tool-catalog/images/brand-*.svg, отдаются тем же
// маршрутом, что и иконки категорий (/catalog/images/*.svg).
const PRESET_BRANDS = [
  { name: 'Bosch', icon_url: '/catalog/images/brand-bosch.svg' },
  { name: 'DeWalt', icon_url: '/catalog/images/brand-dewalt.svg' },
  { name: 'Makita', icon_url: '/catalog/images/brand-makita.svg' },
  { name: 'Metabo', icon_url: '/catalog/images/brand-metabo.svg' },
  { name: 'Hilti', icon_url: '/catalog/images/brand-hilti.svg' },
  { name: 'Milwaukee', icon_url: '/catalog/images/brand-milwaukee.svg' },
  { name: 'Ryobi', icon_url: '/catalog/images/brand-ryobi.svg' },
  { name: 'AEG', icon_url: '/catalog/images/brand-aeg.svg' },
  { name: 'Skil', icon_url: '/catalog/images/brand-skil.svg' },
  { name: 'Interskol', icon_url: '/catalog/images/brand-interskol.svg' },
  { name: 'Einhell', icon_url: '/catalog/images/brand-einhell.svg' },
  { name: 'Sturm', icon_url: '/catalog/images/brand-sturm.svg' },
  { name: 'Зубр', icon_url: '/catalog/images/brand-zubr.svg' },
  { name: 'Bort', icon_url: '/catalog/images/brand-bort.svg' }
];

// === Простая система миграций (для надёжности) ===
const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema + default data',
    up: () => {
      // The existing CREATEs and seeds are run below.
      // This migration is considered applied on first run.
    }
  },
  {
    version: 2,
    description: 'Add image_url to support_messages for chat images',
    up: () => {
      db.run("ALTER TABLE support_messages ADD COLUMN image_url TEXT", () => {});
    }
  },
  {
    version: 3,
    description: 'Add two-factor auth columns to users',
    up: () => {
      db.run("ALTER TABLE users ADD COLUMN two_factor_secret TEXT", () => {});
      db.run("ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0", () => {});
    }
  },
  {
    version: 4,
    description: 'Add account_type to users (client/employee)',
    up: () => {
      // Тип аккаунта: 'client' (клиент компании) или 'employee' (сотрудник).
      // Существующие аккаунты по умолчанию считаем клиентами — админам это
      // поле не мешает (доступ определяется полем role).
      db.run("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'client'", () => {});
    }
  },
  {
    version: 5,
    description: 'Add photo_url to tools',
    up: () => {
      db.run("ALTER TABLE tools ADD COLUMN photo_url TEXT", () => {});
    }
  },
  {
    version: 6,
    description: 'Add category to media',
    up: () => {
      db.run("ALTER TABLE media ADD COLUMN category TEXT NOT NULL DEFAULT 'general'", () => {});
    }
  },
  {
    version: 7,
    description: 'Create tool_photos gallery table',
    up: () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS tool_photos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
          photo_url TEXT NOT NULL,
          uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {});
    }
  },
  {
    version: 8,
    description: 'Add uploaded_by to media',
    up: () => {
      db.run("ALTER TABLE media ADD COLUMN uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL", () => {});
    }
  },
  {
    version: 9,
    description: 'Create category_icons overrides table',
    up: () => {
      // Переопределение стандартной иконки категории инструмента. Ключ —
      // название категории (как в data/tool-catalog). Если записи нет —
      // используется дефолтная иконка из каталога (tools.json).
      db.run(`
        CREATE TABLE IF NOT EXISTS category_icons (
          category TEXT PRIMARY KEY,
          image_url TEXT NOT NULL,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {});
    }
  },
  {
    version: 10,
    description: 'Create tool_requests table (user-submitted, admin-approved)',
    up: () => {
      // Заявки на добавление инструмента от пользователей. Админ одобряет
      // (создаётся запись в tools) или отклоняет. status: pending/approved/rejected.
      db.run(`
        CREATE TABLE IF NOT EXISTS tool_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category TEXT,
          brand TEXT,
          model TEXT,
          serial_number TEXT,
          inventory_number TEXT,
          photo_url TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at DATETIME,
          review_note TEXT,
          created_tool_id INTEGER REFERENCES tools(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {});
    }
  },
  {
    version: 11,
    description: 'Create generic requests table (заявления разных типов)',
    up: () => {
      // Универсальные заявления пользователей: type определяет вид (добавить
      // инструмент, отпуск, увольнение, заказать инструмент …), payload — JSON
      // с полями конкретного типа. Админ одобряет/отклоняет.
      db.run(`
        CREATE TABLE IF NOT EXISTS requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          title TEXT,
          payload TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at DATETIME,
          review_note TEXT,
          result_ref TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {});
    }
  },
  {
    version: 12,
    description: 'Add received_at to requests (сотрудник отметил получение заказа)',
    up: () => {
      // Для заявок type='tool_order': после одобрения сотрудник нажимает
      // «Получил» → проставляется received_at. Пока NULL — заявка «висит».
      db.run("ALTER TABLE requests ADD COLUMN received_at DATETIME", () => {});
    }
  },
  {
    version: 13,
    description: 'Create catalog_models (редактируемый каталог стандартного инструмента) + seed из tools.json',
    up: () => {
      // Стандартный каталог моделей для подсказок при добавлении инструмента
      // (и в админке, и в заявке). Раньше — статичный файл data/tool-catalog;
      // теперь редактируется из админпанели. Сидим первоначальным содержимым.
      db.run(`
        CREATE TABLE IF NOT EXISTS catalog_models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          brand TEXT NOT NULL,
          model TEXT NOT NULL,
          name TEXT,
          line TEXT,
          power_type TEXT,
          power_w INTEGER,
          voltage_v INTEGER,
          brushless INTEGER NOT NULL DEFAULT 0,
          impact INTEGER NOT NULL DEFAULT 0,
          chuck TEXT,
          disc_mm INTEGER,
          image_url TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {
        try {
          const cat = require('./data/tool-catalog');
          const toUrl = (img) => img ? '/catalog/' + String(img).replace(/^\/+/, '') : null;
          const stmt = db.prepare(`INSERT INTO catalog_models
            (category, brand, model, name, line, power_type, power_w, voltage_v, brushless, impact, chuck, disc_mm, image_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          (cat.raw.categories || []).forEach((c) => {
            const catImg = toUrl(c.image);
            (c.tools || []).forEach((t) => {
              stmt.run([
                c.category, t.brand, t.model, t.name || `${t.brand} ${t.model}`,
                t.line || null, t.powerType || null, t.powerW || null, t.voltageV || null,
                t.brushless ? 1 : 0, t.impact ? 1 : 0, t.chuck || null, t.discMm || null,
                t.image ? toUrl(t.image) : catImg
              ]);
            });
          });
          stmt.finalize();
          logger.info('[db] catalog_models засеян из data/tool-catalog');
        } catch (e) {
          logger.error('[db] Не удалось засеять catalog_models:', e.message);
        }
      });
    }
  },
  {
    version: 14,
    description: 'Add specs (JSON) to tools — характеристики по категории',
    up: () => {
      // Характеристики инструмента, зависящие от категории (диск, патрон,
      // мощность, вольтаж…). Хранятся как JSON, набор полей задаёт схема
      // src/toolSpecs.js. NULL/'{}' — характеристик нет.
      db.run("ALTER TABLE tools ADD COLUMN specs TEXT", () => {});
    }
  },
  {
    version: 15,
    description: 'Add specs (JSON) to catalog_models — характеристики модели по категории',
    up: () => {
      // Узкоспециальные характеристики модели каталога, зависящие от категории
      // (энергия удара, Ø бурения…). Общие поля остаются колонками; здесь — JSON.
      db.run("ALTER TABLE catalog_models ADD COLUMN specs TEXT", () => {});
    }
  },
  {
    version: 16,
    description: 'Create brands table (справочник брендов инструмента с иконками) + seed стандартных брендов',
    up: () => {
      // Реестр брендов: id (не name), т.к. бренды свободно добавляются/
      // переименовываются/удаляются пользователем — это первоклассная
      // сущность, а не override поверх фиксированного списка (как
      // category_icons). brand на tools/catalog_models остаётся обычной
      // строкой без FK — удаление бренда из реестра не ломает старые записи.
      db.run(`
        CREATE TABLE IF NOT EXISTS brands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          icon_url TEXT,
          is_preset INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, () => {
        try {
          const stmt = db.prepare(`INSERT OR IGNORE INTO brands (name, icon_url, is_preset) VALUES (?, ?, 1)`);
          PRESET_BRANDS.forEach(b => stmt.run([b.name, b.icon_url]));
          stmt.finalize();
          logger.info('[db] brands засеян стандартным набором');
        } catch (e) {
          logger.error('[db] Не удалось засеять brands:', e.message);
        }
      });
    }
  }
];

function runMigrations() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.get("SELECT MAX(version) as current FROM schema_migrations", (err, row) => {
      const currentVersion = row && row.current ? row.current : 0;

      MIGRATIONS.forEach(migration => {
        if (migration.version > currentVersion) {
          logger.info(`[db] Running migration ${migration.version}: ${migration.description}`);
          migration.up();
          db.run(
            "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
            [migration.version, migration.description]
          );
        }
      });
    });
  });
}

// Хеширование пароля с помощью встроенного модуля pbkdf2
// 1000 → подняли до 120000 итераций для лучшей стойкости (формат хранения не изменился)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Проверка пароля (поддерживает как старые, так и новые хэши)
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  // Если не совпало — попробуем со старыми 1000 итерациями (для существующих аккаунтов)
  if (hash !== originalHash) {
    const oldHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return oldHash === originalHash;
  }
  return true;
}

// Набор тестовых сотрудников (демо). Используется при первичном сиде и
// кнопкой «Добавить/Удалить тестовых сотрудников» в настройках (Superadmin).
const TEST_EMPLOYEES = [
  { username: 'jonas.k',   email: 'jonas.kazlauskas@diamantas.lt',     first: 'Jonas',   last: 'Kazlauskas',   position: 'Электромонтажник', department: 'Монтаж',  phone: '+370 600 11111', hire: '2021-03-15' },
  { username: 'petras.p',  email: 'petras.petrauskas@diamantas.lt',    first: 'Petras',  last: 'Petrauskas',   position: 'Бригадир',         department: 'Монтаж',  phone: '+370 600 22222', hire: '2019-06-01' },
  { username: 'tomas.j',   email: 'tomas.jankauskas@diamantas.lt',     first: 'Tomas',   last: 'Jankauskas',   position: 'Электромонтажник', department: 'Сервис',  phone: '+370 600 33333', hire: '2022-01-10' },
  { username: 'mantas.s',  email: 'mantas.stankevicius@diamantas.lt',  first: 'Mantas',  last: 'Stankevičius', position: 'Монтажник',        department: 'Монтаж',  phone: '+370 600 44444', hire: '2023-09-20' },
  { username: 'andrius.v', email: 'andrius.vasiliauskas@diamantas.lt', first: 'Andrius', last: 'Vasiliauskas', position: 'Мастер участка',   department: 'Монтаж',  phone: '+370 600 55555', hire: '2018-05-05' }
];

// Набор тестовых инструментов (демо). Используется при первичном сиде и
// кнопкой «Добавить/Удалить тестовых инструментов» в настройках (Superadmin).
const TEST_TOOLS = [
  { name: 'Bosch GBH 2-26 DRE', category: 'Перфоратор', brand: 'Bosch', model: 'GBH 2-26 DRE', serial_number: 'BSH-GBH-0001', inventory_number: 'INV-001', photo_url: '/catalog/images/rotary-hammer.svg' },
  { name: 'Bosch GBH 2-28 F', category: 'Перфоратор', brand: 'Bosch', model: 'GBH 2-28 F', serial_number: 'BSH-GBH-0002', inventory_number: 'INV-002', photo_url: '/catalog/images/rotary-hammer.svg' },
  { name: 'DeWalt D25143K', category: 'Перфоратор', brand: 'DeWalt', model: 'D25143K', serial_number: 'DW-D25-0003', inventory_number: 'INV-003', photo_url: '/catalog/images/rotary-hammer.svg' },
  { name: 'Bosch GSR 18V-55', category: 'Шуруповёрт', brand: 'Bosch', model: 'GSR 18V-55', serial_number: 'BSH-GSR-0004', inventory_number: 'INV-004', photo_url: '/catalog/images/drill-driver.svg' },
  { name: 'DeWalt DCD791', category: 'Шуруповёрт', brand: 'DeWalt', model: 'DCD791', serial_number: 'DW-DCD-0005', inventory_number: 'INV-005', photo_url: '/catalog/images/drill-driver.svg' },
  { name: 'Bosch GWS 850', category: 'Углошлифовальная машина (болгарка)', brand: 'Bosch', model: 'GWS 850', serial_number: 'BSH-GWS-0006', inventory_number: 'INV-006', photo_url: '/catalog/images/angle-grinder.svg' },
  { name: 'DeWalt DWE4237', category: 'Углошлифовальная машина (болгарка)', brand: 'DeWalt', model: 'DWE4237', serial_number: 'DW-DWE-0007', inventory_number: 'INV-007', photo_url: '/catalog/images/angle-grinder.svg' },
  { name: 'Bosch GWS 18V-10', category: 'Углошлифовальная машина (болгарка)', brand: 'Bosch', model: 'GWS 18V-10', serial_number: 'BSH-GWS-0008', inventory_number: 'INV-008', photo_url: '/catalog/images/angle-grinder.svg' }
];

// Самолечение: миграция 15 (ALTER TABLE catalog_models ADD COLUMN specs)
// на части инсталляций отметилась применённой, но саму колонку не добавила
// (fire-and-forget ALTER без проверки ошибки). Без неё падает любое
// добавление/изменение модели каталога. Проверяем факт наличия колонки
// напрямую через PRAGMA и досоздаём при необходимости — безопасно и
// идемпотентно, можно гонять на каждом старте.
function ensureCatalogModelsSpecsColumn() {
  db.all("PRAGMA table_info(catalog_models)", (err, rows) => {
    if (err || !rows) return;
    const hasSpecs = rows.some((r) => r.name === 'specs');
    if (!hasSpecs) {
      db.run("ALTER TABLE catalog_models ADD COLUMN specs TEXT", (alterErr) => {
        if (alterErr) logger.error('[db] Не удалось добавить catalog_models.specs:', alterErr.message);
        else logger.info('[db] Восстановлена отсутствовавшая колонка catalog_models.specs');
      });
    }
  });
}

// Инициализация базы данных
db.serialize(() => {
  runMigrations();
  ensureCatalogModelsSpecsColumn();
  // 1. Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'User',
      account_type TEXT NOT NULL DEFAULT 'client',
      avatar_url TEXT,
      two_factor_secret TEXT,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Таблица медиафайлов
  db.run(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Таблица настроек (ключ-значение)
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      description TEXT
    )
  `);

  // 4. Демо-таблица статей для CRUD
  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. Таблица логов действий (Activity Log)
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5a. Таблица сотрудников (учёт персонала компании).
  // user_id — необязательная привязка к учётной записи в users: когда у
  // сотрудника появляется свой вход в кабинет, здесь хранится ссылка на
  // его аккаунт (ON DELETE SET NULL, чтобы удаление аккаунта не удаляло
  // карточку сотрудника). Это фундамент, к которому позже привяжутся
  // инструмент, учёт времени, отпуска и документы.
  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      position TEXT,
      department TEXT,
      phone TEXT,
      email TEXT,
      hire_date DATE,
      status TEXT NOT NULL DEFAULT 'active',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Создаем администраторов и пользователя по умолчанию, если таблица пуста
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (err) {
      logger.error("Ошибка при проверке пользователей:", err);
      return;
    }

    if (row.count === 0) {
      const defaultPass = '1234qwer';
      const hashedPassword = hashPassword(defaultPass);

      const usersToCreate = [
        { username: 'superadmin', email: 'superadmin@example.com', role: 'Superadmin' },
        { username: 'admin', email: 'admin@example.com', role: 'Admin' },
        { username: 'user', email: 'user@example.com', role: 'User' }
      ];

      db.serialize(() => {
        usersToCreate.forEach((u) => {
          db.run(
            "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
            [u.username, u.email, hashedPassword, u.role],
            (err) => {
              if (err) {
                logger.error(`Не удалось создать пользователя ${u.username}:`, err);
              } else {
                logger.info(`Создан аккаунт по умолчанию: ${u.username} (${u.role})`);
              }
            }
          );
        });
      });
    }
  });

  // 5b. Инвентарь инструмента + история закреплений за сотрудниками.
  // Модель «выдача-возврат»: активное закрепление = строка в
  // tool_assignments с returned_at IS NULL. Общая (не под Diamantas)
  // схема — подойдёт любому инвентарю (инструмент, техника, СИЗ).
  db.run(`
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      inventory_number TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      purchase_date DATE,
      photo_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tool_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      returned_at DATETIME,
      issued_by TEXT,
      notes TEXT
    )
  `);

  // Справочник категорий инструмента. is_default=1 — стандартный список
  // (удалять нельзя, чтобы не «разъехался» у всех). Свои категории может
  // добавлять только Superadmin. Список общий, единый для всей базы.
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    const defaults = [
      'Перфоратор', 'Дрель', 'Шуруповёрт', 'Углошлифовальная машина (болгарка)',
      'Отбойный молоток', 'Электролобзик', 'Циркулярная (дисковая) пила',
      'Сабельная пила', 'Штроборез', 'Шлифовальная машина', 'Строительный фен',
      'Строительный миксер', 'Строительный пылесос', 'Сварочный аппарат',
      'Паяльник', 'Мультиметр', 'Пресс-клещи', 'Генератор',
      'Удлинитель на катушке', 'Прожектор LED'
    ];
    const catStmt = db.prepare("INSERT OR IGNORE INTO tool_categories (name, is_default) VALUES (?, 1)");
    defaults.forEach(name => catStmt.run(name));
    catStmt.finalize();
  });

  // Учёт рабочего времени. Пользователь вносит записи (дата + часы + заметка),
  // администраторы видят данные по всем. Одна строка — одна запись за день.
  db.run(`
    CREATE TABLE IF NOT EXISTS work_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      hours REAL NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 6. Таблица сообщений техподдержки / обратной связи (Чат)
  db.run(`
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      user_id INTEGER,
      name TEXT,
      email TEXT,
      message TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    db.run("ALTER TABLE support_messages ADD COLUMN is_read INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE support_messages ADD COLUMN image_url TEXT", () => {});
  });

  // 7. Простая таблица сессий (для надёжности — переживают перезапуск сервера)
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      expires_at DATETIME
    )
  `);

  // Удаляем старые настройки статистики
  db.run("DELETE FROM settings WHERE key LIKE 'stat_%'");

  // Заполняем настройки сайта
  const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)");
  stmt.run("site_name", "UAB Diamantas", "Название вашего веб-ресурса");
  stmt.run("maintenance_mode", "false", "Включить/выключить режим обслуживания");
  stmt.run("allow_registration", "true", "Разрешить самостоятельную регистрацию пользователей");
  stmt.run("hero_title", "UAB Diamantas — учёт компании", "Заголовок главного баннера");
  stmt.run("site_description", "Внутренняя система учёта сотрудников, электроинструмента, времени, отпусков и документов.", "Описание под заголовком баннера");
  stmt.run("about_title", "О нашем блоге", "О блоге: Заголовок раздела");
  stmt.run("about_subtitle", "Кто мы и для чего создали эту платформу", "О блоге: Подзаголовок");
  stmt.run("about_card1_title", "Пишем о главном", "О блоге: Заголовок карточки 1");
  stmt.run("about_card1_text", "Публикуем материалы о веб-разработке, дизайне интерфейсов, системном администрировании и автоматизации процессов.", "О блоге: Текст карточки 1");
  stmt.run("about_card2_title", "Проверенный контент", "О блоге: Заголовок карточки 2");
  stmt.run("about_card2_text", "Все публикации проходят модерацию экспертами, чтобы вы получали только качественную и актуальную информацию.", "О блоге: Текст карточки 2");
  stmt.run("contact_title", "Обратная связь", "Контакты: Заголовок раздела");
  stmt.run("contact_subtitle", "Остались вопросы или хотите предложить сотрудничество?", "Контакты: Подзаголовок");
  stmt.run("contact_email", "info@example.com", "Контакты: Электронная почта");
  stmt.run("contact_address", "г. Вильнюс, ул. Разработчиков, д. 42", "Контакты: Адрес");
  // Публичная карточка инструмента (общие настройки для всех QR-карточек)
  stmt.run("public_card_enabled", "true", "Публичная карточка: доступна всем по QR");
  stmt.run("public_card_show_photo", "true", "Публичная карточка: показывать фото");
  stmt.run("public_card_show_brand", "true", "Публичная карточка: показывать бренд");
  stmt.run("public_card_show_model", "true", "Публичная карточка: показывать модель");
  stmt.run("public_card_show_serial", "true", "Публичная карточка: показывать серийный №");
  stmt.run("public_card_show_inventory", "true", "Публичная карточка: показывать инвентарный №");
  stmt.run("public_card_show_status", "true", "Публичная карточка: показывать статус");
  stmt.run("public_card_show_category", "true", "Публичная карточка: показывать категорию");
  stmt.run("public_card_show_purchase_date", "false", "Публичная карточка: показывать дату покупки");
  stmt.run("public_card_show_notes", "false", "Публичная карточка: показывать заметки");
  stmt.finalize();

  // Заполняем тестовые статьи
  db.get("SELECT COUNT(*) as count FROM articles", (err, row) => {
    if (!err && row.count === 0) {
      const stmt = db.prepare("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)");
      stmt.run("Добро пожаловать в новую админку!", "Это демонстрационная статья, созданная автоматически для проверки работы CRUD панели.", "published");
      stmt.run("Черновик важной публикации", "Контент этой статьи еще не готов для публикации.", "draft");
      stmt.finalize(resolveDbReady);
    } else {
      resolveDbReady();
    }
  });

  // Тестовые сотрудники и тестовый инструмент больше НЕ добавляются
  // автоматически при старте на свежей БД. Используйте кнопки
  // «Добавить тестовых сотрудников» / «Добавить тестовые инструменты»
  // в настройках (Superadmin) — см. src/routes/testEmployees.js
  // и src/routes/testTools.js.
});

// === Простые helpers для персистентных сессий (надёжность) ===
function saveSession(token, user, ttlHours = 24) {
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.run(
    "INSERT OR REPLACE INTO sessions (token, user_id, username, role, expires_at) VALUES (?, ?, ?, ?, ?)",
    [token, user.id, user.username, user.role, expires]
  );
}

function loadSessionsIntoMap(sessionsMap) {
  db.all("SELECT * FROM sessions WHERE expires_at > datetime('now')", [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach(row => {
      sessionsMap.set(row.token, {
        id: row.user_id,
        username: row.username,
        role: row.role
      });
    });
    if (rows.length) logger.info(`[sessions] Восстановлено ${rows.length} сессий из БД`);
  });
}

function deleteSession(token) {
  db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

function cleanupExpiredSessions() {
  db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
}

module.exports = {
  db,
  dbPath,
  dbReady,
  TEST_EMPLOYEES,
  TEST_TOOLS,
  hashPassword,
  verifyPassword,
  saveSession,
  loadSessionsIntoMap,
  deleteSession,
  cleanupExpiredSessions
};
