// Lead magnets dashboard — talks to the real /dashboard/lead-magnets/*
// JSON endpoints (server.js). Magnets start from
// window.__PZ_INITIAL_MAGNETS__ (rendered server-side from
// PDZ_lead_magnets); every edit fires a debounced fetch() to persist,
// same pattern as public/js/builder.js.
(function () {
  let magnets = window.__PZ_INITIAL_MAGNETS__ || [];
  // The merchant's store origin (https://meera.pagezaper.com) — every
  // lead magnet's public page hangs off it.
  const storeUrl = window.__PZ_STORE_URL__;

  const magnetsList = document.getElementById('magnetsList');
  const emptyMagnets = document.getElementById('emptyMagnets');
  const magnetCount = document.getElementById('magnetCount');
  const magnetCountLabel = document.getElementById('magnetCountLabel');
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
    const timers = {};
    return function (key, ...args) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => fn(key, ...args), wait);
    };
  }

  // --- rendering -----------------------------------------------------
  function publicUrl(magnet) {
    return `${storeUrl}/${magnet.slug}`;
  }
  const storeHost = storeUrl.replace(/^https?:\/\//, '');

  // Dashboard field name -> the column name magnets carry from the server.
  const FIELD_KEYS = { ctaText: 'cta_text', fileUrl: 'file_url', successMessage: 'success_message' };

  // Which cards have "Page options" open — render() rebuilds every card,
  // so this is what keeps a panel open across a toggle or a save.
  const openOptions = new Set();

  // The magnet currently loaded into the builder by a card's Edit button,
  // or null while the builder is creating a new one.
  let editingId = null;

  // --- shared: extra questions + accent color (builder Form/Design tabs) --
  // Same set as QUESTION_TYPES in lib/leadMagnets.js. label is what a new
  // question of that type starts out called.
  const QUESTION_TYPES = {
    text: { cls: 'type-text', name: 'Text', label: 'Question', hint: 'A short written answer', icon: '<path d="M5 6h14M12 6v13"/>' },
    number: { cls: 'type-number', name: 'Number', label: 'Number', hint: 'Digits only — age, budget, team size', icon: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>' },
    email: { cls: 'type-email', name: 'Email', label: 'Work email', hint: 'A second email address', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>' },
    phone: { cls: 'type-phone', name: 'Phone', label: 'WhatsApp number', hint: 'Another phone or WhatsApp number', icon: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>' },
    url: { cls: 'type-url', name: 'Link', label: 'Website', hint: 'A website or social profile', icon: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>' },
    date: { cls: 'type-date', name: 'Date', label: 'Date', hint: 'A day picked from a calendar', icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
    radio: { cls: 'type-radio', name: 'Radio buttons', label: 'Pick one', options: true, hint: 'One choice, all shown at once', icon: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>' },
    checkboxes: { cls: 'type-checkboxes', name: 'Checkboxes', label: 'Pick any that apply', options: true, hint: 'Several choices from your list', icon: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 7.5h7M14 17.5h7"/>' },
    dropdown: { cls: 'type-dropdown', name: 'Dropdown', label: 'Pick one', options: true, hint: 'One choice from a compact list', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9 11 3 3 3-3"/>' },
    checkbox: { cls: 'type-checkbox', name: 'Single tick box', label: 'I agree to be contacted', hint: 'One yes/no or consent box', icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>' },
  };
  const MAX_QUESTIONS = 4;
  const MAX_QUESTION_OPTIONS = 6;
  function questionIconHTML(meta) {
    return `<span class="q-type-icon ${meta.cls}"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${meta.icon}</svg></span>`;
  }
  // The "Add question" popup — one tile per type, shared by the create form
  // and every card. Whoever opens it passes what to do with the chosen type.
  const typeModal = document.getElementById('qTypeModal');
  const typeGrid = document.getElementById('qTypeGrid');
  let onTypePicked = null;
  let typePickerOpener = null;
  typeGrid.innerHTML = Object.keys(QUESTION_TYPES).map((type) => `
        <button type="button" class="q-type-tile" data-qtype="${type}">
          ${questionIconHTML(QUESTION_TYPES[type])}
          <span class="q-type-tile-text">
            <strong>${QUESTION_TYPES[type].name}</strong>
            <span>${QUESTION_TYPES[type].hint}</span>
          </span>
        </button>`).join('');
  function openTypePicker(onPick) {
    onTypePicked = onPick;
    typePickerOpener = document.activeElement;
    typeModal.classList.add('open');
    typeModal.setAttribute('aria-hidden', 'false');
    typeGrid.querySelector('.q-type-tile').focus();
  }
  function closeTypePicker() {
    typeModal.classList.remove('open');
    typeModal.setAttribute('aria-hidden', 'true');
    onTypePicked = null;
    // Picking a type re-renders the list, so the opener may be gone by now.
    if (typePickerOpener && document.contains(typePickerOpener)) typePickerOpener.focus();
    typePickerOpener = null;
  }
  typeGrid.querySelectorAll('.q-type-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const pick = onTypePicked;
      closeTypePicker();
      if (pick) pick(tile.dataset.qtype);
    });
  });
  document.getElementById('qTypeModalClose').addEventListener('click', closeTypePicker);
  typeModal.addEventListener('click', (e) => { if (e.target === typeModal) closeTypePicker(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && typeModal.classList.contains('open')) closeTypePicker();
  });
  function newQuestion(id, type) {
    const meta = QUESTION_TYPES[type] || QUESTION_TYPES.text;
    const q = { id, type: QUESTION_TYPES[type] ? type : 'text', label: meta.label, required: false };
    if (meta.options) q.options = ['Option 1', 'Option 2'];
    return q;
  }
  function parseOptions(value) {
    const options = String(value).split(',').map((o) => o.trim().slice(0, 30)).filter(Boolean);
    return [...new Set(options)].slice(0, MAX_QUESTION_OPTIONS);
  }
  const ACCENT_PRESETS = ['#1261ef', '#c0322a', '#12733f', '#7048e8', '#07134f'];
  function shadeHex(hex, amount) {
    const num = parseInt(hex.slice(1), 16);
    const clamp = (n) => Math.min(255, Math.max(0, n));
    const r = clamp((num >> 16) + amount);
    const g = clamp(((num >> 8) & 0xff) + amount);
    const b = clamp((num & 0xff) + amount);
    return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
  }

  // owner is 'new' for the create form, or a magnet id for an existing card
  // — every handler below reads it back off the row to know what to save.
  function questionRowHTML(q, owner) {
    const meta = QUESTION_TYPES[q.type] || QUESTION_TYPES.text;
    return `
      <div class="q-row" draggable="true" data-qid="${q.id}" data-owner="${owner}">
        <span class="q-handle"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.3"/><circle cx="8" cy="12" r="1.3"/><circle cx="8" cy="18" r="1.3"/><circle cx="16" cy="6" r="1.3"/><circle cx="16" cy="12" r="1.3"/><circle cx="16" cy="18" r="1.3"/></svg></span>
        ${questionIconHTML(meta)}
        <div class="q-body">
          <div class="q-label-row">
            <input class="q-label-input" data-qlabel value="${escapeHTML(q.label)}" />
            <button type="button" class="q-required-toggle${q.required ? ' on' : ''}" data-qrequired title="Required">*</button>
          </div>
          <div class="q-type-name">${meta.name}${q.required ? ' · required' : ' · optional'}</div>
          ${meta.options ? `<input class="q-options-input" data-qoptions value="${escapeHTML((q.options || []).join(', '))}" placeholder="Choices, separated by commas" aria-label="Choices" />` : ''}
        </div>
        <button type="button" class="q-remove" data-qremove aria-label="Remove question">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>`;
  }

  function swatchRowHTML(accent, owner) {
    return ACCENT_PRESETS.map((c) => `<button type="button" class="swatch${accent === c ? ' active' : ''}" data-accent="${c}" data-owner="${owner}" style="background:${c};" aria-label="Accent color"></button>`).join('')
      + `<span class="swatch swatch-custom${ACCENT_PRESETS.includes(accent) ? '' : ' active'}" title="Custom color">
           <input type="color" class="custom-accent" data-owner="${owner}" value="${accent}" />
         </span>`;
  }

  // 'new' for the create form's in-progress list, a magnet id (number) for
  // an existing card's own extra_questions array — every caller below goes
  // through these three so both contexts share one implementation.
  let builderQuestions = [];
  let builderNextQid = 1;
  function getQuestions(owner) {
    if (owner === 'new') return builderQuestions;
    const magnet = magnets.find((m) => m.id === owner);
    if (!magnet) return [];
    if (!magnet.extra_questions) magnet.extra_questions = [];
    return magnet.extra_questions;
  }
  function removeQuestion(owner, qid) {
    const arr = getQuestions(owner);
    const idx = arr.findIndex((q) => q.id === qid);
    if (idx !== -1) arr.splice(idx, 1);
  }
  function reorderQuestions(owner, fromId, toId) {
    const arr = getQuestions(owner);
    const fromIdx = arr.findIndex((q) => q.id === fromId);
    const toIdx = arr.findIndex((q) => q.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    arr.splice(toIdx, 0, arr.splice(fromIdx, 1)[0]);
  }

  // Wires one rendered q-list's rows: label typing calls onSave only (so
  // focus survives a keystroke), everything structural (required toggle,
  // remove, drag reorder) calls onRerender then onSave.
  function attachQuestionRowListeners(list, owner, onSave, onRerender) {
    list.querySelectorAll('[data-qlabel]').forEach((input) => {
      input.addEventListener('input', () => {
        const qid = Number(input.closest('.q-row').dataset.qid);
        const q = getQuestions(owner).find((x) => x.id === qid);
        if (!q) return;
        q.label = input.value;
        onSave();
      });
    });
    list.querySelectorAll('[data-qoptions]').forEach((input) => {
      input.addEventListener('input', () => {
        const qid = Number(input.closest('.q-row').dataset.qid);
        const q = getQuestions(owner).find((x) => x.id === qid);
        if (!q) return;
        q.options = parseOptions(input.value);
        onSave();
      });
    });
    list.querySelectorAll('[data-qrequired]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qid = Number(btn.closest('.q-row').dataset.qid);
        const q = getQuestions(owner).find((x) => x.id === qid);
        if (!q) return;
        q.required = !q.required;
        onRerender();
        onSave();
      });
    });
    list.querySelectorAll('[data-qremove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const qid = Number(btn.closest('.q-row').dataset.qid);
        removeQuestion(owner, qid);
        onRerender();
        onSave();
      });
    });
    let dragQid = null;
    list.querySelectorAll('.q-row').forEach((row) => {
      row.addEventListener('dragstart', () => { dragQid = Number(row.dataset.qid); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        list.querySelectorAll('.q-row').forEach((r) => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const targetQid = Number(row.dataset.qid);
        if (dragQid === null || dragQid === targetQid) return;
        reorderQuestions(owner, dragQid, targetQid);
        onRerender();
        onSave();
      });
    });
  }

  // The three standard fields on the public form, each switchable — col is
  // the column a magnet carries from the server, key the name the API takes.
  const FORM_FIELDS = [
    { col: 'collect_name', key: 'collectName', label: 'Full name' },
    { col: 'collect_email', key: 'collectEmail', label: 'Email' },
    { col: 'collect_phone', key: 'collectPhone', label: 'Phone number' },
  ];
  function fieldToggleHTML(magnet, field) {
    const on = !!magnet[field.col];
    return `
                  <div class="pz-option-row">
                    <button type="button" class="pz-switch toggle-field${on ? ' on' : ''}" data-id="${magnet.id}" data-col="${field.col}" aria-label="Ask for ${field.label.toLowerCase()}" aria-pressed="${on ? 'true' : 'false'}"></button>
                    <span>${field.label}</span>
                  </div>`;
  }

  function statsHTML(magnet) {
    const views = magnet.view_count || 0;
    const signups = magnet.signup_count || 0;
    // Views only started counting after signups did, so an older magnet
    // can have more signups than views — no honest rate to show for it.
    const rate = views > 0 && signups <= views ? `${Math.round((signups / views) * 100)}%` : '—';
    return `
          <span class="pz-magnet-stat"><strong>${views}</strong> ${views === 1 ? 'view' : 'views'}</span>
          <span class="pz-magnet-stat"><strong>${signups}</strong> ${signups === 1 ? 'signup' : 'signups'}</span>
          <span class="pz-magnet-stat"><strong>${rate}</strong> conversion</span>`;
  }

  function magnetCardHTML(magnet) {
    return `
      <div class="pz-magnet-card${magnet.visible ? '' : ' pz-hidden'}${magnet.id === editingId ? ' pz-editing' : ''}" data-id="${magnet.id}">
        <div class="pz-magnet-top">
          <div class="pz-magnet-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v4"/><path d="M12 15h.01"/></svg>
          </div>
          <div class="pz-magnet-fields">
            <div class="pz-magnet-title-row">
              <input type="text" class="pz-field-input pz-title" data-field="title" data-id="${magnet.id}" value="${escapeHTML(magnet.title)}" placeholder="Title" style="font-weight:600;" />
              <input type="text" class="pz-field-input" data-field="ctaText" data-id="${magnet.id}" value="${escapeHTML(magnet.cta_text)}" placeholder="Button text" style="max-width:160px;" />
            </div>
            <textarea class="pz-field-input" data-field="description" data-id="${magnet.id}" rows="1" placeholder="Description (optional)" style="resize:vertical;">${escapeHTML(magnet.description)}</textarea>
            <input type="url" class="pz-field-input" data-field="fileUrl" data-id="${magnet.id}" value="${escapeHTML(magnet.file_url)}" placeholder="Link to the file" />
            <details class="pz-magnet-options" data-id="${magnet.id}"${openOptions.has(magnet.id) ? ' open' : ''}>
              <summary>Page options</summary>
              <div class="pz-magnet-option">
                <label for="slug-${magnet.id}">Link</label>
                <div class="pz-slug-field">
                  <span>${escapeHTML(storeHost)}/</span>
                  <input type="text" id="slug-${magnet.id}" class="slug-input" data-id="${magnet.id}" value="${escapeHTML(magnet.slug)}" maxlength="60" spellcheck="false" autocapitalize="off" />
                </div>
                <p class="pz-option-hint">Changing this breaks any link you’ve already shared.</p>
                <p class="pz-field-error slug-error"></p>
              </div>
              <div class="pz-magnet-option">
                <label for="success-${magnet.id}">Thank-you message</label>
                <textarea id="success-${magnet.id}" class="pz-field-input" data-field="successMessage" data-id="${magnet.id}" rows="2" maxlength="300" placeholder="Shown after signup — leave blank for the default." style="padding:8px 11px; resize:vertical;">${escapeHTML(magnet.success_message || '')}</textarea>
              </div>
              <div class="pz-magnet-option">
                <label>Form fields</label>
                <div class="pz-field-toggles">${FORM_FIELDS.map((f) => fieldToggleHTML(magnet, f)).join('')}</div>
              </div>
              <div class="pz-magnet-option">
                <label>Extra questions</label>
                <div class="q-list card-q-list" data-id="${magnet.id}">${(magnet.extra_questions || []).map((q) => questionRowHTML(q, magnet.id)).join('')}</div>
                <div class="add-q-menu">
                  <button type="button" class="add-q-btn card-add-q-btn" data-id="${magnet.id}">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5v14"/></svg>
                    Add question
                  </button>
                </div>
              </div>
              <div class="pz-magnet-option">
                <label>Accent color</label>
                <div class="swatch-row card-swatch-row" data-id="${magnet.id}">${swatchRowHTML(magnet.accent_color || '#1261ef', magnet.id)}</div>
              </div>
              <div class="pz-magnet-option pz-option-row">
                <button type="button" class="pz-switch toggle-cover${magnet.show_cover ? ' on' : ''}" data-id="${magnet.id}" aria-label="Show cover graphic" aria-pressed="${magnet.show_cover ? 'true' : 'false'}"></button>
                <span>Show the cover graphic on the page</span>
              </div>
            </details>
          </div>
          <div class="pz-magnet-actions">
            <button type="button" class="pz-switch toggle-visible${magnet.visible ? ' on' : ''}" data-id="${magnet.id}" title="${magnet.visible ? 'Live — visible to anyone with the link' : 'Unpublished — the link shows a not-found page'}" aria-label="Toggle published"></button>
            <button type="button" class="pz-card-btn edit-magnet" data-id="${magnet.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              Edit
            </button>
            <button type="button" class="pz-card-btn danger remove-magnet" data-id="${magnet.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
              Delete
            </button>
          </div>
        </div>
        <div class="pz-magnet-stats">
          <div class="pz-copy-link">
            <input type="text" readonly value="${escapeHTML(publicUrl(magnet).replace(/^https?:\/\//, ''))}" onclick="this.select()" />
            <button type="button" class="pz-copy-btn copy-link-btn" data-id="${magnet.id}">Copy link</button>
            <a class="pz-copy-btn" href="${escapeHTML(publicUrl(magnet))}" target="_blank" rel="noopener">Open</a>
          </div>${statsHTML(magnet)}
        </div>
      </div>`;
  }

  function updateCount() {
    magnetCount.textContent = magnets.length;
    magnetCountLabel.textContent = magnets.length === 1 ? 'lead magnet' : 'lead magnets';
  }

  function render() {
    magnetsList.innerHTML = magnets.map(magnetCardHTML).join('');
    magnetsList.style.display = magnets.length ? '' : 'none';
    emptyMagnets.style.display = magnets.length ? 'none' : 'flex';
    updateCount();
    attachCardListeners();
  }

  const debouncedFieldSave = debounce((key, id, field, value) => {
    api(`/dashboard/lead-magnets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
  }, 600);

  function attachCardListeners() {
    magnetsList.querySelectorAll('input[data-field], textarea[data-field]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const id = Number(e.target.dataset.id);
        const field = e.target.dataset.field;
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet[FIELD_KEYS[field] || field] = e.target.value;
        debouncedFieldSave(`${id}:${field}`, id, field, e.target.value);
      });
    });
    magnetsList.querySelectorAll('.pz-magnet-options').forEach((details) => {
      details.addEventListener('toggle', () => {
        const id = Number(details.dataset.id);
        if (details.open) openOptions.add(id); else openOptions.delete(id);
      });
    });
    // The link saves when the field is left (or Enter is pressed), not per
    // keystroke — every half-typed value would briefly be the live URL.
    magnetsList.querySelectorAll('.slug-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet || input.value.trim() === magnet.slug) return;
        const errorEl = input.closest('.pz-magnet-option').querySelector('.slug-error');
        errorEl.classList.remove('show');
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ slug: input.value }),
        }).then((data) => {
          // The server tidies the slug (lowercase, dashes) — show what it kept.
          magnet.slug = (data && data.slug) || magnet.slug;
          render();
        }).catch((err) => {
          input.value = magnet.slug;
          errorEl.textContent = err.message || 'Couldn’t change the link.';
          errorEl.classList.add('show');
        });
      });
    });
    // Name / email / phone switches. The server refuses to turn off both
    // email and phone (its message lands in the save status), and the
    // catch puts the switch back.
    magnetsList.querySelectorAll('.toggle-field').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const field = FORM_FIELDS.find((f) => f.col === e.currentTarget.dataset.col);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet || !field) return;
        magnet[field.col] = magnet[field.col] ? 0 : 1;
        render();
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [field.key]: !!magnet[field.col] }),
        }).catch(() => {
          magnet[field.col] = magnet[field.col] ? 0 : 1;
          render();
        });
      });
    });
    // --- card: accent color -------------------------------------------
    magnetsList.querySelectorAll('.card-swatch-row .swatch[data-accent]').forEach((sw) => {
      sw.addEventListener('click', () => {
        const id = Number(sw.dataset.owner);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.accent_color = sw.dataset.accent;
        render();
        api(`/dashboard/lead-magnets/${id}`, { method: 'PATCH', body: JSON.stringify({ accentColor: magnet.accent_color }) }).catch(() => {});
      });
    });
    magnetsList.querySelectorAll('.custom-accent').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.dataset.owner);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.accent_color = input.value;
        debouncedFieldSave(`${id}:accentColor`, id, 'accentColor', input.value);
      });
      input.addEventListener('change', () => {
        const id = Number(input.dataset.owner);
        const magnet = magnets.find((m) => m.id === id);
        if (magnet) render();
      });
    });

    // --- card: cover graphic toggle -------------------------------------
    magnetsList.querySelectorAll('.toggle-cover').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.show_cover = magnet.show_cover ? 0 : 1;
        render();
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ showCover: !!magnet.show_cover }),
        }).catch(() => {
          magnet.show_cover = magnet.show_cover ? 0 : 1;
          render();
        });
      });
    });

    // --- card: extra questions ------------------------------------------
    function saveCardQuestions(id) {
      const magnet = magnets.find((m) => m.id === id);
      if (!magnet) return;
      api(`/dashboard/lead-magnets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ extraQuestions: magnet.extra_questions || [] }),
      }).catch(() => {});
    }
    magnetsList.querySelectorAll('.card-q-list').forEach((list) => {
      const id = Number(list.dataset.id);
      attachQuestionRowListeners(list, id, () => saveCardQuestions(id), () => render());
    });
    magnetsList.querySelectorAll('.card-add-q-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.extra_questions = magnet.extra_questions || [];
        if (magnet.extra_questions.length >= MAX_QUESTIONS) return;
        openTypePicker((type) => {
          const nextId = (Math.max(0, ...magnet.extra_questions.map((q) => q.id)) || 0) + 1;
          magnet.extra_questions.push(newQuestion(nextId, type));
          openOptions.add(id);
          render();
          saveCardQuestions(id);
        });
      });
    });

    magnetsList.querySelectorAll('.toggle-visible').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.visible = magnet.visible ? 0 : 1;
        render();
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ visible: !!magnet.visible }),
        }).catch(() => {
          magnet.visible = magnet.visible ? 0 : 1;
          render();
        });
      });
    });
    magnetsList.querySelectorAll('.copy-link-btn').forEach((btn) => {
      // Capture the button/input synchronously — event.currentTarget is
      // only valid while the event is still dispatching, and this handler
      // awaits a promise, so reading e.currentTarget after that await can
      // read back null.
      btn.addEventListener('click', async (e) => {
        const clickedBtn = e.currentTarget;
        const id = Number(clickedBtn.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        const input = clickedBtn.previousElementSibling;
        try {
          await navigator.clipboard.writeText(publicUrl(magnet));
        } catch (err) {
          if (input) { input.select(); document.execCommand('copy'); }
        }
        const original = clickedBtn.textContent;
        clickedBtn.textContent = 'Copied!';
        clickedBtn.classList.add('copied');
        setTimeout(() => {
          clickedBtn.textContent = original;
          clickedBtn.classList.remove('copied');
        }, 1600);
      });
    });
    magnetsList.querySelectorAll('.edit-magnet').forEach((btn) => {
      btn.addEventListener('click', () => startEdit(Number(btn.dataset.id)));
    });
    magnetsList.querySelectorAll('.remove-magnet').forEach((btn) => {
      // Deleting takes the public page and its counts with it, so the
      // first click only arms the button; a second within 3s deletes.
      const icon = btn.innerHTML;
      let disarmTimer = null;
      btn.addEventListener('click', (e) => {
        if (!btn.classList.contains('confirm')) {
          btn.classList.add('confirm');
          btn.textContent = 'Click again to delete';
          disarmTimer = setTimeout(() => {
            btn.classList.remove('confirm');
            btn.innerHTML = icon;
          }, 3000);
          return;
        }
        clearTimeout(disarmTimer);
        const id = Number(e.currentTarget.dataset.id);
        const card = magnetsList.querySelector(`.pz-magnet-card[data-id="${id}"]`);
        if (card) card.classList.add('pz-removing');
        const previous = magnets;
        api(`/dashboard/lead-magnets/${id}`, { method: 'DELETE' }).then(() => {
          magnets = magnets.filter((m) => m.id !== id);
          // It was open in the builder — nothing left to save changes to.
          if (editingId === id) resetBuilder();
          render();
        }).catch(() => {
          magnets = previous;
          if (card) card.classList.remove('pz-removing');
          btn.classList.remove('confirm');
          btn.innerHTML = icon;
        });
      });
    });
  }

  // --- create form: Content / Form / Design tabs + live preview ---------
  const form = document.getElementById('createMagnetForm');
  const titleInput = document.getElementById('magnetTitle');
  const ctaInput = document.getElementById('magnetCta');
  const descriptionInput = document.getElementById('magnetDescription');
  const fileUrlInput = document.getElementById('magnetFileUrl');
  const successInput = document.getElementById('magnetSuccessMessage');
  const fieldToggles = {
    collectName: document.getElementById('magnetCollectName'),
    collectEmail: document.getElementById('magnetCollectEmail'),
    collectPhone: document.getElementById('magnetCollectPhone'),
  };
  const fieldsError = document.getElementById('magnetFieldsError');
  const formError = document.getElementById('createFormError');

  // tabs
  document.querySelectorAll('.pz-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pz-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.pz-btabpanel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('btab-' + btn.dataset.btab).classList.add('active');
    });
  });

  // content preview
  const previewTitle = document.getElementById('previewTitle');
  const previewDesc = document.getElementById('previewDesc');
  const previewCta = document.getElementById('previewCta');
  const previewSlugUrl = document.getElementById('previewSlugUrl');
  const previewFields = {
    collectName: document.getElementById('previewNameField'),
    collectEmail: document.getElementById('previewEmailField'),
    collectPhone: document.getElementById('previewPhoneField'),
  };
  const previewPhoneOptional = document.getElementById('previewPhoneOptional');
  const magnetPhoneHint = document.getElementById('magnetPhoneHint');
  const previewExtraFields = document.getElementById('previewExtraFields');
  const previewCover = document.getElementById('previewCover');
  const previewFrame = document.querySelector('.pz-magnet-preview-frame');
  const baseSlugUrl = previewSlugUrl.textContent.replace(/\/…$/, '/');

  function slugify(str) {
    return String(str || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '…';
  }
  function updatePreviewFields() {
    previewExtraFields.innerHTML = builderQuestions.map((q) => {
      const placeholder = q.label || 'Question';
      const opt = q.required ? '' : ' <span>(optional)</span>';
      if (q.type === 'checkbox') {
        return `<div class="pz-magnet-preview-check"><i></i>${escapeHTML(placeholder)}${opt}</div>`;
      }
      if (q.type === 'radio' || q.type === 'checkboxes') {
        const choices = (q.options || []).map((o) => `<div class="pz-magnet-preview-check${q.type === 'radio' ? ' radio' : ''}"><i></i>${escapeHTML(o)}</div>`).join('');
        return `<div class="pz-magnet-preview-group"><div class="pz-magnet-preview-group-label">${escapeHTML(placeholder)}${opt}</div>${choices}</div>`;
      }
      const caret = q.type === 'dropdown' ? '<b>▾</b>' : '';
      return `<div class="pz-magnet-preview-input">${escapeHTML(placeholder)}${opt}${caret}</div>`;
    }).join('');
  }
  function syncPreview() {
    previewTitle.textContent = titleInput.value.trim() || 'Your lead magnet title';
    previewDesc.textContent = descriptionInput.value.trim() || 'A line about what someone gets when they sign up.';
    previewDesc.style.display = descriptionInput.value.trim() ? '' : 'none';
    previewCta.textContent = ctaInput.value.trim() || 'Get it free';
    // An existing magnet keeps its link whatever the title becomes.
    const editing = magnets.find((m) => m.id === editingId);
    previewSlugUrl.textContent = baseSlugUrl + (editing ? editing.slug : slugify(titleInput.value));
  }
  [titleInput, descriptionInput, ctaInput].forEach((el) => el.addEventListener('input', syncPreview));

  // Form tab: name / email / phone switches — all on to start with.
  function fieldOn(key) {
    return fieldToggles[key].classList.contains('on');
  }
  function setField(key, on) {
    fieldToggles[key].classList.toggle('on', on);
    fieldToggles[key].setAttribute('aria-pressed', on ? 'true' : 'false');
    previewFields[key].style.display = on ? '' : 'none';
    // Phone is only optional for the visitor while email is there to fall back on.
    const phoneOptional = fieldOn('collectEmail');
    previewPhoneOptional.style.display = phoneOptional ? '' : 'none';
    magnetPhoneHint.textContent = phoneOptional ? '(optional for the visitor)' : '(required — it’s the only way to reach them)';
  }
  Object.keys(fieldToggles).forEach((key) => {
    fieldToggles[key].addEventListener('click', () => {
      const turningOff = fieldOn(key);
      const other = key === 'collectEmail' ? 'collectPhone' : 'collectEmail';
      if (turningOff && key !== 'collectName' && !fieldOn(other)) {
        fieldsError.textContent = 'Keep email or phone switched on — you need a way to reach people.';
        fieldsError.classList.add('show');
        return;
      }
      fieldsError.classList.remove('show');
      setField(key, !turningOff);
    });
  });

  // Form tab: extra questions (local until the magnet is created)
  const magnetQList = document.getElementById('magnetQList');
  function renderBuilderQuestions() {
    magnetQList.innerHTML = builderQuestions.map((q) => questionRowHTML(q, 'new')).join('');
    // Nothing to save until the magnet exists — typing just refreshes the preview.
    attachQuestionRowListeners(magnetQList, 'new', updatePreviewFields, () => { renderBuilderQuestions(); });
    updatePreviewFields();
  }
  const addQBtn = document.getElementById('magnetAddQBtn');
  addQBtn.addEventListener('click', () => {
    if (builderQuestions.length >= MAX_QUESTIONS) return;
    openTypePicker((type) => {
      builderQuestions.push(newQuestion(builderNextQid++, type));
      renderBuilderQuestions();
    });
  });

  // Design tab: accent color + cover toggle
  let builderAccent = '#1261ef';
  let builderShowCover = true;
  document.querySelectorAll('#magnetSwatchRow .swatch[data-accent]').forEach((sw) => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('#magnetSwatchRow .swatch').forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      builderAccent = sw.dataset.accent;
      previewFrame.style.setProperty('--pv-accent', builderAccent);
      previewFrame.style.setProperty('--pv-accent-dark', shadeHex(builderAccent, -60));
    });
  });
  const magnetCustomColor = document.getElementById('magnetCustomColor');
  magnetCustomColor.addEventListener('input', () => {
    document.querySelectorAll('#magnetSwatchRow .swatch').forEach((s) => s.classList.remove('active'));
    magnetCustomColor.parentElement.classList.add('active');
    builderAccent = magnetCustomColor.value;
    previewFrame.style.setProperty('--pv-accent', builderAccent);
    previewFrame.style.setProperty('--pv-accent-dark', shadeHex(builderAccent, -60));
  });
  document.querySelectorAll('#btab-design .cover-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#btab-design .cover-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      builderShowCover = btn.dataset.cover !== 'off';
      previewCover.style.display = builderShowCover ? 'flex' : 'none';
    });
  });

  function setBuilderAccent(color) {
    builderAccent = color;
    document.querySelectorAll('#magnetSwatchRow .swatch').forEach((s) => s.classList.remove('active'));
    const preset = document.querySelector(`#magnetSwatchRow .swatch[data-accent="${color}"]`);
    if (preset) {
      preset.classList.add('active');
    } else {
      magnetCustomColor.value = color;
      magnetCustomColor.parentElement.classList.add('active');
    }
    previewFrame.style.setProperty('--pv-accent', color);
    previewFrame.style.setProperty('--pv-accent-dark', shadeHex(color, -60));
  }
  function setBuilderCover(show) {
    builderShowCover = show;
    document.querySelectorAll('#btab-design .cover-opt').forEach((b) => b.classList.toggle('active', (b.dataset.cover !== 'off') === show));
    previewCover.style.display = show ? 'flex' : 'none';
  }

  // The builder doubles as the editor: a card's Edit button loads that
  // magnet in here, and the submit button saves it instead of creating.
  const builderHeading = document.getElementById('builderHeading');
  const builderSubmitLabel = document.getElementById('builderSubmitLabel');
  const builderSubmitIcon = document.getElementById('builderSubmitIcon');
  const builderCancelBtn = document.getElementById('builderCancelBtn');
  function setBuilderMode() {
    const editing = editingId !== null;
    builderHeading.textContent = editing ? 'Edit lead magnet' : 'Build a lead magnet';
    builderSubmitLabel.textContent = editing ? 'Save changes' : 'Create lead magnet';
    builderSubmitIcon.style.display = editing ? 'none' : '';
    builderCancelBtn.style.display = editing ? '' : 'none';
  }
  function startEdit(id) {
    const magnet = magnets.find((m) => m.id === id);
    if (!magnet) return;
    editingId = id;
    titleInput.value = magnet.title;
    ctaInput.value = magnet.cta_text;
    descriptionInput.value = magnet.description;
    fileUrlInput.value = magnet.file_url;
    successInput.value = magnet.success_message || '';
    FORM_FIELDS.forEach((f) => setField(f.key, !!magnet[f.col]));
    // A copy, so nothing on the card changes until it's saved.
    builderQuestions = JSON.parse(JSON.stringify(magnet.extra_questions || []));
    builderNextQid = Math.max(0, ...builderQuestions.map((q) => q.id)) + 1;
    setBuilderAccent(magnet.accent_color || '#1261ef');
    setBuilderCover(!!magnet.show_cover);
    fieldsError.classList.remove('show');
    formError.classList.remove('show');
    renderBuilderQuestions();
    syncPreview();
    setBuilderMode();
    document.querySelector('.pz-tab-btn[data-btab="content"]').click();
    render();
    document.querySelector('.pz-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
    titleInput.focus({ preventScroll: true });
  }
  builderCancelBtn.addEventListener('click', () => resetBuilder());

  function resetBuilder() {
    const wasEditing = editingId !== null;
    editingId = null;
    setBuilderMode();
    formError.classList.remove('show');
    form.reset();
    builderQuestions = [];
    builderAccent = '#1261ef';
    builderShowCover = true;
    Object.keys(fieldToggles).forEach((key) => setField(key, true));
    fieldsError.classList.remove('show');
    previewCover.style.display = 'flex';
    document.querySelectorAll('#magnetSwatchRow .swatch').forEach((s, i) => s.classList.toggle('active', i === 0));
    document.getElementById('btab-design').querySelector('.swatch-custom').classList.remove('active');
    document.querySelectorAll('#btab-design .cover-opt').forEach((b, i) => b.classList.toggle('active', i === 0));
    previewFrame.style.removeProperty('--pv-accent');
    previewFrame.style.removeProperty('--pv-accent-dark');
    renderBuilderQuestions();
    syncPreview();
    document.querySelector('.pz-tab-btn[data-btab="content"]').click();
    // Drops the "being edited" highlight from its card.
    if (wasEditing) render();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    // Title and file link live on the Content tab, which may be hidden —
    // the browser's own "required" check can't focus a hidden field and
    // just swallows the click, so the form is novalidate and checked here.
    const fileUrl = fileUrlInput.value.trim();
    const missing = !titleInput.value.trim()
      ? { input: titleInput, message: 'Give it a title, like “Free pricing checklist”.' }
      : !fileUrl
        ? { input: fileUrlInput, message: 'Add a link to the file — a Google Drive/Dropbox share link works fine.' }
        : !/^https?:\/\//i.test(fileUrl)
          ? { input: fileUrlInput, message: 'That file link needs to start with http:// or https://' }
          : null;
    if (missing) {
      document.querySelector('.pz-tab-btn[data-btab="content"]').click();
      formError.textContent = missing.message;
      formError.classList.add('show');
      missing.input.focus();
      return;
    }
    const payload = {
      title: titleInput.value,
      ctaText: ctaInput.value,
      description: descriptionInput.value,
      fileUrl: fileUrlInput.value,
      successMessage: successInput.value,
      collectName: fieldOn('collectName'),
      collectEmail: fieldOn('collectEmail'),
      collectPhone: fieldOn('collectPhone'),
      extraQuestions: builderQuestions,
      accentColor: builderAccent,
      showCover: builderShowCover,
    };
    const savingId = editingId;
    try {
      if (savingId !== null) {
        await api(`/dashboard/lead-magnets/${savingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        const magnet = magnets.find((m) => m.id === savingId);
        if (magnet) {
          Object.assign(magnet, {
            title: payload.title.trim(),
            cta_text: payload.ctaText.trim() || 'Get it free',
            description: payload.description.trim(),
            file_url: payload.fileUrl.trim(),
            success_message: payload.successMessage.trim(),
            collect_name: payload.collectName ? 1 : 0,
            collect_email: payload.collectEmail ? 1 : 0,
            collect_phone: payload.collectPhone ? 1 : 0,
            extra_questions: payload.extraQuestions,
            accent_color: payload.accentColor,
            show_cover: payload.showCover ? 1 : 0,
          });
        }
        resetBuilder();
        return;
      }
      const created = await api('/dashboard/lead-magnets', { method: 'POST', body: JSON.stringify(payload) });
      magnets.unshift(created);
      render();
      resetBuilder();
      titleInput.focus();
    } catch (err) {
      formError.textContent = err.message || (savingId !== null ? 'Could not save those changes. Please try again.' : 'Could not create that lead magnet. Please try again.');
      formError.classList.add('show');
    }
  });

  renderBuilderQuestions();
  render();
})();
