const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES, THEMES } = require('../db/database');
const { requireAdmin, requireAdminRole } = require('../middleware/auth');
const { rootUrl, adminPortalUrl, storeUrl } = require('../middleware/tenant');
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
const menusLib = require('../lib/menus');
const { importDemoContent } = require('../lib/demoImport');
const mediaLib = require('../lib/media');
const { getActiveAppSlugs, listAppsForStore, activateApp } = require('../lib/apps');
const metaobjectsLib = require('../lib/metaobjects');

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
  // Also drop the account session: an account-level "log in as" (see
  // routes/platformAdmin.js) sets it, and it must not outlive the exit.
  req.session.account = null;
  req.session.impersonation = null;
  res.redirect(rootUrl(req, '/platform-admin'));
});

// Everything below requires admin auth for this store
router.use(requireAdmin);

// Which paid apps (CRM, etc.) are on for this store right now — bundled by
// its plan or individually activated. Computed once per request so both
// the nav (header.ejs reads res.locals.activeAppSlugs) and the route guard
// below agree with the Apps marketplace screen without each querying it
// separately. Fails open to "no apps active" rather than breaking the page
// if the query has a problem.
router.use(async (req, res, next) => {
  try {
    res.locals.activeAppSlugs = await getActiveAppSlugs(req.store.id, req.store.plan);
  } catch (err) {
    res.locals.activeAppSlugs = [];
  }
  next();
});

// Gates a path prefix behind a paid app being active for this store —
// used for /contacts below. Sends merchants who haven't activated the app
// to the Apps screen instead of a raw 403.
function requireApp(slug, label) {
  return (req, res, next) => {
    if (res.locals.activeAppSlugs && res.locals.activeAppSlugs.includes(slug)) return next();
    req.flash('error', `${label} isn't active for this store yet — activate it from Apps first.`);
    res.redirect('/admin/apps');
  };
}

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

// ---------- Categories ----------
// Deliberately minimal -- a category is just a name here (no description,
// image, or nesting). Renaming is an inline edit right in the list (see
// views/admin/categories.ejs) rather than a whole separate page, since
// there's only the one field.
router.get('/categories', async (req, res, next) => {
  try {
    const [categories] = await pool.query(
      `SELECT c.*, COUNT(pc.product_id) AS product_count
       FROM ${TABLES.categories} c
       LEFT JOIN ${TABLES.productCategories} pc ON pc.category_id = c.id
       WHERE c.store_id = ?
       GROUP BY c.id
       ORDER BY c.name`,
      [req.store.id]
    );
    res.render('admin/categories', { title: 'Categories', categories });
  } catch (err) {
    next(err);
  }
});

router.post('/categories', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Category name is required.');
      return res.redirect('/admin/categories');
    }
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND name = ?`, [req.store.id, name]);
    if (existing) {
      req.flash('error', `A category named "${name}" already exists.`);
      return res.redirect('/admin/categories');
    }
    await pool.query(`INSERT INTO ${TABLES.categories} (store_id, name) VALUES (?, ?)`, [req.store.id, name]);
    req.flash('success', 'Category created.');
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.post('/categories/:id/edit', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Category name is required.');
      return res.redirect('/admin/categories');
    }
    const [[owned]] = await pool.query(`SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!owned) {
      req.flash('error', 'Category not found.');
      return res.redirect('/admin/categories');
    }
    const [[existing]] = await pool.query(
      `SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND name = ? AND id != ?`,
      [req.store.id, name, req.params.id]
    );
    if (existing) {
      req.flash('error', `A category named "${name}" already exists.`);
      return res.redirect('/admin/categories');
    }
    await pool.query(`UPDATE ${TABLES.categories} SET name = ? WHERE store_id = ? AND id = ?`, [name, req.store.id, req.params.id]);
    req.flash('success', 'Category renamed.');
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.post('/categories/:id/delete', async (req, res, next) => {
  try {
    // No confirmation needed beyond the browser-side one in the view --
    // products.category_id is ON DELETE SET NULL and pz_product_categories
    // is ON DELETE CASCADE (see db/database.js), so this never fails or
    // leaves a product half-linked; it just un-categorizes anything that
    // was only in this one category.
    await pool.query(`DELETE FROM ${TABLES.categories} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Category deleted.');
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

// ---------- Products ----------
// Normalizes the product form's category_ids[] (checkboxes; a single check
// arrives as a bare string rather than an array, so this always gives back
// an array) into a de-duped list of positive integer ids actually owned by
// this store -- never trusts an id straight from the request body, since
// nothing stops a crafted request from naming another store's category.
async function ownedCategoryIds(storeId, rawIds) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return [];
  const [rows] = await pool.query(`SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND id IN (?)`, [storeId, ids]);
  return rows.map((r) => r.id);
}

// Replaces a product's full set of category links in one go -- simplest
// correct way to handle "some added, some removed" from a checkbox list
// without diffing. Cheap: a product realistically has a handful of
// categories at most.
async function setProductCategories(productId, categoryIds) {
  await pool.query(`DELETE FROM ${TABLES.productCategories} WHERE product_id = ?`, [productId]);
  if (categoryIds.length) {
    await pool.query(
      `INSERT INTO ${TABLES.productCategories} (product_id, category_id) VALUES ${categoryIds.map(() => '(?, ?)').join(', ')}`,
      categoryIds.flatMap((cid) => [productId, cid])
    );
  }
}

router.get('/products', async (req, res, next) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, GROUP_CONCAT(c.name ORDER BY c.name SEPARATOR ', ') AS category_names
       FROM ${TABLES.products} p
       LEFT JOIN ${TABLES.productCategories} pc ON pc.product_id = p.id
       LEFT JOIN ${TABLES.categories} c ON c.id = pc.category_id
       WHERE p.store_id = ?
       GROUP BY p.id
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
    res.render('admin/product-form', { title: 'New Product', product: null, categories, selectedCategoryIds: [] });
  } catch (err) {
    next(err);
  }
});

router.post('/products/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { title, description, price, compare_at_price, image_url, category_ids, stock, status } = req.body;

    if (!title || !price) {
      req.flash('error', 'Title and price are required.');
      return res.redirect('/admin/products/new');
    }

    let slug = slugify(title);
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [storeId, slug]);
    if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    const categoryIds = await ownedCategoryIds(storeId, category_ids);

    const [result] = await pool.query(
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
        // Legacy column -- first picked category, kept only so anything not
        // yet updated to the junction table (see TABLES.productCategories)
        // still sees a reasonable value instead of always NULL.
        categoryIds[0] || null,
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
      ]
    );
    await setProductCategories(result.insertId, categoryIds);

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
    const [linkRows] = await pool.query(`SELECT category_id FROM ${TABLES.productCategories} WHERE product_id = ?`, [product.id]);
    res.render('admin/product-form', {
      title: 'Edit Product',
      product: toNumber(product),
      categories,
      selectedCategoryIds: linkRows.map((r) => r.category_id),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/products/:id/edit', async (req, res, next) => {
  try {
    const { title, description, price, compare_at_price, image_url, category_ids, stock, status } = req.body;

    // An explicit ownership check up front -- rather than trusting the
    // UPDATE's affectedRows to prove that (MySQL reports rows CHANGED, not
    // rows MATCHED, by default; a resubmit that doesn't alter any column
    // would show 0 even for a product this store legitimately owns, which
    // would then wrongly skip the category-links write below) -- so a
    // crafted product id can never be used to rewrite another store's
    // product-category links, and a same-value resubmit still saves.
    const [[owned]] = await pool.query(`SELECT id FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!owned) {
      req.flash('error', 'Product not found.');
      return res.redirect('/admin/products');
    }

    const categoryIds = await ownedCategoryIds(req.store.id, category_ids);

    await pool.query(
      `UPDATE ${TABLES.products} SET title = ?, description = ?, price = ?, compare_at_price = ?, image_url = ?, category_id = ?, stock = ?, status = ?
       WHERE store_id = ? AND id = ?`,
      [
        title,
        description || '',
        parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        image_url || '',
        categoryIds[0] || null, // legacy column -- see comment in POST /products/new
        parseInt(stock, 10) || 0,
        status === 'draft' ? 'draft' : 'active',
        req.store.id,
        req.params.id,
      ]
    );
    await setProductCategories(owned.id, categoryIds);

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

// ---------- Metaobjects (custom content types, e.g. a real-estate store's
// "Property") -- see lib/metaobjects.js for the definition/field/entry
// model. Every route below is store-scoped through req.store.id the same
// way products/categories are; all three screens (list, one definition's
// schema+entries, one entry's form) share the title 'Metaobjects' so the
// sidebar's nav-active check (views/admin/partials/header.ejs) is a single
// plain string compare, same trick the CRM task drawer uses for its own
// title.
async function loadOwnedDefinition(storeId, id) {
  return metaobjectsLib.getDefinition(storeId, id);
}

router.get('/metaobjects', async (req, res, next) => {
  try {
    const definitions = await metaobjectsLib.listDefinitions(req.store.id);
    res.render('admin/metaobjects', { title: 'Metaobjects', definitions });
  } catch (err) {
    next(err);
  }
});

router.post('/metaobjects', async (req, res, next) => {
  try {
    const id = await metaobjectsLib.createDefinition(req.store.id, { name: req.body.name, handle: req.body.handle });
    req.flash('success', 'Metaobject type created — add its fields below.');
    res.redirect(`/admin/metaobjects/${id}`);
  } catch (err) {
    if (err && err.message) {
      req.flash('error', err.message);
      return res.redirect('/admin/metaobjects');
    }
    next(err);
  }
});

router.get('/metaobjects/:id', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    const [fields, entries] = await Promise.all([
      metaobjectsLib.listFields(definition.id),
      metaobjectsLib.listEntries(req.store.id, definition.id),
    ]);
    res.render('admin/metaobject-detail', {
      title: 'Metaobjects',
      definition,
      fields,
      entries,
      fieldTypes: metaobjectsLib.FIELD_TYPES,
      fieldTypeLabels: metaobjectsLib.FIELD_TYPE_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/metaobjects/:id/edit', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    await metaobjectsLib.updateDefinition(req.store.id, definition.id, { name: req.body.name, handle: req.body.handle });
    req.flash('success', 'Saved.');
  } catch (err) {
    if (!err || !err.message) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(`/admin/metaobjects/${req.params.id}`);
});

router.post('/metaobjects/:id/delete', async (req, res, next) => {
  try {
    await metaobjectsLib.deleteDefinition(req.store.id, req.params.id);
    req.flash('success', 'Metaobject type deleted, along with every entry of it.');
    res.redirect('/admin/metaobjects');
  } catch (err) {
    next(err);
  }
});

// ---- Fields (one definition's schema) ----
router.post('/metaobjects/:id/fields', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    await metaobjectsLib.addField(definition.id, {
      label: req.body.label,
      type: req.body.type,
      required: req.body.required === '1',
      options: req.body.options,
    });
    req.flash('success', 'Field added.');
  } catch (err) {
    if (!err || !err.message) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(`/admin/metaobjects/${req.params.id}`);
});

router.post('/metaobjects/:id/fields/:fieldId/edit', async (req, res, next) => {
  try {
    await metaobjectsLib.updateField(req.params.id, req.params.fieldId, {
      label: req.body.label,
      type: req.body.type,
      required: req.body.required === '1',
      options: req.body.options,
    });
    req.flash('success', 'Field saved.');
  } catch (err) {
    if (!err || !err.message) return next(err);
    req.flash('error', err.message);
  }
  res.redirect(`/admin/metaobjects/${req.params.id}`);
});

router.post('/metaobjects/:id/fields/:fieldId/delete', async (req, res, next) => {
  try {
    await metaobjectsLib.deleteField(req.params.id, req.params.fieldId);
    req.flash('success', 'Field deleted. Existing entries keep whatever value it held, just no longer editable.');
    res.redirect(`/admin/metaobjects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---- Entries (one row per actual item, e.g. one property) ----
router.get('/metaobjects/:id/entries/new', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    const fields = await metaobjectsLib.listFields(definition.id);
    res.render('admin/metaobject-entry-form', { title: 'Metaobjects', definition, fields, entry: null, values: {} });
  } catch (err) {
    next(err);
  }
});

router.post('/metaobjects/:id/entries/new', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    const fields = await metaobjectsLib.listFields(definition.id);
    const fieldValues = metaobjectsLib.sanitizeFieldValues(fields, req.body);
    const entryId = await metaobjectsLib.createEntry(
      req.store.id,
      definition,
      { title: req.body.title, image_url: req.body.image_url, status: req.body.status },
      fieldValues
    );
    req.flash('success', `${definition.name} entry created.`);
    res.redirect(`/admin/metaobjects/${definition.id}/entries/${entryId}/edit`);
  } catch (err) {
    if (err && err.message) {
      req.flash('error', err.message);
      return res.redirect(`/admin/metaobjects/${req.params.id}/entries/new`);
    }
    next(err);
  }
});

router.get('/metaobjects/:id/entries/:entryId/edit', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    const entry = await metaobjectsLib.getEntry(req.store.id, definition.id, req.params.entryId);
    if (!entry) {
      req.flash('error', 'Entry not found.');
      return res.redirect(`/admin/metaobjects/${definition.id}`);
    }
    const fields = await metaobjectsLib.listFields(definition.id);
    res.render('admin/metaobject-entry-form', { title: 'Metaobjects', definition, fields, entry, values: entry.details || {} });
  } catch (err) {
    next(err);
  }
});

router.post('/metaobjects/:id/entries/:entryId/edit', async (req, res, next) => {
  try {
    const definition = await loadOwnedDefinition(req.store.id, req.params.id);
    if (!definition) {
      req.flash('error', 'Metaobject type not found.');
      return res.redirect('/admin/metaobjects');
    }
    const fields = await metaobjectsLib.listFields(definition.id);
    const fieldValues = metaobjectsLib.sanitizeFieldValues(fields, req.body);
    await metaobjectsLib.updateEntry(
      req.store.id,
      definition.id,
      req.params.entryId,
      { title: req.body.title, image_url: req.body.image_url, status: req.body.status },
      fieldValues
    );
    req.flash('success', 'Saved.');
    res.redirect(`/admin/metaobjects/${definition.id}/entries/${req.params.entryId}/edit`);
  } catch (err) {
    if (err && err.message) {
      req.flash('error', err.message);
      return res.redirect(`/admin/metaobjects/${req.params.id}/entries/${req.params.entryId}/edit`);
    }
    next(err);
  }
});

router.post('/metaobjects/:id/entries/:entryId/delete', async (req, res, next) => {
  try {
    await metaobjectsLib.deleteEntry(req.store.id, req.params.id, req.params.entryId);
    req.flash('success', 'Entry deleted.');
    res.redirect(`/admin/metaobjects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- Blog posts (Content > Blog posts) ----------
router.get('/blog', async (req, res, next) => {
  try {
    const [posts] = await pool.query(
      `SELECT * FROM ${TABLES.blogPosts} WHERE store_id = ? ORDER BY created_at DESC`,
      [req.store.id]
    );
    res.render('admin/blog', { title: 'Blog Posts', posts });
  } catch (err) {
    next(err);
  }
});

router.get('/blog/new', (req, res) => {
  res.render('admin/blog-form', { title: 'New Blog Post', post: null });
});

router.post('/blog/new', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { title, excerpt, body, cover_image_url, status } = req.body;

    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/admin/blog/new');
    }

    let slug = slugify(title);
    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.blogPosts} WHERE store_id = ? AND slug = ?`, [storeId, slug]);
    if (existing) slug = `${slug}-${Date.now().toString().slice(-4)}`;

    const publishing = status === 'published';
    await pool.query(
      `INSERT INTO ${TABLES.blogPosts} (store_id, title, slug, excerpt, body, cover_image_url, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
        title,
        slug,
        excerpt || '',
        body || '',
        cover_image_url || '',
        publishing ? 'published' : 'draft',
        publishing ? new Date() : null,
      ]
    );

    req.flash('success', 'Blog post created.');
    res.redirect('/admin/blog');
  } catch (err) {
    next(err);
  }
});

router.get('/blog/:id/edit', async (req, res, next) => {
  try {
    const [[post]] = await pool.query(`SELECT * FROM ${TABLES.blogPosts} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!post) {
      req.flash('error', 'Blog post not found.');
      return res.redirect('/admin/blog');
    }
    res.render('admin/blog-form', { title: 'Edit Blog Post', post });
  } catch (err) {
    next(err);
  }
});

router.post('/blog/:id/edit', async (req, res, next) => {
  try {
    const [[existingPost]] = await pool.query(`SELECT id, status, published_at FROM ${TABLES.blogPosts} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    if (!existingPost) {
      req.flash('error', 'Blog post not found.');
      return res.redirect('/admin/blog');
    }

    const { title, excerpt, body, cover_image_url, status } = req.body;
    const publishing = status === 'published';
    // published_at is set the first time this post goes live and never
    // touched again after that -- see the CREATE TABLE comment in
    // db/database.js.
    const publishedAt = publishing
      ? (existingPost.published_at || new Date())
      : existingPost.published_at;

    await pool.query(
      `UPDATE ${TABLES.blogPosts} SET title = ?, excerpt = ?, body = ?, cover_image_url = ?, status = ?, published_at = ?
       WHERE store_id = ? AND id = ?`,
      [
        title,
        excerpt || '',
        body || '',
        cover_image_url || '',
        publishing ? 'published' : 'draft',
        publishedAt,
        req.store.id,
        req.params.id,
      ]
    );

    req.flash('success', 'Blog post updated.');
    res.redirect('/admin/blog');
  } catch (err) {
    next(err);
  }
});

router.post('/blog/:id/delete', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM ${TABLES.blogPosts} WHERE store_id = ? AND id = ?`, [req.store.id, req.params.id]);
    req.flash('success', 'Blog post deleted.');
    res.redirect('/admin/blog');
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

// The store's saved menus, plus each one's items already resolved to real
// labels/urls (lib/menus.js's resolveMenu) — for the builder canvas to
// preview a nav_menu section's picked menu with the merchant's actual
// pages/categories/products/links instantly, the moment they change the
// picker, without a round trip per keystroke (same instant-preview
// philosophy every other section's fields already get). Every builder
// screen a nav_menu section can appear on (header, footer, and a page's own
// header/footer override) needs this, not just the page-body screen, which
// is why it's shared here.
async function loadMenuContext(storeId) {
  const menus = await menusLib.listMenus(storeId);
  const resolvedMenus = {};
  await Promise.all(menus.map(async (m) => {
    resolvedMenus[m.id] = await menusLib.resolveMenu(storeId, m.id);
  }));
  return { menus, resolvedMenus };
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
// Every section type's blank-slate fields, keyed by type — handed to the
// client once as window.__BUILDER__.sectionDefaultFields so the builder can
// construct a brand-new section (and give it a real `fields` object)
// entirely in the browser, without a round trip to the server, now that
// adding/duplicating a section is a local edit that only reaches the
// database when the merchant clicks Save (see scopeSaveSections and
// admin-builder.js's addSectionAt/duplicateSection/insertComponent).
const SECTION_DEFAULT_FIELDS = Object.keys(SECTION_TYPES).reduce((acc, type) => {
  acc[type] = defaultFields(type);
  return acc;
}, {});

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

// Shared core of the "replace this scope's sections with exactly this
// incoming array" operation — diffs incoming ids against what's currently in
// the DB, UPDATEs matches, INSERTs anything new (including client-only ids
// like "tmp_xxx", which simply never match an existing numeric id and so
// always fall into the insert branch), and DELETEs whatever isn't present in
// the incoming array. Used by the legacy /sections/restore route below, by
// the explicit Save button's /sections/save route, and by revision restore —
// all three are really the same "make this the live state" operation, just
// with different callers/side-effects around it (see scopeSaveSections and
// scopeRestoreRevision).
async function applySectionsDiff(scope, incoming) {
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
      // Universal Style-tab controls (see lib/sections.js's sanitizeSectionSettings) —
      // '' means "no override", stored as NULL same as custom_class/custom_css.
      const textColor = settings.text_color || null;
      const bgColor = settings.bg_color || null;
      const textAlign = settings.text_align || null;

      const incomingId = Number.isInteger(item.id) ? item.id : parseInt(item.id, 10);
      if (incomingId && existingIds.has(incomingId)) {
        keepIds.add(incomingId);
        await pool.query(
          `UPDATE ${TABLES.pageSections}
             SET position = ?, fields = ?, hidden = ?, custom_class = ?, custom_css = ?, min_height = ?,
                 hide_desktop = ?, hide_tablet = ?, hide_mobile = ?,
                 margin_top = ?, margin_bottom = ?, margin_left = ?, margin_right = ?,
                 padding_top = ?, padding_bottom = ?, padding_left = ?, padding_right = ?, element_styles = ?,
                 text_color = ?, bg_color = ?, text_align = ?
           WHERE id = ?`,
          [i, JSON.stringify(fields), hidden, customClass, customCss, minHeight, hideDesktop, hideTablet, hideMobile,
            marginTop, marginBottom, marginLeft, marginRight,
            paddingTop, paddingBottom, paddingLeft, paddingRight, elementStylesJson,
            textColor, bgColor, textAlign, incomingId]
        );
      } else {
        const [result] = await pool.query(
          `INSERT INTO ${TABLES.pageSections}
             (store_id, page_id, region, type, position, fields, hidden, custom_class, custom_css, min_height, hide_desktop, hide_tablet, hide_mobile,
              margin_top, margin_bottom, margin_left, margin_right,
              padding_top, padding_bottom, padding_left, padding_right, element_styles, text_color, bg_color, text_align)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [scope.storeId, scope.pageId, scope.region, item.type, i, JSON.stringify(fields), hidden, customClass, customCss, minHeight, hideDesktop, hideTablet, hideMobile,
            marginTop, marginBottom, marginLeft, marginRight,
            paddingTop, paddingBottom, paddingLeft, paddingRight, elementStylesJson,
            textColor, bgColor, textAlign]
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
}

// Kept for back-compat (nothing in the builder calls this anymore now that
// undo/redo is purely client-side — see admin-builder.js's history stack —
// but it's a harmless, still-correct "make this the live state" primitive,
// and removing a working route earns nothing). Does NOT record a revision;
// only an explicit Save (scopeSaveSections) or a revision restore
// (scopeRestoreRevision) does that.
async function scopeRestoreSections(scope, req, res, next) {
  try {
    const incoming = Array.isArray(req.body.sections) ? req.body.sections.slice(0, 200) : [];
    await applySectionsDiff(scope, incoming);
    res.json({ ok: true, sections: await scopeListSections(scope) });
  } catch (err) {
    next(err);
  }
}

// How many past saves/restores to keep on file per scope (per page's body,
// per store's global header, per store's global footer, per page's own
// header/footer override) — mirrors a WordPress site keeping a bounded,
// not unlimited, revision list. Pruned on every save; see pruneScopeRevisions.
const MAX_REVISIONS_PER_SCOPE = 30;

// The explicit Save button's endpoint — applies the incoming full sections
// tree (built entirely client-side since edits stopped autosaving; see
// admin-builder.js) the same way applySectionsDiff always has, then records
// the resulting state as a new revision so it shows up in "Revision
// history" and can be restored later.
async function scopeSaveSections(scope, req, res, next) {
  try {
    const incoming = Array.isArray(req.body.sections) ? req.body.sections.slice(0, 200) : [];
    await applySectionsDiff(scope, incoming);
    const sections = await scopeListSections(scope);
    await recordRevision(scope, sections, req);
    res.json({ ok: true, sections });
  } catch (err) {
    next(err);
  }
}

async function recordRevision(scope, sections, req) {
  const admin = (req && req.session && req.session.admin) || {};
  await pool.query(
    `INSERT INTO ${TABLES.pageSectionRevisions} (store_id, page_id, region, sections_json, section_count, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [scope.storeId, scope.pageId, scope.region, JSON.stringify(sections), sections.length, admin.id || null, admin.name || null]
  );
  await pruneScopeRevisions(scope);
}

async function pruneScopeRevisions(scope) {
  const { sql, params } = scopeWhere(scope);
  const [rows] = await pool.query(
    `SELECT id FROM ${TABLES.pageSectionRevisions} WHERE ${sql} ORDER BY created_at DESC, id DESC`,
    params
  );
  if (rows.length <= MAX_REVISIONS_PER_SCOPE) return;
  const staleIds = rows.slice(MAX_REVISIONS_PER_SCOPE).map((r) => r.id);
  await pool.query(`DELETE FROM ${TABLES.pageSectionRevisions} WHERE id IN (${staleIds.map(() => '?').join(',')})`, staleIds);
}

async function scopeListRevisions(scope, req, res, next) {
  try {
    const { sql, params } = scopeWhere(scope);
    const [rows] = await pool.query(
      `SELECT id, section_count, created_by_name, created_at FROM ${TABLES.pageSectionRevisions}
       WHERE ${sql} ORDER BY created_at DESC, id DESC LIMIT ${MAX_REVISIONS_PER_SCOPE}`,
      params
    );
    res.json({ ok: true, revisions: rows });
  } catch (err) {
    next(err);
  }
}

// Makes an older saved revision the live state again — itself recorded as a
// brand-new revision (WordPress does the same: restoring never destroys
// history, it just adds "restored to <date>" as the newest entry) so a
// merchant can never lose work by restoring the wrong thing.
async function scopeRestoreRevision(scope, revisionId, req, res, next) {
  try {
    const { sql, params } = scopeWhere(scope);
    const [[row]] = await pool.query(
      `SELECT sections_json FROM ${TABLES.pageSectionRevisions} WHERE id = ? AND ${sql}`,
      [revisionId, ...params]
    );
    if (!row) return res.status(404).json({ error: 'Revision not found' });
    const incoming = JSON.parse(row.sections_json);
    await applySectionsDiff(scope, incoming);
    const sections = await scopeListSections(scope);
    await recordRevision(scope, sections, req);
    res.json({ ok: true, sections });
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
    // Universal Style-tab controls — '' clears back to "inherit from theme"
    // (stored as NULL), same convention custom_class/custom_css already use.
    if (patch.text_color !== undefined) { sets.push('text_color = ?'); values.push(patch.text_color || null); }
    if (patch.bg_color !== undefined) { sets.push('bg_color = ?'); values.push(patch.bg_color || null); }
    if (patch.text_align !== undefined) { sets.push('text_align = ?'); values.push(patch.text_align || null); }
    if (sets.length) {
      values.push(section.id);
      await pool.query(`UPDATE ${TABLES.pageSections} SET ${sets.join(', ')} WHERE id = ?`, values);
    }

    const [[updated]] = await pool.query(
      `SELECT custom_class, custom_css, min_height, hide_desktop, hide_tablet, hide_mobile,
              margin_top, margin_bottom, margin_left, margin_right,
              padding_top, padding_bottom, padding_left, padding_right,
              text_color, bg_color, text_align
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
      text_color: updated.text_color || '',
      bg_color: updated.bg_color || '',
      text_align: updated.text_align || '',
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
  // Explicit Save — see scopeSaveSections. This is the only route the
  // builder's Save button ever calls; every other mutation below happens
  // purely in the browser until Save is clicked.
  router.post(`${routePrefix}/sections/save`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeSaveSections(scope, req, res, next);
  });
  router.get(`${routePrefix}/revisions`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeListRevisions(scope, req, res, next);
  });
  router.post(`${routePrefix}/revisions/:revisionId/restore`, async (req, res, next) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    return scopeRestoreRevision(scope, req.params.revisionId, req, res, next);
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
    const { menus, resolvedMenus } = await loadMenuContext(req.store.id);
    res.render('admin/builder', {
      title: `Edit ${page.name}`,
      page,
      context: 'page',
      sectionsBase: `/admin/pages/${page.id}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      sectionDefaultFields: SECTION_DEFAULT_FIELDS,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products,
      categories,
      components,
      menus,
      resolvedMenus,
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
    const { menus, resolvedMenus } = await loadMenuContext(req.store.id);
    res.render('admin/builder', {
      title: region === 'header' ? 'Header' : 'Footer',
      page: null,
      context: region,
      sectionsBase: `/admin/layout/${region}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      sectionDefaultFields: SECTION_DEFAULT_FIELDS,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products: [],
      categories: [],
      components,
      menus,
      resolvedMenus,
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
    const { menus, resolvedMenus } = await loadMenuContext(req.store.id);
    res.render('admin/builder', {
      title: `${region === 'header' ? 'Header' : 'Footer'} override — ${page.name}`,
      page,
      context: region,
      sectionsBase: `/admin/pages/${page.id}/layout/${region}/sections`,
      sections,
      sectionTypes: SECTION_TYPES,
      sectionDefaultFields: SECTION_DEFAULT_FIELDS,
      nestableTypes: NESTABLE_SECTION_TYPES,
      textElementFields: TEXT_ELEMENT_FIELDS,
      products: [],
      categories: [],
      components,
      menus,
      resolvedMenus,
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

// ---------- Menus (WordPress-style saved navigation menus) ----------
// A menu is a named, reusable tree of items (lib/menus.js) that a nav_menu
// section picks by id instead of storing links inline — see lib/menus.js's
// header comment for the full picture. The list/editor pages below are the
// "Menus" screen linked from the admin sidebar; everything under
// /menus/:id/items is the JSON API the drag-and-drop editor
// (public/js/admin-menus.js, added in a later step) talks to.

router.get('/menus', async (req, res, next) => {
  try {
    const menus = await menusLib.listMenus(req.store.id);
    res.render('admin/menus', { title: 'Menus', menus });
  } catch (err) {
    next(err);
  }
});

router.post('/menus', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      req.flash('error', 'Give the menu a name.');
      return res.redirect('/admin/menus');
    }
    const menuId = await menusLib.createMenu(req.store.id, name);
    req.flash('success', 'Menu created.');
    res.redirect(`/admin/menus/${menuId}`);
  } catch (err) {
    next(err);
  }
});

router.get('/menus/:id', async (req, res, next) => {
  try {
    const menu = await menusLib.getMenu(req.store.id, req.params.id);
    if (!menu) {
      req.flash('error', 'Menu not found.');
      return res.redirect('/admin/menus');
    }
    const [items, sources] = await Promise.all([
      menusLib.getMenuItemsTree(req.store.id, menu.id),
      menusLib.listAddableSources(req.store.id),
    ]);
    res.render('admin/menu-edit', { title: `Edit menu: ${menu.name}`, menu, items, sources });
  } catch (err) {
    next(err);
  }
});

router.post('/menus/:id/rename', async (req, res, next) => {
  try {
    const ok = await menusLib.renameMenu(req.store.id, req.params.id, req.body.name);
    if (!ok) return res.status(400).json({ error: 'Give the menu a name.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Admin only — a Manager can build/edit a menu but not delete it, matching
// the pages/:id/delete restriction above.
router.post('/menus/:id/delete', requireAdminRole, async (req, res, next) => {
  try {
    await menusLib.deleteMenu(req.store.id, req.params.id);
    req.flash('success', 'Menu deleted.');
    res.redirect('/admin/menus');
  } catch (err) {
    next(err);
  }
});

router.post('/menus/:id/items', async (req, res, next) => {
  try {
    const result = await menusLib.addItem(req.store.id, req.params.id, req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, id: result.id });
  } catch (err) {
    next(err);
  }
});

router.post('/menus/:id/items/structure', async (req, res, next) => {
  try {
    const result = await menusLib.saveStructure(req.store.id, req.params.id, req.body.structure);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/menus/:id/items/:itemId', async (req, res, next) => {
  try {
    const result = await menusLib.updateItem(req.store.id, req.params.id, req.params.itemId, req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/menus/:id/items/:itemId/delete', async (req, res, next) => {
  try {
    await menusLib.deleteItem(req.store.id, req.params.id, req.params.itemId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Media Library ----------
// Every uploaded file belongs to exactly one store (lib/media.js's
// pz_media table, store_id-scoped the same way products/categories are),
// stored on disk under public/uploads/store-<id>/. This section covers
// both the standalone Library page and the JSON endpoints the reusable
// media picker (public/js/media-picker.js) calls from wherever an image/
// file field needs it — the product form, the section builder, etc.

router.get('/media', async (req, res, next) => {
  try {
    const { rows, total } = await mediaLib.listMedia(req.store.id, { limit: 100 });
    res.render('admin/media', { title: 'Media', files: rows, total });
  } catch (err) {
    next(err);
  }
});

// JSON listing for the picker modal — same data as the page above, paged,
// so a store with a very large library doesn't have to load it all into
// the picker at once. Kept as a separate route (rather than content-
// negotiating on /media) so it's obvious at a glance which requests are
// page loads and which are the picker's own fetches.
router.get('/media/list', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows, total } = await mediaLib.listMedia(req.store.id, { limit, offset });
    res.json({ ok: true, files: rows, total });
  } catch (err) {
    next(err);
  }
});

router.post('/media/upload', (req, res, next) => {
  mediaLib.upload.array('files', mediaLib.MAX_FILES_PER_UPLOAD)(req, res, async (err) => {
    if (err) {
      // multer's own errors (file too large, too many files) and our
      // fileFilter's UNSUPPORTED_FILE_TYPE both land here — surfaced the
      // same way whether the request came from the full Library page
      // (flash + redirect) or the picker's fetch() (JSON, so the modal can
      // show the error without navigating away).
      const message = err.message === 'UNSUPPORTED_FILE_TYPE'
        ? 'Unsupported file type — images (JPG, PNG, WEBP, GIF, SVG), video (MP4, WEBM), and PDF only.'
        : err.code === 'LIMIT_FILE_SIZE'
          ? `That file is over the ${Math.round(mediaLib.MAX_FILE_SIZE / (1024 * 1024))}MB limit.`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `You can upload up to ${mediaLib.MAX_FILES_PER_UPLOAD} files at once.`
            : 'Upload failed.';
      if (req.get('accept') === 'application/json' || req.xhr) {
        return res.status(400).json({ ok: false, error: message });
      }
      req.flash('error', message);
      return res.redirect('/admin/media');
    }
    try {
      const files = req.files || [];
      const saved = [];
      for (const file of files) {
        saved.push(await mediaLib.recordUpload(req.store.id, req.session.admin && req.session.admin.id, file));
      }
      if (req.get('accept') === 'application/json' || req.xhr) {
        return res.json({ ok: true, files: saved });
      }
      req.flash('success', `${saved.length} file${saved.length === 1 ? '' : 's'} uploaded.`);
      res.redirect('/admin/media');
    } catch (e) {
      next(e);
    }
  });
});

router.post('/media/:id/delete', async (req, res, next) => {
  try {
    const ok = await mediaLib.deleteMedia(req.store.id, req.params.id);
    if (req.get('accept') === 'application/json' || req.xhr) {
      return res.json({ ok });
    }
    req.flash(ok ? 'success' : 'error', ok ? 'File deleted.' : 'File not found.');
    res.redirect('/admin/media');
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
      `SELECT st.id AS store_theme_id, st.is_active, t.id AS theme_id, t.slug, t.name, t.description, t.price_cents
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
    // "View demo" on each theme card — opens that theme's OWN dedicated
    // demo store (pz_themes.demo_store_id), built with content tailored to
    // that theme's sections and design, instead of this merchant's own
    // (possibly empty) store. "Import demo content" (routes below) copies
    // that same demo store's catalog/pages/sections into THIS store. Not
    // every catalog theme has a demo configured yet, so both demoThemeUrl
    // and hasDemo(slug) come back false/null when there's nothing there —
    // the view hides both actions in that case.
    const [demoStores] = await pool.query(
      `SELECT t.slug, s.id AS demo_store_id, s.subdomain
       FROM ${TABLES.themes} t
       JOIN ${TABLES.stores} s ON s.id = t.demo_store_id
       WHERE t.demo_store_id IS NOT NULL`
    );
    const demoUrlBySlug = new Map(demoStores.map((d) => [d.slug, storeUrl(req, d.subdomain, '/')]));
    const demoSlugs = new Set(demoStores.map((d) => d.slug));
    const demoStoreIds = new Set(demoStores.map((d) => d.demo_store_id));
    const demoThemeUrl = (slug) => demoUrlBySlug.get(slug) || null;
    const withSwatch = (t) => {
      const tokens = themeDefaultTokens(t.slug);
      return { ...t, swatchFrom: tokens.color_primary, swatchTo: tokens.color_primary_dark, hasDemo: demoSlugs.has(t.slug) };
    };
    res.render('admin/store-themes', {
      title: 'Themes',
      themes: installed.map(withSwatch),
      available: available.map(withSwatch),
      demoThemeUrl,
      isDemoStore: demoStoreIds.has(req.store.id),
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

// "Import demo content" — installs the theme if it isn't already, activates
// it, and copies its dedicated demo store's categories/products/pages/menus
// /sections into THIS store (see lib/demoImport.js). Unlike a plain
// install/activate, this overwrites the store's Home page, header and
// footer content — the confirm() dialog on the button is what stands in
// for the merchant's go-ahead on that, same pattern as "Activate theme"
// below already uses for its own, smaller warning.
router.post('/store/themes/import-demo', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const themeId = Number(req.body.themeId);
    const [[theme]] = await pool.query(
      `SELECT id, name, demo_store_id FROM ${TABLES.themes} WHERE id = ? AND status = 'published'`,
      [themeId]
    );
    if (!theme) {
      req.flash('error', 'Theme not found.');
      return res.redirect('/admin/store/themes');
    }
    if (!theme.demo_store_id) {
      req.flash('error', `${theme.name} doesn't have demo content to import yet.`);
      return res.redirect('/admin/store/themes');
    }
    if (theme.demo_store_id === req.store.id) {
      req.flash('error', "This store is itself a demo store — nothing to import.");
      return res.redirect('/admin/store/themes');
    }

    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO ${TABLES.storeThemes} (store_id, theme_id, is_active) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE store_id = store_id`,
      [req.store.id, theme.id]
    );
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ? AND theme_id != ?`, [req.store.id, theme.id]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 1 WHERE store_id = ? AND theme_id = ?`, [req.store.id, theme.id]);
    await conn.commit();

    const result = await importDemoContent(pool, { demoStoreId: theme.demo_store_id, targetStoreId: req.store.id });
    req.flash(
      'success',
      `${theme.name} is active with its demo content — ${result.productsAdded} product(s) and ${result.categoriesAdded} categor${result.categoriesAdded === 1 ? 'y' : 'ies'} added, ${result.pagesTouched} page(s) updated.`
    );
    res.redirect('/admin/store/themes');
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection may already be past the transaction */ }
    next(err);
  } finally {
    conn.release();
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
router.get('/apps', async (req, res, next) => {
  try {
    const apps = await listAppsForStore(req.store.id, req.store.plan);
    res.render('admin/apps', { title: 'Apps', apps });
  } catch (err) {
    next(err);
  }
});

router.post('/apps/:slug/activate', async (req, res, next) => {
  try {
    const [[app]] = await pool.query(`SELECT * FROM ${TABLES.apps} WHERE slug = ? AND status = 'published'`, [req.params.slug]);
    if (!app) {
      req.flash('error', 'App not found.');
      return res.redirect('/admin/apps');
    }
    await activateApp(req.store.id, app.id);
    req.flash('success', `${app.name} activated.`);
    res.redirect('/admin/apps');
  } catch (err) {
    next(err);
  }
});

// ---------- Contacts (CRM) ----------
// CRM moved to the account level (routes/platform.js's /dashboard/crm/*,
// lib/crm.js) — it now works across every store one login runs, not just
// this one, so it no longer lives nested in a single store's own /admin.
// Old links into this store's /admin/contacts still land somewhere useful
// instead of 404ing. router.use (not a '/contacts*' route) because Express
// 5's router no longer accepts a bare trailing '*' wildcard in a path
// string -- router.use already matches the prefix and everything under it.
router.use('/contacts', (req, res) => res.redirect(adminPortalUrl(req, '/dashboard/crm/leads')));

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
