// Store looks: a theme, font, button shape and accent colour, applied in
// one go (onboarding step 6, lib/onboarding.js). Every value is one the
// builder's Design tab offers (lib/storeSettings.js CHOICES, its accent
// swatches), so the builder shows the template as picked. Builder v2's
// template picker can grow this list.
//
// accent: null keeps the business type's own colour (lib/presets.js).
const TEMPLATES = [
  {
    key: 'classic',
    label: 'Classic',
    description: 'Clean and calm',
    settings: { theme: 'light', font: 'serif', buttons: 'rounded' },
    accent: null,
  },
  {
    key: 'fresh',
    label: 'Fresh',
    description: 'Soft colour, friendly type',
    settings: { theme: 'tinted', font: 'rounded', buttons: 'pill' },
    accent: '#0f8b6c',
  },
  {
    key: 'bold',
    label: 'Bold',
    description: 'Dark and striking',
    settings: { theme: 'dark', font: 'sans', buttons: 'square' },
    accent: '#d6336c',
  },
];

const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

module.exports = { TEMPLATES, TEMPLATE_BY_KEY };
