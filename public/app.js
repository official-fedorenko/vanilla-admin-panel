// Configuration & State
let currentUser = null;
let articles = [];
let quill = null;
let usersList = [];
let fullLogsList = [];
let employeesList = [];
let toolsList = [];
let toolCategories = [];
let catalogData = null;        // {categories:[{category, models:[...]}]}
let catalogFlat = [];          // плоский список моделей для рендера/выбора
let catalogActiveFilter = '*'; // текущий фильтр категории в пикере

// DOM Elements
const sections = document.querySelectorAll('.app-section');
const navItems = document.querySelectorAll('.nav-list .nav-item');
const toastContainer = document.getElementById('toastContainer');

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  await checkSession();
  setupNavigation();
  initApp();
  handleToolDeepLink();

  // Create icons
  try {
    if (typeof lucide !== 'undefined') lucide.createIcons();
  } catch (e) {
    console.warn('Lucide icons failed to load:', e);
  }
});

// Toast notification helper
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}"></i>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);
  lucide.createIcons({attrs: {'stroke-width': 2}});
  
  setTimeout(() => toast.classList.add('show'), 10);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// Session Check
async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/admin/login.html';
      return;
    }
    const data = await res.json();
    currentUser = data.user;
    
    // Update sidebar profile
    document.getElementById('userDisplay').textContent = currentUser.username;
    document.getElementById('roleDisplay').textContent = currentUser.role === 'Superadmin' ? 'Суперадмин' : (currentUser.role === 'Admin' ? 'Администратор' : 'Редактор');
    document.getElementById('avatarLetter').textContent = currentUser.username.charAt(0).toUpperCase();

    // Show Superadmin-only sections
    if (currentUser.role === 'Superadmin') {
      document.querySelectorAll('.superadmin-only').forEach(el => {
        el.style.display = 'block';
      });
      const resetBox = document.getElementById('resetDemoBox');
      if (resetBox) resetBox.style.display = 'block';
      const backupBox = document.getElementById('backupBox');
      if (backupBox) backupBox.style.display = 'block';
    }
  } catch (err) {
    console.error('Session check error:', err);
    window.location.href = '/admin/login.html';
  }
}

// SPA Routing / Navigation
function setupNavigation() {
  const handleHashChange = () => {
    const hash = window.location.hash.replace('#', '') || 'articles';
    let targetSection = document.getElementById(`section-${hash}`);
    
    if (!targetSection) {
      targetSection = document.getElementById('section-dashboard');
    }
    
    // Toggle active section
    sections.forEach(sec => sec.classList.remove('active'));
    targetSection.classList.add('active');
    
    // Toggle active sidebar item
    navItems.forEach(item => {
      item.classList.remove('active');
      if (item.getAttribute('data-section') === hash) {
        item.classList.add('active');
      }
    });

    // Load section data
    loadSectionData(hash);

    if (hash === 'articles') {
      loadDashboardStats();
    }
  };

  window.addEventListener('hashchange', handleHashChange);
  
  // Set initial page state if hash is present
  if (window.location.hash) {
    handleHashChange();
  } else {
    window.location.hash = '#articles';
  }
}

// Global App Event Listeners & Startup
function initApp() {
  // Initialize Quill Editor
  // Quill грузится с внешнего CDN — если он недоступен (блокировка, сбой
  // сети, медленное соединение), новый Quill() бросает исключение. Без
  // try/catch это необработанное исключение остановило бы выполнение всей
  // initApp() и оставило бы без обработчиков всё, что настраивается ниже
  // (модалку пользователей, поиск, drag&drop загрузку и т.д.) — поэтому
  // ошибка отсюда не должна "ронять" остальную инициализацию.
  if (document.getElementById('quillEditor')) {
    try {
      if (typeof Quill === 'undefined') throw new Error('Quill script failed to load');
      quill = new Quill('#quillEditor', {
        theme: 'snow',
        modules: {
          toolbar: {
            container: [
              [{ 'header': [1, 2, 3, false] }],
              ['bold', 'italic', 'underline', 'strike'],
              ['blockquote', 'code-block'],
              [{ 'list': 'ordered'}, { 'list': 'bullet' }],
              ['link', 'image'],
              ['clean']
            ],
            handlers: {
              image: function() {
                if (window.openMediaPicker) {
                  window.openMediaPicker((url) => {
                    const range = this.quill.getSelection() || { index: this.quill.getLength() };
                    this.quill.insertEmbed(range.index, 'image', url);
                  }, 'articles');
                } else {
                  const url = prompt('Введите URL изображения:');
                  if (url) {
                    const range = this.quill.getSelection() || { index: this.quill.getLength() };
                    this.quill.insertEmbed(range.index, 'image', url);
                  }
                }
              }
            }
          }
        }
      });
    } catch (e) {
      console.warn('Не удалось инициализировать редактор Quill, используется обычное текстовое поле:', e);
      quill = null;

      // Делаем скрытое поле контента видимым textarea, чтобы статьи
      // всё равно можно было редактировать без rich-текстового редактора.
      const editorDiv = document.getElementById('quillEditor');
      const hiddenInput = document.getElementById('articleContent');
      if (editorDiv && hiddenInput) {
        const textarea = document.createElement('textarea');
        textarea.id = 'articleContent';
        textarea.className = 'form-control';
        textarea.rows = 8;
        textarea.value = hiddenInput.value || '';
        editorDiv.replaceWith(textarea);
        hiddenInput.remove();
      }
    }
  }

  // Logout Button
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        showToast('Вы вышли из системы', 'success');
        setTimeout(() => window.location.href = '/admin/login.html', 500);
      }
    } catch (err) {
      showToast('Ошибка при выходе', 'error');
    }
  });

  // Articles Search
  const crudSearch = document.getElementById('crudSearch');
  if (crudSearch) {
    crudSearch.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      renderArticles(query);
    });
  }

  // Загружаем статистику для "дашборда" на главной странице статей
  loadDashboardStats();

  // Счётчик ожидающих заявок на инструмент (бейдж в меню)
  updateRequestsBadge();

  // Счётчик непрочитанных сообщений поддержки (бейдж в меню) + лёгкий опрос,
  // чтобы цифра появлялась даже когда админ не в разделе «Обратная связь».
  updateSupportBadge();
  setInterval(updateSupportBadge, 15000);

  // Modal Setup
  const modal = document.getElementById('articleModalOverlay');
  const addBtn = document.getElementById('addArticleBtn');
  const cancelBtn = document.getElementById('cancelModalBtn');
  const closeBtn = document.getElementById('closeModalBtn');
  const articleForm = document.getElementById('articleForm');

  const openModal = (title = 'Добавить статью', id = '', artTitle = '', artContent = '', artStatus = 'draft') => {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('articleId').value = id;
    document.getElementById('articleTitle').value = artTitle;
    if (quill) {
      quill.root.innerHTML = artContent || '';
    } else {
      document.getElementById('articleContent').value = artContent;
    }
    document.getElementById('articleStatus').value = artStatus;
    modal.classList.add('active');
  };

  const closeModal = () => {
    modal.classList.remove('active');
    articleForm.reset();
  };

  addBtn.addEventListener('click', () => openModal());
  cancelBtn.addEventListener('click', closeModal);
  closeBtn.addEventListener('click', closeModal);

  // CRUD Save handler
  articleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('articleId').value;
    const title = document.getElementById('articleTitle').value;
    const content = quill ? quill.root.innerHTML : document.getElementById('articleContent').value;
    const status = document.getElementById('articleStatus').value;

    const payload = { title, content, status };
    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/crud/articles?id=${id}` : '/api/crud/articles';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        showToast(id ? 'Статья успешно обновлена' : 'Статья создана', 'success');
        closeModal();
        await loadArticles();
      } else {
        const errData = await res.json();
        showToast(errData.message || 'Ошибка сохранения', 'error');
      }
    } catch (err) {
      showToast('Ошибка при сохранении статьи', 'error');
    }
  });

  // Preview button
  const previewBtn = document.getElementById('previewArticleBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      const title = document.getElementById('articleTitle').value || 'Без названия';
      const content = quill ? quill.root.innerHTML : (document.getElementById('articleContent')?.value || '');
      const status = document.getElementById('articleStatus').value;

      const previewWindow = window.open('', '_blank', 'width=900,height=700');
      previewWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Предпросмотр: ${escapeHtml(title)}</title>
          <style>
            body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.7; }
            h1 { border-bottom: 1px solid #eee; padding-bottom: 10px; }
            .meta { color: #666; font-size: 14px; margin-bottom: 30px; }
            .content { font-size: 16px; }
            .content img { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <div class="meta">Статус: <strong>${status}</strong> • Предпросмотр</div>
          <h1>${escapeHtml(title)}</h1>
          <div class="content">${content}</div>
        </body>
        </html>
      `);
      previewWindow.document.close();
    });
  }

  // Media File Manager Upload Setup
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  dropZone.addEventListener('click', (e) => {
    // Не открываем диалог выбора файла, если кликнули по выпадающему списку
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
    fileInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      const category = document.getElementById('uploadCategorySelect').value;
      uploadFiles(e.dataTransfer.files, category);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      const category = document.getElementById('uploadCategorySelect').value;
      uploadFiles(e.target.files, category);
    }
  });

  // Settings Save handler (поддерживает input, textarea, checkbox)
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const container = document.getElementById('settingsContainer');
    const settings = {};

    // Собираем обычные input и textarea
    container.querySelectorAll('input[type="text"], input[type="email"], textarea').forEach(el => {
      settings[el.name] = el.value;
    });

    // Чекбоксы (boolean настройки)
    container.querySelectorAll('input[type="checkbox"]').forEach(el => {
      settings[el.name] = el.checked ? 'true' : 'false';
    });

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      if (res.ok) {
        showToast('Настройки сайта сохранены!', 'success');
      } else {
        showToast('Не удалось сохранить настройки', 'error');
      }
    } catch (err) {
      showToast('Ошибка при сохранении настроек', 'error');
    }
  });

  // Demo reset button (superadmin only)
  const resetBox = document.getElementById('resetDemoBox');
  const resetBtn = document.getElementById('resetDemoBtn');
  if (resetBox && resetBtn) {
    // Will be shown by checkSession for Superadmin (we toggle here too for safety)
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Сбросить все демо-данные? Это действие необратимо.')) return;
      try {
        const res = await fetch('/api/admin/reset-demo', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Демо-данные сброшены. Обновляю...', 'success');
          setTimeout(() => {
            window.location.reload();
          }, 800);
        } else {
          showToast(data.message || 'Не удалось сбросить', 'error');
        }
      } catch (e) {
        showToast('Ошибка сети при сбросе', 'error');
      }
    });
  }

  // Users Search
  const usersSearch = document.getElementById('usersSearch');
  if (usersSearch) {
    usersSearch.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      renderUsers(query);
    });
  }

  // Logs Search
  const logsSearch = document.getElementById('logsSearch');
  if (logsSearch) {
    logsSearch.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      renderFullLogs(query);
    });
  }

  // User Modal Setup
  const userModal = document.getElementById('userModalOverlay');
  const addUserBtn = document.getElementById('addUserBtn');
  const cancelUserBtn = document.getElementById('cancelUserModalBtn');
  const closeUserBtn = document.getElementById('closeUserModalBtn');
  const userForm = document.getElementById('userForm');

  const openUserModal = (title = 'Добавить пользователя', id = '', username = '', email = '', role = 'User', accountType = 'client') => {
    document.getElementById('userModalTitle').textContent = title;
    document.getElementById('userId').value = id;
    document.getElementById('userUsername').value = username;
    document.getElementById('userEmail').value = email;
    document.getElementById('userPassword').value = '';
    document.getElementById('userPassword').required = !id; // required only for new user
    document.getElementById('passwordHelp').textContent = id
      ? 'Оставьте пустым, чтобы не менять пароль.'
      : 'Пароль обязателен для создания нового пользователя.';
    document.getElementById('userRole').value = role;
    document.getElementById('userAccountType').value = accountType || 'client';
    userModal.classList.add('active');
  };

  const closeUserModal = () => {
    userModal.classList.remove('active');
    userForm.reset();
  };

  if (addUserBtn) addUserBtn.addEventListener('click', () => openUserModal());
  if (cancelUserBtn) cancelUserBtn.addEventListener('click', closeUserModal);
  if (closeUserBtn) closeUserBtn.addEventListener('click', closeUserModal);

  // User Save handler
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('userId').value;
      const username = document.getElementById('userUsername').value;
      const email = document.getElementById('userEmail').value;
      const password = document.getElementById('userPassword').value;
      const role = document.getElementById('userRole').value;
      const accountType = document.getElementById('userAccountType').value;

      const payload = { username, email, role, account_type: accountType };
      if (password) payload.password = password;

      const method = id ? 'PUT' : 'POST';
      const url = id ? `/api/users?id=${id}` : '/api/users';

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          showToast(id ? 'Данные пользователя обновлены' : 'Пользователь успешно создан', 'success');
          closeUserModal();
          await loadUsers();
        } else {
          const errData = await res.json();
          showToast(errData.message || 'Ошибка сохранения', 'error');
        }
      } catch (err) {
        showToast('Ошибка сохранения данных пользователя', 'error');
      }
    });
  }

  // Clear Logs Handler
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
      if (confirm('Вы действительно хотите удалить все логи действий? Это действие необратимо.')) {
        try {
          const res = await fetch('/api/logs', { method: 'DELETE' });
          if (res.ok) {
            showToast('Логи действий успешно очищены', 'success');
            await loadFullLogs();
          } else {
            showToast('Не удалось очистить логи', 'error');
          }
        } catch (err) {
          showToast('Ошибка при отправке запроса', 'error');
        }
      }
    });
  }

  setupEmployees();
  setupTools();
}

// Load data specifically for selected route
function loadSectionData(hash) {
  if (hash === 'dashboard') {
    loadDashboardStats();
  } else if (hash === 'employees') {
    loadEmployees();
  } else if (hash === 'tools') {
    loadTools();
  } else if (hash === 'articles') {
    loadArticles();
  } else if (hash === 'media') {
    loadMedia();
  } else if (hash === 'settings') {
    loadSettings();
  } else if (hash === 'users') {
    loadUsers();
  } else if (hash === 'logs') {
    loadFullLogs();
  } else if (hash === 'support') {
    loadSupportTickets();
  } else if (hash === 'requests') {
    loadToolRequests();
  }
}

// ==== Заявления (админ) ====
const REQ_STATUS = {
  pending:  { label: 'Ожидает',   badge: 'badge-warning' },
  approved: { label: 'Одобрено',  badge: 'badge-success' },
  rejected: { label: 'Отклонено', badge: 'badge-danger' }
};
let requestTypesCache = null;

async function ensureRequestTypes() {
  if (requestTypesCache) return requestTypesCache;
  try {
    const res = await fetch('/api/request-types');
    const d = await res.json();
    requestTypesCache = d.types || {};
  } catch (e) { requestTypesCache = {}; }
  // Заполняем фильтр по типам (один раз)
  const sel = document.getElementById('requestsTypeFilter');
  if (sel && sel.options.length <= 1) {
    Object.entries(requestTypesCache).forEach(([key, t]) => {
      const o = document.createElement('option');
      o.value = key; o.textContent = t.label;
      sel.appendChild(o);
    });
  }
  return requestTypesCache;
}

// Человекочитаемое описание заявления из payload + описания полей типа.
function describeRequest(r, types) {
  const def = types[r.type];
  if (!def) return escapeHtml(r.title || '');
  const parts = def.fields
    .filter(f => f.type !== 'photo' && r.payload[f.name] !== '' && r.payload[f.name] != null)
    .map(f => `<span style="color:hsl(var(--text-muted));">${escapeHtml(f.label)}:</span> ${escapeHtml(String(r.payload[f.name]))}`);
  const photo = (r.payload.photo_url)
    ? `<img src="${iconVer(r.payload.photo_url)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;float:left;margin-right:8px;">`
    : '';
  return `${photo}<div><strong>${escapeHtml(r.title || def.label)}</strong></div><div style="font-size:12px;">${parts.join(' · ')}</div>`;
}

async function loadToolRequests() { return loadRequests(); }
async function loadRequests() {
  const tbody = document.getElementById('requestsTableBody');
  if (!tbody) return;
  const types = await ensureRequestTypes();
  const status = document.getElementById('requestsStatusFilter')?.value ?? 'pending';
  const type = document.getElementById('requestsTypeFilter')?.value ?? '';
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:hsl(var(--text-muted));padding:20px;">Загрузка...</td></tr>';
  try {
    const qs = [];
    if (status) qs.push('status=' + status);
    if (type) qs.push('type=' + type);
    const res = await fetch('/api/requests' + (qs.length ? '?' + qs.join('&') : ''));
    if (!res.ok) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:hsl(var(--accent-red));padding:20px;">Нет доступа</td></tr>'; return; }
    const data = await res.json();
    updateRequestsBadge(data.pending);
    renderRequests(data.requests || [], types);
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:hsl(var(--accent-red));padding:20px;">Ошибка загрузки</td></tr>';
  }
}

function renderRequests(list, types) {
  const tbody = document.getElementById('requestsTableBody');
  tbody.innerHTML = '';
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:hsl(var(--text-muted));padding:20px;">Заявлений нет</td></tr>';
    return;
  }
  list.forEach(r => {
    const st = REQ_STATUS[r.status] || REQ_STATUS.pending;
    const actions = r.status === 'pending'
      ? `<button class="btn" style="padding:4px 10px;font-size:12px;" onclick="approveRequest(${r.id}, '${r.type}')">Одобрить</button>
         <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="rejectRequest(${r.id})">Отклонить</button>`
      : (r.review_note ? `<span style="font-size:12px;color:hsl(var(--text-muted));" title="${escapeHtml(r.review_note)}">${escapeHtml(r.reviewed_by_name || '')} ✎</span>` : `<span style="font-size:12px;color:hsl(var(--text-muted));">${escapeHtml(r.reviewed_by_name || '')}</span>`);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${escapeHtml(r.type_label || r.type)}</td>
      <td>${describeRequest(r, types)}</td>
      <td>${escapeHtml(r.requested_by_name || '—')}</td>
      <td><span class="badge ${st.badge}">${st.label}</span></td>
      <td style="text-align:right;">${actions}</td>`;
    tbody.appendChild(tr);
  });
}

window.approveRequest = async (id, type) => {
  const msg = type === 'tool_add' ? 'Одобрить и создать инструмент в инвентаре?' : 'Одобрить заявление?';
  if (!confirm(msg)) return;
  try {
    const res = await fetch(`/api/requests/approve?id=${id}`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { showToast('Заявление одобрено', 'success'); loadRequests(); }
    else showToast(d.message || 'Ошибка одобрения', 'error');
  } catch (e) { showToast('Ошибка сети', 'error'); }
};

window.rejectRequest = async (id) => {
  const note = prompt('Причина отклонения (необязательно):', '');
  if (note === null) return;
  try {
    const res = await fetch(`/api/requests/reject?id=${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_note: note })
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { showToast('Заявление отклонено', 'success'); loadRequests(); }
    else showToast(d.message || 'Ошибка', 'error');
  } catch (e) { showToast('Ошибка сети', 'error'); }
};

async function updateRequestsBadge(count) {
  const badge = document.getElementById('requestsBadge');
  if (!badge) return;
  if (count === undefined) {
    try {
      const res = await fetch('/api/requests?status=pending');
      if (!res.ok) return;
      count = (await res.json()).pending || 0;
    } catch (e) { return; }
  }
  if (count > 0) { badge.textContent = count; badge.style.display = ''; }
  else badge.style.display = 'none';
}

// Бейдж непрочитанных сообщений поддержки в меню (аналогично заявкам).
// count — суммарное число непрочитанных сообщений по всем диалогам.
function setSupportBadge(count) {
  const badge = document.getElementById('supportBadge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = ''; }
  else badge.style.display = 'none';
}

async function updateSupportBadge() {
  try {
    const res = await fetch('/api/support/tickets');
    if (!res.ok) return; // не админ или ошибка — молча выходим
    const data = await res.json();
    const total = (data.tickets || []).reduce((s, t) => s + (t.unread_count || 0), 0);
    setSupportBadge(total);
  } catch (e) { /* тихо */ }
}

document.getElementById('requestsStatusFilter')?.addEventListener('change', loadRequests);
document.getElementById('requestsTypeFilter')?.addEventListener('change', loadRequests);

// API: Dashboard stats loader (улучшено для главной страницы)
async function loadDashboardStats() {
  try {
    const res = await fetch('/api/dashboard/stats');
    if (res.ok) {
      const data = await res.json();
      const u = document.getElementById('stat-users');
      const a = document.getElementById('stat-articles');
      const m = document.getElementById('stat-media');
      if (u) u.textContent = data.users || 0;
      if (a) a.textContent = data.articles || 0;
      if (m) m.textContent = data.mediaFiles || 0;
    }
  } catch (err) {
    console.error('Failed to load dashboard stats:', err);
  }
}

async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    if (res.ok) {
      const logs = await res.json();
      const tbody = document.getElementById('logsTableBody');
      if (!tbody) return;
      tbody.innerHTML = '';
      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: hsl(var(--text-muted)); padding: 16px;">Нет записей</td></tr>';
        return;
      }
      logs.forEach(log => {
        const tr = document.createElement('tr');
        const dateStr = new Date(log.created_at).toLocaleString('ru-RU');
        tr.innerHTML = `
          <td style="color: hsl(var(--text-muted)); font-size: 13px;">${dateStr}</td>
          <td><span class="badge badge-warning">${escapeHtml(log.user)}</span></td>
          <td>${escapeHtml(log.action)}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

// API: Articles loader
async function loadArticles() {
  try {
    const res = await fetch('/api/crud/articles');
    if (res.ok) {
      articles = await res.json();
      renderArticles();
    }
  } catch (err) {
    showToast('Ошибка загрузки статей', 'error');
  }
}

function renderArticles(filterQuery = '') {
  const tbody = document.getElementById('articlesTableBody');
  tbody.innerHTML = '';
  
  const filtered = articles.filter(art => 
    art.title.toLowerCase().includes(filterQuery) || 
    (art.content && art.content.toLowerCase().includes(filterQuery))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: hsl(var(--text-muted)); padding: 30px;">Записи не найдены</td></tr>`;
    return;
  }

  filtered.forEach(art => {
    const tr = document.createElement('tr');
    
    const statusBadge = art.status === 'published' 
      ? `<span class="badge badge-success">Опубликовано</span>`
      : `<span class="badge badge-warning">Черновик</span>`;
      
    const dateFormatted = new Date(art.created_at).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    tr.innerHTML = `
      <td>${art.id}</td>
      <td><strong>${escapeHtml(art.title)}</strong></td>
      <td>${statusBadge}</td>
      <td>${dateFormatted}</td>
      <td style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          <button class="action-btn edit" onclick="editArticle(${art.id})"><i data-lucide="edit-3"></i></button>
          <button class="action-btn delete" onclick="deleteArticle(${art.id})"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  lucide.createIcons();
}

window.editArticle = (id) => {
  const art = articles.find(a => a.id === id);
  if (art) {
    const modal = document.getElementById('articleModalOverlay');
    document.getElementById('modalTitle').textContent = 'Редактировать статью';
    document.getElementById('articleId').value = art.id;
    document.getElementById('articleTitle').value = art.title;
    document.getElementById('articleStatus').value = art.status;

    // Properly populate Quill (or fallback hidden input)
    if (quill) {
      quill.root.innerHTML = art.content || '';
    } else {
      document.getElementById('articleContent').value = art.content || '';
    }

    modal.classList.add('active');
  }
};

window.deleteArticle = async (id) => {
  if (confirm('Вы действительно хотите удалить эту статью?')) {
    try {
      const res = await fetch(`/api/crud/articles?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Статья успешно удалена', 'success');
        await loadArticles();
      } else {
        showToast('Не удалось удалить статью', 'error');
      }
    } catch (err) {
      showToast('Ошибка запроса на удаление', 'error');
    }
  }
};

// API: Media library loader & Uploader (улучшено: поиск + копирование URL)
let mediaFilesCache = [];

window.showMediaFolders = () => {
  document.getElementById('mediaFoldersGrid').style.display = 'grid';
  document.getElementById('mediaFilesView').style.display = 'none';
  document.getElementById('mediaSearch').value = '';
  const iconsPanel = document.getElementById('categoryIconsPanel');
  if (iconsPanel) iconsPanel.style.display = 'none';
  const avPanel = document.getElementById('standardAvatarsPanel');
  if (avPanel) avPanel.style.display = 'none';
};

window.openMediaCategory = (category, title) => {
  document.getElementById('mediaCategorySelect').value = category;
  document.getElementById('uploadCategorySelect').value = category;
  document.getElementById('currentMediaCategoryTitle').textContent = title;

  document.getElementById('mediaFoldersGrid').style.display = 'none';
  document.getElementById('mediaFilesView').style.display = 'block';

  // Раздел «Иконки категорий» показываем только внутри папки «Инструменты».
  const iconsPanel = document.getElementById('categoryIconsPanel');
  if (iconsPanel) {
    // Показываем только кнопку; сами иконки грузятся при открытии модалки.
    iconsPanel.style.display = category === 'tools' ? 'block' : 'none';
  }

  // Раздел «Стандартные аватары» показываем только внутри папки «Аватары».
  const avPanel = document.getElementById('standardAvatarsPanel');
  if (avPanel) {
    // Показываем только кнопку; аватары грузятся при открытии модалки.
    avPanel.style.display = category === 'avatars' ? 'block' : 'none';
  }

  loadMedia();
};

// Модалка со стандартными аватарами: открытие грузит набор, закрытие прячет.
window.openStandardAvatarsModal = () => {
  const overlay = document.getElementById('standardAvatarsModalOverlay');
  if (!overlay) return;
  overlay.classList.add('active');
  loadStandardAvatars();
};

window.closeStandardAvatarsModal = () => {
  const overlay = document.getElementById('standardAvatarsModalOverlay');
  if (overlay) overlay.classList.remove('active');
};

// Показывает предустановленные аватары в медиатеке (папка «Аватары»).
async function loadStandardAvatars() {
  const grid = document.getElementById('standardAvatarsGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1; color:hsl(var(--text-muted)); font-size:13px;">Загрузка...</div>';
  try {
    const res = await fetch('/api/standard-avatars');
    const data = await res.json();
    const avatars = (data && data.avatars) || [];
    grid.innerHTML = '';
    if (!avatars.length) {
      grid.innerHTML = '<div style="grid-column:1/-1; color:hsl(var(--text-muted)); font-size:13px;">Пусто</div>';
      return;
    }
    avatars.forEach(a => {
      const card = document.createElement('div');
      card.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:6px;';
      card.innerHTML = `
        <img src="${a.url}" title="${escapeHtml(a.name)}" style="width:64px; height:64px; border-radius:50%; border:1px solid hsl(var(--border-color));">
        <button onclick="copyMediaUrl('${a.url}', event)" style="background:none;border:1px solid hsl(var(--border-color));color:hsl(var(--text-secondary));padding:2px 6px;font-size:11px;border-radius:4px;cursor:pointer;">URL</button>
      `;
      grid.appendChild(card);
    });
  } catch (e) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:hsl(var(--text-muted));">Ошибка загрузки</div>';
  }
}

// Модалка со стандартными иконками категорий: открытие грузит актуальный
// список, закрытие прячет оверлей.
window.openCategoryIconsModal = () => {
  const overlay = document.getElementById('categoryIconsModalOverlay');
  if (!overlay) return;
  overlay.classList.add('active');
  loadCategoryIcons();
};

window.closeCategoryIconsModal = () => {
  const overlay = document.getElementById('categoryIconsModalOverlay');
  if (overlay) overlay.classList.remove('active');
};

// Загружает и рисует иконки категорий инструментов с возможностью замены.
async function loadCategoryIcons() {
  const grid = document.getElementById('categoryIconsGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1; color:hsl(var(--text-muted)); font-size:13px;">Загрузка...</div>';
  try {
    const res = await fetch('/api/category-icons');
    const data = await res.json();
    const cats = (data && data.categories) || [];
    const isSuper = (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'Superadmin');
    grid.innerHTML = '';
    cats.forEach(c => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid hsl(var(--border-color)); border-radius:12px; padding:14px; display:flex; flex-direction:column; align-items:center; gap:8px; background:rgba(255,255,255,0.01);';
      const iconImg = c.image
        ? `<img src="${c.image}" style="width:56px; height:56px; object-fit:contain;">`
        : `<div style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;color:hsl(var(--text-muted));font-size:11px;">нет</div>`;
      const badge = c.is_custom
        ? `<span style="font-size:10px; color:hsl(var(--accent-cyan));">своя иконка</span>`
        : `<span style="font-size:10px; color:hsl(var(--text-muted));">стандартная</span>`;
      const controls = isSuper ? `
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button onclick="changeCategoryIcon('${encodeURIComponent(c.category)}')" style="background:none;border:1px solid hsl(var(--border-color));color:hsl(var(--accent-amber));padding:3px 8px;font-size:11px;border-radius:6px;cursor:pointer;">Изменить</button>
          ${c.is_custom ? `<button onclick="resetCategoryIcon('${encodeURIComponent(c.category)}')" style="background:none;border:1px solid hsl(var(--border-color));color:hsl(var(--text-secondary));padding:3px 8px;font-size:11px;border-radius:6px;cursor:pointer;">Сбросить</button>` : ''}
        </div>` : '';
      card.innerHTML = `
        ${iconImg}
        <div style="font-size:12px; color:hsl(var(--text-primary)); text-align:center;">${escapeHtml(c.category)}</div>
        ${badge}
        ${controls}
      `;
      grid.appendChild(card);
    });
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    grid.innerHTML = '<div style="grid-column:1/-1; color:hsl(var(--text-muted));">Ошибка загрузки</div>';
  }
}

window.changeCategoryIcon = (categoryEnc) => {
  const category = decodeURIComponent(categoryEnc);
  if (!window.openMediaPicker) { showToast('Пикер недоступен', 'error'); return; }
  window.openMediaPicker(async (url) => {
    try {
      const res = await fetch('/api/category-icons', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, image_url: url })
      });
      if (res.ok) {
        showToast('Иконка категории обновлена', 'success');
        loadCategoryIcons();
      } else {
        const d = await res.json().catch(() => ({}));
        showToast(d.message || 'Ошибка сохранения', 'error');
      }
    } catch (e) { showToast('Ошибка сети', 'error'); }
  }, 'tools');
};

window.resetCategoryIcon = async (categoryEnc) => {
  const category = decodeURIComponent(categoryEnc);
  if (!confirm('Вернуть стандартную иконку для этой категории?')) return;
  try {
    const res = await fetch(`/api/category-icons?category=${encodeURIComponent(category)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Иконка сброшена', 'success');
      loadCategoryIcons();
    } else {
      showToast('Ошибка сброса', 'error');
    }
  } catch (e) { showToast('Ошибка сети', 'error'); }
};

async function loadMedia(filter = '') {
  const grid = document.getElementById('mediaGrid');
  const categorySelect = document.getElementById('mediaCategorySelect');
  
  // If we are in folder view, don't load grid yet
  const foldersGrid = document.getElementById('mediaFoldersGrid');
  if (foldersGrid && foldersGrid.style.display !== 'none') {
    return;
  }
  
  if (!grid) return;
  const category = categorySelect ? categorySelect.value : 'all';
  grid.innerHTML = '<div style="color: hsl(var(--text-muted));">Загрузка файлов...</div>';

  try {
    const res = await fetch(`/api/media?category=${category}`);
    if (res.ok) {
      mediaFilesCache = await res.json();
      renderMediaGrid(filter);
    }
  } catch (err) {
    showToast('Ошибка загрузки медиатеки', 'error');
  }
}

function renderMediaGrid(filter = '') {
  const grid = document.getElementById('mediaGrid');
  grid.innerHTML = '';

  const filtered = mediaFilesCache.filter(f => 
    f.filename.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: hsl(var(--text-muted)); padding: 40px;">Ничего не найдено.</div>';
    return;
  }

  filtered.forEach(file => {
    const item = document.createElement('div');
    item.className = 'media-item';
    
    const isImage = file.mime_type.startsWith('image/');
    const previewEl = isImage 
      ? `<img src="${file.file_url}" alt="${escapeHtml(file.filename)}">`
      : `<i data-lucide="file" style="width: 48px; height: 48px; color: hsl(var(--text-secondary));"></i>`;

    const sizeMB = (file.file_size / (1024 * 1024)).toFixed(2);

    // Строка с привязкой: к чему/к кому относится файл.
    let attachHtml = '';
    if (file.attached_to) {
      const a = file.attached_to;
      if (a.type === 'tool') {
        attachHtml = `<div class="media-attach" style="font-size:11px;color:hsl(var(--accent-cyan));margin-top:2px;">🔧 Инструмент: ${escapeHtml(a.label || '')}${a.holder ? ` · у ${escapeHtml(a.holder)}` : ''}</div>`;
      } else if (a.type === 'user') {
        attachHtml = `<div class="media-attach" style="font-size:11px;color:hsl(var(--accent-amber));margin-top:2px;">👤 Аватар: ${escapeHtml(a.label || '')}</div>`;
      }
    }
    const uploaderHtml = file.uploaded_by_name
      ? `<div class="media-uploader" style="font-size:11px;color:hsl(var(--text-muted));margin-top:2px;">Загрузил: ${escapeHtml(file.uploaded_by_name)}</div>`
      : '';

    item.innerHTML = `
      <div class="media-preview">${previewEl}</div>
      <div class="media-info">
        <div class="media-title" title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</div>
        ${attachHtml}
        ${uploaderHtml}
        <div class="media-meta">
          <span>${sizeMB} MB</span>
          <a href="${file.file_url}" target="_blank" style="color: hsl(var(--accent-cyan)); text-decoration: none;">Открыть</a>
          <button onclick="copyMediaUrl('${file.file_url}', event)" style="background:none;border:1px solid hsl(var(--border-color));color:hsl(var(--text-secondary));padding:2px 6px;font-size:11px;border-radius:4px;cursor:pointer;">URL</button>
          ${(typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'Superadmin') ? `<button onclick="moveMedia(${file.id}, '${file.category}', event)" style="background:none;border:1px solid hsl(var(--border-color));color:hsl(var(--accent-amber));padding:2px 6px;font-size:11px;border-radius:4px;cursor:pointer;margin-left:4px;">В папку</button>` : ''}
        </div>
      </div>
      <button class="media-delete" onclick="deleteMedia(${file.id}, event)"><i data-lucide="trash-2" style="width: 14px; height: 14px;"></i></button>
    `;
    grid.appendChild(item);
  });
  
  lucide.createIcons();
}

window.moveMedia = async (id, currentCategory, e) => {
  if (e) e.stopImmediatePropagation();
  const targetCategory = prompt('Введите новую категорию (general, tools, avatars, articles):', currentCategory);
  if (!targetCategory || targetCategory === currentCategory) return;
  try {
    const res = await fetch('/api/media', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, category: targetCategory })
    });
    if (res.ok) {
      showToast('Медиафайл перемещен', 'success');
      loadMedia(document.getElementById('mediaSearch')?.value || '');
    } else {
      const data = await res.json().catch(()=>({}));
      showToast(data.message || 'Ошибка перемещения', 'error');
    }
  } catch(err) {
    showToast('Ошибка сети', 'error');
  }
};

// Поиск в медиатеке
const mediaSearchInput = document.getElementById('mediaSearch');
if (mediaSearchInput) {
  mediaSearchInput.addEventListener('input', (e) => {
    renderMediaGrid(e.target.value);
  });
}

window.copyMediaUrl = async (url, e) => {
  e.stopImmediatePropagation();
  try {
    await navigator.clipboard.writeText(window.location.origin + url);
    showToast('URL скопирован в буфер обмена', 'success');
  } catch {
    // fallback
    prompt('Скопируйте URL:', window.location.origin + url);
  }
};

// --- Media Picker Modal ---
let mediaPickerCallback = null;

window.openMediaPicker = async (onSelect, defaultCategory = 'all') => {
  mediaPickerCallback = onSelect;
  const modal = document.getElementById('mediaPickerModalOverlay');
  const catSelect = document.getElementById('mediaPickerCategorySelect');
  if (catSelect) catSelect.value = defaultCategory;
  
  try {
    const res = await fetch(`/api/media?category=${defaultCategory}`);
    if (res.ok) mediaFilesCache = await res.json();
  } catch(e) {}
  
  renderMediaPickerGrid();
  modal.classList.add('active');
};

function renderMediaPickerGrid(filter = '') {
  const grid = document.getElementById('mediaPickerGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const filtered = mediaFilesCache.filter(f => 
    f.mime_type.startsWith('image/') && 
    f.filename.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: hsl(var(--text-muted)); padding: 40px;">Изображения не найдены.</div>';
    return;
  }

  filtered.forEach(file => {
    const item = document.createElement('div');
    item.className = 'media-item';
    item.style.cursor = 'pointer';
    
    item.innerHTML = `
      <div class="media-preview">
        <img src="${file.file_url}" alt="${escapeHtml(file.filename)}">
      </div>
      <div class="media-info" style="border-top: 1px solid hsl(var(--border-color)); padding: 6px;">
        <div class="media-title" title="${escapeHtml(file.filename)}" style="font-size: 11px;">${escapeHtml(file.filename)}</div>
      </div>
    `;
    
    item.addEventListener('click', () => {
      if (mediaPickerCallback) mediaPickerCallback(file.file_url);
      document.getElementById('mediaPickerModalOverlay').classList.remove('active');
    });
    
    grid.appendChild(item);
  });
}

document.getElementById('closeMediaPickerBtn')?.addEventListener('click', () => {
  document.getElementById('mediaPickerModalOverlay').classList.remove('active');
});
document.getElementById('cancelMediaPickerBtn')?.addEventListener('click', () => {
  document.getElementById('mediaPickerModalOverlay').classList.remove('active');
});
const mediaPickerModal = document.getElementById('mediaPickerModalOverlay');
mediaPickerModal?.addEventListener('click', (e) => {
  if (e.target === mediaPickerModal) mediaPickerModal.classList.remove('active');
});
document.getElementById('mediaPickerSearch')?.addEventListener('input', (e) => {
  renderMediaPickerGrid(e.target.value);
});
document.getElementById('mediaCategorySelect')?.addEventListener('change', () => {
  loadMedia(document.getElementById('mediaSearch').value);
});
document.getElementById('mediaPickerCategorySelect')?.addEventListener('change', async (e) => {
  const category = e.target.value;
  try {
    const res = await fetch(`/api/media?category=${category}`);
    if (res.ok) {
      mediaFilesCache = await res.json();
      renderMediaPickerGrid(document.getElementById('mediaPickerSearch').value);
    }
  } catch(e) {}
});


window.deleteMedia = async (id, e) => {
  if (e) e.stopImmediatePropagation();
  if (!confirm('Вы уверены, что хотите удалить этот файл?')) return;

  try {
    const res = await fetch(`/api/media?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Файл удален', 'success');
      await loadMedia(document.getElementById('mediaSearch')?.value || '');
    } else {
      showToast('Не удалось удалить файл', 'error');
    }
  } catch (err) {
    showToast('Ошибка при удалении', 'error');
  }
};

// Лимит одного файла на сервере (держим в синхроне с MAX_SIZE_BYTES в utils.js)
const MEDIA_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 МБ
// Большие изображения ужимаем в браузере до этого размера по длинной стороне
const IMAGE_MAX_DIMENSION = 1920;

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
  return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
}

async function uploadFiles(filesList, category = 'general') {
  showToast('Подготовка файлов...', 'info');

  try {
    const filesPayload = [];
    const skipped = [];

    for (const file of filesList) {
      let prepared = { filename: file.name, blobOrFile: file, mimeType: file.type };

      // Изображения при необходимости уменьшаем (кроме SVG/GIF — их не трогаем).
      if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
        try {
          const compressed = await compressImage(file);
          if (compressed && compressed.blob.size < file.size) {
            const base = file.name.replace(/\.[^.]+$/, '');
            prepared = { filename: base + '.jpg', blobOrFile: compressed.blob, mimeType: 'image/jpeg' };
          }
        } catch (_) { /* если сжатие не удалось — пробуем отправить оригинал */ }
      }

      // Понятная ошибка ДО отправки: если всё ещё больше лимита — пропускаем файл.
      if (prepared.blobOrFile.size > MEDIA_MAX_FILE_BYTES) {
        skipped.push(`${file.name} (${humanSize(prepared.blobOrFile.size)})`);
        continue;
      }

      const data = await blobToBase64(prepared.blobOrFile);
      filesPayload.push({ filename: prepared.filename, data, mimeType: prepared.mimeType });
    }

    if (skipped.length) {
      showToast(`Слишком большие, пропущены (макс ${humanSize(MEDIA_MAX_FILE_BYTES)}): ${skipped.join(', ')}`, 'error');
    }
    if (filesPayload.length === 0) return;

    showToast('Загрузка файлов...', 'info');
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: filesPayload, category })
    });

    if (res.ok) {
      showToast(`Загружено файлов: ${filesPayload.length}`, 'success');
      await loadMedia();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.message || 'Ошибка загрузки файлов', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети при загрузке файлов', 'error');
  }
}

// Уменьшает изображение до IMAGE_MAX_DIMENSION по длинной стороне и
// перекодирует в JPEG. Возвращает { blob } или null, если сжатие невозможно.
function compressImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => resolve(blob ? { blob } : null),
        'image/jpeg',
        0.85
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // убираем data:...;base64,
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// API: Settings loader с типами полей и группировкой
async function loadSettings() {
  const container = document.getElementById('settingsContainer');
  container.innerHTML = '<div style="color: hsl(var(--text-muted));">Загрузка настроек...</div>';

  // Группировка настроек (для удобства)
  const GROUPS = {
    'Общие': ['site_name', 'maintenance_mode', 'allow_registration'],
    'Главная страница': ['hero_title', 'site_description'],
    'О блоге': ['about_title', 'about_subtitle', 'about_card1_title', 'about_card1_text', 'about_card2_title', 'about_card2_text'],
    'Контакты': ['contact_title', 'contact_subtitle', 'contact_email', 'contact_address'],
    'Публичная карточка инструмента (по QR)': ['public_card_enabled', 'public_card_show_photo', 'public_card_show_category', 'public_card_show_brand', 'public_card_show_model', 'public_card_show_serial', 'public_card_show_inventory', 'public_card_show_status', 'public_card_show_purchase_date', 'public_card_show_notes']
  };

  // Понятные подписи (не зависят от description в БД, который может теряться
  // при сохранении из-за INSERT OR REPLACE).
  const LABELS = {
    public_card_enabled: 'Публичная карточка доступна всем (по QR)',
    public_card_show_photo: 'Показывать фото',
    public_card_show_brand: 'Показывать бренд',
    public_card_show_model: 'Показывать модель',
    public_card_show_serial: 'Показывать серийный №',
    public_card_show_inventory: 'Показывать инвентарный №',
    public_card_show_status: 'Показывать статус',
    public_card_show_category: 'Показывать категорию',
    public_card_show_purchase_date: 'Показывать дату покупки',
    public_card_show_notes: 'Показывать заметки'
  };

  const PUBLIC_CARD_KEYS = GROUPS['Публичная карточка инструмента (по QR)'];

  // Определяем тип контрола по ключу
  function getFieldType(key) {
    if (['maintenance_mode', 'allow_registration'].includes(key) || PUBLIC_CARD_KEYS.includes(key)) return 'boolean';
    if (['site_description', 'about_subtitle', 'about_card1_text', 'about_card2_text', 'contact_subtitle'].includes(key)) return 'textarea';
    if (key === 'contact_email') return 'email';
    return 'text';
  }

  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to load');
    const allSettings = await res.json();

    // Преобразуем в map для быстрого доступа
    const settingsMap = {};
    allSettings.forEach(s => { settingsMap[s.key] = s; });

    container.innerHTML = '';

    Object.entries(GROUPS).forEach(([groupTitle, keys]) => {
      // Заголовок группы
      const groupHeader = document.createElement('div');
      groupHeader.style.cssText = 'margin: 18px 0 8px; font-size: 13px; font-weight: 600; color: var(--accent-cyan); text-transform: uppercase; letter-spacing: 0.5px;';
      groupHeader.textContent = groupTitle;
      container.appendChild(groupHeader);

      keys.forEach(key => {
        const set = settingsMap[key];
        if (!set) return;

        const fieldType = getFieldType(key);
        const div = document.createElement('div');
        div.className = 'form-group';

        const labelText = escapeHtml(LABELS[key] || set.description || set.key);

        if (fieldType === 'boolean') {
          const checked = set.value === 'true' ? 'checked' : '';
          div.innerHTML = `
            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
              <input type="checkbox" name="${escapeHtml(key)}" ${checked} style="width:18px; height:18px; accent-color: var(--accent-purple);">
              <span>${labelText}</span>
            </label>
          `;
        } else if (fieldType === 'textarea') {
          div.innerHTML = `
            <label>${labelText}</label>
            <textarea name="${escapeHtml(key)}" class="form-control" rows="3" style="resize: vertical; min-height: 70px;">${escapeHtml(set.value || '')}</textarea>
          `;
        } else {
          const inputType = fieldType === 'email' ? 'email' : 'text';
          div.innerHTML = `
            <label>${labelText}</label>
            <input type="${inputType}" name="${escapeHtml(key)}" value="${escapeHtml(set.value || '')}" class="form-control">
          `;
        }

        container.appendChild(div);
      });
    });
  } catch (err) {
    container.innerHTML = '<div style="color: #ff6b6b;">Не удалось загрузить настройки</div>';
    showToast('Ошибка загрузки настроек', 'error');
  }
}

// Helpers
window.exportJSON = async (type) => {
  try {
    const res = await fetch(type === 'media' ? '/api/media' : `/api/crud/${type}`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('JSON успешно экспортирован', 'success');
  } catch (err) {
    showToast('Ошибка экспорта JSON', 'error');
  }
};

window.exportCSV = async (type) => {
  try {
    const res = await fetch(type === 'media' ? '/api/media' : `/api/crud/${type}`);
    const data = await res.json();
    if (!data.length) return showToast('Нет данных для экспорта', 'error');
    
    const keys = Object.keys(data[0]);
    const csvContent = [
      keys.join(','),
      ...data.map(row => keys.map(k => `"${String(row[k] || '').replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV успешно экспортирован', 'success');
  } catch (err) {
    showToast('Ошибка экспорта CSV', 'error');
  }
};

function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

// API: Users loader
async function loadUsers() {
  if (currentUser.role !== 'Superadmin') return;
  try {
    const res = await fetch('/api/users');
    if (res.ok) {
      usersList = await res.json();
      renderUsers();
    }
  } catch (err) {
    showToast('Ошибка загрузки пользователей', 'error');
  }
}

function renderUsers(filterQuery = '') {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const filtered = usersList.filter(u => 
    u.username.toLowerCase().includes(filterQuery) || 
    u.email.toLowerCase().includes(filterQuery)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: hsl(var(--text-muted)); padding: 30px;">Пользователи не найдены</td></tr>`;
    return;
  }

  filtered.forEach(u => {
    const tr = document.createElement('tr');
    let roleBadge = `<span class="badge badge-warning">User</span>`;
    if (u.role === 'Admin') roleBadge = `<span class="badge badge-success">Admin</span>`;
    if (u.role === 'Superadmin') roleBadge = `<span class="badge badge-success" style="background:var(--accent-purple)">Superadmin</span>`;
    const typeBadge = u.account_type === 'employee'
      ? `<span class="badge" style="background:hsl(var(--accent-amber) / 0.15);color:hsl(var(--accent-amber))">Сотрудник</span>`
      : `<span class="badge" style="background:hsl(var(--accent-cyan) / 0.15);color:hsl(var(--accent-cyan))">Клиент</span>`;
    const dateFormatted = new Date(u.created_at).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    tr.innerHTML = `
      <td>${u.id}</td>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${escapeHtml(u.email)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${roleBadge}${typeBadge}</td>
      <td>${dateFormatted}</td>
      <td style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          <button class="action-btn edit" onclick="editUser(${u.id})"><i data-lucide="edit-3"></i></button>
          <button class="action-btn delete" onclick="deleteUser(${u.id})"><i data-lucide="trash-2"></i></button>
          <button class="action-btn chat" onclick="adminStartChat(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.email)}')"><i data-lucide="message-circle"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  lucide.createIcons();
}

// API: Full logs loader
async function loadFullLogs() {
  if (currentUser.role !== 'Superadmin') return;
  try {
    const res = await fetch('/api/logs?limit=1000');
    if (res.ok) {
      fullLogsList = await res.json();
      renderFullLogs();
    }
  } catch (err) {
    showToast('Ошибка загрузки логов', 'error');
  }
}

function renderFullLogs(filterQuery = '') {
  const tbody = document.getElementById('fullLogsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const filtered = fullLogsList.filter(l => 
    l.user.toLowerCase().includes(filterQuery) || 
    l.action.toLowerCase().includes(filterQuery)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: hsl(var(--text-muted)); padding: 30px;">Логи не найдены</td></tr>`;
    return;
  }

  filtered.forEach(l => {
    const tr = document.createElement('tr');
    const dateStr = new Date(l.created_at).toLocaleString('ru-RU');
    tr.innerHTML = `
      <td style="color: hsl(var(--text-muted)); font-size: 13px;">${dateStr}</td>
      <td><span class="badge badge-warning">${escapeHtml(l.user)}</span></td>
      <td>${escapeHtml(l.action)}</td>
    `;
    tbody.appendChild(tr);
  });
}

window.editUser = (id) => {
  const u = usersList.find(user => user.id === id);
  if (u) {
    const modal = document.getElementById('userModalOverlay');
    document.getElementById('userModalTitle').textContent = 'Редактировать пользователя';
    document.getElementById('userId').value = u.id;
    document.getElementById('userUsername').value = u.username;
    document.getElementById('userEmail').value = u.email;
    document.getElementById('userPassword').value = '';
    document.getElementById('userPassword').required = false;
    document.getElementById('passwordHelp').textContent = 'Оставьте пустым, чтобы не менять пароль.';
    document.getElementById('userRole').value = u.role;
    document.getElementById('userAccountType').value = u.account_type || 'client';
    modal.classList.add('active');
  }
};

window.deleteUser = async (id) => {
  if (parseInt(id, 10) === parseInt(currentUser.id, 10)) {
    showToast('Вы не можете удалить свою собственную учетную запись', 'error');
    return;
  }
  if (confirm('Вы действительно хотите удалить этого пользователя?')) {
    try {
      const res = await fetch(`/api/users?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Пользователь успешно удален', 'success');
        await loadUsers();
      } else {
        const data = await res.json();
        showToast(data.message || 'Не удалось удалить пользователя', 'error');
      }
    } catch (err) {
      showToast('Ошибка запроса на удаление', 'error');
    }
  }
};

// --- SUPPORT CHAT LOGIC ---
let activeTicketId = null;
let supportPollingInterval = null;
let supportUsersCache = [];   // все пользователи + агрегаты поддержки
let supportSearchQuery = '';

async function fetchSupportUsers() {
  const res = await fetch('/api/support/users');
  if (!res.ok) return null;
  const data = await res.json();
  return data.users || [];
}

// Фильтр по имени/нику и сортировка: сначала непрочитанные, затем по
// последней активности, затем по имени.
function renderSupportUsers() {
  const q = supportSearchQuery.trim().toLowerCase();
  let list = supportUsersCache.slice();
  if (q) list = list.filter(u => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  list.sort((a, b) => {
    if ((b.unread_count || 0) !== (a.unread_count || 0)) return (b.unread_count || 0) - (a.unread_count || 0);
    const ta = a.last_activity ? Date.parse(String(a.last_activity).replace(' ', 'T')) : 0;
    const tb = b.last_activity ? Date.parse(String(b.last_activity).replace(' ', 'T')) : 0;
    if (tb !== ta) return tb - ta;
    return (a.name || '').localeCompare(b.name || '', 'ru');
  });
  renderTickets(list, !!q);
}

async function loadSupportTickets() {
  try {
    const users = await fetchSupportUsers();
    if (users) { supportUsersCache = users; renderSupportUsers(); }

    // Опрос новых сообщений, пока открыт раздел поддержки
    if (supportPollingInterval) clearInterval(supportPollingInterval);
    supportPollingInterval = setInterval(async () => {
      const sec = document.getElementById('section-support');
      if (sec && sec.classList.contains('active')) {
        const u = await fetchSupportUsers();
        if (u) { supportUsersCache = u; renderSupportUsers(); }
        if (activeTicketId) loadSupportMessages(activeTicketId, true);
      } else {
        clearInterval(supportPollingInterval);
      }
    }, 5000);
  } catch (err) {
    showToast('Ошибка загрузки списка пользователей', 'error');
  }
}

document.getElementById('supportUserSearch')?.addEventListener('input', (e) => {
  supportSearchQuery = e.target.value || '';
  renderSupportUsers();
});

// Короткая относительная дата: «5 мин», «3 ч», «2 дн», иначе дата.
function shortWhen(raw) {
  if (!raw) return '';
  const d = new Date(String(raw).replace(' ', 'T'));
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} дн`;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function renderTickets(tickets, isFiltered = false) {
  const list = document.getElementById('ticketsList');
  if (!list) return;

  // Бейдж меню считаем из ПОЛНОГО кэша (не из отфильтрованного списка).
  setSupportBadge((supportUsersCache || []).reduce((s, t) => s + (t.unread_count || 0), 0));

  if (!tickets.length) {
    const msg = isFiltered ? 'Никого не найдено' : 'Пока нет пользователей';
    list.innerHTML = `
      <div style="padding: 40px 20px; color: hsl(var(--text-muted)); text-align: center; display:flex; flex-direction:column; align-items:center; gap:10px;">
        <i data-lucide="${isFiltered ? 'search-x' : 'users'}" style="width:36px; height:36px; opacity:0.5;"></i>
        <div>${msg}</div>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  let html = '';
  tickets.forEach(t => {
    const unread = t.unread_count || 0;
    const isActive = t.ticket_id === activeTicketId;
    const rowBg = isActive ? 'background: hsl(var(--accent-purple) / 0.12);'
                : unread > 0 ? 'background: hsl(var(--accent-purple) / 0.06);' : '';
    const accent = isActive ? 'box-shadow: inset 3px 0 0 hsl(var(--accent-purple));'
                 : unread > 0 ? 'box-shadow: inset 3px 0 0 hsl(var(--accent-cyan));' : '';
    const badge = unread > 0
      ? `<span title="Непрочитанных: ${unread}" style="background: hsl(var(--accent-purple)); color:#fff; border-radius: 10px; min-width:18px; text-align:center; padding: 1px 6px; font-size: 11px; font-weight: 700;">${unread > 99 ? '99+' : unread}</span>`
      : '';
    const nameWeight = unread > 0 ? '700' : '600';
    const avatarLetter = (t.name || '?').charAt(0).toUpperCase();

    // Превью последнего сообщения (кто написал последним + текст).
    const fromAdmin = t.last_sender_role === 'Admin' || t.last_sender_role === 'Superadmin';
    const preview = t.last_message
      ? (fromAdmin ? 'Вы: ' : '') + String(t.last_message).replace(/\s+/g, ' ').trim()
      : (t.email ? t.email + ' · нет переписки' : 'Нет переписки — напишите первым');
    const when = shortWhen(t.last_activity);

    html += `
      <div style="padding: 12px 16px; border-bottom: 1px solid hsl(var(--border-color)); cursor: pointer; display: flex; align-items: center; gap: 12px; transition: background 0.2s; ${rowBg} ${accent}"
           onmouseover="this.style.background='hsl(var(--accent-purple) / 0.1)'"
           onmouseout="this.style.background='${isActive ? 'hsl(var(--accent-purple) / 0.12)' : unread > 0 ? 'hsl(var(--accent-purple) / 0.06)' : 'transparent'}'"
           onclick="openSupportChat('${t.ticket_id}', '${escapeHtml(t.name || '')}', '${escapeHtml(t.email || '')}')">
        <div style="width: 40px; height: 40px; flex-shrink:0; border-radius: 50%; background: linear-gradient(135deg, hsl(var(--accent-purple)), hsl(var(--accent-cyan))); display: flex; align-items: center; justify-content: center; font-weight: bold; color:#fff; overflow:hidden;">${t.avatar_url ? `<img src="${escapeHtml(t.avatar_url)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.replaceWith(document.createTextNode('${avatarLetter}'))">` : avatarLetter}</div>
        <div style="flex: 1; min-width:0;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap:8px; margin-bottom: 3px;">
            <strong style="font-size: 14px; font-weight:${nameWeight}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.name || 'Пользователь')}</strong>
            <span style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              ${when ? `<span style="font-size:11px; color:hsl(var(--text-muted));">${when}</span>` : ''}
              ${badge}
            </span>
          </div>
          <div style="font-size: 12px; color: hsl(var(--text-muted)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(preview)}</div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;
}

window.openSupportChat = (ticketId, name, email) => {
  activeTicketId = ticketId;
  document.getElementById('chatHeaderName').textContent = name;
  document.getElementById('chatHeaderEmail').textContent = email || 'Гость';
  document.getElementById('chatHeaderAvatar').textContent = (name || '?').charAt(0).toUpperCase();
  document.getElementById('supportChatModalOverlay').classList.add('active');

  loadSupportMessages(ticketId);
  loadSupportTickets(); // обновить счётчики в списке и бейдж меню
  setTimeout(() => document.getElementById('replyMessageInput')?.focus(), 50);
};

window.closeSupportChat = () => {
  document.getElementById('supportChatModalOverlay').classList.remove('active');
  activeTicketId = null;
  loadSupportTickets(); // непрочитанные обнулились — обновляем список/бейдж
};

// Admin-initiated chat function
function adminStartChat(userId, name, email) {
  const ticketId = 'user_' + userId;
  activeTicketId = ticketId;
  // Ensure the ticket exists by creating it (admin only)
  (async () => {
    try {
      await fetch('/api/support/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: userId })
      });
    } catch (e) {
      console.error('Failed to create admin chat ticket', e);
    }
    // Открываем модалку чата
    document.getElementById('chatHeaderName').textContent = name;
    document.getElementById('chatHeaderEmail').textContent = email || 'Гость';
    document.getElementById('chatHeaderAvatar').textContent = (name || '?').charAt(0).toUpperCase();
    document.getElementById('supportChatModalOverlay').classList.add('active');
    loadSupportMessages(ticketId);
    loadSupportTickets();
    setTimeout(() => document.getElementById('replyMessageInput')?.focus(), 50);
  })();
}

async function loadSupportMessages(ticketId, isPolling = false) {
  try {
    const res = await fetch(`/api/support/messages?ticketId=${ticketId}`);
    if (res.ok) {
      const data = await res.json();
      renderChatMessages(data.messages, isPolling);
      
      // Mark as read
      await fetch('/api/support/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId })
      });
      // Сразу обновляем бейдж меню (диалог прочитан).
      if (!isPolling) updateSupportBadge();
    }
  } catch (err) {}
}

function renderChatMessages(messages, isPolling) {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 10;
  
  if (!messages.length) {
    container.innerHTML = '<div style="text-align:center; color:hsl(var(--text-muted));">Здесь пока нет сообщений.</div>';
    return;
  }
  
  let html = '';
  messages.forEach(msg => {
    const isAdmin = msg.sender_role === 'Admin' || msg.sender_role === 'Superadmin';
    const align = isAdmin ? 'flex-end' : 'flex-start';
    const bg = isAdmin ? 'linear-gradient(135deg, var(--accent-purple), var(--accent-cyan))' : 'rgba(255,255,255,0.05)';
    const color = isAdmin ? '#fff' : 'inherit';
    const name = isAdmin ? (msg.name || 'Admin') : (msg.name || 'Гость');
    const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    
    html += `
      <div style="display: flex; flex-direction: column; align-items: ${align};">
        <div style="font-size: 11px; color: hsl(var(--text-muted)); margin-bottom: 4px;">${escapeHtml(name)} • ${time}</div>
        <div style="background: ${bg}; color: ${color}; padding: 10px 14px; border-radius: 14px; max-width: 80%; border: 1px solid ${isAdmin ? 'transparent' : 'hsl(var(--border-color))'}; word-break: break-word;">
          ${escapeHtml(msg.message)}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
  
  if (!isPolling || wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

const replyForm = document.getElementById('replyForm');
if (replyForm) {
  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeTicketId) return;
    
    const input = document.getElementById('replyMessageInput');
    const message = input.value.trim();
    if (!message) return;
    
    input.disabled = true;
    try {
      const res = await fetch('/api/support/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: activeTicketId, message })
      });
      if (res.ok) {
        input.value = '';
        await loadSupportMessages(activeTicketId);
      } else {
        showToast('Ошибка при отправке', 'error');
      }
    } catch(err) {
      showToast('Ошибка сети', 'error');
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}

// Закрытие модалки чата поддержки по клику на фон и по Escape
(function () {
  const overlay = document.getElementById('supportChatModalOverlay');
  if (!overlay) return;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSupportChat(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) closeSupportChat();
  });
})();

// =====================================================================
//  EMPLOYEES (Сотрудники) — CRUD модуль учёта персонала
// =====================================================================

const EMPLOYEE_STATUS = {
  active:   { label: 'Работает',   badge: 'badge-success' },
  vacation: { label: 'В отпуске',  badge: 'badge-warning' },
  inactive: { label: 'Неактивен',  badge: 'badge-warning' },
  fired:    { label: 'Уволен',     badge: 'badge-danger' }
};

async function loadEmployees() {
  try {
    const res = await fetch('/api/crud/employees');
    if (res.ok) {
      employeesList = await res.json();
      renderEmployees();
    } else if (res.status === 401) {
      showToast('Сессия истекла, войдите заново', 'error');
    }
  } catch (err) {
    showToast('Ошибка загрузки сотрудников', 'error');
  }
}

function renderEmployees(filterQuery = '') {
  const tbody = document.getElementById('employeesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = filterQuery.toLowerCase();
  const filtered = employeesList.filter(e => {
    const hay = `${e.first_name} ${e.last_name} ${e.position || ''} ${e.department || ''} ${e.phone || ''} ${e.email || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: hsl(var(--text-muted)); padding: 30px;">Сотрудники не найдены</td></tr>`;
    return;
  }

  filtered.forEach(e => {
    const st = EMPLOYEE_STATUS[e.status] || EMPLOYEE_STATUS.active;
    const statusBadge = `<span class="badge ${st.badge}">${st.label}</span>`;
    const hire = e.hire_date ? new Date(e.hire_date).toLocaleDateString('ru-RU') : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.id}</td>
      <td><strong>${escapeHtml(e.last_name)} ${escapeHtml(e.first_name)}</strong></td>
      <td>${escapeHtml(e.position || '—')}</td>
      <td>${escapeHtml(e.department || '—')}</td>
      <td>${escapeHtml(e.phone || '—')}</td>
      <td>${hire}</td>
      <td>${statusBadge}</td>
      <td style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          <button class="action-btn edit" onclick="editEmployee(${e.id})"><i data-lucide="edit-3"></i></button>
          <button class="action-btn delete" onclick="deleteEmployee(${e.id})"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setupEmployees() {
  const modal = document.getElementById('employeeModalOverlay');
  if (!modal) return;

  const addBtn = document.getElementById('addEmployeeBtn');
  const cancelBtn = document.getElementById('cancelEmployeeModalBtn');
  const closeBtn = document.getElementById('closeEmployeeModalBtn');
  const form = document.getElementById('employeeForm');
  const search = document.getElementById('employeesSearch');

  const closeModal = () => modal.classList.remove('active');

  if (addBtn) addBtn.addEventListener('click', () => openEmployeeModal());
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  if (search) {
    search.addEventListener('input', (e) => renderEmployees(e.target.value));
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('employeeId').value;
      const payload = {
        first_name: document.getElementById('empFirstName').value,
        last_name: document.getElementById('empLastName').value,
        position: document.getElementById('empPosition').value,
        department: document.getElementById('empDepartment').value,
        phone: document.getElementById('empPhone').value,
        email: document.getElementById('empEmail').value,
        hire_date: document.getElementById('empHireDate').value,
        status: document.getElementById('empStatus').value,
        notes: document.getElementById('empNotes').value
      };

      const url = id ? `/api/crud/employees?id=${id}` : '/api/crud/employees';
      const httpMethod = id ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method: httpMethod,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(id ? 'Сотрудник обновлён' : 'Сотрудник добавлен', 'success');
          closeModal();
          await loadEmployees();
        } else {
          showToast(data.message || 'Не удалось сохранить', 'error');
        }
      } catch (err) {
        showToast('Ошибка сети', 'error');
      }
    });
  }
}

function openEmployeeModal(emp = null) {
  const modal = document.getElementById('employeeModalOverlay');
  document.getElementById('employeeModalTitle').textContent = emp ? 'Редактировать сотрудника' : 'Добавить сотрудника';
  document.getElementById('employeeId').value = emp ? emp.id : '';
  document.getElementById('empFirstName').value = emp ? emp.first_name : '';
  document.getElementById('empLastName').value = emp ? emp.last_name : '';
  document.getElementById('empPosition').value = emp ? (emp.position || '') : '';
  document.getElementById('empDepartment').value = emp ? (emp.department || '') : '';
  document.getElementById('empPhone').value = emp ? (emp.phone || '') : '';
  document.getElementById('empEmail').value = emp ? (emp.email || '') : '';
  document.getElementById('empHireDate').value = emp && emp.hire_date ? String(emp.hire_date).slice(0, 10) : '';
  document.getElementById('empStatus').value = emp ? emp.status : 'active';
  document.getElementById('empNotes').value = emp ? (emp.notes || '') : '';
  modal.classList.add('active');
}

window.editEmployee = (id) => {
  const emp = employeesList.find(e => e.id === id);
  if (emp) openEmployeeModal(emp);
};

window.deleteEmployee = async (id) => {
  const emp = employeesList.find(e => e.id === id);
  const name = emp ? `${emp.last_name} ${emp.first_name}` : `id=${id}`;
  if (!confirm(`Удалить сотрудника «${name}»? Это действие необратимо.`)) return;
  try {
    const res = await fetch(`/api/crud/employees?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Сотрудник удалён', 'success');
      await loadEmployees();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.message || 'Не удалось удалить', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети', 'error');
  }
};

// =====================================================================
//  TOOLS (Инструмент) — инвентарь + выдача/возврат/история
// =====================================================================

const TOOL_STATUS = {
  available:   { label: 'На складе',  badge: 'badge-success' },
  assigned:    { label: 'Выдан',      badge: 'badge-warning' },
  repair:      { label: 'В ремонте',  badge: 'badge-warning' },
  written_off: { label: 'Списан',     badge: 'badge-danger' }
};

// Дописывает версию к каталожным иконкам, чтобы сбросить кэш браузера
// (в БД путь хранится без ?v). Для фото из /uploads/ ничего не меняет.
function iconVer(url) {
  if (/^\/catalog\/images\//.test(url || '') && !url.includes('?')) return url + '?v=2';
  return url;
}

// Клиентская генерация инвентарного номера — тот же формат, что на сервере
// (INV-D + дата ГГММДД + крипто-hex). Показываем в поле сразу при добавлении.
function genInventoryNumber() {
  const d = new Date();
  const datePart = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let hex = '';
  if (window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint8Array(3);
    window.crypto.getRandomValues(arr);
    hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    hex = Math.random().toString(16).slice(2, 8);
  }
  return `INV-D${datePart}${hex.toUpperCase()}`;
}

// Карта "категория → иконка" для подстановки в списке инструментов,
// когда у инструмента нет собственного фото.
let categoryIconMap = {};
async function loadCategoryIconMap() {
  try {
    const res = await fetch('/api/category-icons');
    if (!res.ok) return;
    const data = await res.json();
    const map = {};
    (data.categories || []).forEach(c => { if (c.image) map[c.category] = c.image; });
    categoryIconMap = map;
  } catch (e) { /* иконки не критичны */ }
}

async function loadTools() {
  try {
    // Иконки категорий грузим параллельно (один раз кэшируем результат).
    const iconsPromise = Object.keys(categoryIconMap).length ? Promise.resolve() : loadCategoryIconMap();
    const res = await fetch('/api/crud/tools');
    await iconsPromise;
    if (res.ok) {
      toolsList = await res.json();
      renderTools();
    } else if (res.status === 401) {
      showToast('Сессия истекла, войдите заново', 'error');
    }
  } catch (err) {
    showToast('Ошибка загрузки инструмента', 'error');
  }
}

function renderTools(filterQuery = '') {
  const tbody = document.getElementById('toolsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const q = filterQuery.toLowerCase();
  const filtered = toolsList.filter(t => {
    const hay = `${t.name} ${t.category || ''} ${t.brand || ''} ${t.model || ''} ${t.serial_number || ''} ${t.inventory_number || ''} ${t.current_holder || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: hsl(var(--text-muted)); padding: 30px;">Инструмент не найден</td></tr>`;
    return;
  }

  filtered.forEach(t => {
    const st = TOOL_STATUS[t.status] || TOOL_STATUS.available;
    const statusBadge = `<span class="badge ${st.badge}">${st.label}</span>`;
    const holder = t.current_holder
      ? `<strong>${escapeHtml(t.current_holder)}</strong>`
      : `<span style="color: hsl(var(--text-muted));">—</span>`;

    // Кнопка выдать/вернуть в зависимости от того, на руках ли инструмент
    const isHeld = !!t.current_employee_id;
    const canWriteOff = t.status === 'written_off';
    const issueReturnBtn = isHeld
      ? `<button class="action-btn" title="Вернуть / передать" onclick="openReturnModal(${t.id})" style="color: hsl(var(--accent-cyan));"><i data-lucide="corner-down-left"></i></button>`
      : (canWriteOff ? '' : `<button class="action-btn" title="Выдать" onclick="openIssueModal(${t.id})" style="color: hsl(var(--accent-amber));"><i data-lucide="hand-helping"></i></button>`);

    const catIcon = t.category ? categoryIconMap[t.category] : null;
    const thumb = t.photo_url
      ? `<img src="${iconVer(t.photo_url)}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0;">`
      : (catIcon
        ? `<img src="${catIcon}" style="width:40px;height:40px;border-radius:8px;object-fit:cover;flex-shrink:0;" title="${escapeHtml(t.category)}">`
        : `<div style="width:40px;height:40px;border-radius:8px;background:hsl(var(--bg-main));border:1px solid hsl(var(--border-color));display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i data-lucide="wrench" style="width:16px;height:16px;color:hsl(var(--text-muted));"></i></div>`);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.id}</td>
      <td>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="openToolDetail(${t.id})" title="Открыть карточку">
          ${thumb}
          <div><strong style="border-bottom:1px dashed hsl(var(--border-color));">${escapeHtml(t.name)}</strong>${t.brand ? `<div style="font-size:12px;color:hsl(var(--text-muted))">${escapeHtml(t.brand)}${t.model ? ' · ' + escapeHtml(t.model) : ''}</div>` : ''}</div>
        </div>
      </td>
      <td>${escapeHtml(t.category || '—')}</td>
      <td>${escapeHtml(t.serial_number || '—')}</td>
      <td>${escapeHtml(t.inventory_number || '—')}</td>
      <td>${statusBadge}</td>
      <td>${holder}</td>
      <td style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          ${issueReturnBtn}
          <button class="action-btn" title="Карточка инструмента" onclick="openToolDetail(${t.id})"><i data-lucide="eye"></i></button>
          <button class="action-btn edit" title="Изменить" onclick="editTool(${t.id})"><i data-lucide="edit-3"></i></button>
          <button class="action-btn delete" title="Удалить" onclick="deleteTool(${t.id})"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Загружает изображение через /api/media и возвращает его URL (/uploads/...)
async function uploadImageToMedia(file, category = 'general') {
  // Большие изображения ужимаем в браузере, чтобы не упираться в лимит.
  let payload = { filename: file.name, mimeType: file.type, blobOrFile: file };
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
    try {
      const compressed = await compressImage(file);
      if (compressed && compressed.blob.size < file.size) {
        const base = file.name.replace(/\.[^.]+$/, '');
        payload = { filename: base + '.jpg', mimeType: 'image/jpeg', blobOrFile: compressed.blob };
      }
    } catch (_) { /* отправим оригинал */ }
  }
  const data = await blobToBase64(payload.blobOrFile);
  const res = await fetch('/api/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ filename: payload.filename, data, mimeType: payload.mimeType }], category })
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.urls && json.urls[0] ? json.urls[0] : null;
}

async function loadToolCategories() {
  try {
    const res = await fetch('/api/crud/tool-categories');
    if (res.ok) toolCategories = await res.json();
  } catch (e) { /* тихо — список просто будет пустым */ }
}

// Заполняет <select id="toolCategory"> категориями и выставляет выбранное
// значение. Если у инструмента категория, которой нет в справочнике
// (например, удалили), она всё равно добавляется опцией, чтобы не потерять.
function populateCategorySelect(selectedValue = '') {
  const select = document.getElementById('toolCategory');
  if (!select) return;
  const names = toolCategories.map(c => c.name);
  let html = '<option value="">— выберите —</option>';
  names.forEach(n => {
    html += `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`;
  });
  if (selectedValue && !names.includes(selectedValue)) {
    html += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)} (своя)</option>`;
  }
  select.innerHTML = html;
  select.value = selectedValue || '';
}

function setToolPhotoPreview(url) {
  document.getElementById('toolPhotoUrl').value = url || '';
  const preview = document.getElementById('toolPhotoPreview');
  const clearBtn = document.getElementById('toolPhotoClearBtn');
  if (url) {
    preview.innerHTML = `<img src="${iconVer(url)}" style="width:100%;height:100%;object-fit:cover;">`;
    if (clearBtn) clearBtn.style.display = '';
  } else {
    preview.innerHTML = `<i data-lucide="wrench" style="color:hsl(var(--text-muted));"></i>`;
    if (clearBtn) clearBtn.style.display = 'none';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// Загружает справочник моделей (один раз) и открывает пикер поверх модалки инструмента
async function openCatalogPicker() {
  const list = document.getElementById('catalogList');
  document.getElementById('catalogModalOverlay').classList.add('active');
  if (!catalogData) {
    list.innerHTML = '<div style="grid-column:1/-1;color:hsl(var(--text-muted));text-align:center;padding:20px;">Загрузка каталога...</div>';
    try {
      const res = await fetch('/api/tool-catalog');
      catalogData = res.ok ? await res.json() : { categories: [] };
      catalogFlat = (catalogData.categories || []).flatMap(c =>
        c.models.map(m => ({ category: c.category, ...m }))
      );
    } catch (e) {
      list.innerHTML = '<div style="grid-column:1/-1;color:hsl(var(--accent-red));text-align:center;padding:20px;">Не удалось загрузить каталог</div>';
      return;
    }
  }
  renderCatalogFilters();
  renderCatalogList();
}

function renderCatalogFilters() {
  const box = document.getElementById('catalogFilters');
  const cats = (catalogData.categories || []).map(c => c.category);
  const mk = (val, label) =>
    `<button type="button" class="btn ${catalogActiveFilter === val ? '' : 'btn-secondary'}" style="padding:6px 12px;font-size:13px;" onclick="setCatalogFilter('${val.replace(/'/g, "\\'")}')">${escapeHtml(label)}</button>`;
  box.innerHTML = mk('*', 'Все') + cats.map(c => mk(c, c)).join('');
}

window.setCatalogFilter = (val) => {
  catalogActiveFilter = val;
  renderCatalogFilters();
  renderCatalogList();
};

function renderCatalogList() {
  const list = document.getElementById('catalogList');
  const items = catalogActiveFilter === '*'
    ? catalogFlat
    : catalogFlat.filter(m => m.category === catalogActiveFilter);

  list.innerHTML = items.map((m, i) => {
    const idx = catalogFlat.indexOf(m);
    const specs = [];
    if (m.powerType === 'cordless' && m.voltageV) specs.push(m.voltageV + ' В');
    if (m.powerType === 'corded' && m.powerW) specs.push(m.powerW + ' Вт');
    if (m.brushless) specs.push('бесщёт.');
    if (m.discMm) specs.push('⌀' + m.discMm);
    if (m.chuck) specs.push(m.chuck);
    return `
      <div onclick="pickCatalogModel(${idx})" style="display:flex;gap:12px;align-items:center;padding:12px;border:1px solid hsl(var(--border-color));border-radius:12px;cursor:pointer;background:hsl(var(--bg-main));transition:border-color .15s;" onmouseover="this.style.borderColor='hsl(var(--accent-purple))'" onmouseout="this.style.borderColor='hsl(var(--border-color))'">
        <img src="${m.image}" style="width:48px;height:40px;object-fit:contain;flex-shrink:0;">
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(m.name)}</div>
          <div style="font-size:12px;color:hsl(var(--text-muted));">${escapeHtml(m.category)}${specs.length ? ' · ' + escapeHtml(specs.join(' · ')) : ''}</div>
        </div>
      </div>`;
  }).join('');
}

window.pickCatalogModel = (idx) => {
  const m = catalogFlat[idx];
  if (!m) return;
  document.getElementById('toolName').value = m.name;
  document.getElementById('toolBrand').value = m.brand;
  document.getElementById('toolModel').value = m.model;
  populateCategorySelect(m.category);
  setToolPhotoPreview(m.image);
  document.getElementById('catalogModalOverlay').classList.remove('active');
  showToast('Модель подставлена — впишите серийный № и сохраните', 'success');
};

// Проверка дублей серийного/инвентарного номера в реальном времени
let dupCheckTimer = null;

function clearDupWarnings() {
  ['toolSerialWarn', 'toolInventoryWarn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  ['toolSerial', 'toolInventory'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('input-dup');
  });
}

async function checkToolDuplicates() {
  const serial = document.getElementById('toolSerial').value.trim();
  const inventory = document.getElementById('toolInventory').value.trim();
  const excludeId = document.getElementById('toolId').value || '';

  const apply = (warnEl, input, hit, label) => {
    if (hit) {
      warnEl.textContent = `⚠ Такой ${label} уже у «${hit.name}» (ID ${hit.id})`;
      warnEl.style.display = 'block';
      input.classList.add('input-dup');
    } else {
      warnEl.style.display = 'none';
      input.classList.remove('input-dup');
    }
  };

  if (!serial && !inventory) return clearDupWarnings();

  try {
    const params = new URLSearchParams({ serial, inventory, exclude_id: excludeId });
    const res = await fetch('/api/tools/check-dup?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    apply(document.getElementById('toolSerialWarn'), document.getElementById('toolSerial'),
          serial ? data.serial : null, 'серийный №');
    apply(document.getElementById('toolInventoryWarn'), document.getElementById('toolInventory'),
          inventory ? data.inventory : null, 'инвентарный №');
  } catch (e) { /* тихо — проверка вспомогательная, сохранение всё равно защищено на сервере */ }
}

function scheduleDupCheck() {
  clearTimeout(dupCheckTimer);
  dupCheckTimer = setTimeout(checkToolDuplicates, 350);
}

function setupTools() {
  const modal = document.getElementById('toolModalOverlay');
  if (!modal) return;

  const addBtn = document.getElementById('addToolBtn');
  const cancelBtn = document.getElementById('cancelToolModalBtn');
  const closeBtn = document.getElementById('closeToolModalBtn');
  const form = document.getElementById('toolForm');
  const search = document.getElementById('toolsSearch');

  const closeModal = () => modal.classList.remove('active');
  if (addBtn) addBtn.addEventListener('click', () => openToolModal());
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  if (search) search.addEventListener('input', (e) => renderTools(e.target.value));

  // Проверка дублей серийного/инвентарного номера в реальном времени
  const serialInput = document.getElementById('toolSerial');
  const inventoryInput = document.getElementById('toolInventory');
  if (serialInput) serialInput.addEventListener('input', scheduleDupCheck);
  if (inventoryInput) inventoryInput.addEventListener('input', scheduleDupCheck);

  // Подгружаем справочник категорий один раз при инициализации
  loadToolCategories();

  // Добавление своей категории (только Superadmin)
  const addCategoryBtn = document.getElementById('addCategoryBtn');
  if (addCategoryBtn) {
    addCategoryBtn.addEventListener('click', async () => {
      const name = prompt('Название новой категории инструмента:');
      if (name === null) return;
      const trimmed = name.trim();
      if (trimmed.length < 2) return showToast('Название слишком короткое', 'error');
      try {
        const res = await fetch('/api/crud/tool-categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast('Категория добавлена', 'success');
          await loadToolCategories();
          populateCategorySelect(data.name || trimmed);
        } else {
          showToast(data.message || 'Не удалось добавить категорию', 'error');
        }
      } catch (e) {
        showToast('Ошибка сети', 'error');
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('toolId').value;
      const payload = {
        name: document.getElementById('toolName').value,
        category: document.getElementById('toolCategory').value,
        brand: document.getElementById('toolBrand').value,
        model: document.getElementById('toolModel').value,
        serial_number: document.getElementById('toolSerial').value,
        inventory_number: document.getElementById('toolInventory').value,
        status: document.getElementById('toolStatus').value,
        purchase_date: document.getElementById('toolPurchaseDate').value,
        photo_url: document.getElementById('toolPhotoUrl').value,
        notes: document.getElementById('toolNotes').value
      };
      const url = id ? `/api/crud/tools?id=${id}` : '/api/crud/tools';
      try {
        const res = await fetch(url, {
          method: id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          // Для нового инструмента с фото — регистрируем его в галерее,
          // чтобы аватар был среди фото инструмента.
          if (!id && data.id && payload.photo_url) {
            try {
              await fetch('/api/tools/photo', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool_id: data.id, photo_url: payload.photo_url })
              });
            } catch (_) { /* некритично */ }
          }
          showToast(id ? 'Инструмент обновлён' : 'Инструмент добавлен', 'success');
          closeModal();
          await loadTools();
        } else {
          showToast(data.message || 'Не удалось сохранить', 'error');
        }
      } catch (err) {
        showToast('Ошибка сети', 'error');
      }
    });
  }

  // --- Catalog picker (Bosch/DeWalt) ---
  const catalogModal = document.getElementById('catalogModalOverlay');
  const fromCatalogBtn = document.getElementById('fromCatalogBtn');
  const closeCatalog = () => catalogModal.classList.remove('active');
  if (fromCatalogBtn) fromCatalogBtn.addEventListener('click', openCatalogPicker);
  document.getElementById('closeCatalogModalBtn').addEventListener('click', closeCatalog);
  document.getElementById('cancelCatalogModalBtn').addEventListener('click', closeCatalog);
  catalogModal.addEventListener('click', (e) => { if (e.target === catalogModal) closeCatalog(); });

  // --- Photo upload inside tool modal ---
  const photoBtn = document.getElementById('toolPhotoBtn');
  const photoClearBtn = document.getElementById('toolPhotoClearBtn');
  const photoInput = document.getElementById('toolPhotoInput');

  if (photoBtn && photoInput) {
    photoBtn.addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0];
      if (!file) return;
      photoBtn.disabled = true;
      photoBtn.textContent = 'Загрузка...';
      try {
        const url = await uploadImageToMedia(file, 'tools');
        if (!url) { showToast('Не удалось загрузить фото', 'error'); return; }

        const editId = document.getElementById('toolId').value;
        if (editId) {
          // Существующий инструмент: фото уходит в его галерею; первое станет
          // аватаром на сервере. Обновляем превью аватара из ответа.
          const res = await fetch('/api/tools/photo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_id: parseInt(editId, 10), photo_url: url })
          });
          const d = await res.json().catch(() => ({}));
          if (res.ok) {
            if (d.is_avatar) setToolPhotoPreview(url);
            showToast(d.is_avatar ? 'Фото загружено и стало аватаром' : 'Фото добавлено в галерею инструмента', 'success');
          } else {
            showToast(d.message || 'Не удалось добавить фото', 'error');
          }
        } else {
          // Новый инструмент: фото станет аватаром при создании.
          setToolPhotoPreview(url);
          showToast('Фото загружено — станет аватаром', 'success');
        }
      } catch (e) {
        showToast('Ошибка загрузки фото', 'error');
      } finally {
        photoBtn.disabled = false;
        photoBtn.textContent = 'Загрузить фото';
        photoInput.value = '';
      }
    });
  }
  if (photoClearBtn) {
    photoClearBtn.addEventListener('click', () => setToolPhotoPreview(''));
  }

  // --- Issue modal ---
  const issueModal = document.getElementById('issueModalOverlay');
  const closeIssueModal = () => issueModal.classList.remove('active');
  document.getElementById('closeIssueModalBtn').addEventListener('click', closeIssueModal);
  document.getElementById('cancelIssueModalBtn').addEventListener('click', closeIssueModal);
  issueModal.addEventListener('click', (e) => { if (e.target === issueModal) closeIssueModal(); });

  // Поиск сотрудников в реальном времени внутри модалки выдачи
  const issueSearch = document.getElementById('issueEmployeeSearch');
  if (issueSearch) {
    issueSearch.addEventListener('input', (e) => renderIssueEmployeeList(e.target.value));
    // Enter в поиске не должен отправлять форму (выбор — кликом по сотруднику)
    issueSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  document.getElementById('issueForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const toolId = document.getElementById('issueToolId').value;
    const employeeId = document.getElementById('issueEmployeeId').value;
    const notes = document.getElementById('issueNotes').value;
    if (!employeeId) return showToast('Выберите сотрудника', 'error');
    try {
      const res = await fetch('/api/tools/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_id: Number(toolId), employee_id: Number(employeeId), notes })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast('Инструмент выдан', 'success');
        closeIssueModal();
        await loadTools();
      } else {
        showToast(data.message || 'Не удалось выдать', 'error');
      }
    } catch (err) {
      showToast('Ошибка сети', 'error');
    }
  });

  // --- History modal ---
  const historyModal = document.getElementById('historyModalOverlay');
  const closeHistoryModal = () => historyModal.classList.remove('active');
  document.getElementById('closeHistoryModalBtn').addEventListener('click', closeHistoryModal);
  document.getElementById('closeHistoryBtn2').addEventListener('click', closeHistoryModal);
  historyModal.addEventListener('click', (e) => { if (e.target === historyModal) closeHistoryModal(); });

  // --- Tool detail modal ---
  const detailModal = document.getElementById('toolDetailModalOverlay');
  if (detailModal) {
    const closeDetail = () => detailModal.classList.remove('active');
    document.getElementById('closeToolDetailBtn')?.addEventListener('click', closeDetail);
    detailModal.addEventListener('click', (e) => { if (e.target === detailModal) closeDetail(); });
  }
  const lightbox = document.getElementById('photoLightbox');
  if (lightbox) lightbox.addEventListener('click', () => { lightbox.style.display = 'none'; });

  // --- Return / transfer modal ---
  const returnModal = document.getElementById('returnModalOverlay');
  const closeReturnModal = () => returnModal.classList.remove('active');
  document.getElementById('closeReturnModalBtn').addEventListener('click', closeReturnModal);
  document.getElementById('cancelReturnModalBtn').addEventListener('click', closeReturnModal);
  returnModal.addEventListener('click', (e) => { if (e.target === returnModal) closeReturnModal(); });

  // «На склад» — обычный возврат
  document.getElementById('returnToStockBtn').addEventListener('click', async () => {
    await doReturnToStock(Number(returnModal.dataset.toolId));
    closeReturnModal();
  });

  // «Передать другому» — показываем шаг выбора сотрудника
  document.getElementById('goTransferBtn').addEventListener('click', () => {
    document.getElementById('returnStep1').style.display = 'none';
    document.getElementById('returnStep2').style.display = '';
    document.getElementById('confirmTransferBtn').style.display = '';
    renderTransferList('');
    document.getElementById('transferSearch').focus();
  });

  const transferSearch = document.getElementById('transferSearch');
  transferSearch.addEventListener('input', (e) => renderTransferList(e.target.value));
  transferSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  document.getElementById('confirmTransferBtn').addEventListener('click', async () => {
    const toolId = Number(returnModal.dataset.toolId);
    const empId = document.getElementById('transferEmployeeId').value;
    if (!empId) return showToast('Выберите сотрудника', 'error');
    try {
      const res = await fetch('/api/tools/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_id: toolId, employee_id: Number(empId) })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast('Инструмент передан', 'success');
        closeReturnModal();
        await loadTools();
      } else {
        showToast(data.message || 'Не удалось передать', 'error');
      }
    } catch (err) {
      showToast('Ошибка сети', 'error');
    }
  });
}

function openToolModal(tool = null) {
  const modal = document.getElementById('toolModalOverlay');
  document.getElementById('toolModalTitle').textContent = tool ? 'Редактировать инструмент' : 'Добавить инструмент';
  document.getElementById('toolId').value = tool ? tool.id : '';
  document.getElementById('toolName').value = tool ? tool.name : '';
  populateCategorySelect(tool ? (tool.category || '') : '');
  document.getElementById('toolBrand').value = tool ? (tool.brand || '') : '';
  document.getElementById('toolModel').value = tool ? (tool.model || '') : '';
  document.getElementById('toolSerial').value = tool ? (tool.serial_number || '') : '';
  document.getElementById('toolInventory').value = tool ? (tool.inventory_number || '') : genInventoryNumber();
  document.getElementById('toolStatus').value = tool ? tool.status : 'available';
  document.getElementById('toolPurchaseDate').value = tool && tool.purchase_date ? String(tool.purchase_date).slice(0, 10) : '';
  document.getElementById('toolNotes').value = tool ? (tool.notes || '') : '';
  setToolPhotoPreview(tool ? (tool.photo_url || '') : '');
  clearDupWarnings();
  modal.classList.add('active');
}

window.editTool = (id) => {
  const tool = toolsList.find(t => t.id === id);
  if (tool) openToolModal(tool);
};

window.deleteTool = async (id) => {
  const tool = toolsList.find(t => t.id === id);
  const name = tool ? tool.name : `id=${id}`;
  if (!confirm(`Удалить инструмент «${name}»? Вся история его закреплений тоже удалится. Это необратимо.`)) return;
  try {
    const res = await fetch(`/api/crud/tools?id=${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Инструмент удалён', 'success');
      await loadTools();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.message || 'Не удалось удалить', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети', 'error');
  }
};

// Список сотрудников для пикера в модалке выдачи (кэш на открытие модалки)
let issueEmployeesList = [];

// Карточка инструмента для модалок выдачи/возврата (общий хелпер)
function buildToolCard(tool) {
  const st = TOOL_STATUS[tool.status] || TOOL_STATUS.available;
  const catIcon = tool.category ? categoryIconMap[tool.category] : null;
  const thumb = tool.photo_url
    ? `<img class="issue-tool-thumb" src="${iconVer(tool.photo_url)}">`
    : (catIcon
      ? `<img class="issue-tool-thumb" src="${catIcon}" title="${escapeHtml(tool.category)}">`
      : `<div class="issue-tool-thumb placeholder"><i data-lucide="wrench"></i></div>`);
  const sub = [tool.brand, tool.model].filter(Boolean).join(' · ');
  const chips = [];
  if (tool.category) chips.push(escapeHtml(tool.category));
  if (tool.serial_number) chips.push('S/N: ' + escapeHtml(tool.serial_number));
  if (tool.inventory_number) chips.push('Инв: ' + escapeHtml(tool.inventory_number));
  return `
    ${thumb}
    <div class="issue-tool-meta">
      <div class="t-name">${escapeHtml(tool.name)}</div>
      ${sub ? `<div class="t-sub">${escapeHtml(sub)}</div>` : ''}
      <div class="t-chips">
        ${chips.map(c => `<span class="t-chip">${c}</span>`).join('')}
        <span class="badge ${st.badge}">${st.label}</span>
      </div>
    </div>`;
}

// Общий рендер кастомного списка сотрудников с фильтром (реалтайм поиск).
// handlerName — имя глобальной функции выбора (получает id).
function renderEmpList(listEl, employees, filter, selectedId, handlerName) {
  if (!listEl) return;
  const q = (filter || '').trim().toLowerCase();
  const items = employees.filter(e => {
    const hay = `${e.last_name} ${e.first_name} ${e.position || ''} ${e.department || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (!items.length) {
    listEl.innerHTML = `<div class="emp-pick-empty">Сотрудники не найдены</div>`;
    return;
  }

  listEl.innerHTML = items.map(e => {
    const initials = ((e.last_name || ' ')[0] + (e.first_name || ' ')[0]).toUpperCase();
    const sel = String(e.id) === String(selectedId);
    const sub = [e.position, e.department].filter(Boolean).join(' · ');
    return `
      <div class="emp-pick-item ${sel ? 'selected' : ''}" onclick="${handlerName}(${e.id})">
        <div class="emp-pick-avatar">${escapeHtml(initials)}</div>
        <div class="emp-pick-info">
          <div class="emp-pick-name">${escapeHtml(e.last_name)} ${escapeHtml(e.first_name)}</div>
          ${sub ? `<div class="emp-pick-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        ${sel ? '<i data-lucide="check" class="emp-pick-check"></i>' : ''}
      </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderIssueEmployeeList(filter = '') {
  renderEmpList(
    document.getElementById('issueEmployeeList'),
    issueEmployeesList, filter,
    document.getElementById('issueEmployeeId').value,
    'selectIssueEmployee'
  );
}

window.selectIssueEmployee = (id) => {
  document.getElementById('issueEmployeeId').value = id;
  renderIssueEmployeeList(document.getElementById('issueEmployeeSearch').value);
};

window.openIssueModal = async (toolId) => {
  const tool = toolsList.find(t => t.id === toolId);
  if (!tool) return;
  document.getElementById('issueToolId').value = toolId;
  document.getElementById('issueEmployeeId').value = '';
  document.getElementById('issueEmployeeSearch').value = '';
  document.getElementById('issueNotes').value = '';

  // Блок с подробной инфой об инструменте
  document.getElementById('issueToolInfo').innerHTML = buildToolCard(tool);

  const list = document.getElementById('issueEmployeeList');
  list.innerHTML = `<div class="emp-pick-empty">Загрузка...</div>`;
  document.getElementById('issueModalOverlay').classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();

  try {
    const res = await fetch('/api/crud/employees');
    const employees = res.ok ? await res.json() : [];
    // Уволенных не показываем — им инструмент не выдают
    issueEmployeesList = employees.filter(e => e.status !== 'fired');
    renderIssueEmployeeList('');
    document.getElementById('issueEmployeeSearch').focus();
  } catch (err) {
    list.innerHTML = `<div class="emp-pick-empty">Не удалось загрузить сотрудников</div>`;
  }
};

// === Возврат / передача инструмента ===
let transferEmployeesList = [];

function renderTransferList(filter = '') {
  renderEmpList(
    document.getElementById('transferEmployeeList'),
    transferEmployeesList, filter,
    document.getElementById('transferEmployeeId').value,
    'selectTransferEmployee'
  );
}

window.selectTransferEmployee = (id) => {
  document.getElementById('transferEmployeeId').value = id;
  renderTransferList(document.getElementById('transferSearch').value);
};

async function doReturnToStock(toolId) {
  try {
    const res = await fetch('/api/tools/return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_id: toolId })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast('Инструмент возвращён на склад', 'success');
      await loadTools();
    } else {
      showToast(data.message || 'Не удалось вернуть', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети', 'error');
  }
}

window.openReturnModal = async (toolId) => {
  const tool = toolsList.find(t => t.id === toolId);
  if (!tool) return;
  const modal = document.getElementById('returnModalOverlay');
  modal.dataset.toolId = toolId;

  document.getElementById('returnToolInfo').innerHTML = buildToolCard(tool);
  document.getElementById('returnHolder').innerHTML = tool.current_holder
    ? `Сейчас на руках у: <strong style="color:hsl(var(--text-primary))">${escapeHtml(tool.current_holder)}</strong>`
    : '';

  // Сброс к шагу 1
  document.getElementById('returnStep1').style.display = 'flex';
  document.getElementById('returnStep2').style.display = 'none';
  document.getElementById('confirmTransferBtn').style.display = 'none';
  document.getElementById('transferEmployeeId').value = '';
  document.getElementById('transferSearch').value = '';
  document.getElementById('transferEmployeeList').innerHTML = '';

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Заранее подгружаем сотрудников (кроме уволенных и текущего держателя)
  try {
    const res = await fetch('/api/crud/employees');
    const employees = res.ok ? await res.json() : [];
    transferEmployeesList = employees.filter(e => e.status !== 'fired' && e.id !== tool.current_employee_id);
  } catch (err) {
    transferEmployeesList = [];
  }
};

// ==== Карточка инструмента (детальная страница) ====
const TOOL_STATUS_LABEL = {
  available: { label: 'На складе', badge: 'badge-success' },
  assigned:  { label: 'Выдан',     badge: 'badge-warning' },
  repair:    { label: 'В ремонте', badge: 'badge-danger' },
  written_off: { label: 'Списан',  badge: 'badge-danger' }
};

function pluralDays(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return n + ' дней';
  if (b === 1) return n + ' день';
  if (b >= 2 && b <= 4) return n + ' дня';
  return n + ' дней';
}

window.openToolDetail = async (toolId) => {
  const overlay = document.getElementById('toolDetailModalOverlay');
  const body = document.getElementById('toolDetailBody');
  body.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));padding:30px;">Загрузка...</div>';
  overlay.classList.add('active');
  try {
    const res = await fetch(`/api/tools/details?id=${toolId}`);
    if (!res.ok) { body.innerHTML = '<div style="text-align:center;color:hsl(var(--accent-red));padding:30px;">Не удалось загрузить</div>'; return; }
    const data = await res.json();
    renderToolDetail(data);
  } catch (e) {
    body.innerHTML = '<div style="text-align:center;color:hsl(var(--accent-red));padding:30px;">Ошибка сети</div>';
  }
};

function renderToolDetail(data) {
  const { tool, photos, history, stats } = data;
  document.getElementById('toolDetailTitle').textContent = tool.name || 'Карточка инструмента';
  const st = TOOL_STATUS_LABEL[tool.status] || TOOL_STATUS_LABEL.available;

  const mainImg = tool.photo_url
    ? iconVer(tool.photo_url)
    : (tool.category && categoryIconMap[tool.category]) || '';
  const mainImgHtml = mainImg
    ? `<img src="${mainImg}" onclick="openLightbox('${mainImg}')" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;">`
    : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:hsl(var(--text-muted));"><i data-lucide="wrench"></i></div>`;

  const catIcon = tool.category && categoryIconMap[tool.category]
    ? `<img src="${categoryIconMap[tool.category]}" style="width:18px;height:18px;border-radius:4px;vertical-align:middle;margin-right:6px;">` : '';

  const info = [
    ['Категория', `${catIcon}${escapeHtml(tool.category || '—')}`],
    ['Бренд / модель', escapeHtml([tool.brand, tool.model].filter(Boolean).join(' · ') || '—')],
    ['Серийный №', escapeHtml(tool.serial_number || '—')],
    ['Инвентарный №', escapeHtml(tool.inventory_number || '—')],
    ['Дата покупки', tool.purchase_date ? escapeHtml(tool.purchase_date) : '—'],
    ['Сейчас у', tool.current_holder ? `<strong>${escapeHtml(tool.current_holder)}</strong>` : '<span style="color:hsl(var(--text-muted))">на складе</span>']
  ].map(([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid hsl(var(--border-color));"><span style="color:hsl(var(--text-muted));font-size:13px;">${k}</span><span style="font-size:13px;text-align:right;">${v}</span></div>`).join('');

  const statTiles = [
    ['Выдавался', stats.times_issued + ' раз', 'repeat'],
    ['В эксплуатации', pluralDays(stats.days_in_service), 'clock'],
    ['Держателей', String(stats.unique_holders), 'users'],
    ['Фото', String(stats.photos_count), 'image']
  ].map(([label, val, icon]) => `
    <div style="flex:1;min-width:110px;background:hsl(var(--bg-main));border:1px solid hsl(var(--border-color));border-radius:12px;padding:14px;text-align:center;">
      <i data-lucide="${icon}" style="width:20px;height:20px;color:hsl(var(--accent-cyan));"></i>
      <div style="font-size:20px;font-weight:700;margin-top:6px;">${val}</div>
      <div style="font-size:11px;color:hsl(var(--text-muted));">${label}</div>
    </div>`).join('');

  window.__detailToolId = tool.id;
  const gallery = photos.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;">
        ${photos.map((p, i) => {
          const isAvatar = tool.photo_url && p.photo_url === tool.photo_url;
          const when = p.created_at ? new Date(p.created_at.replace(' ', 'T') + 'Z')
            .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
          // Бейдж-статус: текущий аватар / порядковый номер (первое = №1)
          const corner = isAvatar
            ? `<span style="position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;gap:4px;background:hsl(var(--accent-purple));color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;"><i data-lucide="star" style="width:12px;height:12px;"></i> Аватар</span>`
            : `<span style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,0.55);color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:8px;">Фото ${i + 1}</span>`;
          const action = isAvatar ? '' :
            `<button type="button" onclick="setToolAvatar(${tool.id}, '${p.photo_url}')" title="Сделать аватаром инструмента"
                     style="width:100%;margin-top:8px;padding:7px;background:hsl(var(--accent-purple) / 0.12);border:1px solid hsl(var(--accent-purple));color:hsl(var(--text-primary));border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:6px;">
               <i data-lucide="star" style="width:14px;height:14px;"></i> Сделать аватаром
             </button>`;
          return `
          <div style="background:hsl(var(--bg-main));border:1px solid ${isAvatar ? 'hsl(var(--accent-purple))' : 'hsl(var(--border-color))'};border-radius:12px;padding:8px;">
            <div style="position:relative;">
              ${corner}
              <img src="${p.photo_url}" onclick="openLightbox('${p.photo_url}')" style="width:100%;height:150px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block;">
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:hsl(var(--text-secondary));">
              <i data-lucide="user" style="width:13px;height:13px;color:hsl(var(--text-muted));flex-shrink:0;"></i>
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.uploaded_by_name || 'Неизвестно')}</span>
            </div>
            ${when ? `<div style="display:flex;align-items:center;gap:6px;margin-top:3px;font-size:12px;color:hsl(var(--text-muted));">
              <i data-lucide="calendar" style="width:13px;height:13px;flex-shrink:0;"></i><span>${when}</span>
            </div>` : ''}
            ${action}
          </div>`;
        }).join('')}
      </div>`
    : `<div style="display:flex;align-items:center;gap:10px;color:hsl(var(--text-muted));font-size:13px;padding:16px;background:hsl(var(--bg-main));border:1px dashed hsl(var(--border-color));border-radius:12px;">
        <i data-lucide="image-off" style="width:18px;height:18px;"></i>
        <span>Фотографий пока нет. Первое загруженное фото станет аватаром инструмента.</span>
      </div>`;

  const timeline = history.length
    ? history.map(h => {
        const issued = h.issued_at ? new Date(h.issued_at.replace(' ','T')+'Z').toLocaleString('ru-RU') : '—';
        const returned = h.returned_at ? new Date(h.returned_at.replace(' ','T')+'Z').toLocaleString('ru-RU') : null;
        const dot = returned ? 'hsl(var(--text-muted))' : 'hsl(var(--accent-amber))';
        return `
          <div style="display:flex;gap:12px;">
            <div style="display:flex;flex-direction:column;align-items:center;">
              <div style="width:11px;height:11px;border-radius:50%;background:${dot};margin-top:4px;"></div>
              <div style="flex:1;width:2px;background:hsl(var(--border-color));"></div>
            </div>
            <div style="padding-bottom:16px;flex:1;">
              <div style="font-weight:600;">${escapeHtml(h.employee_name || '—')} ${returned ? '' : '<span class="badge badge-warning" style="margin-left:6px;">на руках</span>'}</div>
              <div style="font-size:12px;color:hsl(var(--text-muted));">Выдан: ${issued}${returned ? ` · Возвращён: ${returned}` : ''}</div>
              ${h.issued_by ? `<div style="font-size:12px;color:hsl(var(--text-muted));">Выдал: ${escapeHtml(h.issued_by)}</div>` : ''}
              ${h.notes ? `<div style="font-size:12px;color:hsl(var(--text-secondary));margin-top:2px;">${escapeHtml(h.notes)}</div>` : ''}
            </div>
          </div>`;
      }).join('')
    : '<div style="color:hsl(var(--text-muted));font-size:13px;">Закреплений ещё не было</div>';

  // Кнопки действий (закрывают карточку и открывают нужную модалку)
  const btns = [];
  if (tool.status !== 'written_off') {
    if (stats.is_out) btns.push(`<button class="btn btn-secondary" onclick="toolDetailAction('return', ${tool.id})"><i data-lucide="corner-down-left"></i><span>Вернуть / передать</span></button>`);
    else btns.push(`<button class="btn" onclick="toolDetailAction('issue', ${tool.id})"><i data-lucide="hand-helping"></i><span>Выдать</span></button>`);
  }
  btns.push(`<button class="btn btn-secondary" onclick="toolDetailAction('edit', ${tool.id})"><i data-lucide="edit-3"></i><span>Редактировать</span></button>`);
  btns.push(`<button class="btn btn-secondary" onclick="printToolQr(${tool.id})"><i data-lucide="printer"></i><span>Печать QR</span></button>`);
  btns.push(`<button class="btn btn-secondary" onclick="saveToolQr(${tool.id})"><i data-lucide="download"></i><span>Сохранить QR</span></button>`);

  // QR-код инструмента (ссылка на эту карточку)
  const qrBlock = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;">
      <img id="toolQrImg" src="/api/tools/qr?id=${tool.id}" alt="QR" style="width:120px;height:120px;background:#fff;border-radius:10px;padding:6px;">
      <div style="font-size:11px;color:hsl(var(--text-muted));">Сканируй → карточка</div>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="refreshToolQr(${tool.id})"><i data-lucide="refresh-cw" style="width:13px;height:13px;"></i><span>Обновить QR</span></button>
    </div>`;

  document.getElementById('toolDetailBody').innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;">
      <div style="width:200px;height:200px;border-radius:14px;overflow:hidden;border:1px solid hsl(var(--border-color));background:hsl(var(--bg-main));flex-shrink:0;">${mainImgHtml}</div>
      <div style="flex:1;min-width:240px;">
        <span class="badge ${st.badge}" style="margin-bottom:10px;display:inline-block;">${st.label}</span>
        ${info}
        ${tool.notes ? `<div style="margin-top:10px;font-size:13px;color:hsl(var(--text-secondary));"><i data-lucide="sticky-note" style="width:14px;height:14px;vertical-align:middle;"></i> ${escapeHtml(tool.notes)}</div>` : ''}
      </div>
      ${qrBlock}
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;">${btns.join('')}</div>

    <div style="margin-top:18px;padding:14px 16px;border:1px solid hsl(var(--border-color));border-radius:12px;background:hsl(var(--bg-main));display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div style="font-size:12px;color:hsl(var(--text-muted));display:flex;align-items:center;gap:8px;">
        <i data-lucide="qr-code" style="width:16px;height:16px;"></i>
        <span>Публичная карточка (по QR). Что показывать — настраивается общими правилами в разделе «Настройки».</span>
      </div>
      <a href="/tool.html?id=${tool.id}" target="_blank" rel="noopener" style="font-size:13px;color:hsl(var(--accent-cyan));display:inline-flex;align-items:center;gap:6px;white-space:nowrap;"><i data-lucide="external-link" style="width:14px;height:14px;"></i> Открыть публичную карточку</a>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin:20px 0;">${statTiles}</div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:18px 0 10px;">
      <h4 style="margin:0;font-size:14px;">Фотографии</h4>
      <button type="button" class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" onclick="document.getElementById('toolGalleryInput').click()"><i data-lucide="image-plus" style="width:14px;height:14px;"></i><span>Добавить фото</span></button>
      <input type="file" id="toolGalleryInput" accept="image/*" style="display:none;">
    </div>
    ${gallery}

    <h4 style="margin:22px 0 12px;font-size:14px;">История закреплений</h4>
    <div id="toolHistoryList" style="overflow-y:auto;">${timeline}</div>
  `;
  if (typeof lucide !== 'undefined') lucide.createIcons();

  // Загрузка нового фото в галерею (первое станет аватаром автоматически)
  const galInput = document.getElementById('toolGalleryInput');
  if (galInput) {
    galInput.addEventListener('change', async () => {
      const file = galInput.files[0];
      if (!file) return;
      showToast('Загрузка фото...', 'info');
      try {
        const url = await uploadImageToMedia(file, 'tools');
        if (!url) return showToast('Не удалось загрузить фото', 'error');
        const res = await fetch('/api/tools/photo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_id: tool.id, photo_url: url })
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(d.is_avatar ? 'Фото добавлено и стало аватаром' : 'Фото добавлено в галерею', 'success');
          window.openToolDetail(tool.id);   // перерисовать карточку
          loadTools();                       // обновить миниатюру в списке
        } else {
          showToast(d.message || 'Не удалось добавить фото', 'error');
        }
      } catch (e) {
        showToast('Ошибка загрузки фото', 'error');
      } finally {
        galInput.value = '';
      }
    });
  }

  // Ровно 5 записей истории в высоту, дальше — прокрутка
  const histBox = document.getElementById('toolHistoryList');
  if (histBox && histBox.children.length > 5) {
    let h = 0;
    for (let i = 0; i < 5; i++) h += histBox.children[i].offsetHeight;
    histBox.style.maxHeight = h + 'px';
  }
}

window.openLightbox = (src) => {
  const lb = document.getElementById('photoLightbox');
  document.getElementById('photoLightboxImg').src = src;
  lb.style.display = 'flex';
};

// Назначить аватаром фото из галереи инструмента (только из его же фото).
window.setToolAvatar = async (toolId, photoUrl) => {
  try {
    const res = await fetch('/api/tools/set-avatar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_id: toolId, photo_url: photoUrl })
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast('Аватар обновлён', 'success');
      window.openToolDetail(toolId);
      loadTools();
    } else {
      showToast(d.message || 'Не удалось сменить аватар', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
};

// Действия из карточки — закрываем её и открываем нужную модалку
window.toolDetailAction = (action, id) => {
  document.getElementById('toolDetailModalOverlay').classList.remove('active');
  if (action === 'issue' && window.openIssueModal) openIssueModal(id);
  else if (action === 'return' && window.openReturnModal) openReturnModal(id);
  else if (action === 'edit' && window.editTool) editTool(id);
};


// Обновить отображаемый QR, минуя кэш браузера (сам QR всегда кодирует
// актуальную ссылку — кнопка просто заставляет перезагрузить картинку,
// чтобы убедиться в правильности перед печатью).
window.refreshToolQr = (id) => {
  const img = document.getElementById('toolQrImg');
  if (img) img.src = `/api/tools/qr?id=${id}&_=${Date.now()}`;
  showToast('QR обновлён', 'success');
};

// Печать наклейки с QR-кодом
window.printToolQr = (id) => {
  const tool = toolsList.find(t => t.id === id) || {};
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) { showToast('Разрешите всплывающие окна для печати', 'error'); return; }
  w.document.write(`<!doctype html><meta charset="utf-8"><title>QR ${escapeHtml(tool.name || '')}</title>
    <body style="font-family:sans-serif;text-align:center;padding:24px;">
      <img src="/api/tools/qr?id=${id}&_=${Date.now()}" style="width:260px;height:260px;">
      <h2 style="margin:12px 0 4px;">${escapeHtml(tool.name || '')}</h2>
      <div style="color:#555;">${escapeHtml(tool.inventory_number || '')}</div>
      <div style="color:#888;font-size:13px;">${escapeHtml([tool.brand, tool.model].filter(Boolean).join(' · '))}</div>
      <script>window.onload=()=>{setTimeout(()=>window.print(),300)}<\/script>
    </body>`);
  w.document.close();
};

// Сохранить QR-код инструмента файлом (PNG, с подписью инв.№; при ошибке — SVG)
window.saveToolQr = async (id) => {
  const tool = toolsList.find(t => t.id === id) || {};
  const base = `qr-${(tool.inventory_number || tool.name || 'tool').toString().replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  try {
    const res = await fetch(`/api/tools/qr?id=${id}&_=${Date.now()}`);
    const svgText = await res.text();
    // Рендерим SVG на canvas → PNG (крупнее и с подписью инвентарного номера)
    const size = 600, pad = 40, labelH = tool.inventory_number ? 60 : 20;
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size + pad * 2;
      canvas.height = size + pad * 2 + labelH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, size, size);
      if (tool.inventory_number) {
        ctx.fillStyle = '#111111';
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(tool.inventory_number, canvas.width / 2, size + pad + 44);
      }
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        triggerDownload(URL.createObjectURL(blob), base + '.png', true);
        showToast('QR сохранён (PNG)', 'success');
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Фолбэк: скачиваем исходный SVG
      triggerDownload(URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' })), base + '.svg', true);
      showToast('QR сохранён (SVG)', 'success');
    };
    img.src = url;
  } catch (e) {
    showToast('Не удалось сохранить QR', 'error');
  }
};

function triggerDownload(href, filename, revoke) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 2000);
}

// Открытие карточки по deep-link ?tool=<id> (из QR-кода)
function handleToolDeepLink() {
  const id = parseInt(new URLSearchParams(window.location.search).get('tool'), 10);
  if (Number.isInteger(id) && id > 0) {
    // переключаемся в раздел инструментов и открываем карточку
    if (window.location.hash !== '#tools') window.location.hash = '#tools';
    setTimeout(() => window.openToolDetail(id), 400);
  }
}

window.openToolHistory = async (toolId) => {
  const tool = toolsList.find(t => t.id === toolId);
  document.getElementById('historyToolName').textContent = tool ? tool.name : '';
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:hsl(var(--text-muted));padding:16px;">Загрузка...</td></tr>';
  document.getElementById('historyModalOverlay').classList.add('active');

  try {
    const res = await fetch(`/api/tools/history?tool_id=${toolId}`);
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:hsl(var(--text-muted));padding:16px;">Закреплений ещё не было</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    rows.forEach(r => {
      const issued = r.issued_at ? new Date(r.issued_at).toLocaleString('ru-RU') : '—';
      const returned = r.returned_at
        ? new Date(r.returned_at).toLocaleString('ru-RU')
        : '<span class="badge badge-warning">на руках</span>';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(r.employee_name || '—')}</strong>${r.notes ? `<div style="font-size:12px;color:hsl(var(--text-muted))">${escapeHtml(r.notes)}</div>` : ''}</td>
        <td style="font-size:13px;">${issued}</td>
        <td style="font-size:13px;">${returned}</td>
        <td style="font-size:13px;color:hsl(var(--text-muted));">${escapeHtml(r.issued_by || '—')}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:hsl(var(--accent-red));padding:16px;">Ошибка загрузки истории</td></tr>';
  }
};

