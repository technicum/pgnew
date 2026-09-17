const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool, THEMES, isReservedSubdomain, TABLES } = require('../db/database');
const { storeUrl, rootUrl, adminPortalUrl } = require('../middleware/tenant');
const { defaultFields, STORE_CATEGORIES } = require('../lib/sections');

function slugify(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The category picked on the "Create a new site" popup (see
// views/admin/dashboard.ejs's modal, which links straight into
// /dashboard/new-store?category=<val>) — now the single source of truth
// (lib/sections.js) for which of a store's sections the page builder offers;
// see isEcommerceCategory/sectionTypesForStore there.

// ---------- Marketing homepage ----------
// Only shown on the root domain — on a store's own subdomain, "/" is that
// store's storefront home instead (handled by routes/storefront.js).
router.get('/', (req, res, next) => {
  if (req.store) return next();
  if (req.isAdminPortal) return res.redirect(req.session.account ? '/dashboard' : '/login'); // admin.pagezaper.com -> the account dashboard once logged in, otherwise the staff login form
  if (!req.isRootDomain) return next(); // unknown/suspended subdomain — let storefront.js 404 it
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ---------- Merchant signup ----------
router.get('/signup', (req, res) => {
  if (req.store || !req.isRootDomain) return res.redirect(rootUrl(req, '/signup'));
  res.render('platform/signup', {
    title: 'Create your site',
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
  } else if (isReservedSubdomain(subdomain)) {
    errors.push(`"${subdomain}" is reserved — please choose a different store address.`);
  }

  if (errors.length) {
    return res.status(400).render('platform/signup', { title: 'Create your site', errors, themes: THEMES, values });
  }

  const conn = await pool.getConnection();
  try {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [subdomain]);
    if (existing) {
      conn.release();
      return res.status(400).render('platform/signup', {
        title: 'Create your site',
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
          title: 'Create your site',
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

    req.session.account = { id: userId, name: sessionName, email: ownerEmail };
    req.session.admin = { id: userId, name: sessionName, email: ownerEmail, store_id: storeId, role: 'admin' };
    req.flash('success', `Welcome to PageZaper, ${sessionName}! Your site "${storeName}" is ready — add your first products to get started.`);
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
// by email and password. Every successful login lands on the account
// dashboard below (not straight into a store), same as accounts.shopify.com
// — from there they pick a store to enter, create a new one, or edit their
// profile. Hitting "/login" from anywhere else (the root marketing domain, a
// store's own subdomain) just bounces here, so there is exactly one login
// page in the whole app.
router.get('/login', (req, res) => {
  if (req.store) return res.redirect(adminPortalUrl(req, '/login'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/login'));
  if (req.session.account) return res.redirect(adminPortalUrl(req, '/dashboard'));
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

    req.session.account = { id: user.id, name: user.name, email: user.email };
    req.session.admin = null; // any previous store session is stale until re-chosen from the dashboard
    res.redirect(adminPortalUrl(req, '/dashboard'));
  } catch (err) {
    next(err);
  }
});

// ---------- Account dashboard ----------
// req.session.account (set by POST /login, or by /signup below) means "this
// browser is signed in at the account level" — separate from
// req.session.admin, which means "signed into one particular store" and is
// only set once they actually enter a store from here. Every dashboard route
// requires the former; entering a store additionally sets the latter.
function requireAccount(req, res, next) {
  if (req.store) return res.redirect(adminPortalUrl(req, '/dashboard'));
  if (!req.isAdminPortal) return res.redirect(adminPortalUrl(req, '/dashboard'));
  if (!req.session.account) return res.redirect(adminPortalUrl(req, '/login'));
  next();
}

router.get('/dashboard', requireAccount, async (req, res, next) => {
  try {
    const [stores] = await pool.query(
      `SELECT ur.store_id, ur.role, s.name, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
       ORDER BY (ur.role = 'admin') DESC, s.created_at ASC`,
      [req.session.account.id]
    );
    res.render('platform/dashboard', { title: 'Your sites', account: req.session.account, stores });
  } catch (err) {
    next(err);
  }
});

// Sets req.session.admin for the chosen store and hands off to its own
// subdomain — a plain link can't do this because req.session.admin has to be
// set on THIS request before the browser follows it there.
router.post('/dashboard/enter', requireAccount, async (req, res, next) => {
  try {
    const storeId = parseInt(req.body.storeId, 10);
    const [[match]] = await pool.query(
      `SELECT ur.store_id, ur.role, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.store_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
       LIMIT 1`,
      [req.session.account.id, storeId]
    );

    if (!match) {
      req.flash('error', 'Please choose one of your stores.');
      return res.redirect(adminPortalUrl(req, '/dashboard'));
    }

    req.session.admin = {
      id: req.session.account.id,
      name: req.session.account.name,
      email: req.session.account.email,
      store_id: match.store_id,
      role: match.role,
    };
    res.redirect(storeUrl(req, match.subdomain, '/admin'));
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/logout', requireAccount, (req, res) => {
  req.session.account = null;
  req.session.admin = null;
  res.redirect(adminPortalUrl(req, '/login'));
});

// ---------- Create an additional store ----------
// Reachable only from the dashboard, so the owner is already authenticated —
// unlike /signup this needs no name/email/password fields, just the new
// store's own details.
router.get('/dashboard/new-store', requireAccount, (req, res) => {
  // ?category=<val> arrives from the dashboard's "Create a new site" popup
  // (see views/admin/dashboard.ejs) — an unrecognized or missing value just
  // means no category badge shows on this form, not an error, since a
  // merchant can also reach this page directly (e.g. "Back to your stores"
  // then in again) with nothing picked.
  const category = STORE_CATEGORIES.includes(req.query.category) ? req.query.category : '';
  res.render('platform/new-store', {
    title: 'Create a new site',
    errors: [],
    themes: THEMES,
    values: { storeName: '', subdomain: '', theme: 'default', category },
  });
});

router.post('/dashboard/new-store', requireAccount, async (req, res, next) => {
  const storeName = (req.body.storeName || '').trim();
  let subdomain = (req.body.subdomain || '').trim().toLowerCase();
  if (!subdomain && storeName) subdomain = slugify(storeName);
  const theme = THEMES.includes(req.body.theme) ? req.body.theme : 'default';
  const category = STORE_CATEGORIES.includes(req.body.category) ? req.body.category : null;

  const values = { storeName, subdomain, theme, category: category || '' };
  const errors = [];

  if (!storeName) errors.push('Store name is required.');
  if (!subdomain || !SUBDOMAIN_RE.test(subdomain) || subdomain.length < 3) {
    errors.push('Store address must be 3-63 characters: lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.');
  } else if (isReservedSubdomain(subdomain)) {
    errors.push(`"${subdomain}" is reserved — please choose a different store address.`);
  }

  if (errors.length) {
    return res.status(400).render('platform/new-store', { title: 'Create a new site', errors, themes: THEMES, values });
  }

  const conn = await pool.getConnection();
  try {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [subdomain]);
    if (existing) {
      conn.release();
      return res.status(400).render('platform/new-store', {
        title: 'Create a new site',
        errors: [`"${subdomain}" is already taken — please choose another store address.`],
        themes: THEMES,
        values,
      });
    }

    await conn.beginTransaction();

    const [storeResult] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status, category) VALUES (?, ?, ?, 'free', 'active', ?)`,
      [storeName, subdomain, theme, category]
    );
    const storeId = storeResult.insertId;

    await conn.query(`INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')`, [req.session.account.id, storeId]);

    // Every store needs a Home page to render "/" from — same backfill as /signup.
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

    req.session.admin = {
      id: req.session.account.id,
      name: req.session.account.name,
      email: req.session.account.email,
      store_id: storeId,
      role: 'admin',
    };
    req.flash('success', `Your site "${storeName}" is ready — add your first products to get started.`);
    res.redirect(storeUrl(req, subdomain, '/admin'));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------- Account profile ----------
router.get('/dashboard/profile', requireAccount, (req, res) => {
  res.render('platform/profile', {
    title: 'Your profile',
    errors: [],
    values: { name: req.session.account.name, email: req.session.account.email },
  });
});

router.post('/dashboard/profile', requireAccount, async (req, res, next) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';
  const confirmNewPassword = req.body.confirmNewPassword || '';

  const values = { name, email };
  const errors = [];

  if (!name) errors.push('Name is required.');
  if (!email || !EMAIL_RE.test(email)) errors.push('A valid email address is required.');

  const wantsPasswordChange = Boolean(newPassword || confirmNewPassword || currentPassword);
  if (wantsPasswordChange) {
    if (newPassword.length < 6) errors.push('New password must be at least 6 characters.');
    if (newPassword !== confirmNewPassword) errors.push('New passwords do not match.');
  }

  if (errors.length) {
    return res.status(400).render('platform/profile', { title: 'Your profile', errors, values });
  }

  try {
    const [[user]] = await pool.query(`SELECT * FROM ${TABLES.users} WHERE id = ?`, [req.session.account.id]);

    if (wantsPasswordChange && !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).render('platform/profile', {
        title: 'Your profile',
        errors: ['Current password is incorrect.'],
        values,
      });
    }

    if (email !== user.email) {
      const [[emailTaken]] = await pool.query(`SELECT id FROM ${TABLES.users} WHERE email = ? AND id != ?`, [email, user.id]);
      if (emailTaken) {
        return res.status(400).render('platform/profile', {
          title: 'Your profile',
          errors: [`"${email}" is already in use by another account.`],
          values,
        });
      }
    }

    if (wantsPasswordChange) {
      const passwordHash = bcrypt.hashSync(newPassword, 10);
      await pool.query(`UPDATE ${TABLES.users} SET name = ?, email = ?, password_hash = ? WHERE id = ?`, [name, email, passwordHash, user.id]);
    } else {
      await pool.query(`UPDATE ${TABLES.users} SET name = ?, email = ? WHERE id = ?`, [name, email, user.id]);
    }

    req.session.account.name = name;
    req.session.account.email = email;
    if (req.session.admin && req.session.admin.id === user.id) {
      req.session.admin.name = name;
      req.session.admin.email = email;
    }

    req.flash('success', 'Profile updated.');
    res.redirect(adminPortalUrl(req, '/dashboard'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
