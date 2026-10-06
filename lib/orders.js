// Orders placed on payment pages (lib/paymentPages.js). Each has a random
// token — the buyer's receipt link (/pay/<slug>/order/<token>) is the only
// way to see an order publicly, and it's what reveals the digital
// products' file links once the order is paid.
//
// status:      pending → paid (markOrderPaid) or pending → cancelled
//              (cancelOrder); both only move an order that's still pending,
//              so a double click or a retried request can't pay an order
//              twice or un-pay it.
// fulfillment: '' for orders with nothing to post; 'unfulfilled' once an
//              order with a physical product is paid, 'shipped' when the
//              merchant marks it so (markOrderShipped).
//
// `items` is a snapshot of what was bought (titles, prices, quantities) —
// later edits to the page never rewrite a past order.
const crypto = require('crypto');
const pool = require('./db');
const { recordCouponUse, deductStock } = require('./paymentPages');
const { createContactFromSource, findExistingContact, updateContact } = require('./contacts');

const TABLE = 'PDZ_orders';

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(`
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
      `);
      // Multi-product checkout: line items, shipping and fulfilment.
      const addColumn = async (sql) => {
        try {
          await pool.query(sql);
        } catch (err) {
          if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
      };
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN items TEXT NULL`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN shipping INT NOT NULL DEFAULT 0`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN ship_address VARCHAR(400) NOT NULL DEFAULT ''`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN fulfillment VARCHAR(12) NOT NULL DEFAULT ''`);
      // The optional message a supporter leaves with a "buy me a coffee".
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN buyer_note VARCHAR(300) NOT NULL DEFAULT ''`);
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const ORDER_COLUMNS = `id, user_id, page_id, page_title, token, buyer_name, buyer_email, buyer_phone, quantity,
  unit_amount, subtotal, discount, total, coupon_code, currency, status, provider, provider_ref, created_at, paid_at,
  items, shipping, ship_address, fulfillment, buyer_note`;

// Orders from before multi-product checkout have no `items`: rebuild their
// one line from the old single-product columns.
function toOrder(row) {
  if (!row) return null;
  let items = null;
  try { items = row.items ? JSON.parse(row.items) : null; } catch (err) { items = null; }
  if (!Array.isArray(items) || !items.length) {
    items = [{ id: 1, title: row.page_title, type: 'digital', qty: row.quantity || 1, unit: row.unit_amount, amount: row.subtotal }];
  }
  let address = null;
  try { address = row.ship_address ? JSON.parse(row.ship_address) : null; } catch (err) { address = null; }
  return { ...row, items, ship_address: address };
}

// q: a quote() from lib/paymentPages.js, already checked by the caller.
// buyer: { name, email, phone, address: { line, city, pincode } | null, note }.
async function createOrder(userId, page, buyer, q) {
  await ensureTable();
  const token = crypto.randomBytes(16).toString('hex');
  const items = q.lines.map((l) => ({ id: l.id, title: l.title, type: l.type, qty: l.qty, unit: l.unit, amount: l.amount, shipFee: l.shipFee }));
  const totalQty = items.reduce((sum, l) => sum + l.qty, 0);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, page_id, page_title, token, buyer_name, buyer_email, buyer_phone,
                           quantity, unit_amount, subtotal, discount, total, coupon_code, items, shipping, ship_address, buyer_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, page.id, page.title, token, buyer.name, buyer.email, buyer.phone,
      totalQty, items.length === 1 ? items[0].unit : 0, q.subtotal, q.discount, q.total, q.coupon ? q.coupon.code : '',
      JSON.stringify(items), q.shipping, buyer.address ? JSON.stringify(buyer.address) : '', buyer.note || ''],
  );
  return getOrder(userId, result.insertId);
}

async function getOrder(userId, id) {
  await ensureTable();
  const [rows] = await pool.query(`SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return toOrder(rows[0]);
}

async function getOrderByToken(userId, token) {
  await ensureTable();
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const [rows] = await pool.query(`SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE token = ? AND user_id = ? LIMIT 1`, [token, userId]);
  return toOrder(rows[0]);
}

async function listOrders(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map(toOrder);
}

// Per-page totals for the payment pages list: paid orders, revenue, and
// paid orders still waiting to be posted.
async function orderStatsByPage(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT page_id, COUNT(*) AS paid_count, COALESCE(SUM(total), 0) AS revenue,
            SUM(fulfillment = 'unfulfilled') AS to_ship
     FROM ${TABLE} WHERE user_id = ? AND status = 'paid' GROUP BY page_id`,
    [userId],
  );
  return new Map(rows.map((r) => [r.page_id, {
    paidCount: Number(r.paid_count),
    revenue: Number(r.revenue),
    toShip: Number(r.to_ship) || 0,
  }]));
}

// One payment page's numbers for its Analytics panel (dashboard → Payment
// pages → ⋯ → Analytics): order counts by status, paid revenue, the last
// `days` days of paid orders day by day, what sold, and the latest orders.
async function pageAnalytics(userId, pageId, { days = 30 } = {}) {
  await ensureTable();
  const [orders] = await pool.query(
    `SELECT ${ORDER_COLUMNS} FROM ${TABLE} WHERE user_id = ? AND page_id = ? ORDER BY created_at DESC, id DESC`,
    [userId, pageId],
  );
  const all = orders.map(toOrder);
  const paid = all.filter((o) => o.status === 'paid');
  const revenue = paid.reduce((sum, o) => sum + o.total, 0);

  // Paid orders per day, oldest first, with empty days filled in.
  const dayKey = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const daily = [];
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const row = { date: dayKey(d), orders: 0, revenue: 0 };
    daily.push(row);
    byDay.set(row.date, row);
  }
  paid.forEach((o) => {
    const row = byDay.get(dayKey(o.paid_at || o.created_at));
    if (row) { row.orders += 1; row.revenue += o.total; }
  });

  // What sold, by product, across paid orders.
  const products = new Map();
  paid.forEach((o) => o.items.forEach((i) => {
    const p = products.get(i.id) || { id: i.id, title: i.title, type: i.type, qty: 0, revenue: 0 };
    p.qty += i.qty;
    p.revenue += i.amount;
    products.set(i.id, p);
  }));

  // Everyone who ordered here (cancelled-only buyers aren't customers),
  // one row per email: contact, latest address, what they bought, spend.
  const customers = new Map();
  all.filter((o) => o.status !== 'cancelled').forEach((o) => {
    const key = String(o.buyer_email || '').toLowerCase();
    let c = customers.get(key);
    if (!c) {
      // Orders are newest first, so the first one seen has the latest details.
      c = {
        name: o.buyer_name, email: o.buyer_email, phone: o.buyer_phone, address: o.ship_address,
        orders: [], paidCount: 0, spent: 0, products: new Map(), firstAt: o.created_at, lastAt: o.created_at,
      };
      customers.set(key, c);
    }
    if (!c.phone && o.buyer_phone) c.phone = o.buyer_phone;
    if (!c.address && o.ship_address) c.address = o.ship_address;
    c.firstAt = o.created_at;
    c.orders.push({
      id: o.id, status: o.status, total: o.total, created_at: o.created_at, coupon: o.coupon_code,
      fulfillment: o.fulfillment, note: o.buyer_note, items: o.items.map((i) => ({ title: i.title, qty: i.qty, amount: i.amount })),
    });
    if (o.status === 'paid') {
      c.paidCount += 1;
      c.spent += o.total;
      o.items.forEach((i) => c.products.set(i.title, (c.products.get(i.title) || 0) + i.qty));
    }
  });

  return {
    customers: [...customers.values()]
      .map((c) => ({ ...c, products: [...c.products.entries()].map(([title, qty]) => ({ title, qty })) }))
      .sort((a, b) => b.spent - a.spent || new Date(b.lastAt) - new Date(a.lastAt)),
    orders: {
      total: all.length,
      paid: paid.length,
      pending: all.filter((o) => o.status === 'pending').length,
      cancelled: all.filter((o) => o.status === 'cancelled').length,
    },
    revenue,
    discount: paid.reduce((sum, o) => sum + (o.discount || 0), 0),
    averageOrder: paid.length ? Math.round(revenue / paid.length) : 0,
    lastDays: {
      days,
      orders: daily.reduce((n, d) => n + d.orders, 0),
      revenue: daily.reduce((n, d) => n + d.revenue, 0),
    },
    daily,
    products: [...products.values()].sort((a, b) => b.revenue - a.revenue),
    recent: all.slice(0, 8).map((o) => ({
      id: o.id, buyer: o.buyer_name || o.buyer_email, status: o.status, total: o.total, created_at: o.created_at,
    })),
  };
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
      note: `Bought: ${order.items.map((i) => (i.qty > 1 ? `${i.title} × ${i.qty}` : i.title)).join(', ')}`.slice(0, 300),
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
    `UPDATE ${TABLE} SET status = 'paid', provider = ?, provider_ref = ?, paid_at = CURRENT_TIMESTAMP,
            fulfillment = IF(items LIKE '%"type":"physical"%', 'unfulfilled', '')
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [String(provider).slice(0, 20), String(ref).slice(0, 100), id, userId],
  );
  if (!result.affectedRows) return false;
  const order = await getOrder(userId, id);
  // Bookkeeping after the money's in: a failure here is logged, never
  // turned into a failed payment.
  try {
    if (order.coupon_code) await recordCouponUse(userId, order.coupon_code);
    if (order.page_id) await deductStock(userId, order.page_id, order.items);
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

// A paid order with something to post → shipped.
async function markOrderShipped(userId, id) {
  await ensureTable();
  const [result] = await pool.query(
    `UPDATE ${TABLE} SET fulfillment = 'shipped' WHERE id = ? AND user_id = ? AND status = 'paid' AND fulfillment = 'unfulfilled'`,
    [id, userId],
  );
  return result.affectedRows > 0;
}

module.exports = {
  pageAnalytics,
  createOrder,
  getOrder,
  getOrderByToken,
  listOrders,
  orderStatsByPage,
  markOrderPaid,
  markOrderShipped,
  cancelOrder,
};
