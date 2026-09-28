// Form-submission handling for the page-builder's 'form' section type --
// mirrors lib/contacts.js's role as the one place that turns raw req.body
// into a safe, validated shape, and lib/sections.js's role for section
// fields in general.
//
// v1 deliberately does NOT let a merchant build arbitrary custom fields --
// that needs a real field-list editor in public/js/admin-builder.js, which
// is a separate, larger change. Instead a 'form' section picks one of a
// small set of presets below, each a fixed, sensible field list for a
// common use case. Every preset always asks for name + phone, since that's
// the minimum a business needs to actually follow up on a lead.
const FORM_PRESETS = {
  contact: {
    label: 'Contact form',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'phone', label: 'Phone number', type: 'tel', required: true },
      { key: 'email', label: 'Email', type: 'email', required: false },
      { key: 'message', label: 'Message', type: 'textarea', required: false },
    ],
  },
  enquiry: {
    label: 'Enquiry form',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'phone', label: 'Phone number', type: 'tel', required: true },
      { key: 'interest', label: "What are you interested in?", type: 'text', required: false },
      { key: 'message', label: 'A few details', type: 'textarea', required: false },
    ],
  },
  consultation: {
    label: 'Consultation request',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'phone', label: 'Phone number', type: 'tel', required: true },
      { key: 'topic', label: 'What do you need help with?', type: 'text', required: false },
      { key: 'message', label: 'Briefly describe your situation', type: 'textarea', required: false },
    ],
  },
  booking_request: {
    label: 'Booking request',
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'phone', label: 'Phone number', type: 'tel', required: true },
      { key: 'preferred_date', label: 'Preferred date', type: 'text', required: false },
      { key: 'notes', label: 'Anything we should know?', type: 'textarea', required: false },
    ],
  },
};

const VALID_PRESETS = Object.keys(FORM_PRESETS);

function getPreset(slug) {
  return FORM_PRESETS[slug] || FORM_PRESETS.contact;
}

// Turns raw req.body into { name, phone, email, data } using the preset's
// own field list. `data` holds every field (including name/phone/email) so
// the raw submission can be stored in full; name/phone/email are pulled out
// separately since those are what create/update the CRM contact.
function sanitizeSubmission(presetSlug, body) {
  body = body || {};
  const preset = getPreset(presetSlug);
  const data = {};
  preset.fields.forEach((f) => {
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

module.exports = { FORM_PRESETS, VALID_PRESETS, getPreset, sanitizeSubmission };
