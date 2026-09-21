const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { pool, TABLES, PLANS, THEMES, isReservedSubdomain } = require('../db/database');
const { requirePlatformAdmin } = require('../middleware/auth');
const { rootUrl, storeUrl, adminPortalUrl } = require('../middleware/tenant');

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Route params arrive as strings; anything that isn't a plain positive
// integer can't be a row id, so treat it as "not found" up front.
function parseId(value) {
  return /^\d+$/.test(String(value)) ? parseInt(value, 10) : null;
}

// The platform admin only makes sense on the root domain (pagezaper.com),
// never on a store's own subdomain — send those requests back to the root.
router.use((req, res, next) => {
  if (req.store) {
    return res.redirect(rootUrl(req, `/platform-admin${req.path === '/' ? '' : req.path}`));
  }
  next();
});

router.get('/login', (req, res) => {
  if (req.session.platformAdmin) return res.redirect('/platform-admin');
  res.render('platform-admin/login', { title: 'Platform Admin Login' });
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const [[admin]] = await pool.query(`SELECT * FROM ${TABLES.platformAdmins} WHERE email = ?`, [email]);

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/platform-admin/login');
    }

    req.session.platformAdmin = { id: admin.id, name: admin.name, email: admin.email };
    res.redirect('/platform-admin');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.platformAdmin = null;
  res.redirect('/platform-admin/login');
});

// Everything below requires the platform admin to be logged in.
router.use(requirePlatformAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [stores] = await pool.query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM ${TABLES.products} p WHERE p.store_id = s.id) AS productCount,
        (SELECT COUNT(*) FROM ${TABLES.orders} o WHERE o.store_id = s.id) AS orderCount
       FROM ${TABLES.stores} s
       ORDER BY s.created_at DESC`
    );
    const [[{ c: totalStores }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.stores}`);
    const [[{ c: activeStores }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.stores} WHERE status = 'active'`);
    const [[{ c: totalOrders }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.orders}`);

    res.render('platform-admin/dashboard', {
      title: 'All Stores',
      stores,
      totalStores,
      activeStores,
      totalOrders,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/stores/:id', async (req, res, next) => {
  try {
    const [[store]] = await pool.query(`SELECT * FROM ${TABLES.stores} WHERE id = ?`, [parseId(req.params.id)]);
    if (!store) {
      req.flash('error', 'Store not found.');
      return res.redirect('/platform-admin');
    }
    const [admins] = await pool.query(
      `SELECT ur.id, u.name, u.email, ur.role, ur.created_at
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.users} u ON u.id = ur.user_id
       WHERE ur.store_id = ? AND ur.role IN ('admin', 'manager')
       ORDER BY (ur.role = 'admin') DESC, ur.created_at`,
      [store.id]
    );
    const [[{ c: productCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.products} WHERE store_id = ?`, [store.id]);
    const [[{ c: orderCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ?`, [store.id]);
    const [[{ total }]] = await pool.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status != 'cancelled'`,
      [store.id]
    );

    res.render('platform-admin/store-detail', {
      title: store.name,
      store,
      admins,
      productCount,
      orderCount,
      revenue: Number(total),
      plans: PLANS,
      // A store on a theme no longer in THEMES still needs to show as
      // selected rather than silently flipping to the first option on save.
      themes: THEMES.includes(store.theme) ? THEMES : [store.theme, ...THEMES],
      storefrontUrl: storeUrl(req, store.subdomain, '/'),
      canDelete: !isReservedSubdomain(store.subdomain),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/stores/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['active', 'suspended'];
    if (!allowed.includes(status)) {
      req.flash('error', 'Invalid status.');
      return res.redirect(`/platform-admin/stores/${req.params.id}`);
    }
    await pool.query(`UPDATE ${TABLES.stores} SET status = ? WHERE id = ?`, [status, req.params.id]);
    req.flash('success', `Store ${status === 'active' ? 'activated' : 'suspended'}.`);
    res.redirect(`/platform-admin/stores/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/stores/:id/plan', async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!PLANS.includes(plan)) {
      req.flash('error', 'Invalid plan.');
      return res.redirect(`/platform-admin/stores/${req.params.id}`);
    }
    await pool.query(`UPDATE ${TABLES.stores} SET plan = ? WHERE id = ?`, [plan, req.params.id]);
    req.flash('success', `Plan changed to ${plan}.`);
    res.redirect(`/platform-admin/stores/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/stores/:id/edit', async (req, res, next) => {
  try {
    const storeId = parseId(req.params.id);
    const back = `/platform-admin/stores/${storeId}`;
    const [[store]] = await pool.query(`SELECT * FROM ${TABLES.stores} WHERE id = ?`, [storeId]);
    if (!store) {
      req.flash('error', 'Store not found.');
      return res.redirect('/platform-admin');
    }

    const name = String(req.body.name || '').trim().slice(0, 255);
    const subdomain = String(req.body.subdomain || '').trim().toLowerCase();
    const theme = String(req.body.theme || '');

    if (!name) {
      req.flash('error', 'Store name is required.');
      return res.redirect(back);
    }
    // Only validate the subdomain when it's actually changing — a store that
    // already sits on a reserved word (the demo store) must stay editable.
    if (subdomain !== store.subdomain) {
      if (!SUBDOMAIN_RE.test(subdomain)) {
        req.flash('error', 'Subdomain must be 3-63 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen.');
        return res.redirect(back);
      }
      if (isReservedSubdomain(subdomain)) {
        req.flash('error', `"${subdomain}" is reserved — choose another subdomain.`);
        return res.redirect(back);
      }
      const [[taken]] = await pool.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ? AND id != ?`, [subdomain, store.id]);
      if (taken) {
        req.flash('error', `The subdomain "${subdomain}" is already in use.`);
        return res.redirect(back);
      }
    }
    if (theme !== store.theme && !THEMES.includes(theme)) {
      req.flash('error', 'Invalid theme.');
      return res.redirect(back);
    }

    try {
      await pool.query(`UPDATE ${TABLES.stores} SET name = ?, subdomain = ?, theme = ? WHERE id = ?`, [name, subdomain, theme, store.id]);
    } catch (err) {
      // Lost a race for the same subdomain between the check above and here.
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      req.flash('error', `The subdomain "${subdomain}" is already in use.`);
      return res.redirect(back);
    }
    req.flash('success', 'Store updated.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Permanent. Every store-scoped table cascades off pz_stores (products,
// orders, pages, contacts, ...), so the DELETE below is the whole database
// cleanup; only the uploaded files on disk need removing by hand. The
// owner's pz_users login is left alone — it may hold roles at other stores.
router.post('/stores/:id/delete', async (req, res, next) => {
  try {
    const storeId = parseId(req.params.id);
    const [[store]] = await pool.query(`SELECT * FROM ${TABLES.stores} WHERE id = ?`, [storeId]);
    if (!store) {
      req.flash('error', 'Store not found.');
      return res.redirect('/platform-admin');
    }
    const back = `/platform-admin/stores/${store.id}`;
    // The platform's own demo/showcase stores back the theme marketplace.
    if (isReservedSubdomain(store.subdomain)) {
      req.flash('error', "That's a reserved platform store and can't be deleted here.");
      return res.redirect(back);
    }
    if (String(req.body.confirm || '').trim().toLowerCase() !== store.subdomain) {
      req.flash('error', `Type "${store.subdomain}" exactly to confirm deleting this store.`);
      return res.redirect(back);
    }

    await pool.query(`DELETE FROM ${TABLES.stores} WHERE id = ?`, [store.id]);
    try {
      fs.rmSync(path.join(__dirname, '..', 'public', 'uploads', `store-${store.id}`), { recursive: true, force: true });
    } catch (err) {
      console.error(`Deleted store ${store.id} but could not remove its uploads folder:`, err);
    }
    req.flash('success', `Store "${store.name}" was deleted.`);
    res.redirect('/platform-admin');
  } catch (err) {
    next(err);
  }
});

// Shortcut for "log in as this store's owner": the earliest Admin role, so
// the platform admin doesn't have to hunt through the team list first.
router.post('/stores/:id/login-as-owner', async (req, res, next) => {
  try {
    const storeId = parseId(req.params.id);
    const [[owner]] = await pool.query(
      `SELECT id FROM ${TABLES.userRoles} WHERE store_id = ? AND role = 'admin' ORDER BY created_at, id LIMIT 1`,
      [storeId]
    );
    if (!owner) {
      req.flash('error', 'That store has no admin to log in as.');
      return res.redirect(`/platform-admin/stores/${storeId}`);
    }
    await loginAsRole(req, res, owner.id, `/platform-admin/stores/${storeId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Plans overview ----------
router.get('/plans', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT plan, COUNT(*) AS storeCount FROM ${TABLES.stores} GROUP BY plan`
    );
    const counts = {};
    rows.forEach((r) => { counts[r.plan] = r.storeCount; });
    const plans = PLANS.map((p) => ({ name: p, storeCount: counts[p] || 0 }));

    res.render('platform-admin/plans', { title: 'Plans', plans });
  } catch (err) {
    next(err);
  }
});

// ---------- Users ----------
// A pz_users row is one login ("account"); it can hold a role at several
// stores through pz_user_roles. The list below is one row per account, the
// detail page shows that account's per-store roles. The :roleId in the
// login-as/delete routes further down is a pz_user_roles.id, not a user id.
router.get('/users', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const params = [];
    let where = '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      where = 'WHERE u.name LIKE ? OR u.email LIKE ?';
      params.push(like, like);
    }
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at,
              COUNT(DISTINCT s.id) AS site_count,
              GROUP_CONCAT(DISTINCT s.name ORDER BY s.name SEPARATOR ', ') AS site_names
       FROM ${TABLES.users} u
       LEFT JOIN ${TABLES.userRoles} ur ON ur.user_id = u.id AND ur.role IN ('admin', 'manager')
       LEFT JOIN ${TABLES.stores} s ON s.id = ur.store_id
       ${where}
       GROUP BY u.id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT 200`,
      params
    );
    res.render('platform-admin/users', { title: 'Users', users, q });
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, name, email, created_at FROM ${TABLES.users} WHERE id = ?`,
      [parseId(req.params.id)]
    );
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }
    const [roles] = await pool.query(
      `SELECT ur.id, ur.role, ur.created_at, s.id AS store_id, s.name AS store_name, s.subdomain, s.status AS store_status
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.user_id = ? AND ur.role IN ('admin', 'manager')
       ORDER BY (ur.role = 'admin') DESC, s.name`,
      [user.id]
    );
    res.render('platform-admin/user-detail', { title: user.name, activeNav: 'users', user, roles });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/edit', async (req, res, next) => {
  try {
    const userId = parseId(req.params.id);
    const back = `/platform-admin/users/${userId}`;
    const [[user]] = await pool.query(`SELECT id FROM ${TABLES.users} WHERE id = ?`, [userId]);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }

    const name = String(req.body.name || '').trim().slice(0, 255);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 255);
    if (!name) {
      req.flash('error', 'Name is required.');
      return res.redirect(back);
    }
    if (!EMAIL_RE.test(email)) {
      req.flash('error', 'Enter a valid email address.');
      return res.redirect(back);
    }
    const [[taken]] = await pool.query(`SELECT id FROM ${TABLES.users} WHERE email = ? AND id != ?`, [email, user.id]);
    if (taken) {
      req.flash('error', `Another account already uses ${email}.`);
      return res.redirect(back);
    }

    try {
      await pool.query(`UPDATE ${TABLES.users} SET name = ?, email = ? WHERE id = ?`, [name, email, user.id]);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      req.flash('error', `Another account already uses ${email}.`);
      return res.redirect(back);
    }
    req.flash('success', 'User updated.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Sets a new password without needing the old one (the "forgot password"
// case). Existing logins keep working until they expire — sessions are not
// tied to the password hash.
router.post('/users/:id/password', async (req, res, next) => {
  try {
    const userId = parseId(req.params.id);
    const back = `/platform-admin/users/${userId}`;
    const [[user]] = await pool.query(`SELECT id FROM ${TABLES.users} WHERE id = ?`, [userId]);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }

    const password = String(req.body.password || '');
    if (password.length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect(back);
    }
    if (password !== String(req.body.confirmPassword || '')) {
      req.flash('error', "Passwords don't match.");
      return res.redirect(back);
    }

    await pool.query(`UPDATE ${TABLES.users} SET password_hash = ? WHERE id = ?`, [bcrypt.hashSync(password, 10), user.id]);
    req.flash('success', 'Password changed.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// Logs the platform admin into a merchant's account dashboard (the "Your
// sites" screen on admin.<domain>) as that person, without their password.
// Sets the same account-level session a normal login does, plus the
// `impersonation` marker that drives the "you're logged in as ..." banner
// and its way back (see views/platform/partials/header.ejs).
router.post('/users/:id/login-as-account', async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, name, email FROM ${TABLES.users} WHERE id = ?`,
      [parseId(req.params.id)]
    );
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }

    req.session.account = { id: user.id, name: user.name, email: user.email };
    req.session.admin = null;
    // viaAccount: they can move between the dashboard and this account's
    // stores, so the store admin keeps its "Exit store" link (see
    // views/admin/partials/header.ejs).
    req.session.impersonation = {
      platformAdminId: req.session.platformAdmin.id,
      platformAdminName: req.session.platformAdmin.name,
      viaAccount: true,
    };

    res.redirect(adminPortalUrl(req, '/dashboard'));
  } catch (err) {
    next(err);
  }
});

// Logs the platform admin into a store's admin panel as that user, without
// knowing their password. The session gains an `impersonation` marker
// (shown as a banner in views/admin/partials/header.ejs) so it's always
// visible that this isn't a normal store-admin session, with a way back to
// the platform admin. `back` is where to return if that role can't be used.
async function loginAsRole(req, res, roleId, back) {
  const [[row]] = await pool.query(
    `SELECT ur.role, u.id AS user_id, u.name, u.email, s.id AS store_id, s.subdomain, s.status AS store_status
     FROM ${TABLES.userRoles} ur
     JOIN ${TABLES.users} u ON u.id = ur.user_id
     JOIN ${TABLES.stores} s ON s.id = ur.store_id
     WHERE ur.id = ?`,
    [roleId]
  );
  if (!row) {
    req.flash('error', 'User not found.');
    return res.redirect(back);
  }
  if (row.store_status !== 'active') {
    req.flash('error', "That store is suspended — reactivate it first to log in as this user.");
    return res.redirect(back);
  }

  req.session.admin = { id: row.user_id, name: row.name, email: row.email, store_id: row.store_id, role: row.role };
  req.session.impersonation = { platformAdminId: req.session.platformAdmin.id, platformAdminName: req.session.platformAdmin.name };

  res.redirect(storeUrl(req, row.subdomain, '/admin'));
}

router.post('/users/:roleId/login-as', async (req, res, next) => {
  try {
    await loginAsRole(req, res, parseId(req.params.roleId), '/platform-admin/users');
  } catch (err) {
    next(err);
  }
});

router.post('/users/:roleId/delete', async (req, res, next) => {
  try {
    const [[role]] = await pool.query(`SELECT * FROM ${TABLES.userRoles} WHERE id = ?`, [req.params.roleId]);
    if (!role) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }
    if (role.role === 'admin') {
      const [[{ c: adminCount }]] = await pool.query(
        `SELECT COUNT(*) AS c FROM ${TABLES.userRoles} WHERE store_id = ? AND role = 'admin'`,
        [role.store_id]
      );
      if (adminCount <= 1) {
        req.flash('error', "Can't delete the only admin of a store — that store would be locked out.");
        return res.redirect('/platform-admin/users');
      }
    }

    // Removes this person's access to this one store only — their pz_users
    // login (and any role at other stores) stays intact.
    await pool.query(`DELETE FROM ${TABLES.userRoles} WHERE id = ?`, [role.id]);
    req.flash('success', 'User deleted.');
    res.redirect('/platform-admin/users');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
