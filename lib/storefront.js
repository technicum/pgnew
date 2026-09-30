// Public stores on subdomains + asset cache-busting, kept out of server.js
// so it's two lines there to wire up:
//
//   const { installStorefront } = require('./lib/storefront');
//   installStorefront(app, { siteName: SITE_NAME, siteDomain: SITE_DOMAIN, port: PORT });
//
// Must be called after the session middleware and before any routes.
//
// meera.pagezaper.com renders Meera's store. In local dev the same works on
// meera.localhost:3000 (browsers resolve *.localhost to this machine with no
// hosts-file edits). Anything else — pagezaper.com, www., the VPS's IP —
// falls through to the normal site routes.
const { findUserByHandle } = require('./users');
const { listBlocks, TYPE_LABELS, URL_TYPES } = require('./blocks');

// Handles double as subdomains, so these can never be a store — they're
// the main site or infrastructure names.
const RESERVED_HANDLES = new Set(['www', 'app', 'api', 'admin', 'mail', 'smtp', 'ftp', 'dashboard', 'static', 'cdn', 'help', 'support', 'blog']);

// Link/Video/Social blocks store a URL the merchant typed. Only http(s)
// links are rendered — never javascript: or data: — and a bare
// "instagram.com/x" gets https:// added.
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

function installStorefront(app, { siteName, siteDomain, port }) {
  const baseDomains = [siteDomain, 'localhost'];

  // Behind nginx in production — lets req.hostname/req.protocol reflect
  // what the visitor actually requested (the store subdomain, https).
  app.set('trust proxy', 1);

  // Appended to /css and /js URLs in the views (?v=...) so every restart —
  // i.e. every deploy — gives browsers a new URL. Without it a browser can
  // pair a freshly rendered page with a cached, older script and break.
  // Every view references it, so if this isn't installed every page
  // (including error.ejs) throws "assetVersion is not defined".
  app.locals.assetVersion = Date.now().toString(36);

  function storeHandleFromHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    for (const base of baseDomains) {
      if (!host.endsWith(`.${base}`)) continue;
      const sub = host.slice(0, -(base.length + 1));
      // Only one level deep (a.b.pagezaper.com isn't a store).
      if (!sub || sub.includes('.') || RESERVED_HANDLES.has(sub)) return null;
      return sub;
    }
    return null;
  }

  function isLocalRequest(req) {
    return req.hostname === 'localhost' || req.hostname.endsWith('.localhost');
  }

  // Where a handle's store lives, as seen from this request — so "View
  // live" opens the local store while developing and the real one in
  // production.
  function storeUrlFor(req, handle) {
    if (isLocalRequest(req)) return `http://${handle}.localhost:${port}`;
    return `https://${handle}.${siteDomain}`;
  }

  app.use((req, res, next) => {
    res.locals.storeUrlFor = (handle) => storeUrlFor(req, handle);
    next();
  });

  app.use(async (req, res, next) => {
    const handle = storeHandleFromHost(req.hostname);
    if (!handle) return next();

    const notFound = (message) => res.status(404).render('error', {
      title: `Store not found — ${siteName}`,
      heading: 'Store not found',
      message,
    });

    // A store is a single page for now; login/dashboard live on the main
    // domain, not on every merchant's subdomain.
    if (req.path !== '/' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return notFound('The page you’re looking for doesn’t exist.');
    }

    try {
      const owner = await findUserByHandle(handle);
      if (!owner) return notFound(`There’s no store at ${handle}.${siteDomain} yet.`);

      const blocks = (await listBlocks(owner.id))
        .filter((b) => b.visible && TYPE_LABELS[b.type])
        .map((b) => {
          const href = URL_TYPES.has(b.type) ? safeHref(b.sub) : null;
          return {
            type: b.type,
            label: TYPE_LABELS[b.type],
            title: b.title || TYPE_LABELS[b.type],
            // For URL blocks the raw URL isn't useful text — show the host.
            sub: href ? new URL(href).host.replace(/^www\./, '') : b.sub,
            price: b.price,
            href,
          };
        });

      const initials = owner.name.split(/\s+/).filter(Boolean).slice(0, 2)
        .map((p) => p[0].toUpperCase()).join('') || 'U';

      res.render('store', {
        title: `${owner.name} — ${siteName}`,
        owner: {
          name: owner.name,
          bio: owner.bio || '',
          initials,
          accent: /^#[0-9a-f]{6}$/i.test(owner.accent_color) ? owner.accent_color : '#ff6b4a',
          showBadge: !!owner.show_badge,
        },
        blocks,
        mainSiteUrl: isLocalRequest(req) ? `http://localhost:${port}` : `https://${siteDomain}`,
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { installStorefront, RESERVED_HANDLES };
