// Orders dashboard (views/orders.ejs). Orders start from
// window.__PZ_ORDERS__; search and filters are client-side over that list.
// A pending order can be settled by hand — marked paid (how "manual"
// payments work until a gateway is connected) or cancelled — via
// PATCH /dashboard/orders/:id.
(function () {
  let orders = window.__PZ_ORDERS__ || [];
  const pages = window.__PZ_ORDER_PAGES__ || [];
  const $ = (id) => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatINR(paise) {
    const rupees = (Number(paise) || 0) / 100;
    return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  function formatDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const STATUS_LABEL = { paid: 'Paid', pending: 'Awaiting payment', cancelled: 'Cancelled' };
  const PROVIDER_LABEL = { test: 'test payment', manual: 'marked paid by you', free: 'free (100% off)' };

  // --- save status + fetch helper -------------------------------------
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

  // --- rendering -------------------------------------------------------
  const list = $('ordersList');
  const searchInput = $('orderSearch');
  const statusFilter = $('orderStatusFilter');
  const pageFilter = $('orderPageFilter');
  const clearBtn = $('orderClearFilters');

  // Filter by page id where the page still exists, else by the title the
  // order kept (a deleted page's orders still group together).
  const pageKey = (o) => (pages.some((p) => p.id === o.page_id) ? `id:${o.page_id}` : `title:${o.page_title}`);
  function renderPageOptions() {
    const seen = new Map(pages.map((p) => [`id:${p.id}`, p.title]));
    orders.forEach((o) => { if (!seen.has(pageKey(o))) seen.set(pageKey(o), `${o.page_title} (deleted)`); });
    pageFilter.innerHTML = '<option value="">All payment pages</option>'
      + [...seen].map(([key, title]) => `<option value="${escapeHTML(key)}">${escapeHTML(title)}</option>`).join('');
  }

  function orderRowHTML(o) {
    const qty = o.quantity > 1 ? ` × ${o.quantity}` : '';
    const contact = [o.buyer_email, o.buyer_phone].filter(Boolean).map(escapeHTML).join(' · ');
    const detail = [];
    if (o.discount) detail.push(`${escapeHTML(o.coupon_code)} −${formatINR(o.discount)}`);
    if (o.status === 'paid' && PROVIDER_LABEL[o.provider]) detail.push(PROVIDER_LABEL[o.provider]);
    const actions = o.status === 'pending'
      ? `<div class="pp-order-actions">
           <button type="button" class="pz-card-btn order-paid" data-id="${o.id}">Mark paid</button>
           <button type="button" class="pz-card-btn danger order-cancel" data-id="${o.id}">Cancel</button>
         </div>`
      : '';
    return `
      <div class="pp-order-row" data-id="${o.id}"
           data-search="${escapeHTML(`${o.buyer_name} ${o.buyer_email} ${o.buyer_phone} ${o.coupon_code}`.toLowerCase())}">
        <div class="pp-order-buyer">
          <strong>${escapeHTML(o.buyer_name || o.buyer_email)}</strong>
          <span>${contact}</span>
        </div>
        <div class="pp-order-what">
          ${escapeHTML(o.page_title)}${qty}
          <span>#${o.id} · ${escapeHTML(formatDate(o.created_at))}${detail.length ? ` · ${detail.join(' · ')}` : ''}</span>
        </div>
        <div class="pp-order-amount">
          <strong>${formatINR(o.total)}</strong>
          ${o.discount ? `<span><s>${formatINR(o.subtotal)}</s></span>` : ''}
        </div>
        <div class="pp-order-side">
          <span class="pp-status pp-status-${escapeHTML(o.status)}">${escapeHTML(STATUS_LABEL[o.status] || o.status)}</span>
          ${actions}
        </div>
      </div>`;
  }

  function renderStats() {
    const paid = orders.filter((o) => o.status === 'paid');
    $('statRevenue').textContent = formatINR(paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0));
    $('statPaid').textContent = paid.length;
    $('statPending').textContent = orders.filter((o) => o.status === 'pending').length;
  }

  function render() {
    list.innerHTML = orders.map(orderRowHTML).join('');
    renderStats();
    list.querySelectorAll('.order-paid').forEach((btn) => btn.addEventListener('click', () => settle(Number(btn.dataset.id), 'paid')));
    list.querySelectorAll('.order-cancel').forEach((btn) => btn.addEventListener('click', () => settle(Number(btn.dataset.id), 'cancelled')));
    applyFilters();
  }

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    // "#12" is an order number — matched exactly, not as a substring of
    // phone numbers and the like.
    const orderNo = (q.match(/^#(\d+)$/) || [])[1];
    const status = statusFilter.value;
    const page = pageFilter.value;
    const filtering = !!(q || status || page);
    clearBtn.hidden = !filtering;
    let shown = 0;
    list.querySelectorAll('.pp-order-row').forEach((row) => {
      const o = orders.find((x) => x.id === Number(row.dataset.id));
      const textMatch = !q || (orderNo ? String(o.id) === orderNo : row.dataset.search.includes(q));
      const match = textMatch && (!status || o.status === status) && (!page || pageKey(o) === page);
      row.hidden = !match;
      if (match) shown += 1;
    });
    $('orderCountLine').textContent = filtering
      ? `Showing ${shown} of ${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`
      : `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`;
    $('emptyOrders').hidden = shown > 0;
    if (!orders.length) {
      $('emptyOrdersTitle').textContent = 'No orders yet';
      $('emptyOrdersSub').textContent = 'Share one of your payment pages — every purchase shows up here.';
    } else if (!shown) {
      $('emptyOrdersTitle').textContent = 'No matches';
      $('emptyOrdersSub').textContent = 'No orders match these filters.';
    }
  }
  searchInput.addEventListener('input', applyFilters);
  statusFilter.addEventListener('change', applyFilters);
  pageFilter.addEventListener('change', applyFilters);
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    statusFilter.value = '';
    pageFilter.value = '';
    applyFilters();
    searchInput.focus();
  });

  async function settle(id, status) {
    const order = orders.find((o) => o.id === id);
    if (!order) return;
    const question = status === 'paid'
      ? `Mark order #${id} (${formatINR(order.total)} from ${order.buyer_name}) as paid? Their purchase unlocks and they’re added to your Audience.`
      : `Cancel order #${id}? The buyer’s receipt will show it as cancelled.`;
    if (!window.confirm(question)) return;
    const row = list.querySelector(`.pp-order-row[data-id="${id}"]`);
    if (row) row.classList.add('pp-busy');
    setSaving();
    try {
      const res = await fetch(`/dashboard/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      // 409: someone (or the buyer's checkout) settled it first — show what it is now.
      if (data.order) orders = orders.map((o) => (o.id === id ? data.order : o));
      if (!res.ok) {
        setError(data.error);
      } else {
        setSaved();
      }
      render();
    } catch (err) {
      setError();
      if (row) row.classList.remove('pp-busy');
    }
  }

  renderPageOptions();
  render();
})();
