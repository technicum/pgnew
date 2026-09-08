const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES } = require('../db/database');
const { requirePlatformAdmin } = require('../middleware/auth');
const { rootUrl } = require('../middleware/tenant');

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
    const [admins] = await pool.query(`SELECT id, name, email, created_at FROM ${TABLES.admins} WHERE store_id = ? ORDER BY created_at`, [store.id]);
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

module.exports = router;
