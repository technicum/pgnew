// Store builder — talks to the real /dashboard/builder/* JSON endpoints
// (server.js). Blocks start from window.__PZ_INITIAL_BLOCKS__ (rendered
// server-side from PDZ_blocks) and every edit here is followed by a
// fetch() to persist it; nothing is purely client-side state past the
// first paint.
(function () {
  const TYPE_META = {
    link:       { label: 'Link',       cls: 'pz-type-link',       icon: '<path d="M9 17H7A5 5 0 0 1 7 7h2" stroke="currentColor" stroke-width="1.8"/><path d="M15 7h2a5 5 0 1 1 0 10h-2" stroke="currentColor" stroke-width="1.8"/><line x1="8" x2="16" y1="12" y2="12" stroke="currentColor" stroke-width="1.8"/>', hasPrice: false, subPlaceholder: 'Link URL' },
    course:     { label: 'Course',     cls: 'pz-type-course',     icon: '<path d="M4 19.5V6a2 2 0 0 1 2-2h13v14" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 22a2 2 0 0 1-2-2v0a2 2 0 0 1 2-2h13v4H6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: true, subPlaceholder: 'e.g. 6 lessons · lifetime access' },
    booking:    { label: 'Booking',    cls: 'pz-type-booking',    icon: '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: true, subPlaceholder: 'e.g. 45 min · next slot Thu 2pm' },
    download:   { label: 'Download',   cls: 'pz-type-download',   icon: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: true, subPlaceholder: 'e.g. PDF · instant delivery' },
    membership: { label: 'Membership', cls: 'pz-type-membership', icon: '<path d="M17 20h5v-1a4 4 0 0 0-4-4M9 20H4v-1a4 4 0 0 1 4-4m5-3a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7-1a3 3 0 1 0 0-6" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', hasPrice: true, subPlaceholder: 'e.g. Private community · monthly' },
  };

  let blocks = (window.__PZ_INITIAL_BLOCKS__ || []).map((b) => ({ ...b, visible: !!b.visible }));

  const blocksList = document.getElementById('blocksList');
  const emptyBlocks = document.getElementById('emptyBlocks');
  const previewBlocks = document.getElementById('previewBlocks');
  const saveStatus = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- save status + fetch helper --------------------------------------
  let pending = 0;
  let clearErrorTimer = null;
  function setSaving() {
    pending += 1;
    saveStatus.classList.remove('error');
    saveStatus.classList.add('saving');
    saveStatusText.textContent = 'Saving…';
  }
  function setSaved() {
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
      saveStatus.classList.remove('saving', 'error');
      saveStatusText.textContent = 'Saved';
    }
  }
  function setError(message) {
    pending = Math.max(0, pending - 1);
    saveStatus.classList.remove('saving');
    saveStatus.classList.add('error');
    saveStatusText.textContent = message || 'Couldn’t save';
    clearTimeout(clearErrorTimer);
    clearErrorTimer = setTimeout(() => {
      if (pending === 0) {
        saveStatus.classList.remove('error');
        saveStatusText.textContent = 'Saved';
      }
    }, 4000);
  }

  async function api(url, options) {
    setSaving();
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        setError(data && data.error);
        throw new Error((data && data.error) || `Request failed (${res.status})`);
      }
      setSaved();
      return data;
    } catch (err) {
      if (pending > 0) setError();
      throw err;
    }
  }

  function debounce(fn, wait) {
    let timers = {};
    return function (key, ...args) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => fn(key, ...args), wait);
    };
  }

  // --- rendering ---------------------------------------------------------
  function blockCardHTML(block) {
    const meta = TYPE_META[block.type];
    const priceField = meta.hasPrice
      ? `<input type="text" class="pz-field-input pz-price" data-field="price" data-id="${block.id}" value="${escapeHTML(block.price)}" placeholder="Price" style="width:96px; flex:none;" />`
      : '';
    return `
      <div class="pz-block-card${block.visible ? '' : ' pz-hidden'}" data-id="${block.id}">
        <div class="pz-drag-handle" title="Drag to reorder (coming soon)">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>
        </div>
        <div class="grid size-10 place-items-center rounded-md shrink-0 ${meta.cls}">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18">${meta.icon}</svg>
        </div>
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:7px;">
          <span class="text-xs font-semibold text-muted-foreground" style="text-transform:uppercase; letter-spacing:.03em;">${meta.label}</span>
          <input type="text" class="pz-field-input pz-title" data-field="title" data-id="${block.id}" value="${escapeHTML(block.title)}" placeholder="Title" />
          <div style="display:flex; gap:8px;">
            <input type="text" class="pz-field-input" data-field="sub" data-id="${block.id}" value="${escapeHTML(block.sub)}" placeholder="${meta.subPlaceholder}" />
            ${priceField}
          </div>
        </div>
        <button type="button" class="pz-switch${block.visible ? ' on' : ''} toggle-visible" data-id="${block.id}" title="${block.visible ? 'Visible on your page' : 'Hidden from your page'}"></button>
        <div class="pz-kebab-wrap">
          <button type="button" class="pz-icon-btn kebab-btn" data-id="${block.id}" aria-label="More options">
            <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="19" r="1.3" fill="currentColor"/></svg>
          </button>
          <div class="pz-kebab-menu" data-menu-for="${block.id}">
            <button type="button" class="duplicate-block" data-id="${block.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Duplicate
            </button>
            <button type="button" class="danger remove-block" data-id="${block.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
              Delete
            </button>
          </div>
        </div>
      </div>`;
  }

  function previewBlockHTML(block) {
    const meta = TYPE_META[block.type];
    const priceHTML = meta.hasPrice && block.price ? `<div class="pz-phone-block-price">${escapeHTML(block.price)}</div>` : '';
    return `
      <div class="pz-phone-block">
        <div class="grid size-8 place-items-center rounded-md shrink-0 ${meta.cls}">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">${meta.icon}</svg>
        </div>
        <div style="flex:1; min-width:0;">
          <div class="pz-phone-block-title">${escapeHTML(block.title || 'Untitled')}</div>
          ${block.sub ? `<div class="pz-phone-block-sub">${escapeHTML(block.sub)}</div>` : ''}
        </div>
        ${priceHTML}
      </div>`;
  }

  function closeAllKebabMenus() {
    document.querySelectorAll('.pz-kebab-menu.open').forEach((m) => m.classList.remove('open'));
  }

  function render() {
    blocksList.innerHTML = blocks.map(blockCardHTML).join('');
    emptyBlocks.style.display = blocks.length ? 'none' : 'block';
    renderPreviewOnly();
    attachBlockListeners();
  }

  function renderPreviewOnly() {
    const visible = blocks.filter((b) => b.visible);
    previewBlocks.innerHTML = visible.length
      ? visible.map(previewBlockHTML).join('')
      : '<div class="pz-phone-empty">Add something and it’ll show up here.</div>';
  }

  const debouncedFieldSave = debounce((key, id, field, value) => {
    api(`/dashboard/builder/blocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
  }, 500);

  function attachBlockListeners() {
    blocksList.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const id = Number(e.target.dataset.id);
        const field = e.target.dataset.field;
        const block = blocks.find((b) => b.id === id);
        if (!block) return;
        block[field] = e.target.value;
        renderPreviewOnly();
        debouncedFieldSave(`${id}:${field}`, id, field, e.target.value);
      });
    });
    blocksList.querySelectorAll('.toggle-visible').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const block = blocks.find((b) => b.id === id);
        if (!block) return;
        block.visible = !block.visible;
        render();
        api(`/dashboard/builder/blocks/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ visible: block.visible }),
        }).catch(() => {
          block.visible = !block.visible;
          render();
        });
      });
    });
    blocksList.querySelectorAll('.kebab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = e.currentTarget.dataset.id;
        const menu = blocksList.querySelector(`.pz-kebab-menu[data-menu-for="${id}"]`);
        const isOpen = menu.classList.contains('open');
        closeAllKebabMenus();
        if (!isOpen) menu.classList.add('open');
      });
    });
    blocksList.querySelectorAll('.duplicate-block').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = Number(e.currentTarget.dataset.id);
        closeAllKebabMenus();
        try {
          const created = await api(`/dashboard/builder/blocks/${id}/duplicate`, { method: 'POST' });
          if (created) {
            blocks.push({ ...created, visible: !!created.visible });
            render();
          }
        } catch (err) { /* status already shown */ }
      });
    });
    blocksList.querySelectorAll('.remove-block').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        closeAllKebabMenus();
        const previous = blocks;
        blocks = blocks.filter((b) => b.id !== id);
        render();
        api(`/dashboard/builder/blocks/${id}`, { method: 'DELETE' }).catch(() => {
          blocks = previous;
          render();
        });
      });
    });
  }

  document.addEventListener('click', closeAllKebabMenus);

  // --- add-block menu ------------------------------------------------
  const addMenuBtn = document.getElementById('addMenuBtn');
  const addMenu = document.getElementById('addMenu');
  addMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addMenu.classList.toggle('open');
  });
  addMenu.querySelectorAll('button[data-type]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      addMenu.classList.remove('open');
      try {
        const created = await api('/dashboard/builder/blocks', {
          method: 'POST',
          body: JSON.stringify({ type }),
        });
        blocks.push({ ...created, visible: !!created.visible });
        render();
        requestAnimationFrame(() => {
          const last = blocksList.querySelector('.pz-block-card:last-child .pz-title');
          if (last) last.focus();
        });
      } catch (err) { /* status already shown */ }
    });
  });
  document.addEventListener('click', (e) => {
    if (!addMenu.contains(e.target) && e.target !== addMenuBtn) addMenu.classList.remove('open');
  });

  // --- rail tab switching ---------------------------------------------
  document.querySelectorAll('.pz-rail-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pz-rail-btn[data-tab]').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.pz-tabpanel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // --- design tab -------------------------------------------------------
  const badgeToggle = document.getElementById('badgeToggle');
  const previewBadge = document.getElementById('previewBadge');
  let currentAccent = window.__PZ_ACCENT__ || '#ff6b4a';
  document.documentElement.style.setProperty('--preview-accent', currentAccent);
  document.querySelectorAll('.pz-swatch').forEach((btn) => {
    if (btn.dataset.color.toLowerCase() === currentAccent.toLowerCase()) btn.classList.add('active');
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pz-swatch').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      currentAccent = btn.dataset.color;
      document.documentElement.style.setProperty('--preview-accent', currentAccent);
      api('/dashboard/builder/design', {
        method: 'POST',
        body: JSON.stringify({ accentColor: currentAccent, showBadge: badgeToggle.classList.contains('on') }),
      }).catch(() => {});
    });
  });
  badgeToggle.addEventListener('click', () => {
    const on = badgeToggle.classList.toggle('on');
    previewBadge.style.display = on ? '' : 'none';
    api('/dashboard/builder/design', {
      method: 'POST',
      body: JSON.stringify({ accentColor: currentAccent, showBadge: on }),
    }).catch(() => {
      badgeToggle.classList.toggle('on');
      previewBadge.style.display = badgeToggle.classList.contains('on') ? '' : 'none';
    });
  });

  // --- promo bar dismiss --------------------------------------------
  const promoClose = document.getElementById('promoClose');
  if (promoClose) {
    promoClose.addEventListener('click', () => {
      document.getElementById('promoBar').style.display = 'none';
    });
  }

  // --- profile tab -----------------------------------------------------
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'U';
  }

  const displayName = document.getElementById('displayName');
  const bio = document.getElementById('bio');
  const handle = document.getElementById('handle');
  const handleError = document.getElementById('handleError');
  const previewName = document.getElementById('previewName');
  const previewBio = document.getElementById('previewBio');
  const previewInitials = document.getElementById('previewInitials');
  const avatarInitials = document.getElementById('avatarInitials');
  const switcherInitials = document.getElementById('switcherInitials');
  const switcherHandle = document.getElementById('switcherHandle');
  const previewUrl = document.getElementById('previewUrl');

  function saveProfile() {
    api('/dashboard/builder/profile', {
      method: 'POST',
      body: JSON.stringify({ name: displayName.value, handle: handle.value, bio: bio.value }),
    }).then((data) => {
      handleError.classList.remove('show');
      if (data && data.user) {
        switcherHandle.textContent = `@${data.user.handle}`;
        previewUrl.textContent = `${data.user.handle}.${window.__PZ_SITE_DOMAIN__}`;
      }
    }).catch((err) => {
      if (String(err.message || '').toLowerCase().includes('handle')) {
        handleError.textContent = err.message;
        handleError.classList.add('show');
      }
    });
  }
  const debouncedProfileSave = debounce(() => saveProfile(), 700);

  displayName.addEventListener('input', () => {
    previewName.textContent = displayName.value || 'Your name';
    const i = initials(displayName.value);
    previewInitials.textContent = i;
    avatarInitials.textContent = i;
    switcherInitials.textContent = i;
    debouncedProfileSave('profile');
  });
  bio.addEventListener('input', () => {
    previewBio.textContent = bio.value;
    debouncedProfileSave('profile');
  });
  handle.addEventListener('input', () => {
    debouncedProfileSave('profile');
  });

  render();
})();
