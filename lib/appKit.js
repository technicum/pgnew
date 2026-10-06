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

// Today's date and the minutes since midnight, on the store's clock.
function nowLocal() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
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

// CREATE TABLE once per process, retried if it failed (same lazy-migration
// pattern as the other lib/ models).
function lazyTables(statements) {
  let ready = null;
  return () => {
    if (!ready) {
      ready = statements.reduce((p, sql) => p.then(() => pool.query(sql)), Promise.resolve()).catch((err) => {
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
  STORE_TZ, DATE_RE, TIME_RE, EMAIL_RE,
  normalizeSlug, uniqueSlug, newToken,
  nowLocal, addDays, weekday, isValidDate, toMinutes, fromMinutes, formatDate, formatTime,
  cleanText, cleanInt, readPerson, addToAudience, lazyTables, inputError,
};
