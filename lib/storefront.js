// Public stores on subdomains + asset cache-busting, kept out of server.js
// so it's two lines there to wire up:
//
//   const { installStorefront } = require('./lib/storefront');
//   installStorefront(app, { siteName: SITE_NAME, siteDomain: SITE_DOMAIN, port: PORT });
//
// Must be called after the session middleware and before any routes.
//
// meera.pagezaper.com renders Meera's store, and meera.pagezaper.com/:slug
// one of Meera's lead magnets. In local dev the same works on
// meera.localhost:3000 (browsers resolve *.localhost to this machine with no
// hosts-file edits). Anything else — pagezaper.com, www., the VPS's IP —
// falls through to the normal site routes.
const { findUserByHandle } = require('./users');
const { listBlocks, TYPE_LABELS, URL_TYPES } = require('./blocks');
const { createContactFromSource, findExistingContact, updateContact } = require('./contacts');
const { getPublicLeadMagnet, incrementSignupCount, incrementViewCount } = require('./leadMagnets');

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

// A visitor's answer to one of a lead magnet's extra questions, checked
// against the type the merchant picked for it (the public form is
// novalidate, so the browser hasn't checked anything).
function extraAnswerValid(q, value) {
  switch (q.type) {
    case 'number': return /^-?\d+([.,]\d+)?$/.test(value);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'phone': return /^\+?[\d\s().-]{6,}$/.test(value);
    case 'url': return !!safeHref(value) && value.includes('.');
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'dropdown':
    case 'radio': return !(q.options || []).length || q.options.includes(value);
    case 'checkboxes': return !(q.options || []).length || value.split(', ').every((v) => q.options.includes(v));
    case 'checkbox': return value === 'Yes';
    default: return true;
  }
}

// Lightens (positive amount) or darkens a #rrggbb color, channel by channel.
function shadeHex(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  return '#' + [num >> 16, (num >> 8) & 0xff, num & 0xff]
    .map((c) => Math.min(255, Math.max(0, c + amount)).toString(16).padStart(2, '0'))
    .join('');
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

  // Store pages are rendered from the middleware below, which answers
  // before server.js's res.locals middleware ever runs — so the brand
  // strings those views (and error.ejs) print have to be app-wide.
  app.locals.siteName = siteName;
  app.locals.siteDomain = siteDomain;

  // The inline style that themes a lead-magnet page (signup and success)
  // in the magnet's accent from the Design tab — falls back to the site's
  // own blue when a magnet predates the column or wasn't customized.
  app.locals.lmThemeStyle = (magnet) => {
    const accent = /^#[0-9a-f]{6}$/i.test(magnet && magnet.accent_color) ? magnet.accent_color : '#1261ef';
    return `--magnet-accent:${accent}; --magnet-accent-dark:${shadeHex(accent, -60)}; --magnet-accent-light:${shadeHex(accent, 70)};`;
  };

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

  // The link a merchant shares: GET shows the signup form, POST captures
  // the contact into their Audience list and reveals the download.
  async function leadMagnetPage(req, res, owner, slug) {
    const magnet = await getPublicLeadMagnet(owner.id, slug);
    if (!magnet) {
      return res.status(404).render('error', {
        title: `Not found — ${siteName}`,
        heading: 'This link isn’t live',
        message: 'This lead magnet doesn’t exist, or the creator has taken it down.',
      });
    }

    // Name, email and phone are each the merchant's choice (Form tab in the
    // builder) — a field that's switched off is never read, even if posted.
    const name = magnet.collect_name ? String(req.body?.name || '').trim() : '';
    const email = magnet.collect_email ? String(req.body?.email || '').trim() : '';
    const phone = magnet.collect_phone ? String(req.body?.phone || '').trim().slice(0, 30) : '';
    // Answers to the merchant's own extra questions (Form tab in the
    // builder) — keyed by question id, read as q_<id> fields so they never
    // collide with name/email/phone.
    const extra = {};
    for (const q of magnet.extra_questions || []) {
      const raw = req.body?.[`q_${q.id}`];
      extra[q.id] = q.type === 'checkboxes'
        // Several ticked boxes arrive as an array, a single one as a string.
        ? [].concat(raw || []).map((v) => String(v).trim()).filter(Boolean).slice(0, 6).join(', ')
        : String(raw || '').trim().slice(0, 120);
    }
    const form = (status, error) => res.status(status).render('lead-magnet', {
      title: `${magnet.title} — ${owner.name}`,
      owner,
      magnet,
      error,
      values: { name, email, phone, extra },
    });

    if (req.method !== 'POST') {
      // A failed counter update shouldn't cost the visitor the page.
      if (req.method === 'GET') incrementViewCount(magnet.id).catch((err) => console.error('View count failed:', err));
      return form(200, null);
    }
    if (magnet.collect_name && !name) return form(400, 'Add your name to continue.');
    if (magnet.collect_email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return form(400, 'That email address doesn’t look right.');
    // With email off, the phone number is the only way to reach them.
    if (!magnet.collect_email && !phone) return form(400, 'Add your phone number to continue.');
    if (phone && !/^\+?[\d\s().-]{6,}$/.test(phone)) return form(400, 'That phone number doesn’t look right.');
    for (const q of magnet.extra_questions || []) {
      if (q.required && !extra[q.id]) {
        return form(400, q.type === 'checkbox' ? `Tick “${q.label}” to continue.` : `Add an answer for “${q.label}” to continue.`);
      }
      if (extra[q.id] && !extraAnswerValid(q, extra[q.id])) return form(400, `The answer for “${q.label}” doesn’t look right.`);
    }

    // Extra answers ride along in the contact's note — there's no separate
    // column for them, and contacts.js caps note at 300 chars, so this is
    // best-effort: it can end up truncated for a magnet with several long
    // answers, same as a long note typed by hand in Audience would be.
    const extraNote = (magnet.extra_questions || [])
      .filter((q) => extra[q.id])
      .map((q) => `${q.label}: ${extra[q.id]}`)
      .join(' · ');
    const note = extraNote ? `Lead magnet: ${magnet.title} — ${extraNote}` : `Lead magnet: ${magnet.title}`;

    // Matched on email when there is one, on phone only when that's all
    // the form collects.
    const existing = await findExistingContact(owner.id, { email, phone: email ? '' : phone });
    if (!existing) {
      await createContactFromSource(owner.id, {
        // A contact always needs a name — without the name field, fall
        // back to whatever they did give.
        name: name || email || phone,
        email,
        phone,
        note,
        source: 'form',
        sourceId: magnet.id,
        sourceName: magnet.title,
      });
    } else if (phone && !existing.phone) {
      await updateContact(owner.id, existing.id, { phone });
    }
    await incrementSignupCount(magnet.id);

    res.render('lead-magnet-success', {
      title: `You're in — ${siteName}`,
      owner,
      magnet,
    });
  }

  // Lead magnets used to live at pagezaper.com/l/:handle/:slug — links
  // already shared keep working by forwarding to the store subdomain. The
  // handle goes into the hostname, so anything that isn't a plain handle
  // (it could smuggle in another domain) is left to the 404 handler.
  app.all('/l/:handle/:slug', (req, res, next) => {
    const { handle, slug } = req.params;
    if (!/^[a-z0-9]+$/.test(handle) || !/^[a-z0-9-]+$/.test(slug)) return next();
    res.redirect(308, `${storeUrlFor(req, handle)}/${slug}`);
  });

  app.use(async (req, res, next) => {
    const handle = storeHandleFromHost(req.hostname);
    if (!handle) return next();

    const notFound = (message) => res.status(404).render('error', {
      title: `Store not found — ${siteName}`,
      heading: 'Store not found',
      message,
    });

    // A store is its home page plus one page per lead magnet
    // (meera.pagezaper.com/free-checklist); login/dashboard live on the
    // main domain, not on every merchant's subdomain.
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const magnetSlug = (req.path.toLowerCase().match(/^\/([a-z0-9-]+)\/?$/) || [])[1];
    if (!(req.path === '/' && isRead) && !(magnetSlug && (isRead || req.method === 'POST'))) {
      return notFound('The page you’re looking for doesn’t exist.');
    }

    try {
      const owner = await findUserByHandle(handle);
      if (!owner) return notFound(`There’s no store at ${handle}.${siteDomain} yet.`);

      if (magnetSlug) return await leadMagnetPage(req, res, owner, magnetSlug);

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
