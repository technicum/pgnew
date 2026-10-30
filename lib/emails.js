// Emails from the platform to creators (Platform admin → Emails): templates,
// and sends ("campaigns") of one template to many users.
//
// A send copies the template's subject and body, so editing or deleting the
// template later doesn't change it, and queues one row per recipient. The
// queue lives in MySQL, so a restart just picks up where it left off, and
// runQueue() below works through it in the background, one email every
// SEND_DELAY_MS. Each row is claimed before it's sent, so nobody gets the same
// email twice. A failed sign-in or a provider's rate limit pauses the send
// rather than failing everyone left; resuming carries on from there.
//
// Every email has an unsubscribe link (a signed /unsubscribe link, server.js);
// PDZ_users.email_opt_out is checked again just before each send.
const crypto = require('crypto');
const pool = require('./db');
const { sendMail } = require('./mailer');
const { renderRichText } = require('./richText');
const { ensureUsersTable, setEmailOptOut } = require('./users');
const { matchingUsers } = require('./admin');
const customDomains = require('./customDomains');

const TEMPLATES = 'PDZ_email_templates';
const CAMPAIGNS = 'PDZ_email_campaigns';
const RECIPIENTS = 'PDZ_email_recipients';
const MAX_BODY = 20000;
const SEND_DELAY_MS = 700; // about 85 emails a minute
const MAX_FAILS_IN_A_ROW = 5;
const PLACEHOLDERS = {
  name: 'Their full name',
  first_name: 'Their first name',
  email: 'Their email address',
  store_link: 'Their store’s address',
  dashboard_link: 'Your dashboard address',
  site_name: 'PageZaper',
};

// Set once at boot (startEmails): the site these emails link back to.
let site = { siteName: 'PageZaper', siteDomain: 'pagezaper.com' };

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await ensureUsersTable();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TEMPLATES} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          subject VARCHAR(200) NOT NULL,
          body MEDIUMTEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      // status: queuing → sending → done, or paused / cancelled along the way.
      // send_key is unique, so a double click on Send can't send twice.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${CAMPAIGNS} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          send_key VARCHAR(36) NOT NULL UNIQUE,
          template_name VARCHAR(120) NOT NULL,
          subject VARCHAR(200) NOT NULL,
          body MEDIUMTEXT NOT NULL,
          status VARCHAR(12) NOT NULL DEFAULT 'queuing',
          last_error VARCHAR(300) NOT NULL DEFAULT '',
          sent_by VARCHAR(190) NOT NULL DEFAULT '',
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TIMESTAMP NULL DEFAULT NULL
        )
      `);
      // status: queued → sending → sent / failed / skipped.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${RECIPIENTS} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          campaign_id INT NOT NULL,
          user_id INT NOT NULL,
          status VARCHAR(10) NOT NULL DEFAULT 'queued',
          error VARCHAR(300) NOT NULL DEFAULT '',
          sent_at TIMESTAMP NULL DEFAULT NULL,
          UNIQUE KEY uniq_campaign_user (campaign_id, user_id),
          INDEX (status)
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

// --- templates ---------------------------------------------------------------

async function listTemplates() {
  await ensureTables();
  const [rows] = await pool.query(`SELECT id, name, subject, updated_at FROM ${TEMPLATES} ORDER BY updated_at DESC, id DESC`);
  return rows;
}

async function getTemplate(id) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${TEMPLATES} WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

// A typo like {{nmae}} would go out to everyone as-is, so it's caught here.
function templateFields(body) {
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const subject = String(body.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = String(body.body || '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_BODY);
  if (!name) throw inputError('Give the template a name, so you can find it later.');
  if (!subject) throw inputError('Add a subject line.');
  if (!text) throw inputError('Write the email first.');
  const unknown = `${subject}\n${text}`.match(/\{\{[^{}]*\}\}/g)
    ?.find((tag) => !Object.hasOwn(PLACEHOLDERS, tag.slice(2, -2).trim()));
  if (unknown) throw inputError(`${unknown} isn’t a placeholder — use one from the list, or remove it.`);
  return { name, subject, body: text };
}

async function createTemplate(body) {
  await ensureTables();
  const t = templateFields(body);
  const [result] = await pool.query(`INSERT INTO ${TEMPLATES} (name, subject, body) VALUES (?, ?, ?)`, [t.name, t.subject, t.body]);
  return result.insertId;
}

async function updateTemplate(id, body) {
  await ensureTables();
  const t = templateFields(body);
  await pool.query(`UPDATE ${TEMPLATES} SET name = ?, subject = ?, body = ? WHERE id = ?`, [t.name, t.subject, t.body, id]);
}

async function deleteTemplate(id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${TEMPLATES} WHERE id = ?`, [id]);
}

// --- one email ---------------------------------------------------------------

const unsubscribeToken = (userId) => crypto
  .createHmac('sha256', process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-in-production')
  .update(`unsubscribe:${userId}`)
  .digest('hex');

function validUnsubscribe(userId, token) {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(String(token || ''));
  return Number.isInteger(userId) && userId > 0 && expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function storeLink(handle) {
  const own = customDomains.liveDomainFor(handle);
  return own ? `https://${own}` : `https://${handle}.${site.siteDomain}`;
}

// The subject, body and footer for one person. Placeholders are filled in
// before renderRichText, which escapes the result — a name can't add HTML.
function buildEmail({ subject, body }, user) {
  const values = {
    name: user.name,
    first_name: String(user.name).trim().split(/\s+/)[0],
    email: user.email,
    store_link: storeLink(user.handle),
    dashboard_link: `https://${site.siteDomain}/dashboard`,
    site_name: site.siteName,
  };
  const fill = (text) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (tag, key) => (Object.hasOwn(values, key) ? values[key] : tag));
  const unsubscribe = `https://${site.siteDomain}/unsubscribe?u=${user.id}&t=${unsubscribeToken(user.id)}`;
  const content = renderRichText(fill(body), { max: MAX_BODY });
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:28px;background:#ffffff;border-radius:10px;color:#1c1917;font-size:15px;line-height:1.6;">${content}</div>
<p style="max-width:560px;margin:16px auto 0;color:#78716c;font-size:12px;line-height:1.5;text-align:center;">You’re getting this because you have a ${site.siteName} account.
<a href="${unsubscribe}" style="color:#78716c;">Unsubscribe</a></p>
</body></html>`;
  // The plain-text copy: the same words without the formatting markers.
  const text = `${fill(body)
    .replace(/\[([^\]\n]+)\]\(([^\s()]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^#{2,3}\s+/gm, '')}\n\n--\nUnsubscribe: ${unsubscribe}\n`;
  return {
    to: user.email,
    subject: fill(subject).replace(/[\r\n]+/g, ' '),
    html,
    text,
    headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

// --- who a send goes to --------------------------------------------------------

// audience is { ids: [...] } (ticked on the users list) or { filters } (all
// matching the list's filters). Unsubscribed people are always left out.
// Suspended accounts only get it if they were ticked, or filtered for.
async function resolveAudience(audience) {
  const users = await matchingUsers(audience);
  const wantsSuspended = !!audience.ids || audience.filters.status === 'suspended';
  const recipients = users.filter((u) => !u.email_opt_out && (wantsSuspended || u.status !== 'suspended'));
  return { recipients, skipped: users.length - recipients.length };
}

// --- sends ---------------------------------------------------------------------

// Starts the send. Returns its id — the existing one if this form was already
// submitted (sendKey).
async function createCampaign(template, audience, { sendKey, sentBy }) {
  await ensureTables();
  const { recipients } = await resolveAudience(audience);
  if (!recipients.length) throw inputError('Nobody to send to — everyone selected has unsubscribed or is suspended.');
  let id;
  try {
    const [result] = await pool.query(
      `INSERT INTO ${CAMPAIGNS} (send_key, template_name, subject, body, sent_by) VALUES (?, ?, ?, ?, ?)`,
      [sendKey, template.name, template.subject, template.body, sentBy],
    );
    id = result.insertId;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const [[existing]] = await pool.query(`SELECT id FROM ${CAMPAIGNS} WHERE send_key = ?`, [sendKey]);
    return existing.id;
  }
  for (let i = 0; i < recipients.length; i += 1000) {
    await pool.query(
      `INSERT INTO ${RECIPIENTS} (campaign_id, user_id) VALUES ?`,
      [recipients.slice(i, i + 1000).map((u) => [id, u.id])],
    );
  }
  await pool.query(`UPDATE ${CAMPAIGNS} SET status = 'sending' WHERE id = ?`, [id]);
  runQueue();
  return id;
}

// Sent / failed / … per campaign.
async function countsFor(ids) {
  const counts = new Map(ids.map((id) => [id, { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0, total: 0 }]));
  if (!ids.length) return counts;
  const [rows] = await pool.query(`SELECT campaign_id, status, COUNT(*) AS n FROM ${RECIPIENTS} WHERE campaign_id IN (?) GROUP BY campaign_id, status`, [ids]);
  rows.forEach((r) => {
    const c = counts.get(r.campaign_id);
    c[r.status] = Number(r.n);
    c.total += Number(r.n);
  });
  return counts;
}

async function listCampaigns() {
  await ensureTables();
  const [rows] = await pool.query(`SELECT id, template_name, subject, status, created_at FROM ${CAMPAIGNS} ORDER BY created_at DESC, id DESC LIMIT 50`);
  const counts = await countsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, counts: counts.get(r.id) }));
}

async function getCampaign(id) {
  await ensureTables();
  const [[campaign]] = await pool.query(`SELECT * FROM ${CAMPAIGNS} WHERE id = ? LIMIT 1`, [id]);
  if (!campaign) return null;
  const counts = await countsFor([id]);
  const [problems] = await pool.query(
    `SELECT r.user_id, r.status, r.error, u.name, u.email FROM ${RECIPIENTS} r LEFT JOIN PDZ_users u ON u.id = r.user_id
     WHERE r.campaign_id = ? AND r.status IN ('failed', 'skipped') ORDER BY r.id LIMIT 200`,
    [id],
  );
  return { ...campaign, counts: counts.get(id), problems };
}

async function pauseCampaign(id, reason = '') {
  await ensureTables();
  await pool.query(`UPDATE ${CAMPAIGNS} SET status = 'paused', last_error = ? WHERE id = ? AND status = 'sending'`, [String(reason).slice(0, 300), id]);
}

async function resumeCampaign(id) {
  await ensureTables();
  await pool.query(`UPDATE ${CAMPAIGNS} SET status = 'sending', last_error = '' WHERE id = ? AND status = 'paused'`, [id]);
  runQueue();
}

// Whoever hasn't been emailed yet won't be. Sent emails can't be recalled.
async function cancelCampaign(id) {
  await ensureTables();
  const [result] = await pool.query(`UPDATE ${CAMPAIGNS} SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('sending', 'paused')`, [id]);
  if (result.affectedRows) await pool.query(`UPDATE ${RECIPIENTS} SET status = 'skipped', error = 'Send cancelled' WHERE campaign_id = ? AND status = 'queued'`, [id]);
}

// Worth stopping for, rather than failing every recipient left: anything
// except the server refusing this one address. 530/534/535 are sign-in errors.
function isSenderProblem(err) {
  return !err.responseCode || err.responseCode < 500 || [530, 534, 535].includes(err.responseCode);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const setRecipient = (id, status, error = '') => pool.query(
  `UPDATE ${RECIPIENTS} SET status = ?, error = ?, sent_at = ${status === 'sent' ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`,
  [status, String(error).slice(0, 300), id],
);

// One queued email: claim it, send it, record what happened. false = nothing
// left to send.
let failsInARow = 0;
async function sendNext() {
  const [[row]] = await pool.query(
    `SELECT r.id, r.campaign_id, c.subject, c.body, u.id AS user_id, u.name, u.email, u.handle, u.email_opt_out
     FROM ${RECIPIENTS} r JOIN ${CAMPAIGNS} c ON c.id = r.campaign_id LEFT JOIN PDZ_users u ON u.id = r.user_id
     WHERE r.status = 'queued' AND c.status = 'sending' ORDER BY r.id LIMIT 1`,
  );
  if (!row) return false;
  const [claim] = await pool.query(`UPDATE ${RECIPIENTS} SET status = 'sending' WHERE id = ? AND status = 'queued'`, [row.id]);
  if (!claim.affectedRows) return true;
  if (!row.user_id || row.email_opt_out) {
    await setRecipient(row.id, 'skipped', row.user_id ? 'Unsubscribed' : 'Account deleted');
    return true;
  }
  try {
    await sendMail(buildEmail(row, { ...row, id: row.user_id }));
    await setRecipient(row.id, 'sent');
    failsInARow = 0;
  } catch (err) {
    console.error(`Email to user ${row.user_id} failed:`, err.message);
    failsInARow += 1;
    const pause = isSenderProblem(err) || failsInARow >= MAX_FAILS_IN_A_ROW;
    await setRecipient(row.id, isSenderProblem(err) ? 'queued' : 'failed', isSenderProblem(err) ? '' : err.message);
    if (pause) {
      failsInARow = 0;
      await pauseCampaign(row.campaign_id, err.message);
    }
  }
  await wait(SEND_DELAY_MS);
  return true;
}

let running = false;
let runAgain = false;
async function runQueue() {
  if (running) {
    runAgain = true;
    return;
  }
  running = true;
  try {
    do {
      runAgain = false;
      await ensureTables();
      while (await sendNext()) { /* one at a time, paced by sendNext */ }
      await pool.query(`UPDATE ${CAMPAIGNS} c SET c.status = 'done', c.finished_at = CURRENT_TIMESTAMP
        WHERE c.status = 'sending' AND NOT EXISTS (SELECT 1 FROM ${RECIPIENTS} r WHERE r.campaign_id = c.id AND r.status IN ('queued', 'sending'))`);
    } while (runAgain);
  } catch (err) {
    console.error('Email queue stopped:', err);
  } finally {
    running = false;
  }
}

// At boot: remember the site's address and pick up anything still queued. A
// row left "sending" means the server stopped mid-send; it may have gone out,
// so it's reported rather than sent again.
async function startEmails({ siteName, siteDomain }) {
  site = { siteName, siteDomain };
  await ensureTables();
  await pool.query(`UPDATE ${RECIPIENTS} SET status = 'failed', error = 'Server restarted during this send — it may not have arrived' WHERE status = 'sending'`);
  runQueue();
}

// The public unsubscribe link. true if the link was genuine.
async function unsubscribe(userId, token) {
  if (!validUnsubscribe(userId, token)) return false;
  await setEmailOptOut(userId);
  return true;
}

module.exports = {
  PLACEHOLDERS,
  MAX_BODY,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  buildEmail,
  resolveAudience,
  createCampaign,
  listCampaigns,
  getCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  validUnsubscribe,
  unsubscribe,
  startEmails,
};
