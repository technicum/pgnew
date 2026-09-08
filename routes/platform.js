const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool, THEMES, RESERVED_SUBDOMAINS, TABLES } = require('../db/database');
const { storeUrl, rootUrl } = require('../middleware/tenant');
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

    const [storeResult] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status) VALUES (?, ?, ?, 'free', 'active')`,
      [storeName, subdomain, theme]
    );
    const storeId = storeResult.insertId;

    const passwordHash = bcrypt.hashSync(password, 10);
    const [adminResult] = await conn.query(
      `INSERT INTO ${TABLES.admins} (store_id, name, email, password_hash) VALUES (?, ?, ?, ?)`,
      [storeId, ownerName, ownerEmail, passwordHash]
    );

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

    req.session.admin = { id: adminResult.insertId, name: ownerName, email: ownerEmail, store_id: storeId };
    req.flash('success', `Welcome to PageZaper, ${ownerName}! Your store "${storeName}" is ready — add your first products to get started.`);
    res.redirect(storeUrl(req, subdomain, '/admin'));
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------- Platform login ----------
// A merchant may not remember their store's subdomain, so this looks their
// account up by email (checking the password against every store they own).
router.get('/login', (req, res) => {
  if (req.store) return res.redirect('/admin/login');
  if (!req.isRootDomain) return res.redirect(rootUrl(req, '/login'));
  res.render('platform/login', { title: 'Log in' });
});

router.post('/login', async (req, res, next) => {
  if (req.store) return res.redirect('/admin/login');
  if (!req.isRootDomain) return res.redirect(rootUrl(req, '/login'));
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.email, a.password_hash, a.store_id, s.subdomain, s.status AS store_status
       FROM ${TABLES.admins} a
       JOIN ${TABLES.stores} s ON s.id = a.store_id
       WHERE a.email = ?`,
      [email]
    );

    const match = rows.find((r) => r.store_status === 'active' && bcrypt.compareSync(password, r.password_hash));

    if (!match) {
      req.flash('error', 'No matching account found. Check your email and password.');
      return res.redirect('/login');
    }

    req.session.admin = { id: match.id, name: match.name, email: match.email, store_id: match.store_id };
    res.redirect(storeUrl(req, match.subdomain, '/admin'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
