// Canonical constants/helpers for the structural theme marketplace (see the
// pz_themes/pz_store_themes tables in db/database.js). Deliberately kept
// pure/stateless, mirroring lib/sections.js — the actual DB lookup of a
// store's active theme lives in routes/storefront.js, which already has
// `pool`/`TABLES` in scope.
//
// A theme owns the storefront "chrome" — header, footer, page, product,
// cart, checkout, 404, account/* — each theme's copy lives under
// views/storefront/themes/<slug>/. The section-builder engine
// (views/storefront/partials/section.ejs and block.ejs) is NOT theme-owned:
// every theme renders the same shared section partials, just styled
// differently via that theme's own CSS/token manifest, so it stays in
// views/storefront/partials/ regardless of how many themes exist.

const DEFAULT_THEME_SLUG = 'default';

// The view-path prefix routes/storefront.js's res.render() calls should use
// for a given theme slug, e.g. themeViewPrefix('default') + '/page' ->
// 'storefront/themes/default/page'.
function themeViewPrefix(slug) {
  return `storefront/themes/${slug || DEFAULT_THEME_SLUG}`;
}

module.exports = { DEFAULT_THEME_SLUG, themeViewPrefix };
