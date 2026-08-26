// Must run before any other require — modules like src/config.js and
// src/routes/auth.js read process.env at load time, so .env has to be
// populated first or those reads silently see undefined.
require('dotenv').config({ quiet: true });

const http = require('http');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const logger = require('./src/logger');

// === Modular route handlers (light split from monolithic server.js) ===
const { sendJson } = require('./src/utils');
const { getSessionUser } = require('./src/session');
const handleDashboard = require('./src/routes/dashboard');
const handleArticles = require('./src/routes/articles');
const handleMedia = require('./src/routes/media');
const handleSettings = require('./src/routes/settings');
const handleSupport = require('./src/routes/support');
const handleDirectMessages = require('./src/routes/directMessages');
const handleUsers = require('./src/routes/users');
const handleEmployees = require('./src/routes/employees');
const handleTools = require('./src/routes/tools');
const handleVehicles = require('./src/routes/vehicles');
const handleApartments = require('./src/routes/apartments');
const handleToolCatalog = require('./src/routes/toolCatalog');
const handleCatalogModels = require('./src/routes/catalogModels');
const handleCategoryIcons = require('./src/routes/categoryIcons');
const handleBrands = require('./src/routes/brands');
const handleNotifications = require('./src/routes/notifications');
const handleRequests = require('./src/routes/requests');
const handleWorklogs = require('./src/routes/worklogs');
const handleStandardAvatars = require('./src/routes/standardAvatars');
const handleLogs = require('./src/routes/logs');
const handleResetDemo = require('./src/routes/resetDemo');
const handleTestEmployees = require('./src/routes/testEmployees');
const handleTestTools = require('./src/routes/testTools');
const handleBackup = require('./src/routes/backup');
const handleTwoFactor = require('./src/routes/twoFactor');
const handleAuth = require('./src/routes/auth');
const handleCabinet = require('./src/routes/cabinet');
const handlePublic = require('./src/routes/public');

const PORT = parseInt(process.env.PORT, 10) || 3080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLIENT_DIR = path.join(__dirname, 'client');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

// HTML отдаём без кэша (доступ зависит от сессии: логин/редиректы),
// статичные ассеты — с умеренным кэшем и обязательной ревалидацией,
// т.к. у файлов нет версионирования в имени (cache-busting).
// .js/.css тоже отдаём без кэша: у файлов нет версионирования в имени, а
// панель активно дорабатывается — иначе браузер показывает устаревший
// app.js/style.css из кэша (до часа) и «кнопки не работают».
const NO_CACHE_EXTENSIONS = new Set(['.html', '.js', '.css']);
const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';
const NO_CACHE_CONTROL = 'no-cache';

function getStaticCacheControl(ext) {
  return NO_CACHE_EXTENSIONS.has(ext) ? NO_CACHE_CONTROL : STATIC_ASSET_CACHE_CONTROL;
}

// Авто-версионирование ассетов (cache-busting без ручного бампа ?v=).
// При отдаче HTML подставляем в ссылки на локальные .js/.css параметр
// ?v=<время изменения файла>. Меняется файл → меняется URL → браузер
// гарантированно берёт свежую версию. Забывать про ручной ?v= больше не нужно.
function assetVersion(filePath) {
  try { return Math.floor(fs.statSync(filePath).mtimeMs).toString(36); }
  catch (e) { return null; }
}
function injectAssetVersions(html, baseDir) {
  return html.replace(
    /((?:src|href)=")([^"?#]+\.(?:js|css))(?:\?[^"#]*)?(#[^"]*)?(")/g,
    (match, pre, assetPath, hash, post) => {
      // Внешние ссылки (CDN) не трогаем.
      if (/^(?:https?:)?\/\//.test(assetPath)) return match;
      const abs = path.join(baseDir, assetPath.replace(/^\//, ''));
      const v = assetVersion(abs);
      return v ? `${pre}${assetPath}?v=${v}${hash || ''}${post}` : match;
    }
  );
}

// === Settings cache (for maintenance_mode etc) + helpers ===
let cachedSettings = {};

function reloadSettingsCache() {
  db.all("SELECT key, value FROM settings", [], (err, rows) => {
    if (!err && rows) {
      cachedSettings = {};
      rows.forEach(r => { cachedSettings[r.key] = r.value; });
    }
  });
}
reloadSettingsCache();

// === Базовые security-заголовки (применяются ко всем ответам) ===
// Внимание: страницы используют инлайн onclick="" и style="", а также
// подключают Quill/Lucide с CDN, поэтому 'unsafe-inline' для script/style
// оставлен осознанно — полностью убрать его можно только после рефакторинга
// фронтенда на addEventListener и внешние стили.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com https://cdn.quilljs.com 'unsafe-inline'",
  "style-src 'self' https://cdn.quilljs.com 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'"
].join('; ');

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
}

function sendHtml404(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Страница не найдена</title><style>body{font-family:Inter,system-ui,sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{text-align:center;padding:48px 32px;background:rgba(20,20,28,.85);border:1px solid rgba(255,255,255,.08);border-radius:20px;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.5)}.code{font-size:96px;font-weight:800;line-height:1;margin:0 0 8px;background:linear-gradient(135deg,#8a2be2,#00d2ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.msg{color:#a0a0ab;margin-bottom:28px;font-size:15px} .links a{color:#00d2ff;text-decoration:none;margin:0 8px} .links a:hover{text-decoration:underline}</style></head><body><div class="box"><div class="code">404</div><div class="msg">Страница не найдена или была перемещена</div><div class="links"><a href="/">На главную</a><a href="/admin/">В админ-панель</a></div></div></body></html>`);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  applySecurityHeaders(res);

  // Страницы сами объявляют свою иконку через <link rel="icon" data:...>,
  // отдельного favicon.ico в проекте нет — отвечаем тихо, без шумных 404 в логах.
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Basic global error boundary for uncaught errors in handlers
  try {

  const user = getSessionUser(req);

  // Maintenance mode — affects public visitors (admins always have access)
  const isMaintenance = cachedSettings['maintenance_mode'] === 'true';
  const isPublicNonApi = !pathname.startsWith('/admin') &&
                         !pathname.startsWith('/api/') &&
                         !pathname.startsWith('/uploads/') &&
                         pathname !== '/favicon.ico';

  if (isMaintenance && !user && isPublicNonApi) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>На обслуживании</title><style>body{font-family:Inter,system-ui,sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.m{padding:48px 40px;background:rgba(20,20,28,.85);border:1px solid rgba(255,255,255,.08);border-radius:20px;text-align:center;max-width:420px}.icon{font-size:48px;margin-bottom:12px}.title{font-size:22px;font-weight:700;margin-bottom:8px;color:#ff6b6b}.desc{color:#a0a0ab;font-size:14px;line-height:1.5} .admin-link{color:#00d2ff;text-decoration:none} .admin-link:hover{text-decoration:underline}</style></head><body><div class="m"><div class="icon">🛠️</div><div class="title">Технические работы</div><div class="desc">Сайт временно недоступен для посетителей.<br>Администраторы могут войти через панель управления.</div><div style="margin-top:20px"><a class="admin-link" href="/admin/">Перейти в админ-панель →</a></div></div></body></html>`);
    return;
  }

  // Public articles/settings (read-only, no auth)
  if (pathname.startsWith('/api/public/')) {
    return handlePublic(req, res, parsedUrl, method);
  }

  // Auth (login/2FA/register/logout/me)
  if (pathname.startsWith('/api/auth/')) {
    return handleAuth(req, res, user, parsedUrl, method);
  }

  // Cabinet (own profile / мой инструмент / моё авто — needed for cabinet.html after login)
  if (pathname === '/api/cabinet/me' || pathname === '/api/cabinet/profile' ||
      pathname === '/api/cabinet/my-card' ||
      pathname === '/api/cabinet/my-tools' || pathname === '/api/cabinet/tool-photo' ||
      pathname === '/api/cabinet/my-vehicles' || pathname === '/api/cabinet/vehicle-photo' ||
      pathname === '/api/cabinet/my-apartment') {
    return handleCabinet(req, res, user, parsedUrl, method);
  }

  // === Full admin API handlers ===

  // Dashboard stats
  if (pathname === '/api/dashboard/stats' && method === 'GET') {
    return handleDashboard(req, res, user);
  }

  // CRUD articles
  if (pathname.startsWith('/api/crud/articles')) {
    return handleArticles(req, res, user, parsedUrl, method);
  }

  // CRUD employees (учёт сотрудников)
  if (pathname.startsWith('/api/crud/employees')) {
    return handleEmployees(req, res, user, parsedUrl, method);
  }

  // Инструмент: CRUD инвентаря + выдача/возврат/история + справочник категорий
  if (pathname.startsWith('/api/crud/tools') || pathname.startsWith('/api/tools/') ||
      pathname.startsWith('/api/crud/tool-categories')) {
    return handleTools(req, res, user, parsedUrl, method);
  }

  // Автопарк: CRUD инвентаря транспорта + выдача/возврат/история + справочник типов
  if (pathname.startsWith('/api/crud/vehicles') || pathname.startsWith('/api/vehicles/') ||
      pathname.startsWith('/api/crud/vehicle-categories')) {
    return handleVehicles(req, res, user, parsedUrl, method);
  }

  // Квартиры: CRUD жилья + закрепление/освобождение/история + справочник типов
  if (pathname.startsWith('/api/crud/apartments') || pathname.startsWith('/api/apartments/') ||
      pathname.startsWith('/api/crud/apartment-categories')) {
    return handleApartments(req, res, user, parsedUrl, method);
  }

  // Справочник моделей (стандартный каталог) для подсказок при добавлении инструмента
  if (pathname === '/api/tool-catalog' && method === 'GET') {
    return handleToolCatalog(req, res, user);
  }

  // Управление стандартным каталогом инструмента (Superadmin для изменений)
  if (pathname === '/api/catalog-models' || pathname === '/api/catalog-models/clear') {
    return handleCatalogModels(req, res, user, parsedUrl, method);
  }

  // Схема полей каталога по категориям (для адаптивной модалки)
  if (pathname === '/api/catalog-schema' && method === 'GET') {
    if (!user) return sendJson(res, 401, { success: false, message: 'Неавторизован' });
    const { FIELD_DEFS, CATEGORY_FIELDS, DEFAULT_FIELDS } = require('./src/catalogSchema');
    return sendJson(res, 200, { success: true, fieldDefs: FIELD_DEFS, categoryFields: CATEGORY_FIELDS, defaultFields: DEFAULT_FIELDS });
  }


  // Универсальные заявления (пользователь создаёт, админ одобряет)
  if (pathname === '/api/request-types' || pathname.startsWith('/api/requests')) {
    return handleRequests(req, res, user, parsedUrl, method);
  }

  // Учёт рабочего времени (пользователь вносит свои часы, админ видит всех)
  if (pathname.startsWith('/api/worklogs')) {
    return handleWorklogs(req, res, user, parsedUrl, method);
  }

  // Media
  if (pathname === '/api/media') {
    return handleMedia(req, res, user, parsedUrl, method, { UPLOADS_DIR });
  }

  // Иконки категорий инструментов (просмотр / переопределение)
  if (pathname === '/api/category-icons') {
    return handleCategoryIcons(req, res, user, parsedUrl, method);
  }

  // Реестр брендов инструмента с иконками
  if (pathname === '/api/brands') {
    return handleBrands(req, res, user, parsedUrl, method);
  }

  // Внутренние уведомления от администрации (личный кабинет + отправка из админки)
  if (pathname.startsWith('/api/cabinet/notifications') || pathname.startsWith('/api/admin/notifications')) {
    return handleNotifications(req, res, user, parsedUrl, method);
  }

  // Стандартные (предустановленные) аватары
  if (pathname === '/api/standard-avatars' && method === 'GET') {
    return handleStandardAvatars(req, res, user);
  }

  // Settings
  if (pathname === '/api/settings') {
    return handleSettings(req, res, user, parsedUrl, method, { reloadSettingsCache });
  }

  // Support
  if (pathname.startsWith('/api/support/')) {
    return handleSupport(req, res, user, parsedUrl, method);
  }

  // Личные чаты между сотрудниками
  if (pathname.startsWith('/api/dm/')) {
    return handleDirectMessages(req, res, user, parsedUrl, method);
  }

  // Two-factor authentication (setup/verify/disable/status)
  if (pathname.startsWith('/api/cabinet/2fa/')) {
    return handleTwoFactor(req, res, user, parsedUrl, method);
  }

  // Users (superadmin only)
  if (pathname === '/api/users') {
    return handleUsers(req, res, user, parsedUrl, method);
  }

  // Logs
  if (pathname === '/api/logs') {
    return handleLogs(req, res, user, parsedUrl, method);
  }

  // Superadmin-only: reset demo data
  if (pathname === '/api/admin/reset-demo' && method === 'POST') {
    return handleResetDemo(req, res, user, parsedUrl, method, { UPLOADS_DIR, reloadSettingsCache });
  }

  // Тестовые сотрудники (добавить/удалить) — только Superadmin
  if (pathname.startsWith('/api/admin/test-employees/')) {
    return handleTestEmployees(req, res, user, parsedUrl, method);
  }

  // Тестовые инструменты (добавить/удалить) — только Superadmin
  if (pathname.startsWith('/api/admin/test-tools/')) {
    return handleTestTools(req, res, user, parsedUrl, method);
  }

  // Полная очистка каталога инструментов (включая реальные записи) — только Superadmin
  if (pathname.startsWith('/api/admin/tools-catalog/')) {
    return handleTestTools(req, res, user, parsedUrl, method);
  }

  // Superadmin-only: download a full backup of the SQLite database
  if (pathname === '/api/admin/backup' && method === 'GET') {
    return handleBackup(req, res, user, parsedUrl, method);
  }

  // Other API fall to 404 for now
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { success: false, message: 'API endpoint не найден' });
  }

  // Serve catalog category images (SVG) from data/tool-catalog/images.
  // Только .svg, имя файла жёстко валидируется (без обхода каталога).
  if (pathname.startsWith('/catalog/images/')) {
    const rel = pathname.replace('/catalog/images/', '');
    if (!/^[A-Za-z0-9._-]+\.svg$/.test(rel)) {
      return sendHtml404(res);
    }
    const fullPath = path.join(__dirname, 'data', 'tool-catalog', 'images', rel);
    fs.access(fullPath, fs.constants.F_OK, (err) => {
      if (err) return sendHtml404(res);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    return;
  }

  // Serve uploaded media files (avatars, article images, media library URLs)
  // This was missing — files were saved but 404 on direct access
  if (pathname.startsWith('/uploads/')) {
    const rel = pathname.replace(/^\/uploads\//, '');
    const fullPath = path.join(UPLOADS_DIR, rel);

    fs.access(fullPath, fs.constants.F_OK, (err) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Файл не найден (404)');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      fs.createReadStream(fullPath).pipe(res);
    });
    return;
  }

  // Static files
  let fullStaticPath;
  let staticPath = pathname;

  if (pathname.startsWith('/admin')) {
    staticPath = pathname.replace('/admin', '') || '/index.html';
    if (staticPath === '/') staticPath = '/index.html';
    fullStaticPath = path.join(PUBLIC_DIR, staticPath);

    if (staticPath.endsWith('.html') || staticPath === '/index.html') {
      if (!user && staticPath !== '/login.html') {
        res.writeHead(302, { 'Location': '/admin/login.html' });
        res.end();
        return;
      }
      // В админку пускаем только Admin/Superadmin. Обычного пользователя
      // (role User) отправляем в его кабинет — смотреть админку он не должен.
      const isAdmin = user && (user.role === 'Admin' || user.role === 'Superadmin');
      if (user && !isAdmin && staticPath !== '/login.html') {
        res.writeHead(302, { 'Location': '/cabinet.html' });
        res.end();
        return;
      }
      if (user && staticPath === '/login.html') {
        res.writeHead(302, { 'Location': isAdmin ? '/admin/' : '/cabinet.html' });
        res.end();
        return;
      }
    }
  } else {
    staticPath = pathname === '/' ? '/index.html' : pathname;
    fullStaticPath = path.join(CLIENT_DIR, staticPath);
  }

  fs.access(fullStaticPath, fs.constants.F_OK, (err) => {
    if (err) {
      sendHtml404(res);
      return;
    }

    const ext = path.extname(fullStaticPath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    // HTML читаем и подставляем свежие версии ассетов (авто cache-busting).
    if (ext === '.html') {
      fs.readFile(fullStaticPath, 'utf8', (rErr, html) => {
        if (rErr) { sendHtml404(res); return; }
        const out = injectAssetVersions(html, path.dirname(fullStaticPath));
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': getStaticCacheControl(ext)
        });
        res.end(out);
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': getStaticCacheControl(ext)
    });
    fs.createReadStream(fullStaticPath).pipe(res);
  });

  } catch (err) {
    logger.error('Unhandled error in request handler:', err);
    try {
      sendJson(res, 500, { success: false, message: 'Internal server error' });
    } catch (_) {
      // last resort
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Internal server error' }));
      }
    }
  }
});

// Only auto-listen when run directly (`node server.js` / npm start). When
// required from a test file, require.main !== module, so tests can bind
// their own ephemeral port via server.listen(0) instead.
if (require.main === module) {
  // Держим статус сотрудника ('в отпуске'/'на больничном') в синхроне с
  // одобренными заявлениями — не только по событию (одобрение/правка), но и
  // на случай, если период просто наступил/закончился без каких-либо
  // действий администратора в этот день.
  handleRequests.syncEmployeeLeaveStatuses();
  setInterval(() => handleRequests.syncEmployeeLeaveStatuses(), 60 * 60 * 1000).unref();

  server.listen(PORT, () => {
    console.log(`Админка успешно запущена на http://localhost:${PORT}`);
    console.log('='.repeat(70));
    console.log('🚨  BETA RELEASE — SECURITY WARNING');
    console.log('   Default accounts are EXTREMELY insecure. Change passwords IMMEDIATELY:');
    console.log('');
    console.log('     superadmin / 1234qwer   (Superadmin — полный доступ)');
    console.log('     admin      / 1234qwer   (Admin)');
    console.log('     user       / 1234qwer   (User)');
    console.log('');
    console.log('   Recommended first actions:');
    console.log('     1. Login as superadmin');
    console.log('     2. Go to "Пользователи" (Users) and change ALL passwords');
    console.log('     3. (Optional) Disable registration in Settings');
    console.log('');
    console.log('   To completely reset the database:');
    console.log('     1. Stop the server');
    console.log('     2. Delete db.sqlite');
    console.log('     3. Restart (fresh DB with only the 3 default accounts above)');
    console.log('        Test employees/tools can be added via Settings buttons (Superadmin)');
    console.log('');
    console.log('   Never expose this directly to the internet without a reverse proxy + HTTPS.');
    console.log('='.repeat(70));
  });
}

module.exports = server;
