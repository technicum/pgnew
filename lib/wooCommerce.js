// WordPress / WooCommerce stores paid through PageZaper ("PageZaper Pay",
// the plugin in wordpress/pagezaper-pay). A creator connects a store from
// Settings → Payouts and gets an API key for it; the plugin uses that key on
// a small REST API:
//
//   POST /api/v1/wc/orders       { amount, currency, wc_order_id, notify_url?, buyer? }
//                                → a Razorpay order split with Route: the sale
//                                  minus PageZaper's fee goes to the creator's
//                                  Linked Account (lib/linkedAccounts.js), the
//                                  fee stays with PageZaper.
//   GET  /api/v1/wc/orders/:id   → its status, re-checked with Razorpay.
//
// Keys: "pzwc_" + 40 hex characters, shown once when made; only a SHA-256 of
// it is stored, plus the last four characters to tell keys apart. A revoked
// key stops working at once.
//
// Same rule as everywhere else (lib/razorpay.js): an order is marked paid
// only after we ask Razorpay's API — from the status call, or after a signed
// webhook — and the captured amount matches. Nothing a caller sends about a
// payment is believed. When an order turns paid we nudge the store's
// notify_url (just { id }) so the plugin re-checks with GET; the nudge
// carries no status, so a forged one achieves nothing.
//
// No split payment is ever made to an account Razorpay hasn't activated.
const crypto = require('crypto');
const pool = require('./db');
const razorpay = require('./razorpay');
const linkedAccounts = require('./linkedAccounts');
const { feesFor, feeOn } = require('./platform');
const { findUserById, isSuspended } = require('./users');
const { inputError } = require('./appKit');

const SITES = 'PDZ_wc_sites';
const ORDERS = 'PDZ_wc_orders';
const MAX_SITES = 10;
const MIN_AMOUNT = 100; // ₹1 — Razorpay's minimum
const MAX_AMOUNT = 50000000; // ₹5,00,000 per order

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SITES} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          label VARCHAR(80) NOT NULL DEFAULT '',
          site_url VARCHAR(255) NOT NULL DEFAULT '',
          key_hash CHAR(64) NOT NULL,
          key_last4 CHAR(4) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at TIMESTAMP NULL DEFAULT NULL,
          revoked_at TIMESTAMP NULL DEFAULT NULL,
          UNIQUE KEY uniq_key (key_hash),
          INDEX (user_id)
        )
      `);
      // Amounts in paise. fee_pct / platform_fee are fixed when the order is
      // made, like PDZ_orders; transfer_amount is what the creator gets.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${ORDERS} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          public_id CHAR(28) NOT NULL,
          user_id INT NOT NULL,
          site_id INT NOT NULL,
          wc_order_id VARCHAR(40) NOT NULL DEFAULT '',
          amount INT NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'INR',
          fee_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
          platform_fee INT NOT NULL DEFAULT 0,
          transfer_amount INT NOT NULL DEFAULT 0,
          linked_account VARCHAR(40) NOT NULL DEFAULT '',
          gateway_order VARCHAR(50) NOT NULL DEFAULT '',
          notify_url VARCHAR(500) NOT NULL DEFAULT '',
          buyer_name VARCHAR(200) NOT NULL DEFAULT '',
          buyer_email VARCHAR(255) NOT NULL DEFAULT '',
          buyer_phone VARCHAR(30) NOT NULL DEFAULT '',
          status VARCHAR(12) NOT NULL DEFAULT 'pending',
          provider_ref VARCHAR(100) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          paid_at TIMESTAMP NULL DEFAULT NULL,
          UNIQUE KEY uniq_public (public_id),
          INDEX (gateway_order),
          INDEX (site_id, wc_order_id),
          INDEX (user_id)
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// --- sites and keys (Settings → Payouts) -----------------------------------

async function listSites(userId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id, label, site_url, key_last4, created_at, last_used_at FROM ${SITES}
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

// https://shop.example.com — scheme and host only.
function readSiteUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (err) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.username || u.password) {
    throw inputError('Enter your WordPress site’s address, like https://mystore.in.');
  }
  return u.origin.toLowerCase();
}

// A new site and its key. Returns { site, key } — the key is never shown again.
async function createSite(userId, body) {
  await ensureTables();
  const siteUrl = readSiteUrl(body.site_url);
  const label = String(body.label || '').replace(/\s+/g, ' ').trim().slice(0, 80) || new URL(siteUrl).hostname;
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${SITES} WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
  if (n >= MAX_SITES) throw inputError(`You can connect up to ${MAX_SITES} sites. Revoke one you no longer use first.`);
  const key = `pzwc_${crypto.randomBytes(20).toString('hex')}`;
  const [result] = await pool.query(
    `INSERT INTO ${SITES} (user_id, label, site_url, key_hash, key_last4) VALUES (?, ?, ?, ?, ?)`,
    [userId, label, siteUrl, hashKey(key), key.slice(-4)],
  );
  return { site: { id: result.insertId, label, site_url: siteUrl }, key };
}

async function revokeSite(userId, siteId) {
  await ensureTables();
  const [result] = await pool.query(
    `UPDATE ${SITES} SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [siteId, userId],
  );
  return result.affectedRows > 0;
}

// The live site a key belongs to, or null.
async function siteForKey(key) {
  if (!/^pzwc_[0-9a-f]{40}$/.test(String(key || ''))) return null;
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${SITES} WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`, [hashKey(key)]);
  return rows[0] || null;
}

// --- orders --------------------------------------------------------------

function toApi(o) {
  return {
    id: o.public_id,
    status: o.status,
    amount: o.amount,
    currency: o.currency,
    wc_order_id: o.wc_order_id,
    payment_id: o.status === 'paid' ? o.provider_ref : null,
    paid_at: o.paid_at ? new Date(o.paid_at).toISOString() : null,
  };
}

// What the plugin needs to open Razorpay's checkout for an order.
function checkoutFor(o, cfg) {
  const ref = razorpay.parseRef(o.gateway_order);
  return {
    ...toApi(o),
    test_mode: cfg.mode === 'test',
    razorpay: { key_id: cfg.keyId, order_id: ref.id },
  };
}

// notify_url must be on the site the key was made for, over https (http only
// for a local site) — we post to it, so it can't be pointed anywhere else.
function readNotifyUrl(raw, site) {
  if (!raw) return '';
  let u;
  try { u = new URL(String(raw)); } catch (err) { return null; }
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.origin.toLowerCase() !== site.site_url || (u.protocol !== 'https:' && !local) || u.username || u.password) return null;
  return u.href.slice(0, 500);
}

function apiError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.apiCode = code;
  return err;
}

async function getOrderForSite(site, publicId) {
  if (!/^wco_[0-9a-f]{24}$/.test(String(publicId || ''))) return null;
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS} WHERE public_id = ? AND site_id = ? LIMIT 1`, [publicId, site.id]);
  return rows[0] || null;
}

// POST /api/v1/wc/orders. A retry for the same WooCommerce order and amount
// gets the order already open rather than a second one.
async function createWcOrder(site, body) {
  const cfg = razorpay.activeConfig();
  if (!cfg) throw apiError(503, 'payments_unavailable', 'PageZaper payments are not available right now.');
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    throw apiError(400, 'invalid_amount', `amount must be a whole number of paise from ${MIN_AMOUNT} to ${MAX_AMOUNT}.`);
  }
  const currency = String(body.currency || 'INR').toUpperCase();
  if (currency !== 'INR') throw apiError(400, 'invalid_currency', 'Only INR is supported.');
  const wcOrderId = String(body.wc_order_id ?? '').trim();
  if (!/^[\w.-]{1,40}$/.test(wcOrderId)) throw apiError(400, 'invalid_wc_order_id', 'wc_order_id is required (letters, digits, - _ . up to 40).');
  const notifyUrl = readNotifyUrl(body.notify_url, site);
  if (notifyUrl === null) throw apiError(400, 'invalid_notify_url', `notify_url must be an https address on ${site.site_url}.`);
  const buyer = body.buyer && typeof body.buyer === 'object' ? body.buyer : {};
  const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  const owner = await findUserById(site.user_id);
  if (!owner || await isSuspended(site.user_id)) throw apiError(403, 'account_unavailable', 'This PageZaper account can’t take payments.');
  const linked = await linkedAccounts.activatedAccount(site.user_id, cfg.mode);
  if (!linked) throw apiError(409, 'payouts_not_active', 'Payouts aren’t active for this PageZaper account yet. Finish Settings → Payouts in PageZaper.');

  await ensureTables();
  const [earlier] = await pool.query(
    `SELECT * FROM ${ORDERS} WHERE site_id = ? AND wc_order_id = ? ORDER BY id DESC LIMIT 20`,
    [site.id, wcOrderId],
  );
  if (earlier.some((o) => o.status === 'paid')) throw apiError(409, 'already_paid', 'That WooCommerce order is already paid.');
  const existing = earlier[0];
  if (existing && existing.amount === amount && existing.linked_account === linked.account_id) {
    const ref = razorpay.parseRef(existing.gateway_order);
    if (ref && ref.mode === cfg.mode) {
      if (notifyUrl !== existing.notify_url) await pool.query(`UPDATE ${ORDERS} SET notify_url = ? WHERE id = ?`, [notifyUrl, existing.id]);
      if (await syncWcOrder(existing)) throw apiError(409, 'already_paid', 'That WooCommerce order is already paid.');
      return checkoutFor(existing, cfg);
    }
  }

  // The store's own buyers: the creator's direct-sale percentage.
  const pct = (await feesFor(owner)).direct_pct;
  const fee = feeOn(amount, pct);
  const transfer = amount - fee;
  if (transfer <= 0) throw apiError(400, 'invalid_amount', 'That amount is too small to split.');
  const publicId = `wco_${crypto.randomBytes(12).toString('hex')}`;
  const [result] = await pool.query(
    `INSERT INTO ${ORDERS} (public_id, user_id, site_id, wc_order_id, amount, currency, fee_pct, platform_fee, transfer_amount,
                            linked_account, notify_url, buyer_name, buyer_email, buyer_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [publicId, site.user_id, site.id, wcOrderId, amount, currency, pct, fee, transfer, linked.account_id, notifyUrl,
      text(buyer.name, 200), text(buyer.email, 255), text(buyer.phone, 30)],
  );
  const notes = { pz_wc_order: publicId, pz_user: String(site.user_id), wc_order: wcOrderId };
  let created;
  try {
    created = await razorpay.createOrder(cfg, {
      amount,
      currency,
      receipt: `pzwc${result.insertId}`,
      notes,
      transfers: [{ account: linked.account_id, amount: transfer, currency, notes, linked_account_notes: ['wc_order'] }],
    });
  } catch (err) {
    await pool.query(`DELETE FROM ${ORDERS} WHERE id = ?`, [result.insertId]);
    console.error('Creating Razorpay order for WooCommerce failed:', err.message);
    throw apiError(502, 'gateway_error', 'Couldn’t create the payment with Razorpay. Please try again.');
  }
  const gatewayOrder = `rzp_${cfg.mode}:${created.id}`;
  await pool.query(`UPDATE ${ORDERS} SET gateway_order = ? WHERE id = ?`, [gatewayOrder, result.insertId]);
  const [[row]] = await pool.query(`SELECT * FROM ${ORDERS} WHERE id = ?`, [result.insertId]);
  return checkoutFor(row, cfg);
}

// Asks Razorpay whether this order's been paid; if so (and for the right
// amount) marks it paid. Returns true when it's paid.
async function syncWcOrder(order) {
  if (order.status === 'paid') return true;
  const ref = razorpay.parseRef(order.gateway_order);
  const cfg = ref && razorpay.configFor(ref.mode);
  if (!cfg) return false;
  let paid;
  try {
    paid = await razorpay.capturedPayment(cfg, ref.id, order.amount);
  } catch (err) {
    console.error('Checking Razorpay order for WooCommerce failed:', err.message);
    return false;
  }
  if (!paid) return false;
  const [result] = await pool.query(
    `UPDATE ${ORDERS} SET status = 'paid', provider_ref = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
    [String(paid.id).slice(0, 100), order.id],
  );
  if (result.affectedRows) notify(order);
  return true;
}

// The signed Razorpay webhook (lib/razorpay.js), for an order that isn't a
// storefront one.
async function syncByGatewayOrder(gatewayOrder) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${ORDERS} WHERE gateway_order = ? LIMIT 1`, [gatewayOrder]);
  if (rows[0]) await syncWcOrder(rows[0]);
}

// Tells the store to come and check (fire and forget). The body carries no
// status: the plugin always asks GET /api/v1/wc/orders/:id.
function notify(order) {
  if (!order.notify_url) return;
  fetch(order.notify_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: order.public_id }),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  }).catch((err) => console.error(`Notifying ${order.notify_url} failed:`, err.message));
}

// --- the REST API --------------------------------------------------------

function installWcApi(app) {
  const BASE = '/api/v1/wc';

  // Authorization: Bearer pzwc_…
  async function auth(req, res, next) {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
      const site = m && await siteForKey(m[1]);
      if (!site) return res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or revoked API key.' } });
      req.wcSite = site;
      pool.query(`UPDATE ${SITES} SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, [site.id]).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  }
  const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

  app.post(`${BASE}/orders`, auth, handle(async (req, res) => {
    res.status(201).json(await createWcOrder(req.wcSite, req.body || {}));
  }));

  app.get(`${BASE}/orders/:id`, auth, handle(async (req, res) => {
    const order = await getOrderForSite(req.wcSite, req.params.id);
    if (!order) return res.status(404).json({ error: { code: 'not_found', message: 'No such order.' } });
    if (order.status !== 'paid' && await syncWcOrder(order)) {
      return res.json(toApi(await getOrderForSite(req.wcSite, req.params.id)));
    }
    res.json(toApi(order));
  }));

  app.use(BASE, (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } }));
  // Errors stay JSON here — bad JSON bodies included.
  // eslint-disable-next-line no-unused-vars
  app.use(BASE, (err, req, res, next) => {
    if (err.apiCode) return res.status(err.status).json({ error: { code: err.apiCode, message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'The body isn’t valid JSON.' } });
    console.error('WooCommerce API error:', err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong.' } });
  });
}

module.exports = {
  MAX_SITES,
  ensureTables,
  listSites,
  createSite,
  revokeSite,
  siteForKey,
  createWcOrder,
  syncWcOrder,
  syncByGatewayOrder,
  installWcApi,
};
