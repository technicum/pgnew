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

// ---------- Schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  compare_at_price DECIMAL(10,2) NULL,
  image_url VARCHAR(1000),
  category_id INT NULL,
  stock INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_category (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
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
  INDEX idx_order_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NULL,
  title VARCHAR(255) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  quantity INT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
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

async function init() {
  const conn = await pool.getConnection();
  try {
    // Run each statement in the schema separately (mysql2 needs multipleStatements for this,
    // so split on the ';' that ends each CREATE TABLE block).
    const statements = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await conn.query(stmt);
    }

    const [[{ c: productCount }]] = await conn.query('SELECT COUNT(*) AS c FROM products');

    if (productCount === 0) {
      const categoryNames = [...new Set(SAMPLE_PRODUCTS.map((p) => p.category))];
      const catIds = {};
      for (const name of categoryNames) {
        const [result] = await conn.query('INSERT INTO categories (name) VALUES (?)', [name]);
        catIds[name] = result.insertId;
      }

      for (const p of SAMPLE_PRODUCTS) {
        await conn.query(
          `INSERT INTO products (title, slug, description, price, compare_at_price, image_url, category_id, stock, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [p.title, p.slug, p.description, p.price, p.compare_at_price, p.image_url, catIds[p.category], p.stock]
        );
      }

      const passwordHash = bcrypt.hashSync('admin123', 10);
      await conn.query('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)', [
        'Store Admin',
        'admin@pagezaper.test',
        passwordHash,
      ]);

      console.log('Database seeded with sample products and default admin (admin@pagezaper.test / admin123)');
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, init };
