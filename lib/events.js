// Events app — a workshop, webinar or meetup with a date, a place (a venue
// or an online link) and optionally a cap on seats. Its public page,
// meera.pagezaper.com/event/:slug (lib/appStorefront.js), takes RSVPs; each
// one lands in Audience tagged 'event'. An online event's join link is only
// shown to people who've registered. Free for now — paid tickets would go
// through the payment pages checkout.
const pool = require('./db');
const kit = require('./appKit');

const EVENTS = 'PDZ_events';
const RSVPS = 'PDZ_event_rsvps';

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
]);

function toEvent(row) {
  return { ...row, visible: !!row.visible, going: Number(row.going || 0) };
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
    visible: body.visible ? 1 : 0,
    marketplace: body.marketplace ? 1 : 0,
  };
}

const WITH_GOING = `SELECT e.*, (SELECT COUNT(*) FROM ${RSVPS} r WHERE r.event_id = e.id AND r.status = 'going') AS going FROM ${EVENTS} e`;

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

async function getPublicEvent(userId, slug) {
  await ensureTables();
  const [[row]] = await pool.query(`${WITH_GOING} WHERE e.user_id = ? AND e.slug = ? AND e.visible = 1`, [userId, slug]);
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

function seatsLeft(event) {
  return event.capacity ? Math.max(0, event.capacity - event.going) : Infinity;
}

// Registers someone, or finds their existing RSVP (same email) — either way
// they get the confirmation. { already: true } when they'd registered before.
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
      await pool.query(`INSERT INTO ${RSVPS} SET ?`, [{ event_id: event.id, user_id: event.user_id, ...person }]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return { already: true };
      throw err;
    }
  }
  return { already: false };
}

async function listRsvps(userId, eventId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT * FROM ${RSVPS} WHERE event_id = ? AND user_id = ? ORDER BY status = 'going' DESC, created_at DESC`,
    [eventId, userId],
  );
  return rows;
}

async function cancelRsvp(userId, id) {
  await ensureTables();
  await pool.query(`UPDATE ${RSVPS} SET status = 'cancelled' WHERE id = ? AND user_id = ?`, [id, userId]);
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
  listMarketplaceEvents,
  listEvents, getEvent, getPublicEvent, createEvent, updateEvent, deleteEvent,
  hasEnded, seatsLeft, rsvp, listRsvps, cancelRsvp,
};
