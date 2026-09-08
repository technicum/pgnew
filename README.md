# PageZaper

A working e-commerce platform (Shopify-style) built with Node.js, Express, and MySQL.

## What's included

- **Storefront**: product listing with category filters, product detail pages, a session-based cart, and a checkout flow that creates a real order in the database.
- **Admin dashboard**: secure login, product management (create/edit/delete, stock, pricing, categories), order list and detail view with status updates (pending → paid → shipped → delivered), and a small stats overview (revenue, order count, low-stock alerts).
- **Database**: MySQL, with the schema created automatically on first run and seeded with sample products.

This is a solid single-store foundation. It is **not** multi-tenant (i.e. it doesn't yet let many merchants each run their own store like Shopify does) — see "Where to take this next" below for what that would involve.

## Requirements

- Node.js 18+
- A MySQL or MariaDB server (5.7+/10.3+)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create the database and a user (adjust the password):
   ```sql
   CREATE DATABASE pagezaper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'pagezaper_user'@'localhost' IDENTIFIED BY 'your-password-here';
   GRANT ALL PRIVILEGES ON pagezaper.* TO 'pagezaper_user'@'localhost';
   FLUSH PRIVILEGES;
   ```

3. Copy `.env.example` to `.env` and fill in your database credentials and a random session secret:
   ```bash
   cp .env.example .env
   ```

4. Start the app:
   ```bash
   node server.js
   ```
   On first run it will create all tables and seed sample products automatically.

5. Visit `http://localhost:3000` for the storefront.

6. Visit `http://localhost:3000/admin/login` for the admin panel. Default account:
   - Email: `admin@pagezaper.test`
   - Password: `admin123`

   **Change this password (or create a new admin and delete this one) before putting the site anywhere public.**

## Project structure

```
server.js              App entry point
db/database.js         MySQL connection pool, schema, and seed data
routes/storefront.js   Customer-facing routes (home, product, cart, checkout)
routes/admin.js        Admin routes (auth, products, orders)
middleware/auth.js     Admin session guard
middleware/cart.js     Session cart helpers
views/storefront/      Customer-facing EJS templates
views/admin/           Admin EJS templates
public/css/            Stylesheets
```

## Deploying on Hostinger

Hostinger's regular shared hosting plans are built for PHP, not Node.js — if you're on one of those plans, this app won't run there directly. Hostinger's **Business** and higher shared plans, and its **VPS** plans, do support Node.js apps (via their hPanel "Node.js" setup or a VPS you control). Either way:

1. Create a MySQL database from hPanel (or your VPS) and note the host/user/password/database name — Hostinger's MySQL host is usually `localhost` when the app and database are on the same server.
2. Upload the project (excluding `node_modules`) and run `npm install --production` on the server.
3. Set the environment variables from `.env.example` in Hostinger's Node.js app settings (or a `.env` file on the VPS).
4. Set the app's entry point to `server.js` and the port to whatever Hostinger assigns (read from `process.env.PORT`, which the app already does).
5. Point your domain at the app and, ideally, put it behind HTTPS (Hostinger issues free SSL certificates).

If you're on a plan that only supports PHP, the practical path is either upgrading to a Node-compatible plan/VPS, or having me build the equivalent on PHP/MySQL instead (which would run on your existing Hostinger shared hosting).

## Where to take this next

Roughly in order of what a real launch would need:

- **Payments**: currently checkout is Cash-on-Delivery only. Adding Stripe or Razorpay is the biggest missing piece for a real store.
- **Product images**: currently image URLs are typed in manually. Real image upload (with resizing) would use `multer` (already installed) plus storage (local disk or S3-compatible).
- **Customer accounts**: there's no customer login/order history yet — checkout is guest-only.
- **Multi-tenancy**: if the goal is an actual Shopify-style platform (many merchants, each with their own store), that's a significant architecture change — every table would need a `store_id`, subdomains or custom domains per store, and a merchant-facing signup/billing flow. Worth a separate conversation before building, since it changes the data model from the ground up.
- **Search & pagination**: fine for a small catalog now; add MySQL full-text search or pagination once the catalog grows.
- **Email**: order confirmations are shown on-screen but not emailed yet (e.g. via Nodemailer + an SMTP provider).
