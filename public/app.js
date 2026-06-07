// Configuration & State
let currentUser = null;
let articles = [];
let quill = null;
let usersList = [];
let fullLogsList = [];

// DOM Elements
const sections = document.querySelectorAll('.app-section');
const navItems = document.querySelectorAll('.nav-list .nav-item');
const toastContainer = document.getElementById('toastContainer');

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  await checkSession();
  setupNavigation();
  initApp();
  
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
    }
  } catch (err) {
    console.error('Session check error:', err);
    window.location.href = '/login.html';
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
  if (document.getElementById('quillEditor')) {
    quill = new Quill('#quillEditor', {
      theme: 'snow',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          ['blockquote', 'code-block'],
          [{ 'list': 'ordered'}, { 'list': 'bullet' }],
          ['clean']
        ]
      }
    });
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
  document.getElementById('crudSearch').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    renderArticles(query);
  });

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

  // Media File Manager Upload Setup
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  dropZone.addEventListener('click', () => fileInput.click());

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
      uploadFiles(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      uploadFiles(e.target.files);
    }
  });

  // Settings Save handler
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputs = document.querySelectorAll('#settingsContainer input');
    const settings = {};
    inputs.forEach(input => {
      settings[input.name] = input.value;
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

  const openUserModal = (title = 'Добавить пользователя', id = '', username = '', email = '', role = 'User') => {
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

      const payload = { username, email, role };
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
}

// Load data specifically for selected route
function loadSectionData(hash) {
  if (hash === 'dashboard') {
    loadDashboardStats();
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
  }
}

// API: Dashboard stats loader
async function loadDashboardStats() {
  try {
    const res = await fetch('/api/dashboard/stats');
    if (res.ok) {
      const data = await res.json();
      document.getElementById('stat-users').textContent = data.users;
      document.getElementById('stat-articles').textContent = data.articles;
      document.getElementById('stat-media').textContent = data.mediaFiles;
    }
    await loadLogs();
  } catch (err) {
    console.error('Failed to load stats:', err);
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
    document.getElementById('articleContent').value = art.content || '';
    document.getElementById('articleStatus').value = art.status;
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

// API: Media library loader & Uploader
async function loadMedia() {
  const grid = document.getElementById('mediaGrid');
  grid.innerHTML = '<div style="color: hsl(var(--text-muted));">Загрузка файлов...</div>';

  try {
    const res = await fetch('/api/media');
    if (res.ok) {
      const files = await res.json();
      grid.innerHTML = '';
      
      if (files.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: hsl(var(--text-muted)); padding: 40px;">Медиатека пуста. Загрузите файлы перетаскиванием выше.</div>';
        return;
      }

      files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'media-item';
        
        const isImage = file.mime_type.startsWith('image/');
        const previewEl = isImage 
          ? `<img src="${file.file_url}" alt="${escapeHtml(file.filename)}">`
          : `<i data-lucide="file" style="width: 48px; height: 48px; color: hsl(var(--text-secondary));"></i>`;

        const sizeMB = (file.file_size / (1024 * 1024)).toFixed(2);

        item.innerHTML = `
          <div class="media-preview">${previewEl}</div>
          <div class="media-info">
            <div class="media-title" title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</div>
            <div class="media-meta">
              <span>${sizeMB} MB</span>
              <a href="${file.file_url}" target="_blank" style="color: hsl(var(--accent-cyan)); text-decoration: none;">Открыть</a>
            </div>
          </div>
          <button class="media-delete" onclick="deleteMedia(${file.id})"><i data-lucide="trash-2" style="width: 14px; height: 14px;"></i></button>
        `;
        grid.appendChild(item);
      });
      
      lucide.createIcons();
    }
  } catch (err) {
    showToast('Ошибка загрузки медиатеки', 'error');
  }
}

async function uploadFiles(filesList) {
  const formData = new FormData();
  for (let i = 0; i < filesList.length; i++) {
    formData.append('files', filesList[i]);
  }

  showToast('Загрузка файлов...', 'info');

  try {
    const res = await fetch('/api/media', {
      method: 'POST',
      body: formData
    });

    if (res.ok) {
      showToast('Файлы успешно загружены', 'success');
      await loadMedia();
    } else {
      const err = await res.json();
      showToast(err.message || 'Ошибка загрузки файлов', 'error');
    }
  } catch (err) {
    showToast('Ошибка сети при загрузке файлов', 'error');
  }
}

window.deleteMedia = async (id) => {
  if (confirm('Вы уверены, что хотите удалить этот файл?')) {
    try {
      const res = await fetch(`/api/media?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Файл удален', 'success');
        await loadMedia();
      } else {
        showToast('Не удалось удалить файл', 'error');
      }
    } catch (err) {
      showToast('Ошибка удаления файла', 'error');
    }
  }
};

// API: Settings loader
async function loadSettings() {
  const container = document.getElementById('settingsContainer');
  container.innerHTML = '<div style="color: hsl(var(--text-muted));">Загрузка настроек...</div>';

  try {
    const res = await fetch('/api/settings');
    if (res.ok) {
      const settings = await res.json();
      container.innerHTML = '';
      
      settings.forEach(set => {
        const group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML = `
          <label>${escapeHtml(set.description || set.key)}</label>
          <input type="text" name="${escapeHtml(set.key)}" value="${escapeHtml(set.value || '')}" class="form-control">
        `;
        container.appendChild(group);
      });
    }
  } catch (err) {
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
    const dateFormatted = new Date(u.created_at).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    tr.innerHTML = `
      <td>${u.id}</td>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${escapeHtml(u.email)}</td>
      <td>${roleBadge}</td>
      <td>${dateFormatted}</td>
      <td style="text-align: right;">
        <div class="action-btns" style="justify-content: flex-end;">
          <button class="action-btn edit" onclick="editUser(${u.id})"><i data-lucide="edit-3"></i></button>
          <button class="action-btn delete" onclick="deleteUser(${u.id})"><i data-lucide="trash-2"></i></button>
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

async function loadSupportTickets() {
  try {
    const res = await fetch('/api/support/tickets');
    if (res.ok) {
      const data = await res.json();
      renderTickets(data.tickets);
      
      // Start polling for new tickets/messages
      if (supportPollingInterval) clearInterval(supportPollingInterval);
      supportPollingInterval = setInterval(async () => {
        // Poll logic
        if (document.getElementById('section-support') && document.getElementById('section-support').classList.contains('active')) {
          const tRes = await fetch('/api/support/tickets');
          if (tRes.ok) {
            const tData = await tRes.json();
            renderTickets(tData.tickets);
            if (activeTicketId) {
              loadSupportMessages(activeTicketId, true);
            }
          }
        } else {
          clearInterval(supportPollingInterval);
        }
      }, 5000);
    }
  } catch (err) {
    showToast('Ошибка загрузки тикетов', 'error');
  }
}

function renderTickets(tickets) {
  const list = document.getElementById('ticketsList');
  if (!list) return;
  if (!tickets.length) {
    list.innerHTML = '<div style="padding: 20px; color: hsl(var(--text-muted)); text-align: center;">Нет активных диалогов</div>';
    return;
  }
  
  let html = '';
  tickets.forEach(t => {
    const isActive = t.ticket_id === activeTicketId ? 'background: rgba(255,255,255,0.05);' : '';
    const badge = t.unread_count > 0 ? `<span style="background: var(--accent-purple); color: white; border-radius: 10px; padding: 2px 6px; font-size: 10px; font-weight: bold;">${t.unread_count}</span>` : '';
    const avatarLetter = t.name.charAt(0).toUpperCase();
    
    html += `
      <div style="padding: 12px 16px; border-bottom: 1px solid hsl(var(--border-color)); cursor: pointer; display: flex; align-items: center; gap: 12px; transition: background 0.2s; ${isActive}" onclick="openSupportChat('${t.ticket_id}', '${escapeHtml(t.name)}', '${escapeHtml(t.email)}')">
        <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--bg-surface); display: flex; align-items: center; justify-content: center; font-weight: bold;">${avatarLetter}</div>
        <div style="flex: 1; overflow: hidden;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <strong style="font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.name)}</strong>
            ${badge}
          </div>
          <div style="font-size: 12px; color: hsl(var(--text-muted)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(t.email || 'Гость')}</div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;
}

window.openSupportChat = (ticketId, name, email) => {
  activeTicketId = ticketId;
  document.getElementById('chatEmptyState').style.display = 'none';
  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatMessages').style.display = 'flex';
  document.getElementById('chatInputArea').style.display = 'block';
  
  document.getElementById('chatHeaderName').textContent = name;
  document.getElementById('chatHeaderEmail').textContent = email || 'Гость';
  document.getElementById('chatHeaderAvatar').textContent = name.charAt(0).toUpperCase();
  
  loadSupportTickets();
  loadSupportMessages(ticketId);
};

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

