/* PageZaper Pay — opens Razorpay's checkout on WooCommerce's order-pay page.
 * Whatever Razorpay's success callback says, the order is only marked paid
 * after the server asks PageZaper (see handle_callback in the gateway). */
(function () {
  'use strict';
  var cfg = window.PageZaperPay;
  var button = document.getElementById('pagezaper-pay-button');
  var closed = document.getElementById('pagezaper-pay-closed');
  if (!cfg || !button || typeof window.Razorpay !== 'function') return;

  function open() {
    var rzp = new window.Razorpay({
      key: cfg.key,
      order_id: cfg.order_id,
      amount: cfg.amount,
      currency: cfg.currency,
      name: cfg.name,
      description: cfg.description,
      prefill: cfg.prefill,
      handler: function () {
        button.disabled = true;
        window.location.href = cfg.return_url;
      },
      modal: {
        ondismiss: function () {
          if (closed) closed.style.display = '';
          button.disabled = false;
        },
      },
    });
    rzp.on('payment.failed', function () {
      button.disabled = false;
    });
    button.disabled = true;
    rzp.open();
  }

  button.addEventListener('click', open);
  open();
})();
