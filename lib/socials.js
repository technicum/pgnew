// A creator's social profiles — the Profile tab's "Social links" fields in
// the store builder, shown as a row of icons under the bio on their store
// (views/store.ejs). Stored as JSON in PDZ_users.socials: what the creator
// typed per platform ({ instagram: '@meera', website: 'meera.in' }); the
// links are worked out from that when the store is drawn, so a handle, a
// full profile URL or a bare "instagram.com/x" all work.

// Builder field order is store icon order. kind: 'handle' turns a bare
// handle into base + handle (a pasted URL is used as is), 'url' needs a
// website, 'email' becomes mailto:, 'phone' becomes a wa.me link.
const PLATFORMS = [
  { id: 'instagram', label: 'Instagram', kind: 'handle', base: 'https://instagram.com/', placeholder: '@yourname',
    icon: '<rect x="3" y="3" width="18" height="18" rx="5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><circle cx="17.5" cy="6.5" r="1.1" fill="currentColor"/>' },
  { id: 'youtube', label: 'YouTube', kind: 'handle', base: 'https://youtube.com/@', placeholder: '@yourchannel',
    icon: '<rect x="2" y="5" width="20" height="14" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="m10 9 5 3-5 3V9z" fill="currentColor"/>' },
  { id: 'x', label: 'X (Twitter)', kind: 'handle', base: 'https://x.com/', placeholder: '@yourname',
    icon: '<path d="M4 4h4.5l11.5 16h-4.5zM20 4l-6.6 7.4M4 20l6.6-7.4" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>' },
  { id: 'linkedin', label: 'LinkedIn', kind: 'handle', base: 'https://linkedin.com/in/', placeholder: 'linkedin.com/in/yourname',
    icon: '<rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  { id: 'facebook', label: 'Facebook', kind: 'handle', base: 'https://facebook.com/', placeholder: 'facebook.com/yourpage',
    icon: '<path d="M15 3h-2a4 4 0 0 0-4 4v3H7v4h2v7h4v-7h3l1-4h-4V7a1 1 0 0 1 1-1h2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' },
  { id: 'tiktok', label: 'TikTok', kind: 'handle', base: 'https://tiktok.com/@', placeholder: '@yourname',
    icon: '<path d="M9 12a4 4 0 1 0 4 4V3c.5 2.5 2.5 4.5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' },
  { id: 'threads', label: 'Threads', kind: 'handle', base: 'https://threads.net/@', placeholder: '@yourname',
    icon: '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  { id: 'whatsapp', label: 'WhatsApp', kind: 'phone', placeholder: '+91 98765 43210',
    icon: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' },
  { id: 'telegram', label: 'Telegram', kind: 'handle', base: 'https://t.me/', placeholder: '@yourname',
    icon: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' },
  { id: 'website', label: 'Website', kind: 'url', placeholder: 'yourwebsite.com',
    icon: '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="1.8"/>' },
  { id: 'email', label: 'Email', kind: 'email', placeholder: 'you@example.com',
    icon: '<rect x="2" y="4" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="m22 7-10 6L2 7" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' },
];
const MAX_LENGTH = 200;

// Only http(s) links are ever rendered — never javascript: or data: — and
// a bare "instagram.com/x" gets https:// added.
function safeHref(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (err) {
    return null;
  }
}

const looksLikeUrl = (v) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(v);

function socialHref(platform, raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  switch (platform.kind) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : null;
    case 'url':
      return value.includes('.') ? safeHref(value) : null;
    case 'phone': {
      if (looksLikeUrl(value)) return safeHref(value);
      const digits = value.replace(/\D/g, '');
      return digits.length >= 6 ? `https://wa.me/${digits}` : null;
    }
    default: {
      if (looksLikeUrl(value)) return safeHref(value);
      const handle = value.replace(/^@/, '');
      return /^[\w.-]+$/.test(handle) ? platform.base + handle : null;
    }
  }
}

// Whatever came in (a JSON string from the column, or the builder's
// object) → { platformId: typed value } with known platforms and non-empty
// values only.
function normalizeSocials(input) {
  let source = input;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (err) { source = null; }
  }
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const p of PLATFORMS) {
    const value = String(source[p.id] ?? '').trim().slice(0, MAX_LENGTH);
    if (value) out[p.id] = value;
  }
  return out;
}

// What the store page draws: one icon link per platform that has a usable
// link, in PLATFORMS order.
function socialLinks(input) {
  const socials = normalizeSocials(input);
  return PLATFORMS
    .map((p) => ({ id: p.id, label: p.label, icon: p.icon, href: socialHref(p, socials[p.id]) }))
    .filter((link) => link.href);
}

module.exports = { PLATFORMS, safeHref, socialHref, normalizeSocials, socialLinks };
