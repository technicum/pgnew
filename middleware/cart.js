// Cart is stored in session as: { [productId]: quantity }

async function getCartItems(pool, cart) {
  const ids = Object.keys(cart || {});
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const [products] = await pool.query(`SELECT * FROM products WHERE id IN (${placeholders})`, ids);

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
      if (!req.session.cart) req.session.cart = {};
      const items = await getCartItems(pool, req.session.cart);
      const { itemCount } = getCartTotals(items);
      res.locals.cartItemCount = itemCount;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { getCartItems, getCartTotals, attachCartInfo };
