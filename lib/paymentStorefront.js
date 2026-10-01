// The buyer-facing side of payment pages, on the merchant's store
// subdomain (lib/storefront.js routes /pay/... here):
//
//   GET  /pay/:slug                    the page: price, quantity, coupon, buyer details
//   POST /pay/:slug                    place the order → checkout (test) or receipt
//   POST /pay/:slug/quote              live total for the page's script (JSON)
//   GET  /pay/:slug/checkout/:token    test-mode checkout screen
//   POST /pay/:slug/checkout/:token    complete / cancel the test payment
//   GET  /pay/:slug/order/:token       receipt — reveals the delivery link once paid
//
// The page works without JavaScript (plain form posts); the script only
// adds the live total and the inline coupon check, both answered by the
// same quote() that prices the real order.
const crypto = require('crypto');
const { getPublicPaymentPage, incrementPageViews, quote, formatINR } = require('./paymentPages');
const { createOrder, getOrderByToken, markOrderPaid, cancelOrder } = require('./orders');
const { paymentMode } = require('./payments');

const PAY_PATH = /^\/pay\/([a-z0-9-]+)(?:\/(quote|checkout|order)(?:\/([0-9a-f]{32}))?)?\/?$/;

// Which payment route this request is, or null if it isn't one.
function matchPaymentPath(req) {
  const m = req.path.toLowerCase().match(PAY_PATH);
  if (!m) return null;
  const [, slug, action = 'page', token] = m;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const ok = (action === 'page' && !token && (isRead || req.method === 'POST'))
    || (action === 'quote' && !token && req.method === 'POST')
    || (action === 'checkout' && token && (isRead || req.method === 'POST'))
    || (action === 'order' && token && isRead);
  return ok ? { slug, action, token } : null;
}

function readBuyer(page, body) {
  return {
    name: String(body?.name || '').trim().slice(0, 200),
    email: String(body?.email || '').trim().slice(0, 255),
    phone: page.collect_phone ? String(body?.phone || '').trim().slice(0, 30) : '',
  };
}

function buyerError(page, buyer) {
  if (!buyer.name) return 'Add your name to continue.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email)) return 'That email address doesn’t look right.';
  if (page.collect_phone && !/^\+?[\d\s().-]{6,}$/.test(buyer.phone)) return 'Add a phone number we can reach you on.';
  return null;
}

async function handlePaymentRequest(req, res, owner, { slug, action, token }, { siteName }) {
  const page = await getPublicPaymentPage(owner.id, slug);
  if (!page) {
    if (action === 'quote') return res.status(404).json({ error: 'This page isn’t available.' });
    return res.status(404).render('error', {
      title: `Not found — ${siteName}`,
      heading: 'This link isn’t live',
      message: 'This payment page doesn’t exist, or the creator has taken it down.',
    });
  }
  const base = `/pay/${page.slug}`;
  const mode = paymentMode();

  // --- live total -------------------------------------------------------
  if (action === 'quote') {
    const q = await quote(owner.id, page, req.body || {});
    return res.json({
      error: q.error,
      couponError: q.couponError,
      coupon: q.coupon,
      quantity: q.quantity,
      display: q.display,
      hasDiscount: q.discount > 0,
      total: q.total,
    });
  }

  // --- the page + placing the order -------------------------------------
  if (action === 'page') {
    const values = {
      name: '', email: '', phone: '',
      amount: page.price_type === 'flexible' ? ((page.suggested_price || page.min_price) / 100 || '') : '',
      quantity: 1,
      coupon: '',
    };
    const render = async (status, error) => {
      const q = await quote(owner.id, page, values);
      res.status(status).render('payment-page', {
        title: `${page.title} — ${owner.name}`,
        owner, page, values, error, q, mode,
        priceLabel: page.price_type === 'flexible'
          ? (page.min_price ? `Pay what you want · min ${formatINR(page.min_price)}` : 'Pay what you want')
          : formatINR(page.price),
        formatINR,
      });
    };

    if (req.method !== 'POST') {
      if (req.method === 'GET') incrementPageViews(page.id).catch((err) => console.error('Page view count failed:', err));
      return render(200, null);
    }

    Object.assign(values, readBuyer(page, req.body), {
      amount: String(req.body?.amount ?? values.amount).slice(0, 20),
      quantity: req.body?.quantity ?? 1,
      coupon: String(req.body?.coupon || '').slice(0, 30),
    });
    const q = await quote(owner.id, page, values);
    const problem = q.error || buyerError(page, values) || q.couponError;
    if (problem) return render(400, problem);

    const order = await createOrder(owner.id, page, values, q);
    // Nothing to collect (a 100% coupon, or ₹0 on pay-what-you-want).
    if (order.total === 0) {
      await markOrderPaid(owner.id, order.id, { provider: 'free' });
      return res.redirect(303, `${base}/order/${order.token}`);
    }
    if (mode === 'test') return res.redirect(303, `${base}/checkout/${order.token}`);
    return res.redirect(303, `${base}/order/${order.token}`);
  }

  const order = await getOrderByToken(owner.id, token);
  if (!order || order.page_id !== page.id) {
    return res.status(404).render('error', {
      title: `Not found — ${siteName}`,
      heading: 'Order not found',
      message: 'This order link isn’t valid. Check the link in your confirmation, or start again from the payment page.',
    });
  }

  // --- test checkout ----------------------------------------------------
  if (action === 'checkout') {
    // Only test mode has a checkout screen; anything already settled (or
    // a manual-mode order) goes straight to its receipt.
    if (mode !== 'test' || order.status !== 'pending') return res.redirect(303, `${base}/order/${order.token}`);
    if (req.method === 'POST') {
      if (req.body?.result === 'cancel') await cancelOrder(owner.id, order.id);
      else await markOrderPaid(owner.id, order.id, { provider: 'test', ref: `test_${crypto.randomBytes(6).toString('hex')}` });
      return res.redirect(303, `${base}/order/${order.token}`);
    }
    return res.render('payment-checkout', {
      title: `Checkout — ${page.title}`,
      owner, page, order, formatINR,
    });
  }

  // --- receipt ------------------------------------------------------------
  return res.render('payment-receipt', {
    title: `${order.status === 'paid' ? 'Payment received' : 'Your order'} — ${page.title}`,
    owner, page, order, mode, formatINR,
  });
}

module.exports = { matchPaymentPath, handlePaymentRequest };
