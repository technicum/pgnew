// The buyer-facing side of payment pages, on the merchant's store
// subdomain (lib/storefront.js routes /pay/... here):
//
//   GET  /pay/:slug                    the page: products, buyer details, coupon
//   POST /pay/:slug                    place the order → checkout (test) or receipt
//   POST /pay/:slug/quote              live total for the page's script (JSON)
//   GET  /pay/:slug/checkout/:token    test-mode checkout screen
//   POST /pay/:slug/checkout/:token    complete / cancel the test payment
//   GET  /pay/:slug/order/:token       receipt — reveals the file links once paid
//
// The page works without JavaScript (plain form posts — each product's
// choice arrives as qty_<id> / amount_<id>); the script only adds the live
// total and inline coupon check, both answered by the same quote() that
// prices the real order.
const crypto = require('crypto');
const { getPublicPaymentPage, incrementPageViews, quote, maxQtyFor, productMedia, formatINR } = require('./paymentPages');
const { createOrder, getOrderByToken, markOrderPaid, cancelOrder } = require('./orders');
const { paymentMode } = require('./payments');
const { renderRichText } = require('./richText');

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

// What the buyer chose for each product, from the plain form post.
function readItems(page, body) {
  const items = {};
  page.products.forEach((p) => {
    items[p.id] = {
      qty: body?.[`qty_${p.id}`],
      amount: body?.[`amount_${p.id}`] !== undefined ? String(body[`amount_${p.id}`]).slice(0, 20) : undefined,
    };
  });
  return items;
}

// Which of the three page designs this page gets: a lone "buy me a
// coffee" is a support card, one product a single-product checkout, and
// anything else a store where the buyer adds the products they want.
function layoutFor(page) {
  if (page.products.length === 1) return page.products[0].type === 'coffee' ? 'coffee' : 'single';
  return 'multi';
}

function readBuyer(page, body) {
  const buyer = {
    name: String(body?.name || '').trim().slice(0, 200),
    email: String(body?.email || '').trim().slice(0, 255),
    // The optional message left with a "buy me a coffee".
    note: String(body?.note || '').trim().slice(0, 300),
    phone: '',
    address: null,
  };
  // Only a page with something to post asks for an address (and an
  // optional phone for the courier).
  if (page.has_physical) {
    buyer.phone = String(body?.phone || '').trim().slice(0, 30);
    buyer.address = {
      line: String(body?.address || '').trim().slice(0, 200),
      city: String(body?.city || '').trim().slice(0, 80),
      pincode: String(body?.pincode || '').trim().slice(0, 10),
    };
  }
  return buyer;
}

function buyerError(buyer) {
  if (!buyer.name) return 'Add your name to continue.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email)) return 'That email address doesn’t look right.';
  if (buyer.address) {
    if (buyer.address.line.length < 5) return 'Add the address we should ship to.';
    if (!buyer.address.city) return 'Add your city.';
    if (!/^\d{6}$/.test(buyer.address.pincode)) return 'Pincodes are 6 digits.';
    // Optional (the page asks for it "for delivery updates") — but if it's
    // given, it has to look like a phone number.
    if (buyer.phone && !/^\+?[\d\s().-]{6,}$/.test(buyer.phone)) return 'That phone number doesn’t look right.';
  }
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
      lines: q.lines.map((l) => ({ id: l.id, title: l.title, qty: l.qty })),
      display: q.display,
      hasDiscount: q.discount > 0,
      hasShipping: q.hasPhysical,
      total: q.total,
    });
  }

  // --- the page + placing the order -------------------------------------
  if (action === 'page') {
    const values = { name: '', email: '', phone: '', address: '', city: '', pincode: '', note: '', coupon: '', items: {} };
    page.products.forEach((p) => {
      // A lone coffee starts on ×2, the design's pre-picked amount; a
      // multi-product page starts with an empty cart.
      const layout = layoutFor(page);
      const qty = layout === 'multi' ? 0 : (p.type === 'coffee' && layout === 'coffee' ? 2 : 1);
      values.items[p.id] = { qty, amount: p.pricing === 'pwyw' ? ((p.suggested || p.minimum || 0) / 100 || '') : undefined };
    });
    const render = async (status, error) => {
      const q = await quote(owner.id, page, values);
      res.status(status).render('payment-page', {
        title: `${page.title} — ${owner.name}`,
        owner, page, values, error, q, mode, formatINR, maxQtyFor, productMedia, layout: layoutFor(page),
        aboutHtml: renderRichText(page.about),
      });
    };

    if (req.method !== 'POST') {
      if (req.method === 'GET') incrementPageViews(page.id).catch((err) => console.error('Page view count failed:', err));
      return render(200, null);
    }

    const buyer = readBuyer(page, req.body);
    Object.assign(values, {
      name: buyer.name,
      email: buyer.email,
      note: buyer.note,
      phone: buyer.phone,
      address: buyer.address ? buyer.address.line : '',
      city: buyer.address ? buyer.address.city : '',
      pincode: buyer.address ? buyer.address.pincode : '',
      coupon: String(req.body?.coupon || '').slice(0, 30),
      items: readItems(page, req.body),
    });
    const q = await quote(owner.id, page, values);
    // A cart with nothing physical in it has nowhere to ship.
    if (!q.hasPhysical) Object.assign(buyer, { phone: '', address: null });
    const problem = q.error || buyerError(buyer) || q.couponError;
    if (problem) return render(400, problem);

    const order = await createOrder(owner.id, page, buyer, q);
    // Nothing to collect (a 100% coupon on digital items, or ₹0 pay-what-you-want).
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
  // File links come from the page as it is now (a fixed link is better
  // than a dead one), matched to what this order actually bought.
  const files = order.status === 'paid'
    ? order.items
      .filter((i) => i.type === 'digital')
      .map((i) => ({ title: i.title, url: (page.products.find((p) => p.id === i.id && p.type === 'digital') || {}).fileUrl || '' }))
      .filter((f) => /^https?:\/\//i.test(f.url))
    : [];
  return res.render('payment-receipt', {
    title: `${order.status === 'paid' ? 'Payment received' : 'Your order'} — ${page.title}`,
    owner, page, order, mode, formatINR, files,
  });
}

module.exports = { matchPaymentPath, handlePaymentRequest };
