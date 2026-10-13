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
// hosts-file edits). A creator's own connected domain (mybrand.com —
// lib/customDomains.js) serves their store the same way, its root opening
// whichever page they chose. Anything else — pagezaper.com, www., the
// VPS's IP — falls through to the normal site routes.
const { findUserByHandle } = require('./users');
const { listBlocks, TYPE_LABELS, URL_TYPES } = require('./blocks');
const { createContactFromSource, findExistingContact, updateContact } = require('./contacts');
const { getPublicLeadMagnet, incrementSignupCount, incrementViewCount } = require('./leadMagnets');
const { matchPaymentPath, handlePaymentRequest } = require('./paymentStorefront');
const { matchAccountPath, handleAccountRequest } = require('./customerAccount');
const { matchAppPath, handleAppRequest } = require('./appStorefront');
const { getSettings: getBookingSettings, listPublicServices } = require('./bookings');
const { rememberMarketplaceVisit } = require('./platform');
const customDomains = require('./customDomains');
// Link/Video/Social blocks store a URL the merchant typed — safeHref only
// lets http(s) ones through.
const { safeHref, socialLinks } = require('./socials');
const { storeView } = require('./storeSettings');

// Handles double as subdomains, so these can never be a store — they're
// the main site or infrastructure names.
const RESERVED_HANDLES = new Set(['www', 'app', 'api', 'admin', 'mail', 'smtp', 'ftp', 'dashboard', 'static', 'cdn', 'help', 'support', 'blog']);

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

// The store's popups, each opened by its own link (views/store.ejs).
const POPUP_HASH = /^#(subscribe|form|video|reviews)-\d+$/;

// A YouTube or Vimeo page URL → the player to put in the video popup
// (no-cookie YouTube) and a thumbnail for the card. Anything else: null.
function videoEmbed(href) {
  let url;
  try { url = new URL(href); } catch (err) { return null; }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/) || [])[1];
  }
  if (id && /^[\w-]{6,20}$/.test(id)) {
    return {
      src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      provider: 'YouTube',
    };
  }
  const vimeo = host === 'vimeo.com' && url.pathname.match(/^\/(\d{5,12})/);
  if (vimeo) return { src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1`, thumb: null, provider: 'Vimeo' };
  return null;
}

// What views/store.ejs is rendered with — the store home, and the store
// builder's live preview (lib/livePreview.js). `blocks`: the owner's
// blocks in order; hidden ones and unknown types are left out here.
// `signup`: how a newsletter block's form post went ({ blockId, ok,
// message }), shown in that block's form.
async function storeLocals(owner, blocks, { siteName, mainSiteUrl, signup = null, origin = '' }) {
  const visibleBlocks = blocks.filter((b) => b.visible && TYPE_LABELS[b.type]);
  // "Booking" blocks open the booking page (/book, lib/appStorefront.js)
  // when it's switched on and has a service to book.
  let bookingHref = null;
  if (visibleBlocks.some((b) => b.type === 'booking')) {
    const [settings, services] = await Promise.all([getBookingSettings(owner.id), listPublicServices(owner.id)]);
    if (settings.listing_visible && services.length) bookingHref = '/book';
  }
  const allSocials = socialLinks(owner.socials);
  const shown = visibleBlocks.map((b) => {
    // A Link block can also open one of the store's popups (#subscribe-12,
    // #form-4, #video-9).
    const popupLink = b.type === 'link' && POPUP_HASH.test(String(b.sub || '').trim());
    const href = popupLink ? b.sub.trim()
      : URL_TYPES.has(b.type) ? safeHref(b.sub) : b.type === 'booking' ? bookingHref : null;
    return {
      id: b.id,
      type: b.type,
      label: TYPE_LABELS[b.type],
      // A testimonials block's heading is optional — no "Testimonial" stand-in.
      title: b.title || (b.type === 'testimonial' ? '' : TYPE_LABELS[b.type]),
      // For URL blocks the raw URL isn't useful text — show the host.
      sub: popupLink ? '' : href && URL_TYPES.has(b.type) ? new URL(href).host.replace(/^www\./, '') : b.sub,
      price: b.price,
      // Testimonials: entries with a quote. Form: fields with a label, each
      // keeping its place in the saved list (its input is f_<index>).
      items: b.type === 'form'
        ? (b.items || []).map((item, index) => ({ ...item, index })).filter((item) => item.label.trim())
        : (b.items || []).filter((item) => item.quote && item.quote.trim()),
      // A YouTube or Vimeo video plays in a popup; any other link stays a link.
      embed: b.type === 'video' && href ? videoEmbed(href) : null,
      // Social links: the profile's icons, minus any switched off in this
      // module. (An older Social block holding one URL stays a link card.)
      socials: b.type === 'social' && !href
        ? allSocials.filter((link) => !(b.items || []).some((i) => i.platform === link.id && !i.on))
        : null,
      href,
    };
  });
  const initials = owner.name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('') || 'U';
  return {
    title: `${owner.name} — ${siteName}`,
    owner: {
      name: owner.name,
      bio: owner.bio || '',
      initials,
      accent: /^#[0-9a-f]{6}$/i.test(owner.accent_color) ? owner.accent_color : '#ff6b4a',
      showBadge: !!owner.show_badge,
      socials: allSocials,
    },
    store: storeView(owner.store_settings, { origin }),
    pageUrl: origin ? `${origin}/` : '',
    blocks: shown,
    signup,
    mainSiteUrl,
  };
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
  // A store with a live custom domain is linked there instead.
  function storeUrlFor(req, handle) {
    const own = customDomains.liveDomainFor(handle);
    if (isLocalRequest(req)) return own && own.endsWith('.localhost') ? `http://${own}:${port}` : `http://${handle}.localhost:${port}`;
    return own && !own.endsWith('.localhost') ? `https://${own}` : `https://${handle}.${siteDomain}`;
  }

  // Load connected domains now, so the first requests' links are right.
  customDomains.ensureCache().catch((err) => console.error('Loading custom domains failed:', err.message));

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

  // A newsletter block's form on the store home posts here (POST /): the
  // visitor lands in the merchant's Audience, grouped under the block's
  // title. Success redirects back to the store so a refresh can't post twice.
  async function newsletterSignup(req, res, owner, blocks, renderStore) {
    const blockId = Number(req.body?.block);
    const block = blocks.find((b) => b.id === blockId && b.type === 'newsletter' && b.visible);
    if (!block) return renderStore(400, null);
    const email = String(req.body?.email || '').trim().slice(0, 255);
    const name = String(req.body?.name || '').trim().slice(0, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return renderStore(400, { blockId, ok: false, message: 'That email address doesn’t look right.', email, name });
    }
    const title = block.title || 'Newsletter';
    const existing = await findExistingContact(owner.id, { email, phone: '' });
    if (!existing) {
      await createContactFromSource(owner.id, {
        name: name || email,
        email,
        phone: '',
        note: '',
        source: 'newsletter',
        sourceId: block.id,
        sourceName: title,
      });
    }
    res.redirect(303, `/?subscribed=${block.id}#subscribe-${block.id}`);
  }

  // A Form block's popup posts here too (POST / with form=<id>). The
  // fields are the merchant's own (lib/blocks.js), read as f_<index>. The
  // sender lands in Audience under the form's title with their answers in
  // the note; someone already there gets the new answers added to the
  // front of their note (it's capped at 300 characters, so the oldest
  // answers fall off the end).
  async function formSubmit(req, res, owner, blocks, renderStore) {
    const blockId = Number(req.body?.form);
    const block = blocks.find((b) => b.id === blockId && b.type === 'form' && b.visible);
    if (!block) return renderStore(400, null);
    const fields = block.items.map((field, index) => ({ ...field, index })).filter((f) => f.label.trim());
    const values = {};
    for (const f of fields) {
      values[f.index] = String(req.body?.[`f_${f.index}`] || '').trim().slice(0, f.kind === 'textarea' ? 1000 : 200);
    }
    const fail = (message) => renderStore(400, { blockId, ok: false, message, values });
    for (const f of fields) {
      const v = values[f.index];
      if (f.required && !v) return fail(`Fill in “${f.label}” to send this.`);
      if (!v) continue;
      if (f.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail(`Check “${f.label}” — that doesn’t look like an email address.`);
      if (f.kind === 'phone' && !/^\+?[\d\s().-]{6,}$/.test(v)) return fail(`Check “${f.label}” — that doesn’t look like a phone number.`);
      if (f.kind === 'number' && !/^-?\d+([.,]\d+)?$/.test(v)) return fail(`${f.label} needs to be a number.`);
    }
    // Who it's from: the first email and phone answers, and a name from a
    // field labelled like one.
    const first = (kind) => (fields.find((f) => f.kind === kind && values[f.index]) || {}).index;
    const email = first('email') !== undefined ? values[first('email')] : '';
    const phone = first('phone') !== undefined ? values[first('phone')].slice(0, 30) : '';
    if (!email && !phone) {
      return fail(fields.some((f) => f.kind === 'email' || f.kind === 'phone')
        ? `Add your email or phone so ${owner.name} can reply.`
        : 'This form can’t take replies yet.');
    }
    const nameField = fields.find((f) => f.kind === 'text' && /name/i.test(f.label) && values[f.index]);
    const name = nameField ? values[nameField.index] : (email || phone);
    const title = block.title || 'Form';
    const answers = fields
      .filter((f) => values[f.index] && f !== nameField && f.kind !== 'email' && f.kind !== 'phone')
      .map((f) => `${f.label}: ${values[f.index]}`)
      .join(' · ');
    const note = answers ? `${title} — ${answers}` : title;

    const existing = await findExistingContact(owner.id, { email, phone: email ? '' : phone });
    if (!existing) {
      await createContactFromSource(owner.id, {
        name, email, phone, note,
        source: 'storeform',
        sourceId: block.id,
        sourceName: title,
      });
    } else {
      const update = { note: existing.note ? `${note} | ${existing.note}` : note };
      if (phone && !existing.phone) update.phone = phone;
      await updateContact(owner.id, existing.id, update);
    }
    res.redirect(303, `/?sent=${block.id}#form-${block.id}`);
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
    let handle = storeHandleFromHost(req.hostname);
    // Not one of our subdomains — maybe a creator's own domain.
    let custom = null;
    if (!handle) {
      try {
        custom = await customDomains.lookupHost(req.hostname);
      } catch (err) {
        return next(err);
      }
      if (!custom) return next();
      handle = custom.handle;
      // "Verify" fetching itself over HTTPS (lib/customDomains.js).
      if (req.path === customDomains.CHECK_PATH) return res.json({ domain: custom.domain, token: custom.token });
      // The root opens the page they chose — a course, an event, a booking
      // page, a payment page — as if it had been asked for by its path.
      if (req.path === '/' && (req.method === 'GET' || req.method === 'HEAD') && custom.home_type !== 'store') {
        try {
          const home = await customDomains.homePathFor(custom);
          if (home !== '/') req.url = home + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
        } catch (err) {
          return next(err);
        }
      }
    }
    if (!handle) return next();

    const notFound = (message) => res.status(404).render('error', {
      title: `Store not found — ${siteName}`,
      heading: 'Store not found',
      message,
    });

    // A store is its home page plus one page per lead magnet
    // (meera.pagezaper.com/free-checklist); login/dashboard live on the
    // main domain, not on every merchant's subdomain.
    // Payment pages live under /pay/ (lib/paymentStorefront.js) so their
    // slugs never collide with a lead magnet's. Buyer sign-in and saved
    // addresses are under /account/ (lib/customerAccount.js). Bookings,
    // events and courses are under /book/, /event/ and /course/
    // (lib/appStorefront.js).
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    // Arrived from /explore: sales here count as marketplace sales (lib/platform.js).
    if (isRead) rememberMarketplaceVisit(req, res);
    const magnetSlug = (req.path.toLowerCase().match(/^\/([a-z0-9-]+)\/?$/) || [])[1];
    const payment = matchPaymentPath(req);
    const account = matchAccountPath(req);
    const appRoute = matchAppPath(req);
    const isHome = req.path === '/';
    if (!(isHome && (isRead || req.method === 'POST')) && !(magnetSlug && (isRead || req.method === 'POST')) && !payment && !account && !appRoute) {
      return notFound('The page you’re looking for doesn’t exist.');
    }

    try {
      const owner = await findUserByHandle(handle);
      if (!owner) return notFound(`There’s no store at ${handle}.${siteDomain} yet.`);
      // Suspended by an admin: the store and everything on it is offline.
      if (owner.status === 'suspended') return notFound('This store isn’t available right now.');

      if (payment) return await handlePaymentRequest(req, res, owner, payment, { siteName });
      if (account) return await handleAccountRequest(req, res, owner, account, { siteName });
      if (appRoute) return await handleAppRequest(req, res, owner, appRoute, { siteName });
      if (magnetSlug) return await leadMagnetPage(req, res, owner, magnetSlug);

      const blocks = await listBlocks(owner.id);
      const renderStore = (status, signup) => storeLocals(owner, blocks, {
        siteName,
        mainSiteUrl: isLocalRequest(req) ? `http://localhost:${port}` : `https://${siteDomain}`,
        signup,
        origin: `${req.protocol}://${req.get('host')}`,
      }).then((locals) => res.status(status).render('store', locals));

      if (req.method === 'POST') {
        if (req.body && req.body.form !== undefined) return await formSubmit(req, res, owner, blocks, renderStore);
        return await newsletterSignup(req, res, owner, blocks, renderStore);
      }
      // Back from a signup or a form (post/redirect/get, so a refresh doesn't post again).
      const subscribed = Number(req.query.subscribed);
      const sent = Number(req.query.sent);
      let signup = null;
      if (Number.isInteger(subscribed) && blocks.some((b) => b.id === subscribed)) {
        signup = { blockId: subscribed, ok: true, message: 'You’re subscribed — thanks for signing up!' };
      } else if (Number.isInteger(sent) && blocks.some((b) => b.id === sent && b.type === 'form')) {
        signup = { blockId: sent, ok: true, message: `Sent! ${owner.name} will get back to you soon.` };
      }
      await renderStore(200, signup);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { installStorefront, RESERVED_HANDLES, storeLocals };
