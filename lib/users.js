// Simple file-backed user store.
//
// Slotpay doesn't have a database wired up yet (this app was rebuilt from
// scratch as a homepage-only project — see server.js). Rather than bring
// back a full MySQL layer just to support login/signup, this stores users
// as JSON on disk. It's a real, working store — passwords are hashed,
// emails are unique — just not one that scales past a single small VPS.
// Swap this file out for a proper DB-backed model later without touching
// server.js's route logic (the function signatures below are what matter).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]\n');
}

function readAll() {
  ensureStore();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('users.json is unreadable, starting from an empty store:', err.message);
    return [];
  }
}

function writeAll(users) {
  ensureStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n');
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24) || 'creator';
}

function uniqueHandle(users, baseName) {
  const base = slugify(baseName);
  const taken = new Set(users.map((u) => u.handle));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

function findUserByEmail(email) {
  const normalized = String(email).trim().toLowerCase();
  return readAll().find((u) => u.email === normalized) || null;
}

async function createUser({ name, email, password }) {
  const users = readAll();
  const normalizedEmail = String(email).trim().toLowerCase();
  if (users.some((u) => u.email === normalizedEmail)) {
    const err = new Error('An account with that email already exists.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: String(name).trim(),
    email: normalizedEmail,
    handle: uniqueHandle(users, name),
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeAll(users);
  return user;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.passwordHash);
}

// Shape passed into session / views — never include passwordHash past this point.
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
