// A merchant's audience — the people they've collected (added by hand for
// now; later this is where a booking, an order or a form submission would
// drop someone in automatically, per the homepage's "one contact list you
// actually own" promise). Same lazy-migration pattern as lib/blocks.js —
// PDZ_contacts is created on first use, no separate migration step to run
// before deploying this.
const pool = require('./db');

const TABLE = 'PDZ_contacts';
const SOURCES = new Set(['manual', 'order', 'booking', 'form']);

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(200) NOT NULL DEFAULT '',
        email VARCHAR(255) NOT NULL DEFAULT '',
        phone VARCHAR(30) NOT NULL DEFAULT '',
        note VARCHAR(300) NOT NULL DEFAULT '',
        source VARCHAR(20) NOT NULL DEFAULT 'manual',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_id)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function listContacts(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, note, source, created_at FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

async function countContacts(userId) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE user_id = ?`, [userId]);
  return row.total;
}

async function createContact(userId, { name, email, phone, note }) {
  await ensureTable();
  const trimmedName = String(name || '').trim().slice(0, 200);
  const trimmedEmail = String(email || '').trim().slice(0, 255);
  const trimmedPhone = String(phone || '').trim().slice(0, 30);
  const trimmedNote = String(note || '').trim().slice(0, 300);

  if (!trimmedName) {
    const err = new Error('Add a name for this person.');
    err.code = 'NAME_REQUIRED';
    throw err;
  }
  if (!trimmedEmail && !trimmedPhone) {
    const err = new Error('Add an email or phone number so you can actually reach them.');
    err.code = 'CONTACT_METHOD_REQUIRED';
    throw err;
  }
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    const err = new Error('That email address doesn’t look right.');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, name, email, phone, note, source) VALUES (?, ?, ?, ?, ?, 'manual')`,
    [userId, trimmedName, trimmedEmail, trimmedPhone, trimmedNote],
  );
  return {
    id: result.insertId,
    name: trimmedName,
    email: trimmedEmail,
    phone: trimmedPhone,
    note: trimmedNote,
    source: 'manual',
    created_at: new Date(),
  };
}

// userId is scoped into every write below, same as lib/blocks.js — one
// merchant can never edit or delete a contact belonging to someone else's
// audience, even by guessing a valid id.
async function updateContact(userId, contactId, fields) {
  await ensureTable();
  const allowed = ['name', 'email', 'phone', 'note'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const max = key === 'email' ? 255 : key === 'note' ? 300 : key === 'phone' ? 30 : 200;
      sets.push(`${key} = ?`);
      values.push(String(fields[key] ?? '').trim().slice(0, max));
    }
  }
  if (!sets.length) return;
  values.push(contactId, userId);
  await pool.query(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, values);
}

async function deleteContact(userId, contactId) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ? AND user_id = ?`, [contactId, userId]);
}

module.exports = { listContacts, countContacts, createContact, updateContact, deleteContact, SOURCES };
