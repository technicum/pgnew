// Payment pages — a single thing a merchant sells from a link
// (meera.pagezaper.com/pay/<slug>): a fixed price or pay-what-you-want,
// optionally in a quantity, with coupon codes. A paid order (lib/orders.js)
// reveals the delivery link and drops the buyer into the Audience list.
//
// All money is stored and computed in paise (integer) — never floats — and
// the price a buyer pays is always recomputed here on the server from the
// page + coupon, whatever the browser sent (see quote()).
//
// Same lazy-migration pattern as lib/leadMagnets.js: the tables are
// created on first use, no separate migration step.
const pool = require('./db');
const {
  normalizeSlug,
  slugify,
  sanitizeAccentColor,
  sanitizeCoverType,
  sanitizeCoverColor,
  sanitizeCoverUrl,
} = require('./leadMagnets');

const TABLE = 'PDZ_payment_pages';
const COUPONS = 'PDZ_coupons';

const PRICE_TYPES = new Set(['fixed', 'flexible']);
const MAX_PRICE = 500000 * 100; // ₹5,00,000 in paise
const MAX_QUANTITY_LIMIT = 100;

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(200) NOT NULL DEFAULT '',
          slug VARCHAR(80) NOT NULL,
          description VARCHAR(1000) NOT NULL DEFAULT '',
          price_type VARCHAR(10) NOT NULL DEFAULT 'fixed',
          price INT NOT NULL DEFAULT 0,
          min_price INT NOT NULL DEFAULT 0,
          suggested_price INT NOT NULL DEFAULT 0,
          allow_quantity TINYINT(1) NOT NULL DEFAULT 0,
          max_quantity INT NOT NULL DEFAULT 10,
          cta_text VARCHAR(60) NOT NULL DEFAULT 'Pay now',
          delivery_url VARCHAR(500) NOT NULL DEFAULT '',
          success_message VARCHAR(300) NOT NULL DEFAULT '',
          collect_phone TINYINT(1) NOT NULL DEFAULT 1,
          accent_color VARCHAR(7) NOT NULL DEFAULT '#1261ef',
          show_cover TINYINT(1) NOT NULL DEFAULT 1,
          cover_type VARCHAR(10) NOT NULL DEFAULT 'art',
          cover_image_url VARCHAR(500) NOT NULL DEFAULT '',
          cover_video_url VARCHAR(500) NOT NULL DEFAULT '',
          cover_color VARCHAR(7) NOT NULL DEFAULT '',
          visible TINYINT(1) NOT NULL DEFAULT 1,
          view_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_user_slug (user_id, slug),
          INDEX (user_id)
        )
      `);
      // page_id NULL = the code works on every one of the merchant's pages.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${COUPONS} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          code VARCHAR(30) NOT NULL,
          discount_type VARCHAR(10) NOT NULL DEFAULT 'percent',
          discount_value INT NOT NULL DEFAULT 0,
          page_id INT NULL DEFAULT NULL,
          max_uses INT NULL DEFAULT NULL,
          used_count INT NOT NULL DEFAULT 0,
          expires_at DATE NULL DEFAULT NULL,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_user_code (user_id, code),
          INDEX (user_id)
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

function fieldError(message, code = 'INVALID_FIELD') {
  const err = new Error(message);
  err.code = code;
  return err;
}

// --- money ------------------------------------------------------------

// "499", "499.5", "₹1,499.00" → paise. Returns null when it isn't a
// sensible amount (blank, negative, more than two decimals' worth).
function rupeesToPaise(raw) {
  const value = String(raw ?? '').replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const paise = Math.round(Number(value) * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

function formatINR(paise) {
  const rupees = (Number(paise) || 0) / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// Accepts paise already (from the builder, which converts) — checked here
// so a hand-made request can't store a negative or absurd price.
function sanitizePaise(raw, { min = 0, label = 'Price' } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > MAX_PRICE) {
    throw fieldError(min > 0
      ? `${label} needs to be between ${formatINR(min)} and ${formatINR(MAX_PRICE)}.`
      : `${label} can’t be more than ${formatINR(MAX_PRICE)}.`);
  }
  return n;
}

// --- pages --------------------------------------------------------------

const PAGE_COLUMNS = `id, user_id, title, slug, description, price_type, price, min_price, suggested_price,
  allow_quantity, max_quantity, cta_text, delivery_url, success_message, collect_phone, accent_color,
  show_cover, cover_type, cover_image_url, cover_video_url, cover_color, visible, view_count, created_at`;

// Every field the builder can send, checked and normalized. `partial`
// (an edit) only touches the keys present; a create fills in defaults.
// Cross-field rules (suggested ≥ minimum, a price for fixed pages) are
// checked against the merged result in validatePricing().
function sanitizePageFields(input, { partial }) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const take = (key, fn) => {
    if (has(key)) out[key] = fn(input[key]);
    else if (!partial) out[key] = fn(undefined);
  };

  take('title', (v) => String(v ?? '').trim().slice(0, 200));
  take('description', (v) => String(v ?? '').trim().slice(0, 1000));
  take('priceType', (v) => (PRICE_TYPES.has(v) ? v : 'fixed'));
  take('price', (v) => sanitizePaise(v ?? 0, { label: 'Price' }));
  take('minPrice', (v) => sanitizePaise(v ?? 0, { label: 'Minimum' }));
  take('suggestedPrice', (v) => sanitizePaise(v ?? 0, { label: 'Suggested amount' }));
  take('allowQuantity', (v) => (v ? 1 : 0));
  take('maxQuantity', (v) => {
    const n = Number(v ?? 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY_LIMIT) throw fieldError(`Max quantity needs to be between 1 and ${MAX_QUANTITY_LIMIT}.`);
    return n;
  });
  take('ctaText', (v) => String(v ?? '').trim().slice(0, 60) || 'Pay now');
  take('deliveryUrl', (v) => {
    const value = String(v ?? '').trim().slice(0, 500);
    if (value && !/^https?:\/\//i.test(value)) throw fieldError('The delivery link needs to start with http:// or https://', 'INVALID_DELIVERY_URL');
    return value;
  });
  take('successMessage', (v) => String(v ?? '').trim().slice(0, 300));
  take('collectPhone', (v) => (v === undefined ? 1 : (v ? 1 : 0)));
  take('accentColor', (v) => sanitizeAccentColor(v));
  take('showCover', (v) => (v === undefined ? 1 : (v ? 1 : 0)));
  take('coverType', (v) => sanitizeCoverType(v));
  take('coverImageUrl', (v) => sanitizeCoverUrl(v));
  take('coverVideoUrl', (v) => sanitizeCoverUrl(v));
  take('coverColor', (v) => sanitizeCoverColor(v));
  if (has('visible')) out.visible = input.visible ? 1 : 0;

  if (out.title !== undefined && !out.title) throw fieldError('Give it a title, like “1:1 coaching session”.', 'TITLE_REQUIRED');
  return out;
}

function validatePricing(page) {
  if (page.price_type === 'fixed' && page.price < 100) {
    throw fieldError('Set a price of at least ₹1 — or switch to “Pay what you want”.');
  }
  if (page.price_type === 'flexible' && page.suggested_price && page.suggested_price < page.min_price) {
    throw fieldError('The suggested amount can’t be below the minimum.');
  }
}

const COLUMN_FOR = {
  title: 'title', description: 'description', priceType: 'price_type', price: 'price', minPrice: 'min_price',
  suggestedPrice: 'suggested_price', allowQuantity: 'allow_quantity', maxQuantity: 'max_quantity', ctaText: 'cta_text',
  deliveryUrl: 'delivery_url', successMessage: 'success_message', collectPhone: 'collect_phone', accentColor: 'accent_color',
  showCover: 'show_cover', coverType: 'cover_type', coverImageUrl: 'cover_image_url', coverVideoUrl: 'cover_video_url',
  coverColor: 'cover_color', visible: 'visible',
};

async function uniqueSlug(userId, title) {
  const base = slugify(title);
  const [rows] = await pool.query(`SELECT slug FROM ${TABLE} WHERE user_id = ? AND slug LIKE ?`, [userId, `${base}%`]);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

async function listPaymentPages(userId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT ${PAGE_COLUMNS} FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

async function getPaymentPage(userId, id) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT ${PAGE_COLUMNS} FROM ${TABLE} WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return rows[0] || null;
}

async function createPaymentPage(userId, input) {
  await ensureTables();
  const fields = sanitizePageFields(input || {}, { partial: false });
  const row = {};
  Object.entries(fields).forEach(([key, value]) => { row[COLUMN_FOR[key]] = value; });
  validatePricing(row);
  row.slug = await uniqueSlug(userId, row.title);
  const columns = Object.keys(row);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
    [userId, ...columns.map((c) => row[c])],
  );
  return getPaymentPage(userId, result.insertId);
}

// userId is scoped into every write, same as lib/leadMagnets.js — a
// merchant can never edit another merchant's page by guessing an id.
async function updatePaymentPage(userId, id, input) {
  await ensureTables();
  const current = await getPaymentPage(userId, id);
  if (!current) throw fieldError('That payment page doesn’t exist.', 'NOT_FOUND');
  const fields = sanitizePageFields(input || {}, { partial: true });
  const changes = {};
  Object.entries(fields).forEach(([key, value]) => { changes[COLUMN_FOR[key]] = value; });

  if (input && input.slug !== undefined) {
    const slug = normalizeSlug(input.slug);
    if (!slug) throw fieldError('The link needs at least one letter or number.', 'SLUG_REQUIRED');
    const [clash] = await pool.query(`SELECT id FROM ${TABLE} WHERE user_id = ? AND slug = ? AND id <> ? LIMIT 1`, [userId, slug, id]);
    if (clash.length) throw fieldError('Another of your payment pages already uses that link.', 'SLUG_TAKEN');
    changes.slug = slug;
  }
  validatePricing({ ...current, ...changes });

  const columns = Object.keys(changes);
  if (!columns.length) return current;
  try {
    await pool.query(
      `UPDATE ${TABLE} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
      [...columns.map((c) => changes[c]), id, userId],
    );
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    throw fieldError('Another of your payment pages already uses that link.', 'SLUG_TAKEN');
  }
  return getPaymentPage(userId, id);
}

async function deletePaymentPage(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ? AND user_id = ?`, [id, userId]);
  // Codes tied to just this page would otherwise linger, unusable.
  await pool.query(`DELETE FROM ${COUPONS} WHERE page_id = ? AND user_id = ?`, [id, userId]);
}

// The public /pay/:slug lookup — only visible pages.
async function getPublicPaymentPage(userId, slug) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT ${PAGE_COLUMNS} FROM ${TABLE} WHERE user_id = ? AND slug = ? AND visible = 1 LIMIT 1`,
    [userId, slug],
  );
  return rows[0] || null;
}

async function incrementPageViews(id) {
  await ensureTables();
  await pool.query(`UPDATE ${TABLE} SET view_count = view_count + 1 WHERE id = ?`, [id]);
}

// --- coupons ------------------------------------------------------------

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
}

async function listCoupons(userId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id, code, discount_type, discount_value, page_id, max_uses, used_count,
            DATE_FORMAT(expires_at, '%Y-%m-%d') AS expires_at, active, created_at
     FROM ${COUPONS} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

async function createCoupon(userId, input) {
  await ensureTables();
  const code = normalizeCode(input.code);
  if (code.length < 3) throw fieldError('Codes need at least 3 letters or numbers, like LAUNCH20.');
  const type = input.discountType === 'flat' ? 'flat' : 'percent';
  const value = Number(input.discountValue);
  if (type === 'percent' && (!Number.isInteger(value) || value < 1 || value > 100)) {
    throw fieldError('A percentage discount needs to be between 1 and 100.');
  }
  if (type === 'flat' && (!Number.isInteger(value) || value < 100 || value > MAX_PRICE)) {
    throw fieldError('A flat discount needs to be at least ₹1.');
  }
  let pageId = null;
  if (input.pageId !== undefined && input.pageId !== null && input.pageId !== '') {
    pageId = Number(input.pageId);
    if (!Number.isInteger(pageId) || !(await getPaymentPage(userId, pageId))) throw fieldError('Pick one of your payment pages, or “All pages”.');
  }
  let maxUses = null;
  if (input.maxUses !== undefined && input.maxUses !== null && input.maxUses !== '') {
    maxUses = Number(input.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1) throw fieldError('Max uses needs to be a whole number, 1 or more — or leave it blank.');
  }
  let expiresAt = null;
  if (input.expiresAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) throw fieldError('That expiry date doesn’t look right.');
    expiresAt = input.expiresAt;
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO ${COUPONS} (user_id, code, discount_type, discount_value, page_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, code, type, value, pageId, maxUses, expiresAt],
    );
    const [[row]] = await pool.query(
      `SELECT id, code, discount_type, discount_value, page_id, max_uses, used_count,
              DATE_FORMAT(expires_at, '%Y-%m-%d') AS expires_at, active, created_at
       FROM ${COUPONS} WHERE id = ?`,
      [result.insertId],
    );
    return row;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw fieldError(`You already have a code called ${code}.`, 'CODE_TAKEN');
    throw err;
  }
}

async function setCouponActive(userId, id, active) {
  await ensureTables();
  await pool.query(`UPDATE ${COUPONS} SET active = ? WHERE id = ? AND user_id = ?`, [active ? 1 : 0, id, userId]);
}

async function deleteCoupon(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${COUPONS} WHERE id = ? AND user_id = ?`, [id, userId]);
}

// Counted when an order is paid (lib/orders.js), not when it's placed, so
// abandoned checkouts don't burn a limited code's uses.
async function recordCouponUse(userId, code) {
  await ensureTables();
  await pool.query(`UPDATE ${COUPONS} SET used_count = used_count + 1 WHERE user_id = ? AND code = ?`, [userId, code]);
}

async function findUsableCoupon(userId, page, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { coupon: null, error: null };
  const [rows] = await pool.query(
    `SELECT id, code, discount_type, discount_value, page_id, max_uses, used_count, expires_at, active
     FROM ${COUPONS} WHERE user_id = ? AND code = ? LIMIT 1`,
    [userId, code],
  );
  const coupon = rows[0];
  const invalid = { coupon: null, error: `${code} isn’t a valid code.` };
  if (!coupon || !coupon.active) return invalid;
  if (coupon.page_id && coupon.page_id !== page.id) return { coupon: null, error: `${code} doesn’t apply to this page.` };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return { coupon: null, error: `${code} has been fully used.` };
  if (coupon.expires_at) {
    // Valid through the end of its expiry day (server time).
    const end = new Date(coupon.expires_at);
    end.setHours(23, 59, 59, 999);
    if (Date.now() > end.getTime()) return { coupon: null, error: `${code} has expired.` };
  }
  return { coupon, error: null };
}

// --- pricing ---------------------------------------------------------------

// The one place a price is worked out — used for the live total on the
// public page (POST /pay/:slug/quote) and again, from scratch, when the
// order is placed. input: { amount (rupees, pay-what-you-want only),
// quantity, coupon }. Returns the breakdown in paise plus any problems:
// `error` blocks checkout; `couponError` just means the code was ignored.
async function quote(userId, page, input = {}) {
  await ensureTables();
  const result = { error: null, couponError: null, coupon: null };

  let unit = page.price;
  if (page.price_type === 'flexible') {
    const amount = rupeesToPaise(input.amount);
    if (amount === null) {
      result.error = 'Enter the amount you’d like to pay.';
      unit = page.suggested_price || page.min_price;
    } else if (amount < page.min_price) {
      result.error = `The minimum is ${formatINR(page.min_price)}.`;
      unit = page.min_price;
    } else if (amount > MAX_PRICE) {
      result.error = `The most you can pay here is ${formatINR(MAX_PRICE)}.`;
      unit = MAX_PRICE;
    } else {
      unit = amount;
    }
  }

  let quantity = 1;
  if (page.allow_quantity) {
    const q = Number(input.quantity ?? 1);
    if (!Number.isInteger(q) || q < 1 || q > page.max_quantity) {
      result.error = result.error || `Choose a quantity between 1 and ${page.max_quantity}.`;
    } else {
      quantity = q;
    }
  }

  const subtotal = unit * quantity;
  let discount = 0;
  if (input.coupon) {
    const { coupon, error } = await findUsableCoupon(userId, page, input.coupon);
    if (error) {
      result.couponError = error;
    } else if (coupon) {
      discount = coupon.discount_type === 'percent'
        ? Math.round((subtotal * coupon.discount_value) / 100)
        : coupon.discount_value;
      discount = Math.min(discount, subtotal);
      result.coupon = {
        code: coupon.code,
        label: coupon.discount_type === 'percent' ? `${coupon.discount_value}% off` : `${formatINR(coupon.discount_value)} off`,
      };
    }
  }

  return Object.assign(result, {
    unit,
    quantity,
    subtotal,
    discount,
    total: subtotal - discount,
    display: {
      unit: formatINR(unit),
      subtotal: formatINR(subtotal),
      discount: formatINR(discount),
      total: formatINR(subtotal - discount),
    },
  });
}

module.exports = {
  listPaymentPages,
  getPaymentPage,
  createPaymentPage,
  updatePaymentPage,
  deletePaymentPage,
  getPublicPaymentPage,
  incrementPageViews,
  listCoupons,
  createCoupon,
  setCouponActive,
  deleteCoupon,
  recordCouponUse,
  quote,
  formatINR,
  rupeesToPaise,
  MAX_PRICE,
};
