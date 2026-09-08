const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES } = require('../db/database');
const { getCartItems, getCartTotals, getStoreCart } = require('../middleware/cart');
const { requireCustomer } = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function genOrderNumber() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PZ-${Date.now().toString().slice(-6)}${rand}`;
}

function toNumber(product) {
  return { ...product, price: Number(product.price), compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null };
}

function orderToNumber(order) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    discount_amount: Number(order.discount_amount || 0),
    total: Number(order.total != null ? order.total : order.subtotal),
  };
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

// Non-home published pages, made available to every view in this router so
// the header nav can link to them (see views/storefront/partials/header.ejs).
router.use(async (req, res, next) => {
  try {
    const [pages] = await pool.query(
      `SELECT id, name, path FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 0 AND status = 'published' ORDER BY name`,
      [req.store.id]
    );
    res.locals.storePages = pages;
  } catch (err) {
    res.locals.storePages = [];
  }
  next();
});

// Renders any page (home or a custom one) by loading its sections from the
// builder and, if one of those sections is a product grid, fetching the
// products it needs. Shared by the "/" route and "/pages/:slug" below so
// both go through the exact same rendering logic.
async function renderStorePage(req, res, next, page) {
  try {
    const storeId = req.store.id;
    const { category } = req.query;

    const [rawSections] = await pool.query(
      `SELECT * FROM ${TABLES.pageSections} WHERE page_id = ? AND hidden = 0 ORDER BY position ASC`,
      [page.id]
    );
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]);

    const needsProducts = rawSections.some((s) => s.type === 'products');
    let allProducts = [];
    if (needsProducts) {
      if (category) {
        [allProducts] = await pool.query(
          `SELECT p.* FROM ${TABLES.products} p
           JOIN ${TABLES.categories} c ON p.category_id = c.id
           WHERE p.store_id = ? AND c.name = ? AND p.status = 'active'
           ORDER BY p.created_at DESC`,
          [storeId, category]
        );
      } else {
        [allProducts] = await pool.query(
          `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' ORDER BY created_at DESC`,
          [storeId]
        );
      }
      allProducts = allProducts.map(toNumber);
    }

    const sections = rawSections.map((s) => {
      const fields = typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields;
      const section = { id: s.id, type: s.type, fields };
      if (s.type === 'products') {
        section.products = allProducts.slice(0, fields.limit || 12);
      }
      return section;
    });

    res.render('storefront/page', {
      title: page.is_home ? `Shop ${req.store.name}` : `${page.name} · ${req.store.name}`,
      sections,
      categories,
      activeCategory: category || null,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- Store home / custom pages ----------
// A store's own subdomain shows its Home page at "/"; "/store" is kept as
// an alias so older links (and the demo store link on the marketing page)
// keep working.
router.get(['/', '/store'], async (req, res, next) => {
  try {
    const [[home]] = await pool.query(`SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 1 LIMIT 1`, [req.store.id]);
    if (!home) return res.status(404).render('storefront/404', { title: 'Page not found' });
    return renderStorePage(req, res, next, home);
  } catch (err) {
    next(err);
  }
});

// Extra pages built with the page builder, e.g. "/pages/about-us".
router.get('/pages/:slug', async (req, res, next) => {
  try {
    const path = `/${req.params.slug}`;
    const [[page]] = await pool.query(
      `SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND path = ? AND status = 'published' LIMIT 1`,
      [req.store.id, path]
    );
    if (!page) return res.status(404).render('storefront/404', { title: 'Page not found' });
    return renderStorePage(req, res, next, page);
  } catch (err) {
    next(err);
  }
});

// ---------- Newsletter ----------
router.post('/newsletter', async (req, res) => {
  const email = (req.body.email || '').trim();
  if (email) {
    try {
      await pool.query(`INSERT IGNORE INTO ${TABLES.newsletterSubscribers} (store_id, email) VALUES (?, ?)`, [req.store.id, email]);
    } catch (err) {
      // swallow — subscribing shouldn't be able to break the page
    }
  }
  req.flash('success', 'Thanks for subscribing!');
  res.redirect(req.get('Referer') || '/');
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

// ---------- Customer accounts ----------
// Separate from admin/staff logins entirely (pz_customers, not pz_users) —
// scoped to this one store, same as an order or a product. req.session.customer
// mirrors req.session.admin's shape/security pattern: a single object
// checked against req.store.id on every request, since the session cookie
// is shared across every *.pagezaper.com subdomain.
router.get('/account/signup', (req, res) => {
  if (req.session.customer && req.session.customer.store_id === req.store.id) return res.redirect('/account');
  res.render('storefront/account/signup', { title: 'Create account', errors: [], values: { name: '', email: '' } });
});

router.post('/account/signup', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const confirmPassword = req.body.confirmPassword || '';
    const values = { name, email };
    const errors = [];

    if (!name) errors.push('Name is required.');
    if (!email || !EMAIL_RE.test(email)) errors.push('A valid email address is required.');
    if (!password || password.length < 6) errors.push('Password must be at least 6 characters.');
    if (password !== confirmPassword) errors.push('Passwords do not match.');

    if (errors.length) {
      return res.status(400).render('storefront/account/signup', { title: 'Create account', errors, values });
    }

    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`, [storeId, email]);
    if (existing) {
      return res.status(400).render('storefront/account/signup', {
        title: 'Create account',
        errors: [`An account with ${email} already exists — log in instead.`],
        values,
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const [result] = await pool.query(
      `INSERT INTO ${TABLES.customers} (store_id, name, email, password_hash) VALUES (?, ?, ?, ?)`,
      [storeId, name, email, passwordHash]
    );

    req.session.customer = { id: result.insertId, name, email, store_id: storeId };
    req.flash('success', `Welcome, ${name}!`);
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});

router.get('/account/login', (req, res) => {
  if (req.session.customer && req.session.customer.store_id === req.store.id) return res.redirect('/account');
  res.render('storefront/account/login', { title: 'Log in' });
});

router.post('/account/login', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const [[customer]] = await pool.query(`SELECT * FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`, [storeId, email]);
    if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/account/login');
    }

    req.session.customer = { id: customer.id, name: customer.name, email: customer.email, store_id: storeId };
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});

router.post('/account/logout', (req, res) => {
  req.session.customer = null;
  res.redirect('/');
});

router.get('/account', requireCustomer, async (req, res, next) => {
  try {
    const [orders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? AND customer_id = ? ORDER BY created_at DESC`,
      [req.store.id, req.session.customer.id]
    );
    res.render('storefront/account/dashboard', {
      title: 'My Account',
      orders: orders.map(orderToNumber),
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

// Looks up an active discount code for this store and computes how much it
// takes off a given subtotal. Returns null (no discount) if the code is
// missing, unknown, or inactive — checkout just proceeds at full price.
async function resolveDiscount(storeId, code, subtotal) {
  if (!code || !code.trim()) return null;
  const [[discount]] = await pool.query(
    `SELECT * FROM ${TABLES.discounts} WHERE store_id = ? AND code = ? AND active = 1`,
    [storeId, code.trim().toUpperCase()]
  );
  if (!discount) return null;

  const value = Number(discount.value);
  const amount = discount.type === 'percent' ? (subtotal * value) / 100 : value;
  return {
    code: discount.code,
    amount: Math.min(Math.round(amount * 100) / 100, subtotal),
  };
}

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

    const { name, email, phone, address, city, zip, discountCode } = req.body;
    if (!name || !email || !address) {
      req.flash('error', 'Please fill in all required fields.');
      conn.release();
      return res.redirect('/checkout');
    }

    const { subtotal } = getCartTotals(items);
    const discount = await resolveDiscount(storeId, discountCode, subtotal);
    const discountAmount = discount ? discount.amount : 0;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;
    const orderNumber = genOrderNumber();

    await conn.beginTransaction();

    // Link to the logged-in customer account for THIS store, if any — guest
    // checkout (no account) still works fine and just leaves this null.
    const customerId = (req.session.customer && req.session.customer.store_id === storeId) ? req.session.customer.id : null;

    const [orderResult] = await conn.query(
      `INSERT INTO ${TABLES.orders} (store_id, customer_id, order_number, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_zip, subtotal, discount_code, discount_amount, total, status, payment_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cod')`,
      [storeId, customerId, orderNumber, name, email, phone || null, address, city || null, zip || null, subtotal, discount ? discount.code : null, discountAmount, total]
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
      discountCode: discount ? discount.code : null,
      discountAmount,
      total,
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
