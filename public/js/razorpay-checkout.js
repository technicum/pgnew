// Opens Razorpay's checkout for the #rzpPay button (partials/gateway-pay).
// The button carries the Razorpay order the server created. Whether the
// buyer pays or closes the checkout, they're sent to the return URL, where
// the server asks Razorpay what happened — nothing here is trusted.
// data-auto opens it straight away (first visit), so the buyer doesn't have
// to click twice. A failed attempt is retried inside Razorpay's own modal.
(function () {
  var btn = document.getElementById('rzpPay');
  if (!btn || typeof window.Razorpay !== 'function') return;
  var d = btn.dataset;
  var leaving = false;
  function back() {
    if (leaving) return;
    leaving = true;
    window.location.href = d.return;
  }
  var rzp = new window.Razorpay({
    key: d.key,
    order_id: d.order,
    amount: d.amount,
    currency: d.currency,
    name: d.merchant,
    description: d.description,
    prefill: { name: d.name, email: d.email, contact: d.contact },
    handler: back,
    modal: { ondismiss: back },
  });
  function pay() {
    btn.disabled = true;
    rzp.open();
  }
  btn.addEventListener('click', pay);
  if (d.auto) pay();
})();
