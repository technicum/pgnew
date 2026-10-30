// Outgoing email (lib/mailer.js) — simple transactional and nudge emails
// (e.g. "finish setting up your page"), sent through Hostinger's SMTP
// mailbox for hello@pagezaper.com.
//
// Turned on by setting SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in
// .env; without them sendMail() throws, so call mailerEnabled() first
// wherever a missing mailbox should degrade quietly instead of crashing
// a request (same pattern as lib/googleAuth.js).
const nodemailer = require('nodemailer');

function mailerEnabled() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // true for 465 (SSL), false for 587 (STARTTLS)
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

// to: string | string[]; subject/html/text: the message. from defaults to
// the configured mailbox, shown as "PageZaper". headers is optional
// (List-Unsubscribe, lib/emails.js).
async function sendMail({ to, subject, html, text, from, headers }) {
  if (!mailerEnabled()) {
    const err = new Error('Email isn’t configured — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return getTransporter().sendMail({
    from: from || `"PageZaper" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text,
    headers,
  });
}

module.exports = { mailerEnabled, sendMail };
