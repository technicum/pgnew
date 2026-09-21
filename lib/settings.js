// Platform-wide settings edited from Platform Admin > Settings (SMTP, Google
// Drive keys, ...), stored one row per key in pz_settings.
//
// Adding a new setting is a one-line change to GROUPS below — the settings
// page, validation, storage and encryption all read from it.
//
// Lookup order for every setting: the value saved in the admin, else the
// group's env var (so an existing .env keeps working untouched), else the
// field's default. Fields marked `secret` are encrypted at rest and never
// sent back to the browser.
const crypto = require('crypto');
const { pool, TABLES } = require('../db/database');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GROUPS = [
  {
    id: 'smtp',
    title: 'Email (SMTP)',
    description: 'Outgoing mail server used to send emails from the platform.',
    fields: [
      { key: 'smtp.host', label: 'SMTP host', type: 'text', env: 'SMTP_HOST', placeholder: 'smtp.gmail.com', max: 255 },
      { key: 'smtp.port', label: 'Port', type: 'number', env: 'SMTP_PORT', default: '587', hint: '587 (STARTTLS) or 465 (SSL) are the usual ones.' },
      {
        key: 'smtp.secure', label: 'Encryption', type: 'select', env: 'SMTP_SECURE', default: 'starttls',
        options: [
          { value: 'starttls', label: 'STARTTLS (port 587)' },
          { value: 'ssl', label: 'SSL/TLS (port 465)' },
          { value: 'none', label: 'None' },
        ],
      },
      { key: 'smtp.user', label: 'Username', type: 'text', env: 'SMTP_USER', autocomplete: 'off', max: 255 },
      { key: 'smtp.pass', label: 'Password', type: 'password', env: 'SMTP_PASS', secret: true, hint: 'For Gmail, use an App Password, not your normal password.' },
      { key: 'smtp.from_name', label: 'From name', type: 'text', env: 'SMTP_FROM_NAME', placeholder: 'PageZaper', max: 100 },
      { key: 'smtp.from_email', label: 'From email', type: 'email', env: 'SMTP_FROM_EMAIL', placeholder: 'no-reply@yourdomain.com', max: 255 },
    ],
  },
  {
    id: 'google_drive',
    title: 'Google Drive import',
    description: 'Lets merchants import leads from Google Drive (Leads > Import leads). Both values are public, browser-side identifiers, not secrets.',
    fields: [
      { key: 'google_drive.client_id', label: 'OAuth Client ID', type: 'text', env: 'GOOGLE_DRIVE_CLIENT_ID', placeholder: '123456789012-abc….apps.googleusercontent.com', max: 255 },
      { key: 'google_drive.api_key', label: 'API key', type: 'text', env: 'GOOGLE_DRIVE_API_KEY', placeholder: 'AIza…', max: 255 },
    ],
  },
];

const FIELDS = new Map();
GROUPS.forEach((g) => g.fields.forEach((f) => FIELDS.set(f.key, f)));

// ---------- Encryption for secret values ----------
// AES-256-GCM. The key is derived from SETTINGS_SECRET (or, failing that,
// SESSION_SECRET) — so changing that secret makes saved passwords
// undecryptable, which reads as "not set" and just needs re-entering.
function encryptionKey() {
  const secret = process.env.SETTINGS_SECRET || process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-me';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

function decrypt(stored) {
  if (!stored.startsWith('enc:v1:')) return null;
  try {
    const raw = Buffer.from(stored.slice(7), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

// ---------- Reading ----------
// Short in-process cache so a page render doesn't hit the DB per setting.
// Saves from this process clear it at once; another process (multi-instance
// deploy) picks a change up within the TTL.
const CACHE_TTL_MS = 15 * 1000;
let cache = null;
let cacheAt = 0;

async function loadStored() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  const [rows] = await pool.query(`SELECT setting_key, setting_value FROM ${TABLES.settings}`);
  cache = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  cacheAt = Date.now();
  return cache;
}

function clearCache() {
  cache = null;
}

// The effective value for a field and where it came from: 'admin' (saved
// here), 'env', 'default' or 'unset'.
function resolve(field, stored) {
  const raw = stored.get(field.key);
  if (raw !== undefined) {
    const value = field.secret ? decrypt(raw) : raw;
    if (value) return { value, source: 'admin' };
  }
  const fromEnv = field.env ? process.env[field.env] : '';
  if (fromEnv) return { value: fromEnv, source: 'env' };
  if (field.default) return { value: field.default, source: 'default' };
  return { value: '', source: 'unset' };
}

async function get(key) {
  const field = FIELDS.get(key);
  if (!field) throw new Error(`Unknown setting: ${key}`);
  return resolve(field, await loadStored()).value;
}

// Effective values of one group keyed by the short name, e.g.
// getGroup('google_drive') -> { client_id, api_key }.
async function getGroup(groupId) {
  const group = GROUPS.find((g) => g.id === groupId);
  if (!group) throw new Error(`Unknown settings group: ${groupId}`);
  const stored = await loadStored();
  const out = {};
  group.fields.forEach((f) => { out[f.key.slice(groupId.length + 1)] = resolve(f, stored).value; });
  return out;
}

// What the settings page needs: per field its current value (never a
// secret's), whether it's set, and where the effective value comes from.
async function describeGroups() {
  const stored = await loadStored();
  return GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    fields: g.fields.map((f) => {
      const { value, source } = resolve(f, stored);
      return {
        ...f,
        value: f.secret ? '' : value,
        isSet: source !== 'unset' && source !== 'default',
        source,
      };
    }),
  }));
}

// ---------- Writing ----------
function validate(field, value) {
  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return `${field.label} must be a number between 1 and 65535.`;
  }
  if (field.type === 'email' && !EMAIL_RE.test(value)) return `${field.label} must be a valid email address.`;
  if (field.type === 'select' && !field.options.some((o) => o.value === value)) return `${field.label} has an invalid choice.`;
  if (/\s/.test(value) && (field.key === 'smtp.host' || field.key.startsWith('google_drive.'))) {
    return `${field.label} can't contain spaces.`;
  }
  return null;
}

// Saves one group from a submitted form body. Per field: a blank value
// removes the saved setting (falling back to env/default); a secret left
// blank is kept as-is unless its "clear" box is ticked. Returns
// { errors: [...] } and writes nothing if any field is invalid.
async function saveGroup(groupId, body) {
  const group = GROUPS.find((g) => g.id === groupId);
  if (!group) return { errors: ['Unknown settings section.'] };
  body = body || {};

  const errors = [];
  const writes = []; // [key, storedValue | null (delete)]
  group.fields.forEach((f) => {
    const name = f.key.replace('.', '_');
    let value = String(body[name] == null ? '' : body[name]).trim();
    if (f.max) value = value.slice(0, f.max);

    if (f.secret) {
      if (body[`clear_${name}`]) writes.push([f.key, null]);
      else if (value) writes.push([f.key, encrypt(value)]);
      return; // blank + no clear = leave the saved secret alone
    }
    if (!value) return writes.push([f.key, null]);
    const problem = validate(f, value);
    if (problem) errors.push(problem);
    else writes.push([f.key, value]);
  });
  if (errors.length) return { errors };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [key, stored] of writes) {
      if (stored === null) {
        await conn.query(`DELETE FROM ${TABLES.settings} WHERE setting_key = ?`, [key]);
      } else {
        await conn.query(
          `INSERT INTO ${TABLES.settings} (setting_key, setting_value) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
          [key, stored]
        );
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    clearCache();
  }
  return { errors: [] };
}

module.exports = { GROUPS, get, getGroup, describeGroups, saveGroup };
