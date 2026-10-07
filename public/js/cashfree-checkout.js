// Opens Cashfree's checkout for the #cfPay button (payment-checkout.ejs,
// app-booking-status.ejs). The button carries the payment session the
// server created; Cashfree sends the buyer back to our return_url, where the
// server checks with Cashfree whether they paid. data-auto opens it straight
// away (first visit), so the buyer doesn't have to click twice.
(function () {
  var btn = document.getElementById('cfPay');
  if (!btn || typeof window.Cashfree !== 'function') return;
  var cashfree = window.Cashfree({ mode: btn.dataset.env === 'production' ? 'production' : 'sandbox' });
  function pay() {
    btn.disabled = true;
    cashfree.checkout({ paymentSessionId: btn.dataset.session, redirectTarget: '_self' })
      .then(function (result) {
        // Only reached when checkout couldn't open (redirects leave the page).
        if (result && result.error) {
          console.error('Cashfree checkout:', result.error);
          btn.disabled = false;
        }
      });
  }
  btn.addEventListener('click', pay);
  if (btn.dataset.auto) pay();
})();
