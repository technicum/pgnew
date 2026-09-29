// User accounts, backed by MySQL (via lib/db.js's connection pool).
//
// The PDZ_users table is created automatically on first use — there's no
// separate migration step to run. It only issues CREATE TABLE IF NOT
// EXISTS, so it's safe to boot against a database that already has this
// table (from a previous run, or from the original PageZaper setup).
// DB_NAME itself must already exist on the server; this doesn't create
// the database, only the table inside it.
//
// PDZ_ prefix keeps this table namespaced in case the database ends up
// shared with other apps/tables later — same idea as PageZaper's old
// pz_media convention, just spelled out in full.
const bcrypt = require('bcryptjs');
const pool = require('./db');

const TABLE = 'PDZ_users';

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(190) NOT NULL UNIQUE,
        handle VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(100) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `).catch((err) => {
      // Let the next call retry instead of caching a failed connection
      // attempt forever (e.g. the DB was briefly unreachable at boot).
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// Added after PDZ_users already existed in production, so CREATE TABLE IF
// NOT EXISTS alone won't add these to an existing table — this runs each
// ALTER separately and swallows "column already exists" so it's safe to
// call on every boot, same lazy-migration idea as ensureTable() above.
let columnsReady = null;
function ensureProfileColumns() {
  if (!columnsReady) {
    columnsReady = (async () => {
      const addColumn = async (sql) => {
        try {
          await pool.query(sql);
        } catch (err) {
          if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
      };
      await ensureTable();
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN bio VARCHAR(280) NOT NULL DEFAULT ''`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN accent_color VARCHAR(7) NOT NULL DEFAULT '#ff6b4a'`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN show_badge TINYINT(1) NOT NULL DEFAULT 1`);
    })().catch((err) => {
      columnsReady = null;
      throw err;
    });
  }
  return columnsReady;
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24) || 'creator';
}

async function uniqueHandle(baseName) {
  const base = slugify(baseName);
  const [rows] = await pool.query(`SELECT handle FROM ${TABLE} WHERE handle LIKE ?`, [`${base}%`]);
  const taken = new Set(rows.map((r) => r.handle));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

async function findUserByEmail(email) {
  await ensureTable();
  const normalized = String(email).trim().toLowerCase();
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE email = ? LIMIT 1`, [normalized]);
  return rows[0] || null;
}

async function createUser({ name, email, password }) {
  await ensureTable();
  const normalizedEmail = String(email).trim().toLowerCase();
  const trimmedName = String(name).trim();

  const existing = await findUserByEmail(normalizedEmail);
  if (existing) {
    const err = new Error('An account with that email already exists.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }

  const handle = await uniqueHandle(trimmedName);
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const [result] = await pool.query(
      `INSERT INTO ${TABLE} (name, email, handle, password_hash) VALUES (?, ?, ?, ?)`,
      [trimmedName, normalizedEmail, handle, passwordHash],
    );
    return {
      id: result.insertId,
      name: trimmedName,
      email: normalizedEmail,
      handle,
      password_hash: passwordHash,
      created_at: new Date(),
    };
  } catch (err) {
    // Race condition: two signups with the same email landed between the
    // findUserByEmail check above and this INSERT. The UNIQUE constraint
    // on email catches it — surface it the same way the pre-check does.
    if (err.code === 'ER_DUP_ENTRY') {
      const dupErr = new Error('An account with that email already exists.');
      dupErr.code = 'EMAIL_TAKEN';
      throw dupErr;
    }
    throw err;
  }
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

async function findUserById(id) {
  await ensureProfileColumns();
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

// For public-facing routes that resolve a handle from the URL (lead magnet
// pages today; the storefront page itself once that's built) rather than
// from the logged-in session.
async function findUserByHandle(handle) {
  await ensureProfileColumns();
  const normalized = String(handle || '').trim().toLowerCase();
  if (!normalized) return null;
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE handle = ? LIMIT 1`, [normalized]);
  return rows[0] || null;
}

// Fields the builder's Profile tab is allowed to change. Handle changes are
// checked for uniqueness the same way signup checks email — the UNIQUE
// constraint is the real backstop, this just gives a friendly error first.
async function updateProfile(userId, { name, handle, bio }) {
  await ensureProfileColumns();
  const trimmedName = String(name || '').trim();
  const trimmedHandle = slugify(handle || '');
  const trimmedBio = String(bio || '').slice(0, 280);

  if (!trimmedName) {
    const err = new Error('Name can’t be empty.');
    err.code = 'NAME_REQUIRED';
    throw err;
  }
  if (!trimmedHandle) {
    const err = new Error('Handle can’t be empty.');
    err.code = 'HANDLE_REQUIRED';
    throw err;
  }

  const [existingRows] = await pool.query(
    `SELECT id FROM ${TABLE} WHERE handle = ? AND id != ? LIMIT 1`,
    [trimmedHandle, userId],
  );
  if (existingRows.length) {
    const err = new Error('That handle is already taken.');
    err.code = 'HANDLE_TAKEN';
    throw err;
  }

  try {
    await pool.query(
      `UPDATE ${TABLE} SET name = ?, handle = ?, bio = ? WHERE id = ?`,
      [trimmedName, trimmedHandle, trimmedBio, userId],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dupErr = new Error('That handle is already taken.');
      dupErr.code = 'HANDLE_TAKEN';
      throw dupErr;
    }
    throw err;
  }

  return findUserById(userId);
}

async function updateDesign(userId, { accentColor, showBadge }) {
  await ensureProfileColumns();
  const validColor = /^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : '#ff6b4a';
  await pool.query(
    `UPDATE ${TABLE} SET accent_color = ?, show_badge = ? WHERE id = ?`,
    [validColor, showBadge ? 1 : 0, userId],
  );
  return findUserById(userId);
}

// Shape passed into session / views — never include password_hash past
// this point.
function toPublicUser(user) {
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || 'U';
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    handle: user.handle,
    initials,
  };
}

module.exports = {
  findUserByEmail,
  findUserById,
  findUserByHandle,
  createUser,
  verifyPassword,
  toPublicUser,
  updateProfile,
  updateDesign,
};
