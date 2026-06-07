const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(dbPath);

// Хеширование пароля с помощью встроенного модуля pbkdf2
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Проверка пароля
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === originalHash;
}

// Инициализация базы данных
db.serialize(() => {
  // 1. Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'User',
      avatar_url TEXT,
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

  // Создаем администраторов и пользователя по умолчанию, если таблица пуста
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (err) {
      console.error("Ошибка при проверке пользователей:", err);
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
                console.error(`Не удалось создать пользователя ${u.username}:`, err);
              } else {
                console.log(`Создан аккаунт по умолчанию: ${u.username} (${u.role}) с паролем: ${defaultPass}`);
              }
            }
          );
        });
      });
    }
  });

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    // В случае если таблица уже существует, пытаемся добавить колонку (просто игнорируем ошибку, если она уже есть)
    db.run("ALTER TABLE support_messages ADD COLUMN is_read INTEGER DEFAULT 0", () => {});
  });

  // Удаляем старые настройки статистики
  db.run("DELETE FROM settings WHERE key LIKE 'stat_%'");

  // Заполняем настройки сайта
  const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)");
  stmt.run("site_name", "Мой Личный Сайт", "Название вашего веб-ресурса");
  stmt.run("maintenance_mode", "false", "Включить/выключить режим обслуживания");
  stmt.run("allow_registration", "true", "Разрешить самостоятельную регистрацию пользователей");
  stmt.run("hero_title", "Добро пожаловать в блог", "Заголовок главного баннера");
  stmt.run("site_description", "Последние новости, обзоры и статьи от ведущих экспертов индустрии.", "Описание под заголовком баннера");
  stmt.run("about_title", "О нашем блоге", "О блоге: Заголовок раздела");
  stmt.run("about_subtitle", "Кто мы и для чего создали эту платформу", "О блоге: Подзаголовок");
  stmt.run("about_card1_title", "Пишем о главном", "О блоге: Заголовок карточки 1");
  stmt.run("about_card1_text", "Публикуем материалы о веб-разработке, дизайне интерфейсов, системном администрировании и автоматизации процессов.", "О блоге: Текст карточки 1");
  stmt.run("about_card2_title", "Проверенный контент", "О блоге: Заголовок карточки 2");
  stmt.run("about_card2_text", "Все публикации проходят модерацию экспертами, чтобы вы получали только качественную и актуальную информацию.", "О блоге: Текст карточки 2");
  stmt.run("contact_title", "Обратная связь", "Контакты: Заголовок раздела");
  stmt.run("contact_subtitle", "Остались вопросы или хотите предложить сотрудничество?", "Контакты: Подзаголовок");
  stmt.run("contact_email", "info@example.com", "Контакты: Электронная почта");
  stmt.run("contact_address", "г. Москва, ул. Разработчиков, д. 42", "Контакты: Адрес");
  stmt.finalize();

  // Заполняем тестовые статьи
  db.get("SELECT COUNT(*) as count FROM articles", (err, row) => {
    if (!err && row.count === 0) {
      const stmt = db.prepare("INSERT INTO articles (title, content, status) VALUES (?, ?, ?)");
      stmt.run("Добро пожаловать в новую админку!", "Это демонстрационная статья, созданная автоматически для проверки работы CRUD панели.", "published");
      stmt.run("Черновик важной публикации", "Контент этой статьи еще не готов для публикации.", "draft");
      stmt.finalize();
    }
  });
});

module.exports = {
  db,
  hashPassword,
  verifyPassword
};
