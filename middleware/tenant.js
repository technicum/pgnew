// Resolves which store (if any) the current request belongs to, based on
// the subdomain of the Host header.
//
//   pagezaper.com          -> req.store = null      (the platform/marketing site)
//   www.pagezaper.com      -> req.store = null      (same, "www" is not a store)
//   admin.pagezaper.com    -> req.store = null, req.isAdminPortal = true
//                              (the single staff login gateway — "admin" is a
//                              reserved subdomain, see RESERVED_SUBDOMAINS,
//                              so no store can ever collide with it)
//   acme.pagezaper.com     -> req.store = the "acme" store row (or null + req.unknownSubdomain
//                              if no such store exists / it's suspended)
//
// BASE_DOMAIN is configurable via env so this works both in local dev
// (BASE_DOMAIN=localhost, tested with `curl -H "Host: demo.localhost:3000" ...`)
// and in production (BASE_DOMAIN=pagezaper.com).

const { TABLES } = require('../db/database');

function getBaseDomain() {
  return (process.env.BASE_DOMAIN || 'localhost').toLowerCase();
}

function resolveStore(pool) {
  const baseDomain = getBaseDomain();

  return async (req, res, next) => {
    try {
      const hostHeader = (req.headers.host || '').toLowerCase();
      const hostname = hostHeader.split(':')[0]; // strip port

      req.baseDomain = baseDomain;
      req.store = null;
      req.unknownSubdomain = null;
      req.isRootDomain = true;
      req.isAdminPortal = false;

      let subdomain = null;
      if (hostname === baseDomain || hostname === `www.${baseDomain}`) {
        subdomain = null;
      } else if (hostname.endsWith(`.${baseDomain}`)) {
        subdomain = hostname.slice(0, hostname.length - baseDomain.length - 1);
        // Only treat a single-label prefix as a store subdomain; anything
        // with extra dots (nested subdomains) falls back to the root site.
        if (subdomain.includes('.')) subdomain = null;
      }

      if (subdomain === 'admin') {
        req.isRootDomain = false;
        req.isAdminPortal = true;
      } else if (subdomain) {
        req.isRootDomain = false;
        const [[store]] = await pool.query(
          `SELECT * FROM ${TABLES.stores} WHERE subdomain = ? LIMIT 1`,
          [subdomain]
        );
        if (store && store.status === 'active') {
          req.store = store;
        } else {
          req.unknownSubdomain = subdomain;
        }
      }

      res.locals.store = req.store;
      res.locals.baseDomain = baseDomain;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Builds an absolute URL pointing at a given store's subdomain, preserving
// the current protocol and (in dev) port.
function storeUrl(req, subdomain, path = '/') {
  const baseDomain = req.baseDomain || getBaseDomain();
  const hostHeader = req.headers.host || baseDomain;
  const port = hostHeader.includes(':') ? `:${hostHeader.split(':')[1]}` : '';
  return `${req.protocol}://${subdomain}.${baseDomain}${port}${path}`;
}

// Builds an absolute URL pointing back at the root (platform) domain.
function rootUrl(req, path = '/') {
  const baseDomain = req.baseDomain || getBaseDomain();
  const hostHeader = req.headers.host || baseDomain;
  const port = hostHeader.includes(':') ? `:${hostHeader.split(':')[1]}` : '';
  return `${req.protocol}://${baseDomain}${port}${path}`;
}

// Builds an absolute URL pointing at the admin portal (admin.<baseDomain>) —
// the single login gateway for store staff (Admin/Manager), regardless of
// which store's subdomain, the root marketing domain, or another store's
// subdomain the request came from. Every "log in" link in the app should
// point here.
function adminPortalUrl(req, path = '/') {
  const baseDomain = req.baseDomain || getBaseDomain();
  const hostHeader = req.headers.host || baseDomain;
  const port = hostHeader.includes(':') ? `:${hostHeader.split(':')[1]}` : '';
  return `${req.protocol}://admin.${baseDomain}${port}${path}`;
}

module.exports = { resolveStore, storeUrl, rootUrl, adminPortalUrl, getBaseDomain };
