// Slotpay server entrypoint — homepage + signup/login/dashboard, same stack
// as PageZaper (Node/Express + EJS views, public/ served statically) so
// this can grow into a full app the same way PageZaper did.
//
// Loads .env the same way PageZaper's server.js did — the VPS's nginx
// forwards pagezaper.com to a specific port (PORT=3001 in production's
// .env), and without this the app falls back to its 3000 default while
// nginx still points at 3001, which is a silent 503 (nginx can't reach
// anything on 3001) rather than a crash you'd see in the logs.
require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { findUserByEmail, createUser, verifyPassword, toPublicUser } = require('./lib/users');

const app = express();
// Falls back to 3000 when PORT isn't set in the environment (e.g. local dev
// with no .env file at all).
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  // Falls back to a fixed dev secret so `node server.js` works with no
  // .env at all; set SESSION_SECRET in production's .env for real signing.
  secret: process.env.SESSION_SECRET || 'slotpay-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
  },
}));

// Placeholder brand strings, kept in one place so renaming the product
// later is a one-line change instead of hunting through views/*.ejs.
const SITE_NAME = 'Slotpay';
const SITE_DOMAIN = 'slotpay.page';

// Makes siteName/siteDomain available in every view without passing them
// explicitly on every res.render call.
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  res.locals.siteDomain = SITE_DOMAIN;
  res.locals.currentUser = req.session.user || null;
  next();
});

function redirectIfLoggedIn(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

app.get('/', (req, res) => {
  res.render('index', {
    title: `${SITE_NAME} — One page. Every way you earn.`,
  });
});

app.get('/signup', redirectIfLoggedIn, (req, res) => {
  res.render('signup', {
    title: `Create your page — ${SITE_NAME}`,
    error: null,
    values: { name: '', email: '' },
  });
});

app.post('/signup', redirectIfLoggedIn, async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm || '';

  const rerender = (error) => res.status(400).render('signup', {
    title: `Create your page — ${SITE_NAME}`,
    error,
    values: { name, email },
  });

  if (!name || !email || !password) return rerender('Fill in your name, email and a password to continue.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return rerender('That email address doesn’t look right.');
  if (password.length < 8) return rerender('Use at least 8 characters for your password.');
  if (password !== confirm) return rerender('Those passwords don’t match.');

  try {
    const user = await createUser({ name, email, password });
    req.session.user = toPublicUser(user);
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return rerender('An account with that email already exists — try logging in instead.');
    console.error('Signup failed:', err);
    rerender('Something went wrong creating your account. Please try again.');
  }
});

app.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('login', {
    title: `Log in — ${SITE_NAME}`,
    error: null,
    values: { email: '' },
  });
});

app.post('/login', redirectIfLoggedIn, async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  const rerender = (error) => res.status(400).render('login', {
    title: `Log in — ${SITE_NAME}`,
    error,
    values: { email },
  });

  if (!email || !password) return rerender('Enter your email and password.');

  const user = findUserByEmail(email);
  const ok = user && await verifyPassword(user, password);
  if (!ok) return rerender('That email and password don’t match an account.');

  req.session.user = toPublicUser(user);
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  const user = req.session.user;
  const today = new Date();
  res.render('dashboard', {
    title: `Overview — ${SITE_NAME}`,
    user,
    todayLabel: today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
  });
});

app.listen(PORT, () => {
  console.log(`Slotpay running on port ${PORT}`);
});
