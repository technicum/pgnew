// "Continue with Google" — sign up or log in with a Google account.
//
// Plain OAuth 2.0 authorization-code flow, no extra packages: Node's built-in
// fetch talks to Google's token and userinfo endpoints. Turned on by setting
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env; without them the button
// is hidden and the routes 404, so the app still runs fine without it.
//
// GOOGLE_REDIRECT_URL is optional. By default the callback is
// <this request's origin>/auth/google/callback, e.g.
// https://pagezaper.com/auth/google/callback — that exact URL must be listed
// under "Authorised redirect URIs" in the Google Cloud console.
//
// Who gets logged in, in order:
//   1. an account already linked to this Google account (google_id),
//   2. an account with the same (Google-verified) email — it gets linked,
//      so someone who signed up with a password can also use Google,
//   3. otherwise a new account is created from the Google name and email.
const crypto = require('crypto');
const { findUserByGoogleId, findUserByEmail, linkGoogleId, createGoogleUser, toPublicUser } = require('./users');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function googleEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URL || `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

// The Google account behind an authorization code: { sub, email, name }.
async function fetchGoogleProfile(code, req) {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    throw new Error(`Google token exchange failed: ${token.error || tokenRes.status} ${token.error_description || ''}`.trim());
  }

  const infoRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const info = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !info.sub) throw new Error(`Google userinfo failed: ${infoRes.status}`);
  return info;
}

async function userForProfile(info) {
  const byGoogle = await findUserByGoogleId(info.sub);
  if (byGoogle) return byGoogle;

  const email = String(info.email || '').trim().toLowerCase();
  // Only trust the email for linking/creating when Google says it's verified.
  if (!email || info.email_verified === false || info.email_verified === 'false') {
    const err = new Error('Google did not share a verified email address.');
    err.code = 'GOOGLE_NO_EMAIL';
    throw err;
  }

  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    await linkGoogleId(byEmail.id, info.sub);
    return byEmail;
  }

  const name = String(info.name || info.given_name || email.split('@')[0]).trim().slice(0, 120);
  return createGoogleUser({ name, email, googleId: info.sub });
}

function installGoogleAuth(app, { siteName }) {
  app.use((req, res, next) => {
    res.locals.googleEnabled = googleEnabled();
    next();
  });

  const backToLogin = (req, res, message) => res.status(400).render('login', {
    title: `Log in — ${siteName}`,
    error: message,
    values: { email: '' },
  });

  app.get('/auth/google', (req, res, next) => {
    if (!googleEnabled()) return next();
    if (req.session.user) return res.redirect('/dashboard');
    const state = crypto.randomBytes(24).toString('hex');
    req.session.googleState = state;
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    })}`;
    // Save before leaving, so the state is in the store when Google sends
    // the visitor back.
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  });

  app.get('/auth/google/callback', async (req, res, next) => {
    if (!googleEnabled()) return next();
    const expected = req.session.googleState;
    delete req.session.googleState;

    if (req.query.error) {
      // e.g. access_denied when they press Cancel on Google's screen.
      return res.redirect('/login');
    }
    const state = String(req.query.state || '');
    if (!expected || !state || state.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return backToLogin(req, res, 'That Google sign-in expired. Please try again.');
    }
    if (!req.query.code) return backToLogin(req, res, 'Google sign-in didn’t complete. Please try again.');

    try {
      const info = await fetchGoogleProfile(String(req.query.code), req);
      const user = await userForProfile(info);
      // Suspended by an admin (Platform admin → Users): no sign-in.
      if (user.status === 'suspended') return backToLogin(req, res, 'This account has been suspended. If you think this is a mistake, contact support.');
      // New session id on login, so a session id set before login can't be reused.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = toPublicUser(user);
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/dashboard')));
      });
    } catch (err) {
      if (err.code === 'GOOGLE_NO_EMAIL') return backToLogin(req, res, 'Your Google account didn’t share a verified email, so we couldn’t sign you in.');
      console.error('Google sign-in failed:', err);
      backToLogin(req, res, 'Something went wrong signing in with Google. Please try again.');
    }
  });
}

module.exports = { installGoogleAuth, googleEnabled };
