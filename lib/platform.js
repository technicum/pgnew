// PageZaper's own cut, and where a sale came from.
//
// Every paid order records its source and the platform fee taken from it:
//   marketplace — the buyer found the item on /explore (or the homepage
//                 search): marketplace_pct of the sale (20% by default)
//   direct      — the creator brought the buyer (their own link, Instagram,
//                 WhatsApp…): direct_pct (5% by default)
// The percentages are set by an admin at /admin/settings (ADMIN_EMAILS in
// .env, comma-separated) and snapshotted on each order, so changing them
// never rewrites a past sale.
//
// Attribution: marketplace links carry ?via=marketplace. The store
// subdomain the buyer lands on remembers that in a cookie for
// ATTRIBUTION_DAYS, so a buyer who browses a bit (or comes back next
// week) still counts as a marketplace sale. Each creator's store is its
// own subdomain, so the cookie only ever credits that creator's sales.
const pool = require('./db');

const TABLE = 'PDZ_platform_settings';
const DEFAULTS = { marketplace_pct: 20, direct_pct: 5 };
const COOKIE = 'pz_via';
const ATTRIBUTION_DAYS = 30;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        name VARCHAR(40) NOT NULL PRIMARY KEY,
        value VARCHAR(200) NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function getFees() {
  await ensureTable();
  const [rows] = await pool.query(`SELECT name, value FROM ${TABLE} WHERE name IN ('marketplace_pct', 'direct_pct')`);
  const fees = { ...DEFAULTS };
  rows.forEach((r) => {
    const n = Number(r.value);
    if (Number.isFinite(n)) fees[r.name] = n;
  });
  return fees;
}

// '20', '5.5' → a number from 0 to 50, or null.
function readPct(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n <= 50 ? n : null;
}

async function saveFees(body) {
  const marketplace = readPct(body.marketplace_pct);
  const direct = readPct(body.direct_pct);
  if (marketplace === null || direct === null) {
    const err = new Error('Commission needs to be a percentage from 0 to 50, like 20 or 5.5.');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  await ensureTable();
  await pool.query(
    `INSERT INTO ${TABLE} (name, value) VALUES ('marketplace_pct', ?), ('direct_pct', ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [String(marketplace), String(direct)],
  );
}

function isAdmin(user) {
  if (!user || !user.email) return false;
  const admins = String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(String(user.email).toLowerCase());
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  const hit = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

// Store middleware (lib/storefront.js): a visit from a marketplace link
// is remembered on this store.
function rememberMarketplaceVisit(req, res) {
  if (req.query.via !== 'marketplace') return;
  res.cookie(COOKIE, 'marketplace', {
    maxAge: ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
  });
}

// 'marketplace' | 'direct' — for a request on a store subdomain.
function saleSource(req) {
  if (req.query?.via === 'marketplace' || readCookie(req, COOKIE) === 'marketplace') return 'marketplace';
  return 'direct';
}

// { source, pct } for this request, with the current percentages.
async function feeFor(req) {
  const fees = await getFees();
  const source = saleSource(req);
  return { source, pct: source === 'marketplace' ? fees.marketplace_pct : fees.direct_pct };
}

// The fee on `amount` paise at `pct` percent, in whole paise.
function feeOn(amount, pct) {
  return Math.round((Number(amount) || 0) * (Number(pct) || 0) / 100);
}

module.exports = {
  ATTRIBUTION_DAYS,
  getFees,
  saveFees,
  isAdmin,
  rememberMarketplaceVisit,
  saleSource,
  feeFor,
  feeOn,
};
