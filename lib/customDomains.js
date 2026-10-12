// Custom domains — a creator's own domain (mybrand.com) in place of
// handle.pagezaper.com, the way Shopify and HubSpot connect one:
//
//   1. They type the domain (Dashboard → Domain).
//   2. We show the DNS records: an A record at the domain → this server
//      (the same IPs as SITE_DOMAIN), and www as a CNAME → SITE_DOMAIN.
//   3. "Verify" looks the records up (status 'dns' once they point here).
//   4. HTTPS: Caddy in front of the app gets a free Let's Encrypt
//      certificate the first time the domain is visited — it asks
//      /internal/domain-check first, which only says yes to a domain whose
//      DNS points here (deploy/Caddyfile). "Verify" then fetches
//      https://<domain>/.well-known/pagezaper-domain and, when that comes
//      back with this domain's token, the domain is 'live'.
//   5. Only a live domain replaces handle.pagezaper.com in the store's
//      links (storeUrlFor) — a half-set-up domain never breaks them.
//
// The creator also picks what opens at the root (home_type / home_id): the
// whole store, or one course, event, booking page or payment page. Every
// other page still works under the domain (mybrand.com/course/x, /book,
// /event/y, /pay/z, /<lead magnet>).
//
// Local dev: a domain ending in .localhost (shop.mybrand.localhost — two
// levels, so it isn't read as a handle subdomain) is live straight away;
// browsers send *.localhost to this machine.
const crypto = require('crypto');
const dns = require('dns').promises;
const pool = require('./db');

const TABLE = 'PDZ_custom_domains';
const HOME_TYPES = { store: 'Your store', course: 'A course', event: 'An event', booking: 'A booking page', pay: 'A payment page' };
const CHECK_PATH = '/.well-known/pagezaper-domain';

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        domain VARCHAR(253) NOT NULL,
        token CHAR(32) NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        home_type VARCHAR(10) NOT NULL DEFAULT 'store',
        home_id INT NULL DEFAULT NULL,
        last_error VARCHAR(300) NOT NULL DEFAULT '',
        checked_at TIMESTAMP NULL DEFAULT NULL,
        live_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user (user_id),
        UNIQUE KEY uniq_domain (domain)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

const isDevDomain = (domain) => /\.localhost$/.test(domain);

// "https://www.MyBrand.com/shop" → "mybrand.com". www. is dropped: the
// domain is stored bare and www.<domain> is served too.
function normalizeDomain(raw, siteDomain) {
  let d = String(raw || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
  if (!d) throw inputError('Type your domain, like mybrand.com.');
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/.test(d)) {
    throw inputError('That doesn’t look like a domain — type it like mybrand.com.');
  }
  if (d === siteDomain || d.endsWith(`.${siteDomain}`)) throw inputError(`That’s a ${siteDomain} address — connect a domain you own.`);
  if (d === 'localhost' || (isDevDomain(d) && d.split('.').length < 3)) throw inputError('For local testing use a name like shop.mybrand.localhost.');
  return d;
}

// --- the host → store cache -------------------------------------------------
// Every store request on a domain that isn't ours looks itself up here, and
// storeUrlFor() (synchronous, in every view) needs a handle's live domain —
// so connected domains are kept in memory, reloaded on any change.
let cache = { byDomain: new Map(), liveByUser: new Map(), loadedAt: 0 };
let loading = null;
async function reloadCache() {
  // The JOIN below needs PDZ_users, which is otherwise only created on first
  // signup/login — on a fresh database every request would fail before then.
  await require('./users').ensureUsersTable();
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT d.*, u.handle FROM ${TABLE} d JOIN PDZ_users u ON u.id = d.user_id`,
  );
  const byDomain = new Map();
  const liveByUser = new Map();
  rows.forEach((r) => {
    byDomain.set(r.domain, r);
    if (r.status === 'live') liveByUser.set(r.handle, r.domain);
  });
  cache = { byDomain, liveByUser, loadedAt: Date.now() };
}
function ensureCache() {
  // Refreshed every minute too, for changes made by another process.
  if (!loading || Date.now() - cache.loadedAt > 60000) loading = reloadCache().catch((err) => { loading = null; throw err; });
  return loading;
}

// The connected domain row for a request's host (bare or www.), or null.
// Only domains whose DNS points here (status dns/live) or dev domains answer.
async function lookupHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  await ensureCache();
  const row = cache.byDomain.get(host);
  if (!row) return null;
  return row.status === 'pending' && !isDevDomain(host) ? null : row;
}

// A handle's live custom domain, or null — synchronous, from the cache.
function liveDomainFor(handle) {
  return cache.liveByUser.get(handle) || null;
}

// --- the creator's domain ------------------------------------------------------

async function getDomain(userId) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT * FROM ${TABLE} WHERE user_id = ?`, [userId]);
  return row || null;
}

async function connectDomain(userId, raw, { siteDomain }) {
  await ensureTable();
  const domain = normalizeDomain(raw, siteDomain);
  const [[taken]] = await pool.query(`SELECT user_id FROM ${TABLE} WHERE domain = ?`, [domain]);
  if (taken && taken.user_id !== userId) throw inputError(`${domain} is already connected to another store.`);
  const dev = isDevDomain(domain);
  await pool.query(
    `INSERT INTO ${TABLE} (user_id, domain, token, status, live_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE domain = VALUES(domain), token = VALUES(token), status = VALUES(status),
       last_error = '', checked_at = NULL, live_at = VALUES(live_at)`,
    [userId, domain, crypto.randomBytes(16).toString('hex'), dev ? 'live' : 'pending', dev ? new Date() : null],
  );
  await reloadCache();
  return getDomain(userId);
}

async function disconnectDomain(userId) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE user_id = ?`, [userId]);
  await reloadCache();
}

// What opens at the root. homeId is checked by the caller (it's one of theirs).
async function setHome(userId, homeType, homeId) {
  await ensureTable();
  const type = HOME_TYPES[homeType] ? homeType : 'store';
  await pool.query(`UPDATE ${TABLE} SET home_type = ?, home_id = ? WHERE user_id = ?`, [type, type === 'store' ? null : homeId, userId]);
  await reloadCache();
}

// Where the root of a connected domain goes, as a store path — '/' for the
// store, else the chosen page's current address (looked up each time, so
// renaming a slug doesn't break it). Falls back to the store when the page
// is gone or hidden.
const HOME_LOOKUP = {
  course: { table: 'PDZ_courses', path: (slug) => `/course/${slug}` },
  event: { table: 'PDZ_events', path: (slug) => `/event/${slug}` },
  booking: { table: 'PDZ_booking_services', path: (slug) => `/book/${slug}` },
  pay: { table: 'PDZ_payment_pages', path: (slug) => `/pay/${slug}` },
};
async function homePathFor(row) {
  if (!row || row.home_type === 'store') return '/';
  // A booking home without a service is the booking page listing them all.
  if (row.home_type === 'booking' && !row.home_id) return '/book';
  const look = HOME_LOOKUP[row.home_type];
  if (!look || !row.home_id) return '/';
  try {
    const [[page]] = await pool.query(`SELECT slug FROM ${look.table} WHERE id = ? AND user_id = ?`, [row.home_id, row.user_id]);
    return page ? look.path(page.slug) : '/';
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return '/';
    throw err;
  }
}

// --- verifying -------------------------------------------------------------------

async function resolveSafe(fn, name) {
  try {
    return await fn(name);
  } catch (err) {
    return [];
  }
}

// Does `name` point at this server? Its A records are among SITE_DOMAIN's
// (or SERVER_IP's), or it's a CNAME to SITE_DOMAIN.
async function pointsHere(name, ourIps, siteDomain) {
  const cname = (await resolveSafe(dns.resolveCname, name)).map((c) => c.toLowerCase().replace(/\.$/, ''));
  if (cname.includes(siteDomain)) return { ok: true };
  const ips = await resolveSafe(dns.resolve4, name);
  if (ips.length && ips.every((ip) => ourIps.includes(ip))) return { ok: true };
  return { ok: false, found: cname.length ? `CNAME ${cname.join(', ')}` : ips.length ? `A ${ips.join(', ')}` : 'nothing yet' };
}

// Our public IPs — SERVER_IP (comma-separated) when set, else whatever
// SITE_DOMAIN resolves to.
async function ourServerIps(siteDomain) {
  const fromEnv = String(process.env.SERVER_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return resolveSafe(dns.resolve4, siteDomain);
}

// Checks the domain's DNS, then whether it reaches this app over HTTPS.
// → the updated row, with last_error explaining what's missing.
async function verifyDomain(userId, { siteDomain }) {
  const row = await getDomain(userId);
  if (!row) throw inputError('Connect a domain first.');
  if (isDevDomain(row.domain)) return row;
  const ourIps = await ourServerIps(siteDomain);
  const apex = await pointsHere(row.domain, ourIps, siteDomain);
  let status = 'pending';
  let error = '';
  if (!apex.ok) {
    error = `${row.domain} doesn’t point here yet (found ${apex.found}). DNS changes can take a few minutes, sometimes a few hours.`;
  } else {
    status = 'dns';
    // Saved first: the HTTPS check below comes back in to this app, which
    // only answers for a domain whose DNS is known to point here.
    if (row.status === 'pending') {
      await pool.query(`UPDATE ${TABLE} SET status = 'dns' WHERE id = ?`, [row.id]);
      await reloadCache();
    }
    // Reaching ourselves over HTTPS makes Caddy issue the certificate.
    try {
      const res = await fetch(`https://${row.domain}${CHECK_PATH}`, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      const body = res.ok ? await res.json() : null;
      if (body && body.token === row.token) status = 'live';
      else error = 'DNS is set — the secure (HTTPS) certificate isn’t ready yet. Check again in a minute.';
    } catch (err) {
      error = 'DNS is set — the secure (HTTPS) certificate isn’t ready yet. Check again in a minute.';
    }
  }
  await pool.query(
    `UPDATE ${TABLE} SET status = ?, last_error = ?, checked_at = NOW(), live_at = IF(? = 'live', COALESCE(live_at, NOW()), NULL) WHERE id = ?`,
    [status, error.slice(0, 300), status, row.id],
  );
  await reloadCache();
  return getDomain(userId);
}

// Whether www.<domain> also points here — shown as a tick on the DNS table.
async function wwwPointsHere(domain, { siteDomain }) {
  if (isDevDomain(domain)) return true;
  return (await pointsHere(`www.${domain}`, await ourServerIps(siteDomain), siteDomain)).ok;
}

// For Caddy's on-demand TLS "ask": may we get a certificate for this name?
// Yes for a store subdomain that exists (meera.pagezaper.com — so no
// wildcard certificate is needed), and for a connected domain (or its
// www.) whose DNS points here.
async function mayIssueCertificate(name, { siteDomain }) {
  const host = String(name || '').toLowerCase();
  if (host.endsWith(`.${siteDomain}`)) {
    const sub = host.slice(0, -(siteDomain.length + 1));
    if (!/^[a-z0-9-]+$/.test(sub)) return false;
    const { RESERVED_HANDLES } = require('./storefront');
    if (RESERVED_HANDLES.has(sub)) return sub === 'www';
    const [[user]] = await pool.query('SELECT id FROM PDZ_users WHERE handle = ? LIMIT 1', [sub]);
    return !!user;
  }
  return !!(await lookupHost(host));
}

module.exports = {
  HOME_TYPES, CHECK_PATH,
  normalizeDomain, lookupHost, liveDomainFor, ensureCache, homePathFor,
  getDomain, connectDomain, disconnectDomain, setHome, verifyDomain, wwwPointsHere, mayIssueCertificate, ourServerIps,
};
