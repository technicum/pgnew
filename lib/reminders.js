// Emails a daily digest of due CRM follow-ups (see lib/crm.js's file
// comment for what a follow-up is) to whoever they're assigned to -- the
// "remind me about this customer in a year" case an agent relies on, where
// nobody's going to remember to open the CRM on that exact day. Runs
// platform-wide (every owner's CRM at once) rather than being scoped to one
// owner, since it's a background job, not something a logged-in request
// triggers. See maybeRunDailyReminders for how server.js schedules it.
const { pool, TABLES } = require('../db/database');
const mailer = require('./mailer');
const { getBaseDomain } = require('../middleware/tenant');
const { dateStr } = require('./timezone');

function adminBaseUrl() {
  // No request to read the actual Host header from here (this runs off a
  // timer, not a request) -- BASE_DOMAIN is the same env var every other
  // absolute URL in the app is built from (see middleware/tenant.js).
  const protocol = process.env.BASE_DOMAIN ? 'https' : 'http';
  return `${protocol}://admin.${getBaseDomain()}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// mysql2 returns a DATE column as a JS Date (at local midnight) unless
// dateStrings is set, which it isn't here -- so f.due_date on a query row
// is a Date object, not the string it looks like. Comparing it against a
// YYYY-MM-DD string with < / > would coerce both to numbers instead of
// doing a date comparison (Date -> its epoch ms, "2027-01-01" -> NaN), so
// every row-level "is this overdue" check below goes through this instead.
function dueDateKey(row) {
  const d = new Date(row.due_date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Every not-done follow-up whose due date has arrived (today or earlier, in
// IST) and hasn't been emailed yet -- across every owner's CRM. due_date is
// a plain DATE (no time-of-day, no timezone of its own), so comparing it
// against the IST calendar date string is exact, not an approximation.
async function listDueForEmail() {
  const todayKey = dateStr(new Date());
  const [rows] = await pool.query(
    `SELECT f.id, f.title, f.note, f.due_date,
            COALESCE(f.assigned_to, f.owner_user_id) AS recipient_id,
            u.name AS recipient_name, u.email AS recipient_email,
            c.name AS contact_name
     FROM ${TABLES.crmFollowups} f
     JOIN ${TABLES.users} u ON u.id = COALESCE(f.assigned_to, f.owner_user_id)
     JOIN ${TABLES.contacts} c ON c.id = f.contact_id
     WHERE f.done = 0 AND f.reminder_sent_at IS NULL AND f.due_date <= ?
     ORDER BY f.due_date ASC, f.id ASC`,
    [todayKey]
  );
  return rows;
}

function groupByRecipient(rows) {
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.recipient_id)) map.set(r.recipient_id, { name: r.recipient_name, email: r.recipient_email, items: [] });
    map.get(r.recipient_id).items.push(r);
  });
  return map;
}

function renderEmail(recipient) {
  const base = adminBaseUrl();
  const todayKey = dateStr(new Date());
  const count = recipient.items.length;

  const textLines = recipient.items.map((r) => {
    const tag = dueDateKey(r) < todayKey ? ' (overdue)' : '';
    return `- ${r.contact_name}: ${r.title}${tag}\n  ${base}/dashboard/crm/followups/${r.id}`;
  });
  const text = `You have ${count} CRM follow-up reminder${count > 1 ? 's' : ''} due:\n\n${textLines.join('\n\n')}\n\nOpen your follow-ups: ${base}/dashboard/crm/followups`;

  const htmlItems = recipient.items.map((r) => {
    const tag = dueDateKey(r) < todayKey ? ' <strong style="color:#dc2626;">(overdue)</strong>' : '';
    const note = r.note ? `<br><span style="color:#6b7280;">${escapeHtml(r.note)}</span>` : '';
    return `<li style="margin-bottom:10px;"><a href="${base}/dashboard/crm/followups/${r.id}">${escapeHtml(r.contact_name)}: ${escapeHtml(r.title)}</a>${tag}${note}</li>`;
  });
  const html = `<p>You have ${count} CRM follow-up reminder${count > 1 ? 's' : ''} due:</p><ul style="padding-left:20px;">${htmlItems.join('')}</ul><p><a href="${base}/dashboard/crm/followups">Open your follow-ups</a></p>`;

  return {
    subject: `${count} CRM reminder${count > 1 ? 's' : ''} due${count === 1 ? ': ' + recipient.items[0].contact_name : ''}`,
    text,
    html,
  };
}

async function markSent(ids) {
  if (!ids.length) return;
  await pool.query(`UPDATE ${TABLES.crmFollowups} SET reminder_sent_at = NOW() WHERE id IN (?)`, [ids]);
}

// Sends one digest email per recipient covering every due-and-unsent
// follow-up assigned to them, then marks those follow-ups sent. A follow-up
// is only ever emailed once, even if it's left undone -- its in-CRM
// Overdue tab keeps showing it regardless.
async function sendDueReminders() {
  const rows = await listDueForEmail();
  if (!rows.length) return { emailsSent: 0, remindersSent: 0 };

  const groups = groupByRecipient(rows);
  let emailsSent = 0;
  const sentIds = [];
  for (const recipient of groups.values()) {
    if (!recipient.email) continue; // no login email on file -- nothing to send to
    try {
      const { subject, text, html } = renderEmail(recipient);
      await mailer.sendMail({ to: recipient.email, subject, text, html });
      emailsSent += 1;
      recipient.items.forEach((r) => sentIds.push(r.id));
    } catch (err) {
      // One recipient's bad/missing SMTP config (or a transient send
      // failure) shouldn't stop everyone else's digest, and shouldn't mark
      // THIS recipient's reminders sent -- they're simply retried on the
      // next scheduled run.
      console.error(`CRM reminder email to ${recipient.email} failed:`, err.message);
    }
  }
  await markSent(sentIds);
  return { emailsSent, remindersSent: sentIds.length };
}

// ---- Scheduling ----
// Fires once per IST calendar day, the first time server.js's periodic
// check lands at or after REMINDER_HOUR IST. "Did I already run today" is a
// plain pz_settings row (not lib/settings.js's user-editable GROUPS -- this
// is internal scheduler bookkeeping, not a field anyone edits) so it
// survives a server restart instead of just living in memory.
const REMINDER_HOUR = parseInt(process.env.CRM_REMINDER_HOUR, 10) || 8; // 8am IST
const LAST_RUN_KEY = 'crm.reminders_last_run_date';

async function getLastRunDate() {
  const [[row]] = await pool.query(`SELECT setting_value FROM ${TABLES.settings} WHERE setting_key = ?`, [LAST_RUN_KEY]);
  return row ? row.setting_value : null;
}

async function setLastRunDate(dateKey) {
  await pool.query(
    `INSERT INTO ${TABLES.settings} (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [LAST_RUN_KEY, dateKey]
  );
}

// Called periodically by server.js -- a no-op unless it's past REMINDER_HOUR
// IST and today's run hasn't happened yet, so it's safe to call as often as
// convenient (e.g. every 15-30 minutes).
async function maybeRunDailyReminders() {
  const now = new Date();
  const istHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(now)
  );
  if (istHour < REMINDER_HOUR) return null;
  const todayKey = dateStr(now);
  if ((await getLastRunDate()) === todayKey) return null;
  const result = await sendDueReminders();
  await setLastRunDate(todayKey);
  return result;
}

module.exports = { listDueForEmail, sendDueReminders, maybeRunDailyReminders };
