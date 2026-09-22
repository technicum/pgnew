// Metaobjects (Shopify's term for this) -- a merchant-defined custom
// content type (a "definition", e.g. "Property" for a real-estate store)
// with its own field schema, plus the actual entries of that type (one
// specific property). See db/database.js's CREATE TABLE comments for
// pz_metaobject_definitions / pz_metaobject_fields / pz_listings for the
// full storage design -- entries live in pz_listings (the same table the
// app already had a stub for), tagged with which definition they belong to.
const { pool, TABLES } = require('../db/database');

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Handles that would collide with an existing fixed storefront route prefix
// (see routes/storefront.js's /:handle/:slug entry-detail route) -- kept in
// lockstep with that router's own literal route paths by hand, the same way
// db/database.js's RESERVED_SUBDOMAINS is kept in lockstep with its own
// fixed subdomains.
const RESERVED_HANDLES = new Set([
  '', 'store', 'pages', 'page', 'newsletter', 'products', 'product', 'blog',
  'account', 'cart', 'checkout', 'admin', 'platform-admin', 'login', 'signup',
]);

function sanitizeHandle(str) {
  return slugify(str).slice(0, 50);
}

const FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'date', 'url', 'image', 'select'];
const FIELD_TYPE_LABELS = {
  text: 'Text (single line)',
  textarea: 'Text (paragraph)',
  number: 'Number',
  boolean: 'Yes / No',
  date: 'Date',
  url: 'Link (URL)',
  image: 'Image',
  select: 'Dropdown',
};

// ---- Definitions (the schema/type, e.g. "Property") ----

async function listDefinitions(storeId) {
  const [rows] = await pool.query(
    `SELECT d.*, (SELECT COUNT(*) FROM ${TABLES.listings} l WHERE l.definition_id = d.id) AS entry_count
     FROM ${TABLES.metaobjectDefinitions} d
     WHERE d.store_id = ? ORDER BY d.created_at ASC`,
    [storeId]
  );
  return rows;
}

async function getDefinition(storeId, id) {
  const [[def]] = await pool.query(`SELECT * FROM ${TABLES.metaobjectDefinitions} WHERE store_id = ? AND id = ?`, [storeId, id]);
  return def || null;
}

async function getDefinitionByHandle(storeId, handle) {
  const [[def]] = await pool.query(`SELECT * FROM ${TABLES.metaobjectDefinitions} WHERE store_id = ? AND handle = ?`, [storeId, handle]);
  return def || null;
}

async function assertHandleAvailable(storeId, handle, excludeId) {
  if (!handle || RESERVED_HANDLES.has(handle)) {
    throw new Error(`"${handle || '(blank)'}" can't be used as a handle -- pick another.`);
  }
  const [[existing]] = await pool.query(
    `SELECT id FROM ${TABLES.metaobjectDefinitions} WHERE store_id = ? AND handle = ?${excludeId ? ' AND id != ?' : ''}`,
    excludeId ? [storeId, handle, excludeId] : [storeId, handle]
  );
  if (existing) throw new Error(`You already have a type with the handle "${handle}".`);
}

async function createDefinition(storeId, { name, handle }) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('Name is required.');
  const cleanHandle = sanitizeHandle(handle || name);
  await assertHandleAvailable(storeId, cleanHandle);
  const [result] = await pool.query(
    `INSERT INTO ${TABLES.metaobjectDefinitions} (store_id, name, handle) VALUES (?, ?, ?)`,
    [storeId, cleanName, cleanHandle]
  );
  return result.insertId;
}

async function updateDefinition(storeId, id, { name, handle }) {
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw new Error('Name is required.');
  const cleanHandle = sanitizeHandle(handle || name);
  await assertHandleAvailable(storeId, cleanHandle, id);
  await pool.query(`UPDATE ${TABLES.metaobjectDefinitions} SET name = ?, handle = ? WHERE store_id = ? AND id = ?`, [
    cleanName, cleanHandle, storeId, id,
  ]);
  // listing_type on every existing entry is denormalized from the
  // definition's handle (see db/database.js's comment on pz_listings) --
  // keep it in sync so a handle rename doesn't leave entries pointing at a
  // listing_type that no longer matches how their own URL resolves.
  await pool.query(`UPDATE ${TABLES.listings} SET listing_type = ? WHERE definition_id = ?`, [cleanHandle, id]);
}

// ON DELETE CASCADE on both metaobject_fields.definition_id and
// listings.definition_id takes care of the schema + every entry.
async function deleteDefinition(storeId, id) {
  await pool.query(`DELETE FROM ${TABLES.metaobjectDefinitions} WHERE store_id = ? AND id = ?`, [storeId, id]);
}

// ---- Fields (one definition's schema) ----

async function listFields(definitionId) {
  const [rows] = await pool.query(
    `SELECT * FROM ${TABLES.metaobjectFields} WHERE definition_id = ? ORDER BY position ASC, id ASC`,
    [definitionId]
  );
  return rows.map((f) => ({ ...f, options: f.options || [] }));
}

function sanitizeFieldKey(str) {
  return slugify(str).replace(/-/g, '_').slice(0, 50);
}

// Textarea input, one option per line -- same "one per line" convention as
// lib/sections.js's logos.names field.
function sanitizeFieldOptions(raw) {
  return String(raw || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((s) => s.slice(0, 100));
}

async function addField(definitionId, { key, label, type, required, options }) {
  const cleanLabel = String(label || '').trim().slice(0, 100);
  if (!cleanLabel) throw new Error('Field label is required.');
  const cleanKey = sanitizeFieldKey(key || label);
  if (!cleanKey) throw new Error('Could not derive a field key from that label -- try a simpler one.');
  const cleanType = FIELD_TYPES.includes(type) ? type : 'text';
  const [[existing]] = await pool.query(
    `SELECT id FROM ${TABLES.metaobjectFields} WHERE definition_id = ? AND field_key = ?`,
    [definitionId, cleanKey]
  );
  if (existing) throw new Error(`This type already has a field keyed "${cleanKey}" -- use a different label.`);
  const [[{ nextPosition }]] = await pool.query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM ${TABLES.metaobjectFields} WHERE definition_id = ?`,
    [definitionId]
  );
  await pool.query(
    `INSERT INTO ${TABLES.metaobjectFields} (definition_id, field_key, label, type, required, options, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      definitionId,
      cleanKey,
      cleanLabel,
      cleanType,
      required ? 1 : 0,
      cleanType === 'select' ? JSON.stringify(sanitizeFieldOptions(options)) : null,
      nextPosition,
    ]
  );
}

async function updateField(definitionId, fieldId, { label, type, required, options }) {
  const cleanLabel = String(label || '').trim().slice(0, 100);
  if (!cleanLabel) throw new Error('Field label is required.');
  const cleanType = FIELD_TYPES.includes(type) ? type : 'text';
  await pool.query(
    `UPDATE ${TABLES.metaobjectFields} SET label = ?, type = ?, required = ?, options = ?
     WHERE definition_id = ? AND id = ?`,
    [
      cleanLabel,
      cleanType,
      required ? 1 : 0,
      cleanType === 'select' ? JSON.stringify(sanitizeFieldOptions(options)) : null,
      definitionId,
      fieldId,
    ]
  );
}

async function deleteField(definitionId, fieldId) {
  await pool.query(`DELETE FROM ${TABLES.metaobjectFields} WHERE definition_id = ? AND id = ?`, [definitionId, fieldId]);
}

// ---- Field values (an entry's answer to each of its definition's fields) ----

function sanitizeFieldValue(field, raw) {
  switch (field.type) {
    case 'number': {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      // Unchecked checkboxes don't appear in the submitted body at all --
      // anything present here means it was checked.
      return raw !== undefined && raw !== '' && raw !== '0' && raw !== 'false';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(raw || '')) ? raw : null;
    case 'url': {
      const u = String(raw || '').trim();
      return /^https?:\/\//i.test(u) ? u.slice(0, 500) : '';
    }
    case 'image':
      return String(raw || '').trim().slice(0, 1000);
    case 'select':
      return (field.options || []).includes(raw) ? raw : null;
    case 'textarea':
      return String(raw || '').trim().slice(0, 5000);
    case 'text':
    default:
      return String(raw || '').trim().slice(0, 500);
  }
}

// body is a submitted entry form's req.body -- each field's value is read
// from body['field_' + field_key], prefixed so it can never collide with
// the entry's own title/status/image_url inputs on the same form.
function sanitizeFieldValues(fields, body) {
  const values = {};
  fields.forEach((f) => {
    values[f.field_key] = sanitizeFieldValue(f, body[`field_${f.field_key}`]);
  });
  return values;
}

// ---- Entries (rows in pz_listings scoped to one definition) ----

async function listEntries(storeId, definitionId) {
  const [rows] = await pool.query(
    `SELECT * FROM ${TABLES.listings} WHERE store_id = ? AND definition_id = ? ORDER BY created_at DESC`,
    [storeId, definitionId]
  );
  return rows;
}

async function getEntry(storeId, definitionId, entryId) {
  const [[entry]] = await pool.query(
    `SELECT * FROM ${TABLES.listings} WHERE store_id = ? AND definition_id = ? AND id = ?`,
    [storeId, definitionId, entryId]
  );
  return entry || null;
}

async function getEntryBySlug(storeId, definitionId, slug) {
  const [[entry]] = await pool.query(
    `SELECT * FROM ${TABLES.listings} WHERE store_id = ? AND definition_id = ? AND slug = ?`,
    [storeId, definitionId, slug]
  );
  return entry || null;
}

async function createEntry(storeId, definition, { title, image_url, status }, fieldValues) {
  const cleanTitle = String(title || '').trim().slice(0, 255);
  if (!cleanTitle) throw new Error('Title is required.');
  let slug = slugify(cleanTitle);
  const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.listings} WHERE store_id = ? AND slug = ?`, [storeId, slug]);
  if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;
  const [result] = await pool.query(
    `INSERT INTO ${TABLES.listings} (store_id, definition_id, listing_type, title, slug, image_url, status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      storeId,
      definition.id,
      definition.handle,
      cleanTitle,
      slug,
      String(image_url || '').trim().slice(0, 1000),
      status === 'draft' ? 'draft' : 'active',
      JSON.stringify(fieldValues),
    ]
  );
  return result.insertId;
}

async function updateEntry(storeId, definitionId, entryId, { title, image_url, status }, fieldValues) {
  const cleanTitle = String(title || '').trim().slice(0, 255);
  if (!cleanTitle) throw new Error('Title is required.');
  await pool.query(
    `UPDATE ${TABLES.listings} SET title = ?, image_url = ?, status = ?, details = ?
     WHERE store_id = ? AND definition_id = ? AND id = ?`,
    [
      cleanTitle,
      String(image_url || '').trim().slice(0, 1000),
      status === 'draft' ? 'draft' : 'active',
      JSON.stringify(fieldValues),
      storeId,
      definitionId,
      entryId,
    ]
  );
}

async function deleteEntry(storeId, definitionId, entryId) {
  await pool.query(`DELETE FROM ${TABLES.listings} WHERE store_id = ? AND definition_id = ? AND id = ?`, [storeId, definitionId, entryId]);
}

module.exports = {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  RESERVED_HANDLES,
  sanitizeHandle,
  listDefinitions,
  getDefinition,
  getDefinitionByHandle,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  listFields,
  addField,
  updateField,
  deleteField,
  sanitizeFieldValues,
  listEntries,
  getEntry,
  getEntryBySlug,
  createEntry,
  updateEntry,
  deleteEntry,
};
