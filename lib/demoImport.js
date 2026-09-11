// "Import demo content" — copies a theme's dedicated demo store (see
// db/database.js's migrateThemeDemoStores, pz_themes.demo_store_id) into a
// merchant's own store: its categories, products, pages, saved menus, and
// header/footer/body sections. This is what makes "Import with demo" on the
// admin Themes page actually match the demo the merchant just looked at,
// instead of activating a theme onto whatever (possibly empty) content the
// store already has.
//
// Two ground rules, matching what was confirmed with the merchant before
// building this:
//   1. Categories and products are ADDITIVE — never deleted. A merchant's
//      own catalog is never at risk; demo products are added alongside it
//      (skipped, not duplicated, if a matching slug/name already exists —
//      see cloneCategories/cloneProducts below — so re-running this is
//      safe).
//   2. Home page body sections, plus header/footer sections, are REPLACED —
//      the caller is expected to have confirmed this with the merchant
//      first (routes/admin.js's /store/themes/import-demo does, via the
//      same confirm() pattern already used for "Activate theme").
//
// Everything runs in one transaction so a failure partway through can't
// leave a half-imported store.
const { TABLES } = require('../db/database');

function str(v) {
  return typeof v === 'string' ? v : null;
}

// Deep-clones a section's `fields` JSON, remapping the two places a field
// can hold a foreign id into another store's data (see lib/sections.js —
// these are the ONLY two: spotlight.product_id and nav_menu.menu_id). Also
// walks into a 'row' section's nested column blocks, since a block can be
// any nestable section type, spotlight/nav_menu included.
function remapSectionFields(type, fields, maps) {
  const out = fields && typeof fields === 'object' ? JSON.parse(JSON.stringify(fields)) : fields;
  if (!out || typeof out !== 'object') return out;
  if (type === 'spotlight' && out.product_id) {
    out.product_id = maps.productIdMap.get(out.product_id) || null;
  } else if (type === 'nav_menu' && out.menu_id) {
    out.menu_id = maps.menuIdMap.get(out.menu_id) || null;
  } else if (type === 'row' && Array.isArray(out.columns)) {
    out.columns = out.columns.map((col) => ({
      ...col,
      blocks: Array.isArray(col.blocks)
        ? col.blocks.map((b) => (b && typeof b === 'object' ? { ...b, fields: remapSectionFields(b.type, b.fields, maps) } : b))
        : col.blocks,
    }));
  }
  return out;
}

function remapMenuItemTarget(type, targetId, maps) {
  if (targetId == null) return null;
  if (type === 'page') return maps.pageIdMap.get(targetId) || null;
  if (type === 'category') return maps.categoryIdMap.get(targetId) || null;
  if (type === 'product') return maps.productIdMap.get(targetId) || null;
  return null; // 'custom' items never have a target_id
}

// Additive: a category already present in the target store (matched by
// name, which is what's actually unique per store) is reused rather than
// duplicated.
async function cloneCategories(conn, fromStoreId, toStoreId) {
  const [rows] = await conn.query(`SELECT id, name FROM ${TABLES.categories} WHERE store_id = ?`, [fromStoreId]);
  const idMap = new Map();
  let addedCount = 0;
  for (const cat of rows) {
    const [[existing]] = await conn.query(
      `SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND name = ?`,
      [toStoreId, cat.name]
    );
    if (existing) {
      idMap.set(cat.id, existing.id);
    } else {
      const [result] = await conn.query(`INSERT INTO ${TABLES.categories} (store_id, name) VALUES (?, ?)`, [toStoreId, cat.name]);
      idMap.set(cat.id, result.insertId);
      addedCount++;
    }
  }
  return { idMap, addedCount };
}

// Additive: a product already present in the target store (matched by slug,
// the store-scoped unique key) is reused rather than duplicated, so
// clicking "Import demo content" twice doesn't pile up copies.
async function cloneProducts(conn, fromStoreId, toStoreId, categoryIdMap) {
  const [rows] = await conn.query(
    `SELECT id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status
     FROM ${TABLES.products} WHERE store_id = ?`,
    [fromStoreId]
  );
  const idMap = new Map();
  let addedCount = 0;
  for (const p of rows) {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [toStoreId, p.slug]);
    if (existing) {
      idMap.set(p.id, existing.id);
      continue;
    }
    const mappedCategoryId = p.category_id ? categoryIdMap.get(p.category_id) || null : null;
    const [result] = await conn.query(
      `INSERT INTO ${TABLES.products} (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [toStoreId, p.title, p.slug, p.description, p.price, p.compare_at_price, p.image_url, mappedCategoryId, p.stock, p.status]
    );
    idMap.set(p.id, result.insertId);
    addedCount++;
  }
  return { idMap, addedCount };
}

// Not additive in the same sense — every store already has exactly one Home
// page (is_home=1), so the demo's Home just maps onto it. A non-home demo
// page (e.g. About) is matched onto an existing page with the same path, or
// created if the store doesn't have one yet. Either way this only creates
// the page ROW; cloneBodySections (below) is what replaces its content.
async function clonePageShells(conn, fromStoreId, toStoreId) {
  const [rows] = await conn.query(`SELECT id, name, path, is_home, status FROM ${TABLES.pages} WHERE store_id = ?`, [fromStoreId]);
  const idMap = new Map();
  for (const pg of rows) {
    if (pg.is_home) {
      const [[home]] = await conn.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 1 LIMIT 1`, [toStoreId]);
      if (home) idMap.set(pg.id, home.id);
      continue;
    }
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND path = ?`, [toStoreId, pg.path]);
    if (existing) {
      idMap.set(pg.id, existing.id);
    } else {
      const [result] = await conn.query(
        `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, ?, ?, 0, ?)`,
        [toStoreId, pg.name, pg.path, pg.status]
      );
      idMap.set(pg.id, result.insertId);
    }
  }
  return idMap;
}

// Clones every saved menu the demo store has (a store like this has few, and
// a nav_menu section can only point at one of its own store's menus, so
// there's no meaningful subset to prune to). Matched onto an existing menu
// of the same name so re-running this replaces that menu's items in place
// rather than creating a second copy.
async function cloneMenus(conn, fromStoreId, toStoreId, maps) {
  const [menus] = await conn.query(`SELECT id, name FROM ${TABLES.menus} WHERE store_id = ?`, [fromStoreId]);
  const idMap = new Map();
  for (const menu of menus) {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.menus} WHERE store_id = ? AND name = ?`, [toStoreId, menu.name]);
    let newMenuId;
    if (existing) {
      newMenuId = existing.id;
      await conn.query(`DELETE FROM ${TABLES.menuItems} WHERE menu_id = ?`, [newMenuId]);
    } else {
      const [result] = await conn.query(`INSERT INTO ${TABLES.menus} (store_id, name) VALUES (?, ?)`, [toStoreId, menu.name]);
      newMenuId = result.insertId;
    }
    idMap.set(menu.id, newMenuId);

    const [items] = await conn.query(
      `SELECT id, parent_id, position, type, target_id, label, url FROM ${TABLES.menuItems} WHERE menu_id = ? ORDER BY position, id`,
      [menu.id]
    );
    // Two passes so insertion order never has to match parent-before-child:
    // pass 1 inserts every item (parent_id NULL for now) and records old id
    // -> new id; pass 2, once that map is complete, patches parent_id in.
    const itemIdMap = new Map();
    for (const item of items) {
      const newTargetId = remapMenuItemTarget(item.type, item.target_id, maps);
      const [result] = await conn.query(
        `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label, url) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
        [newMenuId, item.position, item.type, newTargetId, item.label, str(item.url)]
      );
      itemIdMap.set(item.id, result.insertId);
    }
    for (const item of items) {
      if (item.parent_id) {
        await conn.query(`UPDATE ${TABLES.menuItems} SET parent_id = ? WHERE id = ?`, [itemIdMap.get(item.parent_id), itemIdMap.get(item.id)]);
      }
    }
  }
  return idMap;
}

const SECTION_COLUMNS = `type, position, fields, hidden, custom_class, custom_css, min_height,
   hide_desktop, hide_tablet, hide_mobile,
   margin_top, margin_bottom, margin_left, margin_right,
   padding_top, padding_bottom, padding_left, padding_right, element_styles`;
// Generated from SECTION_COLUMNS itself, so the placeholder count can never
// drift out of sync with the column list (a hand-typed "?, ?, ?, ..." list
// is exactly the kind of thing that silently goes stale after an edit).
const SECTION_PLACEHOLDERS = SECTION_COLUMNS.split(',').map(() => '?').join(', ');

function sectionValues(s, fields) {
  return [
    s.type, s.position, JSON.stringify(fields), s.hidden, s.custom_class, s.custom_css, s.min_height,
    s.hide_desktop, s.hide_tablet, s.hide_mobile,
    s.margin_top, s.margin_bottom, s.margin_left, s.margin_right,
    s.padding_top, s.padding_bottom, s.padding_left, s.padding_right,
    s.element_styles ? JSON.stringify(s.element_styles) : null,
  ];
}

// Replaces each cloned page's body sections wholesale — this is the
// "overwrite, with confirmation" the merchant agreed to; the caller is
// responsible for having actually confirmed with them first.
async function cloneBodySections(conn, fromStoreId, toStoreId, pageIdMap, maps) {
  const [pages] = await conn.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ?`, [fromStoreId]);
  let pagesTouched = 0;
  for (const pg of pages) {
    const targetPageId = pageIdMap.get(pg.id);
    if (!targetPageId) continue;
    const [sections] = await conn.query(
      `SELECT ${SECTION_COLUMNS} FROM ${TABLES.pageSections} WHERE page_id = ? AND region = 'body' ORDER BY position`,
      [pg.id]
    );
    if (!sections.length) continue;
    await conn.query(`DELETE FROM ${TABLES.pageSections} WHERE page_id = ? AND region = 'body'`, [targetPageId]);
    for (const s of sections) {
      const fields = remapSectionFields(s.type, s.fields, maps);
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (page_id, region, ${SECTION_COLUMNS}) VALUES (?, 'body', ${SECTION_PLACEHOLDERS})`,
        [targetPageId, ...sectionValues(s, fields)]
      );
    }
    pagesTouched++;
  }
  return pagesTouched;
}

// Replaces the store-wide header/footer sections wholesale, same overwrite
// rule as cloneBodySections above.
async function cloneHeaderFooterSections(conn, fromStoreId, toStoreId, maps) {
  const [sections] = await conn.query(
    `SELECT region, ${SECTION_COLUMNS} FROM ${TABLES.pageSections}
     WHERE store_id = ? AND page_id IS NULL AND region IN ('header','footer') ORDER BY region, position`,
    [fromStoreId]
  );
  if (!sections.length) return;
  await conn.query(
    `DELETE FROM ${TABLES.pageSections} WHERE store_id = ? AND page_id IS NULL AND region IN ('header','footer')`,
    [toStoreId]
  );
  for (const s of sections) {
    const fields = remapSectionFields(s.type, s.fields, maps);
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, ${SECTION_COLUMNS}) VALUES (?, NULL, ?, ${SECTION_PLACEHOLDERS})`,
      [toStoreId, s.region, ...sectionValues(s, fields)]
    );
  }
}

// The one exported entry point. Wraps everything in a transaction — the
// pieces above run in this exact order because each later step's remapping
// depends on an id map an earlier step built (products need categoryIdMap,
// menus need category/product/pageIdMap, sections need all of them).
async function importDemoContent(pool, { demoStoreId, targetStoreId }) {
  if (!demoStoreId || !targetStoreId) throw new Error('importDemoContent requires demoStoreId and targetStoreId.');
  if (demoStoreId === targetStoreId) throw new Error("Can't import a demo store's content into itself.");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { idMap: categoryIdMap, addedCount: categoriesAdded } = await cloneCategories(conn, demoStoreId, targetStoreId);
    const { idMap: productIdMap, addedCount: productsAdded } = await cloneProducts(conn, demoStoreId, targetStoreId, categoryIdMap);
    const pageIdMap = await clonePageShells(conn, demoStoreId, targetStoreId);
    const maps = { categoryIdMap, productIdMap, pageIdMap, menuIdMap: new Map() };
    maps.menuIdMap = await cloneMenus(conn, demoStoreId, targetStoreId, maps);

    const pagesTouched = await cloneBodySections(conn, demoStoreId, targetStoreId, pageIdMap, maps);
    await cloneHeaderFooterSections(conn, demoStoreId, targetStoreId, maps);

    await conn.commit();
    return { categoriesAdded, productsAdded, pagesTouched };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { importDemoContent };
