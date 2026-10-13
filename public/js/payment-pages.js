// Payment pages dashboard (views/payment-pages.ejs). Same pattern as
// lead-magnets.js: data starts from window.__PZ_PAYMENT_PAGES__, every
// change is a fetch() to the JSON endpoints in
// server.js, and the builder doubles as the editor (a page's Edit button
// loads it back in).
//
// The builder holds a page's products as editable cards (Products tab).
// Amounts are typed in rupees and sent as paise; the server re-checks
// everything (lib/paymentPages.js), so the checks here are just for
// friendlier messages on the right tab.
(function () {
  let pages = window.__PZ_PAYMENT_PAGES__ || [];
  const storeUrl = window.__PZ_STORE_URL__ || '';
  const storeHost = storeUrl.replace(/^https?:\/\//, '');
  const DEFAULT_ACCENT = '#1261ef';
  const MAX_PRODUCTS = 10;

  const $ = (id) => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shadeHex(hex, amount) {
    const num = parseInt(hex.slice(1), 16);
    const clamp = (n) => Math.min(255, Math.max(0, n));
    return '#' + [num >> 16, (num >> 8) & 0xff, num & 0xff].map((c) => clamp(c + amount).toString(16).padStart(2, '0')).join('');
  }
  // Display only — mirrors formatINR() in lib/paymentPages.js.
  function formatINR(paise) {
    const rupees = (Number(paise) || 0) / 100;
    return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  // "499" / "1,499.50" → paise; null when blank, NaN when not an amount.
  function toPaise(raw) {
    const value = String(raw ?? '').replace(/[₹,\s]/g, '');
    if (value === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return NaN;
    return Math.round(Number(value) * 100);
  }
  const rupeesText = (paise) => (paise ? String(paise / 100) : '');
  // Whole numbers (stock, weight, max qty); null when blank, NaN when not.
  function toCount(raw) {
    const value = String(raw ?? '').trim();
    if (value === '') return null;
    return /^\d+$/.test(value) ? Number(value) : NaN;
  }

  const ICONS = {
    digital: '<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/>',
    physical: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>',
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>',
  };
  const icon = (type, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[type]}</svg>`;

  // What a stored product (paise) costs, as a short label for the list.
  function productPriceLabel(p) {
    if (p.pricing === 'pwyw') return p.minimum ? `from ${formatINR(p.minimum)}` : 'any amount';
    if (p.type === 'coffee') return `${formatINR(p.price)} / coffee`;
    if (p.pricing === 'qty') return `${formatINR(p.price)} each`;
    return formatINR(p.price);
  }
  function publicUrl(page) {
    return `${storeUrl}/pay/${page.slug}`;
  }

  // --- save status + fetch helper (same as the other dashboard pages) ---
  const saveStatus = $('saveStatus');
  const saveStatusText = $('saveStatusText');
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
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
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

  // --- tabs -------------------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll('.pb-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.pb-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  }
  document.querySelectorAll('.pb-tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  // --- builder state ----------------------------------------------------------
  const form = $('pageForm');
  const formError = $('pageFormError');
  const titleInput = $('ppTitle');
  const descInput = $('ppDescription');
  const aboutInput = $('ppAbout');
  const successInput = $('ppSuccessMessage');
  const marketplaceInput = $('ppMarketplace');
  const slugInput = $('ppSlug');
  const coverImageInput = $('ppCoverImage');
  const coverVideoInput = $('ppCoverVideo');
  const coverColorInput = $('ppCoverColor');
  const coverError = $('ppCoverError');
  const previewFrame = $('ppPreviewFrame');

  let editingId = null;
  let accent = DEFAULT_ACCENT;
  let showCover = true;
  let coverType = 'art';
  let coverColor = '';
  // The live preview's redraw (set up in "live preview" below).
  let refreshPreview = null;

  // Products while editing: amounts as the rupee text typed.
  let products = [];
  let nextPid = 1;
  function blankProduct(seed) {
    return Object.assign({
      id: nextPid++, title: '', description: '', type: 'digital', pricing: 'fixed',
      price: '', compareAt: '', maxQty: '', suggested: '', minimum: '',
      fileUrl: '', stock: '', weight: '', shipFee: '',
      mediaType: '', mediaUrl: '',
    }, seed || {});
  }
  // A stored product (paise) → an editable card.
  function fromStored(p) {
    return blankProduct({
      id: p.id,
      title: p.title || '',
      description: p.description || '',
      type: p.type,
      pricing: p.type === 'coffee' ? 'qty' : p.pricing,
      price: rupeesText(p.price),
      compareAt: rupeesText(p.compareAt),
      maxQty: p.maxQty ? String(p.maxQty) : '',
      suggested: rupeesText(p.suggested),
      minimum: rupeesText(p.minimum),
      fileUrl: p.fileUrl || '',
      stock: p.stock === null || p.stock === undefined ? '' : String(p.stock),
      weight: p.weight === null || p.weight === undefined ? '' : String(p.weight),
      shipFee: rupeesText(p.shipFee),
      mediaType: p.mediaType || '',
      mediaUrl: p.mediaUrl || '',
    });
  }

  // --- products tab: repeatable cards ------------------------------------------
  const prodList = $('prodList');
  const addProductBtn = $('addProductBtn');
  const soloSlot = $('soloProduct');

  function moneyInput(field, value, placeholder) {
    return `<div class="pb-price"><i>₹</i><input type="text" inputmode="decimal" class="pz-field-input" data-field="${field}" placeholder="${placeholder}" value="${escapeHTML(value)}" /></div>`;
  }
  function pricingPanelHTML(p) {
    if (p.pricing === 'qty') {
      return `
        <div class="pb-row">
          ${moneyInput('price', p.price, 'Unit price')}
          <input type="text" inputmode="numeric" class="pz-field-input" data-field="maxQty" placeholder="Max quantity (optional)" value="${escapeHTML(p.maxQty)}" />
        </div>
        <p class="pb-field-hint">Buyers pick how many at checkout — the price above is per unit.</p>`;
    }
    if (p.pricing === 'pwyw') {
      return `
        <div class="pb-row">
          ${moneyInput('suggested', p.suggested, 'Suggested amount')}
          ${moneyInput('minimum', p.minimum, 'Minimum (optional)')}
        </div>
        <p class="pb-field-hint">Buyers can enter their own amount at checkout — the suggested amount is pre-filled.</p>`;
    }
    return `
      <div class="pb-row">
        ${moneyInput('price', p.price, 'Price')}
        ${moneyInput('compareAt', p.compareAt, 'Compare-at (optional)')}
      </div>`;
  }

  // An optional image or video across the top of the product's card on the
  // page: uploaded, or a link (a video link can be YouTube / Vimeo).
  const UPLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M5 20h14"/></svg>';
  function mediaFieldHTML(p) {
    const video = p.mediaType === 'video';
    return `
      <div class="pb-media">
        <div class="pb-toggle pb-media-toggle" role="group" aria-label="Product image or video">
          <button type="button" class="${!p.mediaType ? 'active' : ''}" data-setmedia="">No media</button>
          <button type="button" class="${p.mediaType === 'image' ? 'active' : ''}" data-setmedia="image">Image</button>
          <button type="button" class="${video ? 'active' : ''}" data-setmedia="video">Video</button>
        </div>
        ${p.mediaType ? `
        <div class="pb-media-row">
          <label class="pz-card-btn pz-upload-btn">
            <input type="file" data-media-file accept="${video ? 'video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/gif'}" hidden />
            ${UPLOAD_ICON}<span>Upload ${video ? 'video' : 'image'}</span>
          </label>
          <input type="text" class="pz-field-input" data-field="mediaUrl" maxlength="500" placeholder="${video ? '…or paste a YouTube / Vimeo / .mp4 link' : '…or paste an image link (https://…)'}" value="${escapeHTML(p.mediaUrl)}" />
        </div>
        <p class="pb-field-hint">${video ? 'MP4 or WebM up to 30 MB, or a YouTube / Vimeo link — embedded with its own player.' : 'JPG, PNG, WebP or GIF up to 5 MB. Shown at the top of this product’s card.'}</p>
        <p class="pz-field-error" data-media-error></p>` : ''}
      </div>`;
  }

  // What kind of page this is — picked in the "Create payment page" popup
  // and saved with the page (pages from before that: read off products):
  //   'single'   — one digital or physical product
  //   'multiple' — up to MAX_PRODUCTS, digital and physical in any mix
  //   'coffee'   — just a buy-me-a-coffee button
  // It shapes the builder, and the public page's layout (lib/paymentStorefront.js).
  let pageKind = 'single';
  function kindOf(list) {
    if (list.length > 1) return 'multiple';
    return list[0] && list[0].type === 'coffee' ? 'coffee' : 'single';
  }
  const TYPE_LABELS = { digital: 'Digital', physical: 'Physical', coffee: 'Buy me a coffee' };
  // "Buy me a coffee" is its own kind of page, not a product type — only a
  // product saved as a coffee before that change keeps the option, so it
  // can still be edited (or switched away from).
  function typesFor(kind, p) {
    if (kind === 'coffee') return [];
    return p && p.type === 'coffee' && kind === 'multiple' ? ['digital', 'physical', 'coffee'] : ['digital', 'physical'];
  }

  function renderKind() {
    // Only a multi-product page has a Products tab; otherwise the one
    // product is edited inline in Details.
    const multiple = pageKind === 'multiple';
    $('tabProductsBtn').hidden = !multiple;
    // Coffee pages are tips, never listed on the marketplace (lib/marketplace.js).
    marketplaceInput.closest('.pb-option').hidden = pageKind === 'coffee';
    if (!multiple && $('tab-products').classList.contains('active')) showTab('page');
    $('tabPageLabel').textContent = multiple ? 'Page' : 'Details';
    $('ppProductsNote').hidden = !multiple;
    addProductBtn.hidden = !multiple;
    const BASICS = {
      single: ['Product', 'Product name', 'e.g. Notion Budget Planner'],
      multiple: ['Page', 'Page headline', 'e.g. Complete Starter Bundle'],
      coffee: ['Your page', 'Headline', 'Buy me a coffee'],
    }[pageKind];
    $('ppBasicsTitle').textContent = BASICS[0];
    $('ppTitleLabel').textContent = BASICS[1];
    titleInput.placeholder = BASICS[2];
    setBuilderMode();
  }

  // The pieces of a product editor, shared by the multi-product cards and
  // the inline "solo" editor of a single-product / coffee page.
  function typeToggleHTML(p) {
    const types = typesFor(pageKind, p);
    if (!types.length) return '';
    return `
      <div class="pb-toggle pb-type-toggle" role="group" aria-label="Product type">
        ${types.map((t) => `<button type="button" class="${p.type === t ? 'active' : ''}" data-settype="${t}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[t]}</svg>${TYPE_LABELS[t]}</button>`).join('')}
      </div>`;
  }
  function pricingToggleHTML(p) {
    return `
      <div class="pb-toggle pb-pricing-toggle" role="group" aria-label="Pricing">
        <button type="button" class="${p.pricing === 'fixed' ? 'active' : ''}" data-setpricing="fixed">Fixed price</button>
        <button type="button" class="${p.pricing === 'qty' ? 'active' : ''}" data-setpricing="qty">Per quantity</button>
        <button type="button" class="${p.pricing === 'pwyw' ? 'active' : ''}" data-setpricing="pwyw">Pay what you want</button>
      </div>`;
  }
  function coffeePriceHTML(p) {
    return `
      <div class="pb-row">${moneyInput('price', p.price, 'Price per coffee — e.g. 50')}</div>
      <div class="pb-coffee-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        <span>A quick-support button — buyers pick how many coffees (×1, ×3, ×5) or type their own number. No file or shipping needed.</span>
      </div>`;
  }
  function fulfilHTML(p) {
    if (p.type === 'digital') {
      return `
        <div class="pb-fulfil">
          <input type="url" class="pz-field-input" data-field="fileUrl" maxlength="500" placeholder="Link to the file — unlocked on the receipt once paid" value="${escapeHTML(p.fileUrl)}" />
        </div>`;
    }
    return `
      <div class="pb-fulfil">
        <div class="pb-row">
          <input type="text" inputmode="numeric" class="pz-field-input" data-field="stock" placeholder="Stock qty (blank = unlimited)" value="${escapeHTML(p.stock)}" />
          <input type="text" inputmode="numeric" class="pz-field-input" data-field="weight" placeholder="Weight (g)" value="${escapeHTML(p.weight)}" />
        </div>
        ${moneyInput('shipFee', p.shipFee, 'Shipping fee (blank = free)')}
      </div>`;
  }

  // One card in the Products tab of a multi-product page.
  function prodCardHTML(p, index) {
    const head = `
      <div class="pb-prod-head">
        <span class="pb-prod-index">${index + 1}</span>
        <input type="text" class="pz-field-input" data-field="title" maxlength="120" placeholder="${p.type === 'coffee' ? 'Buy me a coffee' : 'Product title'}" value="${escapeHTML(p.title)}" aria-label="Product ${index + 1} title" />
        <button type="button" class="pb-prod-remove" data-remove aria-label="Remove product ${index + 1}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <textarea class="pz-field-input pb-prod-desc" data-field="description" rows="2" maxlength="300" placeholder="Short description (optional) — shown with this product on the page" aria-label="Product ${index + 1} description">${escapeHTML(p.description)}</textarea>
      ${mediaFieldHTML(p)}`;
    if (p.type === 'coffee') {
      return `
        <div class="pb-prod-card" data-pid="${p.id}">
          ${head}
          ${typeToggleHTML(p)}
          <div class="pb-prod-body">${coffeePriceHTML(p)}</div>
        </div>`;
    }
    return `
      <div class="pb-prod-card" data-pid="${p.id}">
        ${head}
        ${typeToggleHTML(p)}
        ${pricingToggleHTML(p)}
        <div class="pb-prod-body">
          ${pricingPanelHTML(p)}
          ${fulfilHTML(p)}
        </div>
      </div>`;
  }

  // A single-product or coffee page has no product cards: the one product's
  // settings sit right in the Details tab, and its name is the page's own
  // headline (see syncPreview).
  function soloEditorHTML(p) {
    const section = (title, body) => `<div class="pb-section"><p class="pb-section-title">${title}</p>${body}</div>`;
    const media = section('Image or video', mediaFieldHTML(p));
    if (p.type === 'coffee') {
      return `<div data-pid="${p.id}">${section('Price', coffeePriceHTML(p))}${media}</div>`;
    }
    return `<div data-pid="${p.id}">
      ${section('Product type', `${typeToggleHTML(p)}<p class="pb-field-hint">${p.type === 'digital' ? 'Buyers get a download link on their receipt.' : 'Checkout asks for a shipping address.'}</p>`)}
      ${section('Price', `${pricingToggleHTML(p)}${pricingPanelHTML(p)}`)}
      ${section(p.type === 'digital' ? 'Delivery' : 'Stock &amp; shipping', fulfilHTML(p))}
      ${media}
    </div>`;
  }

  function renderProducts() {
    const solo = pageKind !== 'multiple';
    prodList.innerHTML = solo ? '' : products.map(prodCardHTML).join('');
    soloSlot.innerHTML = solo ? soloEditorHTML(products[0]) : '';
    $('tabProductCount').textContent = products.length;
    addProductBtn.disabled = products.length >= MAX_PRODUCTS;
    const editors = solo ? [soloSlot.firstElementChild] : prodList.querySelectorAll('.pb-prod-card');
    editors.forEach((card) => {
      const p = products.find((x) => x.id === Number(card.dataset.pid));
      card.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('input', () => {
        p[input.dataset.field] = input.value;
        syncPreview();
      }));
      card.querySelectorAll('[data-settype]').forEach((btn) => btn.addEventListener('click', () => {
        p.type = btn.dataset.settype;
        if (p.type === 'coffee') p.pricing = 'qty';
        else if (p.pricing === 'qty' && !p.maxQty && card.querySelector('[data-settype].active')?.dataset.settype === 'coffee') p.pricing = 'fixed';
        renderProducts();
      }));
      card.querySelectorAll('[data-setpricing]').forEach((btn) => btn.addEventListener('click', () => {
        p.pricing = btn.dataset.setpricing;
        renderProducts();
      }));
      card.querySelectorAll('[data-setmedia]').forEach((btn) => btn.addEventListener('click', () => {
        if (p.mediaType === btn.dataset.setmedia) return;
        // An image link makes no sense as a video and vice versa.
        p.mediaType = btn.dataset.setmedia;
        p.mediaUrl = '';
        renderProducts();
      }));
      const mediaFile = card.querySelector('[data-media-file]');
      if (mediaFile) {
        const mediaError = card.querySelector('[data-media-error]');
        wireUpload(mediaFile, card.querySelector('[data-field="mediaUrl"]'), p.mediaType, mediaError, (url) => {
          p.mediaUrl = url;
          syncPreview();
        });
        card.querySelector('[data-field="mediaUrl"]').addEventListener('input', () => mediaError.classList.remove('show'));
      }
      card.querySelector('[data-remove]')?.addEventListener('click', () => {
        products = products.filter((x) => x.id !== p.id);
        // The builder never sits empty.
        if (!products.length) products.push(blankProduct());
        renderProducts();
      });
    });
    syncPreview();
  }
  addProductBtn.addEventListener('click', () => {
    if (products.length >= MAX_PRODUCTS) return;
    products.push(blankProduct());
    renderProducts();
    const cards = prodList.querySelectorAll('.pb-prod-card');
    cards[cards.length - 1].querySelector('[data-field="title"]').focus();
  });

  // --- live preview -------------------------------------------------------------
  // The real page (views/payment-page.ejs), drawn by the server from what's
  // in the builder now (lib/livePreview.js, public/js/live-preview.js) — a
  // page not named or priced yet shows stand-ins.
  refreshPreview = window.livePreview($('ppPreviewBox'), () => {
    const built = buildPayload({ draft: true });
    if (built.error) return { error: built.error };
    return {
      url: '/dashboard/payment-pages/preview',
      type: 'application/json',
      body: JSON.stringify({ page: built.payload, id: editingId }),
      note: built.standIns ? 'Showing stand-ins until you add a name and a price.' : '',
    };
  });

  // After any change: a one-product page's product follows the headline,
  // the address bar follows the link, and the preview redraws (debounced).
  function syncPreview() {
    if (pageKind !== 'multiple' && products[0]) products[0].title = titleInput.value;
    const headline = titleInput.value.trim() || (products.length === 1 && products[0].title.trim()) || '';
    const editing = pages.find((pg) => pg.id === editingId);
    const slug = editing ? (slugInput.value.trim() || editing.slug)
      : headline.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    $('ppPreviewUrl').textContent = `${storeHost}/pay/${slug || '…'}`;
    if (refreshPreview && !$('builderSection').hidden) refreshPreview.soon();
  }
  [titleInput, descInput, aboutInput, slugInput].forEach((el) => el.addEventListener('input', syncPreview));

  // Full description toolbar: each button wraps the selection (or the
  // current line) in the small format lib/richText.js understands.
  function editAbout(format) {
    const el = aboutInput;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const selected = value.slice(start, end);
    let before = value.slice(0, start);
    let after = value.slice(end);
    let insert;
    let selFrom;
    let selTo;
    const wrap = (mark, fallback) => {
      const inner = selected || fallback;
      insert = `${mark}${inner}${mark}`;
      selFrom = before.length + mark.length;
      selTo = selFrom + inner.length;
    };
    // Line formats apply to every selected line, from the start of the first.
    const prefixLines = (makePrefix, fallback) => {
      // Whole lines: from the start of the first selected line to the end
      // of the last, so a bare cursor formats the line it's on.
      const lineStart = before.lastIndexOf('\n') + 1;
      const lead = before.slice(lineStart);
      before = before.slice(0, lineStart);
      const nl = after.indexOf('\n');
      const tail = nl === -1 ? after : after.slice(0, nl);
      after = after.slice(tail.length);
      const lines = `${lead}${selected}${tail}`.split('\n');
      const body = lines.map((l, i) => `${makePrefix(i)}${l.replace(/^(#{2,3}\s+|\s*[-*]\s+|\s*\d{1,3}[.)]\s+)/, '') || (lines.length === 1 ? fallback : '')}`).join('\n');
      insert = body;
      selFrom = before.length;
      selTo = selFrom + body.length;
    };
    if (format === 'bold') wrap('**', 'bold text');
    else if (format === 'italic') wrap('*', 'italic text');
    else if (format === 'heading') prefixLines(() => '## ', 'Heading');
    else if (format === 'bullet') prefixLines(() => '- ', 'List item');
    else if (format === 'numbered') prefixLines((i) => `${i + 1}. `, 'List item');
    else if (format === 'link') {
      const url = window.prompt('Link address (https://…)', 'https://');
      if (!url || !/^(https?:\/\/|mailto:)\S+$/i.test(url.trim())) return;
      const label = selected || 'link text';
      insert = `[${label}](${url.trim()})`;
      selFrom = before.length + 1;
      selTo = selFrom + label.length;
    } else return;
    el.value = before + insert + after;
    el.focus();
    el.setSelectionRange(selFrom, selTo);
    syncPreview();
  }
  document.querySelectorAll('.pb-rich-toolbar [data-format]').forEach((btn) => {
    // mousedown keeps the textarea's selection while the button is pressed.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => editAbout(btn.dataset.format));
  });

  // --- design tab: accent + cover ------------------------------------------------
  function setAccent(color) {
    accent = /^#[0-9a-f]{6}$/i.test(color || '') ? color.toLowerCase() : DEFAULT_ACCENT;
    document.querySelectorAll('#ppSwatchRow .swatch').forEach((s) => s.classList.remove('active'));
    const preset = document.querySelector(`#ppSwatchRow .swatch[data-accent="${accent}"]`);
    if (preset) preset.classList.add('active');
    else {
      $('ppCustomColor').value = accent;
      $('ppCustomColor').parentElement.classList.add('active');
    }
    syncCover();
  }
  document.querySelectorAll('#ppSwatchRow .swatch[data-accent]').forEach((sw) => sw.addEventListener('click', () => setAccent(sw.dataset.accent)));
  $('ppCustomColor').addEventListener('input', (e) => setAccent(e.target.value));

  const isCoverUrl = (v) => /^https?:\/\//i.test(v) || /^\/uploads\//.test(v);
  function syncCover() {
    document.querySelectorAll('#ppCoverChoice .cover-opt').forEach((b) => {
      b.classList.toggle('active', showCover ? b.dataset.cover === coverType : b.dataset.cover === 'none');
    });
    $('ppCoverImagePanel').hidden = !(showCover && coverType === 'image');
    $('ppCoverVideoPanel').hidden = !(showCover && coverType === 'video');
    $('ppCoverColorRow').hidden = !(showCover && coverType !== 'art');
    coverColorInput.value = coverColor || shadeHex(accent, coverType === 'color' ? 0 : -60);
    $('ppCoverColorHint').textContent = coverColor
      ? (coverType === 'color' ? 'Fills the banner.' : 'Shows behind the cover while it loads.')
      : 'Matches your accent color.';
    $('ppCoverColorReset').hidden = !coverColor;
    syncPreview();
  }
  document.querySelectorAll('#ppCoverChoice .cover-opt').forEach((btn) => btn.addEventListener('click', () => {
    showCover = btn.dataset.cover !== 'none';
    if (showCover) coverType = btn.dataset.cover;
    coverError.classList.remove('show');
    syncCover();
  }));
  [coverImageInput, coverVideoInput].forEach((el) => el.addEventListener('input', () => {
    coverError.classList.remove('show');
    syncCover();
  }));
  coverColorInput.addEventListener('input', () => {
    coverColor = coverColorInput.value;
    syncCover();
  });
  $('ppCoverColorReset').addEventListener('click', () => {
    coverColor = '';
    syncCover();
  });
  document.querySelectorAll('#tab-design .pz-cover-media .pz-cover-clear').forEach((btn) => btn.addEventListener('click', () => {
    (btn.dataset.clear === 'video' ? coverVideoInput : coverImageInput).value = '';
    syncCover();
  }));

  // Uploads: same endpoint as the lead magnet builder (lib/uploads.js).
  // Used by the cover and by each product's image / video.
  const UPLOAD_LIMITS = { image: 5, video: 30 };
  function wireUpload(fileInput, urlInput, kind, errorEl, onDone) {
    const button = fileInput.closest('.pz-upload-btn');
    const label = button.querySelector('span');
    const idle = label.textContent;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const fail = (message) => {
        errorEl.textContent = message;
        errorEl.classList.add('show');
      };
      errorEl.classList.remove('show');
      if (!file.type.startsWith(`${kind}/`)) return fail(kind === 'video' ? 'Choose an MP4 or WebM video.' : 'Choose a JPG, PNG, WebP or GIF image.');
      if (file.size > UPLOAD_LIMITS[kind] * 1024 * 1024) return fail(`That file is too big — keep ${kind}s under ${UPLOAD_LIMITS[kind]} MB.`);
      button.classList.add('is-busy');
      label.textContent = 'Uploading…';
      try {
        const { url } = await api('/dashboard/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        urlInput.value = url;
        onDone(url);
      } catch (err) {
        fail(err.message || 'Could not upload that file. Please try again.');
      } finally {
        button.classList.remove('is-busy');
        label.textContent = idle;
      }
    });
  }
  wireUpload($('ppCoverImageFile'), coverImageInput, 'image', coverError, syncCover);
  wireUpload($('ppCoverVideoFile'), coverVideoInput, 'video', coverError, syncCover);

  // --- create / edit --------------------------------------------------------------
  function setBuilderMode() {
    const editing = editingId !== null;
    const NEW_HEADINGS = { single: 'New single-product page', multiple: 'New multi-product page', coffee: 'New buy-me-a-coffee page' };
    $('builderHeading').textContent = editing ? 'Edit payment page' : NEW_HEADINGS[pageKind];
    $('builderSubmitLabel').textContent = editing ? 'Save changes' : 'Create payment page';
    $('builderSubmitIcon').style.display = editing ? 'none' : '';
    $('ppSlugRow').hidden = !editing;
  }

  // kind: for a new page, the type picked in the "Create" popup.
  function loadIntoBuilder(page, kind) {
    titleInput.value = page ? page.title : '';
    descInput.value = page ? page.description : '';
    aboutInput.value = page ? page.about || '' : '';
    successInput.value = page ? page.success_message : '';
    marketplaceInput.checked = !!(page && page.marketplace);
    slugInput.value = page ? page.slug : '';
    nextPid = 1;
    if (page && page.products.length) products = page.products.map(fromStored);
    else products = [kind === 'coffee' ? blankProduct({ type: 'coffee', pricing: 'qty' }) : blankProduct()];
    nextPid = Math.max(...products.map((p) => p.id)) + 1;
    pageKind = !page && kind ? kind : (page && page.kind) || kindOf(products);
    // Older single-product pages may have left the headline to the product.
    if (pageKind !== 'multiple' && !titleInput.value.trim()) titleInput.value = products[0].title;
    renderKind();
    showCover = page ? !!page.show_cover : true;
    coverType = page && ['art', 'image', 'video', 'color'].includes(page.cover_type) ? page.cover_type : 'art';
    coverColor = page ? page.cover_color || '' : '';
    coverImageInput.value = page ? page.cover_image_url : '';
    coverVideoInput.value = page ? page.cover_video_url : '';
    coverError.classList.remove('show');
    formError.classList.remove('show');
    setAccent(page ? page.accent_color : DEFAULT_ACCENT);
    setBuilderMode();
    renderProducts();
    showTab('page');
  }

  // The builder stays hidden until a page is being created or edited; open,
  // it covers the screen (the page behind doesn't scroll).
  const builderSection = $('builderSection');
  function openBuilder() {
    builderSection.hidden = false;
    document.body.classList.add('pb-studio-open');
    builderSection.querySelector('.pb-studio-scroll').scrollTop = 0;
    titleInput.focus({ preventScroll: true });
    refreshPreview();
  }

  // Preview size: Desktop / Mobile, remembered in this browser (best-effort).
  const viewButtons = [...document.querySelectorAll('[data-pb-view]')];
  function showView(view) {
    view = view === 'mobile' ? 'mobile' : 'desktop';
    previewFrame.classList.toggle('is-mobile', view === 'mobile');
    previewFrame.classList.toggle('is-desktop', view !== 'mobile');
    viewButtons.forEach((b) => b.setAttribute('aria-pressed', b.dataset.pbView === view ? 'true' : 'false'));
    try { localStorage.setItem('pz-studio-view', view); } catch (err) { /* storage off */ }
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => showView(b.dataset.pbView)));
  let savedView = null;
  try { savedView = localStorage.getItem('pz-studio-view'); } catch (err) { /* storage off */ }
  showView(savedView || (window.innerWidth < 700 ? 'mobile' : 'desktop'));

  function startEdit(id) {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    editingId = id;
    loadIntoBuilder(page);
    renderPages();
    openBuilder();
  }
  function startCreate(kind) {
    const wasEditing = editingId !== null;
    editingId = null;
    loadIntoBuilder(null, kind);
    if (wasEditing) renderPages();
    openBuilder();
  }
  function resetBuilder() {
    const wasEditing = editingId !== null;
    editingId = null;
    loadIntoBuilder(null);
    builderSection.hidden = true;
    document.body.classList.remove('pb-studio-open');
    if (wasEditing) renderPages();
  }
  $('builderCancelBtn').addEventListener('click', resetBuilder);
  $('builderBackBtn').addEventListener('click', resetBuilder);

  // "Create payment page" → a popup asking what kind of page, then the builder.
  const kindModal = $('kindModal');
  let kindModalOpener = null;
  function openKindModal() {
    kindModalOpener = document.activeElement;
    kindModal.classList.add('open');
    kindModal.setAttribute('aria-hidden', 'false');
    kindModal.querySelector('.pb-kind-tile').focus();
  }
  function closeKindModal() {
    kindModal.classList.remove('open');
    kindModal.setAttribute('aria-hidden', 'true');
    if (kindModalOpener && document.contains(kindModalOpener)) kindModalOpener.focus();
    kindModalOpener = null;
  }
  document.querySelectorAll('[data-open-create]').forEach((btn) => btn.addEventListener('click', openKindModal));
  kindModal.querySelectorAll('[data-pick-kind]').forEach((tile) => tile.addEventListener('click', () => {
    kindModalOpener = null;
    closeKindModal();
    startCreate(tile.dataset.pickKind);
  }));
  $('kindModalClose').addEventListener('click', closeKindModal);
  kindModal.addEventListener('click', (e) => { if (e.target === kindModal) closeKindModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && kindModal.classList.contains('open')) closeKindModal();
  });

  function showFormError(message, tab, focusEl) {
    if (tab) showTab(tab);
    formError.textContent = message;
    formError.classList.add('show');
    if (focusEl) focusEl.focus();
  }
  // The input for one of a product card's fields, for focusing on an error.
  const productInput = (p, field) => (pageKind !== 'multiple' && field === 'title' ? titleInput
    : form.querySelector(`[data-pid="${p.id}"] [data-field="${field}"]`));

  // Builder cards → what the server stores (paise), or an error to show.
  // draft (the live preview): a product not named or priced yet gets a
  // stand-in instead of an error, and `standIns` says so.
  function collectProducts({ draft = false } = {}) {
    const out = [];
    let standIns = false;
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      const name = pageKind === 'multiple' ? `product ${i + 1}` : 'your product';
      const bad = (message, field) => ({ error: message, product: p, field });
      const title = p.title.trim();
      if (!title && p.type !== 'coffee') {
        if (!draft) return bad(`Give ${name} a title.`, 'title');
        standIns = true;
      }
      const item = { id: p.id, title: title || (p.type === 'coffee' ? 'Buy me a coffee' : 'Your product'), type: p.type, pricing: p.type === 'coffee' ? 'qty' : p.pricing };
      if (p.description.trim()) item.description = p.description.trim();
      const mediaUrl = p.mediaUrl.trim();
      if (p.mediaType && mediaUrl) {
        if (!isCoverUrl(mediaUrl)) return bad(`The ${p.mediaType} link for ${name} needs to start with http:// or https://`, 'mediaUrl');
        Object.assign(item, { mediaType: p.mediaType, mediaUrl });
      }

      if (item.pricing === 'pwyw') {
        const suggested = toPaise(p.suggested);
        const minimum = toPaise(p.minimum);
        if (Number.isNaN(suggested)) return bad(`The suggested amount for ${name} doesn’t look like an amount.`, 'suggested');
        if (Number.isNaN(minimum)) return bad(`The minimum for ${name} doesn’t look like an amount.`, 'minimum');
        if (suggested && minimum && suggested < minimum) return bad(`The suggested amount for ${name} can’t be below its minimum.`, 'suggested');
        Object.assign(item, { suggested: suggested || 0, minimum: minimum || 0 });
      } else {
        let price = toPaise(p.price);
        if (!(price >= 100) && draft && !String(p.price).trim()) {
          price = 100;
          standIns = true;
        }
        if (!(price >= 100)) return bad(p.type === 'coffee' ? `Set a price per coffee of at least ₹1 for ${name}.` : `Set a price of at least ₹1 for ${name}.`, 'price');
        item.price = price;
      }
      if (item.pricing === 'fixed') {
        const compareAt = toPaise(p.compareAt);
        if (Number.isNaN(compareAt) || (compareAt !== null && compareAt <= item.price)) return bad(`The compare-at price for ${name} should be higher than its price — or leave it blank.`, 'compareAt');
        item.compareAt = compareAt;
      }
      if (item.pricing === 'qty' && p.type !== 'coffee') {
        const maxQty = toCount(p.maxQty);
        if (Number.isNaN(maxQty) || (maxQty !== null && (maxQty < 1 || maxQty > 100))) return bad(`Max quantity for ${name} needs to be a whole number from 1 to 100.`, 'maxQty');
        item.maxQty = maxQty;
      }
      if (p.type === 'digital') {
        const fileUrl = p.fileUrl.trim();
        if (fileUrl && !/^https?:\/\//i.test(fileUrl)) return bad(`The file link for ${name} needs to start with http:// or https://`, 'fileUrl');
        item.fileUrl = fileUrl;
      }
      if (p.type === 'physical') {
        const stock = toCount(p.stock);
        const weight = toCount(p.weight);
        const shipFee = toPaise(p.shipFee);
        if (Number.isNaN(stock)) return bad(`Stock for ${name} needs to be a whole number — or blank for unlimited.`, 'stock');
        if (Number.isNaN(weight)) return bad(`Weight for ${name} needs to be a whole number of grams.`, 'weight');
        if (Number.isNaN(shipFee)) return bad(`The shipping fee for ${name} doesn’t look like an amount.`, 'shipFee');
        Object.assign(item, { stock, weight, shipFee: shipFee || 0 });
      }
      out.push(item);
    }
    return { products: out, standIns };
  }

  // The page as the server takes it — { payload } — or the first thing to
  // fix — { error, tab, focus }. draft (the live preview): a page not named
  // or priced yet gets stand-ins instead (standIns: true).
  function buildPayload({ draft = false } = {}) {
    let headline = titleInput.value;
    if (pageKind === 'single' && !headline.trim()) {
      if (!draft) return { error: 'Give your product a name.', tab: 'page', focus: titleInput };
    }
    const collected = collectProducts({ draft });
    if (collected.error) {
      return { error: collected.error, tab: pageKind === 'multiple' ? 'products' : 'page', focus: productInput(collected.product, collected.field) };
    }
    let standIns = collected.standIns;
    if (!headline.trim() && pageKind === 'multiple') {
      if (!draft) return { error: 'Give the page a headline, like “Complete Starter Bundle”.', tab: 'page', focus: titleInput };
      headline = 'Your payment page';
      standIns = true;
    }
    const coverImageUrl = coverImageInput.value.trim();
    const coverVideoUrl = coverVideoInput.value.trim();
    if ((coverImageUrl && !isCoverUrl(coverImageUrl)) || (coverVideoUrl && !isCoverUrl(coverVideoUrl))) {
      return { error: 'The cover link needs to start with http:// or https://', tab: 'design' };
    }
    const payload = {
      title: headline,
      description: descInput.value,
      about: aboutInput.value,
      successMessage: successInput.value,
      marketplace: pageKind !== 'coffee' && marketplaceInput.checked,
      kind: pageKind,
      products: collected.products,
      accentColor: accent,
      showCover,
      coverType,
      coverImageUrl,
      coverVideoUrl,
      coverColor,
    };
    if (editingId !== null) payload.slug = slugInput.value;
    return { payload, standIns };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    const built = buildPayload();
    if (built.error) return showFormError(built.error, built.tab, built.focus);
    const { payload } = built;
    const savingId = editingId;
    try {
      if (savingId !== null) {
        const updated = await api(`/dashboard/payment-pages/${savingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        pages = pages.map((p) => (p.id === savingId ? updated : p));
      } else {
        const created = await api('/dashboard/payment-pages', { method: 'POST', body: JSON.stringify(payload) });
        pages.unshift(created);
      }
      resetBuilder();
      renderPages();
    } catch (err) {
      showFormError(err.message || 'Could not save that payment page. Please try again.');
    }
  });

  // --- pages list ------------------------------------------------------------------
  // A plain table — one row per page — with its numbers, the publish
  // switch, and a ⋯ menu for Edit / Analytics / Delete (plus the link).
  const pagesList = $('pagesList');
  const MENU_ICONS = {
    more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-9"/></svg>',
    open: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>',
  };
  function pageKindLabel(page) {
    if (page.kind === 'multiple') return `${page.products.length} product${page.products.length === 1 ? '' : 's'}`;
    const p = page.products[0];
    if (!p) return '';
    return p.type === 'coffee' ? 'Buy me a coffee' : (p.type === 'physical' ? 'Physical' : 'Digital');
  }
  function pageRowHTML(page) {
    const url = publicUrl(page);
    const visits = page.view_count || 0;
    return `
      <tr class="pb-trow${page.visible ? '' : ' pp-hidden'}${page.id === editingId ? ' pz-editing' : ''}" data-id="${page.id}">
        <td class="pb-cell-page">
          <button type="button" class="pb-row-title edit-page" data-id="${page.id}">${escapeHTML(page.title)}</button>
          <span class="pb-row-sub">${escapeHTML(pageKindLabel(page))} · /pay/${escapeHTML(page.slug)}${page.to_ship ? ` · <a class="pb-fulfil-pill" href="/dashboard/orders?ship=1">${page.to_ship} to ship</a>` : ''}</span>
        </td>
        <td class="pb-num" data-label="Visits">${visits}</td>
        <td class="pb-num" data-label="Sales">${page.paid_count || 0}</td>
        <td class="pb-num" data-label="Revenue">${formatINR(page.revenue || 0)}</td>
        <td data-label="Status">
          <span class="pb-status">
            <button type="button" class="pz-switch toggle-visible${page.visible ? ' on' : ''}" data-id="${page.id}"
              title="${page.visible ? 'Live — anyone with the link can buy' : 'Unpublished — the link shows a not-found page'}"
              aria-label="Published" aria-pressed="${page.visible ? 'true' : 'false'}"></button>
            <span>${page.visible ? 'Live' : 'Draft'}</span>
          </span>
        </td>
        <td class="pb-cell-actions">
          <div class="pb-menu-wrap">
            <button type="button" class="pb-more" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${escapeHTML(page.title)}">${MENU_ICONS.more}</button>
            <div class="pb-menu" role="menu" hidden>
              <button type="button" role="menuitem" class="edit-page" data-id="${page.id}">${MENU_ICONS.edit}Edit</button>
              <a role="menuitem" href="/dashboard/payment-pages/${page.id}/analytics">${MENU_ICONS.chart}Analytics</a>
              <a role="menuitem" href="${escapeHTML(url)}" target="_blank" rel="noopener">${MENU_ICONS.open}View page</a>
              <button type="button" role="menuitem" class="copy-link" data-url="${escapeHTML(url)}">${MENU_ICONS.copy}<span>Copy link</span></button>
              <div class="pb-menu-sep"></div>
              <button type="button" role="menuitem" class="pb-delete danger" data-id="${page.id}">${MENU_ICONS.trash}<span>Delete</span></button>
            </div>
          </div>
        </td>
      </tr>`;
  }

  function closeMenus(except) {
    pagesList.querySelectorAll('.pb-menu').forEach((menu) => {
      if (menu === except) return;
      menu.hidden = true;
      menu.previousElementSibling.setAttribute('aria-expanded', 'false');
      // An unanswered "Delete?" goes back to "Delete".
      const del = menu.querySelector('.pb-delete');
      del.classList.remove('is-confirming');
      del.querySelector('span').textContent = 'Delete';
    });
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.pb-menu-wrap')) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  function renderPages() {
    pagesList.innerHTML = pages.length ? `
      <table class="pb-table">
        <thead><tr><th>Page</th><th class="pb-num">Visits</th><th class="pb-num">Sales</th><th class="pb-num">Revenue</th><th>Status</th><th><span class="pb-sr">Actions</span></th></tr></thead>
        <tbody>${pages.map(pageRowHTML).join('')}</tbody>
      </table>` : '';
    $('emptyPages').hidden = pages.length > 0;
    $('pageCountLine').textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;

    pagesList.querySelectorAll('.pb-more').forEach((btn) => btn.addEventListener('click', () => {
      const menu = btn.nextElementSibling;
      const open = menu.hidden;
      closeMenus(menu);
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) menu.querySelector('[role="menuitem"]').focus();
    }));
    pagesList.querySelectorAll('.edit-page').forEach((btn) => btn.addEventListener('click', () => {
      closeMenus();
      startEdit(Number(btn.dataset.id));
    }));
    // Delete asks twice: the first click turns the item into "Click again
    // to delete", the second one deletes (closing the menu cancels).
    pagesList.querySelectorAll('.pb-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const label = btn.querySelector('span');
        if (!btn.classList.contains('is-confirming')) {
          btn.classList.add('is-confirming');
          label.textContent = 'Click again to delete';
          return;
        }
        const id = Number(btn.dataset.id);
        try {
          await api(`/dashboard/payment-pages/${id}`, { method: 'DELETE' });
          pages = pages.filter((p) => p.id !== id);
          // (Codes for just this page are deleted with it — lib/paymentPages.js.)
          if (editingId === id) resetBuilder();
          renderPages();
        } catch (err) { /* status shows the error */ }
      });
    });
    pagesList.querySelectorAll('.toggle-visible').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const page = pages.find((p) => p.id === id);
      if (!page) return;
      try {
        const updated = await api(`/dashboard/payment-pages/${id}`, { method: 'PATCH', body: JSON.stringify({ visible: !page.visible }) });
        pages = pages.map((p) => (p.id === id ? updated : p));
        renderPages();
      } catch (err) { /* status shows the error */ }
    }));
    pagesList.querySelectorAll('.copy-link').forEach((btn) => btn.addEventListener('click', async () => {
      const label = btn.querySelector('span');
      try {
        await navigator.clipboard.writeText(btn.dataset.url);
        label.textContent = 'Copied!';
      } catch (err) {
        label.textContent = 'Couldn’t copy — use View page';
      }
      setTimeout(() => { label.textContent = 'Copy link'; }, 1600);
    }));
  }

  loadIntoBuilder(null);
  renderPages();
  // "Edit page" on a page's Analytics links back here as #edit-<id>.
  const editHash = location.hash.match(/^#edit-(\d+)$/);
  if (editHash) {
    history.replaceState(null, '', location.pathname);
    startEdit(Number(editHash[1]));
  }
})();
