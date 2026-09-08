require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

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
const RESERVED_SUBDOMAINS = new Set([
  'www', 'admin', 'api', 'app', 'mail', 'ftp', 'blog', 'help', 'support',
  'static', 'cdn', 'assets', 'shop', 'store', 'dashboard', 'signup', 'login',
  'signin', 'signout', 'register', 'test', 'staging', 'dev', 'my', 'account',
  'billing', 'docs', 'status', 'pagezaper',
]);

// All table names go through this prefix, so PageZaper's tables are easy to
// pick out if this database is ever shared with another app. Every route
// file imports TABLES from here rather than hardcoding table names.
const PREFIX = process.env.DB_PREFIX || 'pz_';
const TABLES = {
  stores: `${PREFIX}stores`,
  admins: `${PREFIX}admins`,
  categories: `${PREFIX}categories`,
  products: `${PREFIX}products`,
  orders: `${PREFIX}orders`,
  orderItems: `${PREFIX}order_items`,
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

CREATE TABLE IF NOT EXISTS ${TABLES.admins} (
  id INT AUTO_INCREMENT PRIMARY KEY,
  store_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (store_id) REFERENCES ${TABLES.stores}(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_store_admin_email (store_id, email)
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
  const tenantTables = [TABLES.admins, TABLES.categories, TABLES.products, TABLES.orders];

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
    { table: TABLES.admins, column: 'email', indexName: 'uniq_store_admin_email' },
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

async function init() {
  const conn = await pool.getConnection();
  try {
    await renameLegacyTables(conn);

    const statements = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await conn.query(stmt);
    }

    const demoStoreId = await migrateMultiTenancy(conn);

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

    const [[{ c: demoAdminCount }]] = await conn.query(`SELECT COUNT(*) AS c FROM ${TABLES.admins} WHERE store_id = ?`, [demoStoreId]);
    if (demoAdminCount === 0) {
      const passwordHash = bcrypt.hashSync('admin123', 10);
      await conn.query(`INSERT INTO ${TABLES.admins} (store_id, name, email, password_hash) VALUES (?, ?, ?, ?)`, [
        demoStoreId,
        'Store Admin',
        'admin@pagezaper.test',
        passwordHash,
      ]);
      console.log('Demo store admin created (admin@pagezaper.test / admin123)');
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, init, THEMES, RESERVED_SUBDOMAINS, TABLES };
