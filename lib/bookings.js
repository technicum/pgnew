// Bookings app — 1:1 sessions a visitor books into the creator's calendar.
// The creator sets up services (a "30-min intro call"): how long each slot
// is and the hours they take bookings on each weekday. The public page,
// meera.pagezaper.com/book/:slug (lib/appStorefront.js), shows the open
// slots for the next days_ahead days and books one; the visitor lands in
// Audience tagged 'booking'.
//
// A slot is taken by any confirmed booking that overlaps it — across all
// of the creator's services, since it's one person's calendar. Bookings are
// free for now; a paid service would go through the payment pages checkout.
const pool = require('./db');
const kit = require('./appKit');

const SERVICES = 'PDZ_booking_services';
const BOOKINGS = 'PDZ_bookings';

const ensureTables = kit.lazyTables([
  `CREATE TABLE IF NOT EXISTS ${SERVICES} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(80) NOT NULL,
    description VARCHAR(2000) NOT NULL DEFAULT '',
    duration_min INT NOT NULL DEFAULT 30,
    location VARCHAR(300) NOT NULL DEFAULT '',
    hours VARCHAR(300) NOT NULL DEFAULT '[]',
    min_notice_hours INT NOT NULL DEFAULT 2,
    days_ahead INT NOT NULL DEFAULT 30,
    visible TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_slug (user_id, slug),
    INDEX (user_id)
  )`,
  // slot_key ("2026-10-06 10:30") is cleared when a booking is cancelled,
  // so the unique key only stops two live bookings starting together —
  // the double-submit race. Overlaps are checked before inserting.
  `CREATE TABLE IF NOT EXISTS ${BOOKINGS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    service_id INT NOT NULL,
    service_title VARCHAR(200) NOT NULL DEFAULT '',
    date CHAR(10) NOT NULL,
    start_time CHAR(5) NOT NULL,
    end_time CHAR(5) NOT NULL,
    name VARCHAR(200) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    note VARCHAR(500) NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'confirmed',
    slot_key VARCHAR(20) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_slot (user_id, slot_key),
    INDEX (user_id, date)
  )`,
]);

// Weekly hours: seven entries, Sunday first, each null (closed) or
// ['09:00', '17:00'].
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_HOURS = [null, ['09:00', '17:00'], ['09:00', '17:00'], ['09:00', '17:00'], ['09:00', '17:00'], ['09:00', '17:00'], null];

function parseHours(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (err) { arr = null; }
  }
  if (!Array.isArray(arr) || arr.length !== 7) return DEFAULT_HOURS.map((h) => h && [...h]);
  return arr.map((h) => (Array.isArray(h) && kit.TIME_RE.test(h[0]) && kit.TIME_RE.test(h[1]) && h[0] < h[1] ? [h[0], h[1]] : null));
}

function toService(row) {
  return { ...row, visible: !!row.visible, hours: parseHours(row.hours) };
}

// The form on the service editor posts open_<day>, start_<day>, end_<day>.
function hoursFromForm(body) {
  return WEEKDAYS.map((_, i) => {
    if (!body[`open_${i}`]) return null;
    const start = String(body[`start_${i}`] || '');
    const end = String(body[`end_${i}`] || '');
    if (!kit.TIME_RE.test(start) || !kit.TIME_RE.test(end) || start >= end) {
      throw kit.inputError(`${WEEKDAYS[i]}’s hours need a start time before the end time.`);
    }
    return [start, end];
  });
}

function serviceFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the service a name.');
  return {
    title,
    description: kit.cleanText(body.description, 2000),
    duration_min: kit.cleanInt(body.duration_min, { min: 5, max: 480, fallback: 30 }),
    location: kit.cleanText(body.location, 300),
    min_notice_hours: kit.cleanInt(body.min_notice_hours, { min: 0, max: 720, fallback: 2 }),
    days_ahead: kit.cleanInt(body.days_ahead, { min: 1, max: 180, fallback: 30 }),
    visible: body.visible ? 1 : 0,
  };
}

async function listServices(userId) {
  await ensureTables();
  const today = kit.nowLocal().date;
  const [rows] = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM ${BOOKINGS} b WHERE b.service_id = s.id AND b.status = 'confirmed' AND b.date >= ?) AS upcoming
     FROM ${SERVICES} s WHERE s.user_id = ? ORDER BY s.created_at DESC, s.id DESC`,
    [today, userId],
  );
  return rows.map(toService);
}

async function getService(userId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${SERVICES} WHERE id = ? AND user_id = ?`, [id, userId]);
  return row ? toService(row) : null;
}

async function getPublicService(userId, slug) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${SERVICES} WHERE user_id = ? AND slug = ? AND visible = 1`, [userId, slug]);
  return row ? toService(row) : null;
}

async function createService(userId, body) {
  await ensureTables();
  const fields = { ...serviceFields({ visible: 1, ...body }), hours: JSON.stringify(DEFAULT_HOURS) };
  const slug = await kit.uniqueSlug(SERVICES, userId, body.slug || fields.title, 'session');
  const [result] = await pool.query(`INSERT INTO ${SERVICES} SET ?`, [{ ...fields, slug, user_id: userId }]);
  return result.insertId;
}

async function updateService(userId, id, body) {
  await ensureTables();
  const fields = { ...serviceFields(body), hours: JSON.stringify(hoursFromForm(body)) };
  fields.slug = await kit.uniqueSlug(SERVICES, userId, body.slug || fields.title, 'session', id);
  await pool.query(`UPDATE ${SERVICES} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

// Bookings already made stay in the list (they keep the service's title).
async function deleteService(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${SERVICES} WHERE id = ? AND user_id = ?`, [id, userId]);
}

async function confirmedBetween(userId, from, to) {
  const [rows] = await pool.query(
    `SELECT date, start_time, end_time FROM ${BOOKINGS} WHERE user_id = ? AND status = 'confirmed' AND date BETWEEN ? AND ?`,
    [userId, from, to],
  );
  return rows;
}

// Every open slot from today to days_ahead out, as { date: ['09:00', …] }
// — only days with at least one slot are listed.
async function openSlots(service) {
  await ensureTables();
  const now = kit.nowLocal();
  const last = kit.addDays(now.date, service.days_ahead - 1);
  const taken = await confirmedBetween(service.user_id, now.date, last);
  const earliest = now.minutes + service.min_notice_hours * 60; // minutes from today's midnight
  const days = {};
  for (let i = 0; i < service.days_ahead; i += 1) {
    const date = kit.addDays(now.date, i);
    const hours = service.hours[kit.weekday(date)];
    if (!hours) continue;
    const busy = taken.filter((b) => b.date === date).map((b) => [kit.toMinutes(b.start_time), kit.toMinutes(b.end_time)]);
    const slots = [];
    for (let t = kit.toMinutes(hours[0]); t + service.duration_min <= kit.toMinutes(hours[1]); t += service.duration_min) {
      if (i * 1440 + t < earliest) continue;
      if (busy.some(([s, e]) => t < e && s < t + service.duration_min)) continue;
      slots.push(kit.fromMinutes(t));
    }
    if (slots.length) days[date] = slots;
  }
  return days;
}

async function createBooking(service, { date, start, person, note }) {
  const days = await openSlots(service);
  if (!(days[date] || []).includes(start)) {
    throw kit.inputError('That time was just taken or isn’t available any more — pick another.');
  }
  const end = kit.fromMinutes(kit.toMinutes(start) + service.duration_min);
  try {
    const [result] = await pool.query(`INSERT INTO ${BOOKINGS} SET ?`, [{
      user_id: service.user_id,
      service_id: service.id,
      service_title: service.title,
      date,
      start_time: start,
      end_time: end,
      name: person.name,
      email: person.email,
      phone: person.phone,
      note: kit.cleanText(note, 500),
      slot_key: `${date} ${start}`,
    }]);
    return { id: result.insertId, date, start_time: start, end_time: end };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw kit.inputError('That time was just taken — pick another.');
    throw err;
  }
}

// upcoming: today onwards, soonest first; otherwise the past, latest first.
async function listBookings(userId, { upcoming = true } = {}) {
  await ensureTables();
  const today = kit.nowLocal().date;
  const [rows] = await pool.query(
    upcoming
      ? `SELECT * FROM ${BOOKINGS} WHERE user_id = ? AND date >= ? ORDER BY date ASC, start_time ASC LIMIT 200`
      : `SELECT * FROM ${BOOKINGS} WHERE user_id = ? AND date < ? ORDER BY date DESC, start_time DESC LIMIT 200`,
    [userId, today],
  );
  return rows;
}

async function cancelBooking(userId, id) {
  await ensureTables();
  await pool.query(`UPDATE ${BOOKINGS} SET status = 'cancelled', slot_key = NULL WHERE id = ? AND user_id = ?`, [id, userId]);
}

module.exports = {
  WEEKDAYS,
  listServices, getService, getPublicService, createService, updateService, deleteService,
  openSlots, createBooking, listBookings, cancelBooking,
};
