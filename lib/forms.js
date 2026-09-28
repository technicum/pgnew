// Support for the Forms module (pz_forms — see routes/admin.js's
// /admin/forms routes and db/database.js's ${TABLES.forms}) and its
// submissions. Mirrors lib/contacts.js's role as the one place that turns
// raw req.body into a safe, validated shape, and lib/sections.js's role for
// section fields in general.
//
// A form is a real, standalone thing a merchant builds from scratch (name,
// heading/subtext/button/success copy, and its own field list) — it gets a
// live URL at /forms/<slug>, and the page-builder's 'form' section just
// embeds one by id (form_id), the same way a nav_menu section just displays
// a saved menu.
//
// Every field is fully custom -- nothing is locked. A merchant picks
// whichever fields they want, in whatever order, including whether to have
// a name or phone field at all. Because of that, a submission only creates
// or updates a CRM contact when the form actually has a phone-type field
// (matched by type, not by a fixed key) -- see sanitizeSubmission below and
// routes/storefront.js's POST /forms/submit. A form with no phone field
// still saves every submission, it just doesn't create a lead.
const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'select', 'radio', 'checkbox'];
const FIELD_TYPE_LABELS = {
  text: 'Short text',
  textarea: 'Paragraph',
  email: 'Email',
  tel: 'Phone',
  number: 'Number',
  select: 'Dropdown',
  radio: 'Radio buttons',
  checkbox: 'Checkboxes',
};
// Field types whose choices come from an editable options list, shown by
// the field builder (public/js/form-builder.js) as an add/remove list of
// individual choice rows.
const CHOICE_TYPES = ['select', 'radio', 'checkbox'];
// A paragraph or a group of radio buttons/checkboxes always reads better as
// its own full row, whatever size is picked for it -- see sanitizeFieldList
// below and section.ejs's rendering, both of which force 'large' for these.
const FULL_WIDTH_TYPES = ['textarea', 'radio', 'checkbox'];
const FIELD_SIZES = ['small', 'medium', 'large'];
// Whether a field shows its label normally (above the field, as usual) or
// as placeholder text inside the field instead (the visible label is
// swapped for a screen-reader-only one -- see section.ejs's 'form'
// rendering and style.css's .pz-form-field .sr-only). Doesn't apply to
// radio/checkbox -- a group of choices always needs its heading visible,
// there's no single input to put a placeholder in.
const LABEL_DISPLAY_MODES = ['label', 'placeholder'];
const NO_PLACEHOLDER_TYPES = ['radio', 'checkbox'];
const MAX_FIELDS = 12;
const MAX_OPTIONS_PER_FIELD = 30;

function defaultFieldList() {
  // A brand-new form starts blank -- the field builder is meant to be built
  // from scratch, not pre-populated with a guess at what the merchant wants.
  return [];
}

// Turns the field builder's serialized field list (public/js/form-builder.js
// posts it as JSON into the edit screen's hidden fields_json input) into a
// safe, validated field list to store on the pz_forms row. Every field is
// re-validated regardless of what the client sent: type must be one of
// FIELD_TYPES, size one of FIELD_SIZES, options only kept (and only
// meaningful) for CHOICE_TYPES. Fields are re-keyed f1/f2/... by their final
// position every save -- simple and matches the same "never derive a key
// from the label" precedent as before, so renaming a field never breaks a
// submission that already used its key.
function sanitizeFieldList(rawFields) {
  return (Array.isArray(rawFields) ? rawFields : [])
    .slice(0, MAX_FIELDS)
    .map((f, i) => {
      const label = String((f && f.label) || '').trim().slice(0, 80);
      if (!label) return null;
      const type = FIELD_TYPES.includes(f && f.type) ? f.type : 'text';
      const size = FULL_WIDTH_TYPES.includes(type)
        ? 'large'
        : (FIELD_SIZES.includes(f && f.size) ? f.size : 'medium');
      const required = !!(f && f.required);
      const options = CHOICE_TYPES.includes(type)
        ? (Array.isArray(f && f.options) ? f.options : [])
            .map((o) => String(o || '').trim().slice(0, 80))
            .filter(Boolean)
            .slice(0, MAX_OPTIONS_PER_FIELD)
        : [];
      const placeholder = NO_PLACEHOLDER_TYPES.includes(type)
        ? ''
        : String((f && f.placeholder) || '').trim().slice(0, 100);
      const labelDisplay = NO_PLACEHOLDER_TYPES.includes(type)
        ? 'label'
        : (LABEL_DISPLAY_MODES.includes(f && f.labelDisplay) ? f.labelDisplay : 'label');
      return { label, type, required, size, options, placeholder, labelDisplay };
    })
    .filter(Boolean)
    // Keyed by final position AFTER blank-label rows are dropped above, so
    // keys always come out gapless (f1, f2, f3, ...) rather than skipping
    // over whatever index a dropped row happened to occupy.
    .map((f, i) => ({ key: `f${i + 1}`, ...f }));
}

// Turns raw req.body into { name, phone, email, data } using a form's own
// field list. `data` holds every field's answer (so the raw submission can
// be stored in full); name/phone/email are pulled out separately, matched
// by field TYPE rather than a fixed key (since nothing is locked to a
// specific key anymore) -- the first tel field is treated as the phone, the
// first email field as the email, and the first text field as the name.
// Any of these can be absent; routes/storefront.js only creates/updates a
// CRM contact when a phone value was actually found.
function sanitizeSubmission(fields, body) {
  body = body || {};
  fields = Array.isArray(fields) ? fields : [];
  const data = {};
  fields.forEach((f) => {
    if (f.type === 'checkbox') {
      const raw = body[f.key];
      const values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      data[f.key] = values.map((v) => String(v || '').trim().slice(0, 80)).filter(Boolean).slice(0, MAX_OPTIONS_PER_FIELD);
    } else {
      const raw = String(body[f.key] || '').trim();
      data[f.key] = raw.slice(0, f.type === 'textarea' ? 2000 : 255);
    }
  });

  const phoneField = fields.find((f) => f.type === 'tel');
  const emailField = fields.find((f) => f.type === 'email');
  const nameField = fields.find((f) => f.type === 'text');

  return {
    name: (nameField && data[nameField.key]) || '',
    phone: (phoneField && data[phoneField.key]) || '',
    email: (emailField && data[emailField.key]) || '',
    data,
  };
}

module.exports = {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  CHOICE_TYPES,
  FULL_WIDTH_TYPES,
  FIELD_SIZES,
  LABEL_DISPLAY_MODES,
  NO_PLACEHOLDER_TYPES,
  MAX_FIELDS,
  MAX_OPTIONS_PER_FIELD,
  defaultFieldList,
  sanitizeFieldList,
  sanitizeSubmission,
};
