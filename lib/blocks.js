// A user's store blocks (link/course/booking/download/membership rows on
// their public page), backed by MySQL. Same lazy-migration pattern as
// lib/users.js — PDZ_blocks is created on first use, no separate migration
// step to run before deploying this.
const pool = require('./db');
const { PLATFORMS } = require('./socials');

const TABLE = 'PDZ_blocks';
// Must match TYPE_META in public/js/builder.js — a type missing here is
// rejected by POST /dashboard/builder/blocks. Labels are what the public
// store page shows on each block.
const TYPE_LABELS = {
  course: 'Course', booking: 'Booking', download: 'Download', membership: 'Membership',
  event: 'Webinar / Event', tip: 'Tip jar',
  newsletter: 'Newsletter', form: 'Form', social: 'Social', testimonial: 'Testimonial',
  link: 'Link', video: 'Video', text: 'Text',
};
const TYPES = new Set(Object.keys(TYPE_LABELS));
// Types whose "sub" field holds a URL — the store page makes them clickable.
const URL_TYPES = new Set(['link', 'video', 'social']);

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(20) NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT '',
        sub VARCHAR(200) NOT NULL DEFAULT '',
        price VARCHAR(40) NOT NULL DEFAULT '',
        visible TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_id)
      )
    `).then(addItemsColumn).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// items: a block's list of entries, as JSON — the testimonials in a
// Testimonials block. Added after PDZ_blocks existed, so it's an ALTER
// that's safe on every boot. A testimonial block from before held one
// quote in title (and its author in sub): it's moved into items once, and
// title becomes the block's optional heading.
async function addItemsColumn() {
  try {
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN items TEXT NULL`);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  await pool.query(
    `UPDATE ${TABLE}
     SET items = JSON_ARRAY(JSON_OBJECT('quote', title, 'name', sub, 'detail', '')), title = '', sub = ''
     WHERE type = 'testimonial' AND items IS NULL AND title <> ''`,
  );
}

// Entries a block can hold, cleaned: a Testimonials block's quotes, a
// Form block's fields. Each key is text (with a max length), one of a set
// of choices, or a yes/no. Empty entries are kept (one just added in the
// builder and not typed into yet); the store skips them.
const FIELD_KINDS = ['text', 'email', 'phone', 'textarea', 'number'];
const ITEM_FIELDS = {
  // Social links: which of the profile's platforms (lib/socials.js) are
  // switched off here; one not listed is shown.
  social: { platform: PLATFORMS.map((p) => p.id), on: Boolean },
  testimonial: { quote: 500, name: 80, detail: 80 },
  form: { label: 80, kind: FIELD_KINDS, required: Boolean },
};
const MAX_ITEMS = { testimonial: 12, form: 8, social: PLATFORMS.length };
// What a new block of the type starts with.
const STARTER = {
  testimonial: { items: [{}] },
  form: {
    title: 'Message me',
    items: [
      { label: 'Name', kind: 'text', required: true },
      { label: 'Email', kind: 'email', required: true },
      { label: 'Message', kind: 'textarea', required: false },
    ],
  },
};

function normalizeItems(type, raw) {
  const fields = ITEM_FIELDS[type];
  if (!fields) return [];
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (err) { list = []; }
  }
  if (!Array.isArray(list)) return [];
  // Social links: known platforms only, each once.
  if (type === 'social') {
    const seen = new Set();
    list = list.filter((item) => {
      const ok = item && fields.platform.includes(item.platform) && !seen.has(item.platform);
      if (ok) seen.add(item.platform);
      return ok;
    });
  }
  return list.slice(0, MAX_ITEMS[type]).map((item) => {
    const out = {};
    for (const [key, rule] of Object.entries(fields)) {
      const value = item && item[key];
      if (rule === Boolean) out[key] = !!value;
      else if (Array.isArray(rule)) out[key] = rule.includes(value) ? value : rule[0];
      else out[key] = String(value ?? '').slice(0, rule);
    }
    return out;
  });
}

const withItems = (row) => ({ ...row, items: normalizeItems(row.type, row.items) });

async function listBlocks(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, type, title, sub, price, visible, sort_order, items FROM ${TABLE} WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
    [userId],
  );
  return rows.map(withItems);
}

async function nextSortOrder(userId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM ${TABLE} WHERE user_id = ?`,
    [userId],
  );
  return row.maxOrder + 1;
}

// What a new block of the type starts with — also sent to the builder,
// which shows a new block before it's saved.
function starterFor(type) {
  const starter = STARTER[type] || {};
  return { title: starter.title || '', items: normalizeItems(type, starter.items || []) };
}

async function createBlock(userId, { type }) {
  await ensureTable();
  if (!TYPES.has(type)) {
    const err = new Error('Unknown block type.');
    err.code = 'INVALID_TYPE';
    throw err;
  }
  const order = await nextSortOrder(userId);
  const { title, items } = starterFor(type);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, type, title, sort_order, items) VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, order, items.length ? JSON.stringify(items) : null],
  );
  return { id: result.insertId, type, title, sub: '', price: '', visible: 1, sort_order: order, items };
}

// userId is included in the WHERE clause on every write below — not just
// the read — so one user can never edit, hide, duplicate or delete a block
// that belongs to someone else's page, even if they guess a valid block id.
async function updateBlock(userId, blockId, fields) {
  await ensureTable();
  const allowed = ['title', 'sub', 'price', 'visible'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?`);
      values.push(key === 'visible' ? (fields[key] ? 1 : 0) : String(fields[key]).slice(0, 200));
    }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'items')) {
    const [[row]] = await pool.query(`SELECT type FROM ${TABLE} WHERE id = ? AND user_id = ?`, [blockId, userId]);
    if (row && ITEM_FIELDS[row.type]) {
      sets.push('items = ?');
      values.push(JSON.stringify(normalizeItems(row.type, fields.items)));
    }
  }
  if (!sets.length) return;
  values.push(blockId, userId);
  await pool.query(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, values);
}

async function reorderBlocks(userId, orderedIds) {
  await ensureTable();
  await Promise.all(
    orderedIds.map((id, index) =>
      pool.query(`UPDATE ${TABLE} SET sort_order = ? WHERE id = ? AND user_id = ?`, [index, id, userId]),
    ),
  );
}

async function deleteBlock(userId, blockId) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ? AND user_id = ?`, [blockId, userId]);
}

async function duplicateBlock(userId, blockId) {
  await ensureTable();
  const [[block]] = await pool.query(`SELECT * FROM ${TABLE} WHERE id = ? AND user_id = ?`, [blockId, userId]);
  if (!block) return null;
  const order = await nextSortOrder(userId);
  const title = block.title ? `${block.title} (copy)` : '';
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, type, title, sub, price, visible, sort_order, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, block.type, title, block.sub, block.price, block.visible, order, block.items],
  );
  return {
    id: result.insertId,
    type: block.type,
    title,
    items: normalizeItems(block.type, block.items),
    sub: block.sub,
    price: block.price,
    visible: block.visible,
    sort_order: order,
  };
}

module.exports = { normalizeItems, starterFor, FIELD_KINDS, listBlocks, createBlock, updateBlock, reorderBlocks, deleteBlock, duplicateBlock, TYPES, TYPE_LABELS, URL_TYPES };
