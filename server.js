// PageZaper server entrypoint (pz_users/pz_user_roles/pz_customers schema)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

const { pool, init, TABLES } = require('./db/database');
const { resolveStore, getBaseDomain, adminPortalUrl, rootUrl, storeUrl } = require('./middleware/tenant');
const { DEFAULT_THEME_SLUG, themeViewPrefix } = require('./lib/themes');
const { themeDefaultTokens } = require('./lib/themeTokens');
const { SOCIAL_ICON_SVGS } = require('./lib/socialIcons');
const platformRoutes = require('./routes/platform');
const platformAdminRoutes = require('./routes/platformAdmin');
const storefrontRoutes = require('./routes/storefront');
const adminRoutes = require('./routes/admin');
const { attachCartInfo } = require('./middleware/cart');
const remindersLib = require('./lib/reminders');

const app = express();
// Falls back to 3000 when PORT isn't set in the environment (e.g. local dev).
const PORT = process.env.PORT || 3000;
const BASE_DOMAIN = getBaseDomain();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

// A cache-busting value for static assets that change behavior, not just
// looks (right now: the page/header/footer builder's own JS/CSS) — appended
// as a "?v=" query param in views/admin/builder.ejs. Changes on every server
// start, so a deploy (git pull + pm2 restart) always forces browsers to
// fetch the new file instead of silently running a stale cached one against
// an updated server — exactly what happened before this existed: the old
// autosave-based admin-builder.js kept running in already-open tabs (and any
// tab that loaded from cache) after the server switched to the explicit
// Save + revisions model, so its "Saved"/"Save" UI looked present but the
// click handlers behind it were the old ones (or missing entirely).
// Available in every view via app.locals, no per-route wiring needed.
app.locals.assetVersion = Date.now();

// Shared "18 Sept 2026" formatting for a CRM task's due date, used anywhere
// one shows up as read-only text (task/subtask list rows) -- not the
// <input type="date"> fields, which the browser formats itself per the
// visitor's own locale/OS settings and can't be overridden from the server.
// Spelled out by hand (not Intl's 'short' month, which gives "Sep") so it
// reads exactly like the requested "18 Sept 2026", everywhere, regardless
// of the server's ICU data/locale.
const DUE_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
app.locals.formatDueDate = (d) => {
  if (!d) return '';
  const date = new Date(d);
  return `${date.getDate()} ${DUE_DATE_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

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
  // The account-level "Your sites" screen (routes/platform.js's /dashboard) —
  // where a merchant with more than one store picks which to work on. Used
  // by the store admin sidebar's "Exit store" link (views/admin/partials/
  // header.ejs) to get back there without a relative link that would try to
  // resolve against the STORE's own subdomain instead.
  res.locals.accountDashboardUrl = adminPortalUrl(req, '/dashboard');
  next();
});

// The 'social_icons' footer section's per-platform icon glyphs (see
// lib/socialIcons.js) — set globally rather than per-route since
// section.ejs/block.ejs render it wherever a store's footer happens to show
// up (every storefront page, not just ones with dedicated route handling).
app.use((req, res, next) => {
  res.locals.socialIcons = SOCIAL_ICON_SVGS;
  next();
});

// The page-builder's 'form' section embeds one of the store's own forms by
// id (pz_forms — see lib/forms.js) — that lookup needs a per-store DB query,
// unlike the two static constants above, so it lives in routes/storefront.js
// (res.locals.storeForms, right next to storePages) rather than here: it
// only actually matters for storefront page renders, not every request this
// app serves (admin, platform, the theme marketplace, ...).

// themes.pagezaper.com — the public theme marketplace (see middleware/
// tenant.js's isThemeMarketplace handling). Lists every published catalog
// theme (pz_themes.status = 'published' — the same set routes/admin.js's
// own /store/themes gallery treats as installable) for a visitor who isn't
// logged into any store yet, so there's no per-store "install"/"activate"
// here — just a look, a live demo link where one exists, and a way into
// signup. Every path on this subdomain hits this same listing (there's
// nothing else here yet).
app.use(async (req, res, next) => {
  if (req.isThemeMarketplace) {
    try {
      const [rows] = await pool.query(
        `SELECT t.slug, t.name, t.description, t.price_cents, s.subdomain AS demo_subdomain
         FROM ${TABLES.themes} t
         LEFT JOIN ${TABLES.stores} s ON s.id = t.demo_store_id
         WHERE t.status = 'published'
         ORDER BY t.price_cents ASC, t.name ASC`
      );
      const themes = rows.map((t) => {
        const tokens = themeDefaultTokens(t.slug);
        return {
          ...t,
          swatchFrom: tokens.color_primary,
          swatchTo: tokens.color_primary_dark,
          demoUrl: t.demo_subdomain ? storeUrl(req, t.demo_subdomain, '/') : null,
        };
      });
      return res.status(200).render('theme-marketplace', {
        title: 'Theme Marketplace',
        themes,
        rootUrl: rootUrl(req),
        signupUrl: rootUrl(req, '/signup'),
      });
    } catch (err) {
      return next(err);
    }
  }
  if (req.isAppMarketplace) {
    return res.status(200).render('marketplace-coming-soon', {
      title: 'App Marketplace',
      eyebrow: 'App Marketplace',
      description: "Browse and install apps that extend your PageZaper store. We're still building this out — check back shortly.",
      rootUrl: rootUrl(req),
    });
  }
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

    // Daily CRM follow-up reminder emails (see lib/reminders.js). The
    // function itself is a no-op except once per IST calendar day, so this
    // interval just controls how promptly after 8am IST today's batch goes
    // out -- not a real per-tick cost. Runs once immediately too, in case
    // the server started after 8am and today's batch hasn't gone out yet.
    const runReminders = () => {
      remindersLib
        .maybeRunDailyReminders()
        .then((result) => {
          if (result) console.log(`CRM reminders: emailed ${result.emailsSent} recipient(s), ${result.remindersSent} follow-up(s).`);
        })
        .catch((err) => console.error('CRM reminders check failed:', err));
    };
    runReminders();
    setInterval(runReminders, 30 * 60 * 1000);
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
