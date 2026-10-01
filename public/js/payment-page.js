// Public payment page (views/payment-page.ejs) — live total and inline
// coupon check. Every number shown comes back from the server's own
// quote() (POST /pay/:slug/quote), the same one that prices the real
// order, so the page never does money maths itself. Without this script
// the form still works: the total is simply worked out on submit.
(function () {
  const form = document.getElementById('payForm');
  if (!form) return;
  const quoteUrl = form.dataset.quoteUrl;
  const cta = form.dataset.cta;
  const amountInput = document.getElementById('amount');
  const qtyInput = document.getElementById('quantity');
  const couponInput = document.getElementById('coupon');
  const couponApply = document.getElementById('couponApply');
  const couponMsg = document.getElementById('couponMsg');
  const summary = document.getElementById('paySummary');
  const sumQty = document.getElementById('sumQty');
  const sumSubtotal = document.getElementById('sumSubtotal');
  const sumDiscountRow = document.getElementById('sumDiscountRow');
  const sumCoupon = document.getElementById('sumCoupon');
  const sumDiscount = document.getElementById('sumDiscount');
  const sumTotal = document.getElementById('sumTotal');
  const payButton = document.getElementById('payButton');

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
        body: JSON.stringify({
          amount: amountInput ? amountInput.value : undefined,
          quantity: qtyInput ? qtyInput.value : undefined,
          coupon: appliedCoupon,
        }),
      });
      const q = await res.json();
      if (mine !== seq || !res.ok) return;
      if (sumQty) sumQty.textContent = `(× ${q.quantity})`;
      sumSubtotal.textContent = q.display.subtotal;
      sumDiscountRow.hidden = !q.hasDiscount;
      sumCoupon.textContent = q.coupon ? q.coupon.code : '';
      sumDiscount.textContent = `−${q.display.discount}`;
      sumTotal.textContent = q.display.total;
      payButton.textContent = `${cta} · ${q.display.total}`;
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

  if (amountInput) amountInput.addEventListener('input', refreshSoon);

  if (qtyInput) {
    const stepper = qtyInput.closest('.pp-qty');
    const max = Number(stepper.dataset.max) || 1;
    const buttons = stepper.querySelectorAll('.pp-qty-btn');
    const clampQty = () => {
      const n = Math.min(max, Math.max(1, Math.round(Number(qtyInput.value) || 1)));
      qtyInput.value = n;
      buttons[0].disabled = n <= 1;
      buttons[1].disabled = n >= max;
    };
    buttons.forEach((btn) => btn.addEventListener('click', () => {
      qtyInput.value = (Number(qtyInput.value) || 1) + Number(btn.dataset.step);
      clampQty();
      refreshSoon();
    }));
    qtyInput.addEventListener('change', () => { clampQty(); refreshSoon(); });
    clampQty();
  }

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
