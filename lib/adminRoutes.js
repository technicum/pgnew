// Platform admin panel routes (ADMIN_EMAILS only — server.js requireAdmin):
//   /admin               Overview
//   /admin/users         Users list; /admin/users/:id one creator (account,
//                        plan, suspend / reactivate)
//   /admin/plans         Plans (lib/plans.js)
//   /admin/fees          Transaction fees (lib/platform.js)
//   /admin/payments      Payment gateway — Razorpay test / live keys (lib/razorpay.js)
//   /admin/blog          Blog posts (lib/blog.js), public at /blog
//   /admin/seo           SEO for the platform's own pages (lib/seo.js)
//   /admin/ideas         App ideas creators sent (lib/appIdeas.js)
//   /admin/media         Media clean-up (lib/adminMedia.js)
// Pages are plain forms that post and redirect back with ?ok= or ?error=.
const { overview, listUsers, userDetail, PER_PAGE } = require('./admin');
const plans = require('./plans');
const users = require('./users');
const { getFees, saveFees, isAdmin, ATTRIBUTION_DAYS } = require('./platform');
const { platformTotals } = require('./orders');
const { formatINR } = require('./paymentPages');
const { mediaReport, deleteMedia } = require('./adminMedia');
const blog = require('./blog');
const seo = require('./seo');
const appIdeas = require('./appIdeas');
const razorpay = require('./razorpay');
const { paymentMode } = require('./payments');

const OK = {
  saved: 'Saved.',
  plan: 'Plan changed.',
  suspended: 'Account suspended — they’re signed out and their store is offline.',
  reactivated: 'Account reactivated.',
  created: 'Plan created.',
  deleted: 'Plan removed — anyone on it is now on the default plan.',
  default: 'Default plan changed.',
  published: 'Published — it’s live on the blog.',
  draft: 'Saved as a draft — only admins can see it.',
  'post-deleted': 'Post deleted.',
  idea: 'Idea updated.',
  'idea-deleted': 'Idea deleted.',
  gateway: 'Payment settings saved.',
};

function installAdmin(app, { requireAdmin, siteName }) {
  const id = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
  // Every admin page: the panel layout (partials/admin-top) with its nav,
  // and the flash from the last action.
  function render(req, res, view, locals = {}, status = 200) {
    const flash = req.query.error
      ? { kind: 'error', text: String(req.query.error).slice(0, 300) }
      : OK[req.query.ok] ? { kind: 'ok', text: OK[req.query.ok] } : null;
    res.status(status).render(view, {
      user: req.session.user,
      formatINR,
      flash,
      ...locals,
      title: `${locals.title || 'Admin'} — ${siteName} admin`,
    });
  }
  const back = (res, path, err) => res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(err.message)}`);
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (err) { next(err); }
  };

  // --- overview ----------------------------------------------------------------
  app.get('/admin', requireAdmin, wrap(async (req, res) => {
    render(req, res, 'admin-overview', { title: 'Overview', section: 'overview', data: await overview() });
  }));

  // --- users -------------------------------------------------------------------
  app.get('/admin/users', requireAdmin, wrap(async (req, res) => {
    const filters = {
      q: String(req.query.q || ''),
      plan: String(req.query.plan || ''),
      status: String(req.query.status || ''),
      page: Number(req.query.page) || 1,
    };
    const [result, allPlans, def] = await Promise.all([listUsers(filters), plans.listPlans(), plans.defaultPlan()]);
    render(req, res, 'admin-users', { title: 'Users', section: 'users', ...result, filters, plans: allPlans, defaultPlanId: def.id, perPage: PER_PAGE });
  }));

  app.get('/admin/users/:id', requireAdmin, wrap(async (req, res) => {
    const detail = id(req.params.id) && await userDetail(id(req.params.id));
    if (!detail) return res.redirect('/admin/users');
    const [allPlans, plan, fees] = await Promise.all([plans.listPlans(), plans.planOf(detail.user), getFees()]);
    // "creator", not "user" — the layout's user is the signed-in admin.
    render(req, res, 'admin-user', {
      title: detail.user.name, section: 'users',
      creator: detail.user, counts: detail.counts, sales: detail.sales, recentOrders: detail.recentOrders,
      plans: allPlans, plan, platformFees: fees,
      isSelf: detail.user.id === req.session.user.id, isAdminUser: isAdmin(detail.user),
    });
  }));

  app.post('/admin/users/:id/account', requireAdmin, wrap(async (req, res) => {
    const path = `/admin/users/${id(req.params.id)}`;
    try {
      await users.adminUpdateAccount(id(req.params.id), req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, path, err);
      throw err;
    }
    res.redirect(303, `${path}?ok=saved`);
  }));

  app.post('/admin/users/:id/plan', requireAdmin, wrap(async (req, res) => {
    const userId = id(req.params.id);
    const planId = id(req.body && req.body.plan_id);
    const def = await plans.defaultPlan();
    if (planId && !(await plans.getPlan(planId))) return back(res, `/admin/users/${userId}`, new Error('That plan doesn’t exist.'));
    // The default plan is stored as "no plan", so a later default change applies.
    await users.setUserPlan(userId, planId && planId !== def.id ? planId : null);
    res.redirect(303, `/admin/users/${userId}?ok=plan`);
  }));

  app.post('/admin/users/:id/status', requireAdmin, wrap(async (req, res) => {
    const userId = id(req.params.id);
    const target = await users.findUserById(userId);
    if (!target) return res.redirect('/admin/users');
    const suspend = req.body && req.body.status === 'suspended';
    if (suspend && (target.id === req.session.user.id || isAdmin(target))) {
      return back(res, `/admin/users/${userId}`, new Error('Admin accounts can’t be suspended.'));
    }
    await users.setUserStatus(userId, suspend ? 'suspended' : 'active', req.body && req.body.reason);
    res.redirect(303, `/admin/users/${userId}?ok=${suspend ? 'suspended' : 'reactivated'}`);
  }));

  // --- plans -------------------------------------------------------------------
  app.get('/admin/plans', requireAdmin, wrap(async (req, res) => {
    const [allPlans, fees, data] = await Promise.all([plans.listPlans(), getFees(), overview()]);
    const usersOn = new Map(data.plans.map((p) => [p.id, p.users]));
    render(req, res, 'admin-plans', {
      title: 'Plans', section: 'plans', plans: allPlans.map((p) => ({ ...p, users: usersOn.get(p.id) || 0 })),
      platformFees: fees, editing: id(req.query.edit), maxPct: plans.MAX_PCT,
    });
  }));
  const planAction = (fn, ok) => wrap(async (req, res) => {
    try {
      await fn(req);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, `/admin/plans${req.params.id ? `?edit=${id(req.params.id)}` : ''}`, err);
      throw err;
    }
    res.redirect(303, `/admin/plans?ok=${ok}`);
  });
  app.post('/admin/plans', requireAdmin, planAction((req) => plans.createPlan(req.body), 'created'));
  app.post('/admin/plans/:id', requireAdmin, planAction((req) => plans.updatePlan(id(req.params.id), req.body), 'saved'));
  app.post('/admin/plans/:id/default', requireAdmin, planAction((req) => plans.setDefaultPlan(id(req.params.id)), 'default'));
  app.post('/admin/plans/:id/delete', requireAdmin, planAction((req) => plans.deletePlan(id(req.params.id)), 'deleted'));

  // --- transaction fees (was /admin/settings) -----------------------------------
  async function feesPage(req, res, { status = 200, error = null } = {}) {
    const [fees, totals, allPlans] = await Promise.all([getFees(), platformTotals(), plans.listPlans()]);
    const money = (t) => ({ count: t.count, sales: formatINR(t.sales), fee: formatINR(t.fees) });
    if (error) req.query.error = error;
    render(req, res, 'admin-fees', {
      title: 'Transaction fees', section: 'fees', fees,
      totals: { marketplace: money(totals.marketplace), direct: money(totals.direct) },
      attributionDays: ATTRIBUTION_DAYS,
      plans: allPlans.filter((p) => p.direct_pct !== null || p.marketplace_pct !== null),
    }, status);
  }
  app.get('/admin/fees', requireAdmin, wrap((req, res) => feesPage(req, res)));
  app.post('/admin/fees', requireAdmin, wrap(async (req, res) => {
    try {
      await saveFees(req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return feesPage(req, res, { status: 400, error: err.message });
      throw err;
    }
    res.redirect(303, '/admin/fees?ok=saved');
  }));
  // Old links.
  app.get('/admin/settings', requireAdmin, (req, res) => res.redirect(301, '/admin/fees'));

  // --- payment gateway (lib/razorpay.js) ----------------------------------------
  app.get('/admin/payments', requireAdmin, wrap(async (req, res) => {
    render(req, res, 'admin-payments', {
      title: 'Payments', section: 'payments',
      razorpay: await razorpay.adminSettings(),
      currentMode: paymentMode(),
      webhookUrl: `${req.protocol}://${req.get('host')}/webhooks/razorpay`,
    });
  }));
  app.post('/admin/payments', requireAdmin, wrap(async (req, res) => {
    try {
      await razorpay.saveAdminSettings(req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, '/admin/payments', err);
      throw err;
    }
    res.redirect(303, '/admin/payments?ok=gateway');
  }));

  // --- blog (lib/blog.js; public at /blog) --------------------------------------
  app.get('/admin/blog', requireAdmin, wrap(async (req, res) => {
    render(req, res, 'admin-blog', { title: 'Blog', section: 'blog', posts: await blog.listPosts() });
  }));
  async function editor(req, res, post) {
    render(req, res, 'admin-blog-edit', { title: post ? post.title : 'New post', section: 'blog', post, maxBody: blog.MAX_BODY });
  }
  app.get('/admin/blog/new', requireAdmin, wrap((req, res) => editor(req, res, null)));
  app.get('/admin/blog/:id', requireAdmin, wrap(async (req, res) => {
    const post = id(req.params.id) && await blog.getPost(id(req.params.id));
    if (!post) return res.redirect('/admin/blog');
    return editor(req, res, post);
  }));
  app.post('/admin/blog', requireAdmin, wrap(async (req, res) => {
    let newId;
    try {
      newId = await blog.createPost(req.body, { authorName: req.session.user.name });
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, '/admin/blog/new', err);
      throw err;
    }
    res.redirect(303, `/admin/blog/${newId}?ok=${req.body.status === 'published' ? 'published' : 'draft'}`);
  }));
  app.post('/admin/blog/:id', requireAdmin, wrap(async (req, res) => {
    const postId = id(req.params.id);
    try {
      await blog.updatePost(postId, req.body);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, `/admin/blog/${postId}`, err);
      throw err;
    }
    res.redirect(303, `/admin/blog/${postId}?ok=${req.body.status === 'published' ? 'published' : 'saved'}`);
  }));
  app.post('/admin/blog/:id/delete', requireAdmin, wrap(async (req, res) => {
    await blog.deletePost(id(req.params.id));
    res.redirect(303, '/admin/blog?ok=post-deleted');
  }));

  // --- SEO for the platform's own pages (lib/seo.js) ------------------------------
  app.get('/admin/seo', requireAdmin, wrap(async (req, res) => {
    render(req, res, 'admin-seo', {
      title: 'SEO', section: 'seo', saved: await seo.getSeoSettings(), pages: seo.PAGES, limits: seo.FIELDS, defaults: seo.DEFAULTS(siteName),
    });
  }));
  app.post('/admin/seo', requireAdmin, wrap(async (req, res) => {
    try {
      await seo.saveSeoSettings(req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, '/admin/seo', err);
      throw err;
    }
    res.redirect(303, '/admin/seo?ok=saved');
  }));

  // --- app ideas (lib/appIdeas.js; creators send them from Explore apps) -------------
  app.get('/admin/ideas', requireAdmin, wrap(async (req, res) => {
    const status = appIdeas.STATUSES[req.query.status] ? req.query.status : '';
    const { ideas, counts } = await appIdeas.listIdeas({ status });
    render(req, res, 'admin-ideas', { title: 'App ideas', section: 'ideas', ideas, counts, status, statuses: appIdeas.STATUSES });
  }));
  app.post('/admin/ideas/:id', requireAdmin, wrap(async (req, res) => {
    await appIdeas.updateIdea(id(req.params.id), req.body || {});
    const filter = appIdeas.STATUSES[req.body && req.body.filter] ? `&status=${req.body.filter}` : '';
    res.redirect(303, `/admin/ideas?ok=idea${filter}#idea-${id(req.params.id)}`);
  }));
  app.post('/admin/ideas/:id/delete', requireAdmin, wrap(async (req, res) => {
    await appIdeas.deleteIdea(id(req.params.id));
    res.redirect(303, '/admin/ideas?ok=idea-deleted');
  }));

  // --- media -----------------------------------------------------------------
  app.get('/admin/media', requireAdmin, wrap(async (req, res) => {
    const report = await mediaReport();
    render(req, res, 'admin-media', { title: 'Media', section: 'media', files: report.files, unusedDays: report.unusedDays });
  }));
  app.post('/admin/media/delete', requireAdmin, async (req, res) => {
    try {
      res.json(await deleteMedia(req.body && req.body.keys));
    } catch (err) {
      console.error('Media delete failed:', err);
      res.status(500).json({ error: 'Could not delete those files. Please try again.' });
    }
  });
}

module.exports = { installAdmin };
