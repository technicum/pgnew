// Store builder (Builder v2). The page opens on the draft if there is one,
// else on what's live (lib/storeDraft.js); blocks start from
// window.__PZ_INITIAL_BLOCKS__. Every edit updates the screen and the live
// preview and auto-saves the whole state to the draft a moment later
// (PUT /dashboard/builder/draft). Nothing on the public page changes until
// Publish; "Discard changes" drops the draft. Undo (Ctrl/Cmd+Z) steps back
// through the last 20 states.
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
    social:      { group: 'Grow',   label: 'Social links',      desc: 'Your social profiles as a row of icons',  keywords: 'instagram youtube linkedin twitter x follow profile social icons', cls: 'pz-type-grow',       icon: '<circle cx="18" cy="5" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="19" r="3" stroke="currentColor" stroke-width="1.8"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" stroke="currentColor" stroke-width="1.8"/>', hasPrice: false, socialList: true,
                   titlePlaceholder: 'Heading (optional), e.g. Follow me', subPlaceholder: 'Profile link',
                   hint: 'Shows the profiles from Profile → Social links. Switch any icon off to leave it out here.' },
    testimonial: { group: 'Grow',   label: 'Testimonials',      desc: 'Quotes from happy customers, in a popup slider',   keywords: 'review quote social proof feedback slider carousel testimonial', cls: 'pz-type-grow',       icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', hasPrice: false, hasItems: true, titlePlaceholder: 'Heading (optional), e.g. What my clients say',
                   hint: 'Shows as a card on your store; tapping it opens your testimonials in a popup slider.', popup: 'reviews' },
    link:        { group: 'Basics', label: 'Link',              desc: 'Send visitors to any website',              keywords: 'url website button external', cls: 'pz-type-link',       icon: '<path d="M9 17H7A5 5 0 0 1 7 7h2" stroke="currentColor" stroke-width="1.8"/><path d="M15 7h2a5 5 0 1 1 0 10h-2" stroke="currentColor" stroke-width="1.8"/><line x1="8" x2="16" y1="12" y2="12" stroke="currentColor" stroke-width="1.8"/>', hasPrice: false, subPlaceholder: 'Link URL — or a popup link like #form-12' },
    button:      { group: 'Basics', label: 'Button',            desc: 'A big button — book, WhatsApp, any link',    keywords: 'button cta call to action whatsapp book order click', cls: 'pz-type-link',       icon: '<rect x="3" y="8" width="18" height="8" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M9 12h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', hasPrice: false, titlePlaceholder: 'Button text, e.g. Book now', subPlaceholder: 'Link, e.g. https://wa.me/919876543210 or #form-12',
                   hint: 'Shows as a full-width button on your store. Use a website or WhatsApp link, or a popup link like #form-12.' },
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

  // --- draft: auto-save, status, undo -----------------------------------
  // The whole state goes to the draft ~800 ms after the last edit; a save
  // that fails is retried with a growing wait. version is the draft's (0:
  // none yet) — another tab saving in between answers 409 and auto-save
  // stops rather than overwrite it. changes: what the draft changes on the
  // live page, as the server counted it on the last save.
  const draftInfo = window.__PZ_DRAFT__ || { version: 0, changes: [] };
  let version = draftInfo.version || 0;
  let changes = draftInfo.changes || [];
  let unsent = false;          // edits not sent yet
  let inFlight = null;         // the save on its way, if any
  let saveTimer = null;
  let retryWait = 0;
  let syncState = 'saved';     // saved | retrying | conflict | error
  let syncMessage = '';
  let publishing = false;
  let discarding = false;
  let justPublished = false;
  let flash = null;            // a one-off message (an upload, a publish problem)
  let flashTimer = null;
  // New and duplicated blocks have a negative id until Publish creates them.
  let tempIds = Math.max(0, ...blocks.map((b) => -b.id));
  const nextTempId = () => -(++tempIds);

  const publishBtn = document.getElementById('publishBtn');
  const discardBtn = document.getElementById('discardBtn');
  const undoBtn = document.getElementById('undoBtn');
  const pendingPill = document.getElementById('pendingPill');
  const pendingList = document.getElementById('pendingList');
  const pendingItems = document.getElementById('pendingItems');

  function paintSaveStatus() {
    const busy = unsent || !!inFlight;
    const bad = syncState === 'conflict' || syncState === 'error' || syncState === 'retrying';
    saveStatus.classList.toggle('error', bad || !!flash);
    saveStatus.classList.toggle('saving', busy && !bad && !flash);
    saveStatusText.textContent = flash
      || (syncState === 'retrying' ? 'Save nahi hua, dobara try kar rahe hain…'
        : bad ? syncMessage
        : busy ? 'Saving…'
        : 'Auto-saved ✓');

    const count = changes.length;
    pendingPill.hidden = false;
    pendingPill.classList.toggle('is-pending', count > 0);
    pendingPill.classList.toggle('is-live', count === 0);
    pendingPill.textContent = count ? `${count} change${count === 1 ? '' : 's'} abhi live nahi`
      : justPublished ? 'Live ✓' : 'Sab live hai ✓';
    pendingPill.disabled = count === 0;
    if (!count) closePendingList();
    pendingItems.innerHTML = changes.map((c) => `<li>${escapeHTML(c)}</li>`).join('');

    publishBtn.disabled = publishing || discarding || syncState === 'conflict' || (count === 0 && !busy);
    publishBtn.textContent = publishing ? 'Publishing…' : 'Publish';
    undoBtn.disabled = !undoStack.length || publishing || discarding;
  }

  function setError(message) {
    flash = message || 'Kuch galat ho gaya';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; paintSaveStatus(); }, 5000);
    paintSaveStatus();
  }

  // Every edit ends here: one undo step (a run of typing in one field is
  // one step), then an auto-save a moment later.
  function changed(key) {
    renderPreviewOnly();
    recordUndo(key);
    unsent = true;
    justPublished = false;
    scheduleSave(800);
    paintSaveStatus();
  }
  function markBlock(id, field) { changed(`block:${id}:${field}`); }
  function markDirty(kind) { changed(kind); }

  function scheduleSave(wait) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flushSave(); }, wait);
  }

  async function flushSave(forPublish) {
    clearTimeout(saveTimer);
    if (discarding || syncState === 'conflict') return;
    // Publish has its own turn: an edit made meanwhile waits for it.
    if (publishing && !forPublish) { scheduleSave(800); return; }
    if (inFlight) await inFlight.catch(() => {});
    if (!unsent || inFlight) return;
    unsent = false;
    const body = JSON.stringify({ state: collectState(), version });
    inFlight = (async () => {
      const res = await fetch('/dashboard/builder/draft', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
      });
      // An expired session redirects to /login — a 200 HTML page, not a save.
      if (res.redirected && new URL(res.url).pathname === '/login') {
        throw Object.assign(new Error('Aap logout ho gaye — save ke liye dobara login karein.'), { stop: true });
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (res.status === 409) throw Object.assign(new Error((data && data.error) || 'Ye page kisi aur tab mein badla gaya hai — reload karein.'), { conflict: true });
      if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Save nahi hua.'), { stop: res.status < 500 && res.status !== 429 });
      return data;
    })();
    paintSaveStatus();
    try {
      const data = await inFlight;
      version = data.version;
      changes = data.changes || [];
      showProblems(data.problems || {});
      retryWait = 0;
      syncState = 'saved';
    } catch (err) {
      unsent = true; // still not in the draft
      if (err.conflict) {
        syncState = 'conflict';
        syncMessage = err.message;
      } else if (err.stop) {
        syncState = 'error';
        syncMessage = err.message;
      } else {
        syncState = 'retrying';
        retryWait = Math.min(30000, retryWait ? retryWait * 2 : 2000);
        scheduleSave(retryWait);
      }
    } finally {
      inFlight = null;
      paintSaveStatus();
    }
  }

  // Name / link problems from the last save (Publish would refuse them).
  function showProblems(problems) {
    const el = document.getElementById('handleError');
    const message = problems.handle || problems.name || '';
    el.textContent = message;
    el.classList.toggle('show', !!message);
  }

  // Uploads (images): a plain JSON fetch, with the problem shown in the status.
  async function api(url, options) {
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
      if (res.redirected && new URL(res.url).pathname === '/login') {
        throw new Error('Aap logout ho gaye — dobara login karein.');
      }
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
      return data;
    } catch (err) {
      setError(err instanceof TypeError ? 'Server tak nahi pahunch paaye' : err.message);
      throw err;
    }
  }

  // Undo: the state before each step, newest last (up to 20).
  const UNDO_LIMIT = 20;
  const undoStack = [];
  let lastSnapshot = null;     // the state after the last step
  let lastKey = null;
  let lastAt = 0;
  function recordUndo(key) {
    const now = Date.now();
    if (lastSnapshot && !(key === lastKey && now - lastAt < 1200)) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    lastKey = key;
    lastAt = now;
    lastSnapshot = JSON.stringify(collectState());
  }
  function undo() {
    if (!undoStack.length || publishing || discarding) return;
    const previous = undoStack.pop();
    applyState(JSON.parse(previous));
    lastSnapshot = previous;
    lastKey = null;
    unsent = true;
    justPublished = false;
    scheduleSave(300);
    paintSaveStatus();
    liveRegion.textContent = 'Undo kiya';
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
    markBlock(block.id, 'items');
  }

  // Cards are a one-line summary until clicked; the ones open now. A new
  // or duplicated block opens straight away so it can be filled in.
  const expanded = new Set();

  // The grey line under a collapsed card's title: what's in it, briefly.
  function blockSummary(block) {
    const meta = TYPE_META[block.type];
    const count = (block.items || []).length;
    if (block.type === 'social' && !block.sub) {
      const profiles = socialProfiles();
      if (!profiles.length) return 'No profiles yet — add them in Profile';
      const shown = profiles.filter((pf) => socialOn(block, pf.id)).length;
      return `${shown} of ${profiles.length} icons shown`;
    }
    if (block.type === 'testimonial') return `${count} testimonial${count === 1 ? '' : 's'}`;
    if (block.type === 'form') return `${count} field${count === 1 ? '' : 's'}${block.sub ? ` · ${block.sub}` : ''}`;
    const sub = String(block.sub || '').trim();
    if (meta.subPlaceholder && /url|link/i.test(meta.subPlaceholder) && sub) return sub.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return [sub, String(block.price || '').trim()].filter(Boolean).join(' · ');
  }

  // Social links module: the profiles filled in on the Profile tab (read
  // from its fields, so it's always current), each with a switch. Only the
  // ones switched off are saved (lib/blocks.js) — a profile added later
  // shows up switched on.
  function socialProfiles() {
    return [...document.querySelectorAll('input[data-social]')]
      .filter((input) => input.value.trim())
      .map((input) => {
        const row = input.closest('.pz-social-row');
        return {
          id: input.dataset.social,
          label: row.querySelector('.pz-social-name').textContent.trim(),
          icon: row.querySelector('.pz-social-icon svg').innerHTML,
          value: input.value.trim(),
        };
      });
  }
  function socialOn(block, platform) {
    return !(block.items || []).some((item) => item.platform === platform && !item.on);
  }
  function socialListHTML(block) {
    const profiles = socialProfiles();
    // An older Social block saved a single profile URL — kept editable.
    const legacy = block.sub
      ? `<input type="text" class="pz-field-input" data-field="sub" data-id="${block.id}" value="${escapeHTML(block.sub)}" placeholder="Profile link" />
         <p class="pz-block-hint">This module links to one profile. Clear the link to show all your profile icons instead.</p>`
      : '';
    if (legacy) return legacy;
    if (!profiles.length) {
      return `<div class="pz-social-empty">
          <span>No social profiles yet.</span>
          <button type="button" class="pz-chip-btn is-solid" data-goto-tab="profile">Add them in Profile</button>
        </div>`;
    }
    return `<div class="pz-social-toggles">${profiles.map((pf) => {
      const on = socialOn(block, pf.id);
      return `<div class="pz-social-toggle${on ? '' : ' is-off'}">
          <span class="pz-social-icon"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="17" height="17" aria-hidden="true">${pf.icon}</svg></span>
          <span class="pz-social-toggle-text"><strong>${escapeHTML(pf.label)}</strong><small>${escapeHTML(pf.value)}</small></span>
          <button type="button" class="pz-switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="Show ${escapeHTML(pf.label)}" data-social-toggle="${pf.id}" data-id="${block.id}"></button>
        </div>`;
    }).join('')}</div>`;
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
        <button type="button" class="pz-drag-handle" data-drag-id="${block.id}" title="Drag to reorder" aria-label="Reorder ${escapeHTML(block.title || meta.label)} — drag, or use the arrow keys">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15" aria-hidden="true"><circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/></svg>
        </button>
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
          ${meta.socialList ? socialListHTML(block) : meta.hasItems ? itemsEditorHTML(block) : `<div style="display:flex; gap:8px;">
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
    if (block.id < 0) {
      return '<div class="pz-popup-link"><span class="pz-popup-link-label">Popup link</span><code>Publish karke is popup ka link milega</code></div>';
    }
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
        markBlock(id, field);
      });
    });
    blocksList.querySelectorAll('.toggle-visible').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const block = blocks.find((b) => b.id === id);
        if (!block) return;
        block.visible = !block.visible;
        render();
        renderPreviewOnly();
        markBlock(id, 'visible');
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
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        closeAllKebabMenus();
        const source = blocks.find((b) => b.id === id);
        if (!source) return;
        // The copy goes right under the original; it's created on Publish.
        const copy = JSON.parse(JSON.stringify(source));
        copy.id = nextTempId();
        copy.title = source.title ? `${source.title} (copy)` : '';
        blocks.splice(blocks.indexOf(source) + 1, 0, copy);
        expanded.add(copy.id);
        render();
        changed('structure');
      });
    });
    blocksList.querySelectorAll('.remove-block').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        closeAllKebabMenus();
        // Gone from the draft; a live block is deleted on Publish (and Undo brings it back).
        blocks = blocks.filter((b) => b.id !== id);
        render();
        changed('structure');
      });
    });
  }

  document.addEventListener('click', closeAllKebabMenus);

  // --- reordering ---------------------------------------------------------
  // Drag a card by its handle (mouse, pen or touch — pointer events), or
  // focus the handle and use ↑ ↓. The card follows the pointer, the others
  // slide out of its way, and the page scrolls near the edges. The new
  // order is saved with everything else on Save.
  const liveRegion = document.createElement('div');
  liveRegion.className = 'sr-only';
  liveRegion.setAttribute('aria-live', 'polite');
  document.body.appendChild(liveRegion);

  function saveOrder() {
    renderPreviewOnly();
    markDirty('order');
  }

  // Slides cards from where they were to where they are now (FLIP).
  function animateFrom(tops) {
    blocksList.querySelectorAll('.pz-block-card:not(.pz-dragging)').forEach((el) => {
      const before = tops.get(el);
      if (before === undefined) return;
      const shift = before - el.getBoundingClientRect().top;
      if (!shift) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${shift}px)`;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
      });
    });
  }
  function cardTops() {
    const tops = new Map();
    blocksList.querySelectorAll('.pz-block-card').forEach((el) => tops.set(el, el.getBoundingClientRect().top));
    return tops;
  }

  let drag = null;
  blocksList.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.pz-drag-handle');
    if (!handle || e.button !== 0 || blocks.length < 2) return;
    e.preventDefault();
    closeAllKebabMenus();
    const card = handle.closest('.pz-block-card');
    drag = {
      card,
      handle,
      pointerId: e.pointerId,
      startPageY: e.clientY + window.scrollY,
      lastClientY: e.clientY,
      startOrder: blocks.map((b) => b.id),
      raf: null,
    };
    handle.setPointerCapture(e.pointerId);
    card.classList.add('pz-dragging');
    document.body.classList.add('pz-sorting');
    handle.addEventListener('pointermove', onDragMove);
    handle.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('pointercancel', onDragEnd);
    // If capture is lost anyway (the window lost focus, say), the drop
    // still ends the drag.
    window.addEventListener('pointerup', onDragEnd);
    handle.addEventListener('lostpointercapture', onDragEnd);
    drag.raf = requestAnimationFrame(autoScroll);
  });

  // Where the card sits in the list without its drag offset.
  function layoutTop(el) {
    return el.getBoundingClientRect().top - (Number(el.dataset.dragOffset) || 0);
  }

  function positionDragged() {
    const { card } = drag;
    const offset = (drag.lastClientY + window.scrollY) - drag.startPageY;
    card.dataset.dragOffset = offset;
    card.style.transform = `translateY(${offset}px)`;
    // Swap with a neighbour once the card's middle passes the neighbour's.
    for (;;) {
      const box = card.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      const next = card.nextElementSibling;
      const prev = card.previousElementSibling;
      let moved = null;
      if (next && middle > next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2) moved = next;
      else if (prev && middle < prev.getBoundingClientRect().top + prev.getBoundingClientRect().height / 2) moved = prev;
      if (!moved) break;
      const tops = cardTops();
      const before = layoutTop(card);
      // Always move the neighbour, never the dragged card: moving the
      // card would drop its pointer capture and lose the drop.
      if (moved === next) blocksList.insertBefore(next, card);
      else blocksList.insertBefore(prev, card.nextSibling);
      // Keep the card under the pointer: its slot moved, so the offset shrinks by as much.
      const shift = layoutTop(card) - before;
      drag.startPageY += shift;
      const newOffset = (drag.lastClientY + window.scrollY) - drag.startPageY;
      card.dataset.dragOffset = newOffset;
      card.style.transform = `translateY(${newOffset}px)`;
      animateFrom(tops);
    }
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastClientY = e.clientY;
    positionDragged();
  }

  // Scrolls while the pointer is near the top or bottom of the window.
  function autoScroll() {
    if (!drag) return;
    const edge = 72;
    const y = drag.lastClientY;
    let speed = 0;
    if (y < edge) speed = -Math.ceil((edge - y) / 6);
    else if (y > window.innerHeight - edge) speed = Math.ceil((y - (window.innerHeight - edge)) / 6);
    if (speed) {
      window.scrollBy(0, speed);
      positionDragged();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onDragEnd(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { card, handle, startOrder } = drag;
    cancelAnimationFrame(drag.raf);
    handle.removeEventListener('pointermove', onDragMove);
    handle.removeEventListener('pointerup', onDragEnd);
    handle.removeEventListener('pointercancel', onDragEnd);
    window.removeEventListener('pointerup', onDragEnd);
    handle.removeEventListener('lostpointercapture', onDragEnd);
    drag = null;
    card.classList.remove('pz-dragging');
    card.style.transform = '';
    delete card.dataset.dragOffset;
    document.body.classList.remove('pz-sorting');

    const order = [...blocksList.querySelectorAll('.pz-block-card')].map((el) => Number(el.dataset.id));
    if (order.join() === startOrder.join()) return;
    const previous = blocks;
    blocks = order.map((id) => previous.find((b) => b.id === id)).filter(Boolean);
    render();
    const moved = blocksList.querySelector(`.pz-drag-handle[data-drag-id="${card.dataset.id}"]`);
    if (moved) moved.focus({ preventScroll: true });
    liveRegion.textContent = `Moved to position ${order.indexOf(Number(card.dataset.id)) + 1} of ${order.length}`;
    saveOrder();
  }

  // Keyboard: ↑ / ↓ on a focused handle moves that block one place.
  blocksList.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.pz-drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const id = Number(handle.dataset.dragId);
    const i = blocks.findIndex((b) => b.id === id);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= blocks.length) return;
    blocks = blocks.slice();
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    const tops = cardTops();
    render();
    // Re-rendered cards are new elements; carry the old positions over by id.
    const byId = new Map();
    tops.forEach((top, el) => byId.set(el.dataset.id, top));
    const mapped = new Map();
    blocksList.querySelectorAll('.pz-block-card').forEach((el) => mapped.set(el, byId.get(el.dataset.id)));
    animateFrom(mapped);
    blocksList.querySelector(`.pz-drag-handle[data-drag-id="${id}"]`).focus();
    liveRegion.textContent = `Moved to position ${j + 1} of ${blocks.length}`;
    saveOrder();
  });

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
    const toggle = e.target.closest('[data-social-toggle]');
    if (toggle) {
      const block = blocks.find((b) => b.id === Number(toggle.dataset.id));
      if (!block) return;
      const platform = toggle.dataset.socialToggle;
      const on = !socialOn(block, platform);
      // Only the switched-off ones are kept.
      block.items = (block.items || []).filter((item) => item.platform !== platform);
      if (!on) block.items.push({ platform, on: false });
      render();
      renderPreviewOnly();
      queueItemsSave(block);
      const again = blocksList.querySelector(`[data-social-toggle="${platform}"][data-id="${block.id}"]`);
      if (again) again.focus();
      return;
    }
    const goto = e.target.closest('[data-goto-tab]');
    if (goto) {
      document.querySelector(`.pz-rail-btn[data-tab="${goto.dataset.gotoTab}"]`).click();
      const first = document.querySelector('input[data-social]');
      if (first) first.focus();
      return;
    }
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

  // A new block goes into the draft at once; Publish creates it on the live page.
  function addBlock(type) {
    if (blocks.length >= ((window.__PZ_DRAFT__ || {}).maxBlocks || 100)) {
      closeAddModal();
      setError('Page par aur sections nahi jod sakte — pehle koi hatayein.');
      return;
    }
    const starter = (window.__PZ_STARTERS__ || {})[type] || { title: '', items: [] };
    const block = {
      id: nextTempId(), type,
      title: starter.title, sub: '', price: '', visible: true,
      items: JSON.parse(JSON.stringify(starter.items || [])),
    };
    blocks.push(block);
    expanded.add(block.id);
    closeAddModal();
    render();
    changed('structure');
    requestAnimationFrame(() => {
      const last = blocksList.querySelector('.pz-block-card:last-child .pz-title');
      if (last) { last.focus(); last.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    });
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
  function paintSwatches() {
    document.querySelectorAll('.pz-swatch').forEach((btn) => {
      const isCurrent = btn.dataset.color.toLowerCase() === currentAccent.toLowerCase();
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-checked', String(isCurrent));
    });
  }
  paintSwatches();
  document.querySelectorAll('.pz-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentAccent = btn.dataset.color;
      paintSwatches();
      renderPreviewOnly();
      markDirty('accent');
    });
  });
  badgeToggle.addEventListener('click', () => {
    const on = badgeToggle.classList.toggle('on');
    badgeToggle.setAttribute('aria-checked', String(on));
    renderPreviewOnly();
    markDirty('badge');
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

  // The live handle (the header, "View live", popup links) changes on
  // Publish; the preview's address bar shows the draft's.
  function paintLiveHandle(liveHandle) {
    const handleChanged = switcherHandle.textContent !== `@${liveHandle}`;
    switcherHandle.textContent = `@${liveHandle}`;
    if (handleChanged) render(); // popup links include the handle
    const viewLiveBtn = document.getElementById('viewLiveBtn');
    if (viewLiveBtn && window.__PZ_STORE_URL__) viewLiveBtn.href = window.__PZ_STORE_URL__.replace('{handle}', liveHandle);
  }
  function paintPreviewUrl() {
    previewUrl.textContent = `${handle.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || 'yourname'}.${window.__PZ_SITE_DOMAIN__}`;
  }

  displayName.addEventListener('input', () => {
    const i = initials(displayName.value);
    avatarInitials.textContent = i;
    switcherInitials.textContent = i;
    renderPreviewOnly();
    markDirty('profile');
  });
  bio.addEventListener('input', () => {
    paintBioCount();
    renderPreviewOnly();
    markDirty('profile');
  });
  handle.addEventListener('input', () => {
    paintPreviewUrl();
    markDirty('handle');
  });
  socialInputs.forEach((input) => {
    input.addEventListener('input', () => {
      paintSocials();
      if (blocks.some((b) => b.type === 'social')) render();
      renderPreviewOnly();
      markDirty('profile');
    });
  });
  paintSocials();

  // --- store settings ----------------------------------------------------
  // Photo, cover, tagline, location, contact button, announcement bar,
  // theme and SEO (lib/storeSettings.js) — one object in the draft. (An
  // image uploads as soon as it's picked, but using it is a change like
  // any other: live only on Publish.)
  const settings = { ...(window.__PZ_SETTINGS__ || {}) };

  function settingChanged(key) {
    renderPreviewOnly();
    paintSeoPreview();
    markDirty(`setting:${key || 'any'}`);
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
      settingChanged(input.dataset.setting);
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

  // Plain on/off settings: <button data-setting-switch="key">.
  document.querySelectorAll('[data-setting-switch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.settingSwitch;
      settings[key] = !settings[key];
      btn.classList.toggle('on', settings[key]);
      btn.setAttribute('aria-checked', String(settings[key]));
      settingChanged();
    });
  });

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
  const UPLOAD_LABELS = { cover: 'Choose cover', shareImage: 'Choose image' };
  function paintImageField(field) {
    const key = field.dataset.imageField;
    const url = settings[key] || '';
    field.classList.toggle('has-image', !!url);
    const img = field.querySelector('[data-image-preview]');
    if (url) img.src = url; else img.removeAttribute('src');
    const remove = field.querySelector('[data-image-remove]');
    if (remove) remove.hidden = !url;
    const label = field.querySelector('[data-upload-label]');
    if (label) label.textContent = url ? 'Change' : UPLOAD_LABELS[key] || 'Choose';
  }
  document.querySelectorAll('[data-image-field]').forEach((field) => {
    const key = field.dataset.imageField;
    const fileInput = field.querySelector('[data-upload]');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setError('JPG, PNG ya WebP image chunein'); return; }
      if (file.size > 5 * 1024 * 1024) { setError('Image 5 MB se chhoti rakhein'); return; }
      field.classList.add('is-uploading');
      try {
        const data = await api('/dashboard/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        if (data.reused && window.mediaLibrary) window.mediaLibrary.toast('That file was already in your library — used the existing copy.');
        settings[key] = data.url;
        paintImageField(field);
        settingChanged();
      } catch (err) { /* status already shown */ } finally {
        field.classList.remove('is-uploading');
      }
    });
    // Picked from the media library (public/js/media-library.js): same as an upload.
    fileInput.addEventListener('media:pick', (e) => {
      settings[key] = e.detail.url;
      paintImageField(field);
      settingChanged();
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

  // --- the whole state: read from / written to the screen -----------------
  // What the draft holds (lib/storeDraft.js cleanState): auto-save sends
  // it, Undo puts an earlier one back.
  function collectState() {
    return {
      profile: { name: displayName.value, handle: handle.value, bio: bio.value, socials: collectSocials() },
      settings: { ...settings },
      design: { accent: currentAccent, showBadge: badgeToggle.classList.contains('on') },
      blocks: blocks.map((b) => ({
        id: b.id, type: b.type, title: b.title, sub: b.sub, price: b.price, visible: !!b.visible,
        items: JSON.parse(JSON.stringify(b.items || [])),
      })),
    };
  }

  function applyState(state) {
    displayName.value = state.profile.name;
    handle.value = state.profile.handle;
    bio.value = state.profile.bio;
    const i = initials(displayName.value);
    avatarInitials.textContent = i;
    switcherInitials.textContent = i;
    paintBioCount();
    paintPreviewUrl();
    socialInputs.forEach((input) => { input.value = state.profile.socials[input.dataset.social] || ''; });
    paintSocials();

    Object.keys(settings).forEach((key) => { delete settings[key]; });
    Object.assign(settings, state.settings);
    document.querySelectorAll('[data-setting]').forEach((input) => {
      input.value = settings[input.dataset.setting] ?? '';
      paintCounter(input);
    });
    ['contactType', 'theme', 'font', 'buttons'].forEach(paintChoices);
    paintContactFields();
    document.querySelectorAll('[data-setting-switch]').forEach((btn) => {
      const on = !!settings[btn.dataset.settingSwitch];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    });
    announceToggle.classList.toggle('on', !!settings.announceOn);
    announceToggle.setAttribute('aria-checked', String(!!settings.announceOn));
    document.getElementById('announceFields').hidden = !settings.announceOn;
    document.querySelectorAll('[data-image-field]').forEach(paintImageField);

    currentAccent = state.design.accent;
    paintSwatches();
    badgeToggle.classList.toggle('on', !!state.design.showBadge);
    badgeToggle.setAttribute('aria-checked', String(!!state.design.showBadge));

    blocks = state.blocks.filter((b) => TYPE_META[b.type]).map((b) => ({ ...b, visible: !!b.visible }));
    render();
    paintSeoPreview();
  }

  // --- publish / discard -------------------------------------------------
  // Publish: the last edits reach the draft first, then the server puts
  // the draft on the live page in one go (or not at all).
  async function publishNow() {
    if (publishing || discarding) return;
    publishing = true;
    paintSaveStatus();
    try {
      while (unsent || inFlight) {
        await flushSave(true);
        if (syncState !== 'saved') throw new Error(syncMessage || 'Changes save nahi ho paaye — thodi der mein Publish karein.');
      }
      const res = await fetch('/dashboard/builder/publish', {
        method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      if (res.redirected && new URL(res.url).pathname === '/login') throw new Error('Aap logout ho gaye — dobara login karein.');
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        if (data && data.field) showProblems({ [data.field]: data.error });
        throw new Error((data && data.error) || 'Publish nahi hua — dobara try karein.');
      }
      // New blocks have their real ids (and popup links) now.
      const ids = data.ids || {};
      blocks.forEach((b) => {
        const real = ids[String(b.id)];
        if (real && real !== b.id) {
          if (expanded.delete(b.id)) expanded.add(real);
          b.id = real;
        }
      });
      version = 0; // the draft is gone; the next edit starts a new one
      changes = [];
      justPublished = true;
      // Undo steps hold the old stand-in ids, so they end here.
      undoStack.length = 0;
      lastSnapshot = JSON.stringify(collectState());
      lastKey = null;
      showProblems({});
      paintLiveHandle(data.handle);
      render();
      liveRegion.textContent = 'Page live ho gaya';
    } catch (err) {
      setError(err instanceof TypeError ? 'Server tak nahi pahunch paaye — Publish nahi hua' : err.message);
    } finally {
      publishing = false;
      paintSaveStatus();
    }
  }
  publishBtn.addEventListener('click', publishNow);

  // Discard: the draft goes and the page reloads on what's live.
  discardBtn.addEventListener('click', async () => {
    if (!window.confirm('Saare unpublished changes hata dein? Page wapas live jaisa ho jayega.')) return;
    discarding = true;
    clearTimeout(saveTimer);
    closePendingList();
    paintSaveStatus();
    try {
      if (inFlight) await inFlight.catch(() => {});
      const res = await fetch('/dashboard/builder/discard', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Changes discard nahi hue — dobara try karein.');
      window.location.reload();
    } catch (err) {
      discarding = false;
      setError(err instanceof TypeError ? 'Server tak nahi pahunch paaye' : err.message);
    }
  });

  // "N changes abhi live nahi": opens the list of them.
  function closePendingList() {
    if (pendingList.hidden) return;
    pendingList.hidden = true;
    pendingPill.setAttribute('aria-expanded', 'false');
  }
  pendingPill.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pendingList.hidden;
    pendingList.hidden = !open;
    pendingPill.setAttribute('aria-expanded', String(open));
  });
  pendingList.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closePendingList);

  undoBtn.addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.key === 'Escape' && !pendingList.hidden) { closePendingList(); pendingPill.focus(); return; }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (key === 's') {
      e.preventDefault(); // stop the browser's "Save page as…"
      flushSave();
    } else if (key === 'z' && !e.shiftKey && addModal.hidden) {
      e.preventDefault();
      undo();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (discarding) return;
    if (unsent || inFlight) { e.preventDefault(); e.returnValue = ''; }
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
  paintPreviewUrl();
  lastSnapshot = JSON.stringify(collectState());
  paintSaveStatus();
})();
