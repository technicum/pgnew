// Public payment page (views/payment-page.ejs) — live totals, the cart on
// a multi-product page, quantity steppers, coffee presets / custom
// amount, and the inline coupon check. Every number shown comes back from
// the server's own quote() (POST /pay/:slug/quote), the same one that
// prices the real order, so the page never does money maths itself.
// Without this script the form still works: the total is simply worked
// out on submit.
(function () {
  const form = document.getElementById('payForm');
  if (!form) return;
  const quoteUrl = form.dataset.quoteUrl;
  const $ = (id) => document.getElementById(id);
  const couponInput = $('coupon');
  const couponApply = $('couponApply');
  const couponMsg = $('couponMsg');
  const summary = $('paySummary');
  const payButton = $('payButton');
  const cartLines = $('cartLines');
  const shipFields = $('shipFields');
  const isCart = form.dataset.layout === 'multi';

  // Each product's current choice, from the inputs that will be posted.
  function readItems() {
    const items = {};
    form.querySelectorAll('input[name^="qty_"], input[name^="amount_"]').forEach((input) => {
      if (input.disabled) return;
      const [, kind, id] = input.name.match(/^(qty|amount)_(\d+)$/) || [];
      if (!id) return;
      items[id] = items[id] || {};
      items[id][kind] = input.value;
    });
    return items;
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function renderCart(q) {
    cartLines.replaceChildren();
    if (!q.lines.length) {
      const empty = document.createElement('p');
      empty.className = 'cx-muted cx-small';
      empty.textContent = 'Your cart is empty — add products to continue.';
      cartLines.append(empty);
    }
    q.lines.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'cx-cart-line';
      const name = document.createElement('span');
      const qty = document.createElement('span');
      qty.className = 'cx-muted';
      qty.textContent = `× ${l.qty}`;
      name.append(`${l.title} `, qty);
      const amount = document.createElement('b');
      amount.textContent = q.display.lines[l.id];
      row.append(name, amount);
      cartLines.append(row);
    });
    setText('cartCount', String(q.lines.reduce((n, l) => n + l.qty, 0)));
  }

  // Only the latest request's answer is applied, however they arrive.
  let seq = 0;
  let appliedCoupon = couponInput ? couponInput.value.trim() : '';

  async function refresh({ showCouponResult = false } = {}) {
    const mine = ++seq;
    if (summary) summary.classList.add('is-updating');
    try {
      const res = await fetch(quoteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: readItems(), coupon: appliedCoupon }),
      });
      const q = await res.json();
      if (mine !== seq || !res.ok) return;
      q.lines.forEach((l) => {
        form.querySelectorAll(`[data-qty-label-for="${l.id}"]`).forEach((el) => { el.textContent = `× ${l.qty}`; });
      });
      if (cartLines) renderCart(q);
      setText('sumSubtotal', q.display.subtotal);
      if ($('sumDiscountRow')) $('sumDiscountRow').hidden = !q.hasDiscount;
      setText('sumCoupon', q.coupon ? q.coupon.code : '');
      setText('sumDiscount', `−${q.display.discount}`);
      if ($('sumShippingRow')) $('sumShippingRow').hidden = !q.hasShipping;
      setText('sumShipping', q.display.shipping);
      setText('sumTotal', q.display.total);
      // The address is only asked for while the cart holds something to post.
      if (shipFields && isCart) shipFields.hidden = !q.hasShipping;
      $('payButtonText').textContent = `${payButton.dataset.label} ${q.display.total}`;
      if (isCart) payButton.disabled = !q.lines.length;
      // An amount below its minimum, more than is in stock… shown now
      // rather than only after submitting. (An empty cart says so itself.)
      const liveError = $('liveError');
      if (liveError) {
        const shown = q.lines.length ? q.error : null;
        liveError.textContent = shown || '';
        liveError.hidden = !shown;
      }
      if (couponMsg && (showCouponResult || q.couponError)) {
        couponMsg.classList.toggle('is-error', !!q.couponError);
        couponMsg.textContent = q.couponError || (q.coupon ? `🎉 ${q.coupon.code} applied — ${q.coupon.label}` : '');
      }
      // A code that stopped working (or was never valid) isn't kept.
      if (q.couponError) appliedCoupon = '';
    } catch (err) {
      // Offline or the server hiccuped — the total is rechecked on submit anyway.
    } finally {
      if (mine === seq && summary) summary.classList.remove('is-updating');
    }
  }

  let timer = null;
  function refreshSoon() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
  }

  // Quantity stepper (single product).
  form.querySelectorAll('.pp-qty').forEach((stepper) => {
    const input = stepper.querySelector('input');
    const max = Number(stepper.dataset.max) || 1;
    const [dec, inc] = stepper.querySelectorAll('.pp-qty-btn');
    const clamp = () => {
      const n = Math.min(max, Math.max(1, Math.round(Number(input.value) || 1)));
      input.value = n;
      dec.disabled = n <= 1 || input.disabled;
      inc.disabled = n >= max || input.disabled;
    };
    [dec, inc].forEach((btn) => btn.addEventListener('click', () => {
      input.value = (Number(input.value) || 1) + Number(btn.dataset.step);
      clamp();
      refreshSoon();
    }));
    input.addEventListener('change', () => { clamp(); refreshSoon(); });
    clamp();
  });

  // Multi-product cart: "+ Add to cart" puts one in, the stepper changes
  // how many, and taking the last one out empties that card again.
  form.querySelectorAll('.cx-product').forEach((card) => {
    const input = card.querySelector('input.n');
    if (!input) return; // sold out
    const max = Number(input.max) || 1;
    const plus = card.querySelector('.plus');
    const set = (n) => {
      n = Math.min(max, Math.max(0, Math.round(Number(n) || 0)));
      input.value = n;
      card.classList.toggle('added', n > 0);
      plus.disabled = n >= max;
      refresh();
    };
    card.querySelector('[data-add]').addEventListener('click', () => set(1));
    card.querySelectorAll('.qty button').forEach((btn) => btn.addEventListener('click', () => {
      set((Number(input.value) || 0) + Number(btn.dataset.step));
    }));
    input.addEventListener('change', () => set(input.value));
  });

  // A "buy me a coffee" page: presets set the number of coffees; typing
  // your own amount takes over from them (an empty amount means "use the
  // preset", so clearing the box goes back to it).
  form.querySelectorAll('[data-coffee]').forEach((presets) => {
    const id = presets.dataset.coffee;
    const qtyInput = form.querySelector(`input[name="qty_${id}"]`);
    const amountInput = form.querySelector(`input[name="amount_${id}"]`);
    const amountBox = amountInput.closest('.cx-custom-amt');
    const buttons = presets.querySelectorAll('button');
    const pick = (btn) => buttons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    buttons.forEach((btn) => btn.addEventListener('click', () => {
      pick(btn);
      qtyInput.value = btn.dataset.qty;
      amountInput.value = '';
      amountBox.classList.remove('active');
      refresh();
    }));
    amountInput.addEventListener('input', () => {
      const custom = amountInput.value.trim() !== '';
      amountBox.classList.toggle('active', custom);
      if (custom) pick(null);
      else pick([...buttons].find((b) => b.dataset.qty === qtyInput.value) || null);
      refreshSoon();
    });
  });

  // A signed-in buyer's saved addresses: picking one hides the new-address
  // fields, "new address" shows them.
  const newAddress = $('newAddress');
  form.querySelectorAll('input[name="address_id"]').forEach((radio) => radio.addEventListener('change', () => {
    form.querySelectorAll('.cx-address').forEach((label) => {
      label.classList.toggle('active', label.querySelector('input').checked);
    });
    newAddress.hidden = radio.value !== 'new';
    if (radio.value === 'new') $('address').focus();
  }));

  // Pay-what-you-want amounts.
  form.querySelectorAll('.cx-amount input').forEach((input) => input.addEventListener('input', refreshSoon));

  if (couponInput) {
    const applyCoupon = () => {
      appliedCoupon = couponInput.value.trim();
      if (!appliedCoupon) {
        couponMsg.textContent = '';
        refresh();
        return;
      }
      refresh({ showCouponResult: true });
    };
    couponApply.addEventListener('click', applyCoupon);
    // Enter in the code field applies it rather than placing the order.
    couponInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCoupon();
      }
    });
  }

  form.addEventListener('submit', (e) => {
    if (payButton.classList.contains('is-busy')) {
      e.preventDefault();
      return;
    }
    // Only an applied code goes with the order — not one typed but never applied.
    if (couponInput) couponInput.value = appliedCoupon;
    payButton.classList.add('is-busy');
    $('payButtonText').textContent = 'Processing…';
  });
  // Coming back to the page from the next step shouldn't leave it stuck.
  window.addEventListener('pageshow', () => {
    if (!payButton.classList.contains('is-busy')) return;
    payButton.classList.remove('is-busy');
    refresh();
  });

  // An empty cart can't be paid for yet.
  if (isCart && !form.querySelector('.cx-product.added')) payButton.disabled = true;
})();
