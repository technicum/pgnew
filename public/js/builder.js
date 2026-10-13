// Store builder — talks to the real /dashboard/builder/* JSON endpoints
// (server.js). Blocks start from window.__PZ_INITIAL_BLOCKS__ (rendered
// server-side from PDZ_blocks) and every edit here is followed by a
// fetch() to persist it; nothing is purely client-side state past the
// first paint.
(function () {
  // Every module the "Add content" popup offers, in display order. group
  // sets the popup section; desc and keywords feed the search. Keys must
  // match TYPES in lib/blocks.js or the server rejects the new block.
  const TYPE_META = {
    course:      { group: 'Sell',   label: 'Course',            desc: 'Self-paced lessons with lifetime access',   keywords: 'lessons class training program', cls: 'pz-type-course',     icon: '<path d="M4 19.5V6a2 2 0 0 1 2-2h13v14" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 22a2 2 0 0 1-2-2v0a2 2 0 0 1 2-2h13v4H6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: true, subPlaceholder: 'e.g. 6 lessons · lifetime access' },
    booking:     { group: 'Sell',   label: 'Booking',           desc: 'Paid 1:1 calls and consultations',          keywords: 'call session consultation appointment calendar coaching meeting', cls: 'pz-type-booking',    icon: '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: true, subPlaceholder: 'e.g. 45 min · next slot Thu 2pm' },
    download:    { group: 'Sell',   label: 'Download',          desc: 'Ebooks, templates and other digital files', keywords: 'digital product file pdf ebook template', cls: 'pz-type-download',   icon: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: true, subPlaceholder: 'e.g. PDF · instant delivery' },
    membership:  { group: 'Sell',   label: 'Membership',        desc: 'Recurring access to a private community',   keywords: 'subscription community recurring monthly club', cls: 'pz-type-membership', icon: '<path d="M17 20h5v-1a4 4 0 0 0-4-4M9 20H4v-1a4 4 0 0 1 4-4m5-3a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7-1a3 3 0 1 0 0-6" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>', hasPrice: true, subPlaceholder: 'e.g. Private community · monthly' },
    event:       { group: 'Sell',   label: 'Webinar / Event',   desc: 'Tickets for a live session or workshop',    keywords: 'live workshop masterclass ticket seminar', cls: 'pz-type-booking',    icon: '<path d="m22 8-6 4 6 4V8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><rect x="2" y="6" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/>', hasPrice: true, subPlaceholder: 'e.g. Live on Zoom · Sat 11am' },
    tip:         { group: 'Sell',   label: 'Tip jar',           desc: 'Let fans support you with any amount',      keywords: 'donation support pay what you want coffee', cls: 'pz-type-course',     icon: '<path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', hasPrice: true, subPlaceholder: 'e.g. Buy me a chai', pricePlaceholder: 'Min. amount' },
    newsletter:  { group: 'Grow',   label: 'Newsletter signup', desc: 'Collect emails from visitors',              keywords: 'email subscribe list lead form', cls: 'pz-type-grow',       icon: '<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="m22 7-10 6L2 7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: false, titlePlaceholder: 'Heading, e.g. Join my weekly newsletter', subPlaceholder: 'Short pitch, e.g. Career tips every Sunday, no spam',
                   hint: 'Opens a signup popup on your store. New subscribers land in <a href="/dashboard/audience">Audience</a>.', popup: 'subscribe' },
    form:        { group: 'Grow',   label: 'Form',              desc: 'A popup form — messages, requests, enquiries', keywords: 'contact message enquiry custom form fields request popup', cls: 'pz-type-grow', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: false, hasItems: true, keepSub: true, popup: 'form',
                   titlePlaceholder: 'Button text, e.g. Message me', subPlaceholder: 'Shown in the popup, e.g. I reply within a day',
                   hint: 'Opens your form in a popup. Replies land in <a href="/dashboard/audience">Audience</a>.' },
    social:      { group: 'Grow',   label: 'Social link',       desc: 'A button to one of your profiles',     keywords: 'instagram youtube linkedin twitter x follow profile', cls: 'pz-type-grow',       icon: '<circle cx="18" cy="5" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="19" r="3" stroke="currentColor" stroke-width="1.8"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" stroke="currentColor" stroke-width="1.8"/>', hasPrice: false, subPlaceholder: 'e.g. instagram.com/yourname',
                   hint: 'Tip: add all your profiles as icons under Profile → Social links.' },
    testimonial: { group: 'Grow',   label: 'Testimonials',      desc: 'A slider of quotes from happy customers',   keywords: 'review quote social proof feedback slider carousel testimonial', cls: 'pz-type-grow',       icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: false, hasItems: true, titlePlaceholder: 'Heading (optional), e.g. What my clients say',
                   hint: 'Shows as a slider on your store — visitors swipe, or use the arrows and dots.' },
    link:        { group: 'Basics', label: 'Link',              desc: 'Send visitors to any website',              keywords: 'url website button external', cls: 'pz-type-link',       icon: '<path d="M9 17H7A5 5 0 0 1 7 7h2" stroke="currentColor" stroke-width="1.8"/><path d="M15 7h2a5 5 0 1 1 0 10h-2" stroke="currentColor" stroke-width="1.8"/><line x1="8" x2="16" y1="12" y2="12" stroke="currentColor" stroke-width="1.8"/>', hasPrice: false, subPlaceholder: 'Link URL — or a popup link like #form-12' },
    video:       { group: 'Basics', label: 'Video',             desc: 'A YouTube or Vimeo video that plays in a popup', keywords: 'youtube vimeo embed reel clip popup play', cls: 'pz-type-link',       icon: '<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="m10 9 5 3-5 3V9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: false, subPlaceholder: 'YouTube or Vimeo link', popup: 'video',
                   hint: 'YouTube and Vimeo links play in a popup on your store; other links open as a normal link.' },
    text:        { group: 'Basics', label: 'Text',              desc: 'A heading with a short paragraph',          keywords: 'heading paragraph about section title', cls: 'pz-type-link',       icon: '<path d="M4 7V5h16v2M9 19h6M12 5v14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', hasPrice: false, subPlaceholder: 'Paragraph text' },
  };
  const MODULE_GROUPS = ['Sell', 'Grow', 'Basics'];

  // Drop rows whose type this script doesn't know, so one bad row can't
  // crash render() for the whole builder.
  let blocks = (window.__PZ_INITIAL_BLOCKS__ || [])
    .filter((b) => TYPE_META[b.type])
    .map((b) => ({ ...b, visible: !!b.visible }));

  const blocksList = document.getElementById('blocksList');
  const emptyBlocks = document.getElementById('emptyBlocks');
  const saveStatus = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- save status + fetch helper --------------------------------------
  // Edits autosave after a short pause (see debounce below). The Save
  // button sends anything still waiting right away, and retries edits
  // whose save failed. "Unsaved" means: typed but not sent yet, or sent
  // and failed.
  const saveBtn = document.getElementById('saveBtn');
  let pending = 0;             // requests in flight
  let errorMessage = null;     // last failure, shown for a few seconds
  let clearErrorTimer = null;
  const failedFieldSaves = new Map(); // "id:field" -> [id, field, value]
  let profileSaveFailed = false;
  let settingsSaveFailed = false;

  function unsavedCount() {
    return debouncedFieldSave.pendingCount()
      + debouncedProfileSave.pendingCount()
      + debouncedSettingsSave.pendingCount()
      + failedFieldSaves.size
      + (profileSaveFailed ? 1 : 0)
      + (settingsSaveFailed ? 1 : 0);
  }

  function paintSaveStatus() {
    const unsaved = unsavedCount();
    saveBtn.disabled = unsaved === 0;
    saveStatus.classList.toggle('error', !!errorMessage && pending === 0);
    saveStatus.classList.toggle('saving', pending > 0 || (unsaved > 0 && !errorMessage));
    saveStatusText.textContent = pending > 0 ? 'Saving…'
      : errorMessage ? errorMessage
      : unsaved > 0 ? 'Unsaved changes'
      : 'Saved';
  }

  function setError(message) {
    errorMessage = message || 'Couldn’t save';
    clearTimeout(clearErrorTimer);
    clearErrorTimer = setTimeout(() => { errorMessage = null; paintSaveStatus(); }, 4000);
  }

  async function api(url, options) {
    pending += 1;
    paintSaveStatus();
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      // An expired session makes requireAuth redirect to /login, which
      // fetch follows and gets back a 200 HTML page — that must count as
      // a failure, not a successful save.
      if (res.redirected && new URL(res.url).pathname === '/login') {
        throw new Error('You’ve been logged out — log in again to keep saving');
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
      return data;
    } catch (err) {
      setError(err instanceof TypeError ? 'Couldn’t reach the server' : err.message);
      throw err;
    } finally {
      pending -= 1;
      paintSaveStatus();
    }
  }

  // Per-key debounce with flush(), so the Save button can send queued
  // edits immediately instead of waiting out the timer.
  function debounce(fn, wait) {
    const timers = {};
    const queuedArgs = {};
    function run(key) {
      clearTimeout(timers[key]);
      delete timers[key];
      const args = queuedArgs[key];
      delete queuedArgs[key];
      fn(key, ...args);
    }
    function debounced(key, ...args) {
      clearTimeout(timers[key]);
      queuedArgs[key] = args;
      timers[key] = setTimeout(() => run(key), wait);
      paintSaveStatus();
    }
    debounced.flush = () => Object.keys(timers).forEach(run);
    debounced.pendingCount = () => Object.keys(timers).length;
    debounced.has = (key) => key in timers;
    return debounced;
  }

  // --- rendering ---------------------------------------------------------
  // Blocks with a list of entries (lib/blocks.js items): a Testimonials
  // block's quotes and a Form block's fields. Each row has move up/down and
  // remove; edits save like any other field — the whole list, a moment
  // after the last change.
  const ITEM_LISTS = {
    testimonial: {
      max: 12, noun: 'testimonial', title: 'Testimonial',
      blank: () => ({ quote: '', name: '', detail: '' }),
      body: (block, item, i) => `
        <textarea class="pz-field-input pz-textarea" rows="3" maxlength="500" data-item-field="quote" data-id="${block.id}" data-index="${i}" placeholder="What they said, e.g. “The mock interviews got me my first PM offer.”">${escapeHTML(item.quote || '')}</textarea>
        <div class="pz-grid-2">
          <input type="text" class="pz-field-input" maxlength="80" data-item-field="name" data-id="${block.id}" data-index="${i}" value="${escapeHTML(item.name || '')}" placeholder="Name, e.g. Priya S." />
          <input type="text" class="pz-field-input" maxlength="80" data-item-field="detail" data-id="${block.id}" data-index="${i}" value="${escapeHTML(item.detail || '')}" placeholder="Detail, e.g. PM at Swiggy" />
        </div>`,
    },
    form: {
      max: 8, noun: 'field', title: 'Field',
      blank: () => ({ label: '', kind: 'text', required: false }),
      body: (block, item, i) => `
        <div class="pz-field-row">
          <input type="text" class="pz-field-input" maxlength="80" data-item-field="label" data-id="${block.id}" data-index="${i}" value="${escapeHTML(item.label || '')}" placeholder="Question, e.g. What do you need help with?" aria-label="Field ${i + 1} label" />
          <select class="pz-field-input pz-select" data-item-field="kind" data-id="${block.id}" data-index="${i}" aria-label="Field ${i + 1} type">
            ${FIELD_KINDS.map(([value, label]) => `<option value="${value}"${item.kind === value ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <label class="pz-check">
          <input type="checkbox" data-item-field="required" data-id="${block.id}" data-index="${i}"${item.required ? ' checked' : ''} />
          Required
        </label>`,
    },
  };
  const FIELD_KINDS = [['text', 'Short text'], ['textarea', 'Long text'], ['email', 'Email'], ['phone', 'Phone'], ['number', 'Number']];

  function itemsEditorHTML(block) {
    const list = ITEM_LISTS[block.type];
    const items = block.items || [];
    const rows = items.map((item, i) => `
      <div class="pz-item" data-item-index="${i}">
        <div class="pz-item-head">
          <span class="pz-item-num">${i + 1}</span>
          <span class="pz-item-label">${list.title} ${i + 1}</span>
          <button type="button" class="pz-icon-btn" data-item-action="up" data-id="${block.id}" data-index="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="m18 15-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="pz-icon-btn" data-item-action="down" data-id="${block.id}" data-index="${i}" aria-label="Move down"${i === items.length - 1 ? ' disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="pz-icon-btn pz-item-remove" data-item-action="remove" data-id="${block.id}" data-index="${i}" aria-label="Remove ${list.noun} ${i + 1}"${items.length === 1 ? ' disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
          </button>
        </div>
        ${list.body(block, item, i)}
      </div>`).join('');
    const full = items.length >= list.max;
    // A form's replies are saved as people in Audience, who need an email or a phone.
    const noReplyField = block.type === 'form' && !items.some((f) => f.kind === 'email' || f.kind === 'phone');
    return `
      <div class="pz-items">${rows}</div>
      ${noReplyField ? '<p class="pz-block-warn" role="status">Add an Email or Phone field — without one, replies can’t be saved.</p>' : ''}
      <button type="button" class="pz-add-item" data-item-action="add" data-id="${block.id}"${full ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" width="15" height="15" aria-hidden="true"><path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        ${full ? `Up to ${list.max} ${list.noun}s` : `Add ${list.noun}`}
      </button>`;
  }

  function queueItemsSave(block) {
    // A copy, so a retry after a failed save sends what was there then.
    debouncedFieldSave(`${block.id}:items`, block.id, 'items', JSON.parse(JSON.stringify(block.items)));
  }

  // Cards are a one-line summary until clicked; the ones open now. A new
  // or duplicated block opens straight away so it can be filled in.
  const expanded = new Set();

  // The grey line under a collapsed card's title: what's in it, briefly.
  function blockSummary(block) {
    const meta = TYPE_META[block.type];
    const count = (block.items || []).length;
    if (block.type === 'testimonial') return `${count} testimonial${count === 1 ? '' : 's'}`;
    if (block.type === 'form') return `${count} field${count === 1 ? '' : 's'}${block.sub ? ` · ${block.sub}` : ''}`;
    const sub = String(block.sub || '').trim();
    if (meta.subPlaceholder && /url|link/i.test(meta.subPlaceholder) && sub) return sub.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return [sub, String(block.price || '').trim()].filter(Boolean).join(' · ');
  }

  function blockCardHTML(block) {
    const meta = TYPE_META[block.type];
    const open = expanded.has(block.id);
    const summary = blockSummary(block);
    const priceField = meta.hasPrice
      ? `<input type="text" class="pz-field-input pz-price" data-field="price" data-id="${block.id}" value="${escapeHTML(block.price)}" placeholder="${meta.pricePlaceholder || 'Price'}" style="width:96px; flex:none;" />`
      : '';
    return `
      <div class="pz-block-card${block.visible ? '' : ' pz-hidden'}${open ? ' is-open' : ''}" data-id="${block.id}">
        <div class="pz-drag-handle" title="Drag to reorder (coming soon)">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>
        </div>
        <div class="grid size-10 place-items-center rounded-md shrink-0 ${meta.cls}">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18">${meta.icon}</svg>
        </div>
        <div class="pz-block-main">
          <button type="button" class="pz-block-summary" data-toggle-id="${block.id}" aria-expanded="${open}" aria-controls="block-body-${block.id}">
            <span class="pz-block-type">${meta.label}</span>
            <span class="pz-block-name" data-summary-title>${escapeHTML(block.title) || `<em>${meta.titlePlaceholder ? 'Untitled' : meta.label}</em>`}</span>
            <span class="pz-block-meta" data-summary-meta${open || !summary ? ' hidden' : ''}>${escapeHTML(summary)}</span>
            <svg class="pz-block-chevron" viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          ${open ? `<div class="pz-block-body" id="block-body-${block.id}">
          <input type="text" class="pz-field-input pz-title" data-field="title" data-id="${block.id}" value="${escapeHTML(block.title)}" placeholder="${meta.titlePlaceholder || 'Title'}" />
          ${meta.hasItems && meta.keepSub ? `<input type="text" class="pz-field-input" data-field="sub" data-id="${block.id}" value="${escapeHTML(block.sub)}" placeholder="${meta.subPlaceholder}" />` : ''}
          ${meta.hasItems ? itemsEditorHTML(block) : `<div style="display:flex; gap:8px;">
            <input type="text" class="pz-field-input" data-field="sub" data-id="${block.id}" value="${escapeHTML(block.sub)}" placeholder="${meta.subPlaceholder}" />
            ${priceField}
          </div>`}
          ${meta.hint ? `<p class="pz-block-hint">${meta.hint}</p>` : ''}
          ${meta.popup ? popupLinkHTML(block) : ''}
          </div>` : ''}
        </div>
        <button type="button" class="pz-switch${block.visible ? ' on' : ''} toggle-visible" data-id="${block.id}" title="${block.visible ? 'Visible on your store' : 'Hidden from your store'}"></button>
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

  // Every popup has its own link — the store URL + #subscribe-<id>,
  // #form-<id> or #video-<id> (views/store.ejs) — that opens it straight
  // away from anywhere: a bio, a WhatsApp message, or a Link block on the
  // store itself.
  function popupLinkFor(block) {
    const handleNow = document.getElementById('switcherHandle').textContent.replace(/^@/, '');
    return `${(window.__PZ_STORE_URL__ || '').replace('{handle}', handleNow)}/#${TYPE_META[block.type].popup}-${block.id}`;
  }
  function popupLinkHTML(block) {
    const url = popupLinkFor(block);
    return `
      <div class="pz-popup-link">
        <span class="pz-popup-link-label">Popup link</span>
        <code title="${escapeHTML(url)}">${escapeHTML(url.replace(/^https?:\/\//, ''))}</code>
        <button type="button" class="pz-copy-btn copy-popup-link" data-url="${escapeHTML(url)}">Copy</button>
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

  // The live preview (set up at the bottom): the real store page, redrawn
  // a moment after each edit.
  let refreshPreview = null;
  function renderPreviewOnly() {
    if (refreshPreview) refreshPreview.soon();
  }

  function saveField(key, id, field, value) {
    failedFieldSaves.delete(key);
    api(`/dashboard/builder/blocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {
      // Keep it for the Save button to retry — unless a newer edit to the
      // same field is already queued, or the block was deleted since.
      if (!debouncedFieldSave.has(key) && blocks.some((b) => b.id === id)) {
        failedFieldSaves.set(key, [id, field, value]);
      }
      paintSaveStatus();
    });
  }
  const debouncedFieldSave = debounce(saveField, 500);

  function attachBlockListeners() {
    blocksList.querySelectorAll('[data-toggle-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.toggleId);
        const opening = !expanded.has(id);
        if (opening) expanded.add(id); else expanded.delete(id);
        render();
        const card = blocksList.querySelector(`.pz-block-card[data-id="${id}"]`);
        const target = opening ? card.querySelector('.pz-block-body [data-field="title"]') : card.querySelector('[data-toggle-id]');
        if (target) target.focus({ preventScroll: true });
      });
    });
    blocksList.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const id = Number(e.target.dataset.id);
        const field = e.target.dataset.field;
        const block = blocks.find((b) => b.id === id);
        if (!block) return;
        block[field] = e.target.value;
        if (field === 'title') {
          const name = e.target.closest('.pz-block-card').querySelector('[data-summary-title]');
          if (block.title) name.textContent = block.title;
          else name.innerHTML = '<em>Untitled</em>';
        }
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
            expanded.add(created.id);
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
        // Nothing left to retry for a block that's gone.
        for (const key of failedFieldSaves.keys()) {
          if (key.startsWith(`${id}:`)) failedFieldSaves.delete(key);
        }
        render();
        api(`/dashboard/builder/blocks/${id}`, { method: 'DELETE' }).catch(() => {
          blocks = previous;
          render();
        });
      });
    });
  }

  document.addEventListener('click', closeAllKebabMenus);

  blocksList.addEventListener('input', (e) => {
    const el = e.target.closest('[data-item-field]');
    if (!el) return;
    const block = blocks.find((b) => b.id === Number(el.dataset.id));
    const item = block && block.items && block.items[Number(el.dataset.index)];
    if (!item) return;
    const field = el.dataset.itemField;
    item[field] = el.type === 'checkbox' ? el.checked : el.value;
    renderPreviewOnly();
    queueItemsSave(block);
    // A field's type decides whether the "no Email or Phone" note shows.
    if (field === 'kind') {
      render();
      const again = blocksList.querySelector(`[data-item-field="kind"][data-id="${block.id}"][data-index="${el.dataset.index}"]`);
      if (again) again.focus();
    }
  });
  blocksList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-item-action]');
    if (!btn || btn.disabled) return;
    const block = blocks.find((b) => b.id === Number(btn.dataset.id));
    if (!block) return;
    const items = block.items || (block.items = []);
    const i = Number(btn.dataset.index);
    const action = btn.dataset.itemAction;
    let focusIndex = null;
    const list = ITEM_LISTS[block.type];
    if (action === 'add' && list && items.length < list.max) {
      items.push(list.blank());
      focusIndex = items.length - 1;
    } else if (action === 'remove' && items.length > 1) {
      items.splice(i, 1);
    } else if ((action === 'up' && i > 0) || (action === 'down' && i < items.length - 1)) {
      const j = action === 'up' ? i - 1 : i + 1;
      [items[i], items[j]] = [items[j], items[i]];
      focusIndex = j;
    } else {
      return;
    }
    render();
    queueItemsSave(block);
    if (focusIndex !== null) {
      const card = blocksList.querySelector(`.pz-block-card[data-id="${block.id}"]`);
      const target = action === 'add'
        ? card.querySelector(`[data-item-index="${focusIndex}"] [data-item-field]`)
        : card.querySelector(`[data-item-action="${action}"][data-index="${focusIndex}"]`);
      if (target && !target.disabled) target.focus();
      else if (target) card.querySelector(`[data-item-index="${focusIndex}"] [data-item-field]`).focus();
    }
  });

  blocksList.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-popup-link');
    if (!btn) return;
    const done = (text) => {
      btn.textContent = text;
      clearTimeout(btn._reset);
      btn._reset = setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    };
    navigator.clipboard.writeText(btn.dataset.url).then(() => done('Copied'), () => done('Couldn’t copy'));
  });

  // --- add-content popup ----------------------------------------------
  // Every module, grouped, filtered by the search box.
  const addMenuBtn = document.getElementById('addMenuBtn');
  const addModal = document.getElementById('addModal');
  const moduleSearch = document.getElementById('moduleSearch');
  const moduleList = document.getElementById('moduleList');
  let adding = false;

  function moduleMatches(meta, query) {
    if (!query) return true;
    const haystack = `${meta.label} ${meta.desc} ${meta.keywords} ${meta.group}`.toLowerCase();
    return query.split(/\s+/).every((word) => haystack.includes(word));
  }

  function renderModuleList() {
    const query = moduleSearch.value.trim().toLowerCase();
    const sections = MODULE_GROUPS.map((group) => {
      const cards = Object.entries(TYPE_META)
        .filter(([, meta]) => meta.group === group && moduleMatches(meta, query))
        .map(([type, meta]) => `
          <button type="button" class="pz-module-card" data-type="${type}">
            <span class="pz-module-icon ${meta.cls}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18">${meta.icon}</svg>
            </span>
            <span style="min-width:0;">
              <span class="pz-module-name">${meta.label}</span>
              <span class="pz-module-desc">${meta.desc}</span>
            </span>
          </button>`)
        .join('');
      return cards ? `<div class="pz-module-group-label">${group}</div><div class="pz-module-grid">${cards}</div>` : '';
    }).join('');

    moduleList.innerHTML = sections
      || `<div class="pz-module-empty">No modules match “${escapeHTML(moduleSearch.value.trim())}”.</div>`;
    // First result is highlighted while searching, since Enter adds it.
    const first = moduleList.querySelector('.pz-module-card');
    if (first && query) first.classList.add('active');
  }

  function openAddModal() {
    moduleSearch.value = '';
    renderModuleList();
    addModal.hidden = false;
    document.body.classList.add('pz-modal-open');
    moduleSearch.focus();
  }

  function closeAddModal() {
    addModal.hidden = true;
    document.body.classList.remove('pz-modal-open');
    addMenuBtn.focus();
  }

  async function addBlock(type) {
    if (adding) return; // one click = one block, even on a slow request
    adding = true;
    moduleList.querySelectorAll('.pz-module-card').forEach((c) => { c.disabled = true; });
    try {
      const created = await api('/dashboard/builder/blocks', {
        method: 'POST',
        body: JSON.stringify({ type }),
      });
      blocks.push({ ...created, visible: !!created.visible });
      expanded.add(created.id);
      closeAddModal();
      render();
      requestAnimationFrame(() => {
        const last = blocksList.querySelector('.pz-block-card:last-child .pz-title');
        if (last) { last.focus(); last.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
    } catch (err) {
      // Status bar shows the error; leave the popup open so they can retry.
      moduleList.querySelectorAll('.pz-module-card').forEach((c) => { c.disabled = false; });
    } finally {
      adding = false;
    }
  }

  addMenuBtn.addEventListener('click', openAddModal);
  document.getElementById('addModalClose').addEventListener('click', closeAddModal);
  addModal.addEventListener('click', (e) => { if (e.target === addModal) closeAddModal(); });
  moduleSearch.addEventListener('input', renderModuleList);
  moduleList.addEventListener('click', (e) => {
    const card = e.target.closest('.pz-module-card');
    if (card) addBlock(card.dataset.type);
  });
  addModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeAddModal(); return; }
    if (e.key === 'Enter' && e.target === moduleSearch) {
      e.preventDefault();
      const first = moduleList.querySelector('.pz-module-card');
      if (first) addBlock(first.dataset.type);
      return;
    }
    // Arrow keys move between results; Down from the search box enters the list.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const cards = [...moduleList.querySelectorAll('.pz-module-card')];
      if (!cards.length) return;
      e.preventDefault();
      const i = cards.indexOf(document.activeElement);
      if (i === -1) { if (e.key === 'ArrowDown') cards[0].focus(); return; }
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
      if (next < 0) moduleSearch.focus();
      else cards[Math.min(next, cards.length - 1)].focus();
      return;
    }
    // Keep Tab inside the popup.
    if (e.key === 'Tab') {
      const focusables = [...addModal.querySelectorAll('button:not(:disabled), input')];
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    }
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
  let currentAccent = window.__PZ_ACCENT__ || '#ff6b4a';
  document.querySelectorAll('.pz-swatch').forEach((btn) => {
    const isCurrent = btn.dataset.color.toLowerCase() === currentAccent.toLowerCase();
    btn.classList.toggle('active', isCurrent);
    btn.setAttribute('aria-checked', String(isCurrent));
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pz-swatch').forEach((s) => {
        s.classList.remove('active');
        s.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      currentAccent = btn.dataset.color;
      renderPreviewOnly();
      api('/dashboard/builder/design', {
        method: 'POST',
        body: JSON.stringify({ accentColor: currentAccent, showBadge: badgeToggle.classList.contains('on') }),
      }).catch(() => {});
    });
  });
  badgeToggle.addEventListener('click', () => {
    const on = badgeToggle.classList.toggle('on');
    badgeToggle.setAttribute('aria-checked', String(on));
    renderPreviewOnly();
    api('/dashboard/builder/design', {
      method: 'POST',
      body: JSON.stringify({ accentColor: currentAccent, showBadge: on }),
    }).catch(() => {
      badgeToggle.setAttribute('aria-checked', String(badgeToggle.classList.toggle('on')));
      renderPreviewOnly();
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
  const avatarInitials = document.getElementById('avatarInitials');
  const switcherInitials = document.getElementById('switcherInitials');
  const switcherHandle = document.getElementById('switcherHandle');
  const previewUrl = document.getElementById('previewUrl');
  const bioCount = document.getElementById('bioCount');
  const socialInputs = [...document.querySelectorAll('input[data-social]')];
  const socialCount = document.getElementById('socialCount');

  // { platform: typed value } — the server turns these into links (lib/socials.js).
  function collectSocials() {
    const out = {};
    socialInputs.forEach((input) => {
      const value = input.value.trim();
      if (value) out[input.dataset.social] = value;
    });
    return out;
  }

  function paintSocials() {
    let filled = 0;
    socialInputs.forEach((input) => {
      const on = !!input.value.trim();
      input.closest('.pz-social-row').classList.toggle('filled', on);
      if (on) filled += 1;
    });
    socialCount.textContent = filled ? `${filled} added` : 'None yet';
    socialCount.classList.toggle('on', filled > 0);
  }

  function paintBioCount() {
    const n = bio.value.length;
    bioCount.textContent = `${n}/280`;
    bioCount.classList.toggle('near', n >= 250);
  }

  function saveProfile() {
    profileSaveFailed = false;
    api('/dashboard/builder/profile', {
      method: 'POST',
      body: JSON.stringify({ name: displayName.value, handle: handle.value, bio: bio.value, socials: collectSocials() }),
    }).then((data) => {
      handleError.classList.remove('show');
      if (data && data.user) {
        const handleChanged = switcherHandle.textContent !== `@${data.user.handle}`;
        switcherHandle.textContent = `@${data.user.handle}`;
        // Newsletter popup links include the handle.
        if (handleChanged && blocks.some((b) => b.type === 'newsletter')) render();
        previewUrl.textContent = `${data.user.handle}.${window.__PZ_SITE_DOMAIN__}`;
        const viewLiveBtn = document.getElementById('viewLiveBtn');
        if (viewLiveBtn && window.__PZ_STORE_URL__) {
          viewLiveBtn.href = window.__PZ_STORE_URL__.replace('{handle}', data.user.handle);
        }
      }
    }).catch((err) => {
      if (!debouncedProfileSave.has('profile')) profileSaveFailed = true;
      if (String(err.message || '').toLowerCase().includes('handle')) {
        handleError.textContent = err.message;
        handleError.classList.add('show');
      }
      paintSaveStatus();
    });
  }
  const debouncedProfileSave = debounce(() => saveProfile(), 700);

  displayName.addEventListener('input', () => {
    const i = initials(displayName.value);
    avatarInitials.textContent = i;
    switcherInitials.textContent = i;
    renderPreviewOnly();
    debouncedProfileSave('profile');
  });
  bio.addEventListener('input', () => {
    paintBioCount();
    renderPreviewOnly();
    debouncedProfileSave('profile');
  });
  handle.addEventListener('input', () => {
    debouncedProfileSave('profile');
  });
  socialInputs.forEach((input) => {
    input.addEventListener('input', () => {
      paintSocials();
      renderPreviewOnly();
      debouncedProfileSave('profile');
    });
  });
  paintSocials();

  // --- store settings ----------------------------------------------------
  // Photo, cover, tagline, location, contact button, announcement bar,
  // theme and SEO (lib/storeSettings.js) — one object, sent whole to
  // /dashboard/builder/settings a moment after each change.
  const settings = { ...(window.__PZ_SETTINGS__ || {}) };

  function saveSettings() {
    settingsSaveFailed = false;
    api('/dashboard/builder/settings', {
      method: 'POST',
      body: JSON.stringify({ settings }),
    }).catch(() => {
      if (!debouncedSettingsSave.has('settings')) settingsSaveFailed = true;
      paintSaveStatus();
    });
  }
  const debouncedSettingsSave = debounce(() => saveSettings(), 600);

  function settingChanged() {
    renderPreviewOnly();
    paintSeoPreview();
    debouncedSettingsSave('settings');
  }

  // "12/80" beside fields with a limit.
  function paintCounter(input) {
    const counter = document.querySelector(`[data-counter-for="${input.id}"]`);
    if (!counter) return;
    const max = Number(input.getAttribute('maxlength'));
    counter.textContent = `${input.value.length}/${max}`;
    counter.classList.toggle('near', input.value.length >= max * 0.9);
  }

  document.querySelectorAll('[data-setting]').forEach((input) => {
    paintCounter(input);
    input.addEventListener('input', () => {
      settings[input.dataset.setting] = input.value;
      paintCounter(input);
      settingChanged();
    });
  });

  // Segmented / option buttons: data-choice="theme" data-value="dark".
  function paintChoices(key) {
    document.querySelectorAll(`[data-choice="${key}"]`).forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.dataset.value === settings[key]));
    });
  }
  document.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.choice;
      if (settings[key] === btn.dataset.value) return;
      settings[key] = btn.dataset.value;
      paintChoices(key);
      if (key === 'contactType') paintContactFields();
      settingChanged();
    });
  });

  const contactFields = document.getElementById('contactFields');
  const contactValue = document.getElementById('set-contactValue');
  const contactLabel = document.getElementById('set-contactLabel');
  function paintContactFields() {
    const type = settings.contactType;
    contactFields.hidden = type === 'none';
    const email = type === 'email';
    document.getElementById('contactValueLabel').textContent = email ? 'Email address' : 'WhatsApp number';
    contactValue.placeholder = email ? 'you@example.com' : '+91 98765 43210';
    contactValue.type = email ? 'email' : 'tel';
    contactLabel.placeholder = email ? 'Email me' : 'Message me on WhatsApp';
  }

  const announceToggle = document.getElementById('announceToggle');
  announceToggle.addEventListener('click', () => {
    settings.announceOn = !settings.announceOn;
    announceToggle.classList.toggle('on', settings.announceOn);
    announceToggle.setAttribute('aria-checked', String(settings.announceOn));
    document.getElementById('announceFields').hidden = !settings.announceOn;
    if (settings.announceOn) document.getElementById('set-announceText').focus();
    settingChanged();
  });

  // Image fields (photo, cover, share image): the file goes to
  // /dashboard/uploads as the raw body, the URL it comes back with is the
  // setting.
  const UPLOAD_LABELS = { cover: 'Upload cover', shareImage: 'Upload image' };
  function paintImageField(field) {
    const key = field.dataset.imageField;
    const url = settings[key] || '';
    field.classList.toggle('has-image', !!url);
    const img = field.querySelector('[data-image-preview]');
    if (url) img.src = url; else img.removeAttribute('src');
    const remove = field.querySelector('[data-image-remove]');
    if (remove) remove.hidden = !url;
    const label = field.querySelector('[data-upload-label]');
    if (label) label.textContent = url ? 'Change' : UPLOAD_LABELS[key] || 'Upload';
  }
  document.querySelectorAll('[data-image-field]').forEach((field) => {
    const key = field.dataset.imageField;
    const fileInput = field.querySelector('[data-upload]');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setError('Upload a JPG, PNG or WebP image'); paintSaveStatus(); return; }
      if (file.size > 5 * 1024 * 1024) { setError('Keep images under 5 MB'); paintSaveStatus(); return; }
      field.classList.add('is-uploading');
      try {
        const data = await api('/dashboard/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        settings[key] = data.url;
        paintImageField(field);
        settingChanged();
      } catch (err) { /* status already shown */ } finally {
        field.classList.remove('is-uploading');
      }
    });
    const remove = field.querySelector('[data-image-remove]');
    if (remove) {
      remove.addEventListener('click', () => {
        settings[key] = '';
        paintImageField(field);
        settingChanged();
      });
    }
  });

  // SEO tab: the Google result and link card, from the fields or the
  // same fallbacks the store page uses (views/store.ejs).
  function paintSeoPreview() {
    const title = settings.seoTitle || `${displayName.value.trim() || 'Your store'} — ${window.__PZ_SITE_NAME__}`;
    const desc = settings.seoDescription || bio.value.trim() || settings.tagline || 'Add a description so people know what they’ll find.';
    document.getElementById('serpTitle').textContent = title;
    document.getElementById('serpDesc').textContent = desc;
    document.getElementById('shareCardTitle').textContent = title;
    document.getElementById('shareCardDesc').textContent = desc;
    const image = settings.shareImage || settings.cover || settings.photo;
    const cardImg = document.getElementById('shareCardImg');
    cardImg.style.backgroundImage = image ? `url("${image.replace(/"/g, '%22')}")` : '';
    cardImg.classList.toggle('is-empty', !image);
    const host = `${handle.value.trim() || 'yourname'}.${window.__PZ_SITE_DOMAIN__}`;
    document.getElementById('serpUrl').textContent = host;
    document.getElementById('shareCardHost').textContent = host;
  }
  [displayName, bio, handle].forEach((input) => input.addEventListener('input', paintSeoPreview));
  paintSeoPreview();

  // --- save button -------------------------------------------------------
  function saveNow() {
    debouncedFieldSave.flush();
    debouncedProfileSave.flush();
    debouncedSettingsSave.flush();
    for (const [key, [id, field, value]] of [...failedFieldSaves]) saveField(key, id, field, value);
    if (profileSaveFailed) saveProfile();
    if (settingsSaveFailed) saveSettings();
    paintSaveStatus();
  }
  saveBtn.addEventListener('click', saveNow);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); // stop the browser's "Save page as…"
      saveNow();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (unsavedCount() > 0 || pending > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // --- live preview ------------------------------------------------------
  // The store page itself (views/store.ejs), drawn by the server from
  // what's on screen — saved or not (lib/livePreview.js,
  // public/js/live-preview.js).
  refreshPreview = window.livePreview(document.getElementById('storePreview'), () => ({
    url: '/dashboard/builder/preview',
    type: 'application/json',
    body: JSON.stringify({
      name: displayName.value,
      bio: bio.value,
      socials: collectSocials(),
      settings,
      accent: currentAccent,
      showBadge: badgeToggle.classList.contains('on'),
      blocks: blocks.map((b) => ({ id: b.id, type: b.type, title: b.title, sub: b.sub, price: b.price, visible: b.visible, items: b.items })),
    }),
  }));

  render();
  refreshPreview();
  paintSaveStatus();
})();
