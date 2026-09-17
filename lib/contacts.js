// CRM contact sanitizing — mirrors lib/sections.js's role for page builder
// fields: the one place that turns raw req.body into a safe, validated
// shape, shared by every route that writes to pz_contacts.
const VALID_SOURCES = ['manual', 'contact_form', 'signup', 'order', 'newsletter'];

// Free-text labels (e.g. "hot", "wholesale", "follow up") -- stored as a
// JSON array on contacts.tags rather than a separate tags table, same
// lightweight convention as pz_page_sections.fields or pz_listings.details.
// Comma-separated in the form field since that's the simplest input a
// merchant can type without any tag-picker UI.
function sanitizeTags(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((t) => t.slice(0, 30));
}

function sanitizeContact(body) {
  body = body || {};
  const name = String(body.name || '').trim().slice(0, 255);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 255);
  const phone = String(body.phone || '').trim().slice(0, 50);
  const source = VALID_SOURCES.includes(body.source) ? body.source : 'manual';
  const tags = sanitizeTags(body.tags);
  return { name, email, phone: phone || null, source, tags };
}

module.exports = { sanitizeContact, sanitizeTags, VALID_SOURCES };
