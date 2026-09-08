const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
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
    const [[admin]] = await pool.query(`SELECT * FROM ${TABLES.admins} WHERE store_id = ? AND email = ?`, [req.store.id, email]);

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/admin/login');
    }

    req.session.admin = { id: admin.id, name: admin.name, email: admin.email, store_id: admin.store_id };
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.admin = null;
  res.redirect('/admin/login');
});

// Everything below requires admin auth for this store
router.use(requireAdmin);

// ---------- Dashboard ----------
router.get('/', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[{ c: productCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.products} WHERE store_id = ?`, [storeId]);
    const [[{ c: orderCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ?`, [storeId]);
    const [[{ total }]] = await pool.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status != 'cancelled'`,
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
      orderCount,
      revenue: Number(total),
      lowStock: lowStock.map(toNumber),
      recentOrders: recentOrders.map((o) => ({ ...o, subtotal: Number(o.subtotal) })),
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

router.post('/pages/:id/delete', async (req, res, next) => {
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
    res.render('admin/orders', { title: 'Orders', orders: orders.map((o) => ({ ...o, subtotal: Number(o.subtotal) })) });
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
      order: { ...order, subtotal: Number(order.subtotal) },
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

module.exports = router;
