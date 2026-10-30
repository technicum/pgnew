// Sending email over SMTP — any provider works (Hostinger mail, Brevo, Gmail,
// Amazon SES…). Like Razorpay, it's set up from the admin panel
// (/admin/emails/settings): settings live in PDZ_platform_settings
// (lib/platform.js), and the password never goes back to the page. With
// nothing saved there, SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in .env
// are used instead.
const nodemailer = require('nodemailer');
const { getSettings, saveSettings } = require('./platform');

const NAMES = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_from_name', 'smtp_from_email'];

// One open transport, rebuilt when the settings change. A single connection
// is plenty: lib/emails.js sends one message at a time.
let transport = null;

function fromEnv() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  return {
    host: String(SMTP_HOST || '').trim(),
    port: Number(SMTP_PORT) || 465,
    user: String(SMTP_USER || '').trim(),
    password: String(SMTP_PASS || ''),
    fromName: 'PageZaper',
    fromEmail: String(SMTP_USER || '').trim(),
  };
}

async function loadSettings() {
  const rows = await getSettings(NAMES);
  if (!String(rows.smtp_host || '').trim()) return fromEnv();
  return {
    host: String(rows.smtp_host || '').trim(),
    port: Number(rows.smtp_port) || 587,
    user: String(rows.smtp_user || '').trim(),
    password: String(rows.smtp_password || ''),
    fromName: String(rows.smtp_from_name || '').trim(),
    fromEmail: String(rows.smtp_from_email || '').trim(),
  };
}

function makeTransport(cfg, options = {}) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // 587 and 25 upgrade with STARTTLS
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    ...options,
  });
}

function closeTransport() {
  if (transport) transport.close();
  transport = null;
}

async function isConfigured() {
  const cfg = await loadSettings();
  return !!(cfg.host && cfg.fromEmail);
}

// html and text are both sent; headers is optional (List-Unsubscribe).
async function sendMail({ to, subject, html, text, headers }) {
  const cfg = await loadSettings();
  if (!cfg.host || !cfg.fromEmail) {
    const err = new Error('Email isn’t set up yet — add your SMTP details in Emails → Settings.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  if (!transport) transport = makeTransport(cfg, { pool: true, maxConnections: 1 });
  return transport.sendMail({
    from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromEmail } : cfg.fromEmail,
    to,
    subject,
    html,
    text,
    headers,
  });
}

// --- admin (/admin/emails/settings) ----------------------------------------------

// The settings for the admin form — only the password's last four characters
// leave the server.
async function adminSettings() {
  const { password, ...cfg } = await loadSettings();
  return { ...cfg, password: password ? `…${password.slice(-4)}` : '' };
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

// Saves the form. A blank password keeps the saved one; a blank host clears
// these settings, leaving .env if it has any. Anything else is checked by
// connecting and signing in first.
async function saveAdminSettings(body) {
  const current = await loadSettings();
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const next = {
    host: clean(body.host, 190),
    port: Number(body.port) || 587,
    user: clean(body.user, 190),
    password: String(body.password || '').trim() || current.password,
    fromName: clean(body.from_name, 100),
    fromEmail: clean(body.from_email, 190).toLowerCase(),
  };
  if (next.password.length > 200) throw invalid('That password is too long.');
  if (next.host) {
    if (!/^[a-z0-9.-]+$/i.test(next.host)) throw invalid('The SMTP host should look like smtp.example.com.');
    if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) throw invalid('The port should be a number, usually 587 or 465.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.fromEmail)) throw invalid('Add the address emails should come from.');
    const check = makeTransport(next);
    try {
      await check.verify();
    } catch (err) {
      throw invalid(err.code === 'EAUTH'
        ? 'The mail server didn’t accept that username and password.'
        : `Couldn’t connect to ${next.host}:${next.port} — check the host and port.`);
    } finally {
      check.close();
    }
  }
  await saveSettings({
    smtp_host: next.host,
    smtp_port: next.port,
    smtp_user: next.user,
    smtp_password: next.host ? next.password : '',
    smtp_from_name: next.fromName,
    smtp_from_email: next.fromEmail,
  });
  closeTransport();
}

module.exports = { sendMail, isConfigured, adminSettings, saveAdminSettings };
