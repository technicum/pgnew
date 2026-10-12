// The buyer-facing side of payment pages, on the merchant's store
// subdomain (lib/storefront.js routes /pay/... here):
//
//   GET  /pay/:slug                    the page: products, buyer details, coupon
//   POST /pay/:slug                    place the order → checkout (test) or receipt
//   POST /pay/:slug/quote              live total for the page's script (JSON)
//   POST /pay/:slug/draft              save the checkout in progress (abandoned carts)
//   GET  /pay/:slug/checkout/:token    checkout: test screen, or Cashfree (also its return_url)
//   POST /pay/:slug/checkout/:token    complete (test only) / cancel the payment
//   GET  /pay/:slug/order/:token       receipt — reveals the file links once paid
//
// The page works without JavaScript (plain form posts — each product's
// choice arrives as qty_<id> / amount_<id>); the script only adds the live
// total and inline coupon check, both answered by the same quote() that
// prices the real order.
const crypto = require('crypto');
const { getPublicPaymentPage, incrementPageViews, quote, maxQtyFor, productMedia, formatINR } = require('./paymentPages');
const { createOrder, getOrderByToken, markOrderPaid, cancelOrder } = require('./orders');
const { paymentMode, gatewayEnv, startGatewayCheckout, syncGatewayOrder } = require('./payments');
const { renderRichText } = require('./richText');
const { listAddresses, getAddress, addAddress } = require('./customers');
const { saveDraft, newDraftKey } = require('./checkoutDrafts');
const { feeFor } = require('./platform');

const PAY_PATH = /^\/pay\/([a-z0-9-]+)(?:\/(quote|draft|checkout|order)(?:\/([0-9a-f]{32}))?)?\/?$/;

// Which payment route this request is, or null if it isn't one.
function matchPaymentPath(req) {
  const m = req.path.toLowerCase().match(PAY_PATH);
  if (!m) return null;
  const [, slug, action = 'page', token] = m;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const ok = (action === 'page' && !token && (isRead || req.method === 'POST'))
    || ((action === 'quote' || action === 'draft') && !token && req.method === 'POST')
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

// What a fresh visit's checkout starts with: a signed-in buyer's name and
// email, their default address, and each product's starting pick.
function startingValues(page, customer = null, addresses = []) {
  const values = {
    name: customer ? customer.name : '',
    email: customer ? customer.email : '',
    phone: '', address: '', city: '', pincode: '', note: '', coupon: '', items: {},
    addressId: addresses.length ? String(addresses[0].id) : 'new',
    saveAddress: true,
    // This visit's checkout, for the abandoned-carts list.
    draftKey: newDraftKey(),
  };
  const layout = layoutFor(page);
  page.products.forEach((p) => {
    // A lone coffee starts on ×2, the design's pre-picked amount; a
    // multi-product page starts with an empty cart.
    const qty = layout === 'multi' ? 0 : (p.type === 'coffee' && layout === 'coffee' ? 2 : 1);
    values.items[p.id] = { qty, amount: p.pricing === 'pwyw' ? ((p.suggested || p.minimum || 0) / 100 || '') : undefined };
  });
  return values;
}

// Everything views/payment-page.ejs is rendered with — for the live page,
// and for the builder's preview (lib/livePreview.js).
async function pageLocals(owner, page, { values, error = null, mode = paymentMode(), customer = null, addresses = [] }) {
  return {
    title: `${page.title} — ${owner.name}`,
    owner, page, values, error, mode, formatINR, maxQtyFor, productMedia, layout: layoutFor(page),
    q: await quote(owner.id, page, values),
    customer, addresses,
    aboutHtml: renderRichText(page.about),
  };
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
    if (action === 'quote' || action === 'draft') return res.status(404).json({ error: 'This page isn’t available.' });
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

  // --- checkout in progress (abandoned carts) ----------------------------
  // Sent by the page's script once there's a valid email and something in
  // the cart. Only what the server prices itself is stored.
  if (action === 'draft') {
    const body = req.body || {};
    const email = String(body.email || '').trim().slice(0, 255);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ ok: false });
    const q = await quote(owner.id, page, { items: body.items, coupon: body.coupon });
    if (!q.lines.length) return res.json({ ok: false });
    await saveDraft(owner.id, page, body.key, { name: String(body.name || '').trim(), email, phone: String(body.phone || '').trim() }, q);
    return res.json({ ok: true });
  }

  // --- the page + placing the order -------------------------------------
  if (action === 'page') {
    // A buyer signed in on this store (lib/customerAccount.js): their name
    // and email prefill checkout, and a page that ships offers their saved
    // addresses — the default one picked — or a new one they can save.
    const customer = req.session.customer || null;
    const addresses = customer && page.has_physical ? await listAddresses(customer.id) : [];
    const values = startingValues(page, customer, addresses);
    const render = async (status, error) => {
      res.status(status).render('payment-page', await pageLocals(owner, page, { values, error, mode, customer, addresses }));
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
      addressId: customer && addresses.length ? String(req.body?.address_id || 'new') : 'new',
      draftKey: /^[0-9a-f]{32}$/.test(String(req.body?.draft_key || '')) ? req.body.draft_key : newDraftKey(),
      saveAddress: req.body?.save_address === '1',
    });
    // Delivering to one of their saved addresses: it's looked up as theirs,
    // whatever else was posted.
    let addressMissing = false;
    if (page.has_physical && values.addressId !== 'new') {
      const saved = await getAddress(customer.id, values.addressId);
      if (saved) {
        buyer.address = { line: saved.line, city: saved.city, pincode: saved.pincode };
        buyer.phone = saved.phone;
      } else {
        addressMissing = true;
      }
    }
    const q = await quote(owner.id, page, values);
    // A cart with nothing physical in it has nowhere to ship.
    if (!q.hasPhysical) Object.assign(buyer, { phone: '', address: null });
    const problem = q.error || (addressMissing && buyer.address ? 'Pick a delivery address.' : null) || buyerError(buyer) || q.couponError;
    if (problem) return render(400, problem);

    const order = await createOrder(owner.id, page, buyer, q, await feeFor(req));
    // Linked to its checkout: paid, it drops off the abandoned list.
    await saveDraft(owner.id, page, values.draftKey, buyer, q, { orderId: order.id })
      .catch((err) => console.error('Saving checkout draft failed:', err));
    // "Save this address to my account" on a new address — best-effort;
    // the order is already placed.
    if (customer && buyer.address && values.addressId === 'new' && values.saveAddress) {
      await addAddress(customer.id, { label: '', name: buyer.name, ...buyer.address, phone: buyer.phone })
        .catch((err) => { if (err.code !== 'TOO_MANY_ADDRESSES') console.error('Saving address failed:', err); });
    }
    // Nothing to collect (a 100% coupon on digital items, or ₹0 pay-what-you-want).
    if (order.total === 0) {
      await markOrderPaid(owner.id, order.id, { provider: 'free' });
      return res.redirect(303, `${base}/order/${order.token}`);
    }
    if (mode === 'test' || mode === 'cashfree') return res.redirect(303, `${base}/checkout/${order.token}`);
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

  // --- checkout -----------------------------------------------------------
  if (action === 'checkout') {
    // Test and Cashfree modes have a checkout screen; anything already
    // settled (or a manual-mode order) goes straight to its receipt.
    const receipt = `${base}/order/${order.token}`;
    if ((mode !== 'test' && mode !== 'cashfree') || order.status !== 'pending') return res.redirect(303, receipt);

    if (mode === 'cashfree') {
      if (req.method === 'POST') {
        if (req.body?.result === 'cancel') await cancelOrder(owner.id, order.id);
        return res.redirect(303, receipt);
      }
      // Back from Cashfree (?cf=return), or any visit: paid already?
      if (await syncGatewayOrder(order)) return res.redirect(303, receipt);
      let session = null;
      let gatewayError = null;
      try {
        session = await startGatewayCheckout(order, `${req.protocol}://${req.get('host')}${base}/checkout/${order.token}?cf=return`);
      } catch (err) {
        console.error('Starting Cashfree checkout failed for order', order.id, err.message, err.cashfree || '');
        gatewayError = 'We couldn’t reach the payment gateway just now. Please try again in a minute.';
      }
      if (session && session.paid) return res.redirect(303, receipt);
      return res.render('payment-checkout', {
        title: `Checkout — ${page.title}`,
        owner, page, order, formatINR, mode,
        gateway: session ? { sessionId: session.sessionId, env: gatewayEnv() } : null,
        gatewayError,
        // Came back from Cashfree's page without paying.
        retry: req.query.cf === 'return',
      });
    }

    if (req.method === 'POST') {
      if (req.body?.result === 'cancel') await cancelOrder(owner.id, order.id);
      else await markOrderPaid(owner.id, order.id, { provider: 'test', ref: `test_${crypto.randomBytes(6).toString('hex')}` });
      return res.redirect(303, `${base}/order/${order.token}`);
    }
    return res.render('payment-checkout', {
      title: `Checkout — ${page.title}`,
      owner, page, order, formatINR, mode, gateway: null, gatewayError: null, retry: false,
    });
  }

  // --- receipt ------------------------------------------------------------
  // Paid on Cashfree but the webhook hasn't landed yet: catch up here.
  if (mode === 'cashfree' && order.status === 'pending' && order.gateway_order && await syncGatewayOrder(order)) {
    return res.redirect(303, `${base}/order/${order.token}`);
  }
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

module.exports = { matchPaymentPath, handlePaymentRequest, startingValues, pageLocals };
