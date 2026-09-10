// Canonical token manifest for the structural theme system (see
// lib/themes.js and the pz_themes/pz_store_themes tables in db/database.js).
// Each theme declares its OWN default token values in its own
// themes/<slug>/theme.json (read via lib/themeManifest.js) — that's what
// lets two different themes have two different baseline looks. DEFAULT_
// TOKENS below is only the safety-net fallback for a theme with no
// manifest (or an invalid one); it's deliberately the exact values already
// in public/css/style.css's :root, so a store with no customization and no
// manifest still renders identically to before this system existed. A
// store can override any subset of the resolved tokens; those overrides
// are stored as JSON in pz_store_themes.token_overrides and merged on top
// when the storefront renders (see routes/storefront.js + the inline style
// emitted on <body> in views/storefront/themes/default/partials/header.ejs).
//
// Kept deliberately small for v1 — colors + corner radius. Typography
// tokens (a heading/body font pairing) are a natural next addition once
// this is proven out, not included here yet.

const { readManifest } = require('./themeManifest');

const DEFAULT_TOKENS = {
  color_primary: '#16a34a',
  color_primary_dark: '#15803d',
  color_bg: '#fafafa',
  color_surface: '#ffffff',
  color_text: '#1a1a1a',
  color_muted: '#6b7280',
  color_border: '#e5e7eb',
  radius_style: 'soft', // 'sharp' | 'soft' | 'pill' — see RADIUS_PX below
};

const RADIUS_PX = { sharp: '2px', soft: '10px', pill: '22px' };

const COLOR_TOKEN_KEYS = [
  'color_primary', 'color_primary_dark', 'color_bg',
  'color_surface', 'color_text', 'color_muted', 'color_border',
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// A theme's own baseline tokens — its theme.json's "tokens" block merged
// over the hardcoded DEFAULT_TOKENS safety net (so a manifest only needs to
// declare the values it actually wants to change, and a missing/invalid
// manifest still resolves to something sane).
function themeDefaultTokens(themeSlug) {
  const tokens = { ...DEFAULT_TOKENS };
  const manifest = readManifest(themeSlug);
  const manifestTokens = manifest && manifest.tokens;
  if (manifestTokens && typeof manifestTokens === 'object') {
    for (const key of COLOR_TOKEN_KEYS) {
      if (typeof manifestTokens[key] === 'string' && HEX_RE.test(manifestTokens[key])) tokens[key] = manifestTokens[key];
    }
    if (typeof manifestTokens.radius_style === 'string' && RADIUS_PX[manifestTokens.radius_style]) {
      tokens.radius_style = manifestTokens.radius_style;
    }
  }
  return tokens;
}

// Merges a store's saved overrides on top of a theme's own default tokens
// (themeDefaultTokens above). Treats stored JSON as untrusted — anything
// missing or invalid just falls back to the default rather than breaking
// the page.
function resolveTokens(overrides, themeSlug) {
  const tokens = themeDefaultTokens(themeSlug);
  if (overrides && typeof overrides === 'object') {
    for (const key of COLOR_TOKEN_KEYS) {
      if (typeof overrides[key] === 'string' && HEX_RE.test(overrides[key])) tokens[key] = overrides[key];
    }
    if (typeof overrides.radius_style === 'string' && RADIUS_PX[overrides.radius_style]) {
      tokens.radius_style = overrides.radius_style;
    }
  }
  return tokens;
}

// Validates a patch from the admin "Customize" form before it's saved to
// pz_store_themes.token_overrides — same spirit as lib/sections.js's
// sanitizeFields, but flat, since every theme shares this one token set.
function sanitizeTokenPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object') return clean;
  for (const key of COLOR_TOKEN_KEYS) {
    if (typeof patch[key] === 'string' && HEX_RE.test(patch[key])) clean[key] = patch[key];
  }
  if (typeof patch.radius_style === 'string' && RADIUS_PX[patch.radius_style]) clean.radius_style = patch.radius_style;
  return clean;
}

// The inline CSS custom-property declarations for a resolved token set,
// meant for <body style="...">. Inline style beats both the stylesheet's
// :root defaults and the older pz_stores.theme color-preset class
// (body.theme-gold/body.theme-red in style.css) for whichever properties a
// store has actually customized — the two systems can coexist; a store that
// hasn't touched the new token editor still renders exactly as the old
// color-preset system would.
function tokensToInlineStyle(tokens) {
  let s = '';
  for (const key of COLOR_TOKEN_KEYS) {
    s += `--${key.replace(/_/g, '-')}:${tokens[key]};`;
  }
  s += `--radius:${RADIUS_PX[tokens.radius_style] || RADIUS_PX.soft};`;
  return s;
}

module.exports = {
  DEFAULT_TOKENS, COLOR_TOKEN_KEYS, RADIUS_PX,
  themeDefaultTokens, resolveTokens, sanitizeTokenPatch, tokensToInlineStyle,
};
