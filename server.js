require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

const { pool, init } = require('./db/database');
const storefrontRoutes = require('./routes/storefront');
const adminRoutes = require('./routes/admin');
const { attachCartInfo } = require('./middleware/cart');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  if (!req.body) req.body = {}; // guard against requests with no/unrecognized body
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
  })
);
app.use(flash());

// Make flash messages & cart count available in every view
app.use(attachCartInfo(pool));
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.admin = req.session.admin || null;
  next();
});

app.use('/', storefrontRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('storefront/404', { title: 'Page not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Check the server logs for details.');
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PageZaper running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
