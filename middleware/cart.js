// Cart is stored in session, namespaced per store, as:
//   req.session.carts = { [storeId]: { [productId]: quantity } }
// so a shopper browsing two different stores in the same browser (the
// session cookie is shared across every *.pagezaper.com subdomain) never
// mixes one store's cart with another's.
const { TABLES } = require('../db/database');

function getStoreCart(req, storeId) {
  if (!req.session.carts) req.session.carts = {};
  if (!req.session.carts[storeId]) req.session.carts[storeId] = {};
  return req.session.carts[storeId];
}

async function getCartItems(pool, storeId, cart) {
  const ids = Object.keys(cart || {});
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const [products] = await pool.query(
    `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id IN (${placeholders})`,
    [storeId, ...ids]
  );

  return products.map((p) => {
    const quantity = cart[p.id];
    const price = Number(p.price);
    return {
      ...p,
      price,
      quantity,
      lineTotal: price * quantity,
    };
  });
}

function getCartTotals(items) {
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
  return { subtotal, itemCount };
}

// Middleware: makes cart item count available to all views (e.g. header badge)
function attachCartInfo(pool) {
  return async (req, res, next) => {
    try {
      if (!req.store) {
        res.locals.cartItemCount = 0;
        return next();
      }
      const cart = getStoreCart(req, req.store.id);
      const items = await getCartItems(pool, req.store.id, cart);
      const { itemCount } = getCartTotals(items);
      res.locals.cartItemCount = itemCount;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { getCartItems, getCartTotals, attachCartInfo, getStoreCart };
