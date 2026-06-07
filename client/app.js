document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  document.getElementById('currentYear').textContent = new Date().getFullYear();

  await loadSettings();
  await loadArticles();
  await checkAuth(); // Проверяем сессию и обновляем навбар
});

// Проверка сессии для динамического навбара
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      const user = data.user;
      // Скрываем гостевые ссылки, показываем авторизованные
      document.getElementById('guestNav').style.display = 'none';
      const authNav = document.getElementById('authNav');
      authNav.style.display = 'flex';
      
      // Удаляем старую кнопку админ-панели, если она была добавлена
      const oldAdminLink = document.getElementById('navAdminPanel');
      if (oldAdminLink) oldAdminLink.remove();

      // Ссылка на кабинет для всех
      const cabinetLink = document.getElementById('cabinetLink');
      const navUsername = document.getElementById('navUsername');
      cabinetLink.href = '/cabinet.html';
      navUsername.textContent = user.username;

      // Скрываем блоки регистрации для авторизованного пользователя
      const sidebarRegBlock = document.getElementById('sidebarRegisterBlock');
      if (sidebarRegBlock) sidebarRegBlock.style.display = 'none';

      const heroRegBtn = document.getElementById('heroRegisterBtn');
      if (heroRegBtn) {
        heroRegBtn.textContent = 'Личный кабинет';
        heroRegBtn.href = '/cabinet.html';
      }

      // Если админ или суперадмин — добавляем кнопку админ-панели
      if (user.role === 'Admin' || user.role === 'Superadmin') {
        const adminLink = document.createElement('a');
        adminLink.href = '/admin/';
        adminLink.id = 'navAdminPanel';
        adminLink.className = 'admin-link';
        adminLink.style.background = 'linear-gradient(135deg, var(--accent-purple), var(--accent-cyan))';
        adminLink.style.color = '#fff';
        adminLink.style.display = 'inline-flex';
        adminLink.style.alignItems = 'center';
        adminLink.style.gap = '6px';
        adminLink.style.marginRight = '8px';
        adminLink.innerHTML = '<i data-lucide="settings" style="width:16px;height:16px;"></i> Панель';
        authNav.insertBefore(adminLink, cabinetLink);
      }
      // Если авторизован, обновляем плашку поддержки
      const promptText = document.getElementById('supportPromptText');
      if (promptText) {
        promptText.textContent = 'Вы авторизованы. Перейдите в личный кабинет, чтобы общаться с техподдержкой в реальном времени.';
      }
      const supportActionButtons = document.getElementById('supportActionButtons');
      if (supportActionButtons) {
        supportActionButtons.innerHTML = `
          <a href="/cabinet.html" class="btn btn--primary" style="text-decoration: none; padding: 12px 24px;">В личный кабинет</a>
        `;
      }
      lucide.createIcons();
    }
    // Если не авторизован — оставляем гостевые ссылки
  } catch(e) { /* сетевая ошибка — оставляем гостевые ссылки */ }
}


// Загрузка настроек с публичного API
async function loadSettings() {
  try {
    const res = await fetch('/api/public/settings');
    if (!res.ok) return;
    
    const settings = await res.json();
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });

    const siteName = settingsMap['site_name'] || 'Мой Блог';
    
    document.title = siteName;
    document.getElementById('siteName').textContent = siteName;
    document.getElementById('footerSiteName').textContent = siteName;
    
    if (settingsMap['hero_title']) {
      document.getElementById('heroTitle').textContent = settingsMap['hero_title'];
    }
    
    if (settingsMap['site_description']) {
      document.getElementById('heroSubtitle').textContent = settingsMap['site_description'];
    }

    if (settingsMap['about_title']) {
      document.getElementById('aboutTitle').textContent = settingsMap['about_title'];
    }
    if (settingsMap['about_subtitle']) {
      document.getElementById('aboutSubtitle').textContent = settingsMap['about_subtitle'];
    }
    if (settingsMap['about_card1_title']) {
      document.getElementById('aboutCard1Title').textContent = settingsMap['about_card1_title'];
    }
    if (settingsMap['about_card1_text']) {
      document.getElementById('aboutCard1Text').textContent = settingsMap['about_card1_text'];
    }
    if (settingsMap['about_card2_title']) {
      document.getElementById('aboutCard2Title').textContent = settingsMap['about_card2_title'];
    }
    if (settingsMap['about_card2_text']) {
      document.getElementById('aboutCard2Text').textContent = settingsMap['about_card2_text'];
    }
    if (settingsMap['contact_title']) {
      document.getElementById('contactTitle').textContent = settingsMap['contact_title'];
    }
    if (settingsMap['contact_subtitle']) {
      document.getElementById('contactSubtitle').textContent = settingsMap['contact_subtitle'];
    }
    if (settingsMap['contact_email']) {
      document.getElementById('contactEmail').textContent = settingsMap['contact_email'];
    }
    if (settingsMap['contact_address']) {
      document.getElementById('contactAddress').textContent = settingsMap['contact_address'];
    }

  } catch (err) {
    console.error('Ошибка загрузки настроек:', err);
  }
}

// Загрузка статей
async function loadArticles() {
  const grid = document.getElementById('articlesGrid');

  try {
    const res = await fetch('/api/public/articles');
    if (!res.ok) throw new Error('Network response was not ok');
    
    const articles = await res.json();
    grid.innerHTML = ''; // Очищаем скелетоны

    if (articles.length === 0) {
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-secondary); padding: 40px;">Пока нет опубликованных статей.</div>';
      return;
    }

    articles.forEach(art => {
      const card = document.createElement('article');
      card.className = 'article-card';
      
      const dateFormatted = new Date(art.created_at).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      card.innerHTML = `
        <span class="article-date">${dateFormatted}</span>
        <h2 class="article-title">${escapeHtml(art.title)}</h2>
        <div class="article-content">${art.content || 'Нет описания'}</div>
        <a href="#" class="read-more">Читать далее <i data-lucide="arrow-right" style="width: 16px; height: 16px;"></i></a>
      `;
      
      grid.appendChild(card);
    });

    lucide.createIcons();

  } catch (err) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #ff4a4a;">Ошибка при загрузке данных.</div>';
    console.error('Ошибка загрузки статей:', err);
  }
}

// Helper для экранирования HTML
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
