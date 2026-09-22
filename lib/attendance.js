// CRM team attendance (clock-in/out with breaks) and per-task time tracking.
// Scoped exactly like lib/crm.js: every row belongs to a CRM owner_user_id,
// and a user_id is either that owner or one of their pz_crm_members (see
// crm.js's isAssignable). This module doesn't re-check that itself --
// callers (routes/platform.js) already resolve req.crm and pass
// ownerUserId/userId through from there.
const { pool, TABLES } = require('../db/database');
const crmLib = require('./crm');

// Every clock/timer time in the CRM is shown, and every attendance "day" is
// bucketed, in this timezone -- regardless of what timezone the Node
// process or the MySQL server happen to be running in (typically UTC on a
// VPS/cloud host). A team clocking in and out cares about their own
// wall-clock day, not the server's. IST has a fixed +05:30 offset (no DST),
// which is what makes the static-offset arithmetic below safe; a timezone
// with DST would need a real tz library instead of this.
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

// "Xh Ym" -- for a settled, non-ticking total (a task's all-time total, a
// past day's row in the history table). See formatClock below for a
// running timer, which shows seconds.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "H:MM:SS" (or "M:SS" under an hour) -- for a timer that's actually
// running right now (clocked in, or a task timer), so the seconds visibly
// tick. Mirrors public/js/live-duration.js's client-side formatter exactly,
// so the page never jumps between two different formats the instant the
// client-side ticker takes over from this server-rendered initial value.
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Wall-clock formatters, all pinned to TIMEZONE -- used by the Attendance
// and Tasks views instead of calling toLocaleTimeString/toLocaleString
// directly, so nothing in a view can accidentally fall back to the
// server's own local timezone.
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

// ---- Attendance (clock in/out, with breaks) ----

// Walks one user's attendance events for a single span (ascending by
// event_at) and derives worked/break seconds plus the current state as of
// `asOf`. An interval still open at `asOf` (no matching end event yet)
// counts as running up to `asOf` -- so "today" keeps ticking live when the
// caller passes new Date(), while a past day is summarized as of that day's
// end (see listRecentDays) so a forgotten clock-out doesn't bleed into
// later days. Out-of-sequence events (e.g. a double clock-in, which the
// clockIn()/etc. guards below shouldn't ever produce, but old data might)
// are simply ignored rather than throwing, so history stays readable.
function summarizeEvents(events, asOf) {
  let state = 'out'; // 'out' | 'in' | 'break'
  let workedMs = 0;
  let breakMs = 0;
  let segmentStart = null;
  let breakStart = null;
  let since = null; // when the CURRENT state began

  events.forEach((ev) => {
    const t = new Date(ev.event_at);
    if (ev.event_type === 'clock_in' && state === 'out') {
      state = 'in';
      segmentStart = t;
      since = t;
    } else if (ev.event_type === 'break_start' && state === 'in') {
      workedMs += t - segmentStart;
      state = 'break';
      breakStart = t;
      since = t;
    } else if (ev.event_type === 'break_end' && state === 'break') {
      breakMs += t - breakStart;
      state = 'in';
      segmentStart = t;
      since = t;
    } else if (ev.event_type === 'clock_out' && (state === 'in' || state === 'break')) {
      if (state === 'in') workedMs += t - segmentStart;
      else breakMs += t - breakStart;
      state = 'out';
      segmentStart = null;
      breakStart = null;
      since = t;
    }
  });

  if (state === 'in') workedMs += asOf - segmentStart;
  else if (state === 'break') breakMs += asOf - breakStart;

  return {
    state,
    since,
    workedSeconds: Math.round(workedMs / 1000),
    breakSeconds: Math.round(breakMs / 1000),
  };
}

async function getStatus(ownerUserId, userId, asOf) {
  const now = asOf || new Date();
  const [start, end] = dayRange(dateStr(now));
  const [events] = await pool.query(
    `SELECT event_type, event_at FROM ${TABLES.crmAttendanceEvents}
     WHERE owner_user_id = ? AND user_id = ? AND event_at >= ? AND event_at < ?
     ORDER BY event_at ASC, id ASC`,
    [ownerUserId, userId, start, end]
  );
  return summarizeEvents(events, now);
}

async function recordEvent(ownerUserId, userId, eventType) {
  await pool.query(
    `INSERT INTO ${TABLES.crmAttendanceEvents} (owner_user_id, user_id, event_type) VALUES (?, ?, ?)`,
    [ownerUserId, userId, eventType]
  );
}

async function clockIn(ownerUserId, userId) {
  const status = await getStatus(ownerUserId, userId);
  if (status.state !== 'out') throw new Error("You're already clocked in.");
  await recordEvent(ownerUserId, userId, 'clock_in');
}

async function clockOut(ownerUserId, userId) {
  const status = await getStatus(ownerUserId, userId);
  if (status.state === 'out') throw new Error("You're not clocked in.");
  await recordEvent(ownerUserId, userId, 'clock_out');
  // Can't keep timing a task once off the clock.
  await stopTimer(ownerUserId, userId);
}

async function startBreak(ownerUserId, userId) {
  const status = await getStatus(ownerUserId, userId);
  if (status.state !== 'in') throw new Error('Clock in first to start a break.');
  await recordEvent(ownerUserId, userId, 'break_start');
}

async function endBreak(ownerUserId, userId) {
  const status = await getStatus(ownerUserId, userId);
  if (status.state !== 'break') throw new Error("You're not on a break.");
  await recordEvent(ownerUserId, userId, 'break_end');
}

// Today's status for everyone this owner's CRM can see (the owner + team) --
// powers the Attendance screen's team table.
async function listTeamStatusToday(ownerUserId) {
  const users = await crmLib.listAssignableUsers(ownerUserId);
  const now = new Date();
  const out = [];
  for (const u of users) {
    out.push({ ...u, ...(await getStatus(ownerUserId, u.id, now)) });
  }
  return out;
}

// One row per of the last `days` calendar days (oldest first), each with
// that day's worked/break totals -- the "My hours" history table. Only
// today is summarized "as of now" (still ticking); earlier days are capped
// at their own end-of-day.
async function listRecentDays(ownerUserId, userId, days = 7) {
  const now = new Date();
  const today = dateStr(now);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const [rangeStart] = dayRange(dateStr(new Date(now.getTime() - (days - 1) * DAY_MS)));
  const [events] = await pool.query(
    `SELECT event_type, event_at FROM ${TABLES.crmAttendanceEvents}
     WHERE owner_user_id = ? AND user_id = ? AND event_at >= ?
     ORDER BY event_at ASC, id ASC`,
    [ownerUserId, userId, rangeStart]
  );
  const byDay = new Map();
  events.forEach((ev) => {
    const key = dateStr(new Date(ev.event_at));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  });
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dateStr(new Date(now.getTime() - i * DAY_MS));
    const asOf = key === today ? now : dayRange(key)[1]; // capped at that IST day's end
    result.push({ date: key, ...summarizeEvents(byDay.get(key) || [], asOf) });
  }
  return result;
}

// ---- Per-task timer ----
// Only one entry per user can be running (ended_at IS NULL) at a time --
// startTimer always stops whatever was already running first, so nobody's
// "total hours today" can double-count overlapping entries.

async function getRunningTimer(ownerUserId, userId) {
  const [[row]] = await pool.query(
    `SELECT e.id, e.task_id, e.started_at, t.title AS task_title
     FROM ${TABLES.crmTaskTimeEntries} e
     JOIN ${TABLES.crmTasks} t ON t.id = e.task_id
     WHERE e.owner_user_id = ? AND e.user_id = ? AND e.ended_at IS NULL
     ORDER BY e.id DESC LIMIT 1`,
    [ownerUserId, userId]
  );
  return row || null;
}

async function stopTimer(ownerUserId, userId) {
  await pool.query(
    `UPDATE ${TABLES.crmTaskTimeEntries} SET ended_at = NOW()
     WHERE owner_user_id = ? AND user_id = ? AND ended_at IS NULL`,
    [ownerUserId, userId]
  );
}

async function startTimer(ownerUserId, userId, taskId) {
  const task = await crmLib.getTask(ownerUserId, taskId);
  if (!task) throw new Error('Task not found.');
  await stopTimer(ownerUserId, userId);
  const [result] = await pool.query(
    `INSERT INTO ${TABLES.crmTaskTimeEntries} (owner_user_id, task_id, user_id) VALUES (?, ?, ?)`,
    [ownerUserId, task.id, userId]
  );
  return result.insertId;
}

async function getTaskTotalSeconds(taskId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS s
     FROM ${TABLES.crmTaskTimeEntries} WHERE task_id = ?`,
    [taskId]
  );
  return Number(row.s);
}

async function listTaskTimeEntries(taskId) {
  const [rows] = await pool.query(
    `SELECT e.*, u.name AS user_name,
            TIMESTAMPDIFF(SECOND, e.started_at, COALESCE(e.ended_at, NOW())) AS duration_seconds
     FROM ${TABLES.crmTaskTimeEntries} e
     JOIN ${TABLES.users} u ON u.id = e.user_id
     WHERE e.task_id = ?
     ORDER BY e.started_at DESC`,
    [taskId]
  );
  return rows;
}

// Total task-timer seconds this person has logged today, across every task
// -- the "total hours" figure alongside each task's own total.
async function getUserSecondsToday(ownerUserId, userId) {
  const [start, end] = dayRange(dateStr(new Date()));
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, started_at, COALESCE(ended_at, NOW()))), 0) AS s
     FROM ${TABLES.crmTaskTimeEntries}
     WHERE owner_user_id = ? AND user_id = ? AND started_at >= ? AND started_at < ?`,
    [ownerUserId, userId, start, end]
  );
  return Number(row.s);
}

module.exports = {
  formatDuration,
  formatClock,
  formatTime,
  formatDateTime,
  formatDay,
  getStatus,
  clockIn,
  clockOut,
  startBreak,
  endBreak,
  listTeamStatusToday,
  listRecentDays,
  getRunningTimer,
  startTimer,
  stopTimer,
  getTaskTotalSeconds,
  listTaskTimeEntries,
  getUserSecondsToday,
};
