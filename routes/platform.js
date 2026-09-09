const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool, THEMES, RESERVED_SUBDOMAINS, TABLES } = require('../db/database');
const { storeUrl, rootUrl, adminPortalUrl } = require('../middleware/tenant');
const { defaultFields } = require('../lib/sections');

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Marketing homepage ----------
// Only shown on the root domain — on a store's own subdomain, "/" is that
// store's storefront home instead (handled by routes/storefront.js).
router.get('/', (req, res, next) => {
  if (req.store) return next();
  if (req.isAdminPortal) return res.redirect('/login'); // admin.pagezaper.com -> straight to the staff login form
  if (!req.isRootDomain) return next(); // unknown/suspended subdomain — let storefront.js 404 it
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ---------- Merchant signup ----------
router.get('/signup', (req, res) => {
  if (req.store || !req.isRootDomain) return res.redirect(rootUrl(req, '/signup'));
  res.render('platform/signup', {
    title: 'Create your store',
    errors: [],
    themes: THEMES,
    values: { storeName: '', subdomain: '', ownerName: '', ownerEmail: '', theme: 'default' },
  });
});

router.post('/signup', async (req, res, next) => {
  if (req.store || !req.isRootDomain) return res.redirect(rootUrl(req, '/signup'));

  const storeName = (req.body.storeName || '').trim();
  const ownerName = (req.body.ownerName || '').trim();
  const ownerEmail = (req.body.ownerEmail || '').trim().toLowerCase();
  const password = req.body.password || '';
  const confirmPassword = req.body.confirmPassword || '';
  let subdomain = (req.body.subdomain || '').trim().toLowerCase();
  if (!subdomain && storeName) subdomain = slugify(storeName);
  const theme = THEMES.includes(req.body.theme) ? req.body.theme : 'default';

  const values = { storeName, subdomain, ownerName, ownerEmail, theme };
  const errors = [];

  if (!storeName) errors.push('Store name is required.');
  if (!ownerName) errors.push('Your name is required.');
  if (!ownerEmail || !EMAIL_RE.test(ownerEmail)) errors.push('A valid email address is required.');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters.');
  if (password !== confirmPassword) errors.push('Passwords do not match.');

  if (!subdomain || !SUBDOMAIN_RE.test(subdomain) || subdomain.length < 3) {
    errors.push('Store address must be 3-63 characters: lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.');
  } else if (RESERVED_SUBDOMAINS.has(subdomain)) {
    errors.push(`"${subdomain}" is reserved — please choose a different store address.`);
  }

  if (errors.length) {
    return res.status(400).render('platform/signup', { title: 'Create your store', errors, themes: THEMES, values });
  }

  const conn = await pool.getConnection();
  try {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [subdomain]);
    if (existing) {
      conn.release();
      return res.status(400).render('platform/signup', {
        title: 'Create your store',
        errors: [`"${subdomain}" is already taken — please choose another store address.`],
        themes: THEMES,
        values,
      });
    }

    await conn.beginTransaction();

    // pz_users is a global login, not scoped to one store — someone who
    // already has an account (e.g. they admin another store) can create a
    // second store under that same login, as long as they prove it's them
    // by entering their existing password.
    const [[existingUser]] = await conn.query(`SELECT id, name, password_hash FROM ${TABLES.users} WHERE email = ?`, [ownerEmail]);
    let userId = null;
    let sessionName = ownerName;
    if (existingUser) {
      if (!bcrypt.compareSync(password, existingUser.password_hash)) {
        await conn.rollback();
        conn.release();
        return res.status(400).render('platform/signup', {
          title: 'Create your store',
          errors: [`An account already exists for ${ownerEmail} — enter its password to add another store, or log in instead.`],
          themes: THEMES,
          values,
        });
      }
      userId = existingUser.id;
      sessionName = existingUser.name;
    }

    const [storeResult] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status) VALUES (?, ?, ?, 'free', 'active')`,
      [storeName, subdomain, theme]
    );
    const storeId = storeResult.insertId;

    if (!userId) {
      const passwordHash = bcrypt.hashSync(password, 10);
      const [userResult] = await conn.query(
        `INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`,
        [ownerName, ownerEmail, passwordHash]
      );
      userId = userResult.insertId;
    }

    await conn.query(`INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')`, [userId, storeId]);

    // Every store needs a Home page to render "/" from — create one here so
    // a brand-new store never 404s. (Stores that existed before the page
    // builder shipped get this backfilled on server boot instead — see
    // migratePagesForExistingStores in db/database.js.)
    const [pageResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Home', '/', 1, 'published')`,
      [storeId]
    );
    const pageId = pageResult.insertId;
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'hero', 0, ?)`,
      [pageId, JSON.stringify(defaultFields('hero'))]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'products', 1, ?)`,
      [pageId, JSON.stringify(defaultFields('products'))]
    );

    await conn.commit();

    req.session.admin = { id: userId, name: sessionName, email: ownerEmail, store_id: storeId, role: 'admin' };
    req.flash('success', `Welcome to PageZaper, ${sessionName}! Your store "${storeName}" is ready — add your first products to get started.`);
    res.redirect(storeUrl(req, subdomain, '/admin'));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------- Platform login ----------
// The single staff login gateway lives at admin.pagezaper.com — a merchant
// may not remember their store's subdomain, so this looks their account up
// by email and sends them on to whichever store(s) they administer. Hitting
// "/login" from anywhere else (the root marketing domain, a store's own
// subdomain) just bounces here rather than rendering its own form, so there
// is exactly one login page in the whole app.
router.get('/login', (req, res) => {
  if (req.store) return res.redirect(adminPortalUrl(req, '/login'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/login'));
  req.session.pendingUser = null; // abandon any in-progress store selection
  res.render('platform/login', { title: 'Log in' });
});

router.post('/login', async (req, res, next) => {
  if (req.store) return res.redirect(adminPortalUrl(req, '/login'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/login'));
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const [[user]] = await pool.query(`SELECT * FROM ${TABLES.users} WHERE email = ?`, [email]);
    if (!user) {
      req.flash('error', 'No account found with that email.');
      return res.redirect('/login');
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      req.flash('error', 'Incorrect password.');
      return res.redirect('/login');
    }

    // One login can have a role at more than one store now. Exactly one
    // active store — skip straight there like before. More than one — ask
    // which store they mean instead of guessing (see /select-store below).
    const [roles] = await pool.query(
      `SELECT ur.store_id, ur.role, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
       ORDER BY (ur.role = 'admin') DESC, s.created_at ASC`,
      [user.id]
    );

    if (!roles.length) {
      req.flash('error', 'No active store found for this account.');
      return res.redirect('/login');
    }

    if (roles.length > 1) {
      // Hold the verified identity in session while they pick — nothing
      // store-scoped (req.session.admin) is set until they choose.
      req.session.pendingUser = { id: user.id, name: user.name, email: user.email };
      return res.redirect(adminPortalUrl(req, '/select-store'));
    }

    const match = roles[0];
    req.session.admin = { id: user.id, name: user.name, email: user.email, store_id: match.store_id, role: match.role };
    res.redirect(storeUrl(req, match.subdomain, '/admin'));
  } catch (err) {
    next(err);
  }
});

// A login that administers more than one store lands here after password
// check instead of being sent straight to a store — req.session.pendingUser
// (set by POST /login above) holds the verified identity until they pick.
router.get('/select-store', async (req, res, next) => {
  if (req.store) return res.redirect(adminPortalUrl(req, '/select-store'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/select-store'));

  const pending = req.session.pendingUser;
  if (!pending) return res.redirect(adminPortalUrl(req, '/login'));

  try {
    const [roles] = await pool.query(
      `SELECT ur.store_id, ur.role, s.name, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
       ORDER BY (ur.role = 'admin') DESC, s.created_at ASC`,
      [pending.id]
    );

    if (!roles.length) {
      req.session.pendingUser = null;
      req.flash('error', 'No active store found for this account.');
      return res.redirect(adminPortalUrl(req, '/login'));
    }

    if (roles.length === 1) {
      // Could happen if a store got suspended between login and this page.
      const match = roles[0];
      req.session.admin = { id: pending.id, name: pending.name, email: pending.email, store_id: match.store_id, role: match.role };
      req.session.pendingUser = null;
      return res.redirect(storeUrl(req, match.subdomain, '/admin'));
    }

    res.render('platform/select-store', { title: 'Select a store', name: pending.name, stores: roles });
  } catch (err) {
    next(err);
  }
});

router.post('/select-store', async (req, res, next) => {
  if (req.store) return res.redirect(adminPortalUrl(req, '/select-store'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/select-store'));

  const pending = req.session.pendingUser;
  if (!pending) return res.redirect(adminPortalUrl(req, '/login'));

  try {
    const storeId = parseInt(req.body.storeId, 10);
    const [[match]] = await pool.query(
      `SELECT ur.store_id, ur.role, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.store_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
       LIMIT 1`,
      [pending.id, storeId]
    );

    if (!match) {
      req.flash('error', 'Please choose one of your stores.');
      return res.redirect(adminPortalUrl(req, '/select-store'));
    }

    req.session.admin = { id: pending.id, name: pending.name, email: pending.email, store_id: match.store_id, role: match.role };
    req.session.pendingUser = null;
    res.redirect(storeUrl(req, match.subdomain, '/admin'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
