const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool, TABLES } = require('../db/database');
const { getCartItems, getCartTotals, getStoreCart } = require('../middleware/cart');
const { requireCustomer } = require('../middleware/auth');
const { storeUrl } = require('../middleware/tenant');
const { DEFAULT_THEME_SLUG, themeViewPrefix } = require('../lib/themes');
const { resolveTokens, tokensToInlineStyle, themeDefaultTokens } = require('../lib/themeTokens');
const { readManifest } = require('../lib/themeManifest');
const menusLib = require('../lib/menus');
const metaobjectsLib = require('../lib/metaobjects');
const { createOrder, genOrderNumber } = require('../lib/orders');
const { sanitizeSubmission } = require('../lib/forms');
const { sanitizeContact } = require('../lib/contacts');
const mailerLib = require('../lib/mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toNumber(product) {
  return { ...product, price: Number(product.price), compare_at_price: product.compare_at_price !== null ? Number(product.compare_at_price) : null };
}

function orderToNumber(order) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    discount_amount: Number(order.discount_amount || 0),
    total: Number(order.total != null ? order.total : order.subtotal),
  };
}

// Everything in this router belongs to a specific store, resolved from the
// subdomain by middleware/tenant.js. On the root domain (or an unknown/
// suspended subdomain) there's no storefront to show.
router.use((req, res, next) => {
  if (req.store) return next();
  // No resolved store means no theme to look up either — fall back to the
  // built-in default theme's 404 page.
  if (req.unknownSubdomain) {
    return res.status(404).render(`${themeViewPrefix(DEFAULT_THEME_SLUG)}/404`, { title: 'Store not found' });
  }
  return res.status(404).render(`${themeViewPrefix(DEFAULT_THEME_SLUG)}/404`, { title: 'Page not found' });
});

// Resolves which structural theme is active for this store once per
// request, so every render() below points at that theme's chrome templates
// (views/storefront/themes/<slug>/...) instead of a fixed path. See
// lib/themes.js.
router.use(async (req, res, next) => {
  try {
    // Theme preview: ?preview_theme=<slug> lets whoever is signed into THIS
    // store's admin see any catalog theme applied — installed or not,
    // active or not — without writing anything to pz_store_themes. Only
    // honored when req.session.admin actually matches this store, so a
    // shared/guessable link can't be used to change what any other visitor
    // sees; everyone else still gets the real active-theme lookup below.
    // Uses the theme's own manifest defaults (never this store's saved
    // token_overrides, which belong to whichever theme is actually
    // installed) — a preview shows the theme as its author intended it.
    //
    // Public "View demo" links (routes/admin.js's /store/themes +
    // views/admin/store-themes.ejs) point at each theme's own dedicated
    // demo store (pz_themes.demo_store_id) running that theme for real, so
    // no query-param bypass is needed here for the public case.
    const previewSlug = typeof req.query.preview_theme === 'string' ? req.query.preview_theme.slice(0, 60) : null;
    const previewAsAdmin = !!(previewSlug && req.session.admin && req.session.admin.store_id === req.store.id);
    if (previewAsAdmin) {
      const manifest = readManifest(previewSlug);
      if (manifest) {
        req.themeViewPrefix = themeViewPrefix(previewSlug);
        res.locals.themeTokenStyle = tokensToInlineStyle(themeDefaultTokens(previewSlug));
        res.locals.previewingTheme = { slug: previewSlug, name: manifest.name || previewSlug };
        return next();
      }
    }

    const [[activeTheme]] = await pool.query(
      `SELECT t.slug, st.token_overrides FROM ${TABLES.storeThemes} st
       JOIN ${TABLES.themes} t ON t.id = st.theme_id
       WHERE st.store_id = ? AND st.is_active = 1
       LIMIT 1`,
      [req.store.id]
    );
    const activeSlug = activeTheme ? activeTheme.slug : DEFAULT_THEME_SLUG;
    req.themeViewPrefix = themeViewPrefix(activeSlug);
    const overrides = activeTheme && activeTheme.token_overrides
      ? (typeof activeTheme.token_overrides === 'string' ? JSON.parse(activeTheme.token_overrides) : activeTheme.token_overrides)
      : null;
    // Emitted on <body style="..."> by the theme's header partial — see
    // lib/themeTokens.js for why inline style is how a merchant's color/
    // radius customization wins over both the theme's own defaults and the
    // older pz_stores.theme preset class. resolveTokens reads this theme's
    // OWN defaults from its theme.json manifest, not a shared global one.
    res.locals.themeTokenStyle = tokensToInlineStyle(resolveTokens(overrides, activeSlug));
  } catch (err) {
    req.themeViewPrefix = themeViewPrefix(DEFAULT_THEME_SLUG);
    res.locals.themeTokenStyle = '';
  }
  next();
});

// Non-home published pages, made available to every view in this router so
// the header nav can link to them (see views/storefront/themes/default/partials/header.ejs).
router.use(async (req, res, next) => {
  try {
    const [pages] = await pool.query(
      `SELECT id, name, path FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 0 AND is_form = 0 AND status = 'published' ORDER BY name`,
      [req.store.id]
    );
    res.locals.storePages = pages;
  } catch (err) {
    res.locals.storePages = [];
  }
  next();
});

// This store's own forms (pz_forms), keyed by id, so a 'form' section (see
// lib/sections.js — it just stores a form_id) can render whichever form it
// points at without its own query per section. Same idea as storePages
// above, just keyed rather than listed since section.ejs looks one up by id
// instead of iterating all of them.
router.use(async (req, res, next) => {
  res.locals.storeForms = {};
  try {
    const [rows] = await pool.query(
      `SELECT id, name, slug, heading, subtext, button_label, success_message, fields FROM ${TABLES.forms} WHERE store_id = ?`,
      [req.store.id]
    );
    rows.forEach((f) => {
      res.locals.storeForms[f.id] = { ...f, fields: typeof f.fields === 'string' ? JSON.parse(f.fields) : f.fields };
    });
  } catch (err) {
    // leave storeForms empty -- a 'form' section with no match just renders
    // its "pick a form" placeholder instead of breaking the page
  }
  next();
});

// Turns a raw pz_page_sections row into the same shape the section/block
// partials already expect from renderStorePage below (parsed JSON columns,
// zeroed-out numeric defaults) — shared so the header/footer canvases render
// through the exact same section.ejs/block.ejs cases as the page body.
function toRenderSection(s) {
  return {
    id: s.id, type: s.type, fields: typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields,
    custom_class: s.custom_class || '', custom_css: s.custom_css || '', min_height: s.min_height || 0,
    hide_desktop: !!s.hide_desktop, hide_tablet: !!s.hide_tablet, hide_mobile: !!s.hide_mobile,
    margin_top: s.margin_top || 0, margin_bottom: s.margin_bottom || 0,
    margin_left: s.margin_left || 0, margin_right: s.margin_right || 0,
    padding_top: s.padding_top || 0, padding_bottom: s.padding_bottom || 0,
    padding_left: s.padding_left || 0, padding_right: s.padding_right || 0,
    element_styles: s.element_styles ? (typeof s.element_styles === 'string' ? JSON.parse(s.element_styles) : s.element_styles) : {},
    // Universal Style-tab controls (see lib/sections.js's sanitizeSectionSettings) —
    // '' (not null) so section.ejs's pzStyleAttrs can treat "no override" uniformly.
    text_color: s.text_color || '', bg_color: s.bg_color || '', text_align: s.text_align || '',
    bg_type: s.bg_type || '', bg_image_url: s.bg_image_url || '', bg_video_url: s.bg_video_url || '', bg_overlay: !!s.bg_overlay,
  };
}

// Resolves one region's ('header' or 'footer') rendered sections: a page's
// own override if it has one, otherwise the store's global header/footer —
// the same page_id-nullable fallback routes/admin.js's builder uses (see
// its scopeWhere/mountSectionRoutes). pageId is omitted for routes with no
// CMS page behind them (cart, checkout, account, product detail, 404),
// which always get the store's global layout.
async function resolveRegionSections(storeId, pageId, region) {
  let rows = [];
  if (pageId) {
    [rows] = await pool.query(
      `SELECT * FROM ${TABLES.pageSections} WHERE store_id = ? AND page_id = ? AND region = ? AND hidden = 0 ORDER BY position ASC`,
      [storeId, pageId, region]
    );
  }
  if (!rows.length) {
    [rows] = await pool.query(
      `SELECT * FROM ${TABLES.pageSections} WHERE store_id = ? AND page_id IS NULL AND region = ? AND hidden = 0 ORDER BY position ASC`,
      [storeId, region]
    );
  }
  return rows.map(toRenderSection);
}

// A nav_menu section (header or footer) points at a saved menu by id
// (lib/menus.js) instead of storing its own links — resolve every menu
// actually referenced by THIS request's header/footer sections once here
// (not once per section, since a header and footer commonly point at the
// same menu), so section.ejs/block.ejs's 'nav_menu' case can just look up
// the ready { label, url, children } tree instead of hitting the database
// mid-render. An id with nothing left to resolve to (menu deleted, or
// never picked) simply has no entry — the partial treats that as no menu.
async function loadResolvedMenus(storeId, sections) {
  const menuIds = [...new Set(
    sections.filter((s) => s.type === 'nav_menu' && s.fields && s.fields.menu_id).map((s) => s.fields.menu_id)
  )];
  const resolvedMenus = {};
  await Promise.all(menuIds.map(async (id) => {
    resolvedMenus[id] = await menusLib.resolveMenu(storeId, id);
  }));
  return resolvedMenus;
}

// Store-wide header/footer, available to every view in this router — every
// theme's header.ejs/footer.ejs partial loops over these instead of the old
// hardcoded markup (see views/storefront/themes/*/partials/header.ejs).
// Routes rendering an actual CMS page (renderStorePage below) re-resolve
// these with that page's id afterward, picking up its per-page override
// when it has one.
router.use(async (req, res, next) => {
  try {
    const [headerSections, footerSections] = await Promise.all([
      resolveRegionSections(req.store.id, null, 'header'),
      resolveRegionSections(req.store.id, null, 'footer'),
    ]);
    res.locals.headerSections = headerSections;
    res.locals.footerSections = footerSections;
    res.locals.resolvedMenus = await loadResolvedMenus(req.store.id, [...headerSections, ...footerSections]);
  } catch (err) {
    res.locals.headerSections = [];
    res.locals.footerSections = [];
    res.locals.resolvedMenus = {};
  }
  next();
});

// Renders any page (home or a custom one) by loading its sections from the
// builder and, if one of those sections is a product grid, fetching the
// products it needs. Shared by the "/" route and "/pages/:slug" below so
// both go through the exact same rendering logic.
async function renderStorePage(req, res, next, page) {
  try {
    const storeId = req.store.id;
    const { category, q } = req.query;

    // region = 'body' excludes this page's own header/footer OVERRIDE rows
    // (same page_id, region IN ('header','footer') — see resolveRegionSections
    // above) from its body content; ordinary page sections are always
    // region = 'body' (see db/database.js's migrateHeaderFooterSections).
    const [rawSections] = await pool.query(
      `SELECT * FROM ${TABLES.pageSections} WHERE page_id = ? AND region = 'body' AND hidden = 0 ORDER BY position ASC`,
      [page.id]
    );
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]);

    // Picks up this page's own header/footer override, falling back to the
    // store's global layout — replaces the store-wide default the earlier
    // middleware set for every route in this router.
    const [headerSections, footerSections] = await Promise.all([
      resolveRegionSections(storeId, page.id, 'header'),
      resolveRegionSections(storeId, page.id, 'footer'),
    ]);
    res.locals.headerSections = headerSections;
    res.locals.footerSections = footerSections;
    // Re-resolve for THIS page's own header/footer (it may override with a
    // different menu than the store-wide default the earlier middleware
    // already resolved).
    res.locals.resolvedMenus = await loadResolvedMenus(storeId, [...headerSections, ...footerSections]);

    // ?q= comes from the optional search box a nav_menu section can turn on
    // (show_search — see partials/section.ejs's 'nav_menu' case); a plain
    // title match against this store's own catalog, same scoping as the
    // category filter below.
    const searchQuery = typeof q === 'string' ? q.trim().slice(0, 200) : '';
    res.locals.searchQuery = searchQuery;

    const needsProducts = rawSections.some((s) => s.type === 'products');
    let allProducts = [];
    if (needsProducts) {
      if (searchQuery) {
        [allProducts] = await pool.query(
          `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' AND title LIKE ? ORDER BY created_at DESC`,
          [storeId, `%${searchQuery}%`]
        );
      } else if (category) {
        [allProducts] = await pool.query(
          `SELECT DISTINCT p.* FROM ${TABLES.products} p
           JOIN ${TABLES.productCategories} pc ON pc.product_id = p.id
           JOIN ${TABLES.categories} c ON c.id = pc.category_id
           WHERE p.store_id = ? AND c.name = ? AND p.status = 'active'
           ORDER BY p.created_at DESC`,
          [storeId, category]
        );
      } else {
        [allProducts] = await pool.query(
          `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' ORDER BY created_at DESC`,
          [storeId]
        );
      }
      allProducts = allProducts.map(toNumber);
    }

    // "Product spotlight" sections each point at one specific product by id
    // (chosen in the builder) — fetched fresh here so price/stock/image are
    // always current, never a stale copy from when the section was set up.
    const spotlightIds = [...new Set(
      rawSections.filter((s) => s.type === 'spotlight')
        .map((s) => (typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields).product_id)
        .filter((id) => Number.isFinite(id) && id > 0)
    )];
    let spotlightProducts = {};
    if (spotlightIds.length) {
      const [rows] = await pool.query(
        `SELECT * FROM ${TABLES.products} WHERE store_id = ? AND status = 'active' AND id IN (?)`,
        [storeId, spotlightIds]
      );
      rows.forEach((p) => { spotlightProducts[p.id] = toNumber(p); });
    }

    // "Metaobject list" sections each point at one of this store's own
    // metaobject types (definition_id, chosen in the builder — see
    // lib/metaobjects.js) — fetched fresh here, grouped by definition so a
    // page with more than one metaobject section (e.g. Properties AND
    // Agents) only queries each type once.
    const listingDefinitionIds = [...new Set(
      rawSections.filter((s) => s.type === 'listings')
        .map((s) => (typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields).definition_id)
        .filter((id) => Number.isFinite(id) && id > 0)
    )];
    let listingEntriesByDefinition = {};
    let listingDefinitionsById = {};
    if (listingDefinitionIds.length) {
      const [entryRows] = await pool.query(
        `SELECT * FROM ${TABLES.listings} WHERE store_id = ? AND status = 'active' AND definition_id IN (?) ORDER BY created_at DESC`,
        [storeId, listingDefinitionIds]
      );
      entryRows.forEach((entry) => {
        if (!listingEntriesByDefinition[entry.definition_id]) listingEntriesByDefinition[entry.definition_id] = [];
        listingEntriesByDefinition[entry.definition_id].push(entry);
      });
      const [defRows] = await pool.query(
        `SELECT * FROM ${TABLES.metaobjectDefinitions} WHERE store_id = ? AND id IN (?)`,
        [storeId, listingDefinitionIds]
      );
      defRows.forEach((d) => { listingDefinitionsById[d.id] = d; });
    }

    const sections = rawSections.map((s) => {
      const fields = typeof s.fields === 'string' ? JSON.parse(s.fields) : s.fields;
      const section = {
        id: s.id, type: s.type, fields,
        custom_class: s.custom_class || '', custom_css: s.custom_css || '', min_height: s.min_height || 0,
        hide_desktop: !!s.hide_desktop, hide_tablet: !!s.hide_tablet, hide_mobile: !!s.hide_mobile,
        margin_top: s.margin_top || 0, margin_bottom: s.margin_bottom || 0,
        margin_left: s.margin_left || 0, margin_right: s.margin_right || 0,
        padding_top: s.padding_top || 0, padding_bottom: s.padding_bottom || 0,
        padding_left: s.padding_left || 0, padding_right: s.padding_right || 0,
        element_styles: s.element_styles ? (typeof s.element_styles === 'string' ? JSON.parse(s.element_styles) : s.element_styles) : {},
        text_color: s.text_color || '', bg_color: s.bg_color || '', text_align: s.text_align || '',
        bg_type: s.bg_type || '', bg_image_url: s.bg_image_url || '', bg_video_url: s.bg_video_url || '', bg_overlay: !!s.bg_overlay,
      };
      if (s.type === 'products') {
        section.products = allProducts.slice(0, fields.limit || 12);
      }
      if (s.type === 'spotlight') {
        section.product = fields.product_id ? (spotlightProducts[fields.product_id] || null) : null;
      }
      if (s.type === 'listings') {
        const def = fields.definition_id ? listingDefinitionsById[fields.definition_id] : null;
        section.definition = def || null;
        section.entries = def ? (listingEntriesByDefinition[def.id] || []).slice(0, fields.limit || 12) : [];
      }
      return section;
    });

    res.render(`${req.themeViewPrefix}/page`, {
      title: page.is_home ? `Shop ${req.store.name}` : `${page.name} · ${req.store.name}`,
      sections,
      categories,
      activeCategory: category || null,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- Store home / custom pages ----------
// A store's own subdomain shows its Home page at "/"; "/store" is kept as
// an alias so older links (and the demo store link on the marketing page)
// keep working.
router.get(['/', '/store'], async (req, res, next) => {
  try {
    const [[home]] = await pool.query(`SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 1 LIMIT 1`, [req.store.id]);
    if (!home) return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Page not found' });
    return renderStorePage(req, res, next, home);
  } catch (err) {
    next(err);
  }
});

// Extra pages built with the page builder, e.g. "/pages/about-us".
router.get('/pages/:slug', async (req, res, next) => {
  try {
    const path = `/${req.params.slug}`;
    const [[page]] = await pool.query(
      `SELECT * FROM ${TABLES.pages} WHERE store_id = ? AND path = ? AND status = 'published' LIMIT 1`,
      [req.store.id, path]
    );
    if (!page) return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Page not found' });
    return renderStorePage(req, res, next, page);
  } catch (err) {
    next(err);
  }
});

// Standalone forms built on the Forms screen (see routes/admin.js's
// /admin/forms routes and pz_forms) — not a pz_pages row at all, so this
// renders the theme's own page wrapper (header/footer/tokens — all already
// set by this router's earlier middleware) around one synthetic 'form'
// section, the exact same way views/storefront/partials/section.ejs renders
// a 'form' section anywhere else. Gives every form a real, themed URL at
// /forms/<slug> without needing a page to exist behind it.
router.get('/forms/:slug', async (req, res, next) => {
  try {
    const [[form]] = await pool.query(
      `SELECT * FROM ${TABLES.forms} WHERE store_id = ? AND slug = ? LIMIT 1`,
      [req.store.id, req.params.slug]
    );
    if (!form) return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Page not found' });
    const [categories] = await pool.query(`SELECT * FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [req.store.id]);
    const section = {
      id: 0, type: 'form', fields: { form_id: form.id },
      custom_class: '', custom_css: '', min_height: 0,
      hide_desktop: false, hide_tablet: false, hide_mobile: false,
      margin_top: 0, margin_bottom: 0, margin_left: 0, margin_right: 0,
      padding_top: 0, padding_bottom: 0, padding_left: 0, padding_right: 0,
      element_styles: {}, text_color: '', bg_color: '', text_align: '',
      bg_type: '', bg_image_url: '', bg_video_url: '', bg_overlay: false,
    };
    res.render(`${req.themeViewPrefix}/page`, {
      title: `${form.name} · ${req.store.name}`,
      sections: [section],
      categories,
      activeCategory: null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Newsletter ----------
router.post('/newsletter', async (req, res) => {
  const email = (req.body.email || '').trim();
  if (email) {
    try {
      await pool.query(`INSERT IGNORE INTO ${TABLES.newsletterSubscribers} (store_id, email) VALUES (?, ?)`, [req.store.id, email]);
    } catch (err) {
      // swallow — subscribing shouldn't be able to break the page
    }
  }
  req.flash('success', 'Thanks for subscribing!');
  res.redirect(req.get('Referer') || '/');
});

// Every form's (pz_forms) submit target, whether it came from its own
// standalone page (/forms/<slug>) or an embedded page-builder 'form'
// section (see views/storefront/partials/section.ejs's 'form' case).
//
// Every submission is kept in full in pz_form_submissions regardless of
// what fields the form has. On top of that, since nothing about a form's
// fields is locked anymore, a submission only creates/updates a pz_contacts
// row (source 'contact_form', so it shows up in the CRM's Leads screen like
// any other) when the form actually has a phone-type field with a value --
// sanitizeSubmission (lib/forms.js) finds that by field TYPE, not a fixed
// key. A form built without a phone field (a feedback form, an RSVP with no
// callback needed, etc.) still saves every submission, it just doesn't
// create a lead. Deliberately tolerant of a missing/deleted section_id (SET
// NULL on the FK) and of a contact-creation failure not blocking the raw
// submission from being kept.
// Emails every admin on the store when a form comes in, using whatever SMTP
// server is configured in Platform Admin > Settings (lib/settings.js /
// lib/mailer.js) -- if nothing is configured there (or in the SMTP_* env
// vars) sendMail() throws, which the caller below catches and logs. A form
// submission is never lost or blocked by this: it's already saved to
// pz_form_submissions before this runs, and this call is fire-and-forget so
// a slow or unreachable mail server can't hang the visitor's redirect.
async function notifyFormSubmission(store, form, fields, data) {
  const [admins] = await pool.query(
    `SELECT u.email FROM ${TABLES.userRoles} ur
     JOIN ${TABLES.users} u ON u.id = ur.user_id
     WHERE ur.store_id = ? AND ur.role = 'admin'`,
    [store.id]
  );
  const to = admins.map((a) => a.email).filter(Boolean);
  if (!to.length) return;

  const rows = fields.map((f) => {
    const raw = data[f.key];
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    return { label: f.label, value: value || '—' };
  });

  const text = [
    `New submission on "${form.name}" (${store.name})`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
  ].join('\n');

  const html = `
    <p>New submission on <strong>${escapeHtml(form.name)}</strong> (${escapeHtml(store.name)})</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
      ${rows.map((r) => `
        <tr>
          <td style="border:1px solid #e5e7eb;font-weight:600;">${escapeHtml(r.label)}</td>
          <td style="border:1px solid #e5e7eb;">${escapeHtml(r.value)}</td>
        </tr>`).join('')}
    </table>
  `;

  // A visitor's own email (if the form collected one) goes on Reply-To, so
  // hitting "Reply" on the notification answers the lead directly -- the
  // From address stays the platform's authenticated sender either way.
  const emailField = fields.find((f) => f.type === 'email');
  const replyTo = emailField && data[emailField.key] ? data[emailField.key] : undefined;

  await mailerLib.sendMail({
    to: to.join(', '),
    subject: `New submission: ${form.name} — ${store.name}`,
    text,
    html,
    fromName: `${store.name} via PageZaper`,
    replyTo,
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

router.post('/forms/submit', async (req, res) => {
  const formId = Number(req.body.form_id) || null;
  const sectionId = Number(req.body.section_id) || null;
  if (!formId) {
    req.flash('error', 'Something went wrong — please try again.');
    return res.redirect(req.get('Referer') || '/');
  }

  try {
    const [[form]] = await pool.query(`SELECT * FROM ${TABLES.forms} WHERE store_id = ? AND id = ? LIMIT 1`, [req.store.id, formId]);
    if (!form) {
      req.flash('error', 'Something went wrong — please try again.');
      return res.redirect(req.get('Referer') || '/');
    }
    const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
    const { name, phone, email, data } = sanitizeSubmission(fields, req.body);

    const missingRequired = fields.some((f) => f.required && (Array.isArray(data[f.key]) ? data[f.key].length === 0 : !data[f.key]));
    if (missingRequired) {
      req.flash('error', 'Please fill in the required fields.');
      return res.redirect(req.get('Referer') || '/');
    }

    let contactId = null;
    if (phone) {
      const contact = sanitizeContact({ name, phone, email, source: 'contact_form', tags: form.name });
      try {
        const [[existing]] = await pool.query(
          `SELECT id FROM ${TABLES.contacts} WHERE store_id = ? AND phone = ? LIMIT 1`,
          [req.store.id, contact.phone]
        );
        if (existing) {
          contactId = existing.id;
        } else {
          const [result] = await pool.query(
            `INSERT INTO ${TABLES.contacts} (store_id, name, email, phone, source, tags) VALUES (?, ?, ?, ?, ?, ?)`,
            [req.store.id, contact.name, contact.email || '', contact.phone, contact.source, JSON.stringify(contact.tags)]
          );
          contactId = result.insertId;
        }
      } catch (contactErr) {
        // Keep the raw submission even if contact creation fails for some
        // reason -- a lead's answer shouldn't vanish over a CRM-side error.
        console.error('Form submission: contact creation failed:', contactErr);
      }
    }

    await pool.query(
      `INSERT INTO ${TABLES.formSubmissions} (store_id, form_id, section_id, data, contact_id) VALUES (?, ?, ?, ?, ?)`,
      [req.store.id, formId, sectionId, JSON.stringify(data), contactId]
    );

    notifyFormSubmission(req.store, form, fields, data).catch((mailErr) => {
      // Not configured yet, or the mail server rejected/timed out -- either
      // way the submission itself is already saved above, so just log it.
      console.error('Form submission notification email failed:', mailErr.message);
    });

    req.flash('success', form.success_message || "Thanks — we'll be in touch shortly.");
  } catch (err) {
    console.error('Form submission failed:', err);
    req.flash('error', 'Something went wrong — please try again.');
  }
  res.redirect(req.get('Referer') || '/');
});

// ---------- Product detail ----------
router.get('/products/:slug', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND slug = ?`, [storeId, req.params.slug]);
    if (!product) {
      return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Product not found' });
    }
    // "Related" = shares at least one category with this product (any of
    // them, not just its first/legacy one) -- falls back to an empty list
    // for a product with no categories at all rather than matching
    // everything, same as before this was many-to-many.
    const [related] = await pool.query(
      `SELECT DISTINCT p.* FROM ${TABLES.products} p
       JOIN ${TABLES.productCategories} pc ON pc.product_id = p.id
       WHERE p.store_id = ?
         AND p.id != ?
         AND p.status = 'active'
         AND pc.category_id IN (SELECT category_id FROM ${TABLES.productCategories} WHERE product_id = ?)
       LIMIT 4`,
      [storeId, product.id, product.id]
    );

    res.render(`${req.themeViewPrefix}/product`, {
      title: product.title,
      product: toNumber(product),
      related: related.map(toNumber),
      // Absolute URL (not a relative /products/<slug>) since this is meant
      // to be dropped straight into a WhatsApp message -- see the "Chat to
      // order on WhatsApp" button in each theme's product.ejs.
      productUrl: storeUrl(req, req.store.subdomain, `/products/${product.slug}`),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Blog ----------
router.get('/blog', async (req, res, next) => {
  try {
    const [posts] = await pool.query(
      `SELECT * FROM ${TABLES.blogPosts} WHERE store_id = ? AND status = 'published' ORDER BY published_at DESC`,
      [req.store.id]
    );
    // Just "Blog" -- the theme's own header partial already appends
    // " · <store name>" itself (see partials/header.ejs's <title> tag), same
    // as the product detail route below does with product.title.
    res.render(`${req.themeViewPrefix}/blog`, {
      title: 'Blog',
      posts,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/blog/:slug', async (req, res, next) => {
  try {
    const [[post]] = await pool.query(
      `SELECT * FROM ${TABLES.blogPosts} WHERE store_id = ? AND slug = ? AND status = 'published'`,
      [req.store.id, req.params.slug]
    );
    if (!post) {
      return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Post not found' });
    }
    res.render(`${req.themeViewPrefix}/blog-post`, {
      title: post.title,
      post,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Customer accounts ----------
// Separate from admin/staff logins entirely (pz_customers, not pz_users) —
// scoped to this one store, same as an order or a product. req.session.customer
// mirrors req.session.admin's shape/security pattern: a single object
// checked against req.store.id on every request, since the session cookie
// is shared across every *.pagezaper.com subdomain.
router.get('/account/signup', (req, res) => {
  if (req.session.customer && req.session.customer.store_id === req.store.id) return res.redirect('/account');
  res.render(`${req.themeViewPrefix}/account/signup`, { title: 'Create account', errors: [], values: { name: '', email: '' } });
});

router.post('/account/signup', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const confirmPassword = req.body.confirmPassword || '';
    const values = { name, email };
    const errors = [];

    if (!name) errors.push('Name is required.');
    if (!email || !EMAIL_RE.test(email)) errors.push('A valid email address is required.');
    if (!password || password.length < 6) errors.push('Password must be at least 6 characters.');
    if (password !== confirmPassword) errors.push('Passwords do not match.');

    if (errors.length) {
      return res.status(400).render(`${req.themeViewPrefix}/account/signup`, { title: 'Create account', errors, values });
    }

    const [[existing]] = await pool.query(`SELECT id FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`, [storeId, email]);
    if (existing) {
      return res.status(400).render(`${req.themeViewPrefix}/account/signup`, {
        title: 'Create account',
        errors: [`An account with ${email} already exists — log in instead.`],
        values,
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const [result] = await pool.query(
      `INSERT INTO ${TABLES.customers} (store_id, name, email, password_hash) VALUES (?, ?, ?, ?)`,
      [storeId, name, email, passwordHash]
    );

    req.session.customer = { id: result.insertId, name, email, store_id: storeId };
    req.flash('success', `Welcome, ${name}!`);
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});

router.get('/account/login', (req, res) => {
  if (req.session.customer && req.session.customer.store_id === req.store.id) return res.redirect('/account');
  res.render(`${req.themeViewPrefix}/account/login`, { title: 'Log in' });
});

router.post('/account/login', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    const [[customer]] = await pool.query(`SELECT * FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`, [storeId, email]);
    if (!customer) {
      req.flash('error', 'No account found with that email.');
      return res.redirect('/account/login');
    }
    if (!bcrypt.compareSync(password, customer.password_hash)) {
      req.flash('error', 'Incorrect password.');
      return res.redirect('/account/login');
    }

    req.session.customer = { id: customer.id, name: customer.name, email: customer.email, store_id: storeId };
    res.redirect('/account');
  } catch (err) {
    next(err);
  }
});

router.post('/account/logout', (req, res) => {
  req.session.customer = null;
  res.redirect('/');
});

router.get('/account', requireCustomer, async (req, res, next) => {
  try {
    const [orders] = await pool.query(
      `SELECT * FROM ${TABLES.orders} WHERE store_id = ? AND customer_id = ? ORDER BY created_at DESC`,
      [req.store.id, req.session.customer.id]
    );
    res.render(`${req.themeViewPrefix}/account/dashboard`, {
      title: 'My Account',
      orders: orders.map(orderToNumber),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Cart ----------
router.get('/cart', async (req, res, next) => {
  try {
    const cart = getStoreCart(req, req.store.id);
    const items = await getCartItems(pool, req.store.id, cart);
    const { subtotal } = getCartTotals(items);
    res.render(`${req.themeViewPrefix}/cart`, { title: 'Your Cart', items, subtotal });
  } catch (err) {
    next(err);
  }
});

router.post('/cart/add', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { productId, quantity } = req.body;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [storeId, productId]);

    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('back');
    }

    const cart = getStoreCart(req, storeId);
    const current = cart[productId] || 0;
    const newQty = Math.min(current + qty, product.stock);
    cart[productId] = newQty;

    req.flash('success', `${product.title} added to cart.`);
    res.redirect(req.body.redirectTo || '/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/update', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const { productId, quantity } = req.body;
    const qty = parseInt(quantity, 10);
    const cart = getStoreCart(req, storeId);

    if (!qty || qty <= 0) {
      delete cart[productId];
    } else {
      const [[product]] = await pool.query(`SELECT * FROM ${TABLES.products} WHERE store_id = ? AND id = ?`, [storeId, productId]);
      cart[productId] = product ? Math.min(qty, product.stock) : qty;
    }

    res.redirect('/cart');
  } catch (err) {
    next(err);
  }
});

router.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  const cart = getStoreCart(req, req.store.id);
  delete cart[productId];
  res.redirect('/cart');
});

// Looks up an active discount code for this store and computes how much it
// takes off a given subtotal. Returns null (no discount) if the code is
// missing, unknown, or inactive — checkout just proceeds at full price.
async function resolveDiscount(storeId, code, subtotal) {
  if (!code || !code.trim()) return null;
  const [[discount]] = await pool.query(
    `SELECT * FROM ${TABLES.discounts} WHERE store_id = ? AND code = ? AND active = 1`,
    [storeId, code.trim().toUpperCase()]
  );
  if (!discount) return null;

  const value = Number(discount.value);
  const amount = discount.type === 'percent' ? (subtotal * value) / 100 : value;
  return {
    code: discount.code,
    amount: Math.min(Math.round(amount * 100) / 100, subtotal),
  };
}

// ---------- Checkout ----------
router.get('/checkout', async (req, res, next) => {
  try {
    const cart = getStoreCart(req, req.store.id);
    const items = await getCartItems(pool, req.store.id, cart);
    if (items.length === 0) {
      req.flash('error', 'Your cart is empty.');
      return res.redirect('/cart');
    }
    const { subtotal } = getCartTotals(items);
    res.render(`${req.themeViewPrefix}/checkout`, { title: 'Checkout', items, subtotal });
  } catch (err) {
    next(err);
  }
});

router.post('/checkout', async (req, res, next) => {
  const storeId = req.store.id;
  const conn = await pool.getConnection();
  try {
    const cart = getStoreCart(req, storeId);
    const items = await getCartItems(pool, storeId, cart);
    if (items.length === 0) {
      req.flash('error', 'Your cart is empty.');
      conn.release();
      return res.redirect('/cart');
    }

    const { name, email, phone, address, city, zip, discountCode } = req.body;
    if (!name || !email || !address) {
      req.flash('error', 'Please fill in all required fields.');
      conn.release();
      return res.redirect('/checkout');
    }

    const { subtotal } = getCartTotals(items);
    const discount = await resolveDiscount(storeId, discountCode, subtotal);
    const discountAmount = discount ? discount.amount : 0;
    const total = Math.round((subtotal - discountAmount) * 100) / 100;
    const orderNumber = genOrderNumber();

    await conn.beginTransaction();

    // Link to the logged-in customer account for THIS store, if any — guest
    // checkout (no account) still works fine and just leaves this null.
    const customerId = (req.session.customer && req.session.customer.store_id === storeId) ? req.session.customer.id : null;

    await createOrder(conn, {
      storeId,
      customerId,
      orderNumber,
      customerName: name,
      customerEmail: email,
      customerPhone: phone || null,
      shippingAddress: address,
      shippingCity: city || null,
      shippingZip: zip || null,
      subtotal,
      discountCode: discount ? discount.code : null,
      discountAmount,
      total,
      status: 'pending',
      paymentMethod: 'cod',
      source: 'storefront',
      items,
    });

    await conn.commit();
    req.session.carts[storeId] = {};

    res.render(`${req.themeViewPrefix}/order-confirmation`, {
      title: 'Order Confirmed',
      orderNumber,
      name,
      email,
      subtotal,
      discountCode: discount ? discount.code : null,
      discountAmount,
      total,
      items,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------- Metaobject entry detail (e.g. "/property/123-main-st") ----------
// A true catch-all on the URL shape (any /<segment>/<segment>), registered
// last so every literal-prefix route above (/products/:slug, /blog/:slug,
// /account/*, ...) always matches first — Express tries routes in
// registration order, and none of those can ever reach here for their own
// prefixes. <handle> is looked up as a metaobject definition's handle at
// request time rather than needing its own route per store; a handle that
// doesn't resolve to one just falls through to next() (there is no other
// content beyond this route, so that lands on the 404 handler in
// server.js), same as any other unmatched path.
router.get('/:handle/:slug', async (req, res, next) => {
  try {
    const storeId = req.store.id;
    const definition = await metaobjectsLib.getDefinitionByHandle(storeId, req.params.handle);
    if (!definition) return next();
    const entry = await metaobjectsLib.getEntryBySlug(storeId, definition.id, req.params.slug);
    if (!entry || entry.status !== 'active') {
      return res.status(404).render(`${req.themeViewPrefix}/404`, { title: 'Not found' });
    }
    const fields = await metaobjectsLib.listFields(definition.id);
    res.render(`${req.themeViewPrefix}/listing`, {
      title: `${entry.title} · ${req.store.name}`,
      definition,
      entry,
      fields,
      values: entry.details || {},
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
