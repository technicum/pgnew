// Abandoned carts, all in one place (dashboard → Abandoned carts): every
// checkout someone started and didn't pay for, so the creator can follow
// up — on WhatsApp, by email, or by copying a message.
//
// Two kinds, both "abandoned" once left alone for ABANDONED_AFTER_MINUTES:
//   page  — a payment page checkout (lib/checkoutDrafts.js): the buyer
//           typed their email and had something in the cart, then either
//           never placed the order or left it at the payment step
//   order — an app's order with nothing behind it on a payment page: a
//           paid course or a booking's advance (lib/courses.js,
//           lib/bookings.js) left unpaid or cancelled
// Someone who came back and paid for the same thing afterwards drops out.
//
// What the creator did about each one lives in PDZ_abandoned_followups,
// keyed by `ref` ('page:<draft id>' / 'order:<order id>'): when they
// contacted the buyer (and how), or that they dismissed it. A contacted
// buyer who then paid anything counts as recovered.
const pool = require('./db');
const { listAbandoned, ABANDONED_AFTER_MINUTES } = require('./checkoutDrafts');
const { listPaymentPages, listCoupons, formatINR } = require('./paymentPages');
const { paymentMode } = require('./payments');

const FOLLOWUPS = 'PDZ_abandoned_followups';
const CHANNELS = new Set(['whatsapp', 'email', 'copy']);

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${FOLLOWUPS} (
        user_id INT NOT NULL,
        ref VARCHAR(24) NOT NULL,
        buyer_email VARCHAR(255) NOT NULL DEFAULT '',
        total INT NOT NULL DEFAULT 0,
        channel VARCHAR(12) NOT NULL DEFAULT '',
        contacts INT NOT NULL DEFAULT 0,
        contacted_at TIMESTAMP NULL DEFAULT NULL,
        dismissed TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, ref)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const parseItems = (raw) => {
  try {
    const items = JSON.parse(raw || '[]');
    return Array.isArray(items) ? items : [];
  } catch (err) {
    return [];
  }
};

// App orders (no payment page) left unpaid or cancelled — paid courses and
// booking advances. `pendingCounts` as in listAbandoned: not in manual mode.
async function abandonedAppOrders(userId, { pendingCounts }) {
  const [rows] = await pool.query(
    `SELECT id, buyer_name, buyer_email, buyer_phone, items, total, status, created_at
     FROM PDZ_orders
     WHERE user_id = ? AND page_id IS NULL AND buyer_email <> ''
       AND created_at < NOW() - INTERVAL ${ABANDONED_AFTER_MINUTES} MINUTE
       AND (status = 'cancelled' OR (? AND status = 'pending'))
     ORDER BY created_at DESC, id DESC LIMIT 500`,
    [userId, pendingCounts ? 1 : 0],
  );
  if (!rows.length) return [];
  // Paid later for the same thing (same kind and id) by the same email.
  const [paid] = await pool.query(
    `SELECT LOWER(buyer_email) AS email, items, created_at FROM PDZ_orders
     WHERE user_id = ? AND page_id IS NULL AND status = 'paid'`,
    [userId],
  );
  const paidKeys = paid.map((p) => {
    const first = parseItems(p.items)[0] || {};
    return { key: `${p.email}|${first.type}|${first.id}`, at: new Date(p.created_at).getTime() };
  });
  // Where each can be bought again: the course's or the session's public page.
  const ids = (type) => [...new Set(rows.map((r) => parseItems(r.items)[0]).filter((i) => i && i.type === type).map((i) => Number(i.id)))];
  const slugs = { course: new Map(), booking: new Map(), event: new Map() };
  const courseIds = ids('course');
  const serviceIds = ids('booking');
  const eventIds = ids('event');
  if (eventIds.length) {
    const [e] = await pool.query('SELECT id, slug, title FROM PDZ_events WHERE user_id = ? AND id IN (?)', [userId, eventIds]);
    e.forEach((x) => slugs.event.set(x.id, { path: `/event/${x.slug}`, title: x.title }));
  }
  if (courseIds.length) {
    const [c] = await pool.query('SELECT id, slug, title FROM PDZ_courses WHERE user_id = ? AND id IN (?)', [userId, courseIds]);
    c.forEach((x) => slugs.course.set(x.id, { path: `/course/${x.slug}`, title: x.title }));
  }
  if (serviceIds.length) {
    try {
      const [s] = await pool.query('SELECT id, slug, title FROM PDZ_booking_services WHERE user_id = ? AND id IN (?)', [userId, serviceIds]);
      s.forEach((x) => slugs.booking.set(x.id, { path: `/book/${x.slug}`, title: x.title }));
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
  }
  return rows
    .map((r) => {
      const items = parseItems(r.items);
      const first = items[0] || {};
      const kind = ['course', 'booking', 'event'].includes(first.type) ? first.type : 'order';
      const target = slugs[kind] && slugs[kind].get(Number(first.id));
      const key = `${String(r.buyer_email).toLowerCase()}|${first.type}|${first.id}`;
      const at = new Date(r.created_at).getTime();
      if (paidKeys.some((p) => p.key === key && p.at >= at)) return null;
      return {
        ref: `order:${r.id}`,
        kind,
        itemId: Number(first.id) || null,
        source: target ? target.title : (first.title || 'Order'),
        path: target ? target.path : '',
        name: r.buyer_name,
        email: r.buyer_email,
        phone: r.buyer_phone,
        items: items.map((i) => ({ title: i.title, qty: i.qty || 1 })),
        total: r.total,
        updatedAt: r.created_at,
        stage: r.status === 'cancelled' ? 'cancelled' : 'payment',
      };
    })
    .filter(Boolean);
}

// Every abandoned cart, newest first, with what the creator did about it
// (contactedAt / channel / contacts) — dismissed ones left out. `mode` is
// lib/payments.js paymentMode().
async function listAllAbandoned(userId, { mode, pages }) {
  await ensureTable();
  const pendingCounts = mode !== 'manual';
  const pageById = new Map((pages || []).map((p) => [p.id, p]));
  const [drafts, orders, [follow]] = await Promise.all([
    listAbandoned(userId, null, { testMode: pendingCounts }),
    abandonedAppOrders(userId, { pendingCounts }),
    pool.query(`SELECT * FROM ${FOLLOWUPS} WHERE user_id = ?`, [userId]),
  ]);
  const followByRef = new Map(follow.map((f) => [f.ref, f]));
  const fromPages = drafts.map((d) => {
    const page = pageById.get(d.pageId);
    return {
      ref: `page:${d.id}`,
      kind: 'page',
      pageId: d.pageId,
      source: page ? page.title : 'Payment page',
      path: page ? `/pay/${page.slug}` : '',
      name: d.name,
      email: d.email,
      phone: d.phone,
      items: d.items.map((i) => ({ title: i.title, qty: i.qty || 1 })),
      total: d.total,
      updatedAt: d.updatedAt,
      stage: d.stage,
    };
  });
  return fromPages.concat(orders)
    .map((c) => {
      const f = followByRef.get(c.ref);
      return { ...c, contactedAt: f && f.contacted_at, channel: f ? f.channel : '', contacts: f ? f.contacts : 0, dismissed: !!(f && f.dismissed) };
    })
    .filter((c) => !c.dismissed)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

const validRef = (ref) => /^(page|order):\d+$/.test(String(ref || ''));

// The creator reached out (whatsapp / email / copy) — kept with the buyer's
// email and the cart's value, to count it as recovered if they then pay.
async function markContacted(userId, { ref, channel, email, total }) {
  await ensureTable();
  if (!validRef(ref)) return null;
  const how = CHANNELS.has(channel) ? channel : 'copy';
  await pool.query(
    `INSERT INTO ${FOLLOWUPS} (user_id, ref, buyer_email, total, channel, contacts, contacted_at)
     VALUES (?, ?, ?, ?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE channel = VALUES(channel), contacts = contacts + 1, contacted_at = NOW(),
       buyer_email = VALUES(buyer_email), total = VALUES(total)`,
    [userId, ref, String(email || '').slice(0, 255), Math.max(0, Number(total) || 0), how],
  );
  const [[row]] = await pool.query(`SELECT contacted_at, contacts, channel FROM ${FOLLOWUPS} WHERE user_id = ? AND ref = ?`, [userId, ref]);
  return row;
}

async function dismissAbandoned(userId, ref) {
  await ensureTable();
  if (!validRef(ref)) return;
  await pool.query(
    `INSERT INTO ${FOLLOWUPS} (user_id, ref, dismissed) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE dismissed = 1`,
    [userId, ref],
  );
}

// Buyers the creator followed up with who paid for something afterwards —
// { count, value } (value: the carts they'd left).
async function recoveredStats(userId) {
  await ensureTable();
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(f.total), 0) AS value FROM ${FOLLOWUPS} f
     WHERE f.user_id = ? AND f.contacted_at IS NOT NULL AND f.buyer_email <> ''
       AND EXISTS (SELECT 1 FROM PDZ_orders o WHERE o.user_id = f.user_id AND o.status = 'paid'
                   AND LOWER(o.buyer_email) = LOWER(f.buyer_email) AND o.created_at >= f.contacted_at)`,
    [userId],
  );
  return { count: Number(row.n) || 0, value: Number(row.value) || 0 };
}

// Everything partials/abandoned-carts.ejs needs, for the whole store or one
// part of it — filter: { kind: 'page' | 'course' | 'booking', pageId,
// itemId (a course's id) }. → { carts, coupons, recovered, total, waiting }.
async function abandonedView(userId, filter = {}) {
  const [pages, coupons, recovered] = await Promise.all([listPaymentPages(userId), listCoupons(userId), recoveredStats(userId)]);
  let carts = await listAllAbandoned(userId, { mode: paymentMode(), pages });
  if (filter.kind) carts = carts.filter((c) => c.kind === filter.kind || (filter.kind === 'booking' && c.kind === 'order'));
  if (filter.pageId) carts = carts.filter((c) => c.pageId === filter.pageId);
  if (filter.itemId) carts = carts.filter((c) => c.itemId === filter.itemId);
  const now = Date.now();
  return {
    carts,
    recovered,
    total: carts.reduce((n, c) => n + c.total, 0),
    waiting: carts.filter((c) => !c.contactedAt).length,
    // Coupons a buyer could still use — they work on payment pages only
    // (lib/paymentPages.js findUsableCoupon).
    coupons: coupons
      .filter((c) => c.active && (c.max_uses === null || c.used_count < c.max_uses)
        && (!c.expires_at || new Date(`${c.expires_at}T23:59:59`).getTime() > now)
        && (!filter.pageId || !c.page_id || c.page_id === filter.pageId))
      .map((c) => ({ code: c.code, label: c.discount_type === 'percent' ? `${c.discount_value}% off` : `${formatINR(c.discount_value)} off`, pageId: c.page_id })),
  };
}

module.exports = { listAllAbandoned, abandonedView, markContacted, dismissAbandoned, recoveredStats, ABANDONED_AFTER_MINUTES };
