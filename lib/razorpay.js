// Razorpay — the second payment gateway (lib/payments.js picks it when it's
// switched on). Unlike Cashfree, it's set up from the admin panel
// (/admin/payments), not .env: a test and a live set of keys, and a switch
// for which one checkout uses — Off, Test or Live. Settings live in
// PDZ_platform_settings (lib/platform.js) and are cached here so
// paymentMode() can stay synchronous; saving refreshes the cache, and a
// stale one (another process saved) reloads in the background.
//
// Like Cashfree, nothing from the browser is trusted: an order is marked
// paid only after we ask Razorpay's API ourselves (syncOrder) and the
// captured amount matches the order's total. Our orders keep the Razorpay
// order id with the key set it belongs to — "rzp_test:order_…" — so a
// switch from Test to Live never asks the live account about a test order.
const crypto = require('crypto');
const { getSettings, saveSettings } = require('./platform');

const API = 'https://api.razorpay.com/v1';
const MODES = ['off', 'test', 'live'];
const KEYS = ['key_id', 'key_secret', 'webhook_secret'];
const NAMES = ['razorpay_mode', ...['test', 'live'].flatMap((m) => KEYS.map((k) => `razorpay_${m}_${k}`))];
const STALE_MS = 30 * 1000;

let cache = null;
let loadedAt = 0;
let loading = null;

function fromRows(rows) {
  const set = (m) => Object.fromEntries(KEYS.map((k) => [k, String(rows[`razorpay_${m}_${k}`] || '').trim()]));
  return {
    mode: MODES.includes(rows.razorpay_mode) ? rows.razorpay_mode : 'off',
    test: set('test'),
    live: set('live'),
  };
}

async function loadSettings() {
  if (!loading) {
    loading = getSettings(NAMES)
      .then((rows) => {
        cache = fromRows(rows);
        loadedAt = Date.now();
        return cache;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

// The cached settings, reloading in the background once they're stale.
function settings() {
  if (Date.now() - loadedAt > STALE_MS && !loading) {
    loadSettings().catch((err) => console.error('Loading Razorpay settings failed:', err.message));
  }
  return cache || fromRows({});
}

// { mode, keyId, keySecret, webhookSecret } for a key set that's filled
// in, else null.
function configFor(mode) {
  const set = settings()[mode];
  if (!set || !set.key_id || !set.key_secret) return null;
  return { mode, keyId: set.key_id, keySecret: set.key_secret, webhookSecret: set.webhook_secret };
}

// The key set checkout uses right now, or null when Razorpay is off (or
// the selected set has no keys).
function activeConfig() {
  const { mode } = settings();
  return mode === 'off' ? null : configFor(mode);
}

async function api(cfg, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Razorpay ${method} ${path} → ${res.status}: ${(data.error && data.error.description) || 'request failed'}`);
    err.status = res.status;
    err.razorpay = data;
    throw err;
  }
  return data;
}

// "rzp_test:order_…" → { mode: 'test', id: 'order_…' }; anything else null.
function parseRef(ref) {
  const m = /^rzp_(test|live):(order_\w+)$/.exec(String(ref || ''));
  return m ? { mode: m[1], id: m[2] } : null;
}
const isRazorpayRef = (ref) => parseRef(ref) !== null;

// Razorpay wants a 10-digit phone for prefill only — leave it out otherwise.
function prefillPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

// What the browser needs to open Razorpay's checkout for this order — the
// Razorpay order already open when there is one, else a new one.
// `{ paid: true }` when it turns out to be paid already.
async function startCheckout(order, returnUrl) {
  const { setGatewayOrder } = require('./orders');
  const cfg = activeConfig();
  if (!cfg) throw new Error('Razorpay is not configured');
  let rzOrderId = null;
  const ref = parseRef(order.gateway_order);
  if (ref && ref.mode === cfg.mode) {
    try {
      const existing = await api(cfg, 'GET', `/orders/${encodeURIComponent(ref.id)}`);
      if (existing.status === 'paid' && await syncOrder(order)) return { paid: true };
      if (existing.status !== 'paid' && existing.amount === order.total) rzOrderId = existing.id;
    } catch (err) {
      if (err.status !== 400 && err.status !== 404) throw err;
    }
  }
  if (!rzOrderId) {
    const created = await api(cfg, 'POST', '/orders', {
      amount: order.total,
      currency: order.currency || 'INR',
      receipt: `pz${order.id}`,
      notes: { pz_order: String(order.id), pz_user: String(order.user_id) },
    });
    rzOrderId = created.id;
    await setGatewayOrder(order.id, `rzp_${cfg.mode}:${rzOrderId}`);
  }
  return {
    checkout: {
      provider: 'razorpay',
      sandbox: cfg.mode === 'test',
      keyId: cfg.keyId,
      orderId: rzOrderId,
      amount: order.total,
      currency: order.currency || 'INR',
      description: String(order.page_title || '').slice(0, 250),
      name: order.buyer_name || '',
      email: order.buyer_email || '',
      contact: prefillPhone(order.buyer_phone),
      returnUrl,
    },
  };
}

// Asks Razorpay whether this order's been paid; if so (and for the right
// amount) marks it paid here. A payment that's only authorized (accounts
// without auto-capture) is captured first. Returns true when it's paid.
async function syncOrder(order) {
  const { markOrderPaid } = require('./orders');
  if (order.status === 'paid') return true;
  const ref = parseRef(order.gateway_order);
  const cfg = ref && configFor(ref.mode);
  if (!cfg) return false;
  let payments;
  try {
    const list = await api(cfg, 'GET', `/orders/${encodeURIComponent(ref.id)}/payments`);
    payments = Array.isArray(list.items) ? list.items : [];
  } catch (err) {
    // Unreachable for now — the webhook or the next visit tries again.
    console.error('Checking Razorpay order failed:', err.message);
    return false;
  }
  let paid = payments.find((p) => p.status === 'captured');
  if (paid && order.status === 'cancelled') {
    console.error(`Razorpay order ${ref.id} was paid but order ${order.id} is already cancelled — refund payment ${paid.id} from the Razorpay dashboard.`);
    return false;
  }
  if (!paid && order.status === 'pending') {
    const auth = payments.find((p) => p.status === 'authorized');
    if (auth && auth.amount === order.total) {
      try {
        paid = await api(cfg, 'POST', `/payments/${encodeURIComponent(auth.id)}/capture`, { amount: auth.amount, currency: auth.currency });
      } catch (err) {
        console.error('Capturing Razorpay payment failed:', err.message);
        return false;
      }
    }
  }
  if (!paid || paid.status !== 'captured') return false;
  if (paid.amount !== order.total) {
    console.error(`Razorpay payment ${paid.id} captured ${paid.amount} but order ${order.id} is ${order.total} paise — not marking paid.`);
    return false;
  }
  await markOrderPaid(order.user_id, order.id, { provider: 'razorpay', ref: paid.id });
  return true;
}

// Before an order is cancelled: paid after all → marked paid (true).
// Razorpay orders can't be closed, but one nobody pays simply expires, and
// an authorized payment on a cancelled order is never captured — Razorpay
// refunds it by itself.
async function closeOrder(order) {
  return syncOrder(order);
}

// The buyer closed Razorpay's checkout without paying: did they give up
// (never tried, or left mid-way) rather than have a payment fail, where
// they should get to try again? Same idea as Cashfree's.
async function buyerCancelled(order) {
  const ref = parseRef(order.gateway_order);
  const cfg = ref && configFor(ref.mode);
  if (!cfg || order.status !== 'pending') return false;
  let payments;
  try {
    const list = await api(cfg, 'GET', `/orders/${encodeURIComponent(ref.id)}/payments`);
    payments = Array.isArray(list.items) ? list.items : [];
  } catch (err) {
    console.error('Checking Razorpay payments failed:', err.message);
    return false;
  }
  if (payments.some((p) => p.status === 'captured' || p.status === 'authorized')) return false;
  if (!payments.length) return true;
  const latest = payments.reduce((a, b) => ((b.created_at || 0) > (a.created_at || 0) ? b : a));
  return latest.status !== 'failed';
}

// POST /webhooks/razorpay — signed (hex HMAC-SHA256 of the raw body) with
// the webhook secret of the key set the event belongs to. The payload only
// tells us which order to look at; whether it's paid comes from the API.
async function handleWebhook(req, res) {
  const raw = req.rawBody || Buffer.alloc(0);
  const signature = String(req.get('x-razorpay-signature') || '');
  const mode = ['test', 'live'].find((m) => {
    const secret = settings()[m].webhook_secret;
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  });
  if (!mode) return res.status(401).end();

  const payload = (req.body && req.body.payload) || {};
  const rzOrderId = (payload.payment && payload.payment.entity && payload.payment.entity.order_id)
    || (payload.order && payload.order.entity && payload.order.entity.id);
  if (rzOrderId) {
    const { getOrderByGatewayOrder } = require('./orders');
    const order = await getOrderByGatewayOrder(`rzp_${mode}:${rzOrderId}`);
    if (order) await syncOrder(order);
  }
  return res.status(200).json({ ok: true });
}

// --- admin (/admin/payments) ---------------------------------------------------

// The settings for the admin form — secrets never leave the server; the
// form only learns whether one is saved and its last four characters.
async function adminSettings() {
  const s = await loadSettings();
  const view = (set) => ({
    key_id: set.key_id,
    key_secret: set.key_secret ? `…${set.key_secret.slice(-4)}` : '',
    webhook_secret: set.webhook_secret ? `…${set.webhook_secret.slice(-4)}` : '',
  });
  return { mode: s.mode, test: view(s.test), live: view(s.live), active: activeConfig() ? s.mode : 'off' };
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

// Saves the form. A blank secret keeps the saved one; "Remove keys"
// clears a whole set. Switching Test or Live on checks its keys with
// Razorpay first.
async function saveAdminSettings(body) {
  const current = await loadSettings();
  const mode = MODES.includes(body.razorpay_mode) ? body.razorpay_mode : 'off';
  const next = { mode, test: { ...current.test }, live: { ...current.live } };
  for (const m of ['test', 'live']) {
    if (body[`${m}_clear`] === '1') {
      next[m] = { key_id: '', key_secret: '', webhook_secret: '' };
      continue;
    }
    const keyId = String(body[`${m}_key_id`] || '').trim();
    if (keyId && !new RegExp(`^rzp_${m}_\\w+$`).test(keyId)) {
      throw invalid(`The ${m} Key ID should start with rzp_${m}_.`);
    }
    next[m].key_id = keyId;
    for (const k of ['key_secret', 'webhook_secret']) {
      const value = String(body[`${m}_${k}`] || '').trim();
      if (value.length > 200) throw invalid('That secret is too long.');
      if (value) next[m][k] = value;
    }
  }
  if (mode !== 'off') {
    const set = next[mode];
    if (!set.key_id || !set.key_secret) throw invalid(`Add the ${mode} Key ID and Key secret before switching to ${mode === 'test' ? 'Test' : 'Live'}.`);
    try {
      await api({ keyId: set.key_id, keySecret: set.key_secret }, 'GET', '/orders?count=1');
    } catch (err) {
      throw invalid(err.status === 401
        ? `Razorpay didn’t accept the ${mode} keys — check the Key ID and Key secret.`
        : 'Couldn’t reach Razorpay to check the keys. Please try again in a minute.');
    }
  }
  const values = { razorpay_mode: mode };
  for (const m of ['test', 'live']) KEYS.forEach((k) => { values[`razorpay_${m}_${k}`] = next[m][k]; });
  await saveSettings(values);
  await loadSettings();
}

module.exports = {
  loadSettings,
  activeConfig,
  isRazorpayRef,
  startCheckout,
  syncOrder,
  closeOrder,
  buyerCancelled,
  handleWebhook,
  adminSettings,
  saveAdminSettings,
};
