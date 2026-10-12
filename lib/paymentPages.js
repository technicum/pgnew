// Payment pages — one checkout link (meera.pagezaper.com/pay/<slug>) that
// sells one product or several together: a course plus a physical
// workbook, a bundle of downloads, a "buy me a coffee". Each product is
//
//   type     'digital'  — unlocks a file link once paid
//            'physical' — has stock, weight and a shipping fee; puts a
//                         shipping-address section on the checkout
//            'coffee'   — a support button: price per coffee × how many
//   pricing  'fixed'    — one price (optionally shown against a
//                         higher compare-at price)
//            'qty'      — a unit price; the buyer picks how many
//            'pwyw'     — pay what you want, from a minimum
//
// A page's products live in its `products` column as a small JSON array.
// Pages made before multi-product checkout have no such column value —
// productsOf() builds their one product from the old single-price columns,
// so they keep working untouched.
//
// All money is integer paise, and the price a buyer pays is always
// recomputed here on the server (quote()), whatever the browser sent.
// Paid orders live in lib/orders.js.
const pool = require('./db');
const {
  normalizeSlug,
  slugify,
  sanitizeAccentColor,
  sanitizeCoverType,
  sanitizeCoverColor,
  sanitizeCoverUrl,
} = require('./leadMagnets');
const { MAX_RICH_TEXT_LENGTH } = require('./richText');

const TABLE = 'PDZ_payment_pages';
const COUPONS = 'PDZ_coupons';

const MAX_PRICE = 500000 * 100; // ₹5,00,000 in paise
const MAX_QUANTITY_LIMIT = 100;
const MAX_PRODUCTS = 10;
const PRODUCT_TYPES = new Set(['digital', 'physical', 'coffee']);
const PRICING_TYPES = new Set(['fixed', 'qty', 'pwyw']);

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
      // Multi-product checkout. TEXT (no DEFAULT on older MySQL) — NULL
      // means "a page from before this", see productsOf().
      try {
        await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN products TEXT NULL`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
      // Listed on PageZaper's marketplace (/explore, lib/marketplace.js) — the creator opts in.
      try {
        await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN marketplace TINYINT(1) NOT NULL DEFAULT 0`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
      // The long "About" description, in lib/richText.js's small format.
      try {
        await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN about TEXT NULL`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
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

// --- products ----------------------------------------------------------

// Paise from the builder (which converts rupees); null for "left blank".
function optionalPaise(raw, label) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE) throw fieldError(`${label} needs to be an amount up to ${formatINR(MAX_PRICE)}.`);
  return n;
}
function optionalCount(raw, label, { min = 0, max = 1000000 } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw fieldError(`${label} needs to be a whole number${min ? ` from ${min}` : ''}${max < 1000000 ? ` up to ${max}` : ''}.`);
  return n;
}

// --- product media -------------------------------------------------------

// A product's picture or video: one of our own uploads (lib/uploads.js),
// or an http(s) link. A video link can also be a YouTube or Vimeo page,
// which productMedia() turns into that site's embed player.
function sanitizeProductMedia(rawType, rawUrl, label) {
  const type = rawType === 'image' || rawType === 'video' ? rawType : '';
  const url = String(rawUrl || '').trim().slice(0, 500);
  if (!type || !url) return null;
  if (!/^https?:\/\//i.test(url) && !/^\/uploads\/user-\d+\/[a-z0-9.-]+$/i.test(url)) {
    throw fieldError(`${label}’s ${type} link needs to start with http:// or https://`);
  }
  return { mediaType: type, mediaUrl: url };
}

// YouTube / Vimeo page link → the video's id, or null.
function youTubeId(url) {
  const m = url.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  return m ? m[1] : null;
}
function vimeoId(url) {
  const m = url.match(/^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{6,12})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

// How to show a product's media: { kind: 'image' | 'video' | 'embed', src },
// or null. Embeds are rebuilt from the video id alone, so the iframe can
// only ever point at YouTube's or Vimeo's own player.
function productMedia(p) {
  if (!p || !p.mediaUrl || !/^(https?:\/\/|\/uploads\/)/i.test(p.mediaUrl)) return null;
  if (p.mediaType === 'image') return { kind: 'image', src: p.mediaUrl };
  if (p.mediaType !== 'video') return null;
  const yt = youTubeId(p.mediaUrl);
  if (yt) return { kind: 'embed', src: `https://www.youtube-nocookie.com/embed/${yt}?rel=0` };
  const vimeo = vimeoId(p.mediaUrl);
  if (vimeo) return { kind: 'embed', src: `https://player.vimeo.com/video/${vimeo}` };
  return { kind: 'video', src: p.mediaUrl };
}

// One product from the builder → the stored shape, with every rule that
// makes it sellable checked. `n` is its 1-based position, for messages.
function sanitizeProduct(raw, n, usedIds) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const label = `Product ${n}`;
  const type = PRODUCT_TYPES.has(p.type) ? p.type : 'digital';
  const pricing = type === 'coffee' ? 'qty' : (PRICING_TYPES.has(p.pricing) ? p.pricing : 'fixed');
  let id = Number(p.id);
  if (!Number.isInteger(id) || id < 1 || usedIds.has(id)) id = Math.max(0, ...usedIds) + 1;
  usedIds.add(id);

  const title = String(p.title || '').trim().slice(0, 120) || (type === 'coffee' ? 'Buy me a coffee' : '');
  if (!title) throw fieldError(`Give ${label.toLowerCase()} a title.`);
  const product = { id, title, type, pricing };
  // A line or two about this product, shown on its tile / order line.
  const description = String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (description) product.description = description;
  // An image or video shown across the top of this product's card.
  const media = sanitizeProductMedia(p.mediaType, p.mediaUrl, label);
  if (media) Object.assign(product, media);

  if (pricing === 'pwyw') {
    product.minimum = optionalPaise(p.minimum, `${label}’s minimum`) || 0;
    product.suggested = optionalPaise(p.suggested, `${label}’s suggested amount`) || 0;
    if (product.suggested && product.suggested < product.minimum) {
      throw fieldError(`${label}’s suggested amount can’t be below its minimum.`);
    }
  } else {
    product.price = optionalPaise(p.price, `${label}’s price`);
    if (!product.price || product.price < 100) {
      throw fieldError(type === 'coffee' ? `Set a price per coffee of at least ₹1 for ${label.toLowerCase()}.` : `Set a price of at least ₹1 for ${label.toLowerCase()}.`);
    }
  }
  if (pricing === 'fixed') {
    product.compareAt = optionalPaise(p.compareAt, `${label}’s compare-at price`);
    if (product.compareAt !== null && product.compareAt <= product.price) {
      throw fieldError(`${label}’s compare-at price should be higher than its price — or leave it blank.`);
    }
  }
  if (pricing === 'qty' && type !== 'coffee') {
    product.maxQty = optionalCount(p.maxQty, `${label}’s max quantity`, { min: 1, max: MAX_QUANTITY_LIMIT });
  }

  if (type === 'digital') {
    const fileUrl = String(p.fileUrl || '').trim().slice(0, 500);
    if (fileUrl && !/^https?:\/\//i.test(fileUrl)) throw fieldError(`${label}’s file link needs to start with http:// or https://`);
    product.fileUrl = fileUrl;
  }
  if (type === 'physical') {
    product.stock = optionalCount(p.stock, `${label}’s stock`);
    product.weight = optionalCount(p.weight, `${label}’s weight`);
    product.shipFee = optionalPaise(p.shipFee, `${label}’s shipping fee`) || 0;
  }
  return product;
}

function sanitizeProducts(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (err) { list = []; }
  }
  if (!Array.isArray(list) || !list.length) throw fieldError('Add at least one product to sell.');
  if (list.length > MAX_PRODUCTS) throw fieldError(`A page can hold up to ${MAX_PRODUCTS} products.`);
  const used = new Set();
  return list.map((p, i) => sanitizeProduct(p, i + 1, used));
}

// A page's products, parsed — or, for a page from before multi-product
// checkout, its single product rebuilt from the old columns.
function productsOf(row) {
  if (row.products) {
    try {
      const list = JSON.parse(row.products);
      if (Array.isArray(list) && list.length) return list;
    } catch (err) { /* fall through to the legacy shape */ }
  }
  const pricing = row.price_type === 'flexible' ? 'pwyw' : (row.allow_quantity ? 'qty' : 'fixed');
  const product = { id: 1, title: row.title || 'Product', type: 'digital', pricing, fileUrl: row.delivery_url || '' };
  if (pricing === 'pwyw') Object.assign(product, { minimum: row.min_price || 0, suggested: row.suggested_price || 0 });
  else product.price = row.price || 0;
  if (pricing === 'fixed') product.compareAt = null;
  if (pricing === 'qty') product.maxQty = row.max_quantity || null;
  return [product];
}

// --- pages --------------------------------------------------------------

const PAGE_COLUMNS = `id, user_id, title, slug, description, price_type, price, min_price, suggested_price,
  allow_quantity, max_quantity, delivery_url, success_message, accent_color, show_cover, cover_type,
  cover_image_url, cover_video_url, cover_color, visible, view_count, products, about, created_at, marketplace`;

// What the rest of the app sees: the row with its products parsed and the
// legacy single-product columns left behind.
function toPage(row) {
  if (!row) return null;
  const {
    price_type: _pt, price: _p, min_price: _mp, suggested_price: _sp, allow_quantity: _aq, max_quantity: _mq,
    delivery_url: _du, ...page
  } = row;
  page.products = productsOf(row);
  page.has_physical = page.products.some((p) => p.type === 'physical');
  return page;
}

const COLUMN_FOR = {
  title: 'title', description: 'description', successMessage: 'success_message', accentColor: 'accent_color',
  showCover: 'show_cover', coverType: 'cover_type', coverImageUrl: 'cover_image_url', coverVideoUrl: 'cover_video_url',
  coverColor: 'cover_color', visible: 'visible', products: 'products', about: 'about', marketplace: 'marketplace',
};

// Every field the builder can send, checked. `partial` (an edit) only
// touches the keys present; a create fills in defaults.
function sanitizePageFields(input, { partial }) {
  const out = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const take = (key, fn) => {
    if (has(key)) out[key] = fn(input[key]);
    else if (!partial) out[key] = fn(undefined);
  };
  take('products', (v) => JSON.stringify(sanitizeProducts(v)));
  // The headline defaults to the product's own name on a one-product page.
  take('title', (v) => String(v ?? '').trim().slice(0, 200));
  take('description', (v) => String(v ?? '').trim().slice(0, 1000));
  // The long "About" text (lib/richText.js format) — stored as typed,
  // rendered safely when the page is shown.
  take('about', (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_RICH_TEXT_LENGTH));
  take('successMessage', (v) => String(v ?? '').trim().slice(0, 300));
  take('accentColor', (v) => sanitizeAccentColor(v));
  take('showCover', (v) => (v === undefined ? 1 : (v ? 1 : 0)));
  take('coverType', (v) => sanitizeCoverType(v));
  take('coverImageUrl', (v) => sanitizeCoverUrl(v));
  take('coverVideoUrl', (v) => sanitizeCoverUrl(v));
  take('coverColor', (v) => sanitizeCoverColor(v));
  if (has('visible')) out.visible = input.visible ? 1 : 0;
  if (has('marketplace')) out.marketplace = input.marketplace ? 1 : 0;

  if (out.title !== undefined && !out.title && out.products) {
    const products = JSON.parse(out.products);
    if (products.length === 1) out.title = products[0].title;
  }
  if (out.title !== undefined && !out.title) throw fieldError('Give the page a headline, like “Complete Starter Bundle”.', 'TITLE_REQUIRED');
  return out;
}

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
  return rows.map(toPage);
}

async function getPaymentPage(userId, id) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT ${PAGE_COLUMNS} FROM ${TABLE} WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return toPage(rows[0]);
}

async function createPaymentPage(userId, input) {
  await ensureTables();
  const fields = sanitizePageFields(input || {}, { partial: false });
  const row = {};
  Object.entries(fields).forEach(([key, value]) => { row[COLUMN_FOR[key]] = value; });
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

// The builder's unsaved page, for the live preview (lib/livePreview.js):
// the same checks as a save, laid over the saved page when editing one —
// nothing written. A new page gets a stand-in link.
function previewPaymentPage(userId, input, saved = null) {
  const fields = sanitizePageFields(input || {}, { partial: false });
  const row = saved ? { ...saved } : { id: 0, user_id: userId, slug: 'preview', visible: 1, view_count: 0 };
  Object.entries(fields).forEach(([key, value]) => { row[COLUMN_FOR[key]] = value; });
  return toPage(row);
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
  return toPage(rows[0]);
}

async function incrementPageViews(id) {
  await ensureTables();
  await pool.query(`UPDATE ${TABLE} SET view_count = view_count + 1 WHERE id = ?`, [id]);
}

// Once an order is paid, its physical items come off stock. Read-modify-
// write of the page's JSON; stock is a convenience counter here, not a
// reservation system (it's also checked when the order is placed).
async function deductStock(userId, pageId, lines) {
  await ensureTables();
  const page = await getPaymentPage(userId, pageId);
  if (!page) return;
  let changed = false;
  const products = page.products.map((p) => {
    const line = lines.find((l) => l.id === p.id);
    if (!line || p.type !== 'physical' || p.stock === null || p.stock === undefined) return p;
    changed = true;
    return { ...p, stock: Math.max(0, p.stock - line.qty) };
  });
  if (changed) {
    await pool.query(`UPDATE ${TABLE} SET products = ? WHERE id = ? AND user_id = ?`, [JSON.stringify(products), pageId, userId]);
  }
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

// The most a buyer can take of one product in one order.
function maxQtyFor(p) {
  let max = p.type === 'coffee' ? MAX_QUANTITY_LIMIT : (p.maxQty || MAX_QUANTITY_LIMIT);
  if (p.type === 'physical' && p.stock !== null && p.stock !== undefined) max = Math.min(max, p.stock);
  return max;
}

// The one place a price is worked out — the live total on the public page
// (POST /pay/:slug/quote) and again, from scratch, when the order is placed.
//
// input: { items: { <productId>: { qty, amount } }, coupon }
//   qty    — for 'qty' pricing and coffee; on a multi-product page, 0
//            means "not in the cart" for any product
//   amount — rupees, for 'pwyw' (and a coffee's "custom" amount)
//
// Returns each line, subtotal, discount (on the products, not shipping),
// shipping (each physical product's flat fee), total, and any problems:
// `error` blocks checkout; `couponError` only means the code was ignored.
async function quote(userId, page, input = {}) {
  await ensureTables();
  const items = input.items && typeof input.items === 'object' ? input.items : {};
  const result = { error: null, couponError: null, coupon: null };
  const fail = (message) => { result.error = result.error || message; };

  // A page with several products is a cart: the buyer picks what to buy,
  // and a qty of 0 leaves that product out of the order.
  const pickable = page.products.length > 1;
  const lines = page.products.map((p) => {
    const chosen = items[p.id] || items[String(p.id)] || {};
    if (pickable && chosen.qty !== undefined && chosen.qty !== '' && Number(chosen.qty) === 0) return null;
    let qty = 1;
    let unit = p.price || 0;

    const customCoffee = p.type === 'coffee' && chosen.amount !== undefined && chosen.amount !== '';
    if (customCoffee) {
      // "Custom" on a coffee: the buyer types their own amount instead of
      // picking a number of coffees — at least the price of one.
      const amount = rupeesToPaise(chosen.amount);
      if (amount === null) fail('Enter the amount you’d like to give.');
      else if (amount < p.price) fail(`The smallest amount is ${formatINR(p.price)} — one coffee.`);
      else if (amount > MAX_PRICE) fail(`The most you can give here is ${formatINR(MAX_PRICE)}.`);
      else unit = amount;
    } else if (p.pricing === 'qty') {
      const max = maxQtyFor(p);
      const q = chosen.qty === undefined || chosen.qty === '' ? 1 : Number(chosen.qty);
      if (max < 1) fail(`${p.title} is sold out.`);
      else if (!Number.isInteger(q) || q < 1 || q > max) fail(`Choose between 1 and ${max} of ${p.title}.`);
      else qty = q;
    } else if (p.pricing === 'pwyw') {
      const fallback = p.suggested || p.minimum || 0;
      const amount = chosen.amount === undefined || chosen.amount === '' ? null : rupeesToPaise(chosen.amount);
      if (amount === null) {
        if (chosen.amount !== undefined && chosen.amount !== '') fail(`Enter an amount for ${p.title}.`);
        unit = fallback;
      } else if (amount < (p.minimum || 0)) {
        fail(`The minimum for ${p.title} is ${formatINR(p.minimum)}.`);
        unit = p.minimum;
      } else if (amount > MAX_PRICE) {
        fail(`The most you can pay for ${p.title} is ${formatINR(MAX_PRICE)}.`);
        unit = MAX_PRICE;
      } else {
        unit = amount;
      }
    } else if (p.type === 'physical' && p.stock !== null && p.stock !== undefined && p.stock < 1) {
      fail(`${p.title} is sold out.`);
    }

    return {
      id: p.id,
      title: p.title,
      type: p.type,
      pricing: p.pricing,
      qty,
      unit,
      amount: unit * qty,
      shipFee: p.type === 'physical' ? (p.shipFee || 0) : 0,
    };
  }).filter(Boolean);
  if (!lines.length) fail('Add at least one product to continue.');

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const shipping = lines.reduce((sum, l) => sum + l.shipFee, 0);
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
  const total = subtotal - discount + shipping;

  return Object.assign(result, {
    lines,
    subtotal,
    discount,
    shipping,
    total,
    hasPhysical: lines.some((l) => l.type === 'physical'),
    display: {
      lines: Object.fromEntries(lines.map((l) => [l.id, formatINR(l.amount)])),
      subtotal: formatINR(subtotal),
      discount: formatINR(discount),
      shipping: shipping ? formatINR(shipping) : 'Free',
      total: formatINR(total),
    },
  });
}

// Live pages the creators listed on the marketplace (lib/marketplace.js), newest first.
async function listMarketplacePages() {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT ${PAGE_COLUMNS.replace(/(^|,\s*)(\w+)/g, '$1p.$2')}, u.handle AS owner_handle, u.name AS owner_name
     FROM ${TABLE} p JOIN PDZ_users u ON u.id = p.user_id
     WHERE p.visible = 1 AND p.marketplace = 1 ORDER BY p.created_at DESC LIMIT 200`,
  );
  return rows.map((r) => ({ ...toPage(r), owner_handle: r.owner_handle, owner_name: r.owner_name }));
}

module.exports = {
  listMarketplacePages,
  listPaymentPages,
  getPaymentPage,
  createPaymentPage,
  updatePaymentPage,
  deletePaymentPage,
  previewPaymentPage,
  getPublicPaymentPage,
  incrementPageViews,
  deductStock,
  listCoupons,
  createCoupon,
  setCouponActive,
  deleteCoupon,
  recordCouponUse,
  quote,
  maxQtyFor,
  productMedia,
  formatINR,
  rupeesToPaise,
  MAX_PRICE,
  MAX_PRODUCTS,
};
