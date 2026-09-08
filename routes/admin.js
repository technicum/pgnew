const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES, THEMES } = require('../db/database');
const { requireAdmin, requireAdminRole } = require('../middleware/auth');
const { rootUrl } = require('../middleware/tenant');
const { SECTION_TYPES, SECTION_TYPE_KEYS, defaultFields, sanitizeFields } = require('../lib/sections');

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function toNumber(product) {
  return {
    ...product,
    price: Number(product.price),
    compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null,
  };
}

function orderToNumber(order) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    discount_amount: Number(order.discount_amount || 0),
    total: Number(order.total != null ? order.total : order.subtotal),
  };
}

// Every route below belongs to a specific store, resolved from the
// subdomain. Without a store (e.g. someone hits pagezaper.com/admin
// directly) there's nothing to log in to.
router.use((req, res, next) => {
  if (!req.store) {
    req.flash('error', "Please visit your store's own address to sign in, e.g. yourstore.pagezaper.com/admin.");
    return res.redirect('/login');
  }
  next();
});

// ---------- Auth ----------
router.get('/login', (req, res) => {
  if (req.session.admin && req.session.admin.store_id === req.store.id) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login' });
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const [[user]] = await pool.query(
      `SELECT u.*, ur.role FROM ${TABLES.users} u
       JOIN ${TABLES.userRoles} ur ON ur.user_id = u.id
       WHERE ur.store_id = ? AND ur.role IN ('admin', 'manager') AND u.email = ?
       ORDER BY (ur.role = 'admin') DESC
       LIMIT 1`,
      [req.store.id, email]
    );

    if (!user) {
      req.flash('error', 'No account found with that email for this store.');
      return res.redirect('/admin/login');
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      req.flash('error', 'Incorrect password.');
      return res.redirect('/admin/login');
    }

    req.session.admin = { id: user.id, name: user.name, email: user.email, store_id: req.store.id, role: user.role };
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.admin = null;
  res.redirect('/admin/login');
});

// Ends a platform-admin "log in as" session (see routes/platformAdmin.js)
// and sends them back to the platform admin dashboard on the root domain.
router.post('/exit-impersonation', (req, res) => {
  if (!req.session.impersonation) return res.redirect('/admin');
  req.session.admin = null;
  req.session.impersonation = null;
  res.redirect(rootUrl(req, '/platform-admin'));
});

// Everything below requires admin auth for this store
router.use(requireAdmin);

// ---------- Dashboard ----------
// Everything on this page is a real number from real data — no fabricated
// "sessions" or "live visitors" counts, since PageZaper doesn't track
// storefront traffic (yet).
router.get('/', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[{ c: productCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.products} WHERE store_id = ?`, [storeId]);

    const [[{ c: orders30, total: revenue30 }]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders}
       WHERE store_id = ? AND status != 'cancelled' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [storeId]
    );

    // "Fulfill orders": placed but not yet shipped. "Capture payments" has no
    // real equivalent yet (checkout is Cash on Delivery only) — the closest
    // honest analogue is COD orders still marked pending, i.e. not yet
    // confirmed/collected.
    const [[{ c: toFulfill }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ? AND status IN ('pending', 'paid')`,
      [storeId]
    );
    const [[{ c: toCollect }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ? AND status = 'pending'`,
      [storeId]
    );

    const [lowStock] = await pool.query(
      `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND stock <= 5 AND status = 'active' ORDER BY stock ASC LIMIT 5`,
      [storeId]
    );
    const [recentOrders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC LIMIT 5`,
      [storeId]
    );

    res.render('admin/dashboard', {
      title: 'Dashboard',
      productCount,
      orders30,
      revenue30: Number(revenue30),
      toFulfill,
      toCollect,
      lowStock: lowStock.map(toNumber),
      recentOrders: recentOrders.map(orderToNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Products ----------
router.get('/products', async (req, res, next) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name AS category_name FROM ${TABLES.products} p
       LEFT JOIN ${TABLES.categories} c ON p.category_id = c.id
       WHERE p.store_id = ?
       ORDER BY p.created_at DESC`,
      [req.store.id]
    );
    res.render('admin/products', { title: 'Products', products: products.map(toNumber) });
  } catch (err) {
    next(err);
  }
});

router.get('/products/new', async (req, res, next) => {
  try {
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [req.store.id]);
    res.render('admin/product-form', { title: 'New Product', product: null, categories });
  } catch (err) {
    next(err);
  }
});

router.post('/products/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { title, description, price, compare_at_price, image_url, category_id, stock, status } = req.body;

    if (!title || !price) {
      req.flash('error', 'Title and price are required.');
      return res.redirect('/admin/products/new');
    }

    let slug = slugify(title);
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [storeId, slug]);
    if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    await pool.query(
      `INSERT INTO ${TABLES.products} (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
        title,
        slug,
        description || '',
        parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        image_url || '',
        category_id || null,
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
      ]
    );

    req.flash('success', 'Product created.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

router.get('/products/:id/edit', async (req, res, next) => {
  try {
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/admin/products');
    }
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [req.store.id]);
    res.render('admin/product-form', { title: 'Edit Product', product: toNumber(product), categories });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/edit', async (req, res, next) => {
  try {
    const { title, description, price, compare_at_price, image_url, category_id, stock, status } = req.body;

    await pool.query(
      `UPDATE ${TABLES.products} SET title = ?, description = ?, price = ?, compare_at_price = ?, image_url = ?, category_id = ?, stock = ?, status = ?
       WHERE store_id = ? AND id = ?`,
      [
        title,
        description || '',
        parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        image_url || '',
        category_id || null,
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
        req.store.id,
        req.params.id,
      ]
    );

    req.flash('success', 'Product updated.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Product deleted.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

// ---------- Pages (builder) ----------
// Loads a page and confirms it belongs to the logged-in store — every
// section route below goes through this so a page/section id can never be
// used to read or edit another merchant's page.
async function loadOwnedPage(storeId, pageId) {
  const [[page]] = await pool.query(`SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND id = ?`, [storeId, pageId]);
  return page;
}

router.get('/pages', async (req, res, next) => {
  try {
    const [pages] = await pool.query(
      `SELECT * FROM ${TABLES.pages} WHERE store_id = ? ORDER BY is_home DESC, name ASC`,
      [req.store.id]
    );
    res.render('admin/pages', { title: 'Pages', pages });
  } catch (err) {
    next(err);
  }
});

router.get('/pages/new', (req, res) => {
  res.render('admin/page-form', { title: 'New Page' });
});

router.post('/pages/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Page name is required.');
      return res.redirect('/admin/pages/new');
    }

    let slug = slugify(name) || 'page';
    let path = `/${slug}`;
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND path = ?`, [storeId, path]);
    if (existing) path = `/${slug}-${Date.now().toString().slice(-4)}`;

    const [result] = await pool.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, ?, ?, 0, 'published')`,
      [storeId, name, path]
    );
    const pageId = result.insertId;

    // Seed a starter hero so the page isn't blank the first time it's opened.
    await pool.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'hero', 0, ?)`,
      [pageId, JSON.stringify(Object.assign(defaultFields('hero'), { heading: name }))]
    );

    req.flash('success', 'Page created.');
    res.redirect(`/admin/pages/${pageId}/edit`);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/:id/edit', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) {
      req.flash('error', 'Page not found.');
      return res.redirect('/admin/pages');
    }
    const [rawSections] = await pool.query(`SELECT * FROM ${TABLES.pageSections} WHERE page_id = ? ORDER BY position ASC`, [page.id]);
    const sections = rawSections.map((s) => ({
      ...s,
      fields: typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields,
    }));
    res.render('admin/builder', { title: `Edit ${page.name}`, page, sections, sectionTypes: SECTION_TYPES });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/publish', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const status = req.body.status === 'draft' ? 'draft' : 'published';
    await pool.query(`UPDATE ${TABLES.pages} SET status = ? WHERE id = ?`, [status, page.id]);
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// Admin only — a Manager can create/edit pages but not delete them.
router.post('/pages/:id/delete', requireAdminRole, async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) {
      req.flash('error', 'Page not found.');
      return res.redirect('/admin/pages');
    }
    if (page.is_home) {
      req.flash('error', "You can't delete the Home page.");
      return res.redirect('/admin/pages');
    }
    await pool.query(`DELETE FROM ${TABLES.pages} WHERE id = ?`, [page.id]);
    req.flash('success', 'Page deleted.');
    res.redirect('/admin/pages');
  } catch (err) {
    next(err);
  }
});

// ---- Section JSON API, used by public/js/builder.js ----
router.post('/pages/:id/sections', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const { type } = req.body;
    if (!SECTION_TYPE_KEYS.includes(type)) return res.status(400).json({ error: 'Unknown section type' });

    const [[{ maxPos }]] = await pool.query(
      `SELECT COALESCE(MAX(position), -1) AS maxPos FROM ${TABLES.pageSections} WHERE page_id = ?`,
      [page.id]
    );
    const fields = defaultFields(type);
    const [result] = await pool.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, ?, ?, ?)`,
      [page.id, type, maxPos + 1, JSON.stringify(fields)]
    );
    res.json({ ok: true, section: { id: result.insertId, type, position: maxPos + 1, fields, hidden: 0 } });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/sections/reorder', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const order = Array.isArray(req.body.order) ? req.body.order : [];
    for (let i = 0; i < order.length; i++) {
      await pool.query(`UPDATE ${TABLES.pageSections} SET position = ? WHERE id = ? AND page_id = ?`, [i, order[i], page.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/sections/:sectionId', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const [[section]] = await pool.query(`SELECT * FROM ${TABLES.pageSections} WHERE id = ? AND page_id = ?`, [req.params.sectionId, page.id]);
    if (!section) return res.status(404).json({ error: 'Section not found' });

    const currentFields = typeof section.fields === 'string' ? JSON.parse(section.fields) : section.fields;
    const nextFields = sanitizeFields(section.type, currentFields, req.body.fields);
    await pool.query(`UPDATE ${TABLES.pageSections} SET fields = ? WHERE id = ?`, [JSON.stringify(nextFields), section.id]);
    res.json({ ok: true, fields: nextFields });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/sections/:sectionId/toggle', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    await pool.query(`UPDATE ${TABLES.pageSections} SET hidden = NOT hidden WHERE id = ? AND page_id = ?`, [req.params.sectionId, page.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/sections/:sectionId/delete', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    await pool.query(`DELETE FROM ${TABLES.pageSections} WHERE id = ? AND page_id = ?`, [req.params.sectionId, page.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Orders ----------
router.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query(`SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC`, [req.store.id]);
    res.render('admin/orders', { title: 'Orders', orders: orders.map(orderToNumber) });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const [[order]] = await pool.query(`SELECT * FROM ${TABLES.orders} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/admin/orders');
    }
    const [items] = await pool.query(`SELECT * FROM ${TABLES.orderItems} WHERE order_id = ?`, [order.id]);
    res.render('admin/order-detail', {
      title: `Order ${order.order_number}`,
      order: orderToNumber(order),
      items: items.map((i) => ({ ...i, price: Number(i.price) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      req.flash('error', 'Invalid status.');
      return res.redirect(`/admin/orders/${req.params.id}`);
    }
    await pool.query(`UPDATE ${TABLES.orders} SET status = ? WHERE store_id = ? AND id = ?`, [status, req.store.id, req.params.id]);
    req.flash('success', 'Order status updated.');
    res.redirect(`/admin/orders/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Customers ----------
// Real accounts from pz_customers (storefront signup/login), not guests
// derived from order history — a guest checkout with no account won't show
// up here, only shoppers who actually created a customer account.
router.get('/customers', async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.created_at,
              COUNT(o.id) AS orderCount,
              COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0) AS totalSpent,
              MAX(o.created_at) AS lastOrderAt
       FROM ${TABLES.customers} c
       LEFT JOIN ${TABLES.orders} o ON o.customer_id = c.id
       WHERE c.store_id = ?
       GROUP BY c.id
       ORDER BY totalSpent DESC`,
      [req.store.id]
    );
    res.render('admin/customers', {
      title: 'Customers',
      customers: customers.map((c) => ({ ...c, totalSpent: Number(c.totalSpent) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Discounts ----------
router.get('/discounts', async (req, res, next) => {
  try {
    const [discounts] = await pool.query(`SELECT * FROM ${TABLES.discounts} WHERE store_id = ? ORDER BY created_at DESC`, [req.store.id]);
    res.render('admin/discounts', { title: 'Discounts', discounts: discounts.map((d) => ({ ...d, value: Number(d.value) })) });
  } catch (err) {
    next(err);
  }
});

router.get('/discounts/new', (req, res) => {
  res.render('admin/discount-form', { title: 'New Discount' });
});

router.post('/discounts/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const code = (req.body.code || '').trim().toUpperCase();
    const type = req.body.type === 'flat' ? 'flat' : 'percent';
    const value = parseFloat(req.body.value);

    if (!code) {
      req.flash('error', 'Code is required.');
      return res.redirect('/admin/discounts/new');
    }
    if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100)) {
      req.flash('error', type === 'percent' ? 'Percent must be between 1 and 100.' : 'Amount must be greater than 0.');
      return res.redirect('/admin/discounts/new');
    }

    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.discounts} WHERE store_id = ? AND code = ?`, [storeId, code]);
    if (existing) {
      req.flash('error', `Code "${code}" already exists.`);
      return res.redirect('/admin/discounts/new');
    }

    await pool.query(`INSERT INTO ${TABLES.discounts} (store_id, code, type, value, active) VALUES (?, ?, ?, ?, 1)`, [storeId, code, type, value]);
    req.flash('success', 'Discount created.');
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

router.post('/discounts/:id/toggle', async (req, res, next) => {
  try {
    await pool.query(`UPDATE ${TABLES.discounts} SET active = NOT active WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

router.post('/discounts/:id/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.discounts} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Discount deleted.');
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

// ---------- Finance ----------
router.get('/finance', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[{ total: revenue }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status != 'cancelled'`,
      [storeId]
    );
    const [[{ total: collected }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status IN ('paid', 'shipped', 'delivered')`,
      [storeId]
    );
    const [[{ total: pendingCOD }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status = 'pending'`,
      [storeId]
    );
    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? GROUP BY status`,
      [storeId]
    );
    const [recentOrders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC LIMIT 10`,
      [storeId]
    );

    res.render('admin/finance', {
      title: 'Finance',
      revenue: Number(revenue),
      collected: Number(collected),
      pendingCOD: Number(pendingCOD),
      byStatus: byStatus.map((s) => ({ ...s, total: Number(s.total) })),
      recentOrders: recentOrders.map(orderToNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Analytics ----------
router.get('/analytics', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [byDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM ${TABLES.orders}
       WHERE store_id = ? AND status != 'cancelled' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day`,
      [storeId]
    );
    const [topProducts] = await pool.query(
      `SELECT oi.title, SUM(oi.quantity) AS unitsSold, SUM(oi.price * oi.quantity) AS revenue
       FROM ${TABLES.orderItems} oi
       JOIN ${TABLES.orders} o ON o.id = oi.order_id
       WHERE o.store_id = ? AND o.status != 'cancelled'
       GROUP BY oi.title
       ORDER BY unitsSold DESC
       LIMIT 5`,
      [storeId]
    );

    const days = byDay.map((d) => ({ day: d.day, orders: d.orders, revenue: Number(d.revenue) }));
    const maxRevenue = Math.max(1, ...days.map((d) => d.revenue));

    res.render('admin/analytics', {
      title: 'Analytics',
      days,
      maxRevenue,
      topProducts: topProducts.map((p) => ({ ...p, revenue: Number(p.revenue) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Markets ----------
// PageZaper only sells in one market today — there's no multi-currency or
// per-country pricing yet, so this is an honest status page, not a
// functional multi-market setup like Shopify's.
router.get('/markets', (req, res) => {
  res.render('admin/markets', { title: 'Markets' });
});

// ---------- Apps ----------
// No app/integration marketplace exists yet — this says so plainly rather
// than showing fake installed apps.
router.get('/apps', (req, res) => {
  res.render('admin/apps', { title: 'Apps' });
});

// ---------- Settings ----------
router.get('/settings', async (req, res, next) => {
  try {
    const [team] = await pool.query(
      `SELECT u.id, u.name, u.email, ur.role, ur.created_at
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.users} u ON u.id = ur.user_id
       WHERE ur.store_id = ?
       ORDER BY (ur.role = 'admin') DESC, u.name ASC`,
      [req.store.id]
    );
    res.render('admin/settings', { title: 'Settings', themes: THEMES, team });
  } catch (err) {
    next(err);
  }
});

// Invite a teammate as Admin or Manager. Admin AND Manager can both do this
// ("can add") — reuses an existing pz_users login by email if that person
// already has an account (e.g. staff at another store) rather than
// overwriting their password.
router.post('/settings/team', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const role = req.body.role === 'manager' ? 'manager' : 'admin';

    if (!name || !email) {
      req.flash('error', 'Name and email are required.');
      return res.redirect('/admin/settings');
    }

    const [[existingUser]] = await pool.query(`SELECT id, name FROM ${TABLES.users} WHERE email = ?`, [email]);

    let userId;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      if (!password || password.length < 6) {
        req.flash('error', 'Password must be at least 6 characters for a new team member.');
        return res.redirect('/admin/settings');
      }
      const passwordHash = bcrypt.hashSync(password, 10);
      const [result] = await pool.query(`INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, passwordHash]);
      userId = result.insertId;
    }

    const [[existingRole]] = await pool.query(
      `SELECT id FROM ${TABLES.userRoles} WHERE user_id = ? AND store_id = ? AND role = ?`,
      [userId, storeId, role]
    );
    if (existingRole) {
      req.flash('error', `${email} already has ${role} access to this store.`);
      return res.redirect('/admin/settings');
    }

    await pool.query(`INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, ?)`, [userId, storeId, role]);
    req.flash('success', `${email} added as ${role}.`);
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

// Admin only — a Manager can invite teammates but not remove them.
router.post('/settings/team/:userId/delete', requireAdminRole, async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[role]] = await pool.query(
      `SELECT * FROM ${TABLES.userRoles} WHERE user_id = ? AND store_id = ?`,
      [req.params.userId, storeId]
    );
    if (!role) {
      req.flash('error', 'Team member not found.');
      return res.redirect('/admin/settings');
    }

    if (role.role === 'admin') {
      const [[{ c: adminCount }]] = await pool.query(
        `SELECT COUNT(*) AS c FROM ${TABLES.userRoles} WHERE store_id = ? AND role = 'admin'`,
        [storeId]
      );
      if (adminCount <= 1) {
        req.flash('error', "Can't remove the only Admin — the store would be locked out.");
        return res.redirect('/admin/settings');
      }
    }

    await pool.query(`DELETE FROM ${TABLES.userRoles} WHERE id = ?`, [role.id]);
    req.flash('success', 'Team member removed.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/store', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const theme = THEMES.includes(req.body.theme) ? req.body.theme : req.store.theme;

    if (!name) {
      req.flash('error', 'Store name is required.');
      return res.redirect('/admin/settings');
    }

    await pool.query(`UPDATE ${TABLES.stores} SET name = ?, theme = ? WHERE id = ?`, [name, theme, req.store.id]);
    req.flash('success', 'Store settings updated.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const [[user]] = await pool.query(`SELECT * FROM ${TABLES.users} WHERE id = ?`, [req.session.admin.id]);

    if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/settings');
    }
    if (!newPassword || newPassword.length < 6) {
      req.flash('error', 'New password must be at least 6 characters.');
      return res.redirect('/admin/settings');
    }
    if (newPassword !== confirmPassword) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/admin/settings');
    }

    // This changes the pz_users password globally — note it applies to every
    // store this person has a role at, not just this one, since logins are
    // shared across stores now.
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await pool.query(`UPDATE ${TABLES.users} SET password_hash = ? WHERE id = ?`, [passwordHash, user.id]);
    req.flash('success', 'Password changed.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
