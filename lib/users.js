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

module.exports = { findUserByEmail, createUser, verifyPassword, toPublicUser };
