// Events app — a workshop, webinar or meetup with a date, a place (a venue
// or an online link), optionally a cap on seats, and a ticket price (0 =
// free). Its public page, meera.pagezaper.com/event/:slug
// (lib/appStorefront.js), takes registrations; each one lands in Audience
// tagged 'event'. An online event's join link is only shown to people
// who've registered.
//
// RSVP status: going     — registered (a free event, or a paid ticket once paid)
//              pending   — a paid ticket waiting for its order (lib/orders.js);
//                          holds a seat for HOLD_MINUTES from held_at
//              cancelled — cancelled by the creator, or an unpaid order cancelled
//
// A paid ticket is an ordinary order (page_id NULL, one item of type
// 'event'), paid through the same test / Cashfree / manual flow as courses
// and bookings. Its page, /event/:slug/ticket/:token, is the checkout until
// it's paid and the ticket after. orders.js calls confirmFromOrder() and
// releaseFromOrder() when that order is paid or cancelled.
const pool = require('./db');
const kit = require('./appKit');
const { createOrder, markOrderPaid, cancelOrder } = require('./orders');
const { formatINR } = require('./paymentPages');

const EVENTS = 'PDZ_events';
const RSVPS = 'PDZ_event_rsvps';
const HOLD_MINUTES = 30;
const MAX_PRICE = 10000000; // ₹1,00,000 in paise

const ensureTables = kit.lazyTables([
  `CREATE TABLE IF NOT EXISTS ${EVENTS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(80) NOT NULL,
    description VARCHAR(2000) NOT NULL DEFAULT '',
    date CHAR(10) NOT NULL,
    start_time CHAR(5) NOT NULL DEFAULT '18:00',
    end_time CHAR(5) NOT NULL DEFAULT '',
    mode VARCHAR(10) NOT NULL DEFAULT 'online',
    location VARCHAR(500) NOT NULL DEFAULT '',
    capacity INT NOT NULL DEFAULT 0,
    visible TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_slug (user_id, slug),
    INDEX (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${RSVPS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_id INT NOT NULL,
    user_id INT NOT NULL,
    name VARCHAR(200) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'going',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_event_email (event_id, email),
    INDEX (user_id)
  )`,
  // Listed on PageZaper's marketplace (/explore, lib/marketplace.js) — the creator opts in.
  { sql: `ALTER TABLE ${EVENTS} ADD COLUMN marketplace TINYINT(1) NOT NULL DEFAULT 0`, ignore: ['ER_DUP_FIELDNAME'] },
  // Ticket price in paise (0 = free) and a cover image.
  { sql: `ALTER TABLE ${EVENTS} ADD COLUMN price INT NOT NULL DEFAULT 0`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${EVENTS} ADD COLUMN cover_url VARCHAR(500) NOT NULL DEFAULT ''`, ignore: ['ER_DUP_FIELDNAME'] },
  // Paid tickets: the attendee's own link, their order, what they paid, when the seat was held.
  { sql: `ALTER TABLE ${RSVPS} ADD COLUMN token CHAR(32) NOT NULL DEFAULT ''`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${RSVPS} ADD COLUMN order_id INT NULL DEFAULT NULL`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${RSVPS} ADD COLUMN amount INT NOT NULL DEFAULT 0`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${RSVPS} ADD COLUMN held_at TIMESTAMP NULL DEFAULT NULL`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${RSVPS} ADD INDEX order_id (order_id)`, ignore: ['ER_DUP_KEYNAME'] },
]);

function toEvent(row) {
  const price = Number(row.price) || 0;
  return {
    ...row,
    visible: !!row.visible,
    going: Number(row.going || 0),
    holding: Number(row.holding || 0),
    price,
    priceLabel: price ? formatINR(price) : 'Free',
  };
}

// "999", "499.50", "₹1,200" → paise. Blank or 0 is free.
function priceFromForm(raw) {
  const text = String(raw ?? '').replace(/[₹,\s]/g, '');
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw kit.inputError('The ticket price needs to be an amount in rupees, like 499 or 299.50.');
  const paise = Math.round(Number(text) * 100);
  if (paise && paise < 100) throw kit.inputError('A paid ticket needs to cost at least ₹1 — or pick Free.');
  if (paise > MAX_PRICE) throw kit.inputError(`Keep the ticket price up to ${formatINR(MAX_PRICE)}.`);
  return paise;
}

function imageUrl(raw) {
  const url = kit.cleanText(raw, 500);
  if (url && !/^(https?:\/\/|\/uploads\/)\S+$/i.test(url)) throw kit.inputError('Images need to be an upload or an https:// link.');
  return url;
}

function eventFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the event a name.');
  const date = String(body.date || '');
  if (!kit.isValidDate(date)) throw kit.inputError('Pick the date the event is on.');
  const start = String(body.start_time || '');
  if (!kit.TIME_RE.test(start)) throw kit.inputError('Add a start time.');
  const end = String(body.end_time || '');
  if (end && (!kit.TIME_RE.test(end) || end <= start)) throw kit.inputError('The end time needs to be after the start time.');
  return {
    title,
    description: kit.cleanText(body.description, 2000),
    date,
    start_time: start,
    end_time: end,
    mode: body.mode === 'venue' ? 'venue' : 'online',
    location: kit.cleanText(body.location, 500),
    capacity: kit.cleanInt(body.capacity || 0, { min: 0, max: 100000, fallback: 0 }),
    // The editor's Free / Paid choice: Free saves 0 whatever the price box says.
    price: body.pricing === 'free' ? 0 : priceFromForm(body.price),
    cover_url: imageUrl(body.cover_url),
    visible: body.visible ? 1 : 0,
    marketplace: body.marketplace ? 1 : 0,
  };
}

const WITH_GOING = `SELECT e.*,
  (SELECT COUNT(*) FROM ${RSVPS} r WHERE r.event_id = e.id AND r.status = 'going') AS going,
  (SELECT COUNT(*) FROM ${RSVPS} r WHERE r.event_id = e.id AND r.status = 'pending' AND r.held_at > NOW() - INTERVAL ${HOLD_MINUTES} MINUTE) AS holding
  FROM ${EVENTS} e`;

async function listEvents(userId) {
  await ensureTables();
  const [rows] = await pool.query(`${WITH_GOING} WHERE e.user_id = ? ORDER BY e.date DESC, e.start_time DESC`, [userId]);
  return rows.map(toEvent);
}

async function getEvent(userId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`${WITH_GOING} WHERE e.id = ? AND e.user_id = ?`, [id, userId]);
  return row ? toEvent(row) : null;
}

// The live event at this link. { any: true } also finds a hidden one — a
// ticket bought before the creator hid the page still opens.
async function getPublicEvent(userId, slug, { any = false } = {}) {
  await ensureTables();
  const [[row]] = await pool.query(`${WITH_GOING} WHERE e.user_id = ? AND e.slug = ?${any ? '' : ' AND e.visible = 1'}`, [userId, slug]);
  return row ? toEvent(row) : null;
}

async function createEvent(userId, body) {
  await ensureTables();
  const fields = eventFields({ visible: 1, ...body });
  const slug = await kit.uniqueSlug(EVENTS, userId, body.slug || fields.title, 'event');
  const [result] = await pool.query(`INSERT INTO ${EVENTS} SET ?`, [{ ...fields, slug, user_id: userId }]);
  return result.insertId;
}

async function updateEvent(userId, id, body) {
  await ensureTables();
  const fields = eventFields(body);
  fields.slug = await kit.uniqueSlug(EVENTS, userId, body.slug || fields.title, 'event', id);
  await pool.query(`UPDATE ${EVENTS} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

// The editor's unsaved fields over the saved event, for the live preview
// (lib/livePreview.js) — checked as a save would be, nothing written.
function previewEvent(saved, body) {
  return toEvent({ ...saved, ...eventFields(body) });
}

async function deleteEvent(userId, id) {
  await ensureTables();
  const [result] = await pool.query(`DELETE FROM ${EVENTS} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (result.affectedRows) await pool.query(`DELETE FROM ${RSVPS} WHERE event_id = ? AND user_id = ?`, [id, userId]);
}

function hasEnded(event) {
  const now = kit.nowLocal();
  if (event.date !== now.date) return event.date < now.date;
  return kit.toMinutes(event.end_time || event.start_time) <= now.minutes;
}

// Seats still open: those registered and those held by an unpaid ticket
// (for HOLD_MINUTES) are taken.
function seatsLeft(event) {
  return event.capacity ? Math.max(0, event.capacity - event.going - (event.holding || 0)) : Infinity;
}

// Registers someone for a free event, or finds their existing RSVP (same
// email) — either way they get the confirmation. { already: true } when
// they'd registered before.
async function rsvp(event, person) {
  await ensureTables();
  const [[existing]] = await pool.query(`SELECT * FROM ${RSVPS} WHERE event_id = ? AND email = ?`, [event.id, person.email]);
  if (existing && existing.status === 'going') return { already: true };
  if (hasEnded(event)) throw kit.inputError('This event has already happened.');
  if (seatsLeft(event) <= 0) throw kit.inputError('Sorry — this event is full.');
  if (existing) {
    await pool.query(`UPDATE ${RSVPS} SET status = 'going', name = ?, phone = ? WHERE id = ?`, [person.name, person.phone, existing.id]);
  } else {
    try {
      await pool.query(`INSERT INTO ${RSVPS} SET ?`, [{ event_id: event.id, user_id: event.user_id, ...person, token: kit.newToken() }]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return { already: true };
      throw err;
    }
  }
  return { already: false };
}

// A paid ticket: the RSVP is held as pending with an order for the price
// (`fee` from lib/platform.js), and its link opens the payment step. An
// email that's already registered never gets the link handed back —
// typing someone else's email mustn't open a ticket they paid for.
// Returns { token } or { already: true }.
async function startPaidTicket(event, person, fee) {
  await ensureTables();
  const [[existing]] = await pool.query(`SELECT * FROM ${RSVPS} WHERE event_id = ? AND email = ?`, [event.id, person.email]);
  if (existing && existing.status === 'going') return { already: true };
  if (existing && existing.status === 'pending' && existing.order_id) {
    const [[order]] = await pool.query('SELECT status FROM PDZ_orders WHERE id = ?', [existing.order_id]);
    if (order && order.status === 'pending') return { token: existing.token };
  }
  if (hasEnded(event)) throw kit.inputError('This event has already happened.');
  if (seatsLeft(event) <= 0) throw kit.inputError('Sorry — this event is full.');
  let rsvpId = existing && existing.id;
  const token = (existing && existing.token) || kit.newToken();
  if (!existing) {
    try {
      const [result] = await pool.query(`INSERT INTO ${RSVPS} SET ?`, [{
        event_id: event.id, user_id: event.user_id, ...person, token, status: 'pending', amount: event.price, held_at: new Date(),
      }]);
      rsvpId = result.insertId;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      return startPaidTicket(event, person, fee); // a double submit — use the row it made
    }
  }
  const line = { id: event.id, title: event.title, type: 'event', qty: 1, unit: event.price, amount: event.price, shipFee: 0 };
  const order = await createOrder(event.user_id, { id: null, title: event.title }, { ...person, address: null, note: '' }, {
    lines: [line], subtotal: event.price, discount: 0, total: event.price, coupon: null, shipping: 0,
  }, fee);
  await pool.query(
    `UPDATE ${RSVPS} SET status = 'pending', order_id = ?, amount = ?, name = ?, phone = ?, token = ?, held_at = NOW() WHERE id = ?`,
    [order.id, event.price, person.name, person.phone || '', token, rsvpId],
  );
  return { token };
}

async function getTicket(eventId, token) {
  await ensureTables();
  if (!/^[0-9a-f]{32}$/.test(String(token))) return null;
  const [[row]] = await pool.query(`SELECT * FROM ${RSVPS} WHERE event_id = ? AND token = ?`, [eventId, token]);
  return row || null;
}

// Called by lib/orders.js once a ticket's order is paid: they're going,
// and they join the creator's Audience.
async function confirmFromOrder(order) {
  await ensureTables();
  const [result] = await pool.query(
    `UPDATE ${RSVPS} SET status = 'going' WHERE order_id = ? AND user_id = ? AND status IN ('pending', 'cancelled')`,
    [order.id, order.user_id],
  );
  if (!result.affectedRows) return;
  const [[r]] = await pool.query(
    `SELECT r.*, e.title AS event_title FROM ${RSVPS} r JOIN ${EVENTS} e ON e.id = r.event_id WHERE r.order_id = ? AND r.user_id = ?`,
    [order.id, order.user_id],
  );
  if (!r) return;
  await kit.addToAudience(r.user_id, { name: r.name, email: r.email, phone: r.phone }, {
    source: 'event', sourceId: r.event_id, sourceName: r.event_title, note: `Ticket: ${r.event_title}`,
  });
}

// …and once it's cancelled: the held seat is freed.
async function releaseFromOrder(order) {
  await ensureTables();
  await pool.query(
    `UPDATE ${RSVPS} SET status = 'cancelled' WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
    [order.id, order.user_id],
  );
}

async function listRsvps(userId, eventId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT * FROM ${RSVPS} WHERE event_id = ? AND user_id = ? ORDER BY FIELD(status, 'going', 'pending', 'cancelled'), created_at DESC`,
    [eventId, userId],
  );
  return rows;
}

// The creator cancelling: an unpaid ticket's order is cancelled with it.
async function cancelRsvp(userId, id) {
  await ensureTables();
  const [[r]] = await pool.query(`SELECT * FROM ${RSVPS} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!r) return;
  if (r.status === 'pending' && r.order_id) await cancelOrder(userId, r.order_id);
  await pool.query(`UPDATE ${RSVPS} SET status = 'cancelled' WHERE id = ? AND user_id = ?`, [id, userId]);
}

// Manual payments: the creator got the money themselves and marks the
// ticket paid — its order is paid in Orders, and they're going.
async function markRsvpPaid(userId, id) {
  await ensureTables();
  const [[r]] = await pool.query(`SELECT * FROM ${RSVPS} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!r || r.status !== 'pending' || !r.order_id) throw kit.inputError('That ticket isn’t waiting for payment.');
  await markOrderPaid(userId, r.order_id, { provider: 'manual' });
}

// Live events the creators listed on the marketplace (lib/marketplace.js),
// soonest first; ones already over are left out.
async function listMarketplaceEvents() {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT x.*, u.handle AS owner_handle, u.name AS owner_name FROM (${WITH_GOING} WHERE e.visible = 1 AND e.marketplace = 1 AND e.date >= CURDATE() - INTERVAL 1 DAY) x
     JOIN PDZ_users u ON u.id = x.user_id ORDER BY x.date ASC, x.start_time ASC LIMIT 200`,
  );
  return rows.map(toEvent).filter((e) => !hasEnded(e));
}

module.exports = {
  HOLD_MINUTES,
  listMarketplaceEvents,
  listEvents, getEvent, getPublicEvent, createEvent, updateEvent, deleteEvent, previewEvent,
  hasEnded, seatsLeft, rsvp, startPaidTicket, getTicket, confirmFromOrder, releaseFromOrder,
  listRsvps, cancelRsvp, markRsvpPaid,
};
