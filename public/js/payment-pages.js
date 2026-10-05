// Payment pages dashboard (views/payment-pages.ejs). Same pattern as
// lead-magnets.js: data starts from window.__PZ_PAYMENT_PAGES__ /
// __PZ_COUPONS__, every change is a fetch() to the JSON endpoints in
// server.js, and the builder doubles as the editor (a page's Edit button
// loads it back in).
//
// The builder holds a page's products as editable cards (Products tab).
// Amounts are typed in rupees and sent as paise; the server re-checks
// everything (lib/paymentPages.js), so the checks here are just for
// friendlier messages on the right tab.
(function () {
  let pages = window.__PZ_PAYMENT_PAGES__ || [];
  let coupons = window.__PZ_COUPONS__ || [];
  const storeUrl = window.__PZ_STORE_URL__ || '';
  const storeHost = storeUrl.replace(/^https?:\/\//, '');
  const DEFAULT_ACCENT = '#1261ef';
  const MAX_PRODUCTS = 10;

  const $ = (id) => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // The full description's small format → safe HTML, for the live
  // preview. A copy of renderRichText in lib/richText.js (which renders
  // the real page) — keep the two in step.
  function richInline(escaped) {
    return escaped
      .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)/g, '<a href="$2" target="_blank" rel="nofollow noopener">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  }
  function renderRichText(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n').slice(0, 5000).trim();
    if (!text) return '';
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(richInline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${richInline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    text.split('\n').forEach((rawLine) => {
      const line = escapeHTML(rawLine.trimEnd());
      const heading = line.match(/^#{2,3}\s+(.+)$/);
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      const numbered = line.match(/^\s*\d{1,3}[.)]\s+(.+)$/);
      if (!line.trim()) {
        flushPara();
        flushList();
      } else if (heading) {
        flushPara();
        flushList();
        out.push(`<h3>${richInline(heading[1])}</h3>`);
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || numbered)[1]);
      } else {
        flushList();
        para.push(line);
      }
    });
    flushPara();
    flushList();
    return out.join('');
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

  // Products while editing: amounts as the rupee text typed, plus what the
  // preview's pretend buyer has picked (previewQty / previewAmount).
  let products = [];
  let nextPid = 1;
  function blankProduct(seed) {
    return Object.assign({
      id: nextPid++, title: '', description: '', type: 'digital', pricing: 'fixed',
      price: '', compareAt: '', maxQty: '', suggested: '', minimum: '',
      fileUrl: '', stock: '', weight: '', shipFee: '',
      mediaType: '', mediaUrl: '',
      previewQty: 1, previewAmount: null,
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

  // What kind of page this is — picked at the top of the builder:
  //   'single'   — one digital or physical product
  //   'multiple' — up to MAX_PRODUCTS, any mix (a coffee can ride along)
  //   'coffee'   — just a buy-me-a-coffee button
  // It only shapes the builder; the server sees a plain product list.
  let pageKind = 'single';
  function kindOf(list) {
    if (list.length > 1) return 'multiple';
    return list[0] && list[0].type === 'coffee' ? 'coffee' : 'single';
  }
  const TYPE_LABELS = { digital: 'Digital', physical: 'Physical', coffee: 'Buy me a coffee' };
  function typesFor(kind) {
    if (kind === 'coffee') return [];
    return kind === 'single' ? ['digital', 'physical'] : ['digital', 'physical', 'coffee'];
  }
  // Whether a card has anything typed in it worth asking before throwing away.
  const hasContent = (p) => !!(p.title.trim() || p.description.trim() || p.price || p.suggested || p.fileUrl || p.mediaUrl);

  function setKind(kind) {
    if (kind === pageKind) return;
    if (kind === 'coffee') {
      const keep = products.find((p) => p.type === 'coffee');
      const dropping = products.filter((p) => p !== keep && hasContent(p));
      if (dropping.length && !window.confirm(`Switching to Buy me a coffee removes the ${dropping.length === 1 ? 'product' : `${dropping.length} products`} you’ve added. Continue?`)) return;
      products = [keep || blankProduct({ type: 'coffee', pricing: 'qty' })];
    } else if (kind === 'single') {
      const keep = products.find((p) => p.type !== 'coffee');
      const dropping = products.filter((p) => p !== keep && hasContent(p));
      if (dropping.length && !window.confirm(`A single-product page keeps only ${keep && keep.title.trim() ? `“${keep.title.trim()}”` : 'the first product'}. Remove the other${dropping.length === 1 ? '' : 's'}?`)) return;
      products = [keep || blankProduct()];
    } else if (products.length === 1 && products[0].type === 'coffee' && !hasContent(products[0])) {
      products = [blankProduct()];
    }
    pageKind = kind;
    renderKind();
    renderProducts();
  }
  function renderKind() {
    document.querySelectorAll('#ppKind .pb-kind-opt').forEach((btn) => {
      const on = btn.dataset.kind === pageKind;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#ppKind .pb-kind-opt').forEach((btn) => btn.addEventListener('click', () => setKind(btn.dataset.kind)));

  function prodCardHTML(p, index) {
    const types = typesFor(pageKind);
    const typeToggle = types.length ? `
      <div class="pb-toggle pb-type-toggle" role="group" aria-label="Product type">
        ${types.map((t) => `<button type="button" class="${p.type === t ? 'active' : ''}" data-settype="${t}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[t]}</svg>${TYPE_LABELS[t]}</button>`).join('')}
      </div>` : '';
    const multiple = pageKind === 'multiple';
    const head = `
      <div class="pb-prod-head">
        ${multiple ? `<span class="pb-prod-index">${index + 1}</span>` : ''}
        <input type="text" class="pz-field-input" data-field="title" maxlength="120" placeholder="${p.type === 'coffee' ? 'Buy me a coffee' : 'Product title'}" value="${escapeHTML(p.title)}" aria-label="Product ${index + 1} title" />
        ${multiple ? `<button type="button" class="pb-prod-remove" data-remove aria-label="Remove product ${index + 1}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>` : ''}
      </div>
      <textarea class="pz-field-input pb-prod-desc" data-field="description" rows="2" maxlength="300" placeholder="Short description (optional) — shown with this product on the page" aria-label="Product ${index + 1} description">${escapeHTML(p.description)}</textarea>
      ${mediaFieldHTML(p)}`;

    if (p.type === 'coffee') {
      return `
        <div class="pb-prod-card" data-pid="${p.id}">
          ${head}
          ${typeToggle}
          <div class="pb-prod-body">
            <div class="pb-row">${moneyInput('price', p.price, 'Price per coffee — e.g. 50')}</div>
            <div class="pb-coffee-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <span>A quick-support button — buyers pick how many coffees (×1, ×3, ×5) or type their own number. No file or shipping needed.</span>
            </div>
          </div>
        </div>`;
    }

    return `
      <div class="pb-prod-card" data-pid="${p.id}">
        ${head}
        ${typeToggle}
        <div class="pb-toggle pb-pricing-toggle" role="group" aria-label="Pricing">
          <button type="button" class="${p.pricing === 'fixed' ? 'active' : ''}" data-setpricing="fixed">Fixed price</button>
          <button type="button" class="${p.pricing === 'qty' ? 'active' : ''}" data-setpricing="qty">Per quantity</button>
          <button type="button" class="${p.pricing === 'pwyw' ? 'active' : ''}" data-setpricing="pwyw">Pay what you want</button>
        </div>
        <div class="pb-prod-body">
          ${pricingPanelHTML(p)}
          ${p.type === 'digital' ? `
          <div class="pb-fulfil">
            <input type="url" class="pz-field-input" data-field="fileUrl" maxlength="500" placeholder="Link to the file — unlocked on the receipt once paid" value="${escapeHTML(p.fileUrl)}" />
          </div>` : `
          <div class="pb-fulfil">
            <div class="pb-row">
              <input type="text" inputmode="numeric" class="pz-field-input" data-field="stock" placeholder="Stock qty (blank = unlimited)" value="${escapeHTML(p.stock)}" />
              <input type="text" inputmode="numeric" class="pz-field-input" data-field="weight" placeholder="Weight (g)" value="${escapeHTML(p.weight)}" />
            </div>
            ${moneyInput('shipFee', p.shipFee, 'Shipping fee (blank = free)')}
          </div>`}
        </div>
      </div>`;
  }

  function renderProducts() {
    prodList.innerHTML = products.map(prodCardHTML).join('');
    $('tabProductCount').textContent = products.length;
    addProductBtn.hidden = pageKind !== 'multiple';
    addProductBtn.disabled = products.length >= MAX_PRODUCTS;
    prodList.querySelectorAll('.pb-prod-card').forEach((card) => {
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
  // What a product line costs right now, given its pricing and what the
  // pretend buyer has chosen in the preview. Paise.
  function lineAmount(p) {
    if (p.pricing === 'pwyw') {
      return p.previewAmount !== null ? p.previewAmount : (toPaise(p.suggested) || toPaise(p.minimum) || 0);
    }
    const qty = p.pricing === 'qty' ? (p.previewQty || 1) : 1;
    return (toPaise(p.price) || 0) * qty;
  }
  function typeLabel(p) {
    if (p.type === 'coffee') return 'Support';
    return p.type === 'digital' ? 'Instant download' : 'Ships to you';
  }
  function previewControlHTML(p) {
    if (p.type === 'coffee') {
      return `<div class="pb-preview-coffee" data-coffee-for="${p.id}">
        ${[1, 3, 5].map((n) => `<button type="button" class="${p.previewQty === n ? 'active' : ''}" data-qty="${n}">×${n}</button>`).join('')}
      </div>`;
    }
    if (p.pricing === 'qty') {
      return `<div class="pb-preview-stepper" data-qty-for="${p.id}">
        <button type="button" data-qty-dec aria-label="Fewer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
        <span>${p.previewQty || 1}</span>
        <button type="button" data-qty-inc aria-label="More"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5v14"/></svg></button>
      </div>`;
    }
    if (p.pricing === 'pwyw') {
      const value = p.previewAmount !== null ? rupeesText(p.previewAmount) : (p.suggested || '');
      const min = toPaise(p.minimum);
      return `<div class="pb-preview-pwyw"><span>₹</span><input type="text" inputmode="decimal" data-pwyw-for="${p.id}" value="${escapeHTML(value)}" placeholder="0" aria-label="Amount" /></div>
        ${min ? `<div class="pb-preview-pwyw-hint">Minimum ${formatINR(min)}</div>` : ''}`;
    }
    return '';
  }

  // The product's own image as its thumbnail; a play badge for a video.
  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  function previewThumbHTML(p) {
    const url = p.mediaUrl.trim();
    if (p.mediaType === 'image' && isCoverUrl(url)) {
      return `<div class="pb-preview-thumb has-image"><img src="${escapeHTML(url)}" alt="" /></div>`;
    }
    if (p.mediaType === 'video' && isCoverUrl(url)) return `<div class="pb-preview-thumb is-video">${PLAY_ICON}</div>`;
    return `<div class="pb-preview-thumb ${p.type}">${icon(p.type)}</div>`;
  }

  function syncPreview() {
    const headline = titleInput.value.trim()
      || (products.length === 1 && products[0].title.trim())
      || 'Your payment page';
    $('ppPreviewTitle').textContent = headline;
    const desc = descInput.value.trim();
    $('ppPreviewDesc').textContent = desc;
    $('ppPreviewDesc').hidden = !desc;
    const aboutHtml = renderRichText(aboutInput.value);
    $('ppPreviewAboutBody').innerHTML = aboutHtml;
    $('ppPreviewAbout').hidden = !aboutHtml;

    const items = $('ppPreviewItems');
    items.innerHTML = products.map((p) => {
      const compare = p.pricing === 'fixed' && toPaise(p.compareAt) > toPaise(p.price) ? `<s>${formatINR(toPaise(p.compareAt))}</s>` : '';
      return `
        <div class="pb-preview-item" data-preview-pid="${p.id}">
          ${previewThumbHTML(p)}
          <div class="pb-preview-main">
            <div class="pb-preview-title">${escapeHTML(p.title.trim() || (p.type === 'coffee' ? 'Buy me a coffee' : 'Untitled product'))}</div>
            <div class="pb-preview-type">${typeLabel(p)}${p.pricing === 'pwyw' ? ' · name your price' : ''}</div>
            ${p.description.trim() ? `<div class="pb-preview-pdesc">${escapeHTML(p.description.trim())}</div>` : ''}
            ${previewControlHTML(p)}
          </div>
          <div class="pb-preview-price">${compare}<b>${formatINR(lineAmount(p))}</b></div>
        </div>`;
    }).join('') || '<div class="pb-preview-empty">Add a product to see it here.</div>';

    items.querySelectorAll('[data-qty-for]').forEach((el) => {
      const p = products.find((x) => x.id === Number(el.dataset.qtyFor));
      el.querySelector('[data-qty-dec]').addEventListener('click', () => {
        p.previewQty = Math.max(1, (p.previewQty || 1) - 1);
        syncPreview();
      });
      el.querySelector('[data-qty-inc]').addEventListener('click', () => {
        const max = toCount(p.maxQty) || 100;
        p.previewQty = Math.min(max, (p.previewQty || 1) + 1);
        syncPreview();
      });
    });
    items.querySelectorAll('[data-pwyw-for]').forEach((input) => {
      const p = products.find((x) => x.id === Number(input.dataset.pwywFor));
      input.addEventListener('input', () => {
        const v = toPaise(input.value);
        p.previewAmount = Number.isNaN(v) ? null : v;
        // Totals only — re-rendering the list would blur this input.
        updateTotals();
      });
    });
    items.querySelectorAll('[data-coffee-for]').forEach((row) => {
      const p = products.find((x) => x.id === Number(row.dataset.coffeeFor));
      row.querySelectorAll('[data-qty]').forEach((btn) => btn.addEventListener('click', () => {
        p.previewQty = Number(btn.dataset.qty);
        syncPreview();
      }));
    });

    const editing = pages.find((pg) => pg.id === editingId);
    const slug = editing ? (slugInput.value.trim() || editing.slug)
      : (headline === 'Your payment page' ? '…' : headline.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40));
    $('ppPreviewUrl').textContent = `${storeHost}/pay/${slug || '…'}`;

    updateTotals();
  }

  function updateTotals() {
    const subtotal = products.reduce((sum, p) => sum + lineAmount(p), 0);
    const physical = products.filter((p) => p.type === 'physical');
    const shipping = physical.reduce((sum, p) => sum + (toPaise(p.shipFee) || 0), 0);
    $('ppPreviewShip').hidden = !physical.length;
    $('ppPreviewShipRow').hidden = !physical.length;
    $('ppPreviewSubtotal').textContent = formatINR(subtotal);
    $('ppPreviewShipAmt').textContent = shipping ? formatINR(shipping) : 'Free';
    $('ppPreviewTotal').textContent = formatINR(subtotal + shipping);
    $('ppPreviewBtnText').textContent = `Pay ${formatINR(subtotal + shipping)}`;
    // Each row's price follows live stepper / amount edits too.
    products.forEach((p) => {
      const row = document.querySelector(`[data-preview-pid="${p.id}"] .pb-preview-price b`);
      if (row) row.textContent = formatINR(lineAmount(p));
    });
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
    previewFrame.style.setProperty('--pv-accent', accent);
    previewFrame.style.setProperty('--pv-accent-dark', shadeHex(accent, -60));
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

    // The preview's header stands in for the cover.
    const top = $('ppPreviewTop');
    const image = coverImageInput.value.trim();
    const video = coverVideoInput.value.trim();
    const shown = !showCover ? 'none'
      : (coverType === 'image' && !isCoverUrl(image)) || (coverType === 'video' && !isCoverUrl(video)) ? 'art' : coverType;
    top.classList.toggle('is-off', shown === 'none');
    top.classList.toggle('is-color', shown === 'color');
    top.classList.toggle('is-media', shown === 'image' || shown === 'video');
    if (coverColor) top.style.setProperty('--pv-cover-color', coverColor);
    else top.style.removeProperty('--pv-cover-color');
    const img = $('ppPreviewCoverImage');
    img.hidden = shown !== 'image';
    if (shown === 'image' && img.getAttribute('src') !== image) img.src = image;
    const vid = $('ppPreviewCoverVideo');
    vid.hidden = shown !== 'video';
    if (shown === 'video') {
      if (vid.getAttribute('src') !== video) vid.src = video;
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
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
    $('builderHeading').textContent = editing ? 'Edit payment page' : 'Create a payment page';
    $('builderSubmitLabel').textContent = editing ? 'Save changes' : 'Create payment page';
    $('builderSubmitIcon').style.display = editing ? 'none' : '';
    $('builderCancelBtn').hidden = !editing;
    $('ppSlugRow').hidden = !editing;
  }

  function loadIntoBuilder(page) {
    titleInput.value = page ? page.title : '';
    descInput.value = page ? page.description : '';
    aboutInput.value = page ? page.about || '' : '';
    successInput.value = page ? page.success_message : '';
    slugInput.value = page ? page.slug : '';
    nextPid = 1;
    products = page && page.products.length ? page.products.map(fromStored) : [blankProduct()];
    nextPid = Math.max(...products.map((p) => p.id)) + 1;
    pageKind = kindOf(products);
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

  function startEdit(id) {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    editingId = id;
    loadIntoBuilder(page);
    renderPages();
    document.querySelector('.pb-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    titleInput.focus({ preventScroll: true });
  }
  function resetBuilder() {
    const wasEditing = editingId !== null;
    editingId = null;
    loadIntoBuilder(null);
    if (wasEditing) renderPages();
  }
  $('builderCancelBtn').addEventListener('click', resetBuilder);

  function showFormError(message, tab, focusEl) {
    if (tab) showTab(tab);
    formError.textContent = message;
    formError.classList.add('show');
    if (focusEl) focusEl.focus();
  }
  // The input for one of a product card's fields, for focusing on an error.
  const productInput = (p, field) => prodList.querySelector(`.pb-prod-card[data-pid="${p.id}"] [data-field="${field}"]`);

  // Builder cards → what the server stores (paise), or an error to show.
  function collectProducts() {
    const out = [];
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      const name = `product ${i + 1}`;
      const bad = (message, field) => ({ error: message, product: p, field });
      const title = p.title.trim();
      if (!title && p.type !== 'coffee') return bad(`Give ${name} a title.`, 'title');
      const item = { id: p.id, title: title || 'Buy me a coffee', type: p.type, pricing: p.type === 'coffee' ? 'qty' : p.pricing };
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
        const price = toPaise(p.price);
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
    return { products: out };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    const collected = collectProducts();
    if (collected.error) {
      showTab('products');
      return showFormError(collected.error, 'products', productInput(collected.product, collected.field));
    }
    if (!titleInput.value.trim() && collected.products.length > 1) {
      return showFormError('Give the page a headline, like “Complete Starter Bundle”.', 'page', titleInput);
    }
    const coverImageUrl = coverImageInput.value.trim();
    const coverVideoUrl = coverVideoInput.value.trim();
    if ((coverImageUrl && !isCoverUrl(coverImageUrl)) || (coverVideoUrl && !isCoverUrl(coverVideoUrl))) {
      return showFormError('The cover link needs to start with http:// or https://', 'design');
    }

    const payload = {
      title: titleInput.value,
      description: descInput.value,
      about: aboutInput.value,
      successMessage: successInput.value,
      products: collected.products,
      accentColor: accent,
      showCover,
      coverType,
      coverImageUrl,
      coverVideoUrl,
      coverColor,
    };
    const savingId = editingId;
    if (savingId !== null) payload.slug = slugInput.value;
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
      // Coupon rows and the "applies to" picker show page titles.
      renderCouponPageOptions();
      renderCoupons();
    } catch (err) {
      showFormError(err.message || 'Could not save that payment page. Please try again.');
    }
  });

  // --- pages list ------------------------------------------------------------------
  const pagesList = $('pagesList');
  function pageRowHTML(page) {
    const url = publicUrl(page);
    const count = page.products.length;
    const visits = page.view_count || 0;
    return `
      <div class="pb-page-row${page.visible ? '' : ' pp-hidden'}${page.id === editingId ? ' pz-editing' : ''}" data-id="${page.id}">
        <div class="pb-page-row-top">
          <span class="pb-page-row-title">${escapeHTML(page.title)}</span>
          ${page.visible ? '' : '<span class="pb-chip off">Unpublished</span>'}
          <span class="pb-chip">${count} ${count === 1 ? 'product' : 'products'}</span>
        </div>
        <div class="pb-page-items">
          ${page.products.map((p) => `<span class="pb-item-pill"><span class="dot ${p.type}"></span>${escapeHTML(p.title)} <b>${escapeHTML(productPriceLabel(p))}</b></span>`).join('')}
        </div>
        <div class="pb-page-stats">
          <span><strong>${visits}</strong> ${visits === 1 ? 'visit' : 'visits'}</span>
          <span><strong>${page.paid_count || 0}</strong> paid</span>
          <span><strong>${formatINR(page.revenue || 0)}</strong> revenue</span>
          ${page.to_ship ? `<a class="pb-fulfil-pill" href="/dashboard/orders?ship=1">${page.to_ship} to ship</a>` : ''}
        </div>
        <div class="pb-page-bottom">
          <div class="pz-copy-link">
            <input type="text" readonly value="${escapeHTML(url.replace(/^https?:\/\//, ''))}" onclick="this.select()" aria-label="Page link" />
            <button type="button" class="pz-copy-btn copy-link" data-url="${escapeHTML(url)}">Copy link</button>
            <a class="pz-copy-btn" href="${escapeHTML(url)}" target="_blank" rel="noopener">Open</a>
          </div>
          <div class="pb-page-actions">
            <button type="button" class="pz-switch toggle-visible${page.visible ? ' on' : ''}" data-id="${page.id}"
              title="${page.visible ? 'Live — anyone with the link can buy' : 'Unpublished — the link shows a not-found page'}"
              aria-label="Published" aria-pressed="${page.visible ? 'true' : 'false'}"></button>
            <button type="button" class="pz-card-btn edit-page" data-id="${page.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              Edit
            </button>
            <button type="button" class="pz-card-btn pb-delete" data-id="${page.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>`;
  }

  function renderPages() {
    pagesList.innerHTML = pages.map(pageRowHTML).join('');
    $('emptyPages').hidden = pages.length > 0;
    $('pageCountLine').textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;

    pagesList.querySelectorAll('.edit-page').forEach((btn) => btn.addEventListener('click', () => startEdit(Number(btn.dataset.id))));
    // Delete asks twice: the first click turns the button into "Delete?"
    // for a few seconds, the second one deletes.
    pagesList.querySelectorAll('.pb-delete').forEach((btn) => {
      let timer = null;
      btn.addEventListener('click', async () => {
        const label = btn.querySelector('span');
        if (!btn.classList.contains('is-confirming')) {
          btn.classList.add('is-confirming');
          label.textContent = 'Delete?';
          timer = setTimeout(() => {
            btn.classList.remove('is-confirming');
            label.textContent = 'Delete';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        const id = Number(btn.dataset.id);
        try {
          await api(`/dashboard/payment-pages/${id}`, { method: 'DELETE' });
          pages = pages.filter((p) => p.id !== id);
          // Codes for just this page are deleted with it (lib/paymentPages.js).
          coupons = coupons.filter((c) => c.page_id !== id);
          if (editingId === id) resetBuilder();
          renderPages();
          renderCouponPageOptions();
          renderCoupons();
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
      try {
        await navigator.clipboard.writeText(btn.dataset.url);
        btn.textContent = 'Copied';
      } catch (err) {
        btn.previousElementSibling.select();
        btn.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { btn.textContent = 'Copy link'; }, 1600);
    }));
  }

  // --- coupons -------------------------------------------------------------------
  const couponForm = $('couponForm');
  const couponError = $('couponFormError');
  const couponPageSelect = $('couponPage');

  function renderCouponPageOptions() {
    const current = couponPageSelect.value;
    couponPageSelect.innerHTML = '<option value="">All payment pages</option>'
      + pages.map((p) => `<option value="${p.id}">${escapeHTML(p.title)}</option>`).join('');
    couponPageSelect.value = pages.some((p) => String(p.id) === current) ? current : '';
  }

  function couponRowHTML(c) {
    const page = c.page_id ? pages.find((p) => p.id === c.page_id) : null;
    const off = c.discount_type === 'percent' ? `${c.discount_value}% off` : `${formatINR(c.discount_value)} off`;
    const uses = c.max_uses ? `${c.used_count} / ${c.max_uses} used` : `${c.used_count} used`;
    const expired = c.expires_at && new Date(`${c.expires_at}T23:59:59`) < new Date();
    const expiry = c.expires_at
      ? `${expired ? 'Expired' : 'Until'} ${new Date(`${c.expires_at}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'No expiry';
    return `
      <div class="pp-coupon-row${c.active ? '' : ' pp-off'}" data-id="${c.id}">
        <span class="pp-coupon-code">${escapeHTML(c.code)}</span>
        <span class="pp-coupon-info">
          <strong>${escapeHTML(off)}</strong>
          <span>${page ? escapeHTML(page.title) : 'All pages'}</span>
          <span>${escapeHTML(uses)}</span>
          <span>${escapeHTML(expiry)}</span>
        </span>
        <button type="button" class="pz-switch toggle-coupon${c.active ? ' on' : ''}" data-id="${c.id}" aria-label="Code active" aria-pressed="${c.active ? 'true' : 'false'}" title="${c.active ? 'Active' : 'Switched off'}"></button>
        <button type="button" class="pz-card-btn danger remove-coupon" data-id="${c.id}" aria-label="Delete code ${escapeHTML(c.code)}">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>`;
  }

  function renderCoupons() {
    const list = $('couponsList');
    list.innerHTML = coupons.map(couponRowHTML).join('');
    $('emptyCoupons').hidden = coupons.length > 0;
    list.querySelectorAll('.toggle-coupon').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const coupon = coupons.find((c) => c.id === id);
      if (!coupon) return;
      const active = !coupon.active;
      try {
        await api(`/dashboard/coupons/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
        coupon.active = active ? 1 : 0;
        renderCoupons();
      } catch (err) { /* status shows the error */ }
    }));
    list.querySelectorAll('.remove-coupon').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      try {
        await api(`/dashboard/coupons/${id}`, { method: 'DELETE' });
        coupons = coupons.filter((c) => c.id !== id);
        renderCoupons();
      } catch (err) { /* status shows the error */ }
    }));
  }

  couponForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    couponError.classList.remove('show');
    const fail = (message) => {
      couponError.textContent = message;
      couponError.classList.add('show');
    };
    const type = $('couponType').value;
    const rawValue = $('couponValue').value.trim();
    let discountValue;
    if (type === 'percent') {
      discountValue = Number(rawValue);
      if (!Number.isInteger(discountValue) || discountValue < 1 || discountValue > 100) return fail('A percentage discount needs to be a whole number from 1 to 100.');
    } else {
      discountValue = toPaise(rawValue);
      if (!(discountValue >= 100)) return fail('A flat discount needs to be at least ₹1.');
    }
    try {
      const created = await api('/dashboard/coupons', {
        method: 'POST',
        body: JSON.stringify({
          code: $('couponCode').value,
          discountType: type,
          discountValue,
          pageId: couponPageSelect.value || null,
          maxUses: $('couponMaxUses').value || null,
          expiresAt: $('couponExpires').value || null,
        }),
      });
      coupons.unshift(created);
      couponForm.reset();
      renderCoupons();
      $('couponCode').focus();
    } catch (err) {
      fail(err.message || 'Could not add that code. Please try again.');
    }
  });

  loadIntoBuilder(null);
  renderPages();
  renderCouponPageOptions();
  renderCoupons();
})();
