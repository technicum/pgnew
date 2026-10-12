// Checkouts in progress on a payment page, for the creator's "Abandoned
// carts" list (dashboard → Payment pages → ⋯ → Analytics).
//
// The page's script saves a draft once the buyer has typed a valid email
// and has something in the cart (POST /pay/:slug/draft), keyed by a random
// id the page keeps for that visit; placing the order saves it again and
// links it to the order. A draft is abandoned when nobody paid: no order
// at all after a while, or the order was cancelled / left at the payment
// step. The cart stored is the server's own quote, never the browser's.
const crypto = require('crypto');
const pool = require('./db');

const TABLE = 'PDZ_checkout_drafts';
// How long a checkout sits untouched before it counts as abandoned.
const ABANDONED_AFTER_MINUTES = 30;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        page_id INT NOT NULL,
        draft_key CHAR(32) NOT NULL,
        buyer_name VARCHAR(200) NOT NULL DEFAULT '',
        buyer_email VARCHAR(255) NOT NULL DEFAULT '',
        buyer_phone VARCHAR(30) NOT NULL DEFAULT '',
        items TEXT NULL,
        total INT NOT NULL DEFAULT 0,
        order_id INT NULL,
        dismissed TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_draft (page_id, draft_key),
        INDEX (user_id, page_id)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const validKey = (key) => /^[0-9a-f]{32}$/.test(String(key || ''));
const newDraftKey = () => crypto.randomBytes(16).toString('hex');

// Saves (or updates) one visit's checkout. q is a quote() from
// lib/paymentPages.js; buyer is { name, email, phone }.
async function saveDraft(userId, page, key, buyer, q, { orderId = null } = {}) {
  await ensureTable();
  if (!validKey(key)) return;
  const items = q.lines.map((l) => ({ id: l.id, title: l.title, type: l.type, qty: l.qty, amount: l.amount }));
  await pool.query(
    `INSERT INTO ${TABLE} (user_id, page_id, draft_key, buyer_name, buyer_email, buyer_phone, items, total, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE buyer_name = VALUES(buyer_name), buyer_email = VALUES(buyer_email),
       buyer_phone = VALUES(buyer_phone), items = VALUES(items), total = VALUES(total),
       order_id = COALESCE(VALUES(order_id), order_id), dismissed = 0`,
    [userId, page.id, key, String(buyer.name || '').slice(0, 200), String(buyer.email || '').slice(0, 255),
      String(buyer.phone || '').slice(0, 30), JSON.stringify(items), q.total, orderId],
  );
}

// A page's abandoned checkouts — or, with pageId null, every page's —
// newest first. `testMode`: an order left pending counts as abandoned only
// when there's a checkout screen to leave (test mode, or Cashfree) — in
// manual mode pending means "waiting for you to confirm".
async function listAbandoned(userId, pageId, { testMode }) {
  await ensureTable();
  const allPages = pageId === null || pageId === undefined;
  const [rows] = await pool.query(
    `SELECT d.id, d.page_id, d.buyer_name, d.buyer_email, d.buyer_phone, d.items, d.total, d.created_at, d.updated_at,
            d.order_id, o.status AS order_status
     FROM ${TABLE} d LEFT JOIN PDZ_orders o ON o.id = d.order_id AND o.user_id = d.user_id
     WHERE d.user_id = ? AND (? OR d.page_id = ?) AND d.dismissed = 0 AND d.buyer_email <> ''
       AND d.updated_at < NOW() - INTERVAL ${ABANDONED_AFTER_MINUTES} MINUTE
       AND (d.order_id IS NULL OR o.status = 'cancelled' OR (? AND o.status = 'pending'))
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT 500`,
    [userId, allPages ? 1 : 0, allPages ? 0 : pageId, testMode ? 1 : 0],
  );
  // The same buyer coming back and paying later (in another visit) isn't abandoned.
  const [paid] = await pool.query(
    `SELECT page_id, LOWER(buyer_email) AS email, MAX(created_at) AS last_paid FROM PDZ_orders
     WHERE user_id = ? AND (? OR page_id = ?) AND page_id IS NOT NULL AND status = 'paid' GROUP BY page_id, LOWER(buyer_email)`,
    [userId, allPages ? 1 : 0, allPages ? 0 : pageId],
  );
  const paidAt = new Map(paid.map((r) => [`${r.page_id}|${r.email}`, new Date(r.last_paid).getTime()]));
  return rows
    .filter((r) => !(paidAt.get(`${r.page_id}|${r.buyer_email.toLowerCase()}`) >= new Date(r.updated_at).getTime()))
    .map((r) => {
      let items = [];
      try { items = JSON.parse(r.items || '[]'); } catch (err) { items = []; }
      return {
        id: r.id,
        pageId: r.page_id,
        orderId: r.order_id,
        name: r.buyer_name,
        email: r.buyer_email,
        phone: r.buyer_phone,
        items,
        total: r.total,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Where they stopped: before placing the order, or at the payment step.
        stage: r.order_id ? (r.order_status === 'cancelled' ? 'cancelled' : 'payment') : 'details',
      };
    });
}

async function dismissDraft(userId, pageId, id) {
  await ensureTable();
  await pool.query(`UPDATE ${TABLE} SET dismissed = 1, updated_at = updated_at WHERE id = ? AND user_id = ? AND page_id = ?`, [id, userId, pageId]);
}

module.exports = { saveDraft, listAbandoned, dismissDraft, newDraftKey, ABANDONED_AFTER_MINUTES };
