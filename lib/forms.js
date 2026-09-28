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
// contact a submission creates/updates is matched by phone. `extra` (the
// field builder UI's draggable list, serialized client-side to JSON and
// parsed by routes/admin.js's POST /forms/:id/edit) is capped at
// MAX_CUSTOM_FIELDS entries, each re-keyed field_1/field_2/... (never
// derived from the label, so renaming a field never breaks a submission
// that already used the old key).
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
  sanitizeSubmission,
};
