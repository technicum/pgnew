// Orders placed on payment pages (lib/paymentPages.js). Each has a random
// token — the buyer's receipt link (/pay/<slug>/order/<token>) is the only
// way to see an order publicly, and it's what reveals the delivery link
// once the order is paid.
//
// pending → paid (markOrderPaid) or pending → cancelled (cancelOrder);
// both only move an order that's still pending, so a double click or a
// retried request can't pay an order twice or un-pay it.
const crypto = require('crypto');
const pool = require('./db');
const { recordCouponUse } = require('./paymentPages');
const { createContactFromSource, findExistingContact, updateContact } = require('./contacts');

const TABLE = 'PDZ_orders';

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        page_id INT NULL DEFAULT NULL,
        page_title VARCHAR(200) NOT NULL DEFAULT '',
        token CHAR(32) NOT NULL,
        buyer_name VARCHAR(200) NOT NULL DEFAULT '',
        buyer_email VARCHAR(255) NOT NULL DEFAULT '',
        buyer_phone VARCHAR(30) NOT NULL DEFAULT '',
        quantity INT NOT NULL DEFAULT 1,
        unit_amount INT NOT NULL DEFAULT 0,
        subtotal INT NOT NULL DEFAULT 0,
        discount INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        coupon_code VARCHAR(30) NOT NULL DEFAULT '',
        currency CHAR(3) NOT NULL DEFAULT 'INR',
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        provider VARCHAR(20) NOT NULL DEFAULT '',
        provider_ref VARCHAR(100) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP NULL DEFAULT NULL,
        UNIQUE KEY uniq_token (token),
        INDEX (user_id),
        INDEX (page_id)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const ORDER_COLUMNS = `id, user_id, page_id, page_title, token, buyer_name, buyer_email, buyer_phone, quantity,
  unit_amount, subtotal, discount, total, coupon_code, currency, status, provider, provider_ref, created_at, paid_at`;

// q: a quote() from lib/paymentPages.js, already checked by the caller.
async function createOrder(userId, page, buyer, q) {
  await ensureTable();
  const token = crypto.randomBytes(16).toString('hex');
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, page_id, page_title, token, buyer_name, buyer_email, buyer_phone,
                           quantity, unit_amount, subtotal, discount, total, coupon_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, page.id, page.title, token, buyer.name, buyer.email, buyer.phone,
      q.quantity, q.unit, q.subtotal, q.discount, q.total, q.coupon ? q.coupon.code : ''],
  );
  return getOrder(userId, result.insertId);
}

async function getOrder(userId, id) {
  await ensureTable();
  const [rows] = await pool.query(`SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return rows[0] || null;
}

async function getOrderByToken(userId, token) {
  await ensureTable();
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const [rows] = await pool.query(`SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE token = ? AND user_id = ? LIMIT 1`, [token, userId]);
  return rows[0] || null;
}

async function listOrders(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

// Per-page totals for the payment pages list: paid orders and revenue.
async function orderStatsByPage(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT page_id, COUNT(*) AS paid_count, COALESCE(SUM(total), 0) AS revenue
     FROM ${TABLE} WHERE user_id = ? AND status = 'paid' GROUP BY page_id`,
    [userId],
  );
  return new Map(rows.map((r) => [r.page_id, { paidCount: Number(r.paid_count), revenue: Number(r.revenue) }]));
}

// The buyer lands in the merchant's Audience the moment they've paid — the
// same one-contact-per-person rule as a lead-magnet signup.
async function addBuyerToAudience(order) {
  const existing = await findExistingContact(order.user_id, { email: order.buyer_email, phone: order.buyer_email ? '' : order.buyer_phone });
  if (!existing) {
    await createContactFromSource(order.user_id, {
      name: order.buyer_name || order.buyer_email || order.buyer_phone,
      email: order.buyer_email,
      phone: order.buyer_phone,
      note: `Bought: ${order.page_title}`,
      source: 'order',
      sourceId: order.page_id,
      sourceName: order.page_title,
    });
  } else if (order.buyer_phone && !existing.phone) {
    await updateContact(order.user_id, existing.id, { phone: order.buyer_phone });
  }
}

// Returns true only for the call that actually moved it to paid.
async function markOrderPaid(userId, id, { provider, ref = '' }) {
  await ensureTable();
  const [result] = await pool.query(
    `UPDATE ${TABLE} SET status = 'paid', provider = ?, provider_ref = ?, paid_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [String(provider).slice(0, 20), String(ref).slice(0, 100), id, userId],
  );
  if (!result.affectedRows) return false;
  const order = await getOrder(userId, id);
  // Bookkeeping after the money's in: a failure here is logged, never
  // turned into a failed payment.
  try {
    if (order.coupon_code) await recordCouponUse(userId, order.coupon_code);
    await addBuyerToAudience(order);
  } catch (err) {
    console.error('Post-payment bookkeeping failed for order', id, err);
  }
  return true;
}

async function cancelOrder(userId, id) {
  await ensureTable();
  const [result] = await pool.query(
    `UPDATE ${TABLE} SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [id, userId],
  );
  return result.affectedRows > 0;
}

module.exports = {
  createOrder,
  getOrder,
  getOrderByToken,
  listOrders,
  orderStatsByPage,
  markOrderPaid,
  cancelOrder,
};
