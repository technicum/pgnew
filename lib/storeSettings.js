// The store-wide settings the builder edits besides name/handle/bio,
// socials and accent (lib/users.js, lib/socials.js): photo and cover,
// tagline, location, a contact button, the announcement bar, the theme
// (background, font, button shape) and SEO. Kept together as JSON in
// PDZ_users.store_settings so adding one more field never needs another
// ALTER. Everything is cleaned here — on save and again when read — so
// views/store.ejs can trust what it gets.
const { safeHref } = require('./socials');

const CHOICES = {
  contactType: ['none', 'whatsapp', 'email'],
  theme: ['light', 'tinted', 'dark'],
  font: ['serif', 'sans', 'rounded'],
  buttons: ['rounded', 'pill', 'square'],
};

const LIMITS = {
  photo: 500, cover: 500, shareImage: 500,
  tagline: 80, location: 60,
  contactValue: 120, contactLabel: 40,
  announceText: 120, announceUrl: 300,
  seoTitle: 70, seoDescription: 160,
};

const DEFAULTS = {
  photo: '', cover: '', tagline: '', location: '',
  contactType: 'none', contactValue: '', contactLabel: '',
  announceOn: false, announceText: '', announceUrl: '',
  theme: 'light', font: 'serif', buttons: 'rounded',
  seoTitle: '', seoDescription: '', shareImage: '',
};

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// An upload of ours or an https:// image; anything else is dropped.
function imageUrl(value) {
  const url = text(value, 500);
  return /^(https:\/\/|\/uploads\/)[^\s"'<>]+$/i.test(url) ? url : '';
}

// What's saved: every field present, each one valid.
function normalizeStoreSettings(input) {
  let source = input;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (err) { source = null; }
  }
  if (!source || typeof source !== 'object') source = {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(LIMITS)) {
    if (source[key] !== undefined) out[key] = text(source[key], LIMITS[key]);
  }
  for (const key of ['photo', 'cover', 'shareImage']) out[key] = imageUrl(out[key]);
  for (const [key, allowed] of Object.entries(CHOICES)) {
    out[key] = allowed.includes(source[key]) ? source[key] : DEFAULTS[key];
  }
  out.announceOn = !!source.announceOn;
  return out;
}

function contactButton(s) {
  const value = s.contactValue;
  if (s.contactType === 'whatsapp') {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 6) return null;
    return { kind: 'whatsapp', href: `https://wa.me/${digits}`, label: s.contactLabel || 'Message me on WhatsApp' };
  }
  if (s.contactType === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
    return { kind: 'email', href: `mailto:${value}`, label: s.contactLabel || 'Email me' };
  }
  return null;
}

// What views/store.ejs draws from the settings. `origin` (https://meera.
// pagezaper.com) makes the share image absolute, as link previews need.
function storeView(input, { origin = '' } = {}) {
  const s = normalizeStoreSettings(input);
  const announceUrl = s.announceUrl;
  const announceHref = /^#subscribe-\d+$/.test(announceUrl) ? announceUrl : safeHref(announceUrl);
  const absolute = (url) => (url && url.startsWith('/') ? origin + url : url);
  return {
    photo: s.photo,
    cover: s.cover,
    tagline: s.tagline,
    location: s.location,
    contact: contactButton(s),
    announcement: s.announceOn && s.announceText ? { text: s.announceText, href: announceHref } : null,
    theme: s.theme,
    font: s.font,
    buttons: s.buttons,
    seo: {
      title: s.seoTitle,
      description: s.seoDescription,
      image: absolute(s.shareImage || s.cover || s.photo),
    },
  };
}

module.exports = { DEFAULTS, CHOICES, LIMITS, normalizeStoreSettings, storeView };
