// Shared "what day/time is it for the people using this CRM" helpers.
// Hardcoded to IST rather than read from the server's own OS timezone: the
// app may be hosted anywhere (typically UTC on a VPS/cloud host), but the
// team clocking in, scheduling follow-ups, or getting a reminder email
// cares about their own wall-clock day, not the server's. IST has a fixed
// +05:30 offset (no DST), which is what makes the static-offset arithmetic
// here safe; a timezone with DST would need a real tz library instead.
// Used by lib/attendance.js and lib/reminders.js.
const TIMEZONE = 'Asia/Kolkata';
const TIMEZONE_OFFSET = '+05:30';

// YYYY-MM-DD for `d` as a calendar date in TIMEZONE -- NOT the server
// process's own local timezone, which plain getFullYear()/getMonth()/
// getDate() would use instead. en-CA conveniently formats as YYYY-MM-DD.
function dateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// The [start, end) instant range covering one TIMEZONE calendar day, as
// real Date instants -- used instead of MySQL's own CURDATE()/DATE(), which
// bucket by the DB connection's session timezone (often UTC, and could
// misfile an event near midnight IST into the wrong day) rather than IST.
function dayRange(dateKey) {
  const start = new Date(`${dateKey}T00:00:00${TIMEZONE_OFFSET}`);
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)];
}

// Wall-clock formatters, all pinned to TIMEZONE -- used by views instead of
// calling toLocaleTimeString/toLocaleString directly, so nothing can
// accidentally fall back to the server's own local timezone.
function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(date) {
  return new Date(date).toLocaleString('en-IN', { timeZone: TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// dateKey is already a TIMEZONE calendar date (see dateStr above) -- shown
// via a noon anchor so formatting it back out can never shift it to the
// adjacent day.
function formatDay(dateKey) {
  return new Date(`${dateKey}T12:00:00${TIMEZONE_OFFSET}`).toLocaleDateString('en-IN', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric' });
}

module.exports = { TIMEZONE, TIMEZONE_OFFSET, dateStr, dayRange, formatTime, formatDateTime, formatDay };
