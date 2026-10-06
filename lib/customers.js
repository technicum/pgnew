// Buyer accounts — the people who pay on a store's payment pages, kept
// apart from PDZ_users (the creators who own the stores). One account
// works on every store; it holds the buyer's name, email and any number
// of saved delivery addresses, which prefill checkout once they've signed
// in on a store (lib/customerAccount.js has the routes).
//
// Same lazy-migration pattern as lib/users.js: both tables are created on
// first use.
const bcrypt = require('bcryptjs');
const pool = require('./db');

const TABLE = 'PDZ_customers';
const ADDRESS_TABLE = 'PDZ_customer_addresses';
// Plenty for home / work / family, and keeps the checkout list short.
const MAX_ADDRESSES = 10;

let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          email VARCHAR(190) NOT NULL UNIQUE,
          password_hash VARCHAR(100) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${ADDRESS_TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT NOT NULL,
          label VARCHAR(40) NOT NULL DEFAULT '',
          name VARCHAR(120) NOT NULL DEFAULT '',
          line VARCHAR(200) NOT NULL,
          city VARCHAR(80) NOT NULL,
          pincode VARCHAR(10) NOT NULL,
          phone VARCHAR(30) NOT NULL DEFAULT '',
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX (customer_id)
        )
      `);
    })().catch((err) => {
      tablesReady = null;
      throw err;
    });
  }
  return tablesReady;
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

// What goes in the session — never the password hash.
function toPublicCustomer(c) {
  return { id: c.id, name: c.name, email: c.email };
}

async function findCustomerByEmail(email) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE email = ? LIMIT 1`, [normalizeEmail(email)]);
  return rows[0] || null;
}

async function getCustomer(id) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT id, name, email, created_at FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function createCustomer({ name, email, password }) {
  await ensureTables();
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      `INSERT INTO ${TABLE} (name, email, password_hash) VALUES (?, ?, ?)`,
      [String(name).trim().slice(0, 120), normalizeEmail(email), passwordHash],
    );
    return getCustomer(result.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const dupErr = new Error('An account with that email already exists.');
      dupErr.code = 'EMAIL_TAKEN';
      throw dupErr;
    }
    throw err;
  }
}

async function verifyCustomerPassword(customer, password) {
  return bcrypt.compare(String(password || ''), customer.password_hash);
}

// --- addresses ------------------------------------------------------------

// A posted address → the stored shape, or { error }. The same rules
// checkout applies (lib/paymentStorefront.js buyerError).
function cleanAddress(raw) {
  const a = {
    label: String(raw?.label || '').trim().slice(0, 40),
    name: String(raw?.name || '').trim().slice(0, 120),
    line: String(raw?.line || '').trim().slice(0, 200),
    city: String(raw?.city || '').trim().slice(0, 80),
    pincode: String(raw?.pincode || '').trim().slice(0, 10),
    phone: String(raw?.phone || '').trim().slice(0, 30),
  };
  if (a.line.length < 5) return { error: 'Add the street address.' };
  if (!a.city) return { error: 'Add the city.' };
  if (!/^\d{6}$/.test(a.pincode)) return { error: 'Pincodes are 6 digits.' };
  if (a.phone && !/^\+?[\d\s().-]{6,}$/.test(a.phone)) return { error: 'That phone number doesn’t look right.' };
  return { address: a };
}

// Default first, then newest.
async function listAddresses(customerId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id, label, name, line, city, pincode, phone, is_default FROM ${ADDRESS_TABLE}
     WHERE customer_id = ? ORDER BY is_default DESC, id DESC`,
    [customerId],
  );
  return rows.map((r) => ({ ...r, is_default: !!r.is_default }));
}

async function getAddress(customerId, id) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id, label, name, line, city, pincode, phone, is_default FROM ${ADDRESS_TABLE} WHERE id = ? AND customer_id = ? LIMIT 1`,
    [Number(id) || 0, customerId],
  );
  return rows[0] ? { ...rows[0], is_default: !!rows[0].is_default } : null;
}

// Saves an already-cleaned address. The first one saved becomes the
// default; `makeDefault` moves the default to this one.
async function addAddress(customerId, address, { makeDefault = false } = {}) {
  await ensureTables();
  const existing = await listAddresses(customerId);
  if (existing.length >= MAX_ADDRESSES) {
    const err = new Error(`You can save up to ${MAX_ADDRESSES} addresses — remove one first.`);
    err.code = 'TOO_MANY_ADDRESSES';
    throw err;
  }
  // The same address saved twice (checkout's "save" ticked again) isn't a new one.
  const same = existing.find((a) => a.line.toLowerCase() === address.line.toLowerCase()
    && a.pincode === address.pincode && a.city.toLowerCase() === address.city.toLowerCase());
  if (same) return same;
  const isDefault = makeDefault || !existing.length;
  if (isDefault) await pool.query(`UPDATE ${ADDRESS_TABLE} SET is_default = 0 WHERE customer_id = ?`, [customerId]);
  const [result] = await pool.query(
    `INSERT INTO ${ADDRESS_TABLE} (customer_id, label, name, line, city, pincode, phone, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerId, address.label, address.name, address.line, address.city, address.pincode, address.phone, isDefault ? 1 : 0],
  );
  return getAddress(customerId, result.insertId);
}

async function deleteAddress(customerId, id) {
  const address = await getAddress(customerId, id);
  if (!address) return;
  await pool.query(`DELETE FROM ${ADDRESS_TABLE} WHERE id = ? AND customer_id = ?`, [address.id, customerId]);
  // Removing the default hands it to the newest remaining address.
  if (address.is_default) {
    await pool.query(
      `UPDATE ${ADDRESS_TABLE} SET is_default = 1 WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
      [customerId],
    );
  }
}

async function setDefaultAddress(customerId, id) {
  const address = await getAddress(customerId, id);
  if (!address) return;
  await pool.query(`UPDATE ${ADDRESS_TABLE} SET is_default = (id = ?) WHERE customer_id = ?`, [address.id, customerId]);
}

module.exports = {
  findCustomerByEmail,
  getCustomer,
  createCustomer,
  verifyCustomerPassword,
  toPublicCustomer,
  cleanAddress,
  listAddresses,
  getAddress,
  addAddress,
  deleteAddress,
  setDefaultAddress,
  MAX_ADDRESSES,
};
