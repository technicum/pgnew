const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');
const { getCartItems, getCartTotals } = require('../middleware/cart');

function genOrderNumber() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PZ-${Date.now().toString().slice(-6)}${rand}`;
}

function toNumber(product) {
  return { ...product, price: Number(product.price), compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null };
}

// ---------- Home / product listing ----------
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    const [categories] = await pool.query('SELECT * FROM categories ORDER BY name');

    let products;
    if (category) {
      [products] = await pool.query(
        `SELECT p.* FROM products p
         JOIN categories c ON p.category_id = c.id
         WHERE c.name = ? AND p.status = 'active'
         ORDER BY p.created_at DESC`,
        [category]
      );
    } else {
      [products] = await pool.query(`SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC`);
    }

    res.render('storefront/home', {
      title: 'Shop everything you need',
      products: products.map(toNumber),
      categories,
      activeCategory: category || null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Product detail ----------
router.get('/products/:slug', async (req, res, next) => {
  try {
    const [[product]] = await pool.query('SELECT * FROM products WHERE slug = ?', [req.params.slug]);
    if (!product) {
      return res.status(404).render('storefront/404', { title: 'Product not found' });
    }
    const [related] = await pool.query(
      `SELECT * FROM products WHERE category_id = ? AND id != ? AND status = 'active' LIMIT 4`,
      [product.category_id, product.id]
    );

    res.render('storefront/product', {
      title: product.title,
      product: toNumber(product),
      related: related.map(toNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Cart ----------
router.get('/cart', async (req, res, next) => {
  try {
    const items = await getCartItems(pool, req.session.cart);
    const { subtotal } = getCartTotals(items);
    res.render('storefront/cart', { title: 'Your Cart', items, subtotal });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/add', async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);

    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('back');
    }

    if (!req.session.cart) req.session.cart = {};
    const current = req.session.cart[productId] || 0;
    const newQty = Math.min(current + qty, product.stock);
    req.session.cart[productId] = newQty;

    req.flash('success', `${product.title} added to cart.`);
    res.redirect(req.body.redirectTo || '/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/update', async (req, res, next) => {
  try {
    const { productId, quantity } = req.body;
    const qty = parseInt(quantity, 10);

    if (!req.session.cart) req.session.cart = {};

    if (!qty || qty <= 0) {
      delete req.session.cart[productId];
    } else {
      const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);
      req.session.cart[productId] = product ? Math.min(qty, product.stock) : qty;
    }

    res.redirect('/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  if (req.session.cart) delete req.session.cart[productId];
  res.redirect('/cart');
});

// ---------- Checkout ----------
router.get('/checkout', async (req, res, next) => {
  try {
    const items = await getCartItems(pool, req.session.cart);
    if (items.length === 0) {
      req.flash('error', 'Your cart is empty.');
      return res.redirect('/cart');
    }
    const { subtotal } = getCartTotals(items);
    res.render('storefront/checkout', { title: 'Checkout', items, subtotal });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const items = await getCartItems(pool, req.session.cart);
    if (items.length === 0) {
      req.flash('error', 'Your cart is empty.');
      conn.release();
      return res.redirect('/cart');
    }

    const { name, email, phone, address, city, zip } = req.body;
    if (!name || !email || !address) {
      req.flash('error', 'Please fill in all required fields.');
      conn.release();
      return res.redirect('/checkout');
    }

    const { subtotal } = getCartTotals(items);
    const orderNumber = genOrderNumber();

    await conn.beginTransaction();

    const [orderResult] = await conn.query(
      `INSERT INTO orders (order_number, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_zip, subtotal, status, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cod')`,
      [orderNumber, name, email, phone || null, address, city || null, zip || null, subtotal]
    );
    const orderId = orderResult.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, title, price, quantity) VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.id, item.title, item.price, item.quantity]
      );
      await conn.query(`UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?`, [item.quantity, item.id]);
    }

    await conn.commit();
    req.session.cart = {};

    res.render('storefront/order-confirmation', {
      title: 'Order Confirmed',
      orderNumber,
      name,
      email,
      subtotal,
      items,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
