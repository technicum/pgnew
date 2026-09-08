const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');

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
    const [[admin]] = await pool.query('SELECT * FROM admins WHERE store_id = ? AND email = ?', [req.store.id, email]);

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
    const [[{ c: productCount }]] = await pool.query('SELECT COUNT(*) AS c FROM products WHERE store_id = ?', [storeId]);
    const [[{ c: orderCount }]] = await pool.query('SELECT COUNT(*) AS c FROM orders WHERE store_id = ?', [storeId]);
    const [[{ total }]] = await pool.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS total FROM orders WHERE store_id = ? AND status != 'cancelled'`,
      [storeId]
    );
    const [lowStock] = await pool.query(
      `SELECT * FROM products WHERE store_id = ? AND stock <= 5 AND status = 'active' ORDER BY stock ASC LIMIT 5`,
      [storeId]
    );
    const [recentOrders] = await pool.query(
      `SELECT * FROM orders WHERE store_id = ? ORDER BY created_at DESC LIMIT 5`,
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
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
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
    const [categories] = await pool.query('SELECT * FROM categories WHERE store_id = ? ORDER BY name', [req.store.id]);
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
    const [[existing]] = await pool.query('SELECT id FROM products WHERE store_id = ? AND slug = ?', [storeId, slug]);
    if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    await pool.query(
      `INSERT INTO products (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
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
    const [[product]] = await pool.query('SELECT * FROM products WHERE store_id = ? AND id = ?', [req.store.id, req.params.id]);
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/admin/products');
    }
    const [categories] = await pool.query('SELECT * FROM categories WHERE store_id = ? ORDER BY name', [req.store.id]);
    res.render('admin/product-form', { title: 'Edit Product', product: toNumber(product), categories });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/edit', async (req, res, next) => {
  try {
    const { title, description, price, compare_at_price, image_url, category_id, stock, status } = req.body;

    await pool.query(
      `UPDATE products SET title = ?, description = ?, price = ?, compare_at_price = ?, image_url = ?, category_id = ?, stock = ?, status = ?
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
    await pool.query('DELETE FROM products WHERE store_id = ? AND id = ?', [req.store.id, req.params.id]);
    req.flash('success', 'Product deleted.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

// ---------- Orders ----------
router.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query('SELECT * FROM orders WHERE store_id = ? ORDER BY created_at DESC', [req.store.id]);
    res.render('admin/orders', { title: 'Orders', orders: orders.map((o) => ({ ...o, subtotal: Number(o.subtotal) })) });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE store_id = ? AND id = ?', [req.store.id, req.params.id]);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/admin/orders');
    }
    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
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
    await pool.query('UPDATE orders SET status = ? WHERE store_id = ? AND id = ?', [status, req.store.id, req.params.id]);
    req.flash('success', 'Order status updated.');
    res.redirect(`/admin/orders/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
