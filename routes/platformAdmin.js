const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES, PLANS } = require('../db/database');
const { requirePlatformAdmin } = require('../middleware/auth');
const { rootUrl, storeUrl } = require('../middleware/tenant');

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
    const [[store]] = await pool.query(`SELECT * FROM ${TABLES.stores} WHERE id = ?`, [req.params.id]);
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

// ---------- Users (every store admin/manager, across every store) ----------
// A pz_users login can hold a role at more than one store, so this lists
// one row per (user, store, role) — i.e. per pz_user_roles row, not per
// person. The :roleId in the routes below is that pz_user_roles.id.
router.get('/users', async (req, res, next) => {
  try {
    const [users] = await pool.query(
      `SELECT ur.id, u.name, u.email, ur.role, ur.created_at, s.id AS store_id, s.name AS store_name, s.subdomain
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.users} u ON u.id = ur.user_id
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.role IN ('admin', 'manager')
       ORDER BY s.name, ur.created_at`
    );
    res.render('platform-admin/users', { title: 'Users', users });
  } catch (err) {
    next(err);
  }
});

// Logs the platform admin into a store's admin panel as that user, without
// knowing their password. The session gains an `impersonation` marker
// (shown as a banner in views/admin/partials/header.ejs) so it's always
// visible that this isn't a normal store-admin session, with a way back to
// the platform admin.
router.post('/users/:roleId/login-as', async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      `SELECT ur.role, u.id AS user_id, u.name, u.email, s.id AS store_id, s.subdomain, s.status AS store_status
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.users} u ON u.id = ur.user_id
       JOIN ${TABLES.stores} s ON s.id = ur.store_id
       WHERE ur.id = ?`,
      [req.params.roleId]
    );
    if (!row) {
      req.flash('error', 'User not found.');
      return res.redirect('/platform-admin/users');
    }
    if (row.store_status !== 'active') {
      req.flash('error', "That store is suspended — reactivate it first to log in as this user.");
      return res.redirect('/platform-admin/users');
    }

    req.session.admin = { id: row.user_id, name: row.name, email: row.email, store_id: row.store_id, role: row.role };
    req.session.impersonation = { platformAdminId: req.session.platformAdmin.id, platformAdminName: req.session.platformAdmin.name };

    res.redirect(storeUrl(req, row.subdomain, '/admin'));
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
