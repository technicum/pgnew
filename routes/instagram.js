// Connecting an Instagram account (Instagram API with Unified Login). The calls
// to Meta are in lib/instagram.js; storing the account is lib/autodm.js, which
// shares the table with AutoDM.
//
//   GET  /auth/instagram/connect      to Meta's login dialog
//   GET  /auth/instagram/callback     Meta sends the client back here
//   POST /auth/instagram/disconnect   deletes the token, automations and activity
//
// Connecting starts from Settings, or from AutoDM with ?from=autodm, and comes
// back there.
const crypto = require('crypto');
const ig = require('../lib/instagram');
const autodm = require('../lib/autodm');

const homeFor = (from) => (from === 'autodm' ? '/dashboard/autodm' : '/dashboard/settings');

function sameState(expected, given) {
  return !!expected && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function installInstagramRoutes(app, { requireAuth }) {
  const fail = (res, home, message) => res.redirect(303, `${home}?error=${encodeURIComponent(message)}`);

  app.get('/auth/instagram/connect', requireAuth, (req, res, next) => {
    if (!ig.instagramEnabled()) return res.redirect(homeFor(req.query.from));
    const state = crypto.randomBytes(24).toString('hex');
    req.session.instagramState = state;
    req.session.instagramFrom = req.query.from === 'autodm' ? 'autodm' : 'settings';
    const url = ig.authUrl(req, state);
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  });

  app.get('/auth/instagram/callback', requireAuth, async (req, res) => {
    const expected = req.session.instagramState;
    const home = homeFor(req.session.instagramFrom);
    delete req.session.instagramState;
    delete req.session.instagramFrom;
    if (req.query.error) {
      // Meta sends error, error_reason, error_description (and error_code /
      // error_message on some failures). Only user_denied is a real cancel.
      const q = req.query;
      const reason = String(q.error_reason || '');
      const detail = String(q.error_description || q.error_message || '').slice(0, 300);
      console.error('Instagram connect: Meta returned an error:', {
        error: q.error, error_reason: reason, error_code: q.error_code, error_description: detail,
      });
      if (reason === 'user_denied') return fail(res, home, 'Instagram wasn’t connected, because the request was cancelled.');
      return fail(res, home, `Instagram wasn’t connected: ${detail || reason || q.error}.`);
    }
    if (!sameState(expected, String(req.query.state || ''))) return fail(res, home, 'That Instagram connection expired. Please try again.');
    if (!req.query.code || !ig.instagramEnabled()) return fail(res, home, 'Instagram didn’t finish connecting. Please try again.');
    try {
      await autodm.connectAccount(req.session.user.id, await ig.exchangeCode(String(req.query.code), req));
      res.redirect(303, `${home}?ok=connected`);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return fail(res, home, err.message);
      console.error('Instagram connect failed:', err.message, err.meta || '');
      fail(res, home, 'Couldn’t connect Instagram. Check it’s a Business or Creator account and try again.');
    }
  });

  app.post('/auth/instagram/disconnect', requireAuth, async (req, res, next) => {
    try {
      await autodm.disconnect(req.session.user.id);
      res.redirect(303, `${homeFor(req.body?.from)}?ok=disconnected`);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { installInstagramRoutes };
