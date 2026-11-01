// PageZaper's own logo and browser icon, set at Platform admin → Branding.
// Both are optional: left blank, the pages keep the built-in mark and icon.
// Creators' stores are not affected; they have their own photo and cover.
//
// Saved in PDZ_platform_settings as brand_logo and brand_icon. The upload's
// path stays in that table, so the admin media clean-up sees it as in use.
const { getSettings, saveSettings } = require('./platform');
const { ensureTable, imageUrl } = require('./seo');

let cache = null;

// { logo, icon } — blank where nothing has been set.
async function getBranding() {
  if (cache) return cache;
  const saved = await getSettings(['brand_logo', 'brand_icon']);
  cache = { logo: saved.brand_logo || '', icon: saved.brand_icon || '' };
  return cache;
}

function readImage(raw, label) {
  const value = imageUrl(raw);
  if (String(raw || '').trim() && !value) {
    const err = new Error(`The ${label} needs to be an upload or an https:// link.`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return value;
}

async function saveBranding(body) {
  const values = {
    brand_logo: readImage(body.logo, 'logo'),
    brand_icon: readImage(body.icon, 'icon'),
  };
  await ensureTable(); // Links can be up to 500 characters: this widens the column.
  await saveSettings(values);
  cache = null;
}

// brandLogo and brandIcon for every view. A database problem shows the
// built-in logo rather than taking the page down; the app.locals blanks
// cover anything rendered before this runs.
function installBranding(app) {
  app.locals.brandLogo = '';
  app.locals.brandIcon = '';
  app.use((req, res, next) => {
    getBranding().then((brand) => {
      res.locals.brandLogo = brand.logo;
      res.locals.brandIcon = brand.icon;
    }, (err) => {
      console.error('Branding: could not load settings:', err.message);
    }).then(() => next());
  });
}

module.exports = { getBranding, saveBranding, installBranding };
