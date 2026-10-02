// Public payment page (views/payment-page.ejs) — live totals, quantity
// steppers, coffee presets / custom amount, and the inline coupon check.
// Every number shown comes back from the server's own quote()
// (POST /pay/:slug/quote), the same one that prices the real order, so
// the page never does money maths itself. Without this script the form
// still works: the total is simply worked out on submit.
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

  // Each product's current choice, from the inputs that will be posted
  // (a disabled input — a coffee's hidden custom amount — doesn't count).
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
      Object.entries(q.display.lines).forEach(([id, text]) => {
        form.querySelectorAll(`[data-line-for="${id}"]`).forEach((el) => { el.textContent = text; });
      });
      q.lines.forEach((l) => {
        form.querySelectorAll(`[data-qty-label-for="${l.id}"]`).forEach((el) => { el.textContent = `× ${l.qty}`; });
      });
      if (summary) {
        $('sumSubtotal').textContent = q.display.subtotal;
        $('sumDiscountRow').hidden = !q.hasDiscount;
        $('sumCoupon').textContent = q.coupon ? q.coupon.code : '';
        $('sumDiscount').textContent = `−${q.display.discount}`;
        if ($('sumShipping')) $('sumShipping').textContent = q.display.shipping;
        $('sumTotal').textContent = q.display.total;
        // A one-product page only needs the breakdown once there's
        // something to break down.
        summary.hidden = !(summary.dataset.always === '1' || q.hasDiscount || q.hasShipping);
      }
      $('payButtonText').textContent = `${payButton.dataset.label} ${q.display.total}`;
      // An amount below its minimum, more than is in stock… shown now
      // rather than only after submitting.
      const liveError = $('liveError');
      if (liveError) {
        liveError.textContent = q.error || '';
        liveError.hidden = !q.error;
      }
      if (couponMsg && (showCouponResult || q.couponError)) {
        couponMsg.classList.toggle('is-error', !!q.couponError);
        couponMsg.textContent = q.couponError || (q.coupon ? `${q.coupon.code} applied — ${q.coupon.label}` : '');
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

  // Quantity steppers.
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

  // A coffee inside a bundle: ×1 / ×3 / ×5.
  form.querySelectorAll('[data-pills-for]').forEach((row) => {
    const input = form.querySelector(`input[name="qty_${row.dataset.pillsFor}"]`);
    row.querySelectorAll('button').forEach((pill) => pill.addEventListener('click', () => {
      input.value = pill.dataset.qty;
      row.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === pill));
      refresh();
    }));
  });

  // A "buy me a coffee" page: presets set the number of coffees; Custom
  // swaps that for a typed amount (the amount input is only enabled — and
  // so only posted — while Custom is picked).
  form.querySelectorAll('[data-coffee]').forEach((presets) => {
    const id = presets.dataset.coffee;
    const qtyInput = form.querySelector(`input[name="qty_${id}"]`);
    const amountInput = form.querySelector(`input[name="amount_${id}"]`);
    const amountBox = amountInput.closest('.pl-coffee-amount');
    const buttons = presets.querySelectorAll('button');
    const pick = (btn) => buttons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    presets.querySelectorAll('[data-qty]').forEach((btn) => btn.addEventListener('click', () => {
      pick(btn);
      qtyInput.value = btn.dataset.qty;
      amountInput.disabled = true;
      amountBox.hidden = true;
      refresh();
    }));
    presets.querySelector('[data-custom]').addEventListener('click', (e) => {
      pick(e.currentTarget);
      amountInput.disabled = false;
      amountBox.hidden = false;
      amountInput.focus();
      if (amountInput.value) refresh();
    });
    amountInput.addEventListener('input', refreshSoon);
  });

  // Pay-what-you-want amounts.
  form.querySelectorAll('.pp-amount input').forEach((input) => input.addEventListener('input', refreshSoon));

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
    // Only an applied code goes with the order — not one typed but never applied.
    form.addEventListener('submit', () => {
      couponInput.value = appliedCoupon;
    });
  }
})();
