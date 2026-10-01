// Payment pages dashboard (views/payment-pages.ejs). Same pattern as
// lead-magnets.js: data starts from window.__PZ_PAYMENT_PAGES__ /
// __PZ_COUPONS__, every change is a fetch() to the JSON endpoints in
// server.js, and the builder doubles as the editor (a card's Edit button
// loads that page into it).
//
// Prices are typed in rupees and sent as paise; the server re-checks
// everything (lib/paymentPages.js), so the checks here are just for
// friendlier messages.
(function () {
  let pages = window.__PZ_PAYMENT_PAGES__ || [];
  let coupons = window.__PZ_COUPONS__ || [];
  const storeUrl = window.__PZ_STORE_URL__ || '';
  const storeHost = storeUrl.replace(/^https?:\/\//, '');
  const DEFAULT_ACCENT = '#1261ef';

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
  // "499" / "1,499.50" → paise, or null if it isn't an amount.
  function toPaise(raw) {
    const value = String(raw ?? '').replace(/[₹,\s]/g, '');
    if (value === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return NaN;
    return Math.round(Number(value) * 100);
  }
  function toRupeesText(paise) {
    if (!paise) return '';
    return String(paise / 100);
  }
  function publicUrl(page) {
    return `${storeUrl}/pay/${page.slug}`;
  }
  function priceLabel(page) {
    if (page.price_type === 'flexible') {
      return page.min_price ? `Pay what you want · min ${formatINR(page.min_price)}` : 'Pay what you want';
    }
    return formatINR(page.price);
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

  // --- builder: tabs -------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll('.pz-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.btab === name));
    document.querySelectorAll('.pz-btabpanel').forEach((p) => p.classList.toggle('active', p.id === `btab-${name}`));
  }
  document.querySelectorAll('.pz-tab-btn').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.btab)));

  // --- builder: state --------------------------------------------------------
  const form = $('pageForm');
  const formError = $('pageFormError');
  const titleInput = $('ppTitle');
  const ctaInput = $('ppCta');
  const descInput = $('ppDescription');
  const deliveryInput = $('ppDeliveryUrl');
  const successInput = $('ppSuccessMessage');
  const slugRow = $('ppSlugRow');
  const slugInput = $('ppSlug');
  const priceInput = $('ppPrice');
  const minInput = $('ppMinPrice');
  const suggestedInput = $('ppSuggestedPrice');
  const maxQtyInput = $('ppMaxQuantity');
  const qtySwitch = $('ppAllowQuantity');
  const phoneSwitch = $('ppCollectPhone');
  const coverImageInput = $('ppCoverImage');
  const coverVideoInput = $('ppCoverVideo');
  const coverColorInput = $('ppCoverColor');
  const coverError = $('ppCoverError');
  const previewFrame = $('ppPreviewFrame');

  let editingId = null;
  let priceType = 'fixed';
  let accent = DEFAULT_ACCENT;
  let showCover = true;
  let coverType = 'art';
  let coverColor = '';

  function setSwitch(btn, on) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const switchOn = (btn) => btn.classList.contains('on');
  [qtySwitch, phoneSwitch].forEach((btn) => btn.addEventListener('click', () => {
    setSwitch(btn, !switchOn(btn));
    syncPreview();
  }));

  function setPriceType(type) {
    priceType = type === 'flexible' ? 'flexible' : 'fixed';
    document.querySelectorAll('#ppPriceTypeChoice .cover-opt').forEach((b) => b.classList.toggle('active', b.dataset.priceType === priceType));
    $('ppFixedRow').hidden = priceType !== 'fixed';
    $('ppFlexibleRow').hidden = priceType !== 'flexible';
    $('ppPriceHint').textContent = priceType === 'fixed'
      ? 'Buyers pay exactly this.'
      : 'Buyers type their own amount — at least the minimum. The suggested amount is pre-filled for them.';
    syncPreview();
  }
  document.querySelectorAll('#ppPriceTypeChoice .cover-opt').forEach((b) => b.addEventListener('click', () => setPriceType(b.dataset.priceType)));

  // --- builder: accent + cover (same controls as the lead magnet builder) ---
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

    const cover = $('ppPreviewCover');
    const image = coverImageInput.value.trim();
    const video = coverVideoInput.value.trim();
    const shown = (coverType === 'image' && !isCoverUrl(image)) || (coverType === 'video' && !isCoverUrl(video)) ? 'art' : coverType;
    cover.classList.toggle('is-off', !showCover);
    cover.classList.toggle('is-plain', shown === 'image' || shown === 'video');
    cover.classList.toggle('is-color', shown === 'color');
    if (coverColor) cover.style.setProperty('--pv-cover-color', coverColor);
    else cover.style.removeProperty('--pv-cover-color');
    $('ppPreviewCoverArt').style.display = shown === 'art' ? '' : 'none';
    const img = $('ppPreviewCoverImage');
    img.style.display = shown === 'image' ? '' : 'none';
    if (shown === 'image' && img.getAttribute('src') !== image) img.src = image;
    const vid = $('ppPreviewCoverVideo');
    vid.style.display = shown === 'video' ? '' : 'none';
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
  document.querySelectorAll('#btab-design .pz-cover-media .pz-cover-clear').forEach((btn) => btn.addEventListener('click', () => {
    (btn.dataset.clear === 'video' ? coverVideoInput : coverImageInput).value = '';
    syncCover();
  }));

  // Uploads: same endpoint as the lead magnet builder (lib/uploads.js).
  const UPLOAD_LIMITS = { image: 5, video: 30 };
  function wireUpload(fileInput, urlInput, kind) {
    const button = fileInput.closest('.pz-upload-btn');
    const label = button.querySelector('span');
    const idle = label.textContent;
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const fail = (message) => {
        coverError.textContent = message;
        coverError.classList.add('show');
      };
      coverError.classList.remove('show');
      if (!file.type.startsWith(`${kind}/`)) return fail(kind === 'video' ? 'Choose an MP4 or WebM video.' : 'Choose a JPG, PNG, WebP or GIF image.');
      if (file.size > UPLOAD_LIMITS[kind] * 1024 * 1024) return fail(`That file is too big — keep ${kind}s under ${UPLOAD_LIMITS[kind]} MB.`);
      button.classList.add('is-busy');
      label.textContent = 'Uploading…';
      try {
        const { url } = await api('/dashboard/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        urlInput.value = url;
        syncCover();
      } catch (err) {
        fail(err.message || 'Could not upload that file. Please try again.');
      } finally {
        button.classList.remove('is-busy');
        label.textContent = idle;
      }
    });
  }
  wireUpload($('ppCoverImageFile'), coverImageInput, 'image');
  wireUpload($('ppCoverVideoFile'), coverVideoInput, 'video');

  // --- builder: live preview ---------------------------------------------
  function syncPreview() {
    const title = titleInput.value.trim();
    $('ppPreviewTitle').textContent = title || 'Your payment page title';
    const desc = descInput.value.trim();
    $('ppPreviewDesc').textContent = desc;
    $('ppPreviewDesc').hidden = !desc;

    const flexible = priceType === 'flexible';
    const price = toPaise(priceInput.value) || 0;
    const min = toPaise(minInput.value) || 0;
    const suggested = toPaise(suggestedInput.value) || 0;
    const unit = flexible ? (suggested || min) : price;
    $('ppPreviewPriceLabel').textContent = flexible
      ? (min ? `Pay what you want · min ${formatINR(min)}` : 'Pay what you want')
      : formatINR(price);
    $('ppPreviewAmount').hidden = !flexible;
    $('ppPreviewAmountValue').textContent = toRupeesText(unit) || '0';
    $('ppPreviewQty').hidden = !switchOn(qtySwitch);
    $('ppMaxQtyRow').hidden = !switchOn(qtySwitch);
    $('ppPreviewPhone').hidden = !switchOn(phoneSwitch);
    $('ppPreviewTotal').textContent = formatINR(unit);
    $('ppPreviewCta').textContent = `${ctaInput.value.trim() || 'Pay now'} · ${formatINR(unit)}`;

    const editing = pages.find((p) => p.id === editingId);
    const slug = editing ? (slugInput.value.trim() || editing.slug)
      : (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '…');
    $('ppPreviewUrl').textContent = `${storeHost}/pay/${slug}`;
  }
  [titleInput, ctaInput, descInput, priceInput, minInput, suggestedInput, slugInput].forEach((el) => el.addEventListener('input', syncPreview));

  // --- builder: create / edit ----------------------------------------------
  function setBuilderMode() {
    const editing = editingId !== null;
    $('builderHeading').textContent = editing ? 'Edit payment page' : 'Create a payment page';
    $('builderSubmitLabel').textContent = editing ? 'Save changes' : 'Create payment page';
    $('builderSubmitIcon').style.display = editing ? 'none' : '';
    $('builderCancelBtn').hidden = !editing;
    slugRow.hidden = !editing;
  }

  function loadIntoBuilder(page) {
    titleInput.value = page ? page.title : '';
    ctaInput.value = page && page.cta_text !== 'Pay now' ? page.cta_text : '';
    descInput.value = page ? page.description : '';
    deliveryInput.value = page ? page.delivery_url : '';
    successInput.value = page ? page.success_message : '';
    slugInput.value = page ? page.slug : '';
    priceInput.value = page ? toRupeesText(page.price) : '';
    minInput.value = page ? toRupeesText(page.min_price) : '';
    suggestedInput.value = page ? toRupeesText(page.suggested_price) : '';
    maxQtyInput.value = page ? page.max_quantity : 10;
    setSwitch(qtySwitch, !!(page && page.allow_quantity));
    setSwitch(phoneSwitch, page ? !!page.collect_phone : true);
    showCover = page ? !!page.show_cover : true;
    coverType = page && ['art', 'image', 'video', 'color'].includes(page.cover_type) ? page.cover_type : 'art';
    coverColor = page ? page.cover_color || '' : '';
    coverImageInput.value = page ? page.cover_image_url : '';
    coverVideoInput.value = page ? page.cover_video_url : '';
    coverError.classList.remove('show');
    formError.classList.remove('show');
    setPriceType(page ? page.price_type : 'fixed');
    setAccent(page ? page.accent_color : DEFAULT_ACCENT);
    setBuilderMode();
    syncPreview();
    showTab('content');
  }

  function startEdit(id) {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    editingId = id;
    loadIntoBuilder(page);
    renderPages();
    document.querySelector('.pz-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
    titleInput.focus({ preventScroll: true });
  }
  function resetBuilder() {
    const wasEditing = editingId !== null;
    editingId = null;
    loadIntoBuilder(null);
    if (wasEditing) renderPages();
  }
  $('builderCancelBtn').addEventListener('click', resetBuilder);

  function showFormError(message, tab, input) {
    if (tab) showTab(tab);
    formError.textContent = message;
    formError.classList.add('show');
    if (input) input.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    // Fields live on tabs that may be hidden — the form is novalidate and
    // checked here so the message can switch to the right tab.
    if (!titleInput.value.trim()) return showFormError('Give it a title, like “1:1 coaching session”.', 'content', titleInput);
    const delivery = deliveryInput.value.trim();
    if (delivery && !/^https?:\/\//i.test(delivery)) return showFormError('The delivery link needs to start with http:// or https://', 'content', deliveryInput);

    const price = toPaise(priceInput.value);
    const min = toPaise(minInput.value);
    const suggested = toPaise(suggestedInput.value);
    if (priceType === 'fixed' && !(price >= 100)) return showFormError('Set a price of at least ₹1 — or switch to “Pay what you want”.', 'pricing', priceInput);
    if (priceType === 'flexible') {
      if (Number.isNaN(min)) return showFormError('That minimum doesn’t look like an amount.', 'pricing', minInput);
      if (Number.isNaN(suggested)) return showFormError('That suggested amount doesn’t look like an amount.', 'pricing', suggestedInput);
      if (suggested && suggested < (min || 0)) return showFormError('The suggested amount can’t be below the minimum.', 'pricing', suggestedInput);
    }
    const maxQty = Number(maxQtyInput.value);
    if (switchOn(qtySwitch) && !(Number.isInteger(maxQty) && maxQty >= 1 && maxQty <= 100)) {
      return showFormError('Max per order needs to be between 1 and 100.', 'pricing', maxQtyInput);
    }
    const coverImageUrl = coverImageInput.value.trim();
    const coverVideoUrl = coverVideoInput.value.trim();
    if ((coverImageUrl && !isCoverUrl(coverImageUrl)) || (coverVideoUrl && !isCoverUrl(coverVideoUrl))) {
      return showFormError('The cover link needs to start with http:// or https://', 'design');
    }

    const payload = {
      title: titleInput.value,
      ctaText: ctaInput.value,
      description: descInput.value,
      deliveryUrl: delivery,
      successMessage: successInput.value,
      priceType,
      price: priceType === 'fixed' ? price : 0,
      minPrice: priceType === 'flexible' ? (min || 0) : 0,
      suggestedPrice: priceType === 'flexible' ? (suggested || 0) : 0,
      allowQuantity: switchOn(qtySwitch),
      maxQuantity: Number.isInteger(maxQty) && maxQty >= 1 ? maxQty : 10,
      collectPhone: switchOn(phoneSwitch),
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
      renderCouponPageOptions();
    } catch (err) {
      showFormError(err.message || 'Could not save that payment page. Please try again.');
    }
  });

  // --- pages list ------------------------------------------------------------
  const pagesList = $('pagesList');
  function pageCardHTML(page) {
    const views = page.view_count || 0;
    const paid = page.paid_count || 0;
    const rate = views > 0 && paid <= views ? `${Math.round((paid / views) * 100)}%` : '—';
    const url = publicUrl(page);
    return `
      <div class="pp-page-card${page.visible ? '' : ' pp-hidden'}${page.id === editingId ? ' pz-editing' : ''}" data-id="${page.id}">
        <div class="pp-page-top">
          <div class="pp-page-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>
          </div>
          <div class="pp-page-main">
            <div class="pp-page-title">${escapeHTML(page.title)}</div>
            <div class="pp-page-meta">
              <span>${escapeHTML(priceLabel(page))}</span>
              ${page.allow_quantity ? `<span class="pp-tag">Up to ${page.max_quantity} per order</span>` : ''}
              ${page.delivery_url ? '' : '<span class="pp-tag" title="Buyers get a receipt but nothing to open — add an “After payment” link.">No delivery link</span>'}
              ${page.visible ? '' : '<span class="pp-tag off">Unpublished</span>'}
            </div>
          </div>
          <div class="pp-page-actions">
            <button type="button" class="pz-switch toggle-visible${page.visible ? ' on' : ''}" data-id="${page.id}"
              title="${page.visible ? 'Live — anyone with the link can buy' : 'Unpublished — the link shows a not-found page'}"
              aria-label="Published" aria-pressed="${page.visible ? 'true' : 'false'}"></button>
            <button type="button" class="pz-card-btn edit-page" data-id="${page.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
              Edit
            </button>
            <button type="button" class="pz-card-btn danger remove-page" data-id="${page.id}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="13" height="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
              Delete
            </button>
          </div>
        </div>
        <div class="pp-page-bottom pz-magnet-stats">
          <div class="pz-copy-link">
            <input type="text" readonly value="${escapeHTML(url.replace(/^https?:\/\//, ''))}" onclick="this.select()" />
            <button type="button" class="pz-copy-btn copy-link" data-url="${escapeHTML(url)}">Copy link</button>
            <a class="pz-copy-btn" href="${escapeHTML(url)}" target="_blank" rel="noopener">Open</a>
          </div>
          <span class="pz-magnet-stat"><strong>${views}</strong> ${views === 1 ? 'view' : 'views'}</span>
          <span class="pz-magnet-stat"><strong>${paid}</strong> paid ${paid === 1 ? 'order' : 'orders'}</span>
          <span class="pz-magnet-stat"><strong>${formatINR(page.revenue || 0)}</strong> earned</span>
          <span class="pz-magnet-stat"><strong>${rate}</strong> conversion</span>
        </div>
      </div>`;
  }

  function renderPages() {
    pagesList.innerHTML = pages.map(pageCardHTML).join('');
    $('emptyPages').hidden = pages.length > 0;
    $('pageCountLine').textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;

    pagesList.querySelectorAll('.edit-page').forEach((btn) => btn.addEventListener('click', () => startEdit(Number(btn.dataset.id))));
    pagesList.querySelectorAll('.remove-page').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const page = pages.find((p) => p.id === id);
      if (!page || !window.confirm(`Delete “${page.title}”? Its link stops working. Past orders stay in Orders.`)) return;
      try {
        await api(`/dashboard/payment-pages/${id}`, { method: 'DELETE' });
        pages = pages.filter((p) => p.id !== id);
        // Codes for just this page are deleted with it (lib/paymentPages.js).
        coupons = coupons.filter((c) => c.page_id !== id);
        if (editingId === id) resetBuilder();
        renderPages();
        renderCoupons();
      } catch (err) { /* status shows the error */ }
    }));
    pagesList.querySelectorAll('.toggle-visible').forEach((btn) => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const page = pages.find((p) => p.id === id);
      if (!page) return;
      const visible = !page.visible;
      try {
        const updated = await api(`/dashboard/payment-pages/${id}`, { method: 'PATCH', body: JSON.stringify({ visible }) });
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

  // --- coupons ---------------------------------------------------------------
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
