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
//                      it holds the slot. In test and Cashfree modes an
//                      unpaid hold lapses after HOLD_MINUTES ('expired'); in
//                      manual mode it holds until the creator marks it paid
//                      or cancels.
//          cancelled / expired — the slot is free again
//
// A paid booking is an ordinary order (page_id NULL, one item of type
// 'booking'), so it shows in Orders and goes through the same test /
// Cashfree / manual payment flow as payment pages. orders.js calls confirmFromOrder()
// and releaseFromOrder() when that order is paid or cancelled.
const pool = require('./db');
const kit = require('./appKit');
const { formatINR } = require('./paymentPages');
const { createOrder, getOrder, markOrderPaid, cancelOrder } = require('./orders');
const { paymentMode, isGatewayMode, syncGatewayOrder } = require('./payments');
const { feeOn } = require('./platform');

const SERVICES = 'PDZ_booking_services';
const BOOKINGS = 'PDZ_bookings';
const DAYS_OFF = 'PDZ_booking_days_off';
const SETTINGS = 'PDZ_booking_settings';
const HOLD_MINUTES = 30;
const MAX_RANGES = 3;
const MAX_QUESTIONS = 10;
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
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
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
  // Tables made by the first version of this app (before prices, split
  // hours, questions and the booking page) lack these — add them. Old
  // bookings get a token so they have a booking page too.
  ...[
    `ALTER TABLE ${SERVICES} ADD COLUMN price INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${SERVICES} ADD COLUMN buffer_min INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${SERVICES} ADD COLUMN max_per_day INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${SERVICES} ADD COLUMN questions VARCHAR(3000) NOT NULL DEFAULT '[]'`,
    `ALTER TABLE ${SERVICES} ADD COLUMN cover_url VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${SERVICES} ADD COLUMN photo_url VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN token CHAR(32) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN answers TEXT NULL`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN location VARCHAR(300) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN amount INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN order_id INT NULL DEFAULT NULL`,
    // Availability moved to Settings: services made before that keep the
    // hours they had (custom_hours = 1); new ones follow Settings.
    `ALTER TABLE ${SERVICES} ADD COLUMN custom_hours TINYINT(1) NOT NULL DEFAULT 1`,
    // Each booking keeps the timezone its times were in, so changing the
    // setting later never moves a booking already made.
    `ALTER TABLE ${BOOKINGS} ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'`,
    // Where it happens (ATTEND) and how it's paid for (PAY_OPTIONS). A
    // service from before has attend '' — its `location` is free text,
    // shown as it was — until it's saved again.
    `ALTER TABLE ${SERVICES} ADD COLUMN attend VARCHAR(10) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${SERVICES} ADD COLUMN meeting_url VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${SERVICES} ADD COLUMN pay_option VARCHAR(10) NOT NULL DEFAULT 'online'`,
    `ALTER TABLE ${SERVICES} ADD COLUMN deposit INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN attend VARCHAR(10) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN meeting_url VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${BOOKINGS} ADD COLUMN due_later INT NOT NULL DEFAULT 0`,
    // Listed on PageZaper's marketplace (/explore, lib/marketplace.js) — the creator opts in.
    `ALTER TABLE ${SERVICES} ADD COLUMN marketplace TINYINT(1) NOT NULL DEFAULT 0`,
  ].map((sql) => ({ sql, ignore: ['ER_DUP_FIELDNAME'] })),
  `ALTER TABLE ${SERVICES} MODIFY COLUMN hours VARCHAR(800) NOT NULL DEFAULT '[]'`,
  // Up to 10 questions with choices outgrew VARCHAR(3000).
  `ALTER TABLE ${SERVICES} MODIFY COLUMN questions TEXT NULL`,
  // One row per creator: their booking page (/book — every service on one
  // link) and defaults the services fall back to.
  `CREATE TABLE IF NOT EXISTS ${SETTINGS} (
    user_id INT NOT NULL PRIMARY KEY,
    headline VARCHAR(120) NOT NULL DEFAULT '',
    intro VARCHAR(1000) NOT NULL DEFAULT '',
    photo_url VARCHAR(500) NOT NULL DEFAULT '',
    cover_url VARCHAR(500) NOT NULL DEFAULT '',
    payment_note VARCHAR(500) NOT NULL DEFAULT '',
    hours VARCHAR(800) NOT NULL DEFAULT '',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    listing_visible TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  { sql: `ALTER TABLE ${SETTINGS} ADD COLUMN hours VARCHAR(800) NOT NULL DEFAULT ''`, ignore: ['ER_DUP_FIELDNAME'] },
  { sql: `ALTER TABLE ${SETTINGS} ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'`, ignore: ['ER_DUP_FIELDNAME'] },
  `UPDATE ${BOOKINGS} SET token = MD5(CONCAT(id, '-', user_id, '-', RAND(), '-', created_at)) WHERE token = ''`,
  { sql: `ALTER TABLE ${BOOKINGS} ADD UNIQUE KEY uniq_token (token)`, ignore: ['ER_DUP_KEYNAME'] },
  { sql: `ALTER TABLE ${BOOKINGS} ADD INDEX order_id (order_id)`, ignore: ['ER_DUP_KEYNAME'] },
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
  return arr.map((day) => {
    if (!Array.isArray(day)) return []; // null: closed
    if (typeof day[0] === 'string') return valid(day) ? [[day[0], day[1]]] : []; // first version: one ['09:00', '17:00'] per day
    return day.filter(valid).map((r) => [r[0], r[1]]).slice(0, MAX_RANGES);
  });
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

// "Mon–Fri 9:00 am – 5:00 pm · Sat 10:00 am – 12:00 pm" — consecutive days
// (Monday first) with the same hours share one entry.
function hoursSummary(hours) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const short = (d) => WEEKDAYS[d].slice(0, 3);
  const label = (ranges) => ranges.map((r) => `${kit.formatTime(r[0])} – ${kit.formatTime(r[1])}`).join(', ');
  const groups = [];
  order.forEach((d) => {
    const key = JSON.stringify(hours[d]);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.to = d;
    else groups.push({ key, from: d, to: d, ranges: hours[d] });
  });
  const open = groups.filter((g) => g.ranges.length);
  if (!open.length) return 'no hours set';
  return open.map((g) => `${short(g.from)}${g.from === g.to ? '' : `–${short(g.to)}`} ${label(g.ranges)}`).join(' · ');
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

// --- Where and how it's paid -----------------------------------------------
// online    — a video call; meeting_url is shown only once booked
// in_person — at `location` (an address — the booking page links it to maps)
// either    — the booker picks one of the two
const ATTEND = { online: 'Online', in_person: 'In person', either: 'Online or in person' };
// online  — the full price, paid when booking
// deposit — `deposit` paid when booking, the rest at the appointment
// later   — nothing online; booked straight away, paid at the appointment
const PAY_OPTIONS = { online: 'Full price online', deposit: 'Advance online, rest later', later: 'Pay at the appointment' };

// What a paid booking of this service collects online now. PageZaper's fee
// (lib/platform.js — `pct` of the full price) is always collected online:
// a "pay at the appointment" service takes just the fee as its advance,
// and an advance is never less than the fee.
function payNow(service, pct = 0) {
  if (!service.price) return 0;
  const fee = feeOn(service.price, pct);
  if (service.pay_option === 'later') return fee;
  if (service.pay_option === 'deposit') return Math.max(Math.min(service.deposit, service.price), fee);
  return service.price;
}

// Sets a service's online amounts for a visitor whose sale carries `pct`.
function applyFee(service, pct) {
  service.feePct = pct;
  service.payNow = payNow(service, pct);
  service.payNowLabel = formatINR(service.payNow);
  service.dueLaterLabel = formatINR(service.price - service.payNow);
  return service;
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// --- Services --------------------------------------------------------------

function toService(row) {
  const service = {
    ...row,
    visible: !!row.visible,
    custom_hours: !!row.custom_hours,
    hours: parseHours(row.hours),
    questions: parseQuestions(row.questions),
    priceLabel: row.price ? formatINR(row.price) : 'Free',
    pay_option: PAY_OPTIONS[row.pay_option] ? row.pay_option : 'online',
  };
  applyFee(service, 0);
  service.attendLabel = ATTEND[service.attend] || '';
  service.mapsUrl = service.location && (service.attend === 'in_person' || service.attend === 'either') ? mapsUrl(service.location) : null;
  return service;
}

// attend / location / meeting_url / pay_option / deposit from the editor.
function placeAndPaymentFields(body, price) {
  const attend = ATTEND[body.attend] ? body.attend : 'online';
  const location = kit.cleanText(body.location, 300);
  const meetingUrl = kit.cleanText(body.meeting_url, 500);
  if (attend !== 'online' && !location) throw kit.inputError('Add the address people should come to.');
  if (meetingUrl && !/^https:\/\/\S+$/i.test(meetingUrl)) throw kit.inputError('The meeting link needs to start with https://');
  const payOption = PAY_OPTIONS[body.pay_option] ? body.pay_option : 'online';
  let deposit = 0;
  if (price && payOption === 'deposit') {
    deposit = priceFromForm(body.deposit);
    if (!deposit) throw kit.inputError('Add how much advance to take when booking.');
    if (deposit >= price) throw kit.inputError('The advance needs to be less than the full price — or choose “Full price online”.');
  }
  return { attend, location, meeting_url: attend === 'in_person' ? '' : meetingUrl, pay_option: payOption, deposit };
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
  const price = priceFromForm(body.price);
  return {
    title,
    description: kit.cleanText(body.description, 2000),
    duration_min: kit.cleanInt(body.duration_min, { min: 5, max: 480, fallback: 30 }),
    price,
    ...placeAndPaymentFields(body, price),
    min_notice_hours: kit.cleanInt(body.min_notice_hours, { min: 0, max: 720, fallback: 2 }),
    days_ahead: kit.cleanInt(body.days_ahead, { min: 1, max: 180, fallback: 30 }),
    buffer_min: kit.cleanInt(body.buffer_min || 0, { min: 0, max: 240, fallback: 0 }),
    max_per_day: kit.cleanInt(body.max_per_day || 0, { min: 0, max: 100, fallback: 0 }),
    cover_url: imageUrl(body.cover_url),
    photo_url: imageUrl(body.photo_url),
    visible: body.visible ? 1 : 0,
    marketplace: body.marketplace ? 1 : 0,
  };
}

async function listServices(userId) {
  await ensureTables();
  const today = await todayFor(userId);
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

// Name, length and price from the "new service" form. It follows the
// creator's availability (Settings) until it's given its own hours.
async function createService(userId, body) {
  await ensureTables();
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the service a name.');
  const fields = {
    title,
    duration_min: kit.cleanInt(body.duration_min, { min: 5, max: 480, fallback: 30 }),
    price: priceFromForm(body.price),
    hours: JSON.stringify(DEFAULT_HOURS),
    custom_hours: 0,
    attend: 'online',
  };
  const slug = await kit.uniqueSlug(SERVICES, userId, title, 'session');
  const [result] = await pool.query(`INSERT INTO ${SERVICES} SET ?`, [{ ...fields, slug, user_id: userId }]);
  return result.insertId;
}

async function updateService(userId, id, body) {
  await ensureTables();
  const custom = body.custom_hours === '1';
  const fields = {
    ...serviceFields(body),
    custom_hours: custom ? 1 : 0,
    questions: JSON.stringify(questionsFromForm(body)),
  };
  // Hours set back to "my availability" keep the custom ones stored, so
  // switching back brings them back.
  if (custom) fields.hours = JSON.stringify(hoursFromForm(body));
  fields.slug = await kit.uniqueSlug(SERVICES, userId, body.slug || fields.title, 'session', id);
  await pool.query(`UPDATE ${SERVICES} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

// The editor's unsaved fields over the saved service, for the live preview
// (lib/livePreview.js) — checked as a save would be, nothing written.
function previewService(saved, body) {
  const custom = body.custom_hours === '1';
  const fields = {
    ...serviceFields(body),
    custom_hours: custom ? 1 : 0,
    questions: JSON.stringify(questionsFromForm(body)),
  };
  if (custom) fields.hours = JSON.stringify(hoursFromForm(body));
  return toService({ ...saved, ...fields });
}

// Onboarding sets only a service's basics; everything else stays as the
// editor left it. price is in paise.
async function updateServiceBasics(userId, id, { title, duration_min, price, visible, attend, location }) {
  await ensureTables();
  const fields = {
    title: kit.cleanText(title, 200),
    duration_min: kit.cleanInt(duration_min, { min: 5, max: 480, fallback: 30 }),
    price: Math.max(0, Math.min(MAX_PRICE, Number(price) || 0)),
    visible: visible ? 1 : 0,
  };
  if (ATTEND[attend]) fields.attend = attend;
  if (location !== undefined) fields.location = kit.cleanText(location, 300);
  await pool.query(`UPDATE ${SERVICES} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

// Whether a service has any booking at all (onboarding only deletes one that hasn't).
async function serviceHasBookings(userId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${BOOKINGS} WHERE user_id = ? AND service_id = ?`, [userId, id]);
  return row.n > 0;
}

// Bookings already made stay in the list (they keep the service's title).
// Show / hide one service on its public page — the ⋯ menu on the list.
async function setServiceVisible(userId, id, visible) {
  await ensureTables();
  await pool.query(`UPDATE ${SERVICES} SET visible = ? WHERE id = ? AND user_id = ?`, [visible ? 1 : 0, id, userId]);
}

async function deleteService(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${SERVICES} WHERE id = ? AND user_id = ?`, [id, userId]);
}

// Visible services, oldest first — the order they were set up in, for the
// /book page.
async function listPublicServices(userId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${SERVICES} WHERE user_id = ? AND visible = 1 ORDER BY created_at ASC, id ASC`, [userId]);
  return rows.map(toService);
}

// --- Settings --------------------------------------------------------------

const DEFAULT_SETTINGS = { headline: '', intro: '', photo_url: '', cover_url: '', payment_note: '', hours: '', timezone: kit.STORE_TZ, listing_visible: true };

// hours: the creator's weekly availability — every service that hasn't
// got its own hours (custom_hours) is bookable in these. Blank (never
// saved) is Mon–Fri 9–5.
async function getSettings(userId) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${SETTINGS} WHERE user_id = ?`, [userId]);
  const settings = row ? { ...row, listing_visible: !!row.listing_visible } : { ...DEFAULT_SETTINGS, user_id: userId };
  return {
    ...settings,
    hours: parseHours(settings.hours || ''),
    // The clock every service's hours, notice and days off are on.
    timezone: kit.validTimezone(settings.timezone) ? settings.timezone : kit.STORE_TZ,
  };
}

// The weekly hours a service is bookable in.
function hoursFor(service, settings) {
  return service.custom_hours ? service.hours : settings.hours;
}

// The Settings tab saves in groups, one form each: 'page' (how /book
// looks), 'availability' (weekly hours) and 'payments'.
async function saveSettings(userId, group, body) {
  await ensureTables();
  const fields = group === 'page'
    ? {
      headline: kit.cleanText(body.headline, 120),
      intro: kit.cleanText(body.intro, 1000),
      photo_url: imageUrl(body.photo_url),
      cover_url: imageUrl(body.cover_url),
      listing_visible: body.listing_visible ? 1 : 0,
    }
    : group === 'availability'
      ? { hours: JSON.stringify(hoursFromForm(body)), timezone: timezoneFromForm(body.timezone) }
      : { payment_note: kit.cleanText(body.payment_note, 500) };
  await pool.query(`INSERT INTO ${SETTINGS} SET ? ON DUPLICATE KEY UPDATE ?`, [{ ...fields, user_id: userId }, fields]);
}

// Weekly hours from onboarding (lib/onboarding.js), already checked:
// seven lists of ['09:00', '13:00'] ranges, Sunday first.
async function saveHours(userId, hours, timezone) {
  await ensureTables();
  const clean = parseHours(hours);
  const tz = kit.validTimezone(timezone) ? timezone : kit.STORE_TZ;
  const fields = { hours: JSON.stringify(clean), timezone: tz };
  await pool.query(`INSERT INTO ${SETTINGS} SET ? ON DUPLICATE KEY UPDATE ?`, [{ ...fields, user_id: userId }, fields]);
}

function timezoneFromForm(raw) {
  const tz = String(raw || '').trim();
  if (!kit.validTimezone(tz)) throw kit.inputError('Pick your timezone from the list.');
  return kit.TIMEZONE_ALIASES[tz] || tz;
}

// Today on the creator's clock.
async function todayFor(userId) {
  return kit.nowLocal((await getSettings(userId)).timezone).date;
}

// Live bookings from today on — the count on the Upcoming bookings tab.
async function countUpcoming(userId) {
  await ensureTables();
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM ${BOOKINGS} WHERE user_id = ? AND date >= ? AND status IN ('confirmed', 'pending')`,
    [userId, await todayFor(userId)],
  );
  return Number(row.n);
}

// --- Days off --------------------------------------------------------------

async function listDaysOff(userId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${DAYS_OFF} WHERE user_id = ? AND date >= ? ORDER BY date`, [userId, await todayFor(userId)]);
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

// Test and Cashfree modes: an unpaid hold lapses so a visitor who wandered
// off at checkout doesn't keep the slot. Its order is cancelled with it.
// (Manual mode holds until the creator decides — payment happens offline.)
async function releaseExpiredHolds(userId) {
  const mode = paymentMode();
  if (mode !== 'test' && !isGatewayMode(mode)) return;
  let [rows] = await pool.query(
    `SELECT id, order_id FROM ${BOOKINGS} WHERE user_id = ? AND status = 'pending' AND created_at < NOW() - INTERVAL ${HOLD_MINUTES} MINUTE`,
    [userId],
  );
  if (isGatewayMode(mode) && rows.length) {
    // Paid on Cashfree just before the hold ran out: confirmed, not expired.
    const paid = new Set();
    for (const r of rows.filter((x) => x.order_id)) {
      const order = await getOrder(userId, r.order_id);
      if (order && await syncGatewayOrder(order)) paid.add(r.id);
    }
    rows = rows.filter((r) => !paid.has(r.id));
  }
  if (!rows.length) return;
  await pool.query(`UPDATE ${BOOKINGS} SET status = 'expired', slot_key = NULL WHERE id IN (?) AND status = 'pending'`, [rows.map((r) => r.id)]);
  await Promise.all(rows.filter((r) => r.order_id).map((r) => cancelOrder(userId, r.order_id)));
}

// Every open slot from today to days_ahead out, as { date: ['09:00', …] }
// — only days with at least one slot are listed.
async function openSlots(service) {
  await ensureTables();
  await releaseExpiredHolds(service.user_id);
  const settings = await getSettings(service.user_id);
  const now = kit.nowLocal(settings.timezone);
  const last = kit.addDays(now.date, service.days_ahead - 1);
  const [[taken], [off]] = await Promise.all([
    pool.query(
      `SELECT service_id, date, start_time, end_time FROM ${BOOKINGS}
       WHERE user_id = ? AND status IN ('confirmed', 'pending') AND date BETWEEN ? AND ?`,
      [service.user_id, now.date, last],
    ),
    pool.query(`SELECT date FROM ${DAYS_OFF} WHERE user_id = ? AND date BETWEEN ? AND ?`, [service.user_id, now.date, last]),
  ]);
  const weekly = hoursFor(service, settings);
  const offDays = new Set(off.map((r) => r.date));
  const earliest = now.minutes + service.min_notice_hours * 60; // minutes from today's midnight
  const length = service.duration_min;
  const gap = service.buffer_min;
  const days = {};
  for (let i = 0; i < service.days_ahead; i += 1) {
    const date = kit.addDays(now.date, i);
    const ranges = weekly[kit.weekday(date)];
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
  const paidOnline = row.amount - (row.due_later || 0);
  return {
    ...row,
    answers,
    amountLabel: row.amount ? formatINR(row.amount) : '',
    // What's (to be) paid online, and what's left for the appointment.
    payNowLabel: paidOnline ? formatINR(paidOnline) : '',
    dueLaterLabel: row.due_later ? formatINR(row.due_later) : '',
    attendLabel: ATTEND[row.attend] || '',
    mapsUrl: row.attend === 'in_person' && row.location ? mapsUrl(row.location) : null,
  };
}

// Whether a live booking of this creator's (any service) overlaps
// start–end on date, allowing `gap` minutes either side.
async function overlapping(db, userId, date, start, end, gap) {
  const from = kit.fromMinutes(Math.max(0, kit.toMinutes(start) - gap));
  const to = kit.fromMinutes(Math.min(1439, kit.toMinutes(end) + gap));
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS n FROM ${BOOKINGS}
     WHERE user_id = ? AND date = ? AND status IN ('confirmed', 'pending') AND start_time < ? AND end_time > ?`,
    [userId, date, to, from],
  );
  return Number(row.n) > 0;
}

// A free service — or one paid at the appointment — books straight away;
// one with something to pay online (full price or advance) places an order
// for that and holds the slot until it's paid. `attend` is the booker's
// pick when the service is "either".
//
// Two people can submit at the same moment for times that overlap without
// starting together (a 60-min 9:30 and a 30-min 10:00), which the unique
// slot_key can't catch. So bookings for one creator are made one at a
// time — a named MySQL lock held on one connection — and the slot is
// checked again inside it, against every live booking, before inserting.
// `fee` ({ source, pct } from lib/platform.js) must be the one applyFee()
// was given, so the booker pays what the page showed them.
async function createBooking(service, { date, start, person, note, answers, attend, fee = { source: 'direct', pct: 0 } }) {
  applyFee(service, fee.pct);
  await ensureTables();
  const end = kit.fromMinutes(kit.toMinutes(start) + service.duration_min);
  const online = service.payNow;
  const paid = online > 0;
  let how = service.attend;
  if (how === 'either') {
    if (attend !== 'online' && attend !== 'in_person') throw kit.inputError('Choose online or in person.');
    how = attend;
  }
  const place = how === 'online' ? { location: '', meeting_url: service.meeting_url } : { location: service.location, meeting_url: '' };
  const token = kit.newToken();
  const taken = () => kit.inputError('That time was just taken or isn’t available any more — pick another.');
  const { timezone } = await getSettings(service.user_id);
  const lockName = `pz_booking_${service.user_id}`;
  const conn = await pool.getConnection();
  let id;
  try {
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, 10) AS got', [lockName]);
    if (got !== 1) throw kit.inputError('Lots of people are booking right now — please try again in a moment.');
    try {
      // Hours, notice, days off, daily cap…
      const days = await openSlots(service);
      if (!(days[date] || []).includes(start)) throw taken();
      // …and, authoritatively, no live booking in the way.
      if (await overlapping(conn, service.user_id, date, start, end, service.buffer_min)) throw taken();
      const [result] = await conn.query(`INSERT INTO ${BOOKINGS} SET ?`, [{
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
        ...place,
        attend: how,
        timezone,
        amount: service.price,
        due_later: service.price - online,
        status: paid ? 'pending' : 'confirmed',
        slot_key: `${date} ${start}`,
      }]);
      id = result.insertId;
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw taken();
    throw err;
  } finally {
    conn.release();
  }

  if (paid) {
    const advance = online < service.price ? ' (advance)' : '';
    const line = { id: service.id, title: `${service.title}${advance} — ${kit.formatDate(date)}, ${kit.formatTime(start)}`, type: 'booking', qty: 1, unit: online, amount: online, shipFee: 0 };
    const order = await createOrder(service.user_id, { id: null, title: service.title }, { ...person, address: null, note: '' }, {
      lines: [line], subtotal: online, discount: 0, total: online, coupon: null, shipping: 0,
    }, { ...fee, base: service.price });
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
  const today = await todayFor(userId);
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

// 'YYYY-MM-DD' + 'HH:MM' on tz's clock → '20261007T033000Z' (UTC).
function utcStamp(date, time, tz) {
  return new Date(kit.zonedToUtc(date, time, tz)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function googleCalendarUrl(b, ownerName) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${b.service_title} with ${ownerName}`,
    dates: `${utcStamp(b.date, b.start_time, b.timezone)}/${utcStamp(b.date, b.end_time, b.timezone)}`,
    details: `Booked on ${ownerName}’s page.`,
    location: b.location || b.meeting_url || (b.attend === 'online' ? 'Online' : ''),
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
    `DTSTART:${utcStamp(b.date, b.start_time, b.timezone)}`,
    `DTEND:${utcStamp(b.date, b.end_time, b.timezone)}`,
    `SUMMARY:${esc(`${b.service_title} with ${ownerName}`)}`,
    (b.location || b.meeting_url) ? `LOCATION:${esc(b.location || b.meeting_url)}` : null,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== null).join('\r\n');
}

// Live services the creators listed on the marketplace (lib/marketplace.js),
// newest first, with the cover/photo from Bookings → Settings as fallback.
async function listMarketplaceServices() {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT s.*, u.handle AS owner_handle, u.name AS owner_name, st.cover_url AS default_cover, st.photo_url AS default_photo
     FROM ${SERVICES} s JOIN PDZ_users u ON u.id = s.user_id LEFT JOIN ${SETTINGS} st ON st.user_id = s.user_id
     WHERE s.visible = 1 AND s.marketplace = 1 ORDER BY s.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => {
    const s = toService(r);
    s.cover_url = s.cover_url || r.default_cover || '';
    s.photo_url = s.photo_url || r.default_photo || '';
    return s;
  });
}

module.exports = {
  listMarketplaceServices,
  WEEKDAYS, QUESTION_TYPES, MAX_RANGES, MAX_QUESTIONS, HOLD_MINUTES, ATTEND, PAY_OPTIONS,
  applyFee,
  listServices, getService, getPublicService, listPublicServices, createService, updateService, deleteService, previewService, setServiceVisible,
  updateServiceBasics, serviceHasBookings, saveHours, priceFromForm, parseHours, MAX_PRICE,
  getSettings, saveSettings, countUpcoming, todayFor, hoursFor, hoursSummary,
  listDaysOff, addDaysOff, deleteDayOff,
  openSlots, readAnswers, createBooking, getBookingByToken, listBookings, cancelBooking, markBookingPaid,
  confirmFromOrder, releaseFromOrder, payTestBooking, abandonBooking,
  googleCalendarUrl, icsFile,
};
