// Bookings app — 1:1 sessions a visitor books into the creator's calendar.
// The creator sets up services (a "30-min intro call"): length, price,
// weekly hours (up to three ranges a day, so a lunch break works), a gap
// between sessions, a daily cap and their own questions. Days off apply to
// every service. The public page, meera.pagezaper.com/book/:slug
// (lib/appStorefront.js), shows a month calendar of open days, the times on
// the picked day, and the booking form.
//
// A slot is taken by any live booking that overlaps it (plus the buffer) —
// across all of the creator's services, since it's one person's calendar.
//
// status:  confirmed — a free booking, or a paid one once its order is paid
//          pending   — a paid booking waiting for its order (lib/orders.js);
//                      it holds the slot. In test mode an unpaid hold lapses
//                      after HOLD_MINUTES ('expired'); in manual mode it
//                      holds until the creator marks it paid or cancels.
//          cancelled / expired — the slot is free again
//
// A paid booking is an ordinary order (page_id NULL, one item of type
// 'booking'), so it shows in Orders and goes through the same test-mode /
// manual payment flow as payment pages. orders.js calls confirmFromOrder()
// and releaseFromOrder() when that order is paid or cancelled.
const pool = require('./db');
const kit = require('./appKit');
const { formatINR } = require('./paymentPages');
const { createOrder, markOrderPaid, cancelOrder } = require('./orders');
const { paymentMode } = require('./payments');

const SERVICES = 'PDZ_booking_services';
const BOOKINGS = 'PDZ_bookings';
const DAYS_OFF = 'PDZ_booking_days_off';
const HOLD_MINUTES = 30;
const MAX_RANGES = 3;
const MAX_QUESTIONS = 5;
const MAX_PRICE = 10000000; // ₹1,00,000 in paise

const ensureTables = kit.lazyTables([
  `CREATE TABLE IF NOT EXISTS ${SERVICES} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(80) NOT NULL,
    description VARCHAR(2000) NOT NULL DEFAULT '',
    duration_min INT NOT NULL DEFAULT 30,
    price INT NOT NULL DEFAULT 0,
    location VARCHAR(300) NOT NULL DEFAULT '',
    hours VARCHAR(800) NOT NULL DEFAULT '[]',
    buffer_min INT NOT NULL DEFAULT 0,
    max_per_day INT NOT NULL DEFAULT 0,
    min_notice_hours INT NOT NULL DEFAULT 2,
    days_ahead INT NOT NULL DEFAULT 30,
    questions VARCHAR(3000) NOT NULL DEFAULT '[]',
    cover_url VARCHAR(500) NOT NULL DEFAULT '',
    photo_url VARCHAR(500) NOT NULL DEFAULT '',
    visible TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_slug (user_id, slug),
    INDEX (user_id)
  )`,
  // slot_key ("2026-10-06 10:30") is cleared when a booking stops being
  // live, so the unique key only stops two live bookings starting together
  // — the double-submit race. Overlaps are checked before inserting.
  `CREATE TABLE IF NOT EXISTS ${BOOKINGS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    service_id INT NOT NULL,
    service_title VARCHAR(200) NOT NULL DEFAULT '',
    token CHAR(32) NOT NULL,
    date CHAR(10) NOT NULL,
    start_time CHAR(5) NOT NULL,
    end_time CHAR(5) NOT NULL,
    name VARCHAR(200) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    note VARCHAR(500) NOT NULL DEFAULT '',
    answers TEXT NULL,
    location VARCHAR(300) NOT NULL DEFAULT '',
    amount INT NOT NULL DEFAULT 0,
    order_id INT NULL DEFAULT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'confirmed',
    slot_key VARCHAR(20) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_token (token),
    UNIQUE KEY uniq_user_slot (user_id, slot_key),
    INDEX (user_id, date),
    INDEX (order_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${DAYS_OFF} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    date CHAR(10) NOT NULL,
    note VARCHAR(100) NOT NULL DEFAULT '',
    UNIQUE KEY uniq_user_date (user_id, date)
  )`,
]);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NINE_TO_FIVE = [['09:00', '17:00']];
const DEFAULT_HOURS = [[], NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, []];

// --- Weekly hours ------------------------------------------------------------
// Seven entries, Sunday first, each a list of ['09:00', '13:00'] ranges
// (empty = closed).
function parseHours(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (err) { arr = null; }
  }
  if (!Array.isArray(arr) || arr.length !== 7) return DEFAULT_HOURS.map((d) => d.map((r) => [...r]));
  const valid = (r) => Array.isArray(r) && kit.TIME_RE.test(r[0]) && kit.TIME_RE.test(r[1]) && r[0] < r[1];
  return arr.map((day) => (Array.isArray(day) ? day.filter(valid).map((r) => [r[0], r[1]]).slice(0, MAX_RANGES) : []));
}

// The editor posts open_<day> plus start_<day>_<n> / end_<day>_<n>; a
// range left blank is skipped.
function hoursFromForm(body) {
  return WEEKDAYS.map((name, d) => {
    if (!body[`open_${d}`]) return [];
    const ranges = [];
    for (let n = 0; n < MAX_RANGES; n += 1) {
      const start = String(body[`start_${d}_${n}`] || '');
      const end = String(body[`end_${d}_${n}`] || '');
      if (!start && !end) continue;
      if (!kit.TIME_RE.test(start) || !kit.TIME_RE.test(end) || start >= end) {
        throw kit.inputError(`${name}’s hours need each start time before its end time.`);
      }
      ranges.push([start, end]);
    }
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (ranges.some((r, i) => i && r[0] < ranges[i - 1][1])) throw kit.inputError(`${name}’s hours overlap — keep each range separate.`);
    if (!ranges.length) throw kit.inputError(`Add ${name}’s hours, or untick it to close that day.`);
    return ranges;
  });
}

// --- Questions -----------------------------------------------------------------
// The creator's own questions on the booking form, beyond name/email/phone.
const QUESTION_TYPES = { text: 'Short answer', textarea: 'Long answer', phone: 'Phone number', dropdown: 'Dropdown', radio: 'Choose one', checkbox: 'Tick box' };
const OPTION_TYPES = new Set(['dropdown', 'radio']);

function parseQuestions(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (err) { arr = []; }
  }
  return Array.isArray(arr) ? arr.filter((q) => q && q.label && QUESTION_TYPES[q.type]).slice(0, MAX_QUESTIONS) : [];
}

// q_label_<n>, q_type_<n>, q_options_<n> (comma-separated), q_required_<n>.
// Ids stay stable per row so a renamed question keeps its answers' meaning.
function questionsFromForm(body) {
  const questions = [];
  for (let n = 0; n < MAX_QUESTIONS; n += 1) {
    const label = kit.cleanText(body[`q_label_${n}`], 120);
    if (!label) continue;
    const type = QUESTION_TYPES[body[`q_type_${n}`]] ? body[`q_type_${n}`] : 'text';
    const options = OPTION_TYPES.has(type)
      ? [...new Set(String(body[`q_options_${n}`] || '').split(',').map((o) => o.trim().slice(0, 40)).filter(Boolean))].slice(0, 10)
      : [];
    if (OPTION_TYPES.has(type) && options.length < 2) throw kit.inputError(`“${label}” needs at least two choices, separated by commas.`);
    questions.push({ id: n + 1, label, type, options, required: !!body[`q_required_${n}`] });
  }
  return questions;
}

// A visitor's answers (a_<id> fields), checked. Returns { answers, error }.
function readAnswers(service, body) {
  const answers = [];
  for (const q of service.questions) {
    const value = q.type === 'checkbox' ? (body[`a_${q.id}`] ? 'Yes' : '') : kit.cleanText(body[`a_${q.id}`], q.type === 'textarea' ? 1000 : 200);
    if (q.required && !value) {
      return { error: q.type === 'checkbox' ? `Tick “${q.label}” to continue.` : `Answer “${q.label}” to continue.`, answers };
    }
    if (value && OPTION_TYPES.has(q.type) && !q.options.includes(value)) return { error: `Pick one of the choices for “${q.label}”.`, answers };
    if (value && q.type === 'phone' && !/^\+?[\d\s().-]{6,}$/.test(value)) return { error: `The answer for “${q.label}” doesn’t look like a phone number.`, answers };
    answers.push({ id: q.id, label: q.label, value });
  }
  return { answers };
}

// --- Services --------------------------------------------------------------

function toService(row) {
  return {
    ...row,
    visible: !!row.visible,
    hours: parseHours(row.hours),
    questions: parseQuestions(row.questions),
    priceLabel: row.price ? formatINR(row.price) : 'Free',
  };
}

// "500", "499.50", "₹1,200" → paise. Blank or 0 is free.
function priceFromForm(raw) {
  const text = String(raw ?? '').replace(/[₹,\s]/g, '');
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw kit.inputError('The price needs to be an amount in rupees, like 500 or 499.50.');
  const paise = Math.round(Number(text) * 100);
  if (paise && paise < 100) throw kit.inputError('A paid session needs to cost at least ₹1 — or leave the price at 0 for free.');
  if (paise > MAX_PRICE) throw kit.inputError(`Keep the price up to ${formatINR(MAX_PRICE)}.`);
  return paise;
}

function imageUrl(raw) {
  const url = kit.cleanText(raw, 500);
  if (url && !/^(https?:\/\/|\/uploads\/)\S+$/i.test(url)) throw kit.inputError('Images need to be an upload or an https:// link.');
  return url;
}

function serviceFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the service a name.');
  return {
    title,
    description: kit.cleanText(body.description, 2000),
    duration_min: kit.cleanInt(body.duration_min, { min: 5, max: 480, fallback: 30 }),
    price: priceFromForm(body.price),
    location: kit.cleanText(body.location, 300),
    min_notice_hours: kit.cleanInt(body.min_notice_hours, { min: 0, max: 720, fallback: 2 }),
    days_ahead: kit.cleanInt(body.days_ahead, { min: 1, max: 180, fallback: 30 }),
    buffer_min: kit.cleanInt(body.buffer_min || 0, { min: 0, max: 240, fallback: 0 }),
    max_per_day: kit.cleanInt(body.max_per_day || 0, { min: 0, max: 100, fallback: 0 }),
    cover_url: imageUrl(body.cover_url),
    photo_url: imageUrl(body.photo_url),
    visible: body.visible ? 1 : 0,
  };
}

async function listServices(userId) {
  await ensureTables();
  const today = kit.nowLocal().date;
  const [rows] = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM ${BOOKINGS} b WHERE b.service_id = s.id AND b.status IN ('confirmed', 'pending') AND b.date >= ?) AS upcoming
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

// Name, length and price from the "new service" form; hours start at
// Mon–Fri 9–5.
async function createService(userId, body) {
  await ensureTables();
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the service a name.');
  const fields = {
    title,
    duration_min: kit.cleanInt(body.duration_min, { min: 5, max: 480, fallback: 30 }),
    price: priceFromForm(body.price),
    hours: JSON.stringify(DEFAULT_HOURS),
  };
  const slug = await kit.uniqueSlug(SERVICES, userId, title, 'session');
  const [result] = await pool.query(`INSERT INTO ${SERVICES} SET ?`, [{ ...fields, slug, user_id: userId }]);
  return result.insertId;
}

async function updateService(userId, id, body) {
  await ensureTables();
  const fields = {
    ...serviceFields(body),
    hours: JSON.stringify(hoursFromForm(body)),
    questions: JSON.stringify(questionsFromForm(body)),
  };
  fields.slug = await kit.uniqueSlug(SERVICES, userId, body.slug || fields.title, 'session', id);
  await pool.query(`UPDATE ${SERVICES} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

// Bookings already made stay in the list (they keep the service's title).
async function deleteService(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${SERVICES} WHERE id = ? AND user_id = ?`, [id, userId]);
}

// --- Days off --------------------------------------------------------------

async function listDaysOff(userId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${DAYS_OFF} WHERE user_id = ? AND date >= ? ORDER BY date`, [userId, kit.nowLocal().date]);
  return rows;
}

// One day, or every day from `from` to `to` (up to 90).
async function addDaysOff(userId, { from, to, note }) {
  await ensureTables();
  const end = to || from;
  if (!kit.isValidDate(from) || !kit.isValidDate(end) || end < from) throw kit.inputError('Pick the first and last day you’re off.');
  const dates = [];
  for (let d = from; d <= end; d = kit.addDays(d, 1)) {
    dates.push(d);
    if (dates.length > 90) throw kit.inputError('Add up to 90 days off at a time.');
  }
  const label = kit.cleanText(note, 100);
  await pool.query(
    `INSERT INTO ${DAYS_OFF} (user_id, date, note) VALUES ? ON DUPLICATE KEY UPDATE note = VALUES(note)`,
    [dates.map((d) => [userId, d, label])],
  );
}

async function deleteDayOff(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${DAYS_OFF} WHERE id = ? AND user_id = ?`, [id, userId]);
}

// --- Availability --------------------------------------------------------------

// Test mode only: an unpaid hold lapses so a visitor who wandered off at
// checkout doesn't keep the slot. Its order is cancelled with it.
async function releaseExpiredHolds(userId) {
  if (paymentMode() !== 'test') return;
  const [rows] = await pool.query(
    `SELECT id, order_id FROM ${BOOKINGS} WHERE user_id = ? AND status = 'pending' AND created_at < NOW() - INTERVAL ${HOLD_MINUTES} MINUTE`,
    [userId],
  );
  if (!rows.length) return;
  await pool.query(`UPDATE ${BOOKINGS} SET status = 'expired', slot_key = NULL WHERE id IN (?) AND status = 'pending'`, [rows.map((r) => r.id)]);
  await Promise.all(rows.filter((r) => r.order_id).map((r) => cancelOrder(userId, r.order_id)));
}

// Every open slot from today to days_ahead out, as { date: ['09:00', …] }
// — only days with at least one slot are listed.
async function openSlots(service) {
  await ensureTables();
  await releaseExpiredHolds(service.user_id);
  const now = kit.nowLocal();
  const last = kit.addDays(now.date, service.days_ahead - 1);
  const [[taken], [off]] = await Promise.all([
    pool.query(
      `SELECT service_id, date, start_time, end_time FROM ${BOOKINGS}
       WHERE user_id = ? AND status IN ('confirmed', 'pending') AND date BETWEEN ? AND ?`,
      [service.user_id, now.date, last],
    ),
    pool.query(`SELECT date FROM ${DAYS_OFF} WHERE user_id = ? AND date BETWEEN ? AND ?`, [service.user_id, now.date, last]),
  ]);
  const offDays = new Set(off.map((r) => r.date));
  const earliest = now.minutes + service.min_notice_hours * 60; // minutes from today's midnight
  const length = service.duration_min;
  const gap = service.buffer_min;
  const days = {};
  for (let i = 0; i < service.days_ahead; i += 1) {
    const date = kit.addDays(now.date, i);
    const ranges = service.hours[kit.weekday(date)];
    if (!ranges.length || offDays.has(date)) continue;
    const onDay = taken.filter((b) => b.date === date);
    if (service.max_per_day && onDay.filter((b) => b.service_id === service.id).length >= service.max_per_day) continue;
    const busy = onDay.map((b) => [kit.toMinutes(b.start_time) - gap, kit.toMinutes(b.end_time) + gap]);
    const slots = [];
    for (const [from, to] of ranges) {
      for (let t = kit.toMinutes(from); t + length <= kit.toMinutes(to); t += length + gap) {
        if (i * 1440 + t < earliest) continue;
        if (busy.some(([s, e]) => t < e && s < t + length)) continue;
        slots.push(kit.fromMinutes(t));
      }
    }
    if (slots.length) days[date] = slots;
  }
  return days;
}

// --- Bookings --------------------------------------------------------------

function toBooking(row) {
  if (!row) return null;
  let answers = [];
  try { answers = row.answers ? JSON.parse(row.answers) : []; } catch (err) { answers = []; }
  return { ...row, answers, amountLabel: row.amount ? formatINR(row.amount) : '' };
}

// A free service books straight away; a paid one places an order and
// holds the slot until it's paid.
async function createBooking(service, { date, start, person, note, answers }) {
  const days = await openSlots(service);
  if (!(days[date] || []).includes(start)) {
    throw kit.inputError('That time was just taken or isn’t available any more — pick another.');
  }
  const end = kit.fromMinutes(kit.toMinutes(start) + service.duration_min);
  const paid = service.price > 0;
  const token = kit.newToken();
  let id;
  try {
    const [result] = await pool.query(`INSERT INTO ${BOOKINGS} SET ?`, [{
      user_id: service.user_id,
      service_id: service.id,
      service_title: service.title,
      token,
      date,
      start_time: start,
      end_time: end,
      name: person.name,
      email: person.email,
      phone: person.phone,
      note: kit.cleanText(note, 500),
      answers: JSON.stringify(answers || []),
      location: service.location,
      amount: service.price,
      status: paid ? 'pending' : 'confirmed',
      slot_key: `${date} ${start}`,
    }]);
    id = result.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw kit.inputError('That time was just taken — pick another.');
    throw err;
  }

  if (paid) {
    const line = { id: service.id, title: `${service.title} — ${kit.formatDate(date)}, ${kit.formatTime(start)}`, type: 'booking', qty: 1, unit: service.price, amount: service.price, shipFee: 0 };
    const order = await createOrder(service.user_id, { id: null, title: service.title }, { ...person, address: null, note: '' }, {
      lines: [line], subtotal: service.price, discount: 0, total: service.price, coupon: null, shipping: 0,
    });
    await pool.query(`UPDATE ${BOOKINGS} SET order_id = ? WHERE id = ?`, [order.id, id]);
  } else {
    await addBookingToAudience({ user_id: service.user_id, service_id: service.id, service_title: service.title, date, start_time: start, ...person });
  }
  return token;
}

async function addBookingToAudience(b) {
  await kit.addToAudience(b.user_id, { name: b.name, email: b.email, phone: b.phone }, {
    source: 'booking', sourceId: b.service_id, sourceName: b.service_title,
    note: `Booked: ${b.service_title} on ${b.date} ${b.start_time}`,
  });
}

async function getBookingByToken(userId, token) {
  await ensureTables();
  await releaseExpiredHolds(userId);
  const [[row]] = await pool.query(`SELECT * FROM ${BOOKINGS} WHERE user_id = ? AND token = ?`, [userId, token]);
  return toBooking(row);
}

// Called by lib/orders.js once a booking's order is paid / cancelled.
async function confirmFromOrder(order) {
  await ensureTables();
  const [result] = await pool.query(
    `UPDATE ${BOOKINGS} SET status = 'confirmed' WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
    [order.id, order.user_id],
  );
  if (!result.affectedRows) return;
  const [[b]] = await pool.query(`SELECT * FROM ${BOOKINGS} WHERE order_id = ? AND user_id = ?`, [order.id, order.user_id]);
  await addBookingToAudience(b);
}
async function releaseFromOrder(order) {
  await ensureTables();
  await pool.query(
    `UPDATE ${BOOKINGS} SET status = 'cancelled', slot_key = NULL WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
    [order.id, order.user_id],
  );
}

// The visitor's own "Complete test payment" / "Cancel" on their booking
// page (test mode).
async function payTestBooking(booking) {
  if (paymentMode() !== 'test' || booking.status !== 'pending' || !booking.order_id) return false;
  return markOrderPaid(booking.user_id, booking.order_id, { provider: 'test' });
}
async function abandonBooking(booking) {
  if (booking.status !== 'pending' || !booking.order_id) return;
  await cancelOrder(booking.user_id, booking.order_id);
}

// upcoming: today onwards, soonest first; otherwise the past, latest first.
async function listBookings(userId, { upcoming = true } = {}) {
  await ensureTables();
  await releaseExpiredHolds(userId);
  const today = kit.nowLocal().date;
  const [rows] = await pool.query(
    upcoming
      ? `SELECT * FROM ${BOOKINGS} WHERE user_id = ? AND date >= ? AND status <> 'expired' ORDER BY date ASC, start_time ASC LIMIT 200`
      : `SELECT * FROM ${BOOKINGS} WHERE user_id = ? AND date < ? AND status <> 'expired' ORDER BY date DESC, start_time DESC LIMIT 200`,
    [userId, today],
  );
  return rows.map(toBooking);
}

// The creator cancelling: an unpaid booking's order is cancelled with it.
async function cancelBooking(userId, id) {
  await ensureTables();
  const [[b]] = await pool.query(`SELECT * FROM ${BOOKINGS} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!b) return;
  if (b.status === 'pending' && b.order_id) await cancelOrder(userId, b.order_id);
  await pool.query(`UPDATE ${BOOKINGS} SET status = 'cancelled', slot_key = NULL WHERE id = ? AND user_id = ?`, [id, userId]);
}

// The creator was paid some other way (manual mode) — same as marking the
// order paid in Orders.
async function markBookingPaid(userId, id) {
  await ensureTables();
  const [[b]] = await pool.query(`SELECT * FROM ${BOOKINGS} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!b || b.status !== 'pending' || !b.order_id) throw kit.inputError('That booking isn’t waiting for payment.');
  await markOrderPaid(userId, b.order_id, { provider: 'manual' });
}

// --- Calendar links -------------------------------------------------------------

// 'YYYY-MM-DD' + 'HH:MM' on the store clock → '20261007T043000Z'.
function utcStamp(date, time) {
  const ms = Date.parse(`${date}T${time}:00Z`) - kit.STORE_UTC_OFFSET_MIN * 60000;
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function googleCalendarUrl(b, ownerName) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${b.service_title} with ${ownerName}`,
    dates: `${utcStamp(b.date, b.start_time)}/${utcStamp(b.date, b.end_time)}`,
    details: `Booked on ${ownerName}’s page.`,
    location: b.location || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function icsFile(b, ownerName, host) {
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PageZaper//Bookings//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:booking-${b.token}@${host}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${utcStamp(b.date, b.start_time)}`,
    `DTEND:${utcStamp(b.date, b.end_time)}`,
    `SUMMARY:${esc(`${b.service_title} with ${ownerName}`)}`,
    b.location ? `LOCATION:${esc(b.location)}` : null,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== null).join('\r\n');
}

module.exports = {
  WEEKDAYS, QUESTION_TYPES, MAX_RANGES, MAX_QUESTIONS, HOLD_MINUTES,
  listServices, getService, getPublicService, createService, updateService, deleteService,
  listDaysOff, addDaysOff, deleteDayOff,
  openSlots, readAnswers, createBooking, getBookingByToken, listBookings, cancelBooking, markBookingPaid,
  confirmFromOrder, releaseFromOrder, payTestBooking, abandonBooking,
  googleCalendarUrl, icsFile,
};
