// PageZaper server entrypoint (pz_users/pz_user_roles/pz_customers schema)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

const { pool, init } = require('./db/database');
const { resolveStore, getBaseDomain, adminPortalUrl } = require('./middleware/tenant');
const { DEFAULT_THEME_SLUG, themeViewPrefix } = require('./lib/themes');
const platformRoutes = require('./routes/platform');
const platformAdminRoutes = require('./routes/platformAdmin');
const storefrontRoutes = require('./routes/storefront');
const adminRoutes = require('./routes/admin');
const { attachCartInfo } = require('./middleware/cart');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_DOMAIN = getBaseDomain();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  if (!req.body) req.body = {}; // guard against requests with no/unrecognized body
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Figure out which store (if any) this request's subdomain belongs to,
// before anything else runs — routes below rely on req.store.
app.use(resolveStore(pool));

// Session cookie: shared across every *.BASE_DOMAIN subdomain so a merchant
// who logs in (or signs up) on the root domain stays logged in when they're
// sent on to their own store's subdomain. It's the same Express app and
// session store handling every subdomain either way; this just controls
// which hosts the browser will send the cookie back to.
const cookieConfig = { maxAge: 1000 * 60 * 60 * 24 * 7 }; // 7 days
if (BASE_DOMAIN && BASE_DOMAIN !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(BASE_DOMAIN)) {
  cookieConfig.domain = `.${BASE_DOMAIN}`;
}
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: cookieConfig,
  })
);
app.use(flash());

// Make flash messages & cart count available in every view
app.use(attachCartInfo(pool));
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.admin = req.session.admin || null;
  res.locals.customer = req.session.customer || null;
  res.locals.platformAdmin = req.session.platformAdmin || null;
  res.locals.impersonation = req.session.impersonation || null;
  // Single login gateway for staff (Admin/Manager) — admin.pagezaper.com.
  // Any "Store admin" / "Log in" link for staff should use this, not a
  // relative /login or /admin/login.
  res.locals.loginUrl = adminPortalUrl(req, '/login');
  next();
});

app.use('/', platformRoutes);
// Mounted before storefrontRoutes: storefrontRoutes' catch-all guard 404s
// any root-domain request it doesn't recognize, which would otherwise
// swallow /platform-admin before this router ever saw it.
app.use('/platform-admin', platformAdminRoutes);
app.use('/', storefrontRoutes);
app.use('/admin', adminRoutes);

// 404 — no store context here (this catches /admin, /platform-admin, and
// root-domain paths too), so always the built-in default theme's 404 page.
app.use((req, res) => {
  res.status(404).render(`${themeViewPrefix(DEFAULT_THEME_SLUG)}/404`, { title: 'Page not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Check the server logs for details.');
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PageZaper running at http://localhost:${PORT} (base domain: ${BASE_DOMAIN})`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
