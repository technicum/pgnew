// Reads each theme's theme.json manifest from themes/<slug>/theme.json — the
// one place a theme declares its own default token values (see lib/
// themeTokens.js: this is why theme.json exists at all, rather than every
// theme sharing one hardcoded default). Cached in memory per slug since the
// file only changes on deploy, which restarts the process anyway.

const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.join(__dirname, '..', 'themes');
const cache = new Map();

// Returns the parsed theme.json for a slug, or null if it's missing/invalid
// — callers (lib/themeTokens.js) fall back to safe hardcoded defaults
// rather than letting a bad or absent manifest break rendering.
function readManifest(slug) {
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);
  let manifest = null;
  try {
    const raw = fs.readFileSync(path.join(THEMES_DIR, slug, 'theme.json'), 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    manifest = null;
  }
  cache.set(slug, manifest);
  return manifest;
}

module.exports = { readManifest };
