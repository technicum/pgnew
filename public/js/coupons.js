// Coupons dashboard (views/coupons.ejs): discount codes for the payment
// pages. Starts from window.__PZ_COUPONS__ (and __PZ_COUPON_PAGES__ for
// the "Works on" picker and page names); every change is a fetch() to the
// /dashboard/coupons JSON endpoints in server.js, which re-check
// everything (lib/paymentPages.js).
(function () {
  let coupons = window.__PZ_COUPONS__ || [];
  const pages = window.__PZ_COUPON_PAGES__ || [];

  const $ = (id) => document.getElementById(id);
  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  // --- save status + fetch helper (same as the other dashboard pages) ---
  const saveStatus = $('saveStatus');
  const saveStatusText = $('saveStatusText');
  let pending = 0;
  let clearErrorTimer = null;
  function setError(message) {
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
    pending += 1;
    saveStatus.classList.remove('error');
    saveStatus.classList.add('saving');
    saveStatusText.textContent = 'Saving…';
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
      pending -= 1;
      if (pending === 0) {
        saveStatus.classList.remove('saving');
        saveStatusText.textContent = 'Saved';
      }
      return data;
    } catch (err) {
      pending -= 1;
      setError(err instanceof TypeError ? 'Couldn’t reach the server' : err.message);
      throw err;
    }
  }

  // --- list ------------------------------------------------------------------
  const isExpired = (c) => !!c.expires_at && new Date(`${c.expires_at}T23:59:59`) < new Date();
  const isUsedUp = (c) => !!c.max_uses && c.used_count >= c.max_uses;
  const isLive = (c) => !!c.active && !isExpired(c) && !isUsedUp(c);

  function statusOf(c) {
    if (!c.active) return ['off', 'Switched off'];
    if (isExpired(c)) return ['off', 'Expired'];
    if (isUsedUp(c)) return ['off', 'Used up'];
    return ['live', 'Active'];
  }

  function couponRowHTML(c) {
    const page = c.page_id ? pages.find((p) => p.id === c.page_id) : null;
    const off = c.discount_type === 'percent' ? `${c.discount_value}% off` : `${formatINR(c.discount_value)} off`;
    const uses = c.max_uses ? `${c.used_count} / ${c.max_uses} used` : `${c.used_count} used`;
    const expiry = c.expires_at
      ? `${isExpired(c) ? 'Expired' : 'Until'} ${new Date(`${c.expires_at}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'No expiry';
    const [state, stateLabel] = statusOf(c);
    return `
      <div class="cp-row${c.active ? '' : ' is-off'}" data-id="${c.id}">
        <span class="cp-row-icon is-${state}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" width="17" height="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path><path d="M13 5v2"></path><path d="M13 17v2"></path><path d="M13 11v2"></path></svg></span>
        <span class="cp-row-main">
          <span class="cp-row-top">
            <span class="cp-code">${escapeHTML(c.code)}</span>
            <button type="button" class="cp-copy" data-copy="${escapeHTML(c.code)}" aria-label="Copy ${escapeHTML(c.code)}">Copy</button>
          </span>
          <span class="cp-row-meta">
            <strong>${escapeHTML(off)}</strong>
            <span>${page ? escapeHTML(page.title) : 'All payment pages'}</span>
            <span>${escapeHTML(uses)}</span>
            <span>${escapeHTML(expiry)}</span>
          </span>
        </span>
        <span class="cp-pill is-${state}">${stateLabel}</span>
        <span class="cp-row-actions">
          <button type="button" class="pz-switch toggle-coupon${c.active ? ' on' : ''}" data-id="${c.id}" role="switch" aria-checked="${c.active ? 'true' : 'false'}" aria-label="${escapeHTML(c.code)} active"></button>
          <button type="button" class="cp-delete remove-coupon" data-id="${c.id}" aria-label="Delete code ${escapeHTML(c.code)}">
            <svg viewBox="0 0 24 24" fill="none" width="15" height="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
          </button>
        </span>
      </div>`;
  }

  const search = $('couponSearch');
  function render() {
    const q = search.value.trim().toUpperCase();
    const shown = q ? coupons.filter((c) => c.code.toUpperCase().includes(q)) : coupons;
    $('couponsList').innerHTML = shown.map(couponRowHTML).join('');
    $('emptyCoupons').hidden = shown.length > 0;
    const emptyText = $('emptyCouponsText');
    if (coupons.length) emptyText.textContent = `No codes match “${search.value.trim()}”.`;
    else emptyText.innerHTML = 'No coupon codes yet. Add one above with <strong>New coupon</strong>, then share it with your audience.';
    const live = coupons.filter(isLive).length;
    $('statActive').textContent = live;
    $('statUses').textContent = coupons.reduce((sum, c) => sum + (c.used_count || 0), 0);
    $('statOff').textContent = coupons.length - live;
    $('couponCountLine').textContent = coupons.length
      ? `${coupons.length} code${coupons.length === 1 ? '' : 's'}, newest first`
      : '';
  }
  search.addEventListener('input', render);

  $('couponsList').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        copy.textContent = 'Copied';
      } catch (err) {
        copy.textContent = 'Couldn’t copy';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      return;
    }
    const toggle = e.target.closest('.toggle-coupon');
    if (toggle) {
      const coupon = coupons.find((c) => c.id === Number(toggle.dataset.id));
      if (!coupon) return;
      const active = !coupon.active;
      try {
        await api(`/dashboard/coupons/${coupon.id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
        coupon.active = active ? 1 : 0;
        render();
      } catch (err) { /* status shows the error */ }
      return;
    }
    const remove = e.target.closest('.remove-coupon');
    if (remove) {
      // First click arms it, a second one deletes (lead-magnets.css .confirm).
      if (!remove.classList.contains('confirm')) {
        remove.classList.add('confirm');
        remove.setAttribute('aria-label', 'Click again to delete');
        remove.title = 'Click again to delete';
        setTimeout(() => { remove.classList.remove('confirm'); remove.title = ''; }, 3000);
        return;
      }
      const id = Number(remove.dataset.id);
      try {
        await api(`/dashboard/coupons/${id}`, { method: 'DELETE' });
        coupons = coupons.filter((c) => c.id !== id);
        render();
      } catch (err) { /* status shows the error */ }
    }
  });

  // --- new code ----------------------------------------------------------------
  const couponForm = $('couponForm');
  const couponError = $('couponFormError');
  const pageSelect = $('couponPage');
  pageSelect.innerHTML = '<option value="">All payment pages</option>'
    + pages.map((p) => `<option value="${p.id}">${escapeHTML(p.title)}</option>`).join('');

  // "% off" / "₹ off" segmented toggle writes the hidden #couponType.
  const typeInput = $('couponType');
  const segButtons = [...document.querySelectorAll('.cp-seg [data-type]')];
  const addBtn = $('couponAdd');
  function setType(type) {
    typeInput.value = type;
    segButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
    $('couponValue').placeholder = type === 'percent' ? '20' : '100';
  }
  function syncAdd() {
    addBtn.disabled = !($('couponCode').value.trim() && $('couponValue').value.trim());
  }
  segButtons.forEach((b) => b.addEventListener('click', () => { setType(b.dataset.type); syncAdd(); }));
  couponForm.addEventListener('input', syncAdd);

  couponForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    couponError.classList.remove('show');
    const fail = (message) => {
      couponError.textContent = message;
      couponError.classList.add('show');
    };
    if (!$('couponCode').value.trim()) return fail('Give the code a name, like LAUNCH20.');
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
          pageId: pageSelect.value || null,
          maxUses: $('couponMaxUses').value || null,
          expiresAt: $('couponExpires').value || null,
        }),
      });
      coupons.unshift(created);
      couponForm.reset();
      setType('percent');
      $('couponLimits').open = false;
      syncAdd();
      search.value = '';
      render();
      $('couponCode').focus();
    } catch (err) {
      fail(err.message || 'Could not add that code. Please try again.');
    }
  });

  render();
})();
