// CRM contact sanitizing — mirrors lib/sections.js's role for page builder
// fields: the one place that turns raw req.body into a safe, validated
// shape, shared by every route that writes to pz_contacts.
const VALID_SOURCES = ['manual', 'contact_form', 'signup', 'order', 'newsletter'];

function sanitizeContact(body) {
  body = body || {};
  const name = String(body.name || '').trim().slice(0, 255);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 255);
  const phone = String(body.phone || '').trim().slice(0, 50);
  const source = VALID_SOURCES.includes(body.source) ? body.source : 'manual';
  return { name, email, phone: phone || null, source };
}

module.exports = { sanitizeContact, VALID_SOURCES };
