const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES, THEMES } = require('../db/database');
const { requireAdmin, requireAdminRole } = require('../middleware/auth');
const { rootUrl, adminPortalUrl } = require('../middleware/tenant');
const {
  SECTION_TYPES,
  SECTION_TYPE_KEYS,
  NESTABLE_SECTION_TYPES,
  TEXT_ELEMENT_FIELDS,
  defaultFields,
  sanitizeFields,
  sanitizeSectionSettings,
  sanitizeElementStyle,
  sanitizeAllElementStyles,
  sanitizeRowBlock,
  sectionTypesForContext,
  sectionAllowedInContext,
} = require('../lib/sections');
const { resolveTokens, sanitizeTokenPatch, themeDefaultTokens, RADIUS_PX } = require('../lib/themeTokens');

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function toNumber(product) {
  return {
    ...product,
    price: Number(product.price),
    compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null,
  };
}

function orderToNumber(order) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    discount_amount: Number(order.discount_amount || 0),
    total: Number(order.total != null ? order.total : order.subtotal),
  };
}

// Every route below belongs to a specific store, resolved from the
// subdomain. Without a store (e.g. someone hits pagezaper.com/admin
// directly) there's nothing to log in to.
router.use((req, res, next) => {
  if (!req.store) {
    req.flash('error', "Please log in first.");
    return res.redirect(adminPortalUrl(req, '/login'));
  }
  next();
});

// ---------- Auth ----------
// There is exactly one login FORM in the whole app, served from
// admin.pagezaper.com (see routes/platform.js) — a store's own subdomain no
// longer renders its own login page, it just bounces there. The actual
// credential check (pz_users JOIN pz_user_roles, scoped by store) also lives
// in that one route now.
router.get('/login', (req, res) => {
  if (req.session.admin && req.session.admin.store_id === req.store.id) return res.redirect('/admin');
  res.redirect(adminPortalUrl(req, '/login'));
});

router.post('/login', (req, res) => {
  res.redirect(adminPortalUrl(req, '/login'));
});

router.post('/logout', (req, res) => {
  req.session.admin = null;
  req.session.account = null;
  res.redirect(adminPortalUrl(req, '/login'));
});

// Ends a platform-admin "log in as" session (see routes/platformAdmin.js)
// and sends them back to the platform admin dashboard on the root domain.
router.post('/exit-impersonation', (req, res) => {
  if (!req.session.impersonation) return res.redirect('/admin');
  req.session.admin = null;
  req.session.impersonation = null;
  res.redirect(rootUrl(req, '/platform-admin'));
});

// Everything below requires admin auth for this store
router.use(requireAdmin);

// ---------- Dashboard ----------
// Everything on this page is a real number from real data — no fabricated
// "sessions" or "live visitors" counts, since PageZaper doesn't track
// storefront traffic (yet).
router.get('/', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[{ c: productCount }]] = await pool.query(`SELECT COUNT(*) AS c FROM ${TABLES.products} WHERE store_id = ?`, [storeId]);

    const [[{ c: orders30, total: revenue30 }]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders}
       WHERE store_id = ? AND status != 'cancelled' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [storeId]
    );

    // "Fulfill orders": placed but not yet shipped. "Capture payments" has no
    // real equivalent yet (checkout is Cash on Delivery only) — the closest
    // honest analogue is COD orders still marked pending, i.e. not yet
    // confirmed/collected.
    const [[{ c: toFulfill }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ? AND status IN ('pending', 'paid')`,
      [storeId]
    );
    const [[{ c: toCollect }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.orders} WHERE store_id = ? AND status = 'pending'`,
      [storeId]
    );

    const [lowStock] = await pool.query(
      `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND stock <= 5 AND status = 'active' ORDER BY stock ASC LIMIT 5`,
      [storeId]
    );
    const [recentOrders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC LIMIT 5`,
      [storeId]
    );

    res.render('admin/dashboard', {
      title: 'Dashboard',
      productCount,
      orders30,
      revenue30: Number(revenue30),
      toFulfill,
      toCollect,
      lowStock: lowStock.map(toNumber),
      recentOrders: recentOrders.map(orderToNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Products ----------
router.get('/products', async (req, res, next) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name AS category_name FROM ${TABLES.products} p
       LEFT JOIN ${TABLES.categories} c ON p.category_id = c.id
       WHERE p.store_id = ?
       ORDER BY p.created_at DESC`,
      [req.store.id]
    );
    res.render('admin/products', { title: 'Products', products: products.map(toNumber) });
  } catch (err) {
    next(err);
  }
});

router.get('/products/new', async (req, res, next) => {
  try {
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [req.store.id]);
    res.render('admin/product-form', { title: 'New Product', product: null, categories });
  } catch (err) {
    next(err);
  }
});

router.post('/products/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { title, description, price, compare_at_price, image_url, category_id, stock, status } = req.body;

    if (!title || !price) {
      req.flash('error', 'Title and price are required.');
      return res.redirect('/admin/products/new');
    }

    let slug = slugify(title);
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [storeId, slug]);
    if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    await pool.query(
      `INSERT INTO ${TABLES.products} (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
        title,
        slug,
        description || '',
        parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        image_url || '',
        category_id || null,
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
      ]
    );

    req.flash('success', 'Product created.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

router.get('/products/:id/edit', async (req, res, next) => {
  try {
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/admin/products');
    }
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [req.store.id]);
    res.render('admin/product-form', { title: 'Edit Product', product: toNumber(product), categories });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/edit', async (req, res, next) => {
  try {
    const { title, description, price, compare_at_price, image_url, category_id, stock, status } = req.body;

    await pool.query(
      `UPDATE ${TABLES.products} SET title = ?, description = ?, price = ?, compare_at_price = ?, image_url = ?, category_id = ?, stock = ?, status = ?
       WHERE store_id = ? AND id = ?`,
      [
        title,
        description || '',
        parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        image_url || '',
        category_id || null,
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
        req.store.id,
        req.params.id,
      ]
    );

    req.flash('success', 'Product updated.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Product deleted.');
    res.redirect('/admin/products');
  } catch (err) {
    next(err);
  }
});

// ---------- Pages (builder) ----------
// Loads a page and confirms it belongs to the logged-in store — every
// section route below goes through this so a page/section id can never be
// used to read or edit another merchant's page.
async function loadOwnedPage(storeId, pageId) {
  const [[page]] = await pool.query(`SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND id = ?`, [storeId, pageId]);
  return page;
}

// ---- Shared section-canvas engine ----
// pz_page_sections now backs THREE kinds of canvas, distinguished by a
// `scope`: { storeId, pageId, region }.
//   - A page's own content:      { pageId: <page>, region: 'body' }
//   - A store's global header/footer (page_id NULL): { pageId: null, region: 'header'|'footer' }
//   - One page's header/footer OVERRIDE (falls back to global when absent
//     — see routes/storefront.js's resolveLayoutSections): { pageId: <page>, region: 'header'|'footer' }
// Every CRUD operation the builder needs (create/reorder/restore/update/
// settings/element-style/toggle/delete) is implemented once here, against a
// scope, and reused by all three sets of routes below — so the three
// canvases can never quietly drift apart in behavior.
function scopeWhere(scope) {
  return scope.pageId != null
    ? { sql: 'page_id = ? AND region = ?', params: [scope.pageId, scope.region] }
    : { sql: 'store_id = ? AND page_id IS NULL AND region = ?', params: [scope.storeId, scope.region] };
}

// The type-library a scope's TOP-LEVEL sections are validated/offered
// against — see lib/sections.js's `contexts`. A page's 'body' region uses
// the 'page' canvas; header/footer scopes (global or per-page override) use
// their own region name directly.
function scopeContext(scope) {
  return scope.region === 'body' ? 'page' : scope.region;
}

function parseSectionRow(s) {
  return {
    ...s,
    fields: typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields,
    element_styles: s.element_styles ? (typeof s.element_styles === 'string' ? JSON.parse(s.element_styles) : s.element_styles) : {},
  };
}

async function scopeListSections(scope) {
  const { sql, params } = scopeWhere(scope);
  const [rows] = await pool.query(`SELECT * FROM ${TABLES.pageSections} WHERE ${sql} ORDER BY position ASC`, params);
  return rows.map(parseSectionRow);
}

async function scopeLoadSection(scope, sectionId) {
  const { sql, params } = scopeWhere(scope);
  const [[row]] = await pool.query(`SELECT * FROM ${TABLES.pageSections} WHERE id = ? AND ${sql}`, [sectionId, ...params]);
  return row ? parseSectionRow(row) : null;
}

async function scopeCreateSection(scope, req, res, next) {
  try {
    const { type } = req.body;
    if (!sectionAllowedInContext(type, scopeContext(scope))) return res.status(400).json({ error: 'Unknown section type' });
    const { sql, params } = scopeWhere(scope);
    const [[{ maxPos }]] = await pool.query(`SELECT COALESCE(MAX(position), -1) AS maxPos FROM ${TABLES.pageSections} WHERE ${sql}`, params);
    const fields = defaultFields(type);
    const [result] = await pool.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, ?, ?, ?, ?, ?)`,
      [scope.storeId, scope.pageId, scope.region, type, maxPos + 1, JSON.stringify(fields)]
    );
    res.json({ ok: true, section: { id: result.insertId, type, position: maxPos + 1, fields, hidden: 0 } });
  } catch (err) {
    next(err);
  }
}

async function scopeReorderSections(scope, req, res, next) {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    const { sql, params } = scopeWhere(scope);
    for (let i = 0; i < order.length; i++) {
      await pool.query(`UPDATE ${TABLES.pageSections} SET position = ? WHERE id = ? AND ${sql}`, [i, order[i], ...params]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function scopeRestoreSections(scope, req, res, next) {
  try {
    const incoming = Array.isArray(req.body.sections) ? req.body.sections.slice(0, 200) : [];
    const context = scopeContext(scope);
    const { sql, params } = scopeWhere(scope);

    const [existingRows] = await pool.query(`SELECT id FROM ${TABLES.pageSections} WHERE ${sql}`, params);
    const existingIds = new Set(existingRows.map((r) => r.id));
    const keepIds = new Set();

    for (let i = 0; i < incoming.length; i++) {
      const item = incoming[i] || {};
      if (!sectionAllowedInContext(item.type, context)) continue;

      const fields = sanitizeFields(item.type, {}, item.fields);
      const settings = sanitizeSectionSettings(item);
      const hidden = item.hidden ? 1 : 0;
      const customClass = settings.custom_class || null;
      const customCss = settings.custom_css || null;
      const minHeight = settings.min_height || 0;
      const hideDesktop = settings.hide_desktop || 0;
      const hideTablet = settings.hide_tablet || 0;
      const hideMobile = settings.hide_mobile || 0;
      const marginTop = settings.margin_top || 0;
      const marginBottom = settings.margin_bottom || 0;
      const marginLeft = settings.margin_left || 0;
      const marginRight = settings.margin_right || 0;
      const paddingTop = settings.padding_top || 0;
      const paddingBottom = settings.padding_bottom || 0;
      const paddingLeft = settings.padding_left || 0;
      const paddingRight = settings.padding_right || 0;
      const elementStyles = sanitizeAllElementStyles(item.type, item.element_styles);
      const elementStylesJson = Object.keys(elementStyles).length ? JSON.stringify(elementStyles) : null;

      const incomingId = Number.isInteger(item.id) ? item.id : parseInt(item.id, 10);
      if (incomingId && existingIds.has(incomingId)) {
        keepIds.add(incomingId);
        await pool.query(
          `UPDATE ${TABLES.pageSections}
             SET position = ?, fields = ?, hidden = ?, custom_class = ?, custom_css = ?, min_height = ?,
                 hide_desktop = ?, hide_tablet = ?, hide_mobile = ?,
                 margin_top = ?, margin_bottom = ?, margin_left = ?, margin_right = ?,
                 padding_top = ?, padding_bottom = ?, padding_left = ?, padding_right = ?, element_styles = ?
           WHERE id = ?`,
          [i, JSON.stringify(fields), hidden, customClass, customCss, minHeight, hideDesktop, hideTablet, hideMobile,
            marginTop, marginBottom, marginLeft, marginRight,
            paddingTop, paddingBottom, paddingLeft, paddingRight, elementStylesJson, incomingId]
        );
      } else {
        const [result] = await pool.query(
          `INSERT INTO ${TABLES.pageSections}
             (store_id, page_id, region, type, position, fields, hidden, custom_class, custom_css, min_height, hide_desktop, hide_tablet, hide_mobile,
              margin_top, margin_bottom, margin_left, margin_right,
              padding_top, padding_bottom, padding_left, padding_right, element_styles)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [scope.storeId, scope.pageId, scope.region, item.type, i, JSON.stringify(fields), hidden, customClass, customCss, minHeight, hideDesktop, hideTablet, hideMobile,
            marginTop, marginBottom, marginLeft, marginRight,
            paddingTop, paddingBottom, paddingLeft, paddingRight, elementStylesJson]
        );
        keepIds.add(result.insertId);
      }
    }

    const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
    if (toDelete.length) {
      await pool.query(
        `DELETE FROM ${TABLES.pageSections} WHERE id IN (${toDelete.map(() => '?').join(',')})`,
        toDelete
      );
    }

    res.json({ ok: true, sections: await scopeListSections(scope) });
  } catch (err) {
    next(err);
  }
}

async function scopeUpdateSectionFields(scope, sectionId, req, res, next) {
  try {
    const section = await scopeLoadSection(scope, sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    const nextFields = sanitizeFields(section.type, section.fields, req.body.fields);
    await pool.query(`UPDATE ${TABLES.pageSections} SET fields = ? WHERE id = ?`, [JSON.stringify(nextFields), section.id]);
    res.json({ ok: true, fields: nextFields });
  } catch (err) {
    next(err);
  }
}

async function scopeUpdateSectionSettings(scope, sectionId, req, res, next) {
  try {
    const section = await scopeLoadSection(scope, sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });

    const patch = sanitizeSectionSettings(req.body);
    const sets = [];
    const values = [];
    if (patch.custom_class !== undefined) { sets.push('custom_class = ?'); values.push(patch.custom_class || null); }
    if (patch.custom_css !== undefined) { sets.push('custom_css = ?'); values.push(patch.custom_css || null); }
    if (patch.min_height !== undefined) { sets.push('min_height = ?'); values.push(patch.min_height); }
    if (patch.hide_desktop !== undefined) { sets.push('hide_desktop = ?'); values.push(patch.hide_desktop); }
    if (patch.hide_tablet !== undefined) { sets.push('hide_tablet = ?'); values.push(patch.hide_tablet); }
    if (patch.hide_mobile !== undefined) { sets.push('hide_mobile = ?'); values.push(patch.hide_mobile); }
    if (patch.margin_top !== undefined) { sets.push('margin_top = ?'); values.push(patch.margin_top); }
    if (patch.margin_bottom !== undefined) { sets.push('margin_bottom = ?'); values.push(patch.margin_bottom); }
    if (patch.margin_left !== undefined) { sets.push('margin_left = ?'); values.push(patch.margin_left); }
    if (patch.margin_right !== undefined) { sets.push('margin_right = ?'); values.push(patch.margin_right); }
    if (patch.padding_top !== undefined) { sets.push('padding_top = ?'); values.push(patch.padding_top); }
    if (patch.padding_bottom !== undefined) { sets.push('padding_bottom = ?'); values.push(patch.padding_bottom); }
    if (patch.padding_left !== undefined) { sets.push('padding_left = ?'); values.push(patch.padding_left); }
    if (patch.padding_right !== undefined) { sets.push('padding_right = ?'); values.push(patch.padding_right); }
    if (sets.length) {
      values.push(section.id);
      await pool.query(`UPDATE ${TABLES.pageSections} SET ${sets.join(', ')} WHERE id = ?`, values);
    }

    const [[updated]] = await pool.query(
      `SELECT custom_class, custom_css, min_height, hide_desktop, hide_tablet, hide_mobile,
              margin_top, margin_bottom, margin_left, margin_right,
              padding_top, padding_bottom, padding_left, padding_right
       FROM ${TABLES.pageSections} WHERE id = ?`,
      [section.id]
    );
    res.json({
      ok: true,
      custom_class: updated.custom_class || '',
      custom_css: updated.custom_css || '',
      min_height: updated.min_height || 0,
      hide_desktop: !!updated.hide_desktop,
      hide_tablet: !!updated.hide_tablet,
      hide_mobile: !!updated.hide_mobile,
      margin_top: updated.margin_top || 0,
      margin_bottom: updated.margin_bottom || 0,
      margin_left: updated.margin_left || 0,
      margin_right: updated.margin_right || 0,
      padding_top: updated.padding_top || 0,
      padding_bottom: updated.padding_bottom || 0,
      padding_left: updated.padding_left || 0,
      padding_right: updated.padding_right || 0,
    });
  } catch (err) {
    next(err);
  }
}

async function scopeUpdateElementStyle(scope, sectionId, req, res, next) {
  try {
    const section = await scopeLoadSection(scope, sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });

    const field = typeof req.body.field === 'string' ? req.body.field : '';
    if (!field || !(TEXT_ELEMENT_FIELDS[section.type] || []).includes(field)) {
      return res.status(400).json({ error: 'Unknown text element for this section' });
    }

    const updated = sanitizeElementStyle(section.type, section.element_styles, field, req.body);
    await pool.query(
      `UPDATE ${TABLES.pageSections} SET element_styles = ? WHERE id = ?`,
      [Object.keys(updated).length ? JSON.stringify(updated) : null, section.id]
    );
    res.json({ ok: true, element_styles: updated });
  } catch (err) {
    next(err);
  }
}

async function scopeToggleSection(scope, sectionId, req, res, next) {
  try {
    const section = await scopeLoadSection(scope, sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    await pool.query(`UPDATE ${TABLES.pageSections} SET hidden = NOT hidden WHERE id = ?`, [section.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function scopeDeleteSection(scope, sectionId, req, res, next) {
  try {
    const section = await scopeLoadSection(scope, sectionId);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    await pool.query(`DELETE FROM ${TABLES.pageSections} WHERE id = ?`, [section.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// Registers the same 8-route CRUD surface (create/reorder/restore/update-
// fields/settings/element-style/toggle/delete) under `routePrefix`, backed
// by whatever scope `resolveScope(req, res)` resolves to. `resolveScope`
// sends its own 404 and returns null when the scope can't be resolved (bad
// region, page not found, etc) — routes below treat a null return as
// "response already sent, do nothing further". Mirrors the literal-paths-
// before-:sectionId ordering the /pages/:id/sections routes need (see the
// NOTE above scopeRestoreSections's original, non-shared version).
function mountSectionRoutes(routePrefix, resolveScope) {
  router.post(`${routePrefix}/sections`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeCreateSection(scope, req, res, next);
  });
  router.post(`${routePrefix}/sections/reorder`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeReorderSections(scope, req, res, next);
  });
  router.post(`${routePrefix}/sections/restore`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeRestoreSections(scope, req, res, next);
  });
  router.post(`${routePrefix}/sections/:sectionId`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeUpdateSectionFields(scope, req.params.sectionId, req, res, next);
  });
  router.post(`${routePrefix}/sections/:sectionId/settings`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeUpdateSectionSettings(scope, req.params.sectionId, req, res, next);
  });
  router.post(`${routePrefix}/sections/:sectionId/element-style`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeUpdateElementStyle(scope, req.params.sectionId, req, res, next);
  });
  router.post(`${routePrefix}/sections/:sectionId/toggle`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeToggleSection(scope, req.params.sectionId, req, res, next);
  });
  router.post(`${routePrefix}/sections/:sectionId/delete`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeDeleteSection(scope, req.params.sectionId, req, res, next);
  });
}

router.get('/pages', async (req, res, next) => {
  try {
    const [pages] = await pool.query(
      `SELECT * FROM ${TABLES.pages} WHERE store_id = ? ORDER BY is_home DESC, name ASC`,
      [req.store.id]
    );
    res.render('admin/pages', { title: 'Pages', pages });
  } catch (err) {
    next(err);
  }
});

router.get('/pages/new', (req, res) => {
  res.render('admin/page-form', { title: 'New Page' });
});

router.post('/pages/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Page name is required.');
      return res.redirect('/admin/pages/new');
    }

    let slug = slugify(name) || 'page';
    let path = `/${slug}`;
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND path = ?`, [storeId, path]);
    if (existing) path = `/${slug}-${Date.now().toString().slice(-4)}`;

    const [result] = await pool.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, ?, ?, 0, 'published')`,
      [storeId, name, path]
    );
    const pageId = result.insertId;

    // Seed a starter hero so the page isn't blank the first time it's opened.
    await pool.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'hero', 0, ?)`,
      [pageId, JSON.stringify(Object.assign(defaultFields('hero'), { heading: name }))]
    );

    req.flash('success', 'Page created.');
    res.redirect(`/admin/pages/${pageId}/edit`);
  } catch (err) {
    next(err);
  }
});

router.get('/pages/:id/edit', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) {
      req.flash('error', 'Page not found.');
      return res.redirect('/admin/pages');
    }
    const sections = await scopeListSections({ storeId: req.store.id, pageId: page.id, region: 'body' });
    // A handful of the store's real products, so the "Product grid" section
    // previews actual catalog items on the canvas instead of placeholders —
    // the live storefront always renders the true current catalog regardless
    // of what's fetched here.
    const [rawProducts] = await pool.query(
      `SELECT id, title, price, image_url, stock FROM ${TABLES.products} WHERE store_id = ? ORDER BY created_at DESC LIMIT 24`,
      [req.store.id]
    );
    const products = rawProducts.map((p) => ({ ...p, price: Number(p.price) }));
    // Real store categories, so the "Collection list" module previews the
    // merchant's actual categories on the canvas (and, on the live
    // storefront, is never anything but a live reflection of them).
    const [categories] = await pool.query(
      `SELECT id, name FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`,
      [req.store.id]
    );
    // Saved components (see the /components routes below) — loaded here so
    // the builder's Components panel has them from the start rather than a
    // separate fetch on every page load.
    const [rawComponents] = await pool.query(
      `SELECT id, name, block FROM ${TABLES.pageComponents} WHERE store_id = ? ORDER BY created_at DESC`,
      [req.store.id]
    );
    const components = rawComponents.map((c) => ({ id: c.id, name: c.name, block: typeof c.block === 'string' ? JSON.parse(c.block) : c.block }));
    // Which of header/footer this page has its OWN override for (as opposed
    // to inheriting the store's global one) — drives the small "Customize
    // for this page" toggle in the builder sidebar. See the
    // /pages/:id/layout/:region/enable|disable routes below.
    const [overrideRows] = await pool.query(
      `SELECT DISTINCT region FROM ${TABLES.pageSections} WHERE page_id = ? AND region IN ('header','footer')`,
      [page.id]
    );
    const overrideRegions = overrideRows.map((r) => r.region);
    res.render('admin/builder', {
      title: `Edit ${page.name}`,
      page,
      context: 'page',
      sectionsBase: `/admin/pages/${page.id}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products,
      categories,
      components,
      layoutOverrides: { header: overrideRegions.includes('header'), footer: overrideRegions.includes('footer') },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/publish', async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    const status = req.body.status === 'draft' ? 'draft' : 'published';
    await pool.query(`UPDATE ${TABLES.pages} SET status = ? WHERE id = ?`, [status, page.id]);
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

// Admin only — a Manager can create/edit pages but not delete them.
router.post('/pages/:id/delete', requireAdminRole, async (req, res, next) => {
  try {
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) {
      req.flash('error', 'Page not found.');
      return res.redirect('/admin/pages');
    }
    if (page.is_home) {
      req.flash('error', "You can't delete the Home page.");
      return res.redirect('/admin/pages');
    }
    await pool.query(`DELETE FROM ${TABLES.pages} WHERE id = ?`, [page.id]);
    req.flash('success', 'Page deleted.');
    res.redirect('/admin/pages');
  } catch (err) {
    next(err);
  }
});

// ---- Section JSON API, used by public/js/admin-builder.js ----
// A page's own content lives at scope { pageId: page.id, region: 'body' }.
// NOTE: /restore must stay ABOVE /:sectionId (mountSectionRoutes already
// registers them in that order) — otherwise "restore" gets swallowed as a
// :sectionId value instead, since Express matches routes in registration
// order.
mountSectionRoutes('/pages/:id', async (req, res) => {
  const page = await loadOwnedPage(req.store.id, req.params.id);
  if (!page) { res.status(404).json({ error: 'Page not found' }); return null; }
  return { storeId: req.store.id, pageId: page.id, region: 'body' };
});

// ---- Header/footer builder ----
// A store's global header/footer (page_id NULL) — the "Header & Footer"
// admin area, reachable from anywhere, not tied to one page.
router.get('/layout/:region', async (req, res, next) => {
  try {
    const region = req.params.region;
    if (region !== 'header' && region !== 'footer') return res.status(404).send('Not found');
    const sections = await scopeListSections({ storeId: req.store.id, pageId: null, region });
    const [rawComponents] = await pool.query(
      `SELECT id, name, block FROM ${TABLES.pageComponents} WHERE store_id = ? ORDER BY created_at DESC`,
      [req.store.id]
    );
    const components = rawComponents.map((c) => ({ id: c.id, name: c.name, block: typeof c.block === 'string' ? JSON.parse(c.block) : c.block }));
    res.render('admin/builder', {
      title: region === 'header' ? 'Header' : 'Footer',
      page: null,
      context: region,
      sectionsBase: `/admin/layout/${region}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products: [],
      categories: [],
      components,
      layoutOverrides: null,
    });
  } catch (err) {
    next(err);
  }
});

mountSectionRoutes('/layout/:region', async (req, res) => {
  const region = req.params.region;
  if (region !== 'header' && region !== 'footer') { res.status(404).json({ error: 'Not found' }); return null; }
  return { storeId: req.store.id, pageId: null, region };
});

// One page's own header/footer OVERRIDE — falls back to the store's global
// header/footer (above) whenever it doesn't exist; see routes/storefront.js's
// resolveLayoutSections. /enable clones the current global sections as this
// page's starting point (so a merchant edits from something, not a blank
// canvas); /disable removes the page-scoped rows entirely, which reverts
// the page to inheriting the global one again — nothing about the global
// header/footer itself is touched by either.
router.get('/pages/:id/layout/:region/edit', async (req, res, next) => {
  try {
    const region = req.params.region;
    if (region !== 'header' && region !== 'footer') return res.status(404).send('Not found');
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) {
      req.flash('error', 'Page not found.');
      return res.redirect('/admin/pages');
    }
    const sections = await scopeListSections({ storeId: req.store.id, pageId: page.id, region });
    if (!sections.length) {
      req.flash('error', `Turn on "Customize ${region} for this page" first.`);
      return res.redirect(`/admin/pages/${page.id}/edit`);
    }
    const [rawComponents] = await pool.query(
      `SELECT id, name, block FROM ${TABLES.pageComponents} WHERE store_id = ? ORDER BY created_at DESC`,
      [req.store.id]
    );
    const components = rawComponents.map((c) => ({ id: c.id, name: c.name, block: typeof c.block === 'string' ? JSON.parse(c.block) : c.block }));
    res.render('admin/builder', {
      title: `${region === 'header' ? 'Header' : 'Footer'} override — ${page.name}`,
      page,
      context: region,
      sectionsBase: `/admin/pages/${page.id}/layout/${region}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products: [],
      categories: [],
      components,
      layoutOverrides: null,
    });
  } catch (err) {
    next(err);
  }
});

mountSectionRoutes('/pages/:id/layout/:region', async (req, res) => {
  const region = req.params.region;
  if (region !== 'header' && region !== 'footer') { res.status(404).json({ error: 'Not found' }); return null; }
  const page = await loadOwnedPage(req.store.id, req.params.id);
  if (!page) { res.status(404).json({ error: 'Page not found' }); return null; }
  return { storeId: req.store.id, pageId: page.id, region };
});

router.post('/pages/:id/layout/:region/enable', async (req, res, next) => {
  try {
    const region = req.params.region;
    if (region !== 'header' && region !== 'footer') return res.status(404).json({ error: 'Not found' });
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const existing = await scopeListSections({ storeId: req.store.id, pageId: page.id, region });
    if (!existing.length) {
      const globalSections = await scopeListSections({ storeId: req.store.id, pageId: null, region });
      for (const s of globalSections) {
        await pool.query(
          `INSERT INTO ${TABLES.pageSections}
             (store_id, page_id, region, type, position, fields, hidden, custom_class, custom_css, min_height, hide_desktop, hide_tablet, hide_mobile,
              margin_top, margin_bottom, margin_left, margin_right,
              padding_top, padding_bottom, padding_left, padding_right, element_styles)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.store.id, page.id, region, s.type, s.position, JSON.stringify(s.fields), s.hidden, s.custom_class, s.custom_css, s.min_height,
            s.hide_desktop, s.hide_tablet, s.hide_mobile, s.margin_top, s.margin_bottom, s.margin_left, s.margin_right,
            s.padding_top, s.padding_bottom, s.padding_left, s.padding_right,
            Object.keys(s.element_styles || {}).length ? JSON.stringify(s.element_styles) : null]
        );
      }
    }
    res.json({ ok: true, redirect: `/admin/pages/${page.id}/layout/${region}/edit` });
  } catch (err) {
    next(err);
  }
});

router.post('/pages/:id/layout/:region/disable', async (req, res, next) => {
  try {
    const region = req.params.region;
    if (region !== 'header' && region !== 'footer') return res.status(404).json({ error: 'Not found' });
    const page = await loadOwnedPage(req.store.id, req.params.id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    await pool.query(`DELETE FROM ${TABLES.pageSections} WHERE page_id = ? AND region = ?`, [page.id, region]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Component library JSON API, used by public/js/admin-builder.js ----
// A "component" is a saved builder block (almost always a configured row,
// but any nestable block works — see sanitizeRowBlock) a merchant can drop
// into any page on their store without rebuilding it from scratch. Not tied
// to any one page: /pages/:id/edit loads the store's whole library
// alongside that page's own sections (see above), and these two routes are
// store-scoped, not page-scoped.
const MAX_COMPONENTS_PER_STORE = 60;

router.post('/components', async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    if (!name) return res.status(400).json({ error: 'Give this component a name.' });

    // Sanitized the same way a block nested inside a row's column is
    // (parentLevel 1, as if it were about to be dropped straight into a
    // top-level row) — permissive enough to keep whatever nesting the
    // source block already had, up to the normal depth cap. Re-sanitized
    // again, against the ACTUAL insertion point, the moment it's cloned
    // into a page (see /pages/:id/sections/:sectionId), so storing it
    // slightly more permissively than its eventual home is safe.
    const block = sanitizeRowBlock(req.body.block, 1);
    if (!block) return res.status(400).json({ error: 'Could not save that as a component.' });

    const [[{ c: existingCount }]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.pageComponents} WHERE store_id = ?`,
      [req.store.id]
    );
    if (existingCount >= MAX_COMPONENTS_PER_STORE) {
      return res.status(400).json({ error: `You've reached the ${MAX_COMPONENTS_PER_STORE}-component limit — delete one from your library first.` });
    }

    const [result] = await pool.query(
      `INSERT INTO ${TABLES.pageComponents} (store_id, name, block) VALUES (?, ?, ?)`,
      [req.store.id, name, JSON.stringify(block)]
    );
    res.json({ ok: true, component: { id: result.insertId, name, block } });
  } catch (err) {
    next(err);
  }
});

router.post('/components/:componentId/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.pageComponents} WHERE id = ? AND store_id = ?`, [req.params.componentId, req.store.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Edit Store: Themes ----------
// "My themes" — every theme this store has installed (pz_store_themes),
// with the active one marked and a Customize link per theme, plus an
// "Available to install" list of catalog themes (pz_themes) this store
// hasn't added yet. This is a local stand-in for the real marketplace —
// once themes.pagezaper.com exists, that page's "Add to store" button will
// hit the same POST /store/themes/install route this file already has.
router.get('/store/themes', async (req, res, next) => {
  try {
    const [installed] = await pool.query(
      `SELECT st.id AS store_theme_id, st.is_active, t.slug, t.name, t.description, t.price_cents
       FROM ${TABLES.storeThemes} st
       JOIN ${TABLES.themes} t ON t.id = st.theme_id
       WHERE st.store_id = ?
       ORDER BY st.is_active DESC, t.name ASC`,
      [req.store.id]
    );
    const [available] = await pool.query(
      `SELECT t.id AS theme_id, t.slug, t.name, t.description, t.price_cents
       FROM ${TABLES.themes} t
       WHERE t.status = 'published'
         AND t.id NOT IN (
           SELECT theme_id FROM ${TABLES.storeThemes} WHERE store_id = ?
         )
       ORDER BY t.name ASC`,
      [req.store.id]
    );
    // Each card's thumbnail is colored from that theme's OWN manifest tokens
    // (not the store's customized overrides — this is a catalog-level
    // preview, same swatch regardless of what this particular store has
    // saved) so Default and PZ Starter read as visually distinct at a
    // glance without opening either one.
    const withSwatch = (t) => {
      const tokens = themeDefaultTokens(t.slug);
      return { ...t, swatchFrom: tokens.color_primary, swatchTo: tokens.color_primary_dark };
    };
    res.render('admin/store-themes', {
      title: 'Themes',
      themes: installed.map(withSwatch),
      available: available.map(withSwatch),
    });
  } catch (err) {
    next(err);
  }
});

// Installs a catalog theme for this store — adds a pz_store_themes row
// (inactive) so it shows up under "My themes" with Customize/Activate
// available, without touching what's currently live on the storefront.
router.post('/store/themes/install', async (req, res, next) => {
  try {
    const themeId = Number(req.body.themeId);
    const [[theme]] = await pool.query(
      `SELECT id FROM ${TABLES.themes} WHERE id = ? AND status = 'published'`,
      [themeId]
    );
    if (!theme) {
      req.flash('error', 'Theme not found.');
      return res.redirect('/admin/store/themes');
    }
    await pool.query(
      `INSERT INTO ${TABLES.storeThemes} (store_id, theme_id, is_active) VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE store_id = store_id`,
      [req.store.id, theme.id]
    );
    req.flash('success', 'Theme installed — customize it or activate it below.');
    res.redirect('/admin/store/themes');
  } catch (err) {
    next(err);
  }
});

router.post('/store/themes/:storeThemeId/activate', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[target]] = await conn.query(
      `SELECT id FROM ${TABLES.storeThemes} WHERE id = ? AND store_id = ?`,
      [req.params.storeThemeId, req.store.id]
    );
    if (!target) {
      req.flash('error', 'Theme not found.');
      return res.redirect('/admin/store/themes');
    }
    await conn.beginTransaction();
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ?`, [req.store.id]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 1 WHERE id = ?`, [target.id]);
    await conn.commit();
    req.flash('success', 'Theme activated — your storefront is now using it.');
    res.redirect('/admin/store/themes');
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

router.get('/store/themes/:storeThemeId/customize', async (req, res, next) => {
  try {
    const [[storeTheme]] = await pool.query(
      `SELECT st.id AS store_theme_id, st.token_overrides, t.name, t.slug
       FROM ${TABLES.storeThemes} st
       JOIN ${TABLES.themes} t ON t.id = st.theme_id
       WHERE st.id = ? AND st.store_id = ?`,
      [req.params.storeThemeId, req.store.id]
    );
    if (!storeTheme) {
      req.flash('error', 'Theme not found.');
      return res.redirect('/admin/store/themes');
    }
    const overrides = storeTheme.token_overrides
      ? (typeof storeTheme.token_overrides === 'string' ? JSON.parse(storeTheme.token_overrides) : storeTheme.token_overrides)
      : null;
    res.render('admin/store-theme-customize', {
      title: `Customize ${storeTheme.name}`,
      storeTheme,
      tokens: resolveTokens(overrides, storeTheme.slug),
      radiusOptions: RADIUS_PX,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/store/themes/:storeThemeId/customize', async (req, res, next) => {
  try {
    const [[storeTheme]] = await pool.query(
      `SELECT id FROM ${TABLES.storeThemes} WHERE id = ? AND store_id = ?`,
      [req.params.storeThemeId, req.store.id]
    );
    if (!storeTheme) {
      req.flash('error', 'Theme not found.');
      return res.redirect('/admin/store/themes');
    }
    if (req.body.reset === '1') {
      await pool.query(`UPDATE ${TABLES.storeThemes} SET token_overrides = NULL WHERE id = ?`, [storeTheme.id]);
      req.flash('success', "Reset to the theme's defaults.");
      return res.redirect(`/admin/store/themes/${storeTheme.id}/customize`);
    }
    const patch = sanitizeTokenPatch(req.body);
    await pool.query(`UPDATE ${TABLES.storeThemes} SET token_overrides = ? WHERE id = ?`, [JSON.stringify(patch), storeTheme.id]);
    req.flash('success', 'Theme appearance updated.');
    res.redirect(`/admin/store/themes/${storeTheme.id}/customize`);
  } catch (err) {
    next(err);
  }
});

// ---------- Orders ----------
router.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query(`SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC`, [req.store.id]);
    res.render('admin/orders', { title: 'Orders', orders: orders.map(orderToNumber) });
  } catch (err) {
    next(err);
  }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const [[order]] = await pool.query(`SELECT * FROM ${TABLES.orders} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/admin/orders');
    }
    const [items] = await pool.query(`SELECT * FROM ${TABLES.orderItems} WHERE order_id = ?`, [order.id]);
    res.render('admin/order-detail', {
      title: `Order ${order.order_number}`,
      order: orderToNumber(order),
      items: items.map((i) => ({ ...i, price: Number(i.price) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      req.flash('error', 'Invalid status.');
      return res.redirect(`/admin/orders/${req.params.id}`);
    }
    await pool.query(`UPDATE ${TABLES.orders} SET status = ? WHERE store_id = ? AND id = ?`, [status, req.store.id, req.params.id]);
    req.flash('success', 'Order status updated.');
    res.redirect(`/admin/orders/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Customers ----------
// Real accounts from pz_customers (storefront signup/login), not guests
// derived from order history — a guest checkout with no account won't show
// up here, only shoppers who actually created a customer account.
router.get('/customers', async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.created_at,
              COUNT(o.id) AS orderCount,
              COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0) AS totalSpent,
              MAX(o.created_at) AS lastOrderAt
       FROM ${TABLES.customers} c
       LEFT JOIN ${TABLES.orders} o ON o.customer_id = c.id
       WHERE c.store_id = ?
       GROUP BY c.id
       ORDER BY totalSpent DESC`,
      [req.store.id]
    );
    res.render('admin/customers', {
      title: 'Customers',
      customers: customers.map((c) => ({ ...c, totalSpent: Number(c.totalSpent) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Discounts ----------
router.get('/discounts', async (req, res, next) => {
  try {
    const [discounts] = await pool.query(`SELECT * FROM ${TABLES.discounts} WHERE store_id = ? ORDER BY created_at DESC`, [req.store.id]);
    res.render('admin/discounts', { title: 'Discounts', discounts: discounts.map((d) => ({ ...d, value: Number(d.value) })) });
  } catch (err) {
    next(err);
  }
});

router.get('/discounts/new', (req, res) => {
  res.render('admin/discount-form', { title: 'New Discount' });
});

router.post('/discounts/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const code = (req.body.code || '').trim().toUpperCase();
    const type = req.body.type === 'flat' ? 'flat' : 'percent';
    const value = parseFloat(req.body.value);

    if (!code) {
      req.flash('error', 'Code is required.');
      return res.redirect('/admin/discounts/new');
    }
    if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100)) {
      req.flash('error', type === 'percent' ? 'Percent must be between 1 and 100.' : 'Amount must be greater than 0.');
      return res.redirect('/admin/discounts/new');
    }

    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.discounts} WHERE store_id = ? AND code = ?`, [storeId, code]);
    if (existing) {
      req.flash('error', `Code "${code}" already exists.`);
      return res.redirect('/admin/discounts/new');
    }

    await pool.query(`INSERT INTO ${TABLES.discounts} (store_id, code, type, value, active) VALUES (?, ?, ?, ?, 1)`, [storeId, code, type, value]);
    req.flash('success', 'Discount created.');
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

router.post('/discounts/:id/toggle', async (req, res, next) => {
  try {
    await pool.query(`UPDATE ${TABLES.discounts} SET active = NOT active WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

router.post('/discounts/:id/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.discounts} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Discount deleted.');
    res.redirect('/admin/discounts');
  } catch (err) {
    next(err);
  }
});

// ---------- Finance ----------
router.get('/finance', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[{ total: revenue }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status != 'cancelled'`,
      [storeId]
    );
    const [[{ total: collected }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status IN ('paid', 'shipped', 'delivered')`,
      [storeId]
    );
    const [[{ total: pendingCOD }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? AND status = 'pending'`,
      [storeId]
    );
    const [byStatus] = await pool.query(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(total), 0) AS total FROM ${TABLES.orders} WHERE store_id = ? GROUP BY status`,
      [storeId]
    );
    const [recentOrders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? ORDER BY created_at DESC LIMIT 10`,
      [storeId]
    );

    res.render('admin/finance', {
      title: 'Finance',
      revenue: Number(revenue),
      collected: Number(collected),
      pendingCOD: Number(pendingCOD),
      byStatus: byStatus.map((s) => ({ ...s, total: Number(s.total) })),
      recentOrders: recentOrders.map(orderToNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Analytics ----------
router.get('/analytics', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [byDay] = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM ${TABLES.orders}
       WHERE store_id = ? AND status != 'cancelled' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day`,
      [storeId]
    );
    const [topProducts] = await pool.query(
      `SELECT oi.title, SUM(oi.quantity) AS unitsSold, SUM(oi.price * oi.quantity) AS revenue
       FROM ${TABLES.orderItems} oi
       JOIN ${TABLES.orders} o ON o.id = oi.order_id
       WHERE o.store_id = ? AND o.status != 'cancelled'
       GROUP BY oi.title
       ORDER BY unitsSold DESC
       LIMIT 5`,
      [storeId]
    );

    const days = byDay.map((d) => ({ day: d.day, orders: d.orders, revenue: Number(d.revenue) }));
    const maxRevenue = Math.max(1, ...days.map((d) => d.revenue));

    res.render('admin/analytics', {
      title: 'Analytics',
      days,
      maxRevenue,
      topProducts: topProducts.map((p) => ({ ...p, revenue: Number(p.revenue) })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Markets ----------
// PageZaper only sells in one market today — there's no multi-currency or
// per-country pricing yet, so this is an honest status page, not a
// functional multi-market setup like Shopify's.
router.get('/markets', (req, res) => {
  res.render('admin/markets', { title: 'Markets' });
});

// ---------- Apps ----------
// No app/integration marketplace exists yet — this says so plainly rather
// than showing fake installed apps.
router.get('/apps', (req, res) => {
  res.render('admin/apps', { title: 'Apps' });
});

// ---------- Settings ----------
router.get('/settings', async (req, res, next) => {
  try {
    const [team] = await pool.query(
      `SELECT u.id, u.name, u.email, ur.role, ur.created_at
       FROM ${TABLES.userRoles} ur
       JOIN ${TABLES.users} u ON u.id = ur.user_id
       WHERE ur.store_id = ?
       ORDER BY (ur.role = 'admin') DESC, u.name ASC`,
      [req.store.id]
    );
    res.render('admin/settings', { title: 'Settings', themes: THEMES, team });
  } catch (err) {
    next(err);
  }
});

// Invite a teammate as Admin or Manager. Admin AND Manager can both do this
// ("can add") — reuses an existing pz_users login by email if that person
// already has an account (e.g. staff at another store) rather than
// overwriting their password.
router.post('/settings/team', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const role = req.body.role === 'manager' ? 'manager' : 'admin';

    if (!name || !email) {
      req.flash('error', 'Name and email are required.');
      return res.redirect('/admin/settings');
    }

    const [[existingUser]] = await pool.query(`SELECT id, name FROM ${TABLES.users} WHERE email = ?`, [email]);

    let userId;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      if (!password || password.length < 6) {
        req.flash('error', 'Password must be at least 6 characters for a new team member.');
        return res.redirect('/admin/settings');
      }
      const passwordHash = bcrypt.hashSync(password, 10);
      const [result] = await pool.query(`INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, passwordHash]);
      userId = result.insertId;
    }

    const [[existingRole]] = await pool.query(
      `SELECT id FROM ${TABLES.userRoles} WHERE user_id = ? AND store_id = ? AND role = ?`,
      [userId, storeId, role]
    );
    if (existingRole) {
      req.flash('error', `${email} already has ${role} access to this store.`);
      return res.redirect('/admin/settings');
    }

    await pool.query(`INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, ?)`, [userId, storeId, role]);
    req.flash('success', `${email} added as ${role}.`);
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

// Admin only — a Manager can invite teammates but not remove them.
router.post('/settings/team/:userId/delete', requireAdminRole, async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[role]] = await pool.query(
      `SELECT * FROM ${TABLES.userRoles} WHERE user_id = ? AND store_id = ?`,
      [req.params.userId, storeId]
    );
    if (!role) {
      req.flash('error', 'Team member not found.');
      return res.redirect('/admin/settings');
    }

    if (role.role === 'admin') {
      const [[{ c: adminCount }]] = await pool.query(
        `SELECT COUNT(*) AS c FROM ${TABLES.userRoles} WHERE store_id = ? AND role = 'admin'`,
        [storeId]
      );
      if (adminCount <= 1) {
        req.flash('error', "Can't remove the only Admin — the store would be locked out.");
        return res.redirect('/admin/settings');
      }
    }

    await pool.query(`DELETE FROM ${TABLES.userRoles} WHERE id = ?`, [role.id]);
    req.flash('success', 'Team member removed.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/store', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const theme = THEMES.includes(req.body.theme) ? req.body.theme : req.store.theme;

    if (!name) {
      req.flash('error', 'Store name is required.');
      return res.redirect('/admin/settings');
    }

    await pool.query(`UPDATE ${TABLES.stores} SET name = ?, theme = ? WHERE id = ?`, [name, theme, req.store.id]);
    req.flash('success', 'Store settings updated.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

router.post('/settings/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const [[user]] = await pool.query(`SELECT * FROM ${TABLES.users} WHERE id = ?`, [req.session.admin.id]);

    if (!user || !bcrypt.compareSync(currentPassword || '', user.password_hash)) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/settings');
    }
    if (!newPassword || newPassword.length < 6) {
      req.flash('error', 'New password must be at least 6 characters.');
      return res.redirect('/admin/settings');
    }
    if (newPassword !== confirmPassword) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/admin/settings');
    }

    // This changes the pz_users password globally — note it applies to every
    // store this person has a role at, not just this one, since logins are
    // shared across stores now.
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await pool.query(`UPDATE ${TABLES.users} SET password_hash = ? WHERE id = ?`, [passwordHash, user.id]);
    req.flash('success', 'Password changed.');
    res.redirect('/admin/settings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
