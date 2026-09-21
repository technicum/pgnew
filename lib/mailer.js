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

async function sendMail({ to, subject, text, html }) {
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

  return transporter.sendMail({
    from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromEmail } : cfg.fromEmail,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendMail };
