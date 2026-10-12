// Abandoned carts (partials/abandoned-carts.ejs, lib/abandoned.js) — on the
// Abandoned carts page and inside each service. Builds each
// buyer's follow-up from the creator's template, and sends it three ways:
//   WhatsApp — wa.me with the message filled in (an Indian 10-digit number
//              gets +91), opens WhatsApp / WhatsApp Web
//   Email    — the creator's own mail app (mailto:)
//   Copy     — to paste anywhere (Instagram DM, SMS…)
// Each marks the cart contacted (POST /dashboard/abandoned/contacted).
// The template, subject and coupon are kept in this browser.
(function () {
  const data = window.__PZ_ABANDONED__ || { carts: [] };
  let carts = data.carts;

  const $ = (id) => document.getElementById(id);
  const list = $('abList');
  const template = $('abTemplate');
  const subject = $('abSubject');
  const couponSelect = $('abCoupon');
  const preview = $('abPreview');
  const search = $('abSearch');
  const statusFilter = $('abStatus');
  const kindFilter = $('abKind');

  const DEFAULT_TEMPLATE = 'Hi {name}, this is {store} 👋\n\nI noticed you were checking out {items} ({total}) but didn’t finish. Any questions I can help with?\n\n{coupon}You can pick up where you left off here: {link}';
  const DEFAULT_SUBJECT = 'Still thinking about {items}?';
  const KIND = { page: 'Payment page', course: 'Course', booking: 'Booking', order: 'Order' };
  const STAGE = { details: 'Left at checkout', payment: 'Left at payment', cancelled: 'Cancelled payment' };

  const store = (key, value) => {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (err) { /* storage off — just not remembered */ }
    return null;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const ago = (when) => {
    const mins = Math.max(1, Math.round((Date.now() - new Date(when).getTime()) / 60000));
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} days ago`;
  };
  const itemsText = (cart) => cart.items.map((i) => (i.qty > 1 ? `${i.title} × ${i.qty}` : i.title)).join(', ') || cart.source;

  // The coupon line only for a payment-page cart the code works on.
  function couponFor(cart) {
    const opt = couponSelect.selectedOptions[0];
    if (!opt || !opt.value || cart.kind !== 'page') return '';
    if (opt.dataset.page && Number(opt.dataset.page) !== cart.pageId) return '';
    return `Use code ${opt.value} for ${opt.dataset.label}. `;
  }
  function fill(text, cart) {
    const first = String(cart.name || '').trim().split(/\s+/)[0] || 'there';
    const link = cart.path ? data.storeUrl + cart.path : data.storeUrl;
    return text
      .replace(/\{name\}/g, first)
      .replace(/\{items\}/g, itemsText(cart))
      .replace(/\{total\}/g, inr(cart.total))
      .replace(/\{link\}/g, link)
      .replace(/\{coupon\}/g, couponFor(cart))
      .replace(/\{store\}/g, data.store || '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 98765 43210 / 098765 43210 → 919876543210; anything with a country code as typed.
  function waNumber(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
    return digits.length >= 11 ? digits : '';
  }

  function toast(text) {
    const t = $('abToast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  async function markContacted(cart, channel) {
    try {
      const res = await fetch('/dashboard/abandoned/contacted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: cart.ref, channel, email: cart.email, total: cart.total }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      cart.contactedAt = out.contactedAt;
      cart.contacts = out.contacts;
      cart.channel = out.channel;
    } catch (err) {
      toast('Couldn’t mark that as contacted — try again.');
    }
    render();
  }

  function rowHTML(cart) {
    const wa = waNumber(cart.phone);
    const contacted = cart.contactedAt
      ? `<span class="ab-tag is-done">✓ Contacted ${esc(ago(cart.contactedAt))}${cart.contacts > 1 ? ` · ${cart.contacts}×` : ''}</span>`
      : '<span class="ab-tag">Not contacted</span>';
    return `
      <li class="ab-row" data-ref="${esc(cart.ref)}">
        <div class="ab-who">
          <span class="ab-avatar" aria-hidden="true">${esc((cart.name || cart.email).trim().charAt(0).toUpperCase())}</span>
          <span>
            <b>${esc(cart.name || 'No name given')}</b>
            <small>${esc(cart.email)}${cart.phone ? ` · ${esc(cart.phone)}` : ''}</small>
          </span>
        </div>
        <div class="ab-cart">
          <span>${esc(itemsText(cart))}</span>
          <small>${esc(KIND[cart.kind] || 'Order')}${cart.kind === 'page' ? `: ${esc(cart.source)}` : ''} · ${esc(STAGE[cart.stage] || '')} · ${esc(ago(cart.updatedAt))}</small>
          ${contacted}
        </div>
        <div class="ab-total">${esc(inr(cart.total))}</div>
        <div class="ab-actions">
          ${wa ? `<a class="ab-btn is-wa" data-act="whatsapp" href="#" title="Open WhatsApp with the message filled in">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3Z"/></svg>
            WhatsApp</a>` : ''}
          <a class="ab-btn" data-act="email" href="#" title="Write the email in your mail app">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>
            Email</a>
          <button type="button" class="ab-btn" data-act="copy" title="Copy the message to paste anywhere">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy</button>
          <button type="button" class="ab-btn is-quiet" data-act="dismiss" title="Remove from this list">Dismiss</button>
        </div>
      </li>`;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const status = statusFilter.value;
    const kind = kindFilter.value;
    const shown = carts.filter((c) => (!q || `${c.name} ${c.email} ${c.phone} ${itemsText(c)} ${c.source}`.toLowerCase().includes(q))
      && (!status || (status === 'new' ? !c.contactedAt : !!c.contactedAt))
      && (!kind || c.kind === kind || (kind === 'booking' && c.kind === 'order')));
    list.innerHTML = shown.map(rowHTML).join('');
    // The "Not contacted yet" tile, on pages that have one.
    const waitingTile = $('statWaiting');
    if (waitingTile) waitingTile.textContent = carts.filter((c) => !c.contactedAt).length;
    $('abCountLine').textContent = carts.length
      ? `Showing ${shown.length} of ${carts.length} · ${inr(shown.reduce((n, c) => n + c.total, 0))}`
      : 'Nothing waiting';
    const empty = !shown.length;
    $('abEmpty').hidden = !empty;
    if (empty) {
      $('abEmptyTitle').textContent = carts.length ? (status === 'new' && !q && !kind ? 'Everyone’s been contacted' : 'No matches') : 'No abandoned carts';
      $('abEmptySub').textContent = carts.length
        ? (status === 'new' && !q && !kind ? 'Switch to “Everyone” to see who you’ve reached out to.' : 'Try another search or filter.')
        : 'Everyone who started checking out finished. 🎉';
    }
    renderPreview();
  }

  function renderPreview() {
    const sample = carts.find((c) => !c.contactedAt) || carts[0]
      || { name: 'Priya Sharma', items: [{ title: 'Your product', qty: 1 }], total: 49900, kind: 'page', path: '', source: '' };
    preview.textContent = fill(template.value, sample);
  }

  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.preventDefault();
    const cart = carts.find((c) => c.ref === btn.closest('.ab-row').dataset.ref);
    if (!cart) return;
    const act = btn.dataset.act;
    const message = fill(template.value, cart);
    if (act === 'whatsapp') {
      window.open(`https://wa.me/${waNumber(cart.phone)}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
      markContacted(cart, 'whatsapp');
    } else if (act === 'email') {
      window.location.href = `mailto:${encodeURIComponent(cart.email)}?subject=${encodeURIComponent(fill(subject.value, cart))}&body=${encodeURIComponent(message)}`;
      markContacted(cart, 'email');
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(message);
        toast('Message copied — paste it anywhere.');
        markContacted(cart, 'copy');
      } catch (err) {
        toast('Couldn’t copy — select the preview text instead.');
      }
    } else if (act === 'dismiss') {
      const row = btn.closest('.ab-row');
      row.classList.add('is-leaving');
      try {
        const res = await fetch('/dashboard/abandoned/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: cart.ref }) });
        if (!res.ok) throw new Error();
        carts = carts.filter((c) => c !== cart);
      } catch (err) {
        toast('Couldn’t dismiss that — try again.');
      }
      render();
    }
  });

  template.value = store('pz-ab-template') || DEFAULT_TEMPLATE;
  subject.value = store('pz-ab-subject') || DEFAULT_SUBJECT;
  couponSelect.value = store('pz-ab-coupon') || '';
  if (couponSelect.value !== (store('pz-ab-coupon') || '')) couponSelect.value = ''; // that coupon's gone
  template.addEventListener('input', () => { store('pz-ab-template', template.value); renderPreview(); });
  subject.addEventListener('input', () => store('pz-ab-subject', subject.value));
  couponSelect.addEventListener('change', () => { store('pz-ab-coupon', couponSelect.value); renderPreview(); });
  $('abReset').addEventListener('click', () => {
    template.value = DEFAULT_TEMPLATE;
    subject.value = DEFAULT_SUBJECT;
    store('pz-ab-template', DEFAULT_TEMPLATE);
    store('pz-ab-subject', DEFAULT_SUBJECT);
    renderPreview();
  });
  [search, statusFilter, kindFilter].forEach((el) => el.addEventListener(el === search ? 'input' : 'change', render));

  // With nobody left to contact, start on everyone instead of an empty list.
  if (!carts.some((c) => !c.contactedAt)) statusFilter.value = '';
  render();
})();
