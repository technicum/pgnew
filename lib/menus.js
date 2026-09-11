// WordPress-style saved navigation menus. A menu (pz_menus) is a named,
// reusable tree of items (pz_menu_items) scoped to one store. A nav_menu
// section (lib/sections.js) picks one by id instead of storing its own
// links inline, so the same menu can be reused across the header, the
// footer, and any per-page header/footer override -- edit it once on the
// Menus screen and every place that displays it updates together.
//
// One level of nesting only: a top-level item (parent_id NULL) can have
// children (rendered as a dropdown), but a child cannot have children of
// its own. That's enforced here at write time, not just in the admin UI --
// mirroring the way sanitizeRowBlock caps row-nesting depth in
// lib/sections.js -- so a malformed request can't smuggle in a deeper tree
// than the renderer (and the editor's own drag UI) know how to show.
//
// A saved item's `label` is a snapshot, same as WordPress: picking a page
// captures its current name as the label, which the merchant can then
// freely edit, and which does NOT silently change again if the page is
// later renamed. Only the item's *destination* (url) stays live -- if the
// underlying page/category/product is deleted or unpublished, resolveMenu
// below drops the item rather than rendering a dead link.
const { pool, TABLES } = require('../db/database');

const ITEM_TYPES = ['page', 'category', 'product', 'custom'];

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ---------- Menu CRUD ----------

async function listMenus(storeId) {
  const [rows] = await pool.query(
    `SELECT id, name, created_at, updated_at FROM ${TABLES.menus} WHERE store_id = ? ORDER BY name`,
    [storeId]
  );
  return rows;
}

async function getMenu(storeId, menuId) {
  const [[menu]] = await pool.query(
    `SELECT id, name, created_at, updated_at FROM ${TABLES.menus} WHERE store_id = ? AND id = ?`,
    [storeId, menuId]
  );
  return menu || null;
}

async function createMenu(storeId, name) {
  const cleanName = str(name, 100) || 'New menu';
  const [result] = await pool.query(`INSERT INTO ${TABLES.menus} (store_id, name) VALUES (?, ?)`, [storeId, cleanName]);
  return result.insertId;
}

async function renameMenu(storeId, menuId, name) {
  const cleanName = str(name, 100);
  if (!cleanName) return false;
  const [result] = await pool.query(`UPDATE ${TABLES.menus} SET name = ? WHERE store_id = ? AND id = ?`, [cleanName, storeId, menuId]);
  return result.affectedRows > 0;
}

async function deleteMenu(storeId, menuId) {
  // pz_menu_items cascades via its FK. Any nav_menu section still pointing
  // at this id is left alone -- resolveMenu/lib/sections.js treat a
  // menu_id that no longer exists the same as "no menu picked" (empty
  // nav), so deleting a menu in use can't 500 a storefront page; it just
  // makes that nav_menu section render empty until re-pointed.
  const [result] = await pool.query(`DELETE FROM ${TABLES.menus} WHERE store_id = ? AND id = ?`, [storeId, menuId]);
  return result.affectedRows > 0;
}

async function touchMenu(storeId, menuId) {
  await pool.query(`UPDATE ${TABLES.menus} SET updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND id = ?`, [storeId, menuId]);
}

// ---------- Items ----------

// Raw (unresolved) items for a menu, as a nested tree matching storage
// shape: [{ id, parent_id, position, type, target_id, label, url, children: [...] }]
async function getMenuItemsTree(storeId, menuId) {
  const menu = await getMenu(storeId, menuId);
  if (!menu) return null;
  const [rows] = await pool.query(
    `SELECT id, parent_id, position, type, target_id, label, url FROM ${TABLES.menuItems} WHERE menu_id = ? ORDER BY position, id`,
    [menuId]
  );
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const top = [];
  for (const row of byId.values()) {
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id).children.push(row);
    } else {
      top.push(row);
    }
  }
  return top;
}

// A page/category/product target must belong to the same store -- without
// this check a crafted request could add another store's product id to
// your menu and have its live title/url leak through resolveMenu.
async function targetExists(storeId, type, targetId) {
  if (!targetId) return false;
  let table;
  if (type === 'page') table = TABLES.pages;
  else if (type === 'category') table = TABLES.categories;
  else if (type === 'product') table = TABLES.products;
  else return false;
  const [[row]] = await pool.query(`SELECT id FROM ${table} WHERE store_id = ? AND id = ?`, [storeId, targetId]);
  return !!row;
}

function sanitizeItemInput(input) {
  const type = ITEM_TYPES.includes(input && input.type) ? input.type : 'custom';
  const out = { type, target_id: null, label: str(input && input.label, 150), url: null };
  if (type === 'custom') {
    out.url = str(input && input.url, 500) || '#';
    if (!out.label) out.label = 'Link';
  } else {
    const id = parseInt(input && input.target_id, 10);
    out.target_id = Number.isFinite(id) && id > 0 ? id : null;
    if (!out.label) out.label = 'Untitled';
  }
  return out;
}

// Adds one item. `input.parent_id`, if given, nests it as a dropdown child
// -- but only when that parent is itself top-level (one level of nesting).
async function addItem(storeId, menuId, input) {
  const menu = await getMenu(storeId, menuId);
  if (!menu) return { error: 'Menu not found' };

  const item = sanitizeItemInput(input);
  if (item.type !== 'custom') {
    const ok = await targetExists(storeId, item.type, item.target_id);
    if (!ok) return { error: 'That item no longer exists' };
  }

  let parentId = null;
  const rawParent = input && input.parent_id;
  if (rawParent) {
    const pid = parseInt(rawParent, 10);
    const [[parentRow]] = await pool.query(`SELECT id, parent_id FROM ${TABLES.menuItems} WHERE menu_id = ? AND id = ?`, [menuId, pid]);
    if (parentRow && !parentRow.parent_id) parentId = parentRow.id;
  }

  const [[{ maxPos }]] = await pool.query(
    `SELECT COALESCE(MAX(position), -1) AS maxPos FROM ${TABLES.menuItems} WHERE menu_id = ? AND parent_id ${parentId ? '= ?' : 'IS NULL'}`,
    parentId ? [menuId, parentId] : [menuId]
  );

  const [result] = await pool.query(
    `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label, url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [menuId, parentId, maxPos + 1, item.type, item.target_id, item.label, item.url]
  );
  await touchMenu(storeId, menuId);
  return { id: result.insertId };
}

// Edits an existing item's label (any type) and/or url (custom only --
// page/category/product items derive their url live from the target, see
// resolveMenu, so there's nothing to edit there).
async function updateItem(storeId, menuId, itemId, patch) {
  const menu = await getMenu(storeId, menuId);
  if (!menu) return { error: 'Menu not found' };
  const [[row]] = await pool.query(`SELECT id, type FROM ${TABLES.menuItems} WHERE menu_id = ? AND id = ?`, [menuId, itemId]);
  if (!row) return { error: 'Item not found' };

  const sets = [];
  const values = [];
  if (typeof (patch && patch.label) === 'string') {
    sets.push('label = ?');
    values.push(str(patch.label, 150) || (row.type === 'custom' ? 'Link' : 'Untitled'));
  }
  if (row.type === 'custom' && typeof (patch && patch.url) === 'string') {
    sets.push('url = ?');
    values.push(str(patch.url, 500) || '#');
  }
  if (!sets.length) return { ok: true };
  values.push(menuId, itemId);
  await pool.query(`UPDATE ${TABLES.menuItems} SET ${sets.join(', ')} WHERE menu_id = ? AND id = ?`, values);
  await touchMenu(storeId, menuId);
  return { ok: true };
}

async function deleteItem(storeId, menuId, itemId) {
  const menu = await getMenu(storeId, menuId);
  if (!menu) return false;
  // Children cascade via the FK -- removing a dropdown parent removes its
  // children with it rather than promoting them to top-level. Simple, and
  // matches what a merchant almost always wants when they delete a parent.
  const [result] = await pool.query(`DELETE FROM ${TABLES.menuItems} WHERE menu_id = ? AND id = ?`, [menuId, itemId]);
  if (result.affectedRows > 0) await touchMenu(storeId, menuId);
  return result.affectedRows > 0;
}

// Bulk-saves the whole structure after a drag-and-drop reorder/nest in the
// editor. `structure` is a flat array of { id, parent_id } in the new
// top-to-bottom (then within-dropdown) order the editor wants saved --
// position within each parent is just that array order, recomputed here.
// One level of nesting is enforced here too, not just client-side: an
// entry whose parent_id itself has a parent (in the submitted structure)
// is flattened to top-level instead of silently accepted.
async function saveStructure(storeId, menuId, structure) {
  const menu = await getMenu(storeId, menuId);
  if (!menu) return { error: 'Menu not found' };
  if (!Array.isArray(structure)) return { error: 'Invalid structure' };

  const [existingRows] = await pool.query(`SELECT id FROM ${TABLES.menuItems} WHERE menu_id = ?`, [menuId]);
  const validIds = new Set(existingRows.map((r) => r.id));

  const entries = structure
    .map((e) => ({ id: parseInt(e && e.id, 10), parent_id: e && e.parent_id ? parseInt(e.parent_id, 10) : null }))
    .filter((e) => validIds.has(e.id));
  const idsInStructure = new Set(entries.map((e) => e.id));
  const positions = new Map(); // parent key (0 = top-level) -> next position counter

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const entry of entries) {
      let parentId = entry.parent_id;
      if (parentId) {
        const parentEntry = entries.find((e) => e.id === parentId);
        const parentIsTopLevel = parentEntry && !parentEntry.parent_id;
        if (parentId === entry.id || !idsInStructure.has(parentId) || !parentIsTopLevel) parentId = null;
      }
      const key = parentId || 0;
      const position = positions.get(key) || 0;
      positions.set(key, position + 1);
      await conn.query(`UPDATE ${TABLES.menuItems} SET parent_id = ?, position = ? WHERE menu_id = ? AND id = ?`, [parentId, position, menuId, entry.id]);
    }
    await conn.query(`UPDATE ${TABLES.menus} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [menuId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { ok: true };
}

// ---------- Sources (for the editor's "add items" sidebar) ----------

// Everything a merchant can drag into a menu. Products is capped -- a
// picker, not a full catalog browser -- since a store can have thousands;
// good enough for v1, a search box can replace the cap later if needed.
async function listAddableSources(storeId) {
  const [[pages], [categories], [products]] = await Promise.all([
    pool.query(`SELECT id, name, path FROM ${TABLES.pages} WHERE store_id = ? AND status = 'published' ORDER BY name`, [storeId]),
    pool.query(`SELECT id, name FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]),
    pool.query(`SELECT id, title FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' ORDER BY title LIMIT 200`, [storeId]),
  ]);
  return { pages, categories, products };
}

// ---------- Resolution (live urls, for rendering) ----------

function pageUrl(path) {
  return `/pages${path || '/'}`;
}
function categoryUrl(name) {
  return `/?category=${encodeURIComponent(name)}`;
}
function productUrl(slug) {
  return `/products/${slug}`;
}

// Resolves a menu's saved item tree against the store's *current*
// pages/categories/products, for rendering -- the storefront nav and the
// admin builder's canvas preview both call this, so they can never drift
// from each other. An item whose target was deleted or unpublished since
// it was added is dropped rather than rendered as a dead link; a 'custom'
// link always survives since it doesn't depend on live data. Returns
// [{ id, label, url, children: [...] }] ready to render.
async function resolveMenu(storeId, menuId) {
  if (!menuId) return [];
  const tree = await getMenuItemsTree(storeId, menuId);
  if (!tree) return [];

  const [[pages], [categories], [products]] = await Promise.all([
    pool.query(`SELECT id, name, path FROM ${TABLES.pages} WHERE store_id = ? AND status = 'published'`, [storeId]),
    pool.query(`SELECT id, name FROM ${TABLES.categories} WHERE store_id = ?`, [storeId]),
    pool.query(`SELECT id, title, slug FROM ${TABLES.products} WHERE store_id = ? AND status = 'active'`, [storeId]),
  ]);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const productById = new Map(products.map((p) => [p.id, p]));

  function resolveOne(item) {
    if (item.type === 'custom') return { id: item.id, label: item.label || 'Link', url: item.url || '#' };
    if (item.type === 'page') {
      const p = pageById.get(item.target_id);
      return p ? { id: item.id, label: item.label || p.name, url: pageUrl(p.path) } : null;
    }
    if (item.type === 'category') {
      const c = categoryById.get(item.target_id);
      return c ? { id: item.id, label: item.label || c.name, url: categoryUrl(c.name) } : null;
    }
    if (item.type === 'product') {
      const p = productById.get(item.target_id);
      return p ? { id: item.id, label: item.label || p.title, url: productUrl(p.slug) } : null;
    }
    return null;
  }

  const out = [];
  for (const item of tree) {
    const resolved = resolveOne(item);
    if (!resolved) continue;
    resolved.children = (item.children || []).map(resolveOne).filter(Boolean);
    out.push(resolved);
  }
  return out;
}

module.exports = {
  ITEM_TYPES,
  listMenus,
  getMenu,
  createMenu,
  renameMenu,
  deleteMenu,
  getMenuItemsTree,
  addItem,
  updateItem,
  deleteItem,
  saveStructure,
  listAddableSources,
  resolveMenu,
};
