require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'pagezaper_user',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pagezaper',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

const THEMES = ['default', 'gold', 'red'];
// Plan tiers a store can be on. No billing is wired up yet (every store
// signs up on 'free') — the platform admin can move a store between these
// by hand from /platform-admin/stores/:id until Razorpay billing exists.
const PLANS = ['free', 'starter', 'pro'];
const RESERVED_SUBDOMAINS = new Set([
  'www', 'admin', 'api', 'app', 'mail', 'ftp', 'blog', 'help', 'support',
  'static', 'cdn', 'assets', 'shop', 'store', 'dashboard', 'signup', 'login',
  'signin', 'signout', 'register', 'test', 'staging', 'dev', 'my', 'account',
  'billing', 'docs', 'status', 'pagezaper',
  // The (future) public theme and app marketplaces — see
  // middleware/tenant.js's isThemeMarketplace/isAppMarketplace handling and
  // views/marketplace-coming-soon.ejs. ('app' singular was already
  // reserved above; 'apps' plural is the actual subdomain these use.)
  'themes', 'apps',
  // The platform's own long-running showcase store (Default theme's demo,
  // see migrateThemeDemoStores below) — this one bare word, plus the whole
  // 'demo-' prefix checked in isReservedSubdomain, keep any current or
  // future per-theme demo store's address off-limits to real merchants.
  'demo',
]);

// A merchant's chosen subdomain is rejected if it's one of the fixed words
// above, OR starts with 'demo-' — the prefix every per-theme demo store
// (see migrateThemeDemoStores) uses for its subdomain, so a merchant can
// never grab one out from under a demo store, including ones added later.
function isReservedSubdomain(subdomain) {
  return RESERVED_SUBDOMAINS.has(subdomain) || subdomain.startsWith('demo-');
}

// All table names go through this prefix, so PageZaper's tables are easy to
// pick out if this database is ever shared with another app. Every route
// file imports TABLES from here rather than hardcoding table names.
const PREFIX = process.env.DB_PREFIX || 'pz_';
const TABLES = {
  stores: `${PREFIX}stores`,
  // `admins` (pz_admins) is legacy — kept here only so migrateAdminsToUsers()
  // can find and migrate it on databases that still have it. New code should
  // never query it directly; use `users` + `userRoles` instead.
  admins: `${PREFIX}admins`,
  users: `${PREFIX}users`,
  userRoles: `${PREFIX}user_roles`,
  customers: `${PREFIX}customers`,
  categories: `${PREFIX}categories`,
  products: `${PREFIX}products`,
  // Many-to-many: a product can sit in more than one category. products.
  // category_id (below) is kept around read-only for backward compat with
  // anything still querying it directly, but is no longer written to by new
  // code — this table is the real source of truth going forward. See
  // migrateProductCategoryLinks() for how existing category_id values get
  // backfilled into it.
  productCategories: `${PREFIX}product_categories`,
  orders: `${PREFIX}orders`,
  orderItems: `${PREFIX}order_items`,
  pages: `${PREFIX}pages`,
  pageSections: `${PREFIX}page_sections`,
  // WordPress-style save history for the section builder — see the CREATE
  // TABLE comment below for the full scoping/pruning story.
  pageSectionRevisions: `${PREFIX}page_section_revisions`,
  newsletterSubscribers: `${PREFIX}newsletter_subscribers`,
  platformAdmins: `${PREFIX}platform_admins`,
  // Platform-wide key/value settings edited from Platform Admin > Settings
  // (SMTP, Google Drive keys, ...) — see lib/settings.js for the field
  // list and how secret values are encrypted.
  settings: `${PREFIX}settings`,
  discounts: `${PREFIX}discounts`,
  // Structural theme marketplace (see lib/themes.js) — distinct from the
  // `theme` column on `stores` above, which only ever swaps two CSS color
  // variables. These two tables let a store's storefront look structurally
  // different (its own header/footer/product/cart templates), not just
  // recolored.
  themes: `${PREFIX}themes`,
  storeThemes: `${PREFIX}store_themes`,
  // Saved, reusable page-builder blocks (usually a configured row — see
  // lib/sections.js's sanitizeRowBlock) a merchant can drop into any page on
  // their store without rebuilding it from scratch each time — the section
  // builder's "component library" (public/js/admin-builder.js).
  pageComponents: `${PREFIX}page_components`,
  // WordPress-style saved navigation menus (lib/menus.js) — a menu is a
  // named, reusable tree of items a merchant builds once on the Menus
  // screen; a nav_menu section then just references one by id instead of
  // storing its own links inline. See pz_menu_items below for the items.
  menus: `${PREFIX}menus`,
  menuItems: `${PREFIX}menu_items`,
  // Per-store Media Library (see lib/media.js) — every uploaded file's
  // metadata; the file itself lives on disk under public/uploads/store-<id>/
  // (MEDIA_UPLOAD_ROOT in lib/media.js), named by this row's own `filename`
  // so store_id is never trusted from anywhere but the DB row/folder path.
  media: `${PREFIX}media`,
  // Blog posts (Content > Blog posts in the admin nav) -- deliberately
  // simple/flat (no tags/authors/comments) to match how the rest of this
  // app's content model stays minimal; see the CREATE TABLE below for the
  // full column story.
  blogPosts: `${PREFIX}blog_posts`,
  // CRM (Contacts) — see the CREATE TABLE comments below for the full
  // design story: contacts is a superset of customers that works for every
  // store vertical, and listings is the non-ecommerce equivalent of
  // products (a property, a vehicle, a rental unit, a bookable service).
  contacts: `${PREFIX}contacts`,
  listings: `${PREFIX}listings`,
  // Custom content types a merchant defines for themselves (Shopify calls
  // these "metaobjects") -- e.g. a real-estate store defining a "Property"
  // type with its own Bedrooms/Bathrooms/Price fields. A definition is the
  // schema (this table + metaobjectFields below); each actual property is a
  // row in `listings` above, scoped to the definition via listings.
  // definition_id (see migrateListingsMetaobjects). Deliberately its own
  // pair of tables rather than folding the field schema into `listings`
  // itself, since a definition's fields are edited far less often than
  // entries are, and every entry of the same definition shares one schema.
  metaobjectDefinitions: `${PREFIX}metaobject_definitions`,
  metaobjectFields: `${PREFIX}metaobject_fields`,
  // Paid apps (CRM is the first one) — mirrors the existing themes/
  // store_themes structural marketplace pattern: `apps` is the catalog,
  // `store_apps` is which store has which app switched on, and `plans` /
  // `plan_apps` say which apps come bundled free at which plan tier (see
  // the CREATE TABLE comments below). `stores.plan` itself stays the plain
  // VARCHAR slug it already was — PLANS above is still the source of truth
  // for which slugs are valid; `plans` here only adds pricing/bundling on
  // top, it doesn't replace that check.
  apps: `${PREFIX}apps`,
  storeApps: `${PREFIX}store_apps`,
  plans: `${PREFIX}plans`,
  planApps: `${PREFIX}plan_apps`,
  // Account-scoped apps (CRM being the first — see apps.scope, added by
  // migrateAppsScopeColumn) install against a pz_users login instead of one
  // store, since the whole point is working across every store that login
  // runs. Mirrors store_apps exactly, just keyed to user_id.
  userApps: `${PREFIX}user_apps`,
  // Who can work a CRM owner's leads/tasks — deliberately separate from
  // user_roles (store admin/manager, which grants full access to ONE
  // store's products/orders/pages). CRM access and store-staff access are
  // independent grants; see the CREATE TABLE comment below.
  crmMembers: `${PREFIX}crm_members`,
  // A follow-up/to-do — either attached to a CRM contact, or "standalone"
  // (contact_id NULL) for work that isn't about any one lead/customer.
  crmTasks: `${PREFIX}crm_tasks`,
  // Small checklist items nested under one crm_tasks row.
  crmSubtasks: `${PREFIX}crm_subtasks`,
  // A scheduled "reach out to this contact on this day" -- separate from
  // crm_tasks, and can optionally link to one task.
  crmFollowups: `${PREFIX}crm_followups`,
  // CRM team attendance -- one row per clock-in/break/clock-out event (see
  // the CREATE TABLE comment below for why this is an event log rather than
  // a mutable per-day summary row).
  crmAttendanceEvents: `${PREFIX}crm_attendance_events`,
  // Per-task timer entries -- one row per "start timer" press, closed by
  // "stop" (or by the next start, or by clocking out). See the CREATE TABLE
  // comment below.
  crmTaskTimeEntries: `${PREFIX}crm_task_time_entries`,
  // Raw responses from a page-builder 'form' section (see lib/forms.js) --
  // every submission also creates/updates a pz_contacts row (source:
  // 'contact_form'), so it shows up in the CRM Leads screen like any other
  // lead; this table keeps the full field-by-field answer (message, topic,
  // preferred date, ...) that a contact row alone has no place to hold.
  formSubmissions: `${PREFIX}form_submissions`,
};
// The un-prefixed names this app used before DB_PREFIX existed — used only
// to detect and safely rename an older install's tables (see
// renameLegacyTables below). Not used anywhere else.
const LEGACY_NAMES = {
  stores: 'stores',
  admins: 'admins',
  categories: 'categories',
  products: 'products',
  orders: 'orders',
  orderItems: 'order_items',
};

// ---------- Schema ----------
// These CREATE TABLE statements describe the full desired multi-tenant
// schema and are what a brand new database gets. An existing (pre-multi-
// tenant, or pre-prefix) database won't be shaped like this yet since
// `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists —
// renameLegacyTables() and migrateMultiTenancy() below bring those up to
// the same shape safely, without ever dropping data.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TABLES.stores} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  subdomain VARCHAR(63) UNIQUE NOT NULL,
  theme VARCHAR(50) NOT NULL DEFAULT 'default',
  plan VARCHAR(20) NOT NULL DEFAULT 'free',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- pz_admins is intentionally NOT created here anymore — new installs go
-- straight to pz_users/pz_user_roles below. migrateAdminsToUsers() handles
-- an existing database that still has pz_admins from before this change.

-- Global login, not scoped to any one store — a person can own or staff
-- multiple stores through pz_user_roles below (mirrors how a Shopify staff
-- account can belong to several shops).
CREATE TABLE IF NOT EXISTS ${TABLES.users} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Links a pz_users login to a store with a role. One user can hold more
-- than one role at the same store (unlikely) or roles at different stores.
CREATE TABLE IF NOT EXISTS ${TABLES.userRoles} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  store_id INT NOT NULL,
  role VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_user_store_role (user_id, store_id, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Storefront shopper accounts. Unlike pz_users, these ARE scoped to a single
-- store (store_id, email) — same person shopping at two different stores is
-- two separate customer records, matching how Shopify customers work.
CREATE TABLE IF NOT EXISTS ${TABLES.customers} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_customer_email (store_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.categories} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_category_name (store_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.products} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  compare_at_price DECIMAL(10,2) NULL,
  image_url VARCHAR(1000),
  category_id INT NULL,
  stock INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES ${TABLES.categories}(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_store_slug (store_id, slug),
  INDEX idx_status (status),
  INDEX idx_category (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Many-to-many product <-> category links (see TABLES.productCategories
-- above for the full story on why this exists alongside products.category_id).
CREATE TABLE IF NOT EXISTS ${TABLES.productCategories} (
  product_id INT NOT NULL,
  category_id INT NOT NULL,
  PRIMARY KEY (product_id, category_id),
  FOREIGN KEY (product_id) REFERENCES ${TABLES.products}(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES ${TABLES.categories}(id) ON DELETE CASCADE,
  INDEX idx_pc_category (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Blog posts: title/slug/excerpt/body/cover image, draft-or-published, same
-- shape as pz_products' own content fields so the admin form (and the
-- media picker wiring on cover_image_url) feels identical to the product
-- form a merchant already knows. published_at is set the first time a post
-- moves to 'published' and never touched again after that (see
-- routes/admin.js) -- it's "when this post first went live", not "last
-- saved", so the storefront can sort by it even across later edits.
CREATE TABLE IF NOT EXISTS ${TABLES.blogPosts} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  excerpt VARCHAR(500),
  body TEXT,
  cover_image_url VARCHAR(1000),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  published_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_blog_slug (store_id, slug),
  INDEX idx_blog_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.orders} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  order_number VARCHAR(64) UNIQUE NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(50),
  shipping_address VARCHAR(500) NOT NULL,
  shipping_city VARCHAR(255),
  shipping_zip VARCHAR(20),
  subtotal DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  payment_method VARCHAR(20) DEFAULT 'cod',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  INDEX idx_order_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.orderItems} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NULL,
  title VARCHAR(255) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES ${TABLES.orders}(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES ${TABLES.products}(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.pages} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  path VARCHAR(255) NOT NULL,
  is_home TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'published',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_page_path (store_id, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.pageSections} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  page_id INT NULL,
  store_id INT NULL,
  region VARCHAR(10) NOT NULL DEFAULT 'body',
  type VARCHAR(30) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  fields JSON NOT NULL,
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  custom_class VARCHAR(100) NULL,
  custom_css TEXT NULL,
  min_height INT NOT NULL DEFAULT 0,
  hide_desktop TINYINT(1) NOT NULL DEFAULT 0,
  hide_tablet TINYINT(1) NOT NULL DEFAULT 0,
  hide_mobile TINYINT(1) NOT NULL DEFAULT 0,
  margin_top INT NOT NULL DEFAULT 0,
  margin_bottom INT NOT NULL DEFAULT 0,
  margin_left INT NOT NULL DEFAULT 0,
  margin_right INT NOT NULL DEFAULT 0,
  padding_top INT NOT NULL DEFAULT 0,
  padding_bottom INT NOT NULL DEFAULT 0,
  padding_left INT NOT NULL DEFAULT 0,
  padding_right INT NOT NULL DEFAULT 0,
  element_styles JSON NULL,
  -- Universal Style-tab controls (see lib/sections.js's sanitizeSectionSettings)
  -- — a section-wide text color, background color, and text alignment, on
  -- top of whatever presentational fields that section's own type already
  -- has. NULL/'' means "inherit from the theme", same convention as the
  -- other nullable style columns here.
  text_color VARCHAR(7) NULL,
  bg_color VARCHAR(7) NULL,
  text_align VARCHAR(10) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (page_id) REFERENCES ${TABLES.pages}(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  INDEX idx_page_position (page_id, position),
  INDEX idx_store_region_page (store_id, region, page_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- WordPress-style save history for the page/header/footer builder — one row
-- per explicit "Save" click (and one more per revision restore, which is
-- itself treated as a new save so nothing is ever lost), holding a full
-- JSON snapshot of that scope's sections at that moment. Scoped exactly
-- like pz_page_sections itself (see scopeWhere in routes/admin.js): page_id
-- NULL + region for a store's global header/footer, page_id set + region
-- 'body' for a page's own content, page_id set + region 'header'/'footer'
-- for a page's own override. Pruned to the most recent MAX_REVISIONS_PER_SCOPE
-- rows per scope on every save (see pruneScopeRevisions in routes/admin.js)
-- so this never grows without bound.
CREATE TABLE IF NOT EXISTS ${TABLES.pageSectionRevisions} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  page_id INT NULL,
  region VARCHAR(10) NOT NULL,
  sections_json LONGTEXT NOT NULL,
  section_count INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_by_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES ${TABLES.pages}(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES ${TABLES.users}(id) ON DELETE SET NULL,
  INDEX idx_scope_created (store_id, page_id, region, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.newsletterSubscribers} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_subscriber_email (store_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.platformAdmins} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per setting, keyed like 'smtp.host'. A missing row means "not set
-- in the admin" — lib/settings.js then falls back to the matching env var.
-- Secret values (e.g. the SMTP password) are stored encrypted, prefixed
-- 'enc:v1:', never as plain text.
CREATE TABLE IF NOT EXISTS ${TABLES.settings} (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ${TABLES.discounts} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  code VARCHAR(50) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'percent',
  value DECIMAL(10,2) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_discount_code (store_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Theme marketplace catalog. One row per theme (e.g. the built-in 'default'
-- theme, seeded below by migrateStoreThemes). author_id is nullable because
-- phase 1 only has PageZaper-authored themes — it's here so third-party
-- theme authorship can be added later without another migration.
CREATE TABLE IF NOT EXISTS ${TABLES.themes} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
  price_cents INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'published',
  description TEXT NULL,
  preview_image VARCHAR(500) NULL,
  author_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which theme(s) a store has installed and which one is active. A store can
-- install more than one (a theme library, like Shopify's) but only one row
-- per store should have is_active=1 — enforced in application code
-- (lib/themes.js), same as this file's other single-active-row patterns.
CREATE TABLE IF NOT EXISTS ${TABLES.storeThemes} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  theme_id INT NOT NULL,
  token_overrides JSON NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (theme_id) REFERENCES ${TABLES.themes}(id) ON DELETE RESTRICT,
  UNIQUE KEY uniq_store_theme (store_id, theme_id),
  INDEX idx_store_active (store_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One saved builder block per row -- the "block" column is the same
-- { id, type, fields, element_styles } shape a page section or a row's
-- nested block already is (see lib/sections.js), just stored on its own
-- instead of inside a page, so it can be cloned (with fresh ids) into any
-- page's section list. Scoped per store, never shared across stores.
CREATE TABLE IF NOT EXISTS ${TABLES.pageComponents} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  block JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  INDEX idx_store_created (store_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A named, reusable menu (WordPress-style) — e.g. "Main menu", "Footer
-- links". A nav_menu section picks one of these by id (see pz_menu_items
-- for its actual items) instead of storing links inline, so the same menu
-- can be reused across the header, the footer, and any page override.
CREATE TABLE IF NOT EXISTS ${TABLES.menus} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  INDEX idx_store_name (store_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One item inside a menu. parent_id (self-referencing, one level deep by
-- app-level convention — the editor only lets you nest under a top-level
-- item) makes the item a dropdown child. 'type' says what the item points
-- to; 'target_id' is that row's id for page/category/product items (no DB
-- FK, since it conditionally points at three different tables — resolved
-- at render time by lib/menus.js, which also drops items whose target was
-- deleted/unpublished) and is NULL for a 'custom' link. 'label' is always
-- stored so a custom link has a title and a page/category/product item can
-- carry an override label; 'url' is only used by 'custom' items.
CREATE TABLE IF NOT EXISTS ${TABLES.menuItems} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  menu_id INT NOT NULL,
  parent_id INT NULL,
  position INT NOT NULL DEFAULT 0,
  type ENUM('page', 'category', 'product', 'custom') NOT NULL,
  target_id INT NULL,
  label VARCHAR(150) NOT NULL,
  url VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (menu_id) REFERENCES ${TABLES.menus}(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES ${TABLES.menuItems}(id) ON DELETE CASCADE,
  INDEX idx_menu_parent_position (menu_id, parent_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One uploaded file's metadata. 'filename' is the sanitized, collision-proof
-- name it's actually saved as on disk (see lib/media.js's safeFilename) —
-- never the visitor-supplied original name, which is kept separately in
-- 'original_name' purely for display (download-as, alt text fallback, the
-- Library grid). 'url' is the public path (/uploads/store-<id>/<filename>)
-- every consumer (product form, section image fields, the media picker)
-- actually stores and renders — kept as its own column, rather than
-- recomputed from store_id+filename everywhere, so a future storage-backend
-- change (e.g. to S3/Cloudinary) only has to rewrite this one column, not
-- every place a media row is read. uploaded_by is nullable/SET NULL so
-- removing a staff account never deletes the files they uploaded.
CREATE TABLE IF NOT EXISTS ${TABLES.media} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size INT NOT NULL,
  url VARCHAR(500) NOT NULL,
  uploaded_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES ${TABLES.users}(id) ON DELETE SET NULL,
  INDEX idx_store_created (store_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- CRM: every person a store's admin should know about, whether or not they
-- ever created a login. Deliberately separate from ${TABLES.customers} (an
-- authentication account with a password_hash) rather than merged into it —
-- most contacts here will never log in at all: a lead, a guest checkout, a
-- newsletter signup, someone who submitted a contact form or requested a
-- quote. customer_id links back to a real ecommerce account ONLY once that
-- contact actually creates one (matched by email at write time); NULL means
-- the CRM knows about this person without them ever having authenticated.
-- Works the same way for every store type/vertical, not just ecommerce —
-- see ${TABLES.listings} below for the vertical-specific thing a contact's
-- inquiry might actually be about (a property, a vehicle, a service).
CREATE TABLE IF NOT EXISTS ${TABLES.contacts} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Nullable: a lead isn't always about one specific site -- a general
  -- business inquiry can exist with no site attached at all. owner_user_id
  -- is set ONLY in that case (store_id IS NULL), so CRM can still tell
  -- whose contact this is -- normally ownership is derived through
  -- store_id -> pz_user_roles instead (see lib/crm.js's getOwnerStoreIds),
  -- which is why owner_user_id stays NULL whenever store_id is set.
  store_id INT NULL,
  owner_user_id INT NULL,
  customer_id INT NULL,
  -- 1 once this contact has been moved to Customers. Separate from customer_id
  -- because a contact with no site can be a customer without any store login
  -- (customer_id stays NULL for those). Every Leads/Customers split reads this.
  is_customer TINYINT(1) NOT NULL DEFAULT 0,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  -- How this contact entered the CRM: 'signup' (created a customer login),
  -- 'guest_checkout' (ordered without one), 'inquiry_form', 'newsletter',
  -- or 'manual' (added by the store admin directly). Plain string, not an
  -- ENUM, so a new source never needs a schema migration to exist.
  source VARCHAR(30) NOT NULL DEFAULT 'manual',
  -- Free-text labels ("hot", "wholesale", "follow up") -- a JSON array,
  -- same lightweight convention as pz_page_sections.fields or
  -- pz_listings.details, rather than a separate tags table. See
  -- lib/contacts.js's sanitizeTags for the comma-separated input format.
  tags JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES ${TABLES.customers}(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_store_contact_email (store_id, email),
  INDEX idx_contact_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Metaobjects (Shopify's term for this) -- a custom content type a merchant
-- defines for themselves, e.g. a real-estate store defining "Property" with
-- its own Bedrooms/Bathrooms/Price fields, or a car dealer defining
-- "Vehicle" with Make/Model/Year. This table is the definition (the schema
-- itself, and the display name/handle); ${TABLES.metaobjectFields} below is
-- its field list; ${TABLES.listings} further below holds the actual entries
-- (one property, one vehicle, ...), each tagged with which definition it
-- belongs to. handle is the URL segment its entries render under on the
-- storefront (e.g. handle 'property' -> /property/123-main-st — see
-- routes/storefront.js's reserved-handle guard, same idea as db/database.js's
-- own RESERVED_SUBDOMAINS for store subdomains).
CREATE TABLE IF NOT EXISTS ${TABLES.metaobjectDefinitions} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  handle VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_definition_handle (store_id, handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One field in a metaobject definition's schema (e.g. Property's
-- "Bedrooms", a 'number' field). field_key is the machine name an entry's
-- ${TABLES.listings}.details JSON is keyed by; label is what the admin form
-- and (unless overridden) the storefront show. options is only meaningful
-- for type='select' (a JSON array of strings); NULL for every other type.
-- position controls display/form order, same convention as
-- ${TABLES.pageSections}.position.
CREATE TABLE IF NOT EXISTS ${TABLES.metaobjectFields} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  definition_id INT NOT NULL,
  field_key VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  type ENUM('text', 'textarea', 'number', 'boolean', 'date', 'url', 'image', 'select') NOT NULL DEFAULT 'text',
  required TINYINT(1) NOT NULL DEFAULT 0,
  options JSON NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (definition_id) REFERENCES ${TABLES.metaobjectDefinitions}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_definition_field_key (definition_id, field_key),
  INDEX idx_field_definition_position (definition_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Vertical-agnostic "thing a store showcases that isn't an ecommerce
-- product" — a property (real estate), a vehicle (car dealer), a rental
-- unit, or a bookable service (a lawyer's consultation type, a salon
-- appointment). Deliberately not a ${TABLES.products} row: no stock/cart/
-- checkout concept applies to any of these. listing_type is a plain string
-- discriminator (not an ENUM) so a brand-new vertical never needs a schema
-- migration to exist — it just starts writing a new listing_type value.
-- Whatever's specific to that vertical (bedrooms/bathrooms for a property,
-- make/model/year for a vehicle, deposit/daily_rate for a rental) lives in
-- the details column, mirroring how ${TABLES.pageSections}.fields already stores
-- type-specific data as JSON rather than needing a column per section type.
-- definition_id ties an entry to its metaobject schema (see
-- ${TABLES.metaobjectDefinitions} above) -- NULL is kept possible (rather
-- than NOT NULL) so this table still has a sane shape if it's ever used
-- without the metaobject system layered on top; every entry the metaobject
-- admin screens create always sets it, and listing_type is kept in sync
-- with the definition's handle purely as a denormalized filter (see
-- lib/metaobjects.js) so a storefront query never needs to join back to the
-- definition just to filter by type.
CREATE TABLE IF NOT EXISTS ${TABLES.listings} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  definition_id INT NULL,
  listing_type VARCHAR(30) NOT NULL DEFAULT 'general',
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NULL,
  image_url VARCHAR(1000),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  details JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (definition_id) REFERENCES ${TABLES.metaobjectDefinitions}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_listing_slug (store_id, slug),
  INDEX idx_listing_type_status (listing_type, status),
  INDEX idx_listing_definition (definition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per submission of a page-builder 'form' section (see
-- lib/forms.js's FORM_PRESETS). section_id is nullable/ON DELETE SET NULL
-- because a lead's own record should outlive the page section that
-- captured it -- a merchant redesigning the page shouldn't lose history of
-- who already enquired. contact_id likewise SET NULL rather than CASCADE,
-- so deleting a duplicate/merged contact never silently deletes the raw
-- submission it came from.
CREATE TABLE IF NOT EXISTS ${TABLES.formSubmissions} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  section_id INT NULL,
  preset VARCHAR(30) NOT NULL DEFAULT 'contact',
  data JSON NOT NULL,
  contact_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (section_id) REFERENCES ${TABLES.pageSections}(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES ${TABLES.contacts}(id) ON DELETE SET NULL,
  INDEX idx_form_submissions_store (store_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Plan pricing — mirrors ${TABLES.themes}'s own catalog shape (a price on
-- the catalog row itself). ${TABLES.stores}.plan stays a plain VARCHAR slug
-- ('free'/'starter'/'pro', validated against the PLANS array in this file)
-- rather than becoming a real foreign key here — that would touch every
-- place PLANS is already checked against for comparatively little benefit.
-- This table just gives each of those slugs a real price and a place to
-- attach bundled apps (see ${TABLES.planApps} below). No payment processor
-- is wired up yet (see PLANS' own comment above) — a store's plan is still
-- moved by hand from /platform-admin/stores/:id until Razorpay billing
-- exists; this table is what that screen will show a price for.
CREATE TABLE IF NOT EXISTS ${TABLES.plans} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The paid-app catalog (CRM is the first entry — see migrateSeedApps below
-- for how it gets seeded). Same shape as ${TABLES.themes}: a slug, a price,
-- and a status so an app can be unpublished without deleting it (and
-- orphaning every store that already has it switched on).
CREATE TABLE IF NOT EXISTS ${TABLES.apps} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'published',
  description TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which apps come bundled free at which plan tier (e.g. CRM included on
-- Pro, but not on Starter) — a store on that plan gets the app active with
-- no separate ${TABLES.storeApps} row needed; see lib/apps.js (once it
-- exists) for the combined "is this app active for this store" check that
-- reads both tables. Many-to-many since a plan can bundle several apps and
-- an app could be bundled into more than one tier.
CREATE TABLE IF NOT EXISTS ${TABLES.planApps} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  app_id INT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES ${TABLES.plans}(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES ${TABLES.apps}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_plan_app (plan_id, app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which store has which app switched on beyond whatever their plan already
-- bundles for free — i.e. a standalone purchase (a Starter store buying
-- CRM on its own rather than upgrading to Pro). Mirrors ${TABLES.storeThemes}
-- exactly: is_active lets an app be paused (payment lapsed) without losing
-- the row/its history, same as a theme can be installed but not the active
-- one.
CREATE TABLE IF NOT EXISTS ${TABLES.storeApps} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  app_id INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES ${TABLES.apps}(id) ON DELETE RESTRICT,
  UNIQUE KEY uniq_store_app (store_id, app_id),
  INDEX idx_store_app_active (store_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Same shape as ${TABLES.storeApps} above, but for an app whose scope is
-- 'account' (see migrateAppsScopeColumn) rather than 'store' -- CRM being
-- the first one. Keyed to a pz_users login instead of one store, since the
-- whole point of an account-scoped app is working across every store that
-- login runs, not any single one of them.
CREATE TABLE IF NOT EXISTS ${TABLES.userApps} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  app_id INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES ${TABLES.apps}(id) ON DELETE RESTRICT,
  UNIQUE KEY uniq_user_app (user_id, app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who can work a CRM owner's leads and tasks. Deliberately separate from
-- ${TABLES.userRoles} (which grants full admin/manager access to one
-- specific STORE -- products, orders, pages, everything). A person here can
-- see and work this owner's contacts/tasks across every store the owner
-- runs, without ever touching any of those stores' own admin -- and being
-- store staff does NOT imply CRM access, or vice versa; the owner grants
-- each independently. owner_user_id is whoever activated CRM (via
-- ${TABLES.userApps}); member_user_id is who they've added to help work it.
CREATE TABLE IF NOT EXISTS ${TABLES.crmMembers} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id INT NOT NULL,
  member_user_id INT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (member_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_owner_member (owner_user_id, member_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A follow-up/to-do, either attached to one ${TABLES.contacts} row or
-- "standalone" (contact_id NULL) for CRM work that isn't about any one
-- lead/customer. assigned_to is checked in app code (either the owner
-- themself or one of their ${TABLES.crmMembers}) rather than by the FK,
-- since either table could hold that user. owner_user_id is denormalized
-- from the contact's store (rather than joined through contacts -> stores
-- -> user_roles every time) purely so "my tasks" / "tasks I've assigned"
-- stay a single cheap query, and is set directly for standalone tasks.
-- description holds a small amount of sanitized rich-text HTML from the
-- task panel's editor (see lib/crm.js's sanitizeDescriptionHtml).
CREATE TABLE IF NOT EXISTS ${TABLES.crmTasks} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id INT NOT NULL,
  contact_id INT NULL,
  title VARCHAR(255) NOT NULL,
  description MEDIUMTEXT NULL,
  priority ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium',
  due_date DATE NULL,
  assigned_to INT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES ${TABLES.contacts}(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES ${TABLES.users}(id) ON DELETE SET NULL,
  INDEX idx_task_owner_done (owner_user_id, done),
  INDEX idx_task_contact (contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A small checklist item nested under one crm_tasks row (the "Subtasks"
-- card). Deliberately minimal -- no description/priority of its own.
CREATE TABLE IF NOT EXISTS ${TABLES.crmSubtasks} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  due_date DATE NULL,
  assigned_to INT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES ${TABLES.crmTasks}(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES ${TABLES.users}(id) ON DELETE SET NULL,
  INDEX idx_subtask_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A scheduled follow-up with one contact: who to get back to and on which
-- day (optionally at what time). Deliberately its own thing rather than a
-- crm_tasks row -- the Follow-ups screen is the "what do I need to do today"
-- list. task_id optionally links it to one crm_tasks row (the work that
-- follow-up is about) and is cleared, not cascaded, if that task is deleted.
-- assigned_to is checked in app code like crm_tasks.assigned_to. owner_user_id
-- is denormalized the same way crm_tasks does it, so the today/overdue
-- queries stay a single table scan.
CREATE TABLE IF NOT EXISTS ${TABLES.crmFollowups} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id INT NOT NULL,
  contact_id INT NOT NULL,
  task_id INT NULL,
  title VARCHAR(255) NOT NULL,
  note TEXT NULL,
  due_date DATE NOT NULL,
  due_time TIME NULL,
  assigned_to INT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  done_at TIMESTAMP NULL,
  -- Set once the daily reminder email (see lib/reminders.js) has gone out
  -- for this follow-up, so it's only ever emailed once even if it's left
  -- undone -- its in-CRM Overdue tab keeps showing it regardless. NULL
  -- means "not sent yet".
  reminder_sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES ${TABLES.contacts}(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES ${TABLES.crmTasks}(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_to) REFERENCES ${TABLES.users}(id) ON DELETE SET NULL,
  INDEX idx_followup_owner_due (owner_user_id, done, due_date),
  INDEX idx_followup_contact (contact_id),
  INDEX idx_followup_reminder_due (done, reminder_sent_at, due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- CRM team attendance. Deliberately an append-only event log (clock_in /
-- break_start / break_end / clock_out), not a mutable "today's summary"
-- row -- lib/attendance.js derives worked/break totals and current state by
-- walking a day's events in order, which keeps every clock action a plain
-- INSERT (no read-modify-write race between two tabs/devices) and leaves a
-- full audit trail for free. Scoped like crm_tasks: owner_user_id is whose
-- CRM this belongs to, user_id is who clocked in (the owner themself or one
-- of their crm_members).
CREATE TABLE IF NOT EXISTS ${TABLES.crmAttendanceEvents} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id INT NOT NULL,
  user_id INT NOT NULL,
  event_type ENUM('clock_in', 'break_start', 'break_end', 'clock_out') NOT NULL,
  event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  INDEX idx_attendance_owner_user_at (owner_user_id, user_id, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-task timer entries -- one row per "start timer" press on a crm_tasks
-- row, with ended_at NULL while it's still running. lib/attendance.js
-- enforces one running row per user_id at a time (starting a new timer
-- stops whatever was already running), so a person's total logged hours
-- never double-counts overlapping entries. owner_user_id is denormalized
-- from the task the same way crm_tasks/crm_followups already do it, so
-- "my total hours today" stays a single-table scan.
CREATE TABLE IF NOT EXISTS ${TABLES.crmTaskTimeEntries} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_user_id INT NOT NULL,
  task_id INT NOT NULL,
  user_id INT NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL,
  FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES ${TABLES.crmTasks}(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE,
  INDEX idx_time_entry_task (task_id),
  INDEX idx_time_entry_user_running (user_id, ended_at),
  INDEX idx_time_entry_user_started (owner_user_id, user_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const SAMPLE_PRODUCTS = [
  {
    title: 'Classic Cotton Tee',
    slug: 'classic-cotton-tee',
    description: 'A soft, breathable everyday t-shirt made from 100% combed cotton. Available in multiple colors.',
    price: 599,
    compare_at_price: 799,
    image_url: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600',
    category: 'Apparel',
    stock: 50,
  },
  {
    title: 'Minimalist Leather Wallet',
    slug: 'minimalist-leather-wallet',
    description: 'Slim, handcrafted genuine leather wallet with 6 card slots and a coin pocket.',
    price: 1299,
    compare_at_price: null,
    image_url: 'https://images.unsplash.com/photo-1627123424574-724758594e93?w=600',
    category: 'Accessories',
    stock: 30,
  },
  {
    title: 'Ceramic Pour-Over Coffee Set',
    slug: 'ceramic-pour-over-coffee-set',
    description: 'Hand-glazed ceramic dripper and mug set for the perfect morning brew.',
    price: 1899,
    compare_at_price: 2199,
    image_url: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600',
    category: 'Home & Living',
    stock: 20,
  },
  {
    title: 'Wireless Earbuds Pro',
    slug: 'wireless-earbuds-pro',
    description: 'Active noise cancelling wireless earbuds with 30-hour battery life via charging case.',
    price: 3499,
    compare_at_price: 3999,
    image_url: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600',
    category: 'Electronics',
    stock: 15,
  },
  {
    title: 'Canvas Tote Bag',
    slug: 'canvas-tote-bag',
    description: 'Durable heavyweight canvas tote, perfect for groceries, books, or the beach.',
    price: 449,
    compare_at_price: null,
    image_url: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=600',
    category: 'Accessories',
    stock: 40,
  },
  {
    title: 'Scented Soy Candle',
    slug: 'scented-soy-candle',
    description: 'Hand-poured soy wax candle with a warm sandalwood and vanilla fragrance. 40-hour burn time.',
    price: 699,
    compare_at_price: 899,
    image_url: 'https://images.unsplash.com/photo-1602874801007-bd458bb1b8b6?w=600',
    category: 'Home & Living',
    stock: 60,
  },
];

// ---------- Migration helpers ----------
// All idempotent: safe to run on every boot, on a brand new DB, an old
// single-tenant one, or an old un-prefixed multi-tenant one. Never drops
// or truncates data.
async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return rows[0].c > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0].c > 0;
}

async function columnIsNullable(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows.length > 0 && rows[0].is_nullable === 'YES';
}

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  return rows[0].c > 0;
}

async function foreignKeyExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.KEY_COLUMN_USAGE
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND referenced_table_name IS NOT NULL`,
    [table, column]
  );
  return rows[0].c > 0;
}

// Finds a UNIQUE index that covers exactly `column` alone (not PRIMARY, not
// already the store-scoped composite one) so it can be replaced.
async function findLegacyUniqueIndex(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT index_name, COUNT(*) AS col_count,
            SUM(CASE WHEN column_name = ? THEN 1 ELSE 0 END) AS matches
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND non_unique = 0 AND index_name != 'PRIMARY'
     GROUP BY index_name`,
    [column, table]
  );
  // mysql2 returns COUNT(*) as a JS number but SUM(...) as a string (to
  // avoid precision loss on large sums), so comparing r.matches with === 1
  // silently never matches — Number(...) both sides so this actually finds
  // the legacy index instead of always returning null.
  const hit = rows.find((r) => Number(r.col_count) === 1 && Number(r.matches) === 1);
  return hit ? hit.index_name : null;
}

// If this database still has the old un-prefixed tables (from before
// DB_PREFIX existed) and the prefixed ones don't exist yet, rename them in
// place — a single atomic RENAME TABLE per table, which MySQL/InnoDB keeps
// foreign keys pointing through correctly. All data, all rows, stays intact.
async function renameLegacyTables(conn) {
  for (const key of Object.keys(TABLES)) {
    const legacy = LEGACY_NAMES[key];
    const prefixed = TABLES[key];
    if (legacy === prefixed) continue;
    const [legacyThere, prefixedThere] = await Promise.all([
      tableExists(conn, legacy),
      tableExists(conn, prefixed),
    ]);
    if (legacyThere && !prefixedThere) {
      await conn.query(`RENAME TABLE \`${legacy}\` TO \`${prefixed}\``);
      console.log(`Renamed table \`${legacy}\` -> \`${prefixed}\``);
    }
  }
}

async function migrateMultiTenancy(conn) {
  // pz_admins deliberately excluded — it's being retired by
  // migrateAdminsToUsers() below, not managed here anymore.
  const tenantTables = [TABLES.categories, TABLES.products, TABLES.orders];

  // 1. Add store_id (nullable for now) to any table that predates multi-tenancy.
  for (const t of tenantTables) {
    if (!(await columnExists(conn, t, 'store_id'))) {
      await conn.query(`ALTER TABLE ${t} ADD COLUMN store_id INT NULL`);
    }
  }

  // 2. Make sure a "demo" store exists to own any pre-existing rows (the
  // original single-tenant storefront becomes this store).
  let [[demoStore]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = 'demo' LIMIT 1`);
  if (!demoStore) {
    const [result] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status) VALUES (?, 'demo', 'default', 'free', 'active')`,
      ['Demo Store']
    );
    demoStore = { id: result.insertId };
  }
  const demoStoreId = demoStore.id;

  // 3. Backfill any NULL store_id rows onto the demo store.
  for (const t of tenantTables) {
    await conn.query(`UPDATE ${t} SET store_id = ? WHERE store_id IS NULL`, [demoStoreId]);
  }

  // 4. Enforce NOT NULL + index + FK now that every row has a store_id.
  for (const t of tenantTables) {
    await conn.query(`ALTER TABLE ${t} MODIFY store_id INT NOT NULL`);

    const idxName = `idx_${t}_store_id`;
    if (!(await indexExists(conn, t, idxName))) {
      await conn.query(`ALTER TABLE ${t} ADD INDEX ${idxName} (store_id)`);
    }

    if (!(await foreignKeyExists(conn, t, 'store_id'))) {
      await conn.query(
        `ALTER TABLE ${t} ADD CONSTRAINT fk_${t}_store FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE`
      );
    }
  }

  // 5. Replace old single-column UNIQUE constraints with store-scoped ones,
  // so different merchants can reuse the same slug/category name/admin email.
  const uniquePlans = [
    { table: TABLES.products, column: 'slug', indexName: 'uniq_store_slug' },
    { table: TABLES.categories, column: 'name', indexName: 'uniq_store_category_name' },
  ];
  for (const plan of uniquePlans) {
    const legacyIdx = await findLegacyUniqueIndex(conn, plan.table, plan.column);
    if (legacyIdx) {
      await conn.query(`ALTER TABLE ${plan.table} DROP INDEX ${legacyIdx}`);
    }
    if (!(await indexExists(conn, plan.table, plan.indexName))) {
      await conn.query(`ALTER TABLE ${plan.table} ADD UNIQUE KEY ${plan.indexName} (store_id, ${plan.column})`);
    }
  }

  return demoStoreId;
}

// Every store needs exactly one Home page (is_home=1, path='/') to render the
// storefront front page from. Any store that doesn't have one yet (brand new
// stores created before this feature existed, or a fresh signup) gets one
// created here with a starter hero + product grid section, matching what the
// hardcoded storefront home page used to look like.
async function migratePagesForExistingStores(conn) {
  const { defaultFields } = require('../lib/sections');

  const [stores] = await conn.query(`SELECT id FROM ${TABLES.stores}`);
  for (const store of stores) {
    const [[home]] = await conn.query(
      `SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 1 LIMIT 1`,
      [store.id]
    );
    if (home) continue;

    const [result] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Home', '/', 1, 'published')`,
      [store.id]
    );
    const pageId = result.insertId;

    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'hero', 0, ?)`,
      [pageId, JSON.stringify(defaultFields('hero'))]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'products', 1, ?)`,
      [pageId, JSON.stringify(defaultFields('products'))]
    );
  }
}

// Marks a page as a standalone "Form" (see the /admin/forms routes) rather
// than a regular content page. A form is a normal pz_pages row underneath —
// it reuses the exact same builder, theming, and rendering pipeline as any
// other page, just auto-provisioned with a single 'form' section, served at
// /forms/<slug> instead of /pages/<slug> (see routes/storefront.js), and
// kept out of the regular Pages list / auto nav-link list (res.locals.
// storePages) so it doesn't clutter either one. 0/unset for every existing
// page, which is exactly right — nothing already published should suddenly
// start behaving like a form.
async function migratePagesFormColumn(conn) {
  if (!(await columnExists(conn, TABLES.pages, 'is_form'))) {
    await conn.query(`ALTER TABLE ${TABLES.pages} ADD COLUMN is_form TINYINT(1) NOT NULL DEFAULT 0`);
  }
}

// Backfills pz_product_categories for products that only ever had the old
// single products.category_id set — runs every startup but is a no-op once
// caught up (INSERT IGNORE against the junction table's own PRIMARY KEY
// means re-running this is always safe). New products/edits go straight
// through the junction table from routes/admin.js and never touch
// category_id again, but this keeps every pre-existing product's one
// category from silently vanishing out of category filters/collections the
// first time this code runs against an existing database.
async function migrateProductCategoryLinks(conn) {
  await conn.query(
    `INSERT IGNORE INTO ${TABLES.productCategories} (product_id, category_id)
     SELECT id, category_id FROM ${TABLES.products} WHERE category_id IS NOT NULL`
  );
}

// Adds discount tracking to orders placed before the Discounts feature
// existed. `total` is what the customer actually paid (subtotal minus any
// discount); existing rows get total = subtotal, discount_amount = 0, which
// is the correct value for an order that had no discount applied.
async function migrateOrderDiscountColumns(conn) {
  if (!(await columnExists(conn, TABLES.orders, 'discount_code'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD COLUMN discount_code VARCHAR(50) NULL`);
  }
  if (!(await columnExists(conn, TABLES.orders, 'discount_amount'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.orders, 'total'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD COLUMN total DECIMAL(10,2) NULL`);
    await conn.query(`UPDATE ${TABLES.orders} SET total = subtotal - discount_amount WHERE total IS NULL`);
  }
}

// Adds per-section custom_class / custom_css columns — universal "module
// settings" every section type gets alongside its own type-specific fields,
// so a merchant can nudge one section's look without a whole new theme.
// custom_css is trusted, unfiltered CSS text (same trust level as any other
// admin-entered value); the storefront neutralizes it at render time via a
// textContent assignment rather than input filtering — see the "custom CSS"
// block in views/storefront/partials/section.ejs.
async function migratePageSectionSettings(conn) {
  if (!(await columnExists(conn, TABLES.pageSections, 'custom_class'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN custom_class VARCHAR(100) NULL`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'custom_css'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN custom_css TEXT NULL`);
  }
  // min_height (px): the drag-to-resize handle on each canvas section writes
  // here. 0 means "no override" — the section keeps its natural, content-fit
  // height exactly as before.
  if (!(await columnExists(conn, TABLES.pageSections, 'min_height'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN min_height INT NOT NULL DEFAULT 0`);
  }
  // Per-section responsive visibility — independent of `hidden` above
  // (which hides a section everywhere): each of these hides it only on
  // that one device class, both in the builder's canvas preview and via a
  // real CSS media query on the live storefront.
  if (!(await columnExists(conn, TABLES.pageSections, 'hide_desktop'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN hide_desktop TINYINT(1) NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'hide_tablet'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN hide_tablet TINYINT(1) NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'hide_mobile'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN hide_mobile TINYINT(1) NOT NULL DEFAULT 0`);
  }
  // Spacing around/inside a section — margin (the gap before/after/beside
  // it, adjustable via the gutter/edge drag handles on the canvas) and
  // padding (inset from its own edges, numeric-only in the inspector).
  // Sections are full-width blocks, so left/right margin insets the section
  // itself from the page edge (a "boxed" look) rather than repositioning it.
  if (!(await columnExists(conn, TABLES.pageSections, 'margin_top'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN margin_top INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'margin_bottom'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN margin_bottom INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'margin_left'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN margin_left INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'margin_right'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN margin_right INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'padding_top'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN padding_top INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'padding_bottom'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN padding_bottom INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'padding_left'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN padding_left INT NOT NULL DEFAULT 0`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'padding_right'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN padding_right INT NOT NULL DEFAULT 0`);
  }
  // Per-element spacing (margin/padding on one text field inside a section,
  // e.g. just the Hero heading, independent of the section-level spacing
  // above) — keyed by field name, see lib/sections.js's TEXT_ELEMENT_FIELDS
  // and sanitizeElementStyle. NULL/absent means no element has an override.
  if (!(await columnExists(conn, TABLES.pageSections, 'element_styles'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN element_styles JSON NULL`);
  }
}

// Universal Style-tab controls (see lib/sections.js's sanitizeSectionSettings
// and the builder's new Content/Style/Advanced/Visibility inspector tabs) —
// a section-wide text color, background color, and text alignment that
// apply regardless of type, layered on top of a type's own presentational
// fields (a hero's own bg_color, a promo_bar's own text_color, etc.).
// Split out from migratePageSectionSettings (which already covers the
// original custom_class/custom_css/spacing/visibility columns) so this one
// idempotent step can be added without touching that already-shipped one.
async function migrateSectionStyleColumns(conn) {
  if (!(await columnExists(conn, TABLES.pageSections, 'text_color'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN text_color VARCHAR(7) NULL`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'bg_color'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN bg_color VARCHAR(7) NULL`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'text_align'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN text_align VARCHAR(10) NULL`);
  }
}

// Turns pz_page_sections into the shared storage for page content AND the
// header/footer builder, instead of a separate table. Two additions make
// this possible:
//   - `region` ('body' | 'header' | 'footer') says which canvas a row
//     belongs to; existing rows default to 'body' (ordinary page content),
//     unchanged in meaning.
//   - `page_id` becomes nullable, and a new `store_id` is added: a row with
//     page_id = NULL is a store's GLOBAL header/footer section; a row with a
//     real page_id and region = 'header'/'footer' is that one page's
//     OVERRIDE, which the storefront prefers over the global rows when
//     present (see resolveLayoutSections in routes/storefront.js). Ordinary
//     'body' rows always have a page_id, exactly as before.
// store_id is filled on every row (even page-scoped ones) so header/footer
// lookups never need to join through pz_pages just to know which store a
// row belongs to.
async function migrateHeaderFooterSections(conn) {
  if (!(await columnExists(conn, TABLES.pageSections, 'store_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN store_id INT NULL`);
  }
  if (!(await columnExists(conn, TABLES.pageSections, 'region'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD COLUMN region VARCHAR(10) NOT NULL DEFAULT 'body'`);
  }
  if (!(await columnIsNullable(conn, TABLES.pageSections, 'page_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} MODIFY page_id INT NULL`);
  }
  // Backfill store_id for every existing row via its page, then for any
  // stragglers (shouldn't exist, but keeps this migration self-contained).
  await conn.query(
    `UPDATE ${TABLES.pageSections} ps JOIN ${TABLES.pages} p ON ps.page_id = p.id SET ps.store_id = p.store_id WHERE ps.store_id IS NULL`
  );
  if (!(await indexExists(conn, TABLES.pageSections, 'idx_store_region_page'))) {
    await conn.query(`ALTER TABLE ${TABLES.pageSections} ADD INDEX idx_store_region_page (store_id, region, page_id)`);
  }
  if (!(await foreignKeyExists(conn, TABLES.pageSections, 'store_id'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.pageSections} ADD CONSTRAINT fk_${TABLES.pageSections}_store FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE`
    );
  }
}

// A starter "Main menu" (pz_menus/pz_menu_items — see lib/menus.js) built
// from whatever the store's catalog looks like right now: its published
// pages, then its categories. Used to seed a brand new store's default nav
// with something rather than nothing; the merchant is free to rebuild it
// from the Menus screen afterward like any other menu. Reused (not
// recreated) if a "Main menu" already exists for the store, so calling this
// more than once is harmless.
async function seedStarterMenu(conn, storeId) {
  const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.menus} WHERE store_id = ? AND name = 'Main menu' LIMIT 1`, [storeId]);
  if (existing) return existing.id;

  const [menuResult] = await conn.query(`INSERT INTO ${TABLES.menus} (store_id, name) VALUES (?, 'Main menu')`, [storeId]);
  const menuId = menuResult.insertId;

  let position = 0;
  const [pages] = await conn.query(
    `SELECT id, name FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 0 AND status = 'published' ORDER BY name`,
    [storeId]
  );
  for (const p of pages) {
    await conn.query(
      `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label) VALUES (?, NULL, ?, 'page', ?, ?)`,
      [menuId, position++, p.id, p.name]
    );
  }
  const [categories] = await conn.query(`SELECT id, name FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]);
  for (const c of categories) {
    await conn.query(
      `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label) VALUES (?, NULL, ?, 'category', ?, ?)`,
      [menuId, position++, c.id, c.name]
    );
  }
  return menuId;
}

// Every store needs a global header and footer (page_id NULL) to fall back
// on — pages created before this feature existed, and brand new stores,
// have none yet. Seeds sections that reproduce today's hardcoded header/
// footer markup (logo/store-name, category+page nav, cart/account links;
// copyright + "Powered by PageZaper" + admin link), so no live storefront
// goes blank or changes look the moment this ships.
async function migrateDefaultHeaderFooter(conn) {
  const { defaultFields } = require('../lib/sections');

  const [stores] = await conn.query(`SELECT id FROM ${TABLES.stores}`);
  for (const store of stores) {
    const [[existingHeader]] = await conn.query(
      `SELECT id FROM ${TABLES.pageSections} WHERE store_id = ? AND page_id IS NULL AND region = 'header' LIMIT 1`,
      [store.id]
    );
    if (!existingHeader) {
      const logoFields = defaultFields('logo');
      const starterMenuId = await seedStarterMenu(conn, store.id);
      const navFields = { ...defaultFields('nav_menu'), show_search: false, show_account: true, show_cart: true, menu_id: starterMenuId };
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'logo', 0, ?)`,
        [store.id, JSON.stringify(logoFields)]
      );
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'nav_menu', 1, ?)`,
        [store.id, JSON.stringify(navFields)]
      );
    }

    const [[existingFooter]] = await conn.query(
      `SELECT id FROM ${TABLES.pageSections} WHERE store_id = ? AND page_id IS NULL AND region = 'footer' LIMIT 1`,
      [store.id]
    );
    if (!existingFooter) {
      // Empty `text` means "auto (c) <year> <store name>" at render time —
      // see the 'copyright' case in section.ejs — so the seeded default
      // looks exactly like today's hardcoded footer without baking a
      // specific year into the database.
      const copyrightFields = { ...defaultFields('copyright'), text: '', show_powered_by: true, show_admin_link: true };
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'copyright', 0, ?)`,
        [store.id, JSON.stringify(copyrightFields)]
      );
    }
  }
}

// nav_menu sections created before the WordPress-style Menus feature stored
// their links inline (fields.links, plus auto_categories/auto_pages flags)
// instead of pointing at a saved menu (fields.menu_id — see lib/menus.js).
// This converts each such section's old data into a real menu and points
// the section at it, so nothing a merchant already built goes blank the
// moment this ships. A store with more than one stale section (its header
// and its footer both had auto_categories, say) gets ONE shared migrated
// menu, not a duplicate per section, since they almost always want the
// same nav. Idempotent: a section that already has menu_id set (new
// sections, or ones already migrated) is left alone; a section with no
// links and both auto flags off is left alone too (menu_id stays null,
// same as if a merchant had never picked one).
async function migrateNavMenuSections(conn) {
  const [rows] = await conn.query(`SELECT id, store_id, fields FROM ${TABLES.pageSections} WHERE type = 'nav_menu'`);

  const staleByStore = new Map(); // store_id -> [{ id, fields }]
  for (const row of rows) {
    const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
    if (!fields || fields.menu_id) continue;
    const hasOldData = (Array.isArray(fields.links) && fields.links.length) || fields.auto_categories || fields.auto_pages;
    if (!hasOldData) continue;
    if (!staleByStore.has(row.store_id)) staleByStore.set(row.store_id, []);
    staleByStore.get(row.store_id).push({ id: row.id, fields });
  }
  if (!staleByStore.size) return;

  for (const [storeId, sections] of staleByStore) {
    const wantsCategories = sections.some((s) => s.fields.auto_categories);
    const wantsPages = sections.some((s) => s.fields.auto_pages);
    // Union of every stale section's manual links for this store, de-duped
    // by label+url so header and footer sections that happened to share
    // links don't produce two copies of each.
    const customLinks = [];
    const seenLinkKey = new Set();
    sections.forEach((s) => {
      (s.fields.links || []).forEach((l) => {
        const key = (l.label || '') + '|' + (l.url || '');
        if (seenLinkKey.has(key)) return;
        seenLinkKey.add(key);
        customLinks.push(l);
      });
    });

    const [menuResult] = await conn.query(`INSERT INTO ${TABLES.menus} (store_id, name) VALUES (?, 'Main menu')`, [storeId]);
    const menuId = menuResult.insertId;
    let position = 0;

    // Same order the old rendering used (categories, then pages, then
    // manual links — see the pre-migration 'nav_menu' case in
    // partials/section.ejs), so a migrated nav looks the same as before.
    if (wantsCategories) {
      const [categories] = await conn.query(`SELECT id, name FROM ${TABLES.categories} WHERE store_id = ? ORDER BY name`, [storeId]);
      for (const c of categories) {
        await conn.query(
          `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label) VALUES (?, NULL, ?, 'category', ?, ?)`,
          [menuId, position++, c.id, c.name]
        );
      }
    }
    if (wantsPages) {
      const [pages] = await conn.query(
        `SELECT id, name FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 0 AND status = 'published' ORDER BY name`,
        [storeId]
      );
      for (const p of pages) {
        await conn.query(
          `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label) VALUES (?, NULL, ?, 'page', ?, ?)`,
          [menuId, position++, p.id, p.name]
        );
      }
    }
    for (const l of customLinks) {
      const [itemResult] = await conn.query(
        `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label, url) VALUES (?, NULL, ?, 'custom', NULL, ?, ?)`,
        [menuId, position++, (l.label || 'Link').slice(0, 150), (l.url || '#').slice(0, 500)]
      );
      let childPos = 0;
      for (const c of l.children || []) {
        await conn.query(
          `INSERT INTO ${TABLES.menuItems} (menu_id, parent_id, position, type, target_id, label, url) VALUES (?, ?, ?, 'custom', NULL, ?, ?)`,
          [menuId, itemResult.insertId, childPos++, (c.label || 'Link').slice(0, 150), (c.url || '#').slice(0, 500)]
        );
      }
    }

    for (const s of sections) {
      const nextFields = { ...s.fields, menu_id: menuId };
      await conn.query(`UPDATE ${TABLES.pageSections} SET fields = ? WHERE id = ?`, [JSON.stringify(nextFields), s.id]);
    }
    console.log(`Migrated ${sections.length} nav_menu section(s) in store ${storeId} to a new "Main menu".`);
  }
}

// Adds customer_id to orders so a checkout can be linked to a pz_customers
// account. Nullable and ON DELETE SET NULL — guest checkout (no account)
// stays fully supported, and deleting a customer account never deletes
// their past orders.
async function migrateOrderCustomerColumn(conn) {
  if (!(await columnExists(conn, TABLES.orders, 'customer_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD COLUMN customer_id INT NULL`);
  }
  if (!(await foreignKeyExists(conn, TABLES.orders, 'customer_id'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.orders} ADD CONSTRAINT fk_${TABLES.orders}_customer FOREIGN KEY (customer_id) REFERENCES ${TABLES.customers}(id) ON DELETE SET NULL`
    );
  }
}

// WhatsApp order tracking, Phase 1 (no WhatsApp Business API — just a way to
// log a sale made over a WhatsApp chat and tell it apart from a real
// storefront checkout). Plain VARCHAR rather than an ENUM, same convention
// as pz_contacts.source above, so a future source ('instagram', 'phone', ...)
// never needs its own migration to exist. Existing rows all predate this
// column and are real storefront checkouts, so DEFAULT 'storefront' backfills
// them correctly with no separate UPDATE needed.
async function migrateOrderSourceColumn(conn) {
  if (!(await columnExists(conn, TABLES.orders, 'source'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'storefront'`);
  }
  if (!(await indexExists(conn, TABLES.orders, 'idx_order_source'))) {
    await conn.query(`ALTER TABLE ${TABLES.orders} ADD INDEX idx_order_source (source)`);
  }
}

// A store's own WhatsApp contact number (for the storefront's "Chat to order
// on WhatsApp" product-page link and the admin's "New order from WhatsApp"
// quick-create form) -- digits only, no '+' or spaces, e.g. '919876543210',
// so it can be dropped straight into a wa.me/<number> link. NULL means the
// store hasn't set one yet, in which case the storefront button and this
// order-source feature are both effectively off for that store.
async function migrateStoreWhatsappColumn(conn) {
  if (!(await columnExists(conn, TABLES.stores, 'whatsapp_number'))) {
    await conn.query(`ALTER TABLE ${TABLES.stores} ADD COLUMN whatsapp_number VARCHAR(20) NULL`);
  }
}

// ONE-TIME EXCEPTION to this file's "never drop data" rule: pz_admins is
// being fully replaced by pz_users + pz_user_roles. Every existing pz_admins
// row is copied forward first, then the (now-empty-of-value) table is
// dropped. Safe to run on every boot — it's a no-op once pz_admins is gone.
//
// pz_admins allowed the same email to be an independent admin row on more
// than one store (UNIQUE was store_id+email). pz_users.email is globally
// unique, so rows sharing an email are collapsed into ONE pz_users identity
// (using the most-recently-created row's name/password) with a
// pz_user_roles row per store it used to administer.
async function migrateAdminsToUsers(conn) {
  if (!(await tableExists(conn, TABLES.admins))) return;

  const [oldAdmins] = await conn.query(`SELECT * FROM ${TABLES.admins} ORDER BY created_at ASC`);

  const byEmail = new Map();
  for (const row of oldAdmins) {
    const key = row.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(row);
  }

  for (const [email, rows] of byEmail) {
    const latest = rows[rows.length - 1];

    let userId;
    const [[existingUser]] = await conn.query(`SELECT id FROM ${TABLES.users} WHERE email = ?`, [email]);
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const [result] = await conn.query(
        `INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`,
        [latest.name, email, latest.password_hash]
      );
      userId = result.insertId;
    }

    for (const row of rows) {
      await conn.query(
        `INSERT IGNORE INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')`,
        [userId, row.store_id]
      );
    }
  }

  await conn.query(`DROP TABLE ${TABLES.admins}`);
  console.log(`Migrated ${oldAdmins.length} pz_admins row(s) into pz_users/pz_user_roles and dropped pz_admins.`);
}

// Seeds the built-in 'default' theme (the design every store already has —
// now addressable as a theme in its own right, see
// views/storefront/themes/default/) and backfills an active pz_store_themes
// row for any store that doesn't have one yet, so routes/storefront.js's
// theme-resolution lookup always finds something. Safe to run on every boot.
// Registers/updates every theme found under themes/<slug>/theme.json in the
// pz_themes catalog, keeping the DB in sync with what's actually on disk —
// adding a theme becomes "drop its folder in and redeploy" rather than
// hand-writing an INSERT. This does NOT install a newly-found theme for any
// store (that stays a deliberate action, eventually via the marketplace) —
// it only makes the theme exist in the catalog at all. Safe to run on every
// boot; an existing theme's row is refreshed from its current manifest.
async function migrateThemesFromManifests(conn) {
  const themesDir = path.join(__dirname, '..', 'themes');
  let entries;
  try {
    entries = fs.readdirSync(themesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    return; // no themes/ directory yet — nothing to sync
  }

  for (const entry of entries) {
    const slug = entry.name;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(themesDir, slug, 'theme.json'), 'utf8'));
    } catch (err) {
      continue; // no/invalid theme.json in this folder — skip it
    }
    const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : slug;
    const version = typeof manifest.version === 'string' && manifest.version ? manifest.version : '1.0.0';
    const priceCents = Number.isInteger(manifest.price_cents) ? manifest.price_cents : 0;
    const description = typeof manifest.description === 'string' ? manifest.description : null;

    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.themes} WHERE slug = ?`, [slug]);
    if (existing) {
      await conn.query(
        `UPDATE ${TABLES.themes} SET name = ?, version = ?, price_cents = ?, description = ? WHERE id = ?`,
        [name, version, priceCents, description, existing.id]
      );
    } else {
      await conn.query(
        `INSERT INTO ${TABLES.themes} (slug, name, version, price_cents, status, description) VALUES (?, ?, ?, ?, 'published', ?)`,
        [slug, name, version, priceCents, description]
      );
      console.log(`Registered new theme "${slug}" (from themes/${slug}/theme.json) into pz_themes.`);
    }
  }
}

// Backfills an active pz_store_themes row (pointing at the 'default' theme)
// for any store that doesn't have one yet, so routes/storefront.js's
// theme-resolution lookup always finds something. Assumes
// migrateThemesFromManifests has already run this boot, so the 'default'
// theme's pz_themes row already exists — falls back to inserting it
// directly only in the unlikely case themes/default/theme.json is missing.
async function migrateStoreThemes(conn) {
  const [[existingDefault]] = await conn.query(`SELECT id FROM ${TABLES.themes} WHERE slug = ?`, ['default']);
  let defaultThemeId;
  if (existingDefault) {
    defaultThemeId = existingDefault.id;
  } else {
    const [result] = await conn.query(
      `INSERT INTO ${TABLES.themes} (slug, name, version, price_cents, status, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['default', 'Default', '1.0.0', 0, 'published', "PageZaper's built-in storefront theme."]
    );
    defaultThemeId = result.insertId;
    console.log('Default theme seeded into pz_themes (fallback — themes/default/theme.json was not found).');
  }

  const [storesWithoutActiveTheme] = await conn.query(
    `SELECT s.id FROM ${TABLES.stores} s
     LEFT JOIN ${TABLES.storeThemes} st ON st.store_id = s.id AND st.is_active = 1
     WHERE st.id IS NULL`
  );
  for (const s of storesWithoutActiveTheme) {
    await conn.query(
      `INSERT INTO ${TABLES.storeThemes} (store_id, theme_id, is_active) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [s.id, defaultThemeId]
    );
  }
  if (storesWithoutActiveTheme.length) {
    console.log(`Activated the default theme for ${storesWithoutActiveTheme.length} store(s) with no active theme.`);
  }
}

// Seeds the three existing plan slugs (PLANS above) into pz_plans with real
// prices, and the CRM app into pz_apps, bundling CRM into 'pro' by default
// (a 'starter' store can still buy it standalone once pz_store_apps has a
// real purchase flow wired up — see this file's comment above
// TABLES.planApps). Safe to run on every boot: an existing row is left
// alone once created, so a price changed later from platform-admin is never
// silently overwritten here. price_cents is paise (INR) throughout, same
// convention as pz_themes' own price_cents column.
//
// NOTE: the plan prices below (Starter ₹1,000/mo, Pro ₹5,000/mo) reflect
// what was actually decided; the CRM app's own standalone price does NOT —
// it's seeded at 0 as a placeholder since no standalone price was set, and
// should be updated from platform-admin (or here) before any store is
// actually charged for it on its own.
// Adds pz_apps.scope to an existing install (fresh installs already get it
// from the CREATE TABLE above). 'store' (the default, matching every app
// before this) installs per-store via pz_store_apps; 'account' installs per
// pz_users login via pz_user_apps instead -- CRM is the first 'account' app,
// set explicitly below in migrateSeedPlansAndApps. Must run before that
// function so the column exists by the time it tries to set it.
// Adds pz_contacts.tags to an existing install (fresh installs already get
// it from the CREATE TABLE above).
async function migrateContactsTagsColumn(conn) {
  if (!(await tableExists(conn, TABLES.contacts))) return;
  if (!(await columnExists(conn, TABLES.contacts, 'tags'))) {
    await conn.query(`ALTER TABLE ${TABLES.contacts} ADD COLUMN tags JSON NULL AFTER source`);
  }
}

// Lets a lead be created with no site at all (see the CREATE TABLE comment
// above) -- relaxes store_id to nullable and adds owner_user_id for that
// case. columnIsNullable lets this skip the MODIFY on an install that's
// already been migrated, same idempotency pattern as every migrate*
// function in this file.
async function migrateContactsOptionalStore(conn) {
  if (!(await tableExists(conn, TABLES.contacts))) return;
  if (!(await columnIsNullable(conn, TABLES.contacts, 'store_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.contacts} MODIFY COLUMN store_id INT NULL`);
  }
  if (!(await columnExists(conn, TABLES.contacts, 'owner_user_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.contacts} ADD COLUMN owner_user_id INT NULL AFTER store_id`);
  }
  if (!(await foreignKeyExists(conn, TABLES.contacts, 'owner_user_id'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.contacts} ADD FOREIGN KEY (owner_user_id) REFERENCES ${TABLES.users}(id) ON DELETE CASCADE`
    );
  }
}

async function migrateAppsScopeColumn(conn) {
  if (!(await tableExists(conn, TABLES.apps))) return;
  if (!(await columnExists(conn, TABLES.apps, 'scope'))) {
    await conn.query(`ALTER TABLE ${TABLES.apps} ADD COLUMN scope VARCHAR(10) NOT NULL DEFAULT 'store' AFTER slug`);
  }
}

// Adds the Tasks-panel fields (description, priority) to an existing
// install and relaxes contact_id to nullable so a task can be "standalone"
// -- not attached to any contact. Fresh installs already get this shape
// from the CREATE TABLE above; crm_subtasks is a brand-new table on both,
// so it needs no migrate function (CREATE TABLE IF NOT EXISTS covers it).
// Adds contacts.is_customer (see the CREATE TABLE comment) and marks every
// contact that was already linked to a store login as a customer, so nobody
// silently moves back to Leads. Only the column add is guarded, so the
// backfill runs exactly once, on the run that adds it.
async function migrateContactsIsCustomer(conn) {
  if (!(await tableExists(conn, TABLES.contacts))) return;
  if (await columnExists(conn, TABLES.contacts, 'is_customer')) return;
  await conn.query(`ALTER TABLE ${TABLES.contacts} ADD COLUMN is_customer TINYINT(1) NOT NULL DEFAULT 0 AFTER customer_id`);
  await conn.query(`UPDATE ${TABLES.contacts} SET is_customer = 1 WHERE customer_id IS NOT NULL`);
}

async function migrateCrmTasksEnhancements(conn) {
  if (!(await tableExists(conn, TABLES.crmTasks))) return;
  if (!(await columnExists(conn, TABLES.crmTasks, 'description'))) {
    await conn.query(`ALTER TABLE ${TABLES.crmTasks} ADD COLUMN description MEDIUMTEXT NULL AFTER title`);
  }
  if (!(await columnExists(conn, TABLES.crmTasks, 'priority'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.crmTasks} ADD COLUMN priority ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium' AFTER description`
    );
  }
  if (!(await columnIsNullable(conn, TABLES.crmTasks, 'contact_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.crmTasks} MODIFY COLUMN contact_id INT NULL`);
  }
}

// Adds the "has this follow-up's due-date reminder been emailed yet" column
// (see lib/reminders.js) to an existing install. Fresh installs already get
// this shape from the CREATE TABLE above.
async function migrateFollowupReminderColumn(conn) {
  if (!(await tableExists(conn, TABLES.crmFollowups))) return;
  if (!(await columnExists(conn, TABLES.crmFollowups, 'reminder_sent_at'))) {
    await conn.query(`ALTER TABLE ${TABLES.crmFollowups} ADD COLUMN reminder_sent_at TIMESTAMP NULL AFTER done_at`);
  }
}

// Adds the definition_id column/FK (see lib/metaobjects.js) tying a
// pz_listings row to its metaobject schema, for an existing install whose
// pz_listings predates the metaobject system. Fresh installs already get
// this shape from the CREATE TABLE above; pz_metaobject_definitions itself
// needs no migration (a brand-new table -- CREATE TABLE IF NOT EXISTS
// already covers every install, new or old).
async function migrateListingsMetaobjects(conn) {
  if (!(await tableExists(conn, TABLES.listings))) return;
  if (!(await columnExists(conn, TABLES.listings, 'definition_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.listings} ADD COLUMN definition_id INT NULL AFTER store_id`);
  }
  if (!(await foreignKeyExists(conn, TABLES.listings, 'definition_id'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.listings} ADD FOREIGN KEY (definition_id) REFERENCES ${TABLES.metaobjectDefinitions}(id) ON DELETE CASCADE`
    );
  }
  if (!(await indexExists(conn, TABLES.listings, 'idx_listing_definition'))) {
    await conn.query(`ALTER TABLE ${TABLES.listings} ADD INDEX idx_listing_definition (definition_id)`);
  }
}

async function migrateSeedPlansAndApps(conn) {
  const planSeed = [
    { slug: 'free', name: 'Free', price_cents: 0 },
    { slug: 'starter', name: 'Starter', price_cents: 100000 }, // ₹1,000/mo
    { slug: 'pro', name: 'Pro', price_cents: 500000 }, // ₹5,000/mo
  ];
  const planIds = {};
  for (const p of planSeed) {
    const [[existing]] = await conn.query(`SELECT id FROM ${TABLES.plans} WHERE slug = ?`, [p.slug]);
    if (existing) {
      planIds[p.slug] = existing.id;
    } else {
      const [result] = await conn.query(
        `INSERT INTO ${TABLES.plans} (slug, name, price_cents) VALUES (?, ?, ?)`,
        [p.slug, p.name, p.price_cents]
      );
      planIds[p.slug] = result.insertId;
    }
  }

  // CRM is 'account'-scoped (works across every store one login runs, via
  // pz_user_apps) rather than 'store'-scoped like every app before it — see
  // migrateAppsScopeColumn above. The UPDATE below only fires the one time
  // it's needed: an install that seeded this row before scope existed would
  // otherwise be stuck showing CRM as a plain per-store app forever.
  const [[existingCrmApp]] = await conn.query(`SELECT id, scope FROM ${TABLES.apps} WHERE slug = 'crm'`);
  let crmAppId;
  if (existingCrmApp) {
    crmAppId = existingCrmApp.id;
    if (existingCrmApp.scope !== 'account') {
      await conn.query(`UPDATE ${TABLES.apps} SET scope = 'account' WHERE id = ?`, [crmAppId]);
    }
  } else {
    const [result] = await conn.query(
      `INSERT INTO ${TABLES.apps} (slug, name, price_cents, description, scope) VALUES (?, ?, ?, ?, ?)`,
      ['crm', 'CRM', 0, 'Contacts, leads, tasks and follow-ups across every site you run.', 'account']
    );
    crmAppId = result.insertId;
  }

  if (planIds.pro) {
    const [[existingBundle]] = await conn.query(
      `SELECT id FROM ${TABLES.planApps} WHERE plan_id = ? AND app_id = ?`,
      [planIds.pro, crmAppId]
    );
    if (!existingBundle) {
      await conn.query(`INSERT INTO ${TABLES.planApps} (plan_id, app_id) VALUES (?, ?)`, [planIds.pro, crmAppId]);
    }
  }
}

// Each catalog theme can point at a real, fully-built store to use as its
// public "View demo" showcase (see middleware/tenant.js's storeUrl usage in
// routes/admin.js's /store/themes + views/admin/store-themes.ejs) — the same
// idea as Shopify's Theme Store "View demo store" button, which opens an
// actual merchant-style store built to show off that specific theme, not a
// shared one just recolored. Adds the pz_themes.demo_store_id column, points
// the 'default' theme at the existing seeded Demo Store, and — the first
// time this runs — builds a second, dedicated store ("Leaf & Bloom", a small
// plant shop) with its own categories/products/pages/header/footer and PZ
// Starter active, tailored to show off that theme's circular category
// badges, pill buttons, minimal product cards and sage-tinted sections.
// Fully idempotent: every insert below is gated on "does this already
// exist", so re-running on a later boot only fills in anything still
// missing rather than duplicating content a merchant (or this function
// itself, last boot) already created.
async function migrateThemeDemoStores(conn, demoStoreId) {
  const { defaultFields } = require('../lib/sections');

  if (!(await columnExists(conn, TABLES.themes, 'demo_store_id'))) {
    await conn.query(`ALTER TABLE ${TABLES.themes} ADD COLUMN demo_store_id INT NULL`);
  }
  if (!(await foreignKeyExists(conn, TABLES.themes, 'demo_store_id'))) {
    await conn.query(
      `ALTER TABLE ${TABLES.themes} ADD CONSTRAINT fk_${TABLES.themes}_demo_store FOREIGN KEY (demo_store_id) REFERENCES ${TABLES.stores}(id) ON DELETE SET NULL`
    );
  }

  // 'default' theme's demo is simply the existing Demo Store — it's already
  // a reasonably full generic catalog, and it's what a merchant sees first
  // (Store Admin > Edit Store > Themes) so it doubles as a live example
  // without building anything new.
  await conn.query(
    `UPDATE ${TABLES.themes} SET demo_store_id = ? WHERE slug = 'default' AND demo_store_id IS NULL`,
    [demoStoreId]
  );

  const [[pzStarterTheme]] = await conn.query(`SELECT id, demo_store_id FROM ${TABLES.themes} WHERE slug = 'pz-starter'`);
  if (!pzStarterTheme) return; // theme not registered yet (no themes/pz-starter/theme.json) — nothing to link up

  // Subdomain carries a 'demo-' prefix — never a bare word like 'leafbloom' —
  // so it can't collide with a merchant's own store address. The whole
  // 'demo-' prefix is blocked at signup (see RESERVED_SUBDOMAINS /
  // isReservedSubdomain below), so this is safe for any number of future
  // per-theme demo stores without having to name each one individually.
  // Named after the theme's own slug ('pz-starter' -> 'demo-pzstarter'),
  // not the store's brand name, so it's obvious at a glance which theme a
  // demo subdomain belongs to.
  const LEAFBLOOM_SUBDOMAIN = 'demo-pzstarter';

  // Naming has moved twice as this convention settled: bare 'leafbloom'
  // (before the 'demo-' prefix reservation existed), then 'demo-leafbloom'
  // (brand name instead of theme slug), now 'demo-pzstarter'. Self-heal
  // from EITHER legacy name by renaming the existing row in place — so
  // this works no matter which earlier version of this migration last ran
  // on a given server — instead of creating a duplicate demo store. Only
  // renames when nothing has already claimed the current name (extremely
  // unlikely, but never clobber a real row).
  for (const legacySubdomain of ['leafbloom', 'demo-leafbloom']) {
    const [[legacyRow]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [legacySubdomain]);
    if (!legacyRow) continue;
    const [[targetTaken]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [LEAFBLOOM_SUBDOMAIN]);
    if (!targetTaken) {
      await conn.query(`UPDATE ${TABLES.stores} SET subdomain = ? WHERE id = ?`, [LEAFBLOOM_SUBDOMAIN, legacyRow.id]);
      console.log(`Renamed legacy demo store subdomain '${legacySubdomain}' -> '${LEAFBLOOM_SUBDOMAIN}' (store_id=${legacyRow.id}).`);
    }
    break; // only one legacy row can exist at a time in practice
  }

  const [[existingLeafBloom]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [LEAFBLOOM_SUBDOMAIN]);
  let leafBloomId = existingLeafBloom && existingLeafBloom.id;

  if (!leafBloomId) {
    console.log('Building "Leaf & Bloom" — the PZ Starter theme\'s dedicated demo store...');

    const [storeResult] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status) VALUES ('Leaf & Bloom', ?, 'default', 'free', 'active')`,
      [LEAFBLOOM_SUBDOMAIN]
    );
    leafBloomId = storeResult.insertId;

    // A real, logged-in-able owner account (documented password below) so
    // this can still be opened and tweaked in the normal admin builder like
    // any other store — same as how a theme partner maintains their own
    // Shopify demo stores.
    const demoOwnerEmail = 'demo+leafbloom@pagezaper.local';
    const [[existingUser]] = await conn.query(`SELECT id FROM ${TABLES.users} WHERE email = ?`, [demoOwnerEmail]);
    let ownerId;
    if (existingUser) {
      ownerId = existingUser.id;
    } else {
      const passwordHash = bcrypt.hashSync('leafbloom-demo', 10);
      const [userResult] = await conn.query(
        `INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES ('Leaf & Bloom', ?, ?)`,
        [demoOwnerEmail, passwordHash]
      );
      ownerId = userResult.insertId;
    }
    await conn.query(
      `INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')
       ON DUPLICATE KEY UPDATE role = role`,
      [ownerId, leafBloomId]
    );

    // ---- Categories + products ----
    const PLANT_PRODUCTS = [
      { title: 'Monstera Deliciosa', slug: 'monstera-deliciosa', description: 'A statement Swiss-cheese-leaf plant that thrives in bright, indirect light.', price: 899, compare_at_price: 1099, image_url: 'https://images.unsplash.com/photo-1614594975525-e45190c55d0b?w=600', category: 'Houseplants', stock: 24 },
      { title: 'Golden Pothos', slug: 'golden-pothos', description: 'The easiest houseplant there is — trailing vines that forgive a missed watering or two.', price: 449, compare_at_price: null, image_url: 'https://images.unsplash.com/photo-1602923668104-8f9e03e77c31?w=600', category: 'Houseplants', stock: 40 },
      { title: 'Snake Plant', slug: 'snake-plant', description: 'Architectural, near-indestructible, and one of the best plants for low light.', price: 549, compare_at_price: 649, image_url: 'https://images.unsplash.com/photo-1572688484438-313a6e50c333?w=600', category: 'Houseplants', stock: 32 },
      { title: 'String of Pearls', slug: 'string-of-pearls', description: 'Trailing bead-like succulent, beautiful spilling out of a hanging planter.', price: 399, compare_at_price: null, image_url: 'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?w=600', category: 'Succulents', stock: 28 },
      { title: 'Echeveria Rosette', slug: 'echeveria-rosette', description: 'A classic blue-green rosette succulent that loves a sunny windowsill.', price: 349, compare_at_price: 429, image_url: 'https://images.unsplash.com/photo-1459156212016-c812468e2115?w=600', category: 'Succulents', stock: 45 },
      { title: 'Fiddle Leaf Fig', slug: 'fiddle-leaf-fig', description: 'The showstopper — tall, glossy violin-shaped leaves for a bright corner.', price: 1599, compare_at_price: 1899, image_url: 'https://images.unsplash.com/photo-1597055181300-e3246d4d7b64?w=600', category: 'Outdoor Plants', stock: 12 },
      { title: 'Lavender Bush', slug: 'lavender-bush', description: 'Fragrant, pollinator-friendly, and happiest in a sunny outdoor spot.', price: 429, compare_at_price: null, image_url: 'https://images.unsplash.com/photo-1499002238440-d264edd596ec?w=600', category: 'Outdoor Plants', stock: 22 },
      { title: 'Barrel Cactus', slug: 'barrel-cactus', description: 'Low-maintenance desert charm — waters itself out of a neglect, basically.', price: 299, compare_at_price: null, image_url: 'https://images.unsplash.com/photo-1509937528035-ad76254b0356?w=600', category: 'Desert Bloom', stock: 30 },
      { title: 'Terracotta Planter Set', slug: 'terracotta-planter-set', description: 'Set of 3 hand-thrown terracotta pots with drainage, in graduated sizes.', price: 699, compare_at_price: 899, image_url: 'https://images.unsplash.com/photo-1485955900006-10f4d324d411?w=600', category: 'Desert Bloom', stock: 18 },
    ];
    const catIds = {};
    for (const name of [...new Set(PLANT_PRODUCTS.map((p) => p.category))]) {
      const [result] = await conn.query(`INSERT INTO ${TABLES.categories} (store_id, name) VALUES (?, ?)`, [leafBloomId, name]);
      catIds[name] = result.insertId;
    }
    for (const p of PLANT_PRODUCTS) {
      await conn.query(
        `INSERT INTO ${TABLES.products} (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [leafBloomId, p.title, p.slug, p.description, p.price, p.compare_at_price, p.image_url, catIds[p.category], p.stock]
      );
    }

    // ---- Pages: Home (with body sections) + a simple About page ----
    const [homeResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Home', '/', 1, 'published')`,
      [leafBloomId]
    );
    const homeId = homeResult.insertId;
    const [aboutResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'About', '/about-us', 0, 'published')`,
      [leafBloomId]
    );
    const aboutId = aboutResult.insertId;
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'richtext', 0, ?)`,
      [aboutId, JSON.stringify({ ...defaultFields('richtext'), heading: 'Our story', body: 'Leaf & Bloom started on a single crowded windowsill and grew from there. Every plant we sell is nursery-raised, hand-inspected before it ships, and comes with a care card so it actually survives the trip home.', width: 'narrow', align: 'center' })]
    );

    const homeSections = [
      { type: 'hero', fields: { ...defaultFields('hero'), heading: 'Bring the Outdoors In', subheading: 'Hand-picked houseplants, succulents and planters, delivered to your door.', bg_type: 'image', bg_image_url: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1600', bg_overlay: true, text_theme: 'light' } },
      { type: 'row', fields: { columns: [
        { width: 1, blocks: [{ id: 'blk_lb_badge1', type: 'richtext', fields: { heading: 'Free Shipping', body: 'On orders over ₹999', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_lb_badge2', type: 'richtext', fields: { heading: 'Hand-Packed', body: 'Every plant boxed with care', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_lb_badge3', type: 'richtext', fields: { heading: '30-Day Guarantee', body: 'Arrives healthy, or it’s replaced', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_lb_badge4', type: 'richtext', fields: { heading: 'Real Plant People', body: 'Care advice, always free', width: 'narrow', align: 'center' }, element_styles: {} }] },
      ] } },
      { type: 'products', fields: { ...defaultFields('products'), heading: 'Trending Plants', limit: 8 } },
      { type: 'hero', fields: { ...defaultFields('hero'), heading: '20% Off All Succulents This Week', subheading: "Use code SUCCULENT20 at checkout — while stock lasts.", bg_type: 'color', bg_color: '#233318', bg_overlay: false, text_theme: 'light' } },
      { type: 'collections', fields: { ...defaultFields('collections'), heading: 'Shop by Category', cols: '3' } },
      { type: 'text_image', fields: { ...defaultFields('text_image'), heading: 'Your Neighborhood Plant Shop', body: 'We believe a home isn’t finished until something in it is growing. Whether you’re a seasoned plant parent or killing your first pothos, our team picks every plant for how well it’ll actually do in a real home — not just how it looks on a shelf.', side: 'right', image_url: 'https://images.unsplash.com/photo-1526397751294-331021109fbd?w=900' } },
      { type: 'testimonials', fields: { ...defaultFields('testimonials'), heading: 'What our customers say', quotes: [
        { quote: 'My monstera arrived in perfect shape and is already pushing out a new leaf. Packaging was so thoughtful.', author: 'Priya S.' },
        { quote: 'Finally a snake plant that didn’t show up half-dead. This is my third order.', author: 'Daniel K.' },
        { quote: 'The care card alone is worth it — I’ve kept every plant alive for once.', author: 'Marisol T.' },
      ] } },
      { type: 'newsletter', fields: { ...defaultFields('newsletter'), heading: 'Get 10% off your first order', subtext: 'Plant care tips and new arrivals, straight to your inbox.', button: 'Subscribe' } },
    ];
    let pos = 0;
    for (const s of homeSections) {
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, ?, ?, ?)`,
        [homeId, s.type, pos++, JSON.stringify(s.fields)]
      );
    }

    // ---- Header / footer (page_id NULL = store-wide default) ----
    const menuId = await seedStarterMenu(conn, leafBloomId);
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'promo_bar', 0, ?)`,
      [leafBloomId, JSON.stringify({ ...defaultFields('promo_bar'), text: 'Free shipping on orders over ₹999' })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'logo', 1, ?)`,
      [leafBloomId, JSON.stringify(defaultFields('logo'))]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'nav_menu', 2, ?)`,
      [leafBloomId, JSON.stringify({ ...defaultFields('nav_menu'), menu_id: menuId, show_search: false, show_account: true, show_cart: true })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'link_columns', 0, ?)`,
      [leafBloomId, JSON.stringify({ columns: [
        { heading: 'Shop', links: [{ label: 'Houseplants', url: '/?category=Houseplants' }, { label: 'Succulents', url: '/?category=Succulents' }] },
        { heading: 'Support', links: [{ label: 'About us', url: '/pages/about-us' }, { label: 'Contact', url: '/pages/about-us' }] },
      ] })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'social_icons', 1, ?)`,
      [leafBloomId, JSON.stringify({ links: [{ platform: 'instagram', url: '#' }, { platform: 'pinterest', url: '#' }, { platform: 'facebook', url: '#' }] })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'copyright', 2, ?)`,
      [leafBloomId, JSON.stringify({ ...defaultFields('copyright'), text: '', show_powered_by: true, show_admin_link: true })]
    );

    console.log(`"Leaf & Bloom" demo store created (store_id=${leafBloomId}, subdomain=${LEAFBLOOM_SUBDOMAIN}, owner ${demoOwnerEmail} / leafbloom-demo).`);
  }

  await conn.query(`UPDATE ${TABLES.themes} SET demo_store_id = ? WHERE id = ? AND demo_store_id IS NULL`, [leafBloomId, pzStarterTheme.id]);

  // Make sure PZ Starter is actually the ACTIVE theme on its own demo store
  // (installed but inactive is not enough — a fresh install defaults to
  // 'default') so the demo genuinely shows PZ Starter, not a fallback.
  const [[pzStarterInstall]] = await conn.query(
    `SELECT id, is_active FROM ${TABLES.storeThemes} WHERE store_id = ? AND theme_id = ?`,
    [leafBloomId, pzStarterTheme.id]
  );
  if (!pzStarterInstall) {
    await conn.query(`INSERT INTO ${TABLES.storeThemes} (store_id, theme_id, is_active) VALUES (?, ?, 1)`, [leafBloomId, pzStarterTheme.id]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ? AND theme_id != ?`, [leafBloomId, pzStarterTheme.id]);
  } else if (!pzStarterInstall.is_active) {
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ?`, [leafBloomId]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 1 WHERE id = ?`, [pzStarterInstall.id]);
  }
}

// The Recruit theme's demo store — same idea as migrateThemeDemoStores'
// "Leaf & Bloom" above, but Recruit's own content model isn't products: its
// listing.ejs view (views/storefront/themes/recruit/) is the generic
// Metaobjects entry-detail template (see lib/metaobjects.js), so this demo's
// "products" are Job Openings, a Metaobject definition seeded with real
// field types (select/text/boolean/url) and entries, shown on the storefront
// through a 'listings' page-builder section (routes/storefront.js /
// lib/sections.js) exactly the way a 'products' section shows a category.
// Fully idempotent, same "does this already exist" gating as
// migrateThemeDemoStores. Depends on migrateListingsMetaobjects (the
// pz_listings/pz_metaobject_* tables) having already run this boot.
async function migrateRecruitDemoStore(conn) {
  const { defaultFields } = require('../lib/sections');

  const [[recruitTheme]] = await conn.query(`SELECT id, demo_store_id FROM ${TABLES.themes} WHERE slug = 'recruit'`);
  if (!recruitTheme) return; // theme not registered yet (no themes/recruit/theme.json) — nothing to link up

  // Same 'demo-' prefix convention as Leaf & Bloom's LEAFBLOOM_SUBDOMAIN
  // above (see isReservedSubdomain) — named after the theme slug so it's
  // obvious at a glance which theme a demo subdomain belongs to.
  const RECRUIT_SUBDOMAIN = 'demo-recruit';

  const [[existingRecruitDemo]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = ?`, [RECRUIT_SUBDOMAIN]);
  let recruitStoreId = existingRecruitDemo && existingRecruitDemo.id;

  if (!recruitStoreId) {
    console.log('Building "Sterling & Cole Recruiting" — the Recruit theme\'s dedicated demo store...');

    const [storeResult] = await conn.query(
      `INSERT INTO ${TABLES.stores} (name, subdomain, theme, plan, status) VALUES ('Sterling & Cole Recruiting', ?, 'default', 'free', 'active')`,
      [RECRUIT_SUBDOMAIN]
    );
    recruitStoreId = storeResult.insertId;

    // A real, logged-in-able owner account, same convention as Leaf & Bloom's.
    const demoOwnerEmail = 'demo+recruit@pagezaper.local';
    const [[existingUser]] = await conn.query(`SELECT id FROM ${TABLES.users} WHERE email = ?`, [demoOwnerEmail]);
    let ownerId;
    if (existingUser) {
      ownerId = existingUser.id;
    } else {
      const passwordHash = bcrypt.hashSync('recruit-demo', 10);
      const [userResult] = await conn.query(
        `INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES ('Sterling & Cole Recruiting', ?, ?)`,
        [demoOwnerEmail, passwordHash]
      );
      ownerId = userResult.insertId;
    }
    await conn.query(
      `INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')
       ON DUPLICATE KEY UPDATE role = role`,
      [ownerId, recruitStoreId]
    );

    // ---- Metaobject type: "Job Opening" (handle 'jobs' -> /jobs/<slug>) ----
    const [defResult] = await conn.query(
      `INSERT INTO ${TABLES.metaobjectDefinitions} (store_id, name, handle) VALUES (?, 'Job Opening', 'jobs')`,
      [recruitStoreId]
    );
    const jobDefId = defResult.insertId;

    const JOB_FIELDS = [
      { key: 'department', label: 'Department', type: 'select', required: 1, options: ['Finance', 'Technology', 'Sales & Marketing', 'Operations', 'Executive'] },
      { key: 'location', label: 'Location', type: 'text', required: 1, options: null },
      { key: 'employment_type', label: 'Employment Type', type: 'select', required: 1, options: ['Full-time', 'Part-time', 'Contract'] },
      { key: 'salary_range', label: 'Salary Range', type: 'text', required: 0, options: null },
      { key: 'remote_friendly', label: 'Remote-Friendly', type: 'boolean', required: 0, options: null },
      { key: 'apply_url', label: 'Apply Link', type: 'url', required: 0, options: null },
    ];
    let fieldPos = 0;
    for (const f of JOB_FIELDS) {
      await conn.query(
        `INSERT INTO ${TABLES.metaobjectFields} (definition_id, field_key, label, type, required, options, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [jobDefId, f.key, f.label, f.type, f.required, f.options ? JSON.stringify(f.options) : null, fieldPos++]
      );
    }

    // ---- Entries: real-looking Job Opening listings ----
    const JOB_OPENINGS = [
      { title: 'Senior Financial Analyst', slug: 'senior-financial-analyst', description: 'Lead monthly close, forecasting and board reporting for a fast-growing FMCG client. Chartered Accountant or equivalent, 5+ years in FP&A.', image_url: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=600', department: 'Finance', location: 'Mumbai, Maharashtra', employment_type: 'Full-time', salary_range: '₹14L – ₹18L per year', remote_friendly: false, apply_url: '#' },
      { title: 'Backend Engineer (Node.js)', slug: 'backend-engineer-nodejs', description: 'Own core services for a Series B fintech platform. Strong Node.js, MySQL and system-design fundamentals expected.', image_url: 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600', department: 'Technology', location: 'Bengaluru, Karnataka', employment_type: 'Full-time', salary_range: '₹18L – ₹26L per year', remote_friendly: true, apply_url: '#' },
      { title: 'Regional Sales Manager', slug: 'regional-sales-manager', description: 'Build and run a 6-person field sales team across Western India for an industrial-equipment manufacturer.', image_url: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=600', department: 'Sales & Marketing', location: 'Pune, Maharashtra', employment_type: 'Full-time', salary_range: '₹12L – ₹16L + incentives', remote_friendly: false, apply_url: '#' },
      { title: 'HR Business Partner', slug: 'hr-business-partner', description: 'Partner with department heads at a 400-person BPO on hiring, performance cycles and retention.', image_url: 'https://images.unsplash.com/photo-1521791136064-7986c2920216?w=600', department: 'Operations', location: 'Gurugram, Haryana', employment_type: 'Full-time', salary_range: '₹10L – ₹14L per year', remote_friendly: false, apply_url: '#' },
      { title: 'Contract Data Analyst', slug: 'contract-data-analyst', description: 'Six-month engagement building dashboards and pipeline reporting for a logistics client. SQL and Power BI required.', image_url: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600', department: 'Technology', location: 'Hyderabad, Telangana', employment_type: 'Contract', salary_range: '₹60,000 – ₹90,000 per month', remote_friendly: true, apply_url: '#' },
      { title: 'Chief Operating Officer', slug: 'chief-operating-officer', description: 'Retained search for a COO to scale operations at a Series C D2C brand ahead of its next funding round.', image_url: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=600', department: 'Executive', location: 'Delhi NCR', employment_type: 'Full-time', salary_range: 'Confidential', remote_friendly: false, apply_url: '#' },
      { title: 'Digital Marketing Executive', slug: 'digital-marketing-executive', description: 'Run paid social and performance campaigns for a D2C skincare brand launching in three new cities this year.', image_url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600', department: 'Sales & Marketing', location: 'Chennai, Tamil Nadu', employment_type: 'Full-time', salary_range: '₹6L – ₹9L per year', remote_friendly: true, apply_url: '#' },
      { title: 'Supply Chain Coordinator', slug: 'supply-chain-coordinator', description: 'Coordinate inbound logistics and vendor schedules for a textiles exporter, roughly 20 hours a week.', image_url: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=600', department: 'Operations', location: 'Ahmedabad, Gujarat', employment_type: 'Part-time', salary_range: '₹4L – ₹6L per year (pro-rated)', remote_friendly: false, apply_url: '#' },
    ];
    for (const j of JOB_OPENINGS) {
      const details = {
        department: j.department,
        location: j.location,
        employment_type: j.employment_type,
        salary_range: j.salary_range,
        remote_friendly: j.remote_friendly,
        apply_url: j.apply_url,
      };
      await conn.query(
        `INSERT INTO ${TABLES.listings} (store_id, definition_id, listing_type, title, slug, description, image_url, status, details)
         VALUES (?, ?, 'jobs', ?, ?, ?, ?, 'active', ?)`,
        [recruitStoreId, jobDefId, j.title, j.slug, j.description, j.image_url, JSON.stringify(details)]
      );
    }

    // ---- Pages: Home (with body sections), About, Services, Contact ----
    const [homeResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Home', '/', 1, 'published')`,
      [recruitStoreId]
    );
    const homeId = homeResult.insertId;
    const [aboutResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'About', '/about-us', 0, 'published')`,
      [recruitStoreId]
    );
    const aboutId = aboutResult.insertId;
    const [servicesResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Services', '/services', 0, 'published')`,
      [recruitStoreId]
    );
    const servicesId = servicesResult.insertId;
    const [contactResult] = await conn.query(
      `INSERT INTO ${TABLES.pages} (store_id, name, path, is_home, status) VALUES (?, 'Contact', '/contact', 0, 'published')`,
      [recruitStoreId]
    );
    const contactId = contactResult.insertId;

    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'richtext', 0, ?)`,
      [aboutId, JSON.stringify({ ...defaultFields('richtext'), heading: 'About Sterling & Cole', body: 'Sterling & Cole has placed candidates across finance, technology, sales and operations roles for fifteen years. We run every search the same way: a real conversation with the hiring manager first, a shortlist built on fit rather than keyword-matching second, and a process fast enough that good candidates don’t take another offer while we deliberate.', width: 'narrow', align: 'center' })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'richtext', 0, ?)`,
      [servicesId, JSON.stringify({ ...defaultFields('richtext'), heading: 'What We Do', body: 'Executive Search for leadership and board-level hires, retained end to end. Permanent Staffing for full-time roles across finance, tech, sales and operations. Contract Staffing when you need experienced talent fast, without a long-term commitment. RPO for companies that want their whole recruiting function run by a dedicated outside team.', width: 'wide', align: 'center' })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields) VALUES (?, 'richtext', 0, ?)`,
      [contactId, JSON.stringify({ ...defaultFields('richtext'), heading: 'Get in Touch', body: 'Hiring for a role, or looking for your next one? Write to us at hello@sterlingcole.example or call +91 98765 43210 — a consultant replies within one business day. Offices in Mumbai, Bengaluru and Delhi NCR.', width: 'narrow', align: 'center' })]
    );

    // Recruit's own navy accent (themes/recruit/theme.json's color_primary)
    // repeated here as a literal, not read from the token system -- these
    // two sections intentionally paint themselves in the theme's brand
    // color via the universal Style-tab bg_color/text_color columns (same
    // mechanism any merchant uses from the builder), the same navy-band-
    // on-cream rhythm the theme's reference design uses for its stat strip
    // and closing CTA. Kept in sync with theme.json's color_primary/
    // color_primary_dark by hand since this raw INSERT can't read a JS
    // import of the manifest.
    const RECRUIT_NAVY = '#10305a';
    const homeSections = [
      // bg_type left at its 'none' default (see defaultFields('hero')) --
      // a plain, uncluttered ground behind serif type, not a photo, is the
      // whole point of this theme's redesigned hero.
      { type: 'hero', fields: { ...defaultFields('hero'), heading: 'Recruiting the People Who Move Your Business Forward', subheading: 'Executive search, permanent staffing and contract talent — matched by consultants who work your industry.' } },
      { type: 'row', fields: { columns: [
        { width: 1, blocks: [{ id: 'blk_rec_svc1', type: 'richtext', fields: { heading: 'Executive Search', body: 'C-suite and leadership hires, retained.', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_rec_svc2', type: 'richtext', fields: { heading: 'Permanent Staffing', body: 'Full-time roles, end to end.', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_rec_svc3', type: 'richtext', fields: { heading: 'Contract Staffing', body: 'Flexible talent, fast turnaround.', width: 'narrow', align: 'center' }, element_styles: {} }] },
        { width: 1, blocks: [{ id: 'blk_rec_svc4', type: 'richtext', fields: { heading: 'RPO', body: 'Your recruiting team, outsourced.', width: 'narrow', align: 'center' }, element_styles: {} }] },
      ] } },
      { type: 'listings', fields: { ...defaultFields('listings'), heading: 'Current Openings', definition_id: jobDefId, limit: 8 } },
      { type: 'stats', bg_color: RECRUIT_NAVY, text_color: '#ffffff', fields: { items: [
        { value: '2,400+', label: 'Candidates placed' },
        { value: '180+', label: 'Client companies' },
        { value: '15 yrs', label: 'In business' },
        { value: '92%', label: 'Roles filled within 30 days' },
      ] } },
      { type: 'text_image', fields: { ...defaultFields('text_image'), heading: 'A Recruiting Partner, Not Just a Vendor', body: 'Every search starts with a real conversation about the role, the team and what “good” looks like for you — not a job description forwarded to a database. That’s why most of our clients call us back for the next role, too.', side: 'right', image_url: 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=900' } },
      { type: 'testimonials', fields: { ...defaultFields('testimonials'), heading: 'What clients say', quotes: [
        { quote: 'They understood our engineering culture better than recruiters we’d worked with for years. Every shortlist was hireable.', author: 'VP Engineering, Series B fintech' },
        { quote: 'Filled a COO search we’d struggled with for six months, in five weeks.', author: 'Founder, D2C brand' },
        { quote: 'Straightforward, fast, and they actually called us back. Rare in this industry.', author: 'Head of HR, logistics company' },
      ] } },
      { type: 'newsletter', bg_color: RECRUIT_NAVY, text_color: '#ffffff', fields: { ...defaultFields('newsletter'), heading: 'Ready to build your team or your career?', subtext: 'Tell us what you’re hiring for — or what you’re looking for — and we’ll get back to you within one business day.', button: 'Submit a Brief' } },
    ];
    let pos = 0;
    for (const s of homeSections) {
      await conn.query(
        `INSERT INTO ${TABLES.pageSections} (page_id, type, position, fields, bg_color, text_color) VALUES (?, ?, ?, ?, ?, ?)`,
        [homeId, s.type, pos++, JSON.stringify(s.fields), s.bg_color || null, s.text_color || null]
      );
    }

    // ---- Header / footer (page_id NULL = store-wide default) ----
    const menuId = await seedStarterMenu(conn, recruitStoreId);
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'promo_bar', 0, ?)`,
      [recruitStoreId, JSON.stringify({ ...defaultFields('promo_bar'), text: 'Now hiring for 40+ roles across India' })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'logo', 1, ?)`,
      [recruitStoreId, JSON.stringify(defaultFields('logo'))]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'header', 'nav_menu', 2, ?)`,
      [recruitStoreId, JSON.stringify({ ...defaultFields('nav_menu'), menu_id: menuId, show_search: false, show_account: false, show_cart: false })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'link_columns', 0, ?)`,
      [recruitStoreId, JSON.stringify({ columns: [
        { heading: 'Company', links: [{ label: 'About us', url: '/pages/about-us' }, { label: 'Services', url: '/pages/services' }, { label: 'Contact', url: '/pages/contact' }] },
        { heading: 'Candidates', links: [{ label: 'Browse openings', url: '/' }, { label: 'Submit your resume', url: '/pages/contact' }] },
      ] })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'social_icons', 1, ?)`,
      [recruitStoreId, JSON.stringify({ links: [{ platform: 'linkedin', url: '#' }, { platform: 'instagram', url: '#' }] })]
    );
    await conn.query(
      `INSERT INTO ${TABLES.pageSections} (store_id, page_id, region, type, position, fields) VALUES (?, NULL, 'footer', 'copyright', 2, ?)`,
      [recruitStoreId, JSON.stringify({ ...defaultFields('copyright'), text: '', show_powered_by: true, show_admin_link: true })]
    );

    console.log(`"Sterling & Cole Recruiting" demo store created (store_id=${recruitStoreId}, subdomain=${RECRUIT_SUBDOMAIN}, owner ${demoOwnerEmail} / recruit-demo).`);
  }

  await conn.query(`UPDATE ${TABLES.themes} SET demo_store_id = ? WHERE id = ? AND demo_store_id IS NULL`, [recruitStoreId, recruitTheme.id]);

  // Make sure Recruit is actually the ACTIVE theme on its own demo store —
  // installed but inactive is not enough, a fresh install defaults to
  // 'default'. Same pattern as migrateThemeDemoStores' pzStarterInstall.
  const [[recruitInstall]] = await conn.query(
    `SELECT id, is_active FROM ${TABLES.storeThemes} WHERE store_id = ? AND theme_id = ?`,
    [recruitStoreId, recruitTheme.id]
  );
  if (!recruitInstall) {
    await conn.query(`INSERT INTO ${TABLES.storeThemes} (store_id, theme_id, is_active) VALUES (?, ?, 1)`, [recruitStoreId, recruitTheme.id]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ? AND theme_id != ?`, [recruitStoreId, recruitTheme.id]);
  } else if (!recruitInstall.is_active) {
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 0 WHERE store_id = ?`, [recruitStoreId]);
    await conn.query(`UPDATE ${TABLES.storeThemes} SET is_active = 1 WHERE id = ?`, [recruitInstall.id]);
  }
}

// migrateRecruitDemoStore above only WRITES its hero/row/stats/etc content
// the very first time it runs (its `if (!recruitStoreId)` block) -- correct
// for a brand-new demo store, but it means a later content-only revision to
// that function (e.g. this theme's redesign: dropping the hero's photo
// background, painting the stats band and closing CTA in the theme's own
// navy) never reaches a demo store that was already created on an earlier
// boot. This is the fix-up for exactly that: re-applies the current hero/
// stats/newsletter field values (and their bg_color/text_color) to the
// EXISTING demo store's Home page sections by type, every boot. Cheap and
// fully idempotent (plain UPDATEs, no inserts), so it's harmless to leave
// running indefinitely rather than deleting it once every server has
// picked it up. If a merchant ever customizes this specific demo store by
// hand those edits would be overwritten -- acceptable here since this is
// the platform's own showcase store, not a real merchant's.
async function migrateRecruitDemoRedesign(conn) {
  const { defaultFields } = require('../lib/sections');

  const [[recruitStore]] = await conn.query(`SELECT id FROM ${TABLES.stores} WHERE subdomain = 'demo-recruit'`);
  if (!recruitStore) return; // demo store doesn't exist yet -- migrateRecruitDemoStore will create it with current content directly
  const recruitStoreId = recruitStore.id;

  const [[homePage]] = await conn.query(`SELECT id FROM ${TABLES.pages} WHERE store_id = ? AND is_home = 1`, [recruitStoreId]);
  if (!homePage) return;
  const homeId = homePage.id;

  const RECRUIT_NAVY = '#10305a';

  await conn.query(
    `UPDATE ${TABLES.pageSections} SET fields = ?, bg_color = NULL, text_color = NULL WHERE page_id = ? AND type = 'hero'`,
    [
      JSON.stringify({ ...defaultFields('hero'), heading: 'Recruiting the People Who Move Your Business Forward', subheading: 'Executive search, permanent staffing and contract talent — matched by consultants who work your industry.' }),
      homeId,
    ]
  );
  await conn.query(
    `UPDATE ${TABLES.pageSections} SET bg_color = ?, text_color = ? WHERE page_id = ? AND type = 'stats'`,
    [RECRUIT_NAVY, '#ffffff', homeId]
  );
  await conn.query(
    `UPDATE ${TABLES.pageSections} SET fields = ?, bg_color = ?, text_color = ? WHERE page_id = ? AND type = 'newsletter'`,
    [
      JSON.stringify({ ...defaultFields('newsletter'), heading: 'Ready to build your team or your career?', subtext: 'Tell us what you’re hiring for — or what you’re looking for — and we’ll get back to you within one business day.', button: 'Submit a Brief' }),
      RECRUIT_NAVY,
      '#ffffff',
      homeId,
    ]
  );
}

async function init() {
  const conn = await pool.getConnection();
  try {
    await renameLegacyTables(conn);

    const statements = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await conn.query(stmt);
    }

    const demoStoreId = await migrateMultiTenancy(conn);
    await migratePagesForExistingStores(conn);
    await migratePagesFormColumn(conn);
    await migrateProductCategoryLinks(conn);
    await migratePageSectionSettings(conn);
    await migrateSectionStyleColumns(conn);
    await migrateHeaderFooterSections(conn);
    await migrateDefaultHeaderFooter(conn);
    await migrateNavMenuSections(conn);
    await migrateOrderDiscountColumns(conn);
    await migrateOrderCustomerColumn(conn);
    await migrateOrderSourceColumn(conn);
    await migrateStoreWhatsappColumn(conn);
    await migrateAdminsToUsers(conn);
    await migrateThemesFromManifests(conn);
    await migrateStoreThemes(conn);
    await migrateContactsTagsColumn(conn);
    await migrateContactsOptionalStore(conn);
    await migrateCrmTasksEnhancements(conn);
    await migrateFollowupReminderColumn(conn);
    await migrateListingsMetaobjects(conn);
    await migrateContactsIsCustomer(conn);
    await migrateAppsScopeColumn(conn);
    await migrateSeedPlansAndApps(conn);
    await migrateThemeDemoStores(conn, demoStoreId);
    await migrateRecruitDemoStore(conn);
    await migrateRecruitDemoRedesign(conn);

    const [[{ c: productCount }]] = await conn.query(`SELECT COUNT(*) AS c FROM ${TABLES.products} WHERE store_id = ?`, [demoStoreId]);

    if (productCount === 0) {
      const categoryNames = [...new Set(SAMPLE_PRODUCTS.map((p) => p.category))];
      const catIds = {};
      for (const name of categoryNames) {
        const [[existingCat]] = await conn.query(`SELECT id FROM ${TABLES.categories} WHERE store_id = ? AND name = ?`, [demoStoreId, name]);
        if (existingCat) {
          catIds[name] = existingCat.id;
        } else {
          const [result] = await conn.query(`INSERT INTO ${TABLES.categories} (store_id, name) VALUES (?, ?)`, [demoStoreId, name]);
          catIds[name] = result.insertId;
        }
      }

      for (const p of SAMPLE_PRODUCTS) {
        await conn.query(
          `INSERT INTO ${TABLES.products} (store_id, title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [demoStoreId, p.title, p.slug, p.description, p.price, p.compare_at_price, p.image_url, catIds[p.category], p.stock]
        );
      }

      console.log('Demo store seeded with sample products.');
    }

    const [[{ c: demoAdminCount }]] = await conn.query(
      `SELECT COUNT(*) AS c FROM ${TABLES.userRoles} WHERE store_id = ? AND role = 'admin'`,
      [demoStoreId]
    );
    if (demoAdminCount === 0) {
      const demoEmail = 'admin@pagezaper.test';
      const [[existingUser]] = await conn.query(`SELECT id FROM ${TABLES.users} WHERE email = ?`, [demoEmail]);
      let userId;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const passwordHash = bcrypt.hashSync('admin123', 10);
        const [result] = await conn.query(`INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`, [
          'Store Admin',
          demoEmail,
          passwordHash,
        ]);
        userId = result.insertId;
      }
      await conn.query(`INSERT INTO ${TABLES.userRoles} (user_id, store_id, role) VALUES (?, ?, 'admin')`, [userId, demoStoreId]);
      console.log('Demo store admin created (admin@pagezaper.test / admin123)');
    }

    // Platform super-admin: separate account/table from per-store admins,
    // used to manage ALL stores from one place (see routes/platformAdmin.js).
    // Override the seeded credentials via env vars in production.
    const [[{ c: platformAdminCount }]] = await conn.query(`SELECT COUNT(*) AS c FROM ${TABLES.platformAdmins}`);
    if (platformAdminCount === 0) {
      const email = process.env.PLATFORM_ADMIN_EMAIL || 'superadmin@pagezaper.com';
      const password = process.env.PLATFORM_ADMIN_PASSWORD || 'changeme123';
      const passwordHash = bcrypt.hashSync(password, 10);
      await conn.query(`INSERT INTO ${TABLES.platformAdmins} (name, email, password_hash) VALUES (?, ?, ?)`, [
        'Platform Admin',
        email,
        passwordHash,
      ]);
      console.log(`Platform admin created (${email} / ${password}) - change this password.`);
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, init, THEMES, PLANS, RESERVED_SUBDOMAINS, isReservedSubdomain, TABLES };
