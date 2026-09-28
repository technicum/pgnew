// Support for the Forms module (pz_forms — see routes/admin.js's
// /admin/forms routes and db/database.js's ${TABLES.forms}) and its
// submissions. Mirrors lib/contacts.js's role as the one place that turns
// raw req.body into a safe, validated shape, and lib/sections.js's role for
// section fields in general.
//
// A form is a real, standalone thing a merchant builds once (name, heading/
// subtext/button/success copy, and its own field list) — it gets a live URL
// at /forms/<slug>, and the page-builder's 'form' section just embeds one by
// id (form_id), the same way a nav_menu section just displays a saved menu.
//
// Every form's first two fields are always 'name' (text) and 'phone' (tel),
// both locked required — their labels can be customized, but not their key
// or type, since the CRM contact a submission creates/updates is matched by
// phone (see routes/storefront.js's POST /forms/submit). Beyond that, a
// merchant can add up to MAX_CUSTOM_FIELDS fields of their own choosing.
const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number'];
const FIELD_TYPE_LABELS = { text: 'Short text', textarea: 'Long text', email: 'Email', tel: 'Phone', number: 'Number' };
const MAX_CUSTOM_FIELDS = 10;

function defaultFieldList() {
  return [
    { key: 'name', label: 'Full name', type: 'text', required: true },
    { key: 'phone', label: 'Phone number', type: 'tel', required: true },
    { key: 'email', label: 'Email', type: 'email', required: false },
    { key: 'message', label: 'Message', type: 'textarea', required: false },
  ];
}

// Turns the form-edit screen's own inputs into a safe, validated field
// list. name/phone are always present and locked to key 'name'/'phone' and
// type text/tel — only their label comes from the input — since the CRM
// contact a submission creates/updates is matched by phone. `extra` (parsed
// from the edit screen's "more fields" textarea by parseFieldsText below)
// is capped at MAX_CUSTOM_FIELDS entries, each re-keyed field_1/field_2/...
// (never derived from the label, so renaming a field never breaks a
// submission that already used the old key).
function sanitizeFieldList(nameLabel, phoneLabel, extra) {
  const nLabel = String(nameLabel || '').trim().slice(0, 60) || 'Full name';
  const pLabel = String(phoneLabel || '').trim().slice(0, 60) || 'Phone number';
  const extraFields = (Array.isArray(extra) ? extra : [])
    .slice(0, MAX_CUSTOM_FIELDS)
    .map((f, i) => {
      const label = String((f && f.label) || '').trim().slice(0, 60);
      const type = FIELD_TYPES.includes(f && f.type) ? f.type : 'text';
      return label ? { key: `field_${i + 1}`, label, type, required: !!(f && f.required) } : null;
    })
    .filter(Boolean);
  return [
    { key: 'name', label: nLabel, type: 'text', required: true },
    { key: 'phone', label: pLabel, type: 'tel', required: true },
    ...extraFields,
  ];
}

// The form-edit screen's "more fields" textarea, one field per line as
// "Label | type | required" (type and "required" both optional — e.g. just
// "Company name" is a plain optional text field). Mirrors the same
// line-based editor pattern already used for link_columns/social_icons in
// public/js/admin-builder.js, just parsed server-side here since this
// screen is plain server-rendered HTML, not the JS-driven page builder.
function parseFieldsText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((p) => p.trim());
      return { label: parts[0] || '', type: (parts[1] || 'text').toLowerCase(), required: /required/i.test(parts[2] || '') };
    })
    .filter((f) => f.label);
}

// The reverse of parseFieldsText, to pre-fill the textarea when editing an
// existing form. Takes a full field list (as sanitizeFieldList returns it)
// and drops the locked name/phone entries, since those have their own
// dedicated inputs on the edit screen.
function fieldsToText(fields) {
  return (fields || [])
    .filter((f) => f.key !== 'name' && f.key !== 'phone')
    .map((f) => `${f.label} | ${f.type}${f.required ? ' | required' : ''}`)
    .join('\n');
}

// Turns raw req.body into { name, phone, email, data } using a form's own
// field list. `data` holds every field (including name/phone/email) so the
// raw submission can be stored in full; name/phone/email are pulled out
// separately since those are what create/update the CRM contact.
function sanitizeSubmission(fields, body) {
  body = body || {};
  const data = {};
  (fields || []).forEach((f) => {
    const raw = String(body[f.key] || '').trim();
    data[f.key] = raw.slice(0, f.type === 'textarea' ? 2000 : 255);
  });
  return {
    name: data.name || '',
    phone: data.phone || '',
    email: data.email || '',
    data,
  };
}

module.exports = {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  MAX_CUSTOM_FIELDS,
  defaultFieldList,
  sanitizeFieldList,
  parseFieldsText,
  fieldsToText,
  sanitizeSubmission,
};
