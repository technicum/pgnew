// How a payment page or a paid booking actually collects money. Three modes:
//
//   test     — a simulated checkout screen ("Complete test payment"), clearly
//              labelled; nothing is charged. The default outside production,
//              or anywhere with PAYMENTS_MODE=test.
//   manual   — the order is placed as "pending" and the merchant marks it
//              paid from Orders once they've been paid some other way (UPI,
//              bank transfer). The default in production, so a live store is
//              never handing out paid downloads for a test click.
//   cashfree — Cashfree Payment Gateway (PAYMENTS_MODE=cashfree plus
//              CASHFREE_APP_ID / CASHFREE_SECRET_KEY, and CASHFREE_ENV=
//              production for real money — anything else is the sandbox).
//              The buyer pays on Cashfree's own checkout; we never see card
//              or UPI details. Money lands in the one Cashfree account those
//              keys belong to (PageZaper's), not the creator's.
//
// Cashfree is never trusted from the browser: an order is marked paid only
// after we ask Cashfree's API ourselves (syncGatewayOrder) — from the
// buyer's return_url, from the signed webhook, or when a hold lapses — and
// the amount Cashfree says it collected matches the order's total.
const crypto = require('crypto');

const API_VERSION = '2023-08-01';
// Where Cashfree posts payment events (server.js); CASHFREE_WEBHOOK_URL overrides.
const WEBHOOK_URL = 'https://pagezaper.com/webhooks/cashfree';

function cashfreeConfig() {
  const appId = String(process.env.CASHFREE_APP_ID || '').trim();
  const secret = String(process.env.CASHFREE_SECRET_KEY || '').trim();
  if (!appId || !secret) return null;
  const env = String(process.env.CASHFREE_ENV || '').toLowerCase() === 'production' ? 'production' : 'sandbox';
  return {
    appId,
    secret,
    env,
    baseUrl: env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg',
  };
}

let warnedNoKeys = false;
function paymentMode() {
  const mode = String(process.env.PAYMENTS_MODE || '').toLowerCase();
  if (mode === 'test' || mode === 'manual') return mode;
  if (mode === 'cashfree') {
    if (cashfreeConfig()) return 'cashfree';
    if (!warnedNoKeys) {
      warnedNoKeys = true;
      console.error('PAYMENTS_MODE=cashfree but CASHFREE_APP_ID / CASHFREE_SECRET_KEY are missing — falling back.');
    }
  }
  return process.env.NODE_ENV === 'production' ? 'manual' : 'test';
}

// 'sandbox' | 'production' — the checkout script needs to know which.
function gatewayEnv() {
  const cfg = cashfreeConfig();
  return cfg ? cfg.env : 'sandbox';
}

async function cashfree(method, path, body) {
  const cfg = cashfreeConfig();
  if (!cfg) throw new Error('Cashfree is not configured');
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'x-client-id': cfg.appId,
      'x-client-secret': cfg.secret,
      'x-api-version': API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Cashfree ${method} ${path} → ${res.status}: ${data.message || 'request failed'}`);
    err.status = res.status;
    err.cashfree = data;
    throw err;
  }
  return data;
}

// Cashfree insists on a 10-digit phone. Most of our checkouts don't ask for
// one, so a buyer without one gets a placeholder — Cashfree's own checkout
// asks for whatever the payment method (UPI, wallet) really needs.
function cashfreePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '9999999999';
}

// A payment session for this order's Cashfree checkout — the one already
// open when there is one, else a new Cashfree order. `{ paid: true }` when
// it turns out to be paid already.
async function startGatewayCheckout(order, returnUrl) {
  const { setGatewayOrder } = require('./orders');
  if (order.gateway_order) {
    const existing = await cashfree('GET', `/orders/${encodeURIComponent(order.gateway_order)}`);
    if (existing.order_status === 'PAID') {
      await syncGatewayOrder(order);
      return { paid: true };
    }
    if (existing.order_status === 'ACTIVE' && existing.payment_session_id) {
      return { sessionId: existing.payment_session_id };
    }
  }
  const gatewayOrder = `pz${order.id}_${crypto.randomBytes(4).toString('hex')}`;
  const meta = { return_url: returnUrl };
  // Cashfree only posts webhooks to https, so a local (http) checkout
  // relies on the return_url alone.
  if (/^https:\/\//i.test(returnUrl)) meta.notify_url = process.env.CASHFREE_WEBHOOK_URL || WEBHOOK_URL;
  const created = await cashfree('POST', '/orders', {
    order_id: gatewayOrder,
    order_amount: order.total / 100,
    order_currency: order.currency || 'INR',
    customer_details: {
      customer_id: `pzbuyer_${order.id}`,
      customer_name: order.buyer_name || undefined,
      customer_email: order.buyer_email || undefined,
      customer_phone: cashfreePhone(order.buyer_phone),
    },
    order_meta: meta,
    order_note: String(order.page_title || '').slice(0, 200) || undefined,
    order_tags: { pz_order: String(order.id), pz_user: String(order.user_id) },
  });
  await setGatewayOrder(order.id, gatewayOrder);
  return { sessionId: created.payment_session_id };
}

// Asks Cashfree whether this order's been paid; if so (and for the right
// amount) marks it paid here. Returns true when the order is paid.
async function syncGatewayOrder(order) {
  const { markOrderPaid } = require('./orders');
  if (order.status === 'paid') return true;
  if (!order.gateway_order || !cashfreeConfig()) return false;
  let cf;
  try {
    cf = await cashfree('GET', `/orders/${encodeURIComponent(order.gateway_order)}`);
  } catch (err) {
    // Unreachable for now — the webhook or the next visit tries again.
    console.error('Checking Cashfree order failed:', err.message);
    return false;
  }
  if (cf.order_status !== 'PAID') return false;
  if (Math.round(Number(cf.order_amount) * 100) !== order.total) {
    console.error(`Cashfree order ${order.gateway_order} paid ${cf.order_amount} but order ${order.id} is ${order.total} paise — not marking paid.`);
    return false;
  }
  if (order.status === 'cancelled') {
    console.error(`Cashfree order ${order.gateway_order} was PAID but order ${order.id} is already cancelled — refund it from the Cashfree dashboard.`);
    return false;
  }
  let ref = order.gateway_order;
  try {
    const payments = await cashfree('GET', `/orders/${encodeURIComponent(order.gateway_order)}/payments`);
    const ok = (Array.isArray(payments) ? payments : []).find((p) => p.payment_status === 'SUCCESS');
    if (ok && ok.cf_payment_id) ref = String(ok.cf_payment_id);
  } catch (err) {
    console.error('Fetching Cashfree payment id failed:', err.message);
  }
  await markOrderPaid(order.user_id, order.id, { provider: 'cashfree', ref });
  return true;
}

// Before an order with an open Cashfree checkout is cancelled: if it was
// paid after all, it's marked paid (returns true) instead; otherwise the
// Cashfree order is terminated so nobody can pay it later.
async function closeGatewayOrder(order) {
  if (!order.gateway_order || !cashfreeConfig()) return false;
  if (await syncGatewayOrder(order)) return true;
  try {
    await cashfree('PATCH', `/orders/${encodeURIComponent(order.gateway_order)}`, { order_status: 'TERMINATED' });
  } catch (err) {
    // A payment mid-flight can't be terminated — check once more.
    if (await syncGatewayOrder(order)) return true;
    console.error('Terminating Cashfree order failed:', err.message);
  }
  return false;
}

// The buyer is back from Cashfree's checkout (?cf=return) without paying:
// did they cancel it themselves — pressed Cancel / Back on Cashfree's page
// — rather than have a payment fail (a declined card), where they should
// get to try again? Cashfree marks an abandoned attempt USER_DROPPED (or
// CANCELLED / NOT_ATTEMPTED); leaving before picking a method leaves no
// attempt at all. A payment still in flight (PENDING, e.g. a UPI request
// not yet approved) or a successful one is never treated as a cancel.
const DROPPED = new Set(['USER_DROPPED', 'CANCELLED', 'NOT_ATTEMPTED', 'VOID']);
async function buyerCancelledOnGateway(order) {
  if (!order.gateway_order || order.status !== 'pending' || !cashfreeConfig()) return false;
  let payments;
  try {
    payments = await cashfree('GET', `/orders/${encodeURIComponent(order.gateway_order)}/payments`);
  } catch (err) {
    console.error('Checking Cashfree payments failed:', err.message);
    return false;
  }
  const list = Array.isArray(payments) ? payments : [];
  if (list.some((p) => p.payment_status === 'SUCCESS' || p.payment_status === 'PENDING')) return false;
  if (!list.length) return true;
  const latest = list.reduce((a, b) => (new Date(b.payment_time || 0) > new Date(a.payment_time || 0) ? b : a));
  return DROPPED.has(latest.payment_status);
}

// POST /webhooks/cashfree — signed with our secret over timestamp + raw
// body. The payload only tells us which order to look at; whether it's
// paid comes from Cashfree's API.
async function handleCashfreeWebhook(req, res) {
  const cfg = cashfreeConfig();
  if (!cfg) return res.status(404).end();
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const timestamp = String(req.get('x-webhook-timestamp') || '');
  const signature = String(req.get('x-webhook-signature') || '');
  const expected = crypto.createHmac('sha256', cfg.secret).update(timestamp + raw).digest('base64');
  const valid = signature.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return res.status(401).end();

  const gatewayOrder = req.body?.data?.order?.order_id;
  if (gatewayOrder) {
    const { getOrderByGatewayOrder } = require('./orders');
    const order = await getOrderByGatewayOrder(String(gatewayOrder));
    if (order) await syncGatewayOrder(order);
  }
  return res.status(200).json({ ok: true });
}

module.exports = {
  paymentMode,
  gatewayEnv,
  startGatewayCheckout,
  syncGatewayOrder,
  closeGatewayOrder,
  buyerCancelledOnGateway,
  handleCashfreeWebhook,
};
