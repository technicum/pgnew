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
]);

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
  orders: `${PREFIX}orders`,
  orderItems: `${PREFIX}order_items`,
  pages: `${PREFIX}pages`,
  pageSections: `${PREFIX}page_sections`,
  // WordPress-style save history for the section builder — see the CREATE
  // TABLE comment below for the full scoping/pruning story.
  pageSectionRevisions: `${PREFIX}page_section_revisions`,
  newsletterSubscribers: `${PREFIX}newsletter_subscribers`,
  platformAdmins: `${PREFIX}platform_admins`,
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
  const hit = rows.find((r) => r.col_count === 1 && r.matches === 1);
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
    await migratePageSectionSettings(conn);
    await migrateHeaderFooterSections(conn);
    await migrateDefaultHeaderFooter(conn);
    await migrateNavMenuSections(conn);
    await migrateOrderDiscountColumns(conn);
    await migrateOrderCustomerColumn(conn);
    await migrateAdminsToUsers(conn);
    await migrateThemesFromManifests(conn);
    await migrateStoreThemes(conn);

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

module.exports = { pool, init, THEMES, PLANS, RESERVED_SUBDOMAINS, TABLES };
