// Canonical per-platform icon set for the 'social_icons' footer section type
// (see SECTION_TYPES.social_icons in lib/sections.js). One shared source of
// truth for the actual glyph shown for each platform — used server-side by
// the storefront renderer (views/storefront/partials/section.ejs, block.ejs)
// and mirrored client-side in public/js/admin-builder.js's own copy (the
// admin canvas is pure client JS with no access to this Node module, so its
// SOCIAL_ICON_SVGS constant must stay in sync with this file by hand — see
// the comment there).
//
// Every icon is a plain 24x24 viewBox path using currentColor (no fills of
// its own) so it inherits color from its container's CSS, exactly like the
// section-type icons already used in the "Add a section" library panel.
// These are simplified, original glyph traces (not copied brand assets), on
// the same footing as any other favicon-style icon set — swap any of these
// for a licensed icon font/set later without touching anything that calls
// getSocialIcon().
//
// The key set here MUST match lib/sections.js's SOCIAL_PLATFORMS allowlist
// exactly, since sanitizeFields() only ever stores one of those platform
// keys (falling back to 'custom' for anything else) — see sections.js's
// 'social_icons' case in sanitizeFields.
const SOCIAL_ICON_SVGS = {
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 8.5h-2a1.5 1.5 0 0 0-1.5 1.5v2h3.4l-.5 3.2H12V21H8.7v-5.8H6.5v-3.2h2.2v-2.3A4 4 0 0 1 12.9 5.5h2.6v3Z"/></svg>',
  // X/Twitter's own mark, drawn as two crossing strokes rather than the
  // bird — matches how the platform presents itself today.
  twitter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.5" width="18" height="11" rx="3.5"/><path d="M10.5 9.8l4.5 2.2-4.5 2.2Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3.5v11.2a3.3 3.3 0 1 1-3.3-3.3c.3 0 .6 0 .9.1"/><path d="M13 3.5c.3 2.2 2 3.9 4.2 4.1"/></svg>',
  pinterest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 19c.6-2.4 1.4-5.7 2-8.2a2.6 2.6 0 0 1 2.5-2c1.6 0 2.7 1.1 2.7 2.9 0 2.4-1.2 4.6-3.2 4.6-.8 0-1.5-.4-1.8-1"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5v6M8 7.8v.1"/><path d="M12 16.5v-3.3a2.2 2.2 0 0 1 4.4 0v3.3M12 16.5v-6"/></svg>',
  // Generic fallback for platform === 'custom' (or any value that somehow
  // isn't in SOCIAL_PLATFORMS) — a plain link/chain glyph, not blank, so an
  // un-recognized entry never renders as an empty circle.
  custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 14.5l5-5"/><path d="M11 8l.9-.9a3 3 0 0 1 4.2 4.2l-.9.9"/><path d="M13 16l-.9.9a3 3 0 0 1-4.2-4.2l.9-.9"/></svg>',
};

// Ordered for select/checkbox lists in the admin UI — display label plus
// the platform key sanitizeFields()/admin-builder.js both already use.
const SOCIAL_PLATFORM_LABELS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'X (Twitter)',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
  custom: 'Custom',
};

function getSocialIcon(platform) {
  return SOCIAL_ICON_SVGS[platform] || SOCIAL_ICON_SVGS.custom;
}

module.exports = { SOCIAL_ICON_SVGS, SOCIAL_PLATFORM_LABELS, getSocialIcon };
