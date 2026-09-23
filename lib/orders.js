// Shared order-creation logic -- the one place a row gets written to
// pz_orders/pz_order_items and stock gets decremented, so the storefront's
// own checkout (routes/storefront.js) and the admin's WhatsApp quick-create
// form (routes/admin.js) can't drift out of sync with each other. Every
// caller is responsible for its own transaction (conn.beginTransaction() /
// commit() / rollback()) around this call -- this function just runs the
// queries on whatever connection it's given.
const { TABLES } = require('../db/database');

function genOrderNumber() {
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PZ-${Date.now().toString().slice(-6)}${rand}`;
}

// items: [{ id, title, price, quantity }] -- id is nullable (order_items.
// product_id is ON DELETE SET NULL) but every caller in this codebase always
// has a real product row behind each item.
async function createOrder(conn, {
  storeId,
  customerId = null,
  orderNumber,
  customerName,
  customerEmail,
  customerPhone = null,
  shippingAddress,
  shippingCity = null,
  shippingZip = null,
  subtotal,
  discountCode = null,
  discountAmount = 0,
  total,
  status = 'pending',
  paymentMethod = 'cod',
  source = 'storefront',
  items,
}) {
  const [orderResult] = await conn.query(
    `INSERT INTO ${TABLES.orders} (store_id, customer_id, order_number, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_zip, subtotal, discount_code, discount_amount, total, status, payment_method, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [storeId, customerId, orderNumber, customerName, customerEmail, customerPhone, shippingAddress, shippingCity, shippingZip, subtotal, discountCode, discountAmount, total, status, paymentMethod, source]
  );
  const orderId = orderResult.insertId;

  for (const item of items) {
    await conn.query(
      `INSERT INTO ${TABLES.orderItems} (order_id, product_id, title, price, quantity) VALUES (?, ?, ?, ?, ?)`,
      [orderId, item.id, item.title, item.price, item.quantity]
    );
    await conn.query(`UPDATE ${TABLES.products} SET stock = GREATEST(stock - ?, 0) WHERE store_id = ? AND id = ?`, [item.quantity, storeId, item.id]);
  }

  return orderId;
}

module.exports = { createOrder, genOrderNumber };
