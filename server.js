// PageZaper server entrypoint — homepage + signup/login/dashboard, on the
// same stack as before (Node/Express + EJS views, public/ served statically).
//
// Loads .env the same way PageZaper's server.js did — the VPS's nginx
// forwards pagezaper.com to a specific port (PORT=3001 in production's
// .env), and without this the app falls back to its 3000 default while
// nginx still points at 3001, which is a silent 503 (nginx can't reach
// anything on 3001) rather than a crash you'd see in the logs.
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const {
  findUserByEmail,
  findUserById,
  createUser,
  verifyPassword,
  toPublicUser,
  updateProfile,
  updateStoreSettings,
  updateDesign,
  isSuspended,
} = require('./lib/users');
const {
  listBlocks,
  createBlock,
  updateBlock,
  reorderBlocks,
  deleteBlock,
  duplicateBlock,
  starterFor,
  TYPES: BLOCK_TYPES,
} = require('./lib/blocks');
const {
  listContacts,
  countContacts,
  createContact,
  updateContact,
  deleteContact,
} = require('./lib/contacts');
const {
  listLeadMagnets,
  createLeadMagnet,
  updateLeadMagnet,
  deleteLeadMagnet,
} = require('./lib/leadMagnets');
const { saveUpload, UPLOAD_TYPES, MAX_UPLOAD_BYTES } = require('./lib/uploads');
const {
  listPaymentPages,
  getPaymentPage,
  formatINR,
  createPaymentPage,
  updatePaymentPage,
  deletePaymentPage,
  listCoupons,
  createCoupon,
  setCouponActive,
  deleteCoupon,
} = require('./lib/paymentPages');
const { listAbandoned, dismissDraft } = require('./lib/checkoutDrafts');
const { abandonedView, markContacted, dismissAbandoned, ABANDONED_AFTER_MINUTES } = require('./lib/abandoned');
const customDomains = require('./lib/customDomains');
const { APPS, APP_BY_ID, installedApps, setAppInstalled, appForPath } = require('./lib/apps');
const { listOrders, orderStatsByPage, pageAnalytics, getOrder, markOrderPaid, markOrderShipped, cancelOrder } = require('./lib/orders');
const { paymentMode, handleCashfreeWebhook, handleRazorpayWebhook, loadGatewaySettings } = require('./lib/payments');
const { listItems, TYPES: MARKET_TYPES } = require('./lib/marketplace');
const { isAdmin } = require('./lib/platform');
const { installStorefront } = require('./lib/storefront');
const { installAppDashboards } = require('./lib/appDashboard');
const { PLATFORMS: SOCIAL_PLATFORMS, normalizeSocials } = require('./lib/socials');
const { normalizeStoreSettings, LIMITS: STORE_LIMITS } = require('./lib/storeSettings');
const { userMedia, deleteUserMedia } = require('./lib/adminMedia');
const { installAdmin } = require('./lib/adminRoutes');
const { metaFor } = require('./lib/seo');
const blog = require('./lib/blog');
const appIdeas = require('./lib/appIdeas');
const { installLivePreview } = require('./lib/livePreview');
const { MySQLSessionStore } = require('./lib/sessionStore');
const { installGoogleAuth } = require('./lib/googleAuth');

const app = express();
// Falls back to 3000 when PORT isn't set in the environment (e.g. local dev
// with no .env file at all).
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
// Only the builder's fetch()-based endpoints send JSON bodies — everything
// else (signup/login) still posts as a normal HTML form.
// The raw bytes are kept for the payment webhooks' signature checks.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Cashfree payment events (lib/payments.js) — signed, no session needed.
app.post('/webhooks/cashfree', (req, res, next) => handleCashfreeWebhook(req, res).catch(next));
// Razorpay payment events (lib/razorpay.js; keys and webhook secrets set at /admin/payments).
app.post('/webhooks/razorpay', (req, res, next) => handleRazorpayWebhook(req, res).catch(next));

app.use(session({
  // Falls back to a fixed dev secret so `node server.js` works with no
  // .env at all; set SESSION_SECRET in production's .env for real signing.
  secret: process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-in-production',
  // Kept in MySQL so a restart/deploy doesn't log everyone out.
  store: new MySQLSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  },
}));

// Brand strings, kept in one place so a future rename is a one-line
// change instead of hunting through views/*.ejs.
const SITE_NAME = 'PageZaper';
const SITE_DOMAIN = 'pagezaper.com';

// Store subdomains, trust proxy, assetVersion and storeUrlFor for views.
installStorefront(app, { siteName: SITE_NAME, siteDomain: SITE_DOMAIN, port: PORT });

// "Continue with Google" on login/signup (lib/googleAuth.js) — only when
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set.
installGoogleAuth(app, { siteName: SITE_NAME });

// Makes siteName/siteDomain available in every view without passing them
// explicitly on every res.render call.
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  res.locals.siteDomain = SITE_DOMAIN;
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = isAdmin(req.session.user);
  next();
});

const SELLING_APPS = ['payment-pages', 'courses', 'bookings'];
const ABANDONED_NAV = {
  href: '/dashboard/abandoned',
  label: 'Abandoned carts',
  icon: '<circle cx="8" cy="21" r="1"></circle><circle cx="19" cy="21" r="1"></circle><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"></path>',
};

// Apps (lib/apps.js): every dashboard page knows which apps are added (the
// sidebar lists them), and an app's own routes only open once it's added —
// otherwise the page sends you to Explore apps to add it.
app.use('/dashboard', async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const installed = await installedApps(req.session.user.id);
    res.locals.installedApps = installed;
    const nav = APPS.filter((a) => installed.includes(a.id)).flatMap((a) => a.nav);
    // Abandoned carts (lib/abandoned.js) span every app that sells, so it
    // shows once, after Orders, when any of them is added.
    if (installed.some((x) => SELLING_APPS.includes(x))) {
      const at = nav.findIndex((n) => n.href === '/dashboard/orders');
      nav.splice(at >= 0 ? at + 1 : nav.length, 0, ABANDONED_NAV);
    }
    res.locals.appNav = nav;
    const needs = appForPath(req.baseUrl + req.path);
    if (!needs || needs.core || installed.includes(needs.id)) return next();
    if (req.method === 'GET') return res.redirect(`/dashboard/apps?add=${needs.id}`);
    return res.status(403).json({ error: `Add the ${needs.name} app first (Explore apps).` });
  } catch (err) {
    next(err);
  }
});

const SUSPENDED_MESSAGE = 'This account has been suspended. If you think this is a mistake, contact support.';

function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

// Signed in — and not suspended (Platform admin → Users). A suspended
// account is signed out on its next request.
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  isSuspended(req.session.user.id).then((suspended) => {
    if (!suspended) return next();
    req.session.destroy(() => {
      if (req.accepts(['html', 'json']) === 'json') return res.status(401).json({ error: 'This account has been suspended.' });
      res.redirect('/login?suspended=1');
    });
  }).catch(next);
}

app.get('/', async (req, res, next) => {
  try {
    // The marketplace's newest listings, under the homepage search.
    const featured = (await listItems()).slice(0, 8);
    res.render('index', {
      title: `${SITE_NAME} — The Creator Business Toolkit`,
      featured,
      seo: await metaFor('home', { siteName: SITE_NAME, origin: originOf(req) }),
    });
  } catch (err) {
    next(err);
  }
});

// About: what PageZaper is, who builds it, how to get in touch (views/about.ejs).
app.get('/about', async (req, res, next) => {
  try {
    res.render('about', { title: `About — ${SITE_NAME}`, seo: await metaFor('about', { siteName: SITE_NAME, origin: originOf(req) }) });
  } catch (err) {
    next(err);
  }
});

// The marketplace (lib/marketplace.js): everything creators chose to list.
app.get('/explore', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const type = MARKET_TYPES[req.query.type] ? req.query.type : '';
    const all = await listItems({ q });
    const counts = Object.fromEntries(Object.keys(MARKET_TYPES).map((t) => [t, all.filter((i) => i.type === t).length]));
    const items = (type ? all.filter((i) => i.type === type) : all).slice(0, 120);
    // Just browsing (no search, no kind picked): a row per kind.
    const sections = !q && !type
      ? Object.keys(MARKET_TYPES).map((t) => ({ type: t, label: MARKET_TYPES[t], items: all.filter((i) => i.type === t).slice(0, 8), count: counts[t] })).filter((s) => s.items.length)
      : null;
    const seo = await metaFor('explore', { siteName: SITE_NAME, origin: originOf(req) });
    // A search page is its own thing; the canonical stays the main Explore page.
    if (q) seo.title = `${q} — Explore — ${SITE_NAME}`;
    res.render('explore', {
      seo,
      title: `${q ? `${q} — ` : ''}Explore — ${SITE_NAME}`,
      q, type, types: MARKET_TYPES, counts, total: all.length, items, sections,
    });
  } catch (err) {
    next(err);
  }
});

// This request's site address (https://pagezaper.com) — for canonical
// links, link-preview images and the sitemap.
function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// The blog (lib/blog.js; written in Platform admin → Blog).
app.get('/blog', async (req, res, next) => {
  try {
    const result = await blog.listPublished({ page: req.query.page });
    const seo = await metaFor('blog', { siteName: SITE_NAME, origin: originOf(req) });
    if (result.page > 1) seo.url += `?page=${result.page}`;
    res.render('blog', { title: seo.title, seo, ...result });
  } catch (err) {
    next(err);
  }
});

app.get('/blog/:slug', async (req, res, next) => {
  try {
    // Admins can open drafts and scheduled posts (?preview=1, from the editor).
    const preview = req.query.preview === '1' && isAdmin(req.session.user);
    const post = await blog.getPostBySlug(req.params.slug, { includeDrafts: preview });
    if (!post) return res.status(404).render('error', { title: `Not found — ${SITE_NAME}`, heading: 'Post not found', message: 'That post doesn’t exist, or isn’t published yet.' });
    const origin = originOf(req);
    const image = post.share_image || post.cover_url;
    const seo = {
      title: post.seo_title || `${post.title} — ${SITE_NAME}`,
      description: post.seo_description || post.excerpt,
      image: image && image.startsWith('/') ? origin + image : image,
      url: `${origin}/blog/${post.slug}`,
      type: 'article',
    };
    const more = (await blog.listPublished()).posts.filter((p) => p.id !== post.id).slice(0, 3);
    res.render('blog-post', { title: seo.title, seo, post, more, preview: !post.live });
  } catch (err) {
    next(err);
  }
});

// For search engines: the platform's public pages and every live blog post.
// Creators' stores live on their own subdomains, which aren't listed here.
app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const origin = originOf(req);
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const urls = ['/', '/explore', '/about', '/blog'].map((u) => `<url><loc>${esc(origin + u)}</loc></url>`);
    (await blog.sitemapPosts()).forEach((p) => {
      urls.push(`<url><loc>${esc(`${origin}/blog/${p.slug}`)}</loc><lastmod>${new Date(p.updated_at).toISOString().slice(0, 10)}</lastmod></url>`);
    });
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  } catch (err) {
    next(err);
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /dashboard',
    'Disallow: /admin',
    'Disallow: /login',
    'Disallow: /signup',
    '',
    `Sitemap: ${originOf(req)}/sitemap.xml`,
    '',
  ].join('\n'));
});

// Platform admin panel (lib/adminRoutes.js). ADMIN_EMAILS only.
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!isAdmin(req.session.user)) return res.status(404).render('error', { title: `Not found — ${SITE_NAME}`, heading: 'Page not found', message: 'This page doesn’t exist.' });
  next();
}

// The admin panel itself: overview, users, plans, fees, media.
installAdmin(app, { requireAdmin, siteName: SITE_NAME });

app.get('/signup', redirectIfLoggedIn, (req, res) => {
  res.render('signup', {
    title: `Create your store — ${SITE_NAME}`,
    error: null,
    values: { name: '', email: '' },
  });
});

app.post('/signup', redirectIfLoggedIn, async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  const rerender = (error) => res.status(400).render('signup', {
    title: `Create your store — ${SITE_NAME}`,
    error,
    values: { name, email },
  });

  if (!name || !email || !password) return rerender('Fill in your name, email and a password to continue.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rerender('That email address doesn’t look right.');
  if (password.length < 8) return rerender('Use at least 8 characters for your password.');
  if (password !== confirm) return rerender('Those passwords don’t match.');

  try {
    await createUser({ name, email, password });
    // Deliberately not logging them in here — signup just confirms the
    // account was created and sends them to log in with it, rather than
    // starting a session automatically.
    res.render('signup-success', {
      title: `Account created — ${SITE_NAME}`,
    });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return rerender('An account with that email already exists — try logging in instead.');
    console.error('Signup failed:', err);
    rerender('Something went wrong creating your account. Please try again.');
  }
});

app.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('login', {
    title: `Log in — ${SITE_NAME}`,
    error: req.query.suspended ? SUSPENDED_MESSAGE : null,
    values: { email: '' },
  });
});

app.post('/login', redirectIfLoggedIn, async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  const rerender = (error) => res.status(400).render('login', {
    title: `Log in — ${SITE_NAME}`,
    error,
    values: { email },
  });

  if (!email || !password) return rerender('Enter your email and password.');

  try {
    const user = await findUserByEmail(email);
    const ok = user && await verifyPassword(user, password);
    if (!ok) return rerender('That email and password don’t match an account.');
    if (user.status === 'suspended') return rerender(SUSPENDED_MESSAGE);

    req.session.user = toPublicUser(user);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login failed:', err);
    rerender('Something went wrong logging you in. Please try again.');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  const today = new Date();
  res.render('dashboard', {
    title: `Overview — ${SITE_NAME}`,
    user,
    todayLabel: today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
  });
});

// --- Store builder ----------------------------------------------------
// The builder page itself is a normal render (needs the user's full
// profile row, not just what's in the session). Every action inside it
// (add/edit/delete/duplicate/reorder a block, save profile, save design)
// is a fetch() call against the JSON endpoints below — nothing here does
// a full page reload. Every endpoint re-checks requireAuth and scopes its
// query to req.session.user.id, so one merchant can never touch another
// merchant's blocks or profile even by guessing an id.

// Explore apps: the Store (always on) and the apps a creator can add.
app.get('/dashboard/apps', requireAuth, async (req, res, next) => {
  try {
    res.render('apps', {
    title: `Explore apps — ${SITE_NAME}`,
    user: req.session.user,
    apps: APPS,
    installed: res.locals.installedApps || [],
    // Arriving from an app's page before adding it: that app is highlighted.
    highlight: APP_BY_ID.has(req.query.add) ? req.query.add : null,
    ideas: await appIdeas.listMyIdeas(req.session.user.id),
    ideaCategories: appIdeas.CATEGORIES,
    ideaSent: req.query.idea === 'sent',
    ideaError: req.query.idea_error ? String(req.query.idea_error).slice(0, 200) : null,
    });
  } catch (err) {
    next(err);
  }
});

// "Suggest an app" on Explore apps (lib/appIdeas.js) — admins see them in
// Platform admin → App ideas.
app.post('/dashboard/app-ideas', requireAuth, async (req, res, next) => {
  try {
    await appIdeas.submitIdea(req.session.user.id, req.body || {});
    res.redirect(303, '/dashboard/apps?idea=sent#ideas');
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.redirect(303, `/dashboard/apps?idea_error=${encodeURIComponent(err.message)}#ideas`);
    next(err);
  }
});

// Turn an app on or off — the switch on its Explore apps card. The page's
// script sends it with fetch() and gets JSON back; without the script it's
// a plain form post that comes back to Explore apps.
app.post('/dashboard/apps/:id', requireAuth, async (req, res, next) => {
  const app_ = APP_BY_ID.get(req.params.id);
  if (!app_ || app_.core) return res.redirect(303, '/dashboard/apps');
  try {
    const add = req.body.action !== 'remove';
    await setAppInstalled(req.session.user.id, app_.id, add);
    if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true, id: app_.id, on: add });
    res.redirect(303, '/dashboard/apps');
  } catch (err) {
    next(err);
  }
});

app.get('/dashboard/builder', requireAuth, async (req, res, next) => {
  try {
    const [user, blocks] = await Promise.all([
      findUserById(req.session.user.id),
      listBlocks(req.session.user.id),
    ]);
    if (!user) return res.redirect('/login');
    res.render('builder', {
      title: `Build your store — ${SITE_NAME}`,
      user,
      blocks,
      socialPlatforms: SOCIAL_PLATFORMS,
      socials: normalizeSocials(user.socials),
      settings: normalizeStoreSettings(user.store_settings),
      limits: STORE_LIMITS,
      // New blocks are added on screen and created on Save (public/js/builder.js).
      starters: Object.fromEntries([...BLOCK_TYPES].map((type) => [type, starterFor(type)])),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/builder/blocks', requireAuth, async (req, res) => {
  try {
    const type = req.body && req.body.type;
    if (!BLOCK_TYPES.has(type)) return res.status(400).json({ error: 'Unknown block type.' });
    const block = await createBlock(req.session.user.id, { type });
    res.status(201).json(block);
  } catch (err) {
    console.error('Create block failed:', err);
    res.status(500).json({ error: 'Could not add that block. Please try again.' });
  }
});

app.patch('/dashboard/builder/blocks/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid block id.' });
    const { title, sub, price, visible, items } = req.body || {};
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (sub !== undefined) fields.sub = sub;
    if (price !== undefined) fields.price = price;
    if (visible !== undefined) fields.visible = visible;
    if (Array.isArray(items)) fields.items = items;
    await updateBlock(req.session.user.id, id, fields);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update block failed:', err);
    res.status(500).json({ error: 'Could not save that change. Please try again.' });
  }
});

app.post('/dashboard/builder/blocks/reorder', requireAuth, async (req, res) => {
  try {
    const order = Array.isArray(req.body && req.body.order) ? req.body.order.map(Number).filter(Number.isInteger) : null;
    if (!order) return res.status(400).json({ error: 'Invalid order.' });
    await reorderBlocks(req.session.user.id, order);
    res.json({ ok: true });
  } catch (err) {
    console.error('Reorder blocks failed:', err);
    res.status(500).json({ error: 'Could not save the new order. Please try again.' });
  }
});

app.post('/dashboard/builder/blocks/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid block id.' });
    const block = await duplicateBlock(req.session.user.id, id);
    if (!block) return res.status(404).json({ error: 'Block not found.' });
    res.status(201).json(block);
  } catch (err) {
    console.error('Duplicate block failed:', err);
    res.status(500).json({ error: 'Could not duplicate that block. Please try again.' });
  }
});

app.delete('/dashboard/builder/blocks/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid block id.' });
    await deleteBlock(req.session.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete block failed:', err);
    res.status(500).json({ error: 'Could not delete that block. Please try again.' });
  }
});

app.post('/dashboard/builder/profile', requireAuth, async (req, res) => {
  try {
    const { name, handle, bio, socials } = req.body || {};
    const updated = await updateProfile(req.session.user.id, { name, handle, bio, socials });
    req.session.user = toPublicUser(updated);
    res.json({ ok: true, user: { name: updated.name, handle: updated.handle, bio: updated.bio, initials: req.session.user.initials } });
  } catch (err) {
    if (err.code === 'HANDLE_TAKEN') return res.status(409).json({ error: 'That handle is already taken.' });
    if (err.code === 'NAME_REQUIRED' || err.code === 'HANDLE_REQUIRED') return res.status(400).json({ error: err.message });
    console.error('Update profile failed:', err);
    res.status(500).json({ error: 'Could not save your profile. Please try again.' });
  }
});

// Everything in lib/storeSettings.js, sent whole on each change.
app.post('/dashboard/builder/settings', requireAuth, async (req, res) => {
  try {
    const settings = await updateStoreSettings(req.session.user.id, (req.body && req.body.settings) || {});
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('Update store settings failed:', err);
    res.status(500).json({ error: 'Could not save your store settings. Please try again.' });
  }
});

app.post('/dashboard/builder/design', requireAuth, async (req, res) => {
  try {
    const { accentColor, showBadge } = req.body || {};
    const updated = await updateDesign(req.session.user.id, { accentColor, showBadge });
    res.json({ ok: true, accentColor: updated.accent_color, showBadge: !!updated.show_badge });
  } catch (err) {
    console.error('Update design failed:', err);
    res.status(500).json({ error: 'Could not save your design. Please try again.' });
  }
});

// --- Audience -----------------------------------------------------------
// A merchant's people list. Same shape as the builder: the page itself is
// a normal render, every action inside it is a fetch() against the JSON
// endpoints below, and every endpoint scopes to req.session.user.id so one
// merchant can never see or touch another merchant's contacts.

app.get('/dashboard/audience', requireAuth, async (req, res, next) => {
  try {
    const [rows, magnets, payPages] = await Promise.all([
      listContacts(req.session.user.id),
      listLeadMagnets(req.session.user.id),
      listPaymentPages(req.session.user.id),
    ]);
    // Each contact's source_label names what it came from — a lead
    // magnet's or payment page's current title (so a rename shows up
    // here), else the title saved at the time if it's gone or the contact
    // predates source_id. audience.js groups the list by it.
    const currentTitles = {
      form: new Map(magnets.map((m) => [m.id, m.title])),
      order: new Map(payPages.map((p) => [p.id, p.title])),
    };
    const contacts = rows.map((c) => ({
      ...c,
      source_label: (currentTitles[c.source] && currentTitles[c.source].get(c.source_id)) || c.source_name || '',
    }));
    res.render('audience', {
      title: `Audience — ${SITE_NAME}`,
      user: req.session.user,
      contacts,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/audience', requireAuth, async (req, res) => {
  try {
    const { name, email, phone, note } = req.body || {};
    const contact = await createContact(req.session.user.id, { name, email, phone, note });
    res.status(201).json(contact);
  } catch (err) {
    if (err.code === 'NAME_REQUIRED' || err.code === 'CONTACT_METHOD_REQUIRED' || err.code === 'INVALID_EMAIL') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Create contact failed:', err);
    res.status(500).json({ error: 'Could not add that person. Please try again.' });
  }
});

app.patch('/dashboard/audience/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contact id.' });
    const { name, email, phone, note } = req.body || {};
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (email !== undefined) fields.email = email;
    if (phone !== undefined) fields.phone = phone;
    if (note !== undefined) fields.note = note;
    await updateContact(req.session.user.id, id, fields);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update contact failed:', err);
    res.status(500).json({ error: 'Could not save that change. Please try again.' });
  }
});

app.delete('/dashboard/audience/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid contact id.' });
    await deleteContact(req.session.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete contact failed:', err);
    res.status(500).json({ error: 'Could not delete that person. Please try again.' });
  }
});

// --- Lead magnets ---------------------------------------------------------
// Dashboard side: manage magnets, same shape as blocks/contacts — normal
// render for the list page, fetch() against JSON endpoints for every
// action, everything scoped to req.session.user.id.

app.get('/dashboard/lead-magnets', requireAuth, async (req, res, next) => {
  try {
    const magnets = await listLeadMagnets(req.session.user.id);
    res.render('lead-magnets', {
      title: `Lead magnets — ${SITE_NAME}`,
      user: req.session.user,
      magnets,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/lead-magnets', requireAuth, async (req, res) => {
  try {
    const {
      title, description, ctaText, fileUrl, successMessage, collectName, collectEmail, collectPhone,
      extraQuestions, accentColor, showCover, brandType, brandText, brandLogoUrl,
      coverType, coverImageUrl, coverVideoUrl, coverColor,
    } = req.body || {};
    const magnet = await createLeadMagnet(req.session.user.id, {
      title, description, ctaText, fileUrl, successMessage, collectName, collectEmail, collectPhone,
      extraQuestions, accentColor, showCover, brandType, brandText, brandLogoUrl,
      coverType, coverImageUrl, coverVideoUrl, coverColor,
    });
    res.status(201).json({ ...magnet, publicPath: `/${magnet.slug}` });
  } catch (err) {
    if (['TITLE_REQUIRED', 'FILE_URL_REQUIRED', 'INVALID_FILE_URL', 'INVALID_LOGO_URL', 'INVALID_COVER_URL', 'CONTACT_FIELD_REQUIRED'].includes(err.code)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Create lead magnet failed:', err);
    res.status(500).json({ error: 'Could not create that lead magnet. Please try again.' });
  }
});

app.patch('/dashboard/lead-magnets/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid lead magnet id.' });
    const {
      title, description, ctaText, fileUrl, visible, slug, successMessage, collectName, collectEmail, collectPhone,
      extraQuestions, accentColor, showCover, brandType, brandText, brandLogoUrl,
      coverType, coverImageUrl, coverVideoUrl, coverColor,
    } = req.body || {};
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (description !== undefined) fields.description = description;
    if (ctaText !== undefined) fields.ctaText = ctaText;
    if (fileUrl !== undefined) fields.fileUrl = fileUrl;
    if (visible !== undefined) fields.visible = visible;
    if (slug !== undefined) fields.slug = slug;
    if (successMessage !== undefined) fields.successMessage = successMessage;
    if (collectName !== undefined) fields.collectName = collectName;
    if (collectEmail !== undefined) fields.collectEmail = collectEmail;
    if (collectPhone !== undefined) fields.collectPhone = collectPhone;
    if (extraQuestions !== undefined) fields.extraQuestions = extraQuestions;
    if (accentColor !== undefined) fields.accentColor = accentColor;
    if (showCover !== undefined) fields.showCover = showCover;
    if (brandType !== undefined) fields.brandType = brandType;
    if (brandText !== undefined) fields.brandText = brandText;
    if (brandLogoUrl !== undefined) fields.brandLogoUrl = brandLogoUrl;
    if (coverType !== undefined) fields.coverType = coverType;
    if (coverImageUrl !== undefined) fields.coverImageUrl = coverImageUrl;
    if (coverVideoUrl !== undefined) fields.coverVideoUrl = coverVideoUrl;
    if (coverColor !== undefined) fields.coverColor = coverColor;
    const changed = await updateLeadMagnet(req.session.user.id, id, fields);
    res.json({ ok: true, ...changed });
  } catch (err) {
    if (['TITLE_REQUIRED', 'INVALID_FILE_URL', 'INVALID_LOGO_URL', 'INVALID_COVER_URL', 'SLUG_REQUIRED', 'SLUG_TAKEN', 'CONTACT_FIELD_REQUIRED'].includes(err.code)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Update lead magnet failed:', err);
    res.status(500).json({ error: 'Could not save that change. Please try again.' });
  }
});

// One file per request, sent as the raw body with its own Content-Type
// (the builder's cover image/video upload) — see lib/uploads.js. Parse
// errors (too big, cut off) come back as JSON rather than the error page.
const readUploadBody = express.raw({ type: Object.keys(UPLOAD_TYPES), limit: MAX_UPLOAD_BYTES });
app.post('/dashboard/uploads', requireAuth, (req, res, next) => {
  readUploadBody(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big — keep videos under 30 MB and images under 5 MB.' });
    res.status(400).json({ error: 'Could not read that file. Please try again.' });
  });
}, async (req, res) => {
  try {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // reused: this exact file was already in their library (lib/uploads.js).
    const { url, reused } = await saveUpload(req.session.user.id, mime, req.body);
    res.status(reused ? 200 : 201).json({ url, reused });
  } catch (err) {
    if (err.code === 'INVALID_UPLOAD') return res.status(400).json({ error: err.message });
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'Could not upload that file. Please try again.' });
  }
});

// A creator's media library (public/js/media-library.js): their uploads, to
// reuse instead of uploading the same file again — and deleting ones that
// nothing uses (lib/adminMedia.js).
app.get('/dashboard/media', requireAuth, async (req, res) => {
  try {
    res.json({ files: await userMedia(req.session.user.id) });
  } catch (err) {
    console.error('Media library failed:', err);
    res.status(500).json({ error: 'Could not load your media. Please try again.' });
  }
});

app.post('/dashboard/media/delete', requireAuth, async (req, res) => {
  try {
    const result = await deleteUserMedia(req.session.user.id, req.body && req.body.url);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('Media delete failed:', err);
    res.status(500).json({ error: 'Could not delete that file. Please try again.' });
  }
});

app.delete('/dashboard/lead-magnets/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid lead magnet id.' });
    await deleteLeadMagnet(req.session.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete lead magnet failed:', err);
    res.status(500).json({ error: 'Could not delete that lead magnet. Please try again.' });
  }
});

// --- Payment pages, coupons, orders ----------------------------------------
// Same shape as lead magnets: one render per page, JSON endpoints for every
// action, everything scoped to req.session.user.id. The public side
// (/pay/... on the store subdomain) is lib/paymentStorefront.js.

// Errors thrown by lib/paymentPages.js for something the merchant typed —
// shown as-is; anything else is a server fault.
const PAYMENT_INPUT_ERRORS = new Set([
  'INVALID_FIELD', 'TITLE_REQUIRED', 'INVALID_DELIVERY_URL', 'INVALID_COVER_URL', 'SLUG_REQUIRED', 'SLUG_TAKEN', 'CODE_TAKEN',
]);
function sendPaymentError(res, err, fallback) {
  if (PAYMENT_INPUT_ERRORS.has(err.code)) return res.status(400).json({ error: err.message });
  if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
  console.error(fallback, err);
  return res.status(500).json({ error: `${fallback} Please try again.` });
}
function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : null;
}
// Pages for the dashboard script: the stored row plus paid-order stats.
function withStats(page, stats) {
  const s = stats.get(page.id) || { paidCount: 0, revenue: 0, toShip: 0 };
  return { ...page, paid_count: s.paidCount, revenue: s.revenue, to_ship: s.toShip };
}

app.get('/dashboard/payment-pages', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const [pages, stats] = await Promise.all([listPaymentPages(userId), orderStatsByPage(userId)]);
    res.render('payment-pages', {
      title: `Payment pages — ${SITE_NAME}`,
      user: req.session.user,
      pages: pages.map((p) => withStats(p, stats)),
      paymentMode: paymentMode(),
    });
  } catch (err) {
    next(err);
  }
});

// One page's Analytics (Payment pages → ⋯ → Analytics): Overview,
// Customers and Abandoned carts tabs (?tab=), all from its orders and
// checkout drafts (lib/orders.js pageAnalytics, lib/checkoutDrafts.js).
const ANALYTICS_TABS = new Set(['overview', 'customers', 'abandoned']);
app.get('/dashboard/payment-pages/:id/analytics', requireAuth, async (req, res, next) => {
  const id = idParam(req);
  try {
    const userId = req.session.user.id;
    const page = id === null ? null : await getPaymentPage(userId, id);
    if (!page) {
      return res.status(404).render('error', {
        title: `Not found — ${SITE_NAME}`,
        heading: 'Payment page not found',
        message: 'That payment page doesn’t exist, or it was deleted.',
      });
    }
    const tab = ANALYTICS_TABS.has(req.query.tab) ? req.query.tab : 'overview';
    const mode = paymentMode();
    const [stats, abandoned, ab] = await Promise.all([
      pageAnalytics(userId, id),
      listAbandoned(userId, id, { testMode: mode !== 'manual' }),
      tab === 'abandoned' ? abandonedView(userId, { kind: 'page', pageId: id }) : null,
    ]);
    const visits = page.view_count || 0;
    res.render('payment-page-analytics', {
      title: `Analytics — ${page.title} — ${SITE_NAME}`,
      user: req.session.user,
      page,
      tab,
      stats,
      abandoned,
      ab,
      visits,
      // Paid orders per visit — capped, since a page's views started being
      // counted after some of its orders may already have been placed.
      conversion: visits ? Math.min(100, Math.round((stats.orders.paid / visits) * 1000) / 10) : null,
      formatINR,
      paymentMode: mode,
    });
  } catch (err) {
    next(err);
  }
});

// "Dismiss" on an abandoned cart — it leaves the list for good.
app.post('/dashboard/payment-pages/:id/abandoned/:draftId/dismiss', requireAuth, async (req, res, next) => {
  const id = idParam(req);
  const draftId = Number(req.params.draftId);
  try {
    if (id !== null && Number.isInteger(draftId)) await dismissDraft(req.session.user.id, id, draftId);
    res.redirect(303, `/dashboard/payment-pages/${id}/analytics?tab=abandoned`);
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/payment-pages', requireAuth, async (req, res) => {
  try {
    const page = await createPaymentPage(req.session.user.id, req.body || {});
    res.status(201).json({ ...page, paid_count: 0, revenue: 0, to_ship: 0 });
  } catch (err) {
    sendPaymentError(res, err, 'Could not create that payment page.');
  }
});

app.patch('/dashboard/payment-pages/:id', requireAuth, async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(400).json({ error: 'Invalid payment page id.' });
  try {
    const page = await updatePaymentPage(req.session.user.id, id, req.body || {});
    const stats = await orderStatsByPage(req.session.user.id);
    res.json(withStats(page, stats));
  } catch (err) {
    sendPaymentError(res, err, 'Could not save that change.');
  }
});

app.delete('/dashboard/payment-pages/:id', requireAuth, async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(400).json({ error: 'Invalid payment page id.' });
  try {
    await deletePaymentPage(req.session.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    sendPaymentError(res, err, 'Could not delete that payment page.');
  }
});

// Coupons (Payment pages app): its own page; codes can be for every
// payment page or just one, so the page list comes along for the picker.
app.get('/dashboard/coupons', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const [coupons, pages] = await Promise.all([listCoupons(userId), listPaymentPages(userId)]);
    res.render('coupons', {
      title: `Coupons — ${SITE_NAME}`,
      user: req.session.user,
      coupons,
      pages: pages.map((p) => ({ id: p.id, title: p.title })),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/dashboard/coupons', requireAuth, async (req, res) => {
  try {
    res.status(201).json(await createCoupon(req.session.user.id, req.body || {}));
  } catch (err) {
    sendPaymentError(res, err, 'Could not create that coupon.');
  }
});

app.patch('/dashboard/coupons/:id', requireAuth, async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(400).json({ error: 'Invalid coupon id.' });
  try {
    await setCouponActive(req.session.user.id, id, !!(req.body && req.body.active));
    res.json({ ok: true });
  } catch (err) {
    sendPaymentError(res, err, 'Could not update that coupon.');
  }
});

app.delete('/dashboard/coupons/:id', requireAuth, async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(400).json({ error: 'Invalid coupon id.' });
  try {
    await deleteCoupon(req.session.user.id, id);
    res.json({ ok: true });
  } catch (err) {
    sendPaymentError(res, err, 'Could not delete that coupon.');
  }
});

// --- Custom domain (lib/customDomains.js) ---------------------------------
// A creator connects their own domain the way Shopify does it: type it, add
// the DNS records shown, Verify. Caddy (deploy/Caddyfile) issues the HTTPS
// certificate on the first visit, after asking /internal/domain-check.
// They also pick what opens at the root: the store, or one course, event,
// booking page or payment page.
const domainBack = (res, query = '') => res.redirect(303, `/dashboard/domain${query}`);
app.get('/dashboard/domain', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const domain = await customDomains.getDomain(userId);
    const [courseList, eventList, serviceList, pageList, wwwOk, serverIps] = await Promise.all([
      require('./lib/courses').listCourses(userId).catch(() => []),
      require('./lib/events').listEvents(userId).catch(() => []),
      require('./lib/bookings').listServices(userId).catch(() => []),
      listPaymentPages(userId).catch(() => []),
      domain ? customDomains.wwwPointsHere(domain.domain, { siteDomain: SITE_DOMAIN }).catch(() => false) : false,
      customDomains.ourServerIps(SITE_DOMAIN).catch(() => []),
    ]);
    const pick = (list) => list.map((x) => ({ id: x.id, title: x.title }));
    res.render('domain', {
      title: `Domain — ${SITE_NAME}`,
      user: req.session.user,
      domain,
      wwwOk,
      serverIps,
      homeTypes: customDomains.HOME_TYPES,
      port: PORT,
      homes: { course: pick(courseList), event: pick(eventList), booking: pick(serviceList), pay: pick(pageList) },
      flash: req.query.error ? { kind: 'error', text: String(req.query.error).slice(0, 200) }
        : req.query.ok ? { kind: 'ok', text: { connected: 'Domain added — now add the DNS records below.', saved: 'Saved.', removed: 'Domain disconnected.', checked: 'Checked.' }[req.query.ok] || 'Saved.' } : null,
    });
  } catch (err) {
    next(err);
  }
});
app.post('/dashboard/domain', requireAuth, async (req, res, next) => {
  try {
    await customDomains.connectDomain(req.session.user.id, req.body && req.body.domain, { siteDomain: SITE_DOMAIN });
    domainBack(res, '?ok=connected');
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return domainBack(res, `?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});
app.post('/dashboard/domain/verify', requireAuth, async (req, res, next) => {
  try {
    await customDomains.verifyDomain(req.session.user.id, { siteDomain: SITE_DOMAIN });
    domainBack(res, '?ok=checked');
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return domainBack(res, `?error=${encodeURIComponent(err.message)}`);
    next(err);
  }
});
app.post('/dashboard/domain/home', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    // "course:12" / "booking:" (the whole booking page) / "store".
    const [type, rawId] = String((req.body && req.body.home) || 'store').split(':');
    const homeId = Number(rawId) || null;
    if (!customDomains.HOME_TYPES[type]) return domainBack(res, '?error=Pick what opens at your domain.');
    if (type !== 'store' && !(type === 'booking' && !homeId)) {
      const lists = {
        course: () => require('./lib/courses').listCourses(userId),
        event: () => require('./lib/events').listEvents(userId),
        booking: () => require('./lib/bookings').listServices(userId),
        pay: () => listPaymentPages(userId),
      };
      if (!homeId || !(await lists[type]()).some((x) => x.id === homeId)) return domainBack(res, '?error=That page doesn’t exist.');
    }
    await customDomains.setHome(userId, type, homeId);
    domainBack(res, '?ok=saved');
  } catch (err) {
    next(err);
  }
});
app.post('/dashboard/domain/disconnect', requireAuth, async (req, res, next) => {
  try {
    await customDomains.disconnectDomain(req.session.user.id);
    domainBack(res, '?ok=removed');
  } catch (err) {
    next(err);
  }
});
// Caddy's on-demand TLS asks this before getting a certificate for a name
// (deploy/Caddyfile): 200 = go ahead, 404 = not one of ours. Answered only
// to the machine itself, never through the proxy.
app.get('/internal/domain-check', async (req, res) => {
  const from = String(req.socket.remoteAddress || '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from) || req.get('x-forwarded-for')) return res.status(403).end();
  try {
    return res.status(await customDomains.mayIssueCertificate(req.query.domain, { siteDomain: SITE_DOMAIN }) ? 200 : 404).end();
  } catch (err) {
    console.error('Domain check failed:', err.message);
    return res.status(500).end();
  }
});

// --- Abandoned carts (lib/abandoned.js) ---------------------------------
// Every unpaid checkout across payment pages, paid courses and booking
// advances, with WhatsApp / email / copy follow-ups. The page builds each
// message from the creator's template; contacting and dismissing are JSON
// calls so the list doesn't reload.
app.get('/dashboard/abandoned', requireAuth, async (req, res, next) => {
  try {
    res.render('abandoned', {
      title: `Abandoned carts — ${SITE_NAME}`,
      user: req.session.user,
      ab: await abandonedView(req.session.user.id),
      abandonedAfter: ABANDONED_AFTER_MINUTES,
      formatINR,
    });
  } catch (err) {
    next(err);
  }
});
app.post('/dashboard/abandoned/contacted', requireAuth, async (req, res) => {
  try {
    const row = await markContacted(req.session.user.id, req.body || {});
    if (!row) return res.status(400).json({ error: 'Unknown cart.' });
    return res.json({ ok: true, contactedAt: row.contacted_at, contacts: row.contacts, channel: row.channel });
  } catch (err) {
    console.error('Marking a cart contacted failed:', err);
    return res.status(500).json({ error: 'Could not save that. Please try again.' });
  }
});
app.post('/dashboard/abandoned/dismiss', requireAuth, async (req, res) => {
  try {
    await dismissAbandoned(req.session.user.id, req.body && req.body.ref);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Dismissing a cart failed:', err);
    return res.status(500).json({ error: 'Could not dismiss that. Please try again.' });
  }
});

app.get('/dashboard/orders', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const [orders, pages] = await Promise.all([listOrders(userId), listPaymentPages(userId)]);
    res.render('orders', {
      title: `Orders — ${SITE_NAME}`,
      user: req.session.user,
      orders,
      pages: pages.map((p) => ({ id: p.id, title: p.title })),
      paymentMode: paymentMode(),
    });
  } catch (err) {
    next(err);
  }
});

// Settling an order by hand — marking a pending one paid (how "manual"
// mode works: the merchant was paid by UPI/bank transfer), cancelling an
// abandoned one, or marking a paid order's parcel as shipped.
app.patch('/dashboard/orders/:id', requireAuth, async (req, res) => {
  const id = idParam(req);
  if (id === null) return res.status(400).json({ error: 'Invalid order id.' });
  const status = req.body && req.body.status;
  if (!['paid', 'cancelled', 'shipped'].includes(status)) return res.status(400).json({ error: 'Unknown order status.' });
  try {
    const userId = req.session.user.id;
    let changed;
    if (status === 'paid') changed = await markOrderPaid(userId, id, { provider: 'manual' });
    else if (status === 'cancelled') changed = await cancelOrder(userId, id);
    else changed = await markOrderShipped(userId, id);
    const order = await getOrder(userId, id);
    if (!order) return res.status(404).json({ error: 'That order doesn’t exist.' });
    if (!changed) {
      const now = status === 'shipped' && order.status === 'paid' ? (order.fulfillment || 'not for shipping') : order.status;
      return res.status(409).json({ error: `That order is already ${now}.`, order });
    }
    res.json({ ok: true, order });
  } catch (err) {
    console.error('Update order failed:', err);
    res.status(500).json({ error: 'Could not update that order. Please try again.' });
  }
});

// --- Live preview: the editors show the real public page (lib/livePreview.js)
installLivePreview(app, { requireAuth });

// --- Bookings, Events, Courses (lib/appDashboard.js) ----------------------
installAppDashboards(app, { requireAuth, siteName: SITE_NAME });

// Public side: the link a merchant shares lives on their store subdomain
// (meera.pagezaper.com/free-checklist) — see lib/storefront.js.

// Anything that isn't one of the routes above — catches typos in a URL,
// not a route that hasn't been built yet.
app.use((req, res) => {
  res.status(404).render('error', {
    title: `Page not found — ${SITE_NAME}`,
    heading: 'Page not found',
    message: 'The page you’re looking for doesn’t exist.',
  });
});

// Last-resort safety net. Signup and login already catch their own errors
// with a specific, friendly message (see above) — this only fires for
// something unexpected slipping through elsewhere, so a real user never
// sees Express's default stack-trace page. The actual error still goes to
// the server log (and from there, pm2 logs) for debugging.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    title: `Something went wrong — ${SITE_NAME}`,
    heading: 'Something went wrong',
    message: 'An unexpected error occurred. Please try again.',
  });
});

// Razorpay's admin settings are loaded before the first request, so
// checkout uses the right gateway from the start.
loadGatewaySettings()
  .catch((err) => console.error('Loading Razorpay settings failed:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`${SITE_NAME} running on port ${PORT}`);
    });
  });
