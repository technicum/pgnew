// Live preview for the dashboard editors: the public page itself —
// rendered by the same view and the same locals as the live one
// (lib/paymentStorefront.js pageLocals, lib/appStorefront.js
// eventLocals / courseLocals / bookingLocals) — from the editor's unsaved
// fields. Nothing is saved; the fields are checked as a save would check
// them, and a field that wouldn't save yet (a half-typed price) answers
// 422 { error } so the editor keeps showing the last good page.
//
//   POST /dashboard/payment-pages/preview          JSON { page: <the builder's save payload>, id? }
//   POST /dashboard/events/:id/preview             the event editor's form
//   POST /dashboard/courses/:id/preview            the course editor's details form
//   POST /dashboard/bookings/services/:id/preview  the booking service editor's form
//   POST /dashboard/builder/preview                JSON { name, bio, accent, showBadge, blocks } — the store builder
//   POST /dashboard/lead-magnets/preview           JSON { magnet: <the builder's save payload>, id? }
//
// The editors put the HTML in a sandboxed iframe (public/js/live-preview.js
// and public/js/payment-pages.js): scripts run, so the page behaves as it
// does live, but GUARD stops links, forms and the page's own requests
// (quotes, abandoned-cart drafts) from going anywhere.
const { findUserById } = require('./users');
const paymentPages = require('./paymentPages');
const events = require('./events');
const courses = require('./courses');
const bookings = require('./bookings');
const { getFees } = require('./platform');
const { paymentMode } = require('./payments');
const { startingValues, pageLocals } = require('./paymentStorefront');
const { eventLocals, courseLocals, bookingLocals } = require('./appStorefront');
const { storeLocals } = require('./storefront');
const leadMagnets = require('./leadMagnets');

const GUARD = `<script>
(function () {
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (a && !/^#/.test(a.getAttribute('href'))) e.preventDefault();
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
  window.fetch = function () { return Promise.reject(new Error('Preview')); };
  if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };
})();
</script>`;

const id = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);

// The view as HTML, with GUARD first thing in <head> so it's in place
// before the page's own scripts.
function sendPreview(res, view, locals) {
  res.render(view, locals, (err, html) => {
    if (err) {
      console.error('Live preview failed to render', view, err);
      return res.status(500).json({ error: 'The preview couldn’t be drawn.' });
    }
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(html.replace(/<head>/i, (m) => `${m}\n${GUARD}`));
  });
}

// A field that wouldn't save yet — keep the last good preview.
function tryBuild(res, build) {
  try {
    return build();
  } catch (err) {
    if (err.sqlMessage) throw err;
    res.status(422).json({ error: err.message || 'Check the fields.' });
    return null;
  }
}

function installLivePreview(app, { requireAuth }) {
  const handler = (fn) => async (req, res, next) => {
    try {
      const owner = await findUserById(req.session.user.id);
      if (!owner) return res.status(404).json({ error: 'Not found' });
      return await fn(req, res, owner);
    } catch (err) { return next(err); }
  };

  app.post('/dashboard/payment-pages/preview', requireAuth, handler(async (req, res, owner) => {
    const body = req.body || {};
    const saved = id(body.id) ? await paymentPages.getPaymentPage(owner.id, id(body.id)) : null;
    const page = tryBuild(res, () => paymentPages.previewPaymentPage(owner.id, body.page || {}, saved));
    if (!page) return null;
    const values = startingValues(page);
    return sendPreview(res, 'payment-page', await pageLocals(owner, page, { values, mode: paymentMode() }));
  }));

  app.post('/dashboard/events/:id/preview', requireAuth, handler(async (req, res, owner) => {
    const saved = id(req.params.id) && await events.getEvent(owner.id, id(req.params.id));
    if (!saved) return res.status(404).json({ error: 'That event doesn’t exist.' });
    const event = tryBuild(res, () => events.previewEvent(saved, req.body || {}));
    if (!event) return null;
    return sendPreview(res, 'app-event', eventLocals(owner, event));
  }));

  app.post('/dashboard/courses/:id/preview', requireAuth, handler(async (req, res, owner) => {
    const saved = id(req.params.id) && await courses.getCourse(owner.id, id(req.params.id));
    if (!saved) return res.status(404).json({ error: 'That course doesn’t exist.' });
    const course = tryBuild(res, () => courses.previewCourse(saved, req.body || {}));
    if (!course) return null;
    const [lessons, moduleRows] = await Promise.all([courses.listLessons(course.id), courses.listModules(course.id)]);
    // As the live page: modules with nothing in them yet are left out.
    const modules = courses.groupModules(lessons, moduleRows).filter((m) => m.lessons.length);
    return sendPreview(res, 'app-course', courseLocals(owner, course, lessons, modules));
  }));

  app.post('/dashboard/bookings/services/:id/preview', requireAuth, handler(async (req, res, owner) => {
    const [saved, settings] = await Promise.all([
      id(req.params.id) && bookings.getService(owner.id, id(req.params.id)),
      bookings.getSettings(owner.id),
    ]);
    if (!saved) return res.status(404).json({ error: 'That session doesn’t exist.' });
    const service = tryBuild(res, () => bookings.previewService(saved, req.body || {}));
    if (!service) return null;
    // As the live page: photo and cover fall back to Bookings → Settings,
    // and the online part is priced for a direct visitor.
    service.photo_url = service.photo_url || settings.photo_url;
    service.cover_url = service.cover_url || settings.cover_url;
    bookings.applyFee(service, (await getFees()).direct_pct);
    return sendPreview(res, 'app-booking', await bookingLocals(owner, service, settings));
  }));

  // The store home: the builder's blocks (in its order) and profile as
  // they are on screen — the same limits the builder's saves apply.
  app.post('/dashboard/builder/preview', requireAuth, handler(async (req, res, owner) => {
    const body = req.body || {};
    const text = (v, max) => String(v ?? '').slice(0, max);
    const store = {
      ...owner,
      name: text(body.name, 200).trim() || owner.name,
      bio: text(body.bio, 280),
      accent_color: /^#[0-9a-f]{6}$/i.test(body.accent || '') ? body.accent : owner.accent_color,
      show_badge: body.showBadge === undefined ? owner.show_badge : !!body.showBadge,
    };
    const blocks = (Array.isArray(body.blocks) ? body.blocks : []).slice(0, 200).map((b) => ({
      type: text(b && b.type, 20),
      title: text(b && b.title, 200),
      sub: text(b && b.sub, 200),
      price: text(b && b.price, 200),
      visible: !!(b && b.visible),
    }));
    return sendPreview(res, 'store', await storeLocals(store, blocks, { siteName: res.locals.siteName, mainSiteUrl: '/' }));
  }));

  // A lead magnet's page (views/lead-magnet.ejs), the form empty as a
  // visitor first sees it.
  app.post('/dashboard/lead-magnets/preview', requireAuth, handler(async (req, res, owner) => {
    const body = req.body || {};
    const saved = id(body.id) ? (await leadMagnets.listLeadMagnets(owner.id)).find((m) => m.id === id(body.id)) : null;
    const magnet = tryBuild(res, () => leadMagnets.previewLeadMagnet(body.magnet || {}, saved));
    if (!magnet) return null;
    return sendPreview(res, 'lead-magnet', {
      title: `${magnet.title} — ${owner.name}`,
      owner, magnet, error: null,
      values: { name: '', email: '', phone: '', extra: {} },
    });
  }));
}

module.exports = { installLivePreview };
