// How a payment page actually collects money. There's no gateway wired up
// yet, so for now this is just a switch between two gateway-less modes —
// and the one seam a real provider (Razorpay etc.) slots into later: it
// becomes a third mode that sends the buyer from /pay/:slug/checkout/:token
// to the gateway and calls markOrderPaid() (lib/orders.js) from its
// verified callback/webhook instead of from the test button.
//
//   test   — a simulated checkout screen ("Complete test payment"), clearly
//            labelled; nothing is charged. The default outside production,
//            or anywhere with PAYMENTS_MODE=test.
//   manual — the order is placed as "pending" and the merchant marks it
//            paid from Orders once they've been paid some other way (UPI,
//            bank transfer). The default in production, so a live store is
//            never handing out paid downloads for a test click.
function paymentMode() {
  const mode = String(process.env.PAYMENTS_MODE || '').toLowerCase();
  if (mode === 'test' || mode === 'manual') return mode;
  return process.env.NODE_ENV === 'production' ? 'manual' : 'test';
}

module.exports = { paymentMode };
