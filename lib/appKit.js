// Small pieces shared by the Bookings, Events and Courses apps
// (lib/bookings.js, lib/events.js, lib/courses.js): slugs, dates and times,
// and dropping a signup into the creator's Audience.
//
// Dates and times are stored as plain strings — 'YYYY-MM-DD' and 'HH:MM'
// — in the creator's own clock, so nothing shifts with the server's or the
// database's time zone. "Now" is read in STORE_TZ (the site prices in ₹).
const crypto = require('crypto');
const pool = require('./db');
const { createContactFromSource, findExistingContact, updateContact } = require('./contacts');

const STORE_TZ = 'Asia/Kolkata';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{6,}$/;

// Lowercase letters, digits and single dashes — it's a URL path segment.
function normalizeSlug(str) {
  return String(str || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
}

// A slug no other row of this creator's uses: "intro-call", then
// "intro-call-2", "intro-call-3"…
async function uniqueSlug(table, userId, wanted, fallback, excludeId = 0) {
  const base = normalizeSlug(wanted) || fallback;
  const [rows] = await pool.query(
    `SELECT slug FROM ${table} WHERE user_id = ? AND id <> ? AND (slug = ? OR slug LIKE ?)`,
    [userId, excludeId, base, `${base}-%`],
  );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

// --- Time zones (IANA names, e.g. 'Asia/Kolkata') ---
// ICU still lists some zones by their old names (Asia/Calcutta for India);
// people look for the current ones, so the list uses those. Browsers can
// report either, so the page maps them too (TIMEZONE_ALIASES).
const TIMEZONE_ALIASES = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Enderbury': 'Pacific/Kanton',
  'America/Godthab': 'America/Nuuk', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca', 'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy', 'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Indianapolis': 'America/Indiana/Indianapolis', 'America/Louisville': 'America/Kentucky/Louisville',
  'America/Coral_Harbour': 'America/Atikokan', 'Africa/Asmera': 'Africa/Asmara',
};
const TIMEZONES = [...new Set(Intl.supportedValuesOf('timeZone').map((tz) => TIMEZONE_ALIASES[tz] || tz).concat('UTC'))].sort();

// Any zone name the runtime understands (current or old).
const tzCache = new Map();
function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  if (!tzCache.has(tz)) {
    let ok = true;
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (err) { ok = false; }
    tzCache.set(tz, ok);
  }
  return tzCache.get(tz);
}

// Wall-clock parts of an instant in tz.
function partsIn(tz, ms) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

// tz's offset from UTC at that instant, in minutes (330 for India).
function offsetMinutes(tz, ms) {
  const p = partsIn(tz, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

// 'YYYY-MM-DD' + 'HH:MM' on tz's clock → the instant (ms). Daylight-saving
// aware: the offset is looked up again at the result.
function zonedToUtc(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  let utc = guess - offsetMinutes(tz, guess) * 60000;
  utc = guess - offsetMinutes(tz, utc) * 60000;
  return utc;
}

// "GMT+5:30" — tz's offset right now.
function gmtLabel(tz) {
  const off = offsetMinutes(tz, Date.now());
  const abs = Math.abs(off);
  return `GMT${off < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

// "Kolkata (GMT+5:30)" — the city from the zone name and its offset now.
function tzLabel(tz) {
  const city = tz === 'UTC' ? 'UTC' : tz.split('/').pop().replace(/_/g, ' ');
  return `${city} (${gmtLabel(tz)})`;
}

// The timezone dropdown: "Asia/Kolkata — GMT+5:30", searchable by either.
function timezoneOptions() {
  return TIMEZONES.map((tz) => ({ value: tz, label: `${tz.replace(/_/g, ' ')} — ${gmtLabel(tz)}` }));
}

// Today's date and the minutes since midnight, on the clock of tz (the
// creator's booking timezone; STORE_TZ when none is given).
function nowLocal(tz = STORE_TZ) {
  const parts = partsIn(validTimezone(tz) ? tz : STORE_TZ, Date.now());
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Date arithmetic on 'YYYY-MM-DD' strings (UTC noon, so no DST edge).
function dateObj(date) {
  return new Date(`${date}T12:00:00Z`);
}
function addDays(date, n) {
  const d = dateObj(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(date) {
  return dateObj(date).getUTCDay();
}
function isValidDate(date) {
  return DATE_RE.test(date) && dateObj(date).toISOString().slice(0, 10) === date;
}

function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// "Tue, 6 Oct" (and the year when it isn't this one), "10:30 am".
function formatDate(date, { long = false } = {}) {
  if (!DATE_RE.test(date || '')) return '';
  const opts = { timeZone: 'UTC', weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short' };
  if (date.slice(0, 4) !== nowLocal().date.slice(0, 4)) opts.year = 'numeric';
  return dateObj(date).toLocaleDateString('en-GB', opts);
}
function formatTime(time) {
  if (!TIME_RE.test(time || '')) return '';
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}
function cleanInt(value, { min, max, fallback }) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// The name / email / phone a visitor typed on a public signup form, checked.
// Returns { person } or { error }.
function readPerson(body, { phoneRequired = false } = {}) {
  const person = {
    name: cleanText(body?.name, 200),
    email: cleanText(body?.email, 255),
    phone: cleanText(body?.phone, 30),
  };
  if (!person.name) return { error: 'Add your name to continue.', person };
  if (!EMAIL_RE.test(person.email)) return { error: 'That email address doesn’t look right.', person };
  if (phoneRequired && !person.phone) return { error: 'Add your phone number to continue.', person };
  if (person.phone && !PHONE_RE.test(person.phone)) return { error: 'That phone number doesn’t look right.', person };
  return { person };
}

// Same person signing up again (to this or anything else) updates one
// Audience row instead of adding another — as lead magnets do.
async function addToAudience(userId, person, { source, sourceId, sourceName, note }) {
  const existing = await findExistingContact(userId, { email: person.email });
  if (existing) {
    if (person.phone && !existing.phone) await updateContact(userId, existing.id, { phone: person.phone });
    return;
  }
  await createContactFromSource(userId, { ...person, note, source, sourceId, sourceName });
}

// CREATE TABLE (and later ALTERs) once per process, retried if it failed —
// same lazy-migration pattern as the other lib/ models. A statement can be
// { sql, ignore: [error codes] } for an ALTER that's already been applied
// (ER_DUP_FIELDNAME, ER_DUP_KEYNAME), so every boot can run them all.
function lazyTables(statements) {
  let ready = null;
  const run = (s) => (typeof s === 'string' ? pool.query(s) : pool.query(s.sql).catch((err) => {
    if (!s.ignore.includes(err.code)) throw err;
  }));
  return () => {
    if (!ready) {
      ready = statements.reduce((p, s) => p.then(() => run(s)), Promise.resolve()).catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  };
}

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

module.exports = {
  STORE_TZ, TIMEZONES, TIMEZONE_ALIASES, validTimezone, zonedToUtc, tzLabel, timezoneOptions, DATE_RE, TIME_RE, EMAIL_RE,
  normalizeSlug, uniqueSlug, newToken,
  nowLocal, addDays, weekday, isValidDate, toMinutes, fromMinutes, formatDate, formatTime,
  cleanText, cleanInt, readPerson, addToAudience, lazyTables, inputError,
};
