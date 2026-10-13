// A merchant's audience — the people they've collected (added by hand for
// now; later this is where a booking, an order or a form submission would
// drop someone in automatically, per the homepage's "one contact list you
// actually own" promise). Same lazy-migration pattern as lib/blocks.js —
// PDZ_contacts is created on first use, no separate migration step to run
// before deploying this.
const pool = require('./db');

const TABLE = 'PDZ_contacts';
const SOURCES = new Set(['manual', 'order', 'booking', 'event', 'course', 'form', 'newsletter']);

// Which particular thing a contact came from — for a lead-magnet signup
// (source 'form') the magnet's id and its title at signup time, so the
// Audience list can group people under each magnet by name. Added after
// PDZ_contacts already existed: same ALTER-and-swallow-duplicates approach
// as lib/leadMagnets.js, safe on every boot. Signups from before this only
// have the title inside their note ("Lead magnet: <title> — …"), so it's
// copied out into source_name for them.
async function addSourceColumns() {
  const addColumn = async (sql) => {
    try {
      await pool.query(sql);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  };
  await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN source_id INT NULL DEFAULT NULL`);
  await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN source_name VARCHAR(200) NOT NULL DEFAULT ''`);
  await pool.query(
    `UPDATE ${TABLE}
     SET source_name = LEFT(SUBSTRING_INDEX(SUBSTRING(note, 14), ' — ', 1), 200)
     WHERE source = 'form' AND source_name = '' AND note LIKE 'Lead magnet: %'`,
  );
}

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
    `).then(addSourceColumns).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function listContacts(userId) {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, note, source, source_id, source_name, created_at FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows;
}

async function countContacts(userId) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE user_id = ?`, [userId]);
  return row.total;
}

// Used by lead-magnet signups (and anything else that captures a contact
// from outside the dashboard) so the same person opting in twice — to the
// same magnet or a different one — updates one row instead of piling up
// duplicates in the audience list.
async function findExistingContact(userId, { email, phone }) {
  await ensureTable();
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const trimmedPhone = String(phone || '').trim();
  if (trimmedEmail) {
    const [rows] = await pool.query(
      `SELECT * FROM ${TABLE} WHERE user_id = ? AND LOWER(email) = ? LIMIT 1`,
      [userId, trimmedEmail],
    );
    if (rows[0]) return rows[0];
  }
  if (trimmedPhone) {
    const [rows] = await pool.query(
      `SELECT * FROM ${TABLE} WHERE user_id = ? AND phone = ? LIMIT 1`,
      [userId, trimmedPhone],
    );
    if (rows[0]) return rows[0];
  }
  return null;
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

// source lets a caller outside the manual "Add someone" form (a lead
// magnet signup today) tag where the contact came from, instead of every
// contact being stamped 'manual'; sourceId/sourceName say which one (the
// magnet's id and title).
async function createContactFromSource(userId, { name, email, phone, note, source, sourceId, sourceName }) {
  const contact = await createContact(userId, { name, email, phone, note });
  const finalSource = SOURCES.has(source) ? source : 'manual';
  if (finalSource !== 'manual') {
    const id = Number.isInteger(sourceId) ? sourceId : null;
    const label = String(sourceName || '').trim().slice(0, 200);
    await pool.query(
      `UPDATE ${TABLE} SET source = ?, source_id = ?, source_name = ? WHERE id = ? AND user_id = ?`,
      [finalSource, id, label, contact.id, userId],
    );
    Object.assign(contact, { source: finalSource, source_id: id, source_name: label });
  }
  return contact;
}

module.exports = {
  listContacts,
  countContacts,
  createContact,
  createContactFromSource,
  findExistingContact,
  updateContact,
  deleteContact,
  SOURCES,
};
