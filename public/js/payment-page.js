// Public payment page (views/payment-page.ejs) — live totals, quantity
// steppers, coffee pills and the inline coupon check. Every number shown
// comes back from the server's own quote() (POST /pay/:slug/quote), the
// same one that prices the real order, so the page never does money maths
// itself. Without this script the form still works: the total is simply
// worked out on submit.
(function () {
  const form = document.getElementById('payForm');
  if (!form) return;
  const quoteUrl = form.dataset.quoteUrl;
  const couponInput = document.getElementById('coupon');
  const couponApply = document.getElementById('couponApply');
  const couponMsg = document.getElementById('couponMsg');
  const summary = document.getElementById('paySummary');
  const $ = (id) => document.getElementById(id);

  // Each product's current choice, read straight from its inputs.
  function readItems() {
    const items = {};
    form.querySelectorAll('.pp-item').forEach((row) => {
      const id = row.dataset.pid;
      const qty = row.querySelector(`[name="qty_${id}"]`);
      const amount = row.querySelector(`[name="amount_${id}"]`);
      items[id] = { qty: qty ? qty.value : undefined, amount: amount ? amount.value : undefined };
    });
    return items;
  }

  // Only the latest request's answer is applied, however they arrive.
  let seq = 0;
  let appliedCoupon = couponInput.value.trim();

  async function refresh({ showCouponResult = false } = {}) {
    const mine = ++seq;
    summary.classList.add('is-updating');
    try {
      const res = await fetch(quoteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: readItems(), coupon: appliedCoupon }),
      });
      const q = await res.json();
      if (mine !== seq || !res.ok) return;
      Object.entries(q.display.lines).forEach(([id, text]) => {
        const el = form.querySelector(`[data-line-for="${id}"]`);
        if (el) el.textContent = text;
      });
      $('sumSubtotal').textContent = q.display.subtotal;
      $('sumDiscountRow').hidden = !q.hasDiscount;
      $('sumCoupon').textContent = q.coupon ? q.coupon.code : '';
      $('sumDiscount').textContent = `−${q.display.discount}`;
      if ($('sumShipping')) $('sumShipping').textContent = q.display.shipping;
      $('sumTotal').textContent = q.display.total;
      $('payButtonText').textContent = `Pay ${q.display.total}`;
      if (showCouponResult || q.couponError) {
        couponMsg.classList.toggle('is-error', !!q.couponError);
        couponMsg.textContent = q.couponError || (q.coupon ? `${q.coupon.code} applied — ${q.coupon.label}` : '');
      }
      // A code that stopped working (or was never valid) isn't kept.
      if (q.couponError) appliedCoupon = '';
    } catch (err) {
      // Offline or the server hiccuped — the total is rechecked on submit anyway.
    } finally {
      if (mine === seq) summary.classList.remove('is-updating');
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

  // Coffee: ×1 / ×3 / ×5 pills set the count; the box takes any other number.
  form.querySelectorAll('.pp-coffee').forEach((row) => {
    const input = row.querySelector('input');
    const pills = row.querySelectorAll('.pp-coffee-pill');
    const mark = () => pills.forEach((p) => p.classList.toggle('active', Number(p.dataset.setQty) === Number(input.value)));
    pills.forEach((pill) => pill.addEventListener('click', () => {
      input.value = pill.dataset.setQty;
      mark();
      refreshSoon();
    }));
    input.addEventListener('input', () => { mark(); refreshSoon(); });
  });

  // Pay-what-you-want amounts.
  form.querySelectorAll('[name^="amount_"]').forEach((input) => input.addEventListener('input', refreshSoon));

  function applyCoupon() {
    appliedCoupon = couponInput.value.trim();
    if (!appliedCoupon) {
      couponMsg.textContent = '';
      refresh();
      return;
    }
    refresh({ showCouponResult: true });
  }
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
})();
