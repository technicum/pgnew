const express = require('express');
const router = express.Router();
const { pool, TABLES } = require('../db/database');
const { getCartItems, getCartTotals, getStoreCart } = require('../middleware/cart');

function genOrderNumber() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PZ-${Date.now().toString().slice(-6)}${rand}`;
}

function toNumber(product) {
  return { ...product, price: Number(product.price), compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null };
}

// Everything in this router belongs to a specific store, resolved from the
// subdomain by middleware/tenant.js. On the root domain (or an unknown/
// suspended subdomain) there's no storefront to show.
router.use((req, res, next) => {
  if (req.store) return next();
  if (req.unknownSubdomain) {
    return res.status(404).render('storefront/404', { title: 'Store not found' });
  }
  return res.status(404).render('storefront/404', { title: 'Page not found' });
});

// ---------- Store / product listing ----------
// A store's own subdomain shows its home page at "/"; "/store" is kept as
// an alias so older links (and the demo store link on the marketing page)
// keep working.
router.get(['/', '/store'], async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { category } = req.query;
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]);

    let products;
    if (category) {
      [products] = await pool.query(
        `SELECT p.* FROM ${TABLES.products} p
         JOIN ${TABLES.categories} c ON p.category_id = c.id
         WHERE p.store_id = ? AND c.name = ? AND p.status = 'active'
         ORDER BY p.created_at DESC`,
        [storeId, category]
      );
    } else {
      [products] = await pool.query(
        `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' ORDER BY created_at DESC`,
        [storeId]
      );
    }

    res.render('storefront/home', {
      title: `Shop ${req.store.name}`,
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
    const storeId = req.store.id;
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [storeId, req.params.slug]);
    if (!product) {
      return res.status(404).render('storefront/404', { title: 'Product not found' });
    }
    const [related] = await pool.query(
      `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND category_id = ? AND id != ? AND status = 'active' LIMIT 4`,
      [storeId, product.category_id, product.id]
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
    const cart = getStoreCart(req, req.store.id);
    const items = await getCartItems(pool, req.store.id, cart);
    const { subtotal } = getCartTotals(items);
    res.render('storefront/cart', { title: 'Your Cart', items, subtotal });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/add', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { productId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [storeId, productId]);

    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('back');
    }

    const cart = getStoreCart(req, storeId);
    const current = cart[productId] || 0;
    const newQty = Math.min(current + qty, product.stock);
    cart[productId] = newQty;

    req.flash('success', `${product.title} added to cart.`);
    res.redirect(req.body.redirectTo || '/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/update', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { productId, quantity } = req.body;
    const qty = parseInt(quantity, 10);
    const cart = getStoreCart(req, storeId);

    if (!qty || qty <= 0) {
      delete cart[productId];
    } else {
      const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [storeId, productId]);
      cart[productId] = product ? Math.min(qty, product.stock) : qty;
    }

    res.redirect('/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  const cart = getStoreCart(req, req.store.id);
  delete cart[productId];
  res.redirect('/cart');
});

// ---------- Checkout ----------
router.get('/checkout', async (req, res, next) => {
  try {
    const cart = getStoreCart(req, req.store.id);
    const items = await getCartItems(pool, req.store.id, cart);
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
  const storeId = req.store.id;
  const conn = await pool.getConnection();
  try {
    const cart = getStoreCart(req, storeId);
    const items = await getCartItems(pool, storeId, cart);
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
      `INSERT INTO ${TABLES.orders} (store_id, order_number, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_zip, subtotal, status, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cod')`,
      [storeId, orderNumber, name, email, phone || null, address, city || null, zip || null, subtotal]
    );
    const orderId = orderResult.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO ${TABLES.orderItems} (order_id, product_id, title, price, quantity) VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.id, item.title, item.price, item.quantity]
      );
      await conn.query(`UPDATE ${TABLES.products} SET stock = GREATEST(stock - ?, 0) WHERE store_id = ? AND id = ?`, [item.quantity, storeId, item.id]);
    }

    await conn.commit();
    req.session.carts[storeId] = {};

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
