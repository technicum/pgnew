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
  findUserByHandle,
  createUser,
  verifyPassword,
  toPublicUser,
  updateProfile,
  updateDesign,
} = require('./lib/users');
const {
  listBlocks,
  createBlock,
  updateBlock,
  reorderBlocks,
  deleteBlock,
  duplicateBlock,
  TYPES: BLOCK_TYPES,
  TYPE_LABELS: BLOCK_LABELS,
  URL_TYPES: BLOCK_URL_TYPES,
} = require('./lib/blocks');
const {
  listContacts,
  countContacts,
  createContact,
  updateContact,
  deleteContact,
} = require('./lib/contacts');

const app = express();
// Falls back to 3000 when PORT isn't set in the environment (e.g. local dev
// with no .env file at all).
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Behind nginx in production — lets req.hostname/req.protocol reflect what
// the visitor actually requested (the store subdomain, https).
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
// Only the builder's fetch()-based endpoints send JSON bodies — everything
// else (signup/login) still posts as a normal HTML form.
app.use(express.json());

app.use(session({
  // Falls back to a fixed dev secret so `node server.js` works with no
  // .env at all; set SESSION_SECRET in production's .env for real signing.
  secret: process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-in-production',
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

// Appended to /css and /js URLs in the views (?v=...) so every restart —
// i.e. every deploy — gives browsers a new URL. Without it a browser can
// pair a freshly rendered page with a cached, older builder.js and break.
const ASSET_VERSION = Date.now().toString(36);

// Makes siteName/siteDomain/assetVersion available in every view without
// passing them explicitly on every res.render call.
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  res.locals.siteDomain = SITE_DOMAIN;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.currentUser = req.session.user || null;
  res.locals.storeUrlFor = (handle) => storeUrlFor(req, handle);
  next();
});

// --- Public stores on subdomains ---------------------------------------
// meera.pagezaper.com renders Meera's store. In local dev the same works
// on meera.localhost:3000 (browsers resolve *.localhost to this machine
// with no hosts-file edits). Anything else — pagezaper.com, www., the
// VPS's IP — falls through to the normal site routes below.
const STORE_BASE_DOMAINS = [SITE_DOMAIN, 'localhost'];

function storeHandleFromHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const base of STORE_BASE_DOMAINS) {
    if (!host.endsWith(`.${base}`)) continue;
    const sub = host.slice(0, -(base.length + 1));
    // Only one level deep (a.b.pagezaper.com isn't a store), and www is
    // the main site.
    if (!sub || sub.includes('.') || sub === 'www') return null;
    return sub;
  }
  return null;
}

function isLocalRequest(req) {
  return req.hostname === 'localhost' || req.hostname.endsWith('.localhost');
}

// Where a handle's store lives, as seen from this request — so "View live"
// opens the local store while developing and the real one in production.
function storeUrlFor(req, handle) {
  if (isLocalRequest(req)) return `http://${handle}.localhost:${PORT}`;
  return `https://${handle}.${SITE_DOMAIN}`;
}

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

app.use(async (req, res, next) => {
  const handle = storeHandleFromHost(req.hostname);
  if (!handle) return next();

  const notFound = (message) => res.status(404).render('error', {
    title: `Store not found — ${SITE_NAME}`,
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
    if (!owner) return notFound(`There’s no store at ${handle}.${SITE_DOMAIN} yet.`);

    const blocks = (await listBlocks(owner.id))
      .filter((b) => b.visible && BLOCK_LABELS[b.type])
      .map((b) => {
        const href = BLOCK_URL_TYPES.has(b.type) ? safeHref(b.sub) : null;
        return {
          type: b.type,
          label: BLOCK_LABELS[b.type],
          title: b.title || BLOCK_LABELS[b.type],
          // For URL blocks the raw URL isn't useful text — show the host.
          sub: href ? new URL(href).host.replace(/^www\./, '') : b.sub,
          price: b.price,
          href,
        };
      });

    const initials = owner.name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map((p) => p[0].toUpperCase()).join('') || 'U';

    res.render('store', {
      title: `${owner.name} — ${SITE_NAME}`,
      owner: {
        name: owner.name,
        bio: owner.bio || '',
        initials,
        accent: /^#[0-9a-f]{6}$/i.test(owner.accent_color) ? owner.accent_color : '#ff6b4a',
        showBadge: !!owner.show_badge,
      },
      blocks,
      mainSiteUrl: isLocalRequest(req) ? `http://localhost:${PORT}` : `https://${SITE_DOMAIN}`,
    });
  } catch (err) {
    next(err);
  }
});

function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

app.get('/', (req, res) => {
  res.render('index', {
    title: `${SITE_NAME} — One store. Every way you earn.`,
  });
});

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
    error: null,
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
    const { title, sub, price, visible } = req.body || {};
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (sub !== undefined) fields.sub = sub;
    if (price !== undefined) fields.price = price;
    if (visible !== undefined) fields.visible = visible;
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
    const { name, handle, bio } = req.body || {};
    const updated = await updateProfile(req.session.user.id, { name, handle, bio });
    req.session.user = toPublicUser(updated);
    res.json({ ok: true, user: { name: updated.name, handle: updated.handle, bio: updated.bio, initials: req.session.user.initials } });
  } catch (err) {
    if (err.code === 'HANDLE_TAKEN') return res.status(409).json({ error: 'That handle is already taken.' });
    if (err.code === 'NAME_REQUIRED' || err.code === 'HANDLE_REQUIRED') return res.status(400).json({ error: err.message });
    console.error('Update profile failed:', err);
    res.status(500).json({ error: 'Could not save your profile. Please try again.' });
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
    const contacts = await listContacts(req.session.user.id);
    res.render('audience', {
      title: `People — ${SITE_NAME}`,
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

app.listen(PORT, () => {
  console.log(`${SITE_NAME} running on port ${PORT}`);
});
