// A user's store blocks (link/course/booking/download/membership rows on
// their public page), backed by MySQL. Same lazy-migration pattern as
// lib/users.js — PDZ_blocks is created on first use, no separate migration
// step to run before deploying this.
const pool = require('./db');

const TABLE = 'PDZ_blocks';
const TYPES = new Set(['link', 'course', 'booking', 'download', 'membership']);

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
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function listBlocks(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, type, title, sub, price, visible, sort_order FROM ${TABLE} WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
    [userId],
  );
  return rows;
}

async function nextSortOrder(userId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM ${TABLE} WHERE user_id = ?`,
    [userId],
  );
  return row.maxOrder + 1;
}

async function createBlock(userId, { type }) {
  await ensureTable();
  if (!TYPES.has(type)) {
    const err = new Error('Unknown block type.');
    err.code = 'INVALID_TYPE';
    throw err;
  }
  const order = await nextSortOrder(userId);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, type, sort_order) VALUES (?, ?, ?)`,
    [userId, type, order],
  );
  return { id: result.insertId, type, title: '', sub: '', price: '', visible: 1, sort_order: order };
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
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, type, title, sub, price, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, block.type, `${block.title} (copy)`, block.sub, block.price, block.visible, order],
  );
  return {
    id: result.insertId,
    type: block.type,
    title: `${block.title} (copy)`,
    sub: block.sub,
    price: block.price,
    visible: block.visible,
    sort_order: order,
  };
}

module.exports = { listBlocks, createBlock, updateBlock, reorderBlocks, deleteBlock, duplicateBlock, TYPES };
