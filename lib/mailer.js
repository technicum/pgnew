// Sends email through the SMTP server configured in Platform Admin >
// Settings (see lib/settings.js). Every caller goes through sendMail() so the
// settings are read fresh — a change on the settings page applies to the next
// email without a restart.
//
// nodemailer is required lazily so the app still boots if it hasn't been
// installed yet (npm install), instead of failing every page over an email
// dependency.
const settings = require('./settings');

async function smtpConfig() {
  const c = await settings.getGroup('smtp');
  return {
    host: c.host,
    port: parseInt(c.port, 10) || 587,
    secure: c.secure,
    user: c.user,
    pass: c.pass,
    fromName: c.from_name,
    fromEmail: c.from_email || c.user,
  };
}

async function sendMail({ to, subject, text, html, fromName, replyTo }) {
  const cfg = await smtpConfig();
  if (!cfg.host) throw new Error('SMTP host is not set. Save your SMTP settings first.');
  if (!cfg.fromEmail) throw new Error('Set a From email (or a username that is an email address) first.');

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('The nodemailer package is not installed. Run "npm install" and restart the server.');
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === 'ssl', // true = implicit TLS (465)
    requireTLS: cfg.secure === 'starttls',
    ignoreTLS: cfg.secure === 'none',
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  // fromName lets a caller display e.g. "Acme Store via PageZaper" without
  // touching the authenticated sending address itself (cfg.fromEmail) --
  // SPF/DKIM/DMARC are all keyed to the address, never the display name, so
  // this can vary per call safely. Falls back to the configured From name,
  // then the bare address if neither is set.
  const displayName = fromName || cfg.fromName;

  return transporter.sendMail({
    from: displayName ? { name: displayName, address: cfg.fromEmail } : cfg.fromEmail,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || undefined,
  });
}

module.exports = { sendMail };
