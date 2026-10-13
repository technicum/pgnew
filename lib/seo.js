// SEO for the platform's own public pages (Platform admin → SEO): the title,
// description and share image search engines and link previews show for the
// homepage, Explore, About and the blog. Blank fields use the built-in text
// (DEFAULTS). Stored in PDZ_platform_settings next to the fees (lib/platform.js)
// as seo_<page>_<field>.
//
// Also: the page's <head> tags (views/partials/seo-meta.ejs reads what
// metaFor returns), and sitemap.xml / robots.txt (server.js).
const pool = require('./db');

const TABLE = 'PDZ_platform_settings';
const PAGES = {
  home: { label: 'Homepage', path: '/' },
  explore: { label: 'Explore (marketplace)', path: '/explore' },
  about: { label: 'About', path: '/about' },
  blog: { label: 'Blog', path: '/blog' },
};
const FIELDS = { title: 70, description: 160, image: 500 };
const DEFAULTS = (siteName) => ({
  home: {
    title: `${siteName} — The Creator Business Toolkit`,
    description: 'Grow your audience, sell digital products, automate conversations, and run your creator business from one beautiful page.',
  },
  explore: {
    title: `Explore — ${siteName}`,
    description: `Find sessions, courses, events and products from creators, coaches, doctors and studios on ${siteName}.`,
  },
  about: {
    title: `About — ${siteName}`,
    description: `${siteName} is one page for bookings, courses, events, digital products and payments.`,
  },
  blog: {
    title: `Blog — ${siteName}`,
    description: `Guides, ideas and news for creators selling on ${siteName}.`,
  },
});

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        name VARCHAR(40) NOT NULL PRIMARY KEY,
        value VARCHAR(200) NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `).then(async () => {
      // The share image link can be longer than the fee settings ever were.
      const [[col]] = await pool.query(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'value'`, [TABLE],
      );
      if (col && Number(col.len) < 500) await pool.query(`ALTER TABLE ${TABLE} MODIFY value VARCHAR(500) NOT NULL DEFAULT ''`);
    }).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const imageUrl = (v) => {
  const url = String(v || '').trim().slice(0, FIELDS.image);
  return /^(https:\/\/|\/uploads\/)[^\s"'<>]+$/i.test(url) ? url : '';
};

let cache = null;
// { home: { title, description, image }, … } — what the admin typed (blank = default).
async function getSeoSettings() {
  if (cache) return cache;
  await ensureTable();
  const [rows] = await pool.query(`SELECT name, value FROM ${TABLE} WHERE name LIKE 'seo\\_%'`);
  const map = new Map(rows.map((r) => [r.name, r.value]));
  const out = {};
  Object.keys(PAGES).forEach((page) => {
    out[page] = {};
    Object.keys(FIELDS).forEach((f) => { out[page][f] = map.get(`seo_${page}_${f}`) || ''; });
  });
  cache = out;
  return out;
}

async function saveSeoSettings(body) {
  await ensureTable();
  const values = [];
  Object.keys(PAGES).forEach((page) => {
    Object.entries(FIELDS).forEach(([f, max]) => {
      const raw = body[`${page}_${f}`];
      const value = f === 'image' ? imageUrl(raw) : String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
      if (f === 'image' && String(raw || '').trim() && !value) {
        const err = new Error(`The ${PAGES[page].label} share image needs to be an upload or an https:// link.`);
        err.code = 'INVALID_INPUT';
        throw err;
      }
      values.push([`seo_${page}_${f}`, value]);
    });
  });
  await pool.query(
    `INSERT INTO ${TABLE} (name, value) VALUES ${values.map(() => '(?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    values.flat(),
  );
  cache = null;
}

// The <head> tags for one of the platform pages: { title, description, image, url }.
// origin makes the image and canonical link absolute, as link previews need.
async function metaFor(page, { siteName, origin = '' }) {
  const saved = (await getSeoSettings())[page] || {};
  const def = DEFAULTS(siteName)[page] || {};
  const abs = (u) => (u && u.startsWith('/') ? origin + u : u);
  return {
    title: saved.title || def.title,
    description: saved.description || def.description,
    image: abs(saved.image || ''),
    url: origin ? origin + (PAGES[page] ? PAGES[page].path : '/') : '',
  };
}

module.exports = { PAGES, FIELDS, DEFAULTS, getSeoSettings, saveSeoSettings, metaFor };
