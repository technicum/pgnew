const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool, THEMES, isReservedSubdomain, TABLES } = require('../db/database');
const { storeUrl, rootUrl, adminPortalUrl } = require('../middleware/tenant');
const { defaultFields } = require('../lib/sections');
const appsLib = require('../lib/apps');
const crmLib = require('../lib/crm');
const { sanitizeContact } = require('../lib/contacts');

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
  if (req.isAdminPortal) return res.redirect(req.session.account ? '/dashboard' : '/login'); // admin.pagezaper.com -> the account dashboard once logged in, otherwise the staff login form
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
  } else if (isReservedSubdomain(subdomain)) {
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

    req.session.account = { id: userId, name: sessionName, email: ownerEmail };
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
    res.render('platform/dashboard', { title: 'Your stores', account: req.session.account, stores });
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
  res.render('platform/new-store', {
    title: 'Create a new store',
    errors: [],
    themes: THEMES,
    values: { storeName: '', subdomain: '', theme: 'default' },
  });
});

router.post('/dashboard/new-store', requireAccount, async (req, res, next) => {
  const storeName = (req.body.storeName || '').trim();
  let subdomain = (req.body.subdomain || '').trim().toLowerCase();
  if (!subdomain && storeName) subdomain = slugify(storeName);
  const theme = THEMES.includes(req.body.theme) ? req.body.theme : 'default';

  const values = { storeName, subdomain, theme };
  const errors = [];

  if (!storeName) errors.push('Store name is required.');
  if (!subdomain || !SUBDOMAIN_RE.test(subdomain) || subdomain.length < 3) {
    errors.push('Store address must be 3-63 characters: lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.');
  } else if (isReservedSubdomain(subdomain)) {
    errors.push(`"${subdomain}" is reserved — please choose a different store address.`);
  }

  if (errors.length) {
    return res.status(400).render('platform/new-store', { title: 'Create a new store', errors, themes: THEMES, values });
  }

  const conn = await pool.getConnection();
  try {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [subdomain]);
    if (existing) {
      conn.release();
      return res.status(400).render('platform/new-store', {
        title: 'Create a new store',
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
    req.flash('success', `Your store "${storeName}" is ready — add your first products to get started.`);
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

// ---------- CRM ----------
// Lives at the account level (this router), not inside any one store's
// /admin — see lib/crm.js's file comment for why. requireCrm resolves
// whether this login can be here at all (owner of their own CRM, or a
// member of someone else's) and attaches { ownerUserId, role } to
// req.crm; every route below reads req.crm instead of req.session.account
// directly, so "whose CRM am I looking at" stays in exactly one place.
async function requireCrm(req, res, next) {
  try {
    const access = await crmLib.resolveCrmAccess(req.session.account.id);
    if (!access) return res.redirect(adminPortalUrl(req, '/dashboard/crm/activate'));
    req.crm = access;
    next();
  } catch (err) {
    next(err);
  }
}

// Only the owner manages billing and the team roster — a member helps work
// leads/tasks, not who else gets to.
function requireCrmOwner(req, res, next) {
  if (req.crm && req.crm.role === 'owner') return next();
  req.flash('error', "Only the CRM owner can do that.");
  res.redirect(adminPortalUrl(req, '/dashboard/crm/team'));
}

router.get('/dashboard/crm', requireAccount, (req, res) => res.redirect(adminPortalUrl(req, '/dashboard/crm/leads')));

// Shown instead of requireCrm's redirect target when this login has no CRM
// access anywhere yet — lets them activate it for themselves. (A team
// member who hasn't been added by an owner also lands here, same message.)
router.get('/dashboard/crm/activate', requireAccount, async (req, res, next) => {
  try {
    const access = await crmLib.resolveCrmAccess(req.session.account.id);
    if (access) return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    const [[crmApp]] = await pool.query(`SELECT * FROM ${TABLES.apps} WHERE slug = 'crm'`);
    res.render('platform/crm-activate', { title: 'CRM', account: req.session.account, crmApp });
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/activate', requireAccount, async (req, res, next) => {
  try {
    const [[crmApp]] = await pool.query(`SELECT * FROM ${TABLES.apps} WHERE slug = 'crm'`);
    if (!crmApp) {
      req.flash('error', 'CRM app not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard'));
    }
    await appsLib.activateAccountApp(req.session.account.id, crmApp.id);
    req.flash('success', 'CRM activated.');
    res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
  } catch (err) {
    next(err);
  }
});

async function renderCrmContacts(req, res, next, segment) {
  try {
    const storeId = req.query.store ? parseInt(req.query.store, 10) : null;
    const [contacts, stores] = await Promise.all([
      crmLib.listContacts(req.crm.ownerUserId, segment, storeId),
      crmLib.getOwnerStores(req.crm.ownerUserId),
    ]);
    res.render('platform/crm-contacts', {
      title: segment === 'customers' ? 'CRM Customers' : 'Leads',
      segment,
      contacts,
      stores,
      selectedStore: storeId,
      crm: req.crm,
      account: req.session.account,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/dashboard/crm/leads', requireAccount, requireCrm, (req, res, next) => renderCrmContacts(req, res, next, 'leads'));
router.get('/dashboard/crm/customers', requireAccount, requireCrm, (req, res, next) => renderCrmContacts(req, res, next, 'customers'));

router.get('/dashboard/crm/contacts/new', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const stores = await crmLib.getOwnerStores(req.crm.ownerUserId);
    res.render('platform/crm-contact-form', { title: 'New Contact', account: req.session.account, crm: req.crm, contact: null, stores });
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/contacts/new', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const ownerUserId = req.crm.ownerUserId;
    // Site is optional -- an empty selection means a general inquiry not
    // tied to any one site (see pz_contacts.store_id's CREATE TABLE
    // comment). owner_user_id only gets set in that case; a site-attached
    // contact still derives its owner through store_id as before.
    const storeId = req.body.store_id ? parseInt(req.body.store_id, 10) : null;
    if (storeId) {
      const storeIds = await crmLib.getOwnerStoreIds(ownerUserId);
      if (!storeIds.includes(storeId)) {
        req.flash('error', 'Please choose one of your sites.');
        return res.redirect(adminPortalUrl(req, '/dashboard/crm/contacts/new'));
      }
    }
    const data = sanitizeContact(req.body);
    if (!data.name || !data.email) {
      req.flash('error', 'Name and email are required.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/contacts/new'));
    }
    const [[existing]] = await pool.query(
      storeId
        ? `SELECT id FROM ${TABLES.contacts} WHERE store_id = ? AND email = ?`
        : `SELECT id FROM ${TABLES.contacts} WHERE store_id IS NULL AND owner_user_id = ? AND email = ?`,
      [storeId || ownerUserId, data.email]
    );
    if (existing) {
      req.flash('error', `A contact with email "${data.email}" already exists${storeId ? ' for that site' : ''}.`);
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/contacts/new'));
    }
    await pool.query(
      `INSERT INTO ${TABLES.contacts} (store_id, owner_user_id, name, email, phone, source, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [storeId, storeId ? null : ownerUserId, data.name, data.email, data.phone, data.source, JSON.stringify(data.tags)]
    );
    req.flash('success', 'Contact added.');
    res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/crm/contacts/:id', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const contact = await crmLib.getContact(req.crm.ownerUserId, req.params.id);
    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    }
    const [tasks, assignableUsers] = await Promise.all([
      crmLib.listTasksForContact(contact.id),
      crmLib.listAssignableUsers(req.crm.ownerUserId),
    ]);
    res.render('platform/crm-contact', { title: 'Contact', account: req.session.account, crm: req.crm, contact, tasks, assignableUsers });
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/contacts/:id/edit', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const contact = await crmLib.getContact(req.crm.ownerUserId, req.params.id);
    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    }
    const data = sanitizeContact(req.body);
    if (!data.name || !data.email) {
      req.flash('error', 'Name and email are required.');
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
    }
    const [[dupe]] = await pool.query(
      `SELECT id FROM ${TABLES.contacts} WHERE store_id = ? AND email = ? AND id != ?`,
      [contact.store_id, data.email, contact.id]
    );
    if (dupe) {
      req.flash('error', `A contact with email "${data.email}" already exists for that site.`);
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
    }
    await pool.query(
      `UPDATE ${TABLES.contacts} SET name = ?, email = ?, phone = ?, source = ?, tags = ? WHERE id = ?`,
      [data.name, data.email, data.phone, data.source, JSON.stringify(data.tags), contact.id]
    );
    req.flash('success', 'Contact updated.');
    res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/contacts/:id/convert', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const contact = await crmLib.getContact(req.crm.ownerUserId, req.params.id);
    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    }
    if (contact.customer_id) {
      req.flash('error', 'Already a customer.');
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
    }
    await crmLib.convertToCustomer(req.crm.ownerUserId, contact.id);
    req.flash('success', `${contact.name} moved to Customers.`);
    res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
  } catch (err) {
    if (err && err.message) {
      req.flash('error', err.message);
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${req.params.id}`));
    }
    next(err);
  }
});

router.post('/dashboard/crm/contacts/:id/delete', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const contact = await crmLib.getContact(req.crm.ownerUserId, req.params.id);
    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    }
    const segment = contact.customer_id ? 'customers' : 'leads';
    await pool.query(`DELETE FROM ${TABLES.contacts} WHERE id = ?`, [contact.id]);
    req.flash('success', 'Contact deleted.');
    res.redirect(adminPortalUrl(req, `/dashboard/crm/${segment}`));
  } catch (err) {
    next(err);
  }
});

// ---- Tasks (attached to a contact) ----
router.post('/dashboard/crm/contacts/:id/tasks', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const contact = await crmLib.getContact(req.crm.ownerUserId, req.params.id);
    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/leads'));
    }
    const title = (req.body.title || '').trim();
    if (!title) {
      req.flash('error', 'Task title is required.');
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
    }
    const assignedTo = req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
    if (!(await crmLib.isAssignable(req.crm.ownerUserId, assignedTo))) {
      req.flash('error', "That person isn't on this CRM team.");
      return res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
    }
    await crmLib.createTask(req.crm.ownerUserId, contact.id, {
      title,
      due_date: req.body.due_date || null,
      assigned_to: assignedTo,
    });
    req.flash('success', 'Task added.');
    res.redirect(adminPortalUrl(req, `/dashboard/crm/contacts/${contact.id}`));
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/tasks/:id/toggle', requireAccount, requireCrm, async (req, res, next) => {
  try {
    await crmLib.setTaskDone(req.crm.ownerUserId, req.params.id, req.body.done === '1');
    res.redirect(req.get('Referer') || adminPortalUrl(req, '/dashboard/crm/my-tasks'));
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/tasks/:id/delete', requireAccount, requireCrm, async (req, res, next) => {
  try {
    await crmLib.deleteTask(req.crm.ownerUserId, req.params.id);
    res.redirect(req.get('Referer') || adminPortalUrl(req, '/dashboard/crm/my-tasks'));
  } catch (err) {
    next(err);
  }
});

// Landing page for a team member: everything assigned to them, across
// every contact/site under this CRM, in one list.
router.get('/dashboard/crm/my-tasks', requireAccount, requireCrm, async (req, res, next) => {
  try {
    const tasks = await crmLib.listTasksForAssignee(req.crm.ownerUserId, req.session.account.id);
    res.render('platform/crm-my-tasks', { title: 'My Tasks', account: req.session.account, crm: req.crm, tasks });
  } catch (err) {
    next(err);
  }
});

// ---- CRM team (owner only) ----
router.get('/dashboard/crm/team', requireAccount, requireCrm, requireCrmOwner, async (req, res, next) => {
  try {
    const team = await crmLib.listCrmTeam(req.crm.ownerUserId);
    res.render('platform/crm-team', { title: 'CRM Team', account: req.session.account, crm: req.crm, team });
  } catch (err) {
    next(err);
  }
});

router.post('/dashboard/crm/team', requireAccount, requireCrm, requireCrmOwner, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    if (!name || !email) {
      req.flash('error', 'Name and email are required.');
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/team'));
    }
    await crmLib.addCrmMember(req.crm.ownerUserId, { name, email, password: req.body.password, role: req.body.role });
    req.flash('success', `${email} added to your CRM team.`);
    res.redirect(adminPortalUrl(req, '/dashboard/crm/team'));
  } catch (err) {
    if (err && err.message) {
      req.flash('error', err.message);
      return res.redirect(adminPortalUrl(req, '/dashboard/crm/team'));
    }
    next(err);
  }
});

router.post('/dashboard/crm/team/:userId/remove', requireAccount, requireCrm, requireCrmOwner, async (req, res, next) => {
  try {
    await crmLib.removeCrmMember(req.crm.ownerUserId, req.params.userId);
    req.flash('success', 'Removed from your CRM team.');
    res.redirect(adminPortalUrl(req, '/dashboard/crm/team'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
