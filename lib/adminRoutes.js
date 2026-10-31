// Platform admin panel routes (ADMIN_EMAILS only — server.js requireAdmin):
//   /admin               Overview
//   /admin/users         Users list; /admin/users/export as a CSV;
//                        /admin/users/:id one creator (account, plan,
//                        suspend / reactivate)
//   /admin/plans         Plans (lib/plans.js)
//   /admin/fees          Transaction fees (lib/platform.js)
//   /admin/payments      Payment gateway — Razorpay test / live keys (lib/razorpay.js)
//   /admin/blog          Blog posts (lib/blog.js), public at /blog
//   /admin/seo           SEO for the platform's own pages (lib/seo.js)
//   /admin/emails        Email templates and sends to users (lib/emails.js),
//                        SMTP settings (lib/mailer.js)
//   /admin/ideas         App ideas creators sent (lib/appIdeas.js)
//   /admin/media         Media clean-up (lib/adminMedia.js)
// Pages are plain forms that post and redirect back with ?ok= or ?error=.
const crypto = require('crypto');
const { overview, listUsers, usersCsv, userDetail, PER_PAGE } = require('./admin');
const plans = require('./plans');
const users = require('./users');
const { getFees, saveFees, isAdmin, isAdminAccount, ATTRIBUTION_DAYS } = require('./platform');
const { platformTotals } = require('./orders');
const { formatINR } = require('./paymentPages');
const { mediaReport, deleteMedia } = require('./adminMedia');
const blog = require('./blog');
const seo = require('./seo');
const appIdeas = require('./appIdeas');
const emails = require('./emails');
const mailer = require('./mailer');
const razorpay = require('./razorpay');
const { paymentMode } = require('./payments');

const OK = {
  saved: 'Saved.',
  adminAdded: 'They’re an admin now.',
  adminRemoved: 'Admin access removed.',
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
  'template-deleted': 'Template deleted.',
  'test-sent': 'Test email sent to you.',
  sending: 'Sending — you can leave this page, it carries on in the background.',
  paused: 'Paused.',
  resumed: 'Sending again.',
  cancelled: 'Cancelled — nobody else will get this email.',
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
    const [result, allPlans, def, templates] = await Promise.all([listUsers(filters), plans.listPlans(), plans.defaultPlan(), emails.listTemplates()]);
    render(req, res, 'admin-users', { title: 'Users', section: 'users', ...result, filters, plans: allPlans, defaultPlanId: def.id, perPage: PER_PAGE, templates });
  }));

  app.get('/admin/users/export', requireAdmin, wrap(async (req, res) => {
    const csv = await usersCsv({ q: String(req.query.q || ''), plan: String(req.query.plan || ''), status: String(req.query.status || '') });
    res.attachment(`users-${new Date().toISOString().slice(0, 10)}.csv`).send(csv);
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
      isSelf: detail.user.id === req.session.user.id, isAdminUser: await isAdminAccount(detail.user),
      isOwnerUser: isAdmin(detail.user), canManageAdmins: isAdmin(req.session.user),
    });
  }));

  app.post('/admin/users/:id/account', requireAdmin, wrap(async (req, res) => {
    const path = `/admin/users/${id(req.params.id)}`;
    // Only owners touch admin accounts or owner emails: the email is what makes
    // an owner, so an admin could otherwise promote themselves.
    if (!isAdmin(req.session.user)) {
      const target = await users.findUserById(id(req.params.id));
      if (await isAdminAccount(target) || isAdmin({ email: req.body && req.body.email })) {
        return back(res, path, new Error('Only an owner can change that account.'));
      }
    }
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

  app.post('/admin/users/:id/admin', requireAdmin, wrap(async (req, res) => {
    const userId = id(req.params.id);
    const target = await users.findUserById(userId);
    if (!target) return res.redirect('/admin/users');
    const path = `/admin/users/${userId}`;
    const makeAdmin = !!req.body && req.body.admin === '1';
    if (!isAdmin(req.session.user)) return back(res, path, new Error('Only an owner can change who’s an admin.'));
    if (isAdmin(target)) return back(res, path, new Error('Owners are set by ADMIN_EMAILS in .env.'));
    if (makeAdmin && target.status === 'suspended') return back(res, path, new Error('Reactivate this account first.'));
    await users.setAdminGrant(userId, makeAdmin);
    res.redirect(303, `${path}?ok=${makeAdmin ? 'adminAdded' : 'adminRemoved'}`);
  }));

  app.post('/admin/users/:id/status', requireAdmin, wrap(async (req, res) => {
    const userId = id(req.params.id);
    const target = await users.findUserById(userId);
    if (!target) return res.redirect('/admin/users');
    const suspend = req.body && req.body.status === 'suspended';
    if (suspend && (target.id === req.session.user.id || await isAdminAccount(target))) {
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

  // --- emails to users (lib/emails.js; SMTP in lib/mailer.js) ---------------------
  app.get('/admin/emails', requireAdmin, wrap(async (req, res) => {
    const [templates, campaigns, configured] = await Promise.all([emails.listTemplates(), emails.listCampaigns(), mailer.isConfigured()]);
    render(req, res, 'admin-emails', { title: 'Emails', section: 'emails', templates, campaigns, configured });
  }));

  app.get('/admin/emails/settings', requireAdmin, wrap(async (req, res) => {
    render(req, res, 'admin-email-settings', { title: 'Email settings', section: 'emails', smtp: await mailer.adminSettings() });
  }));
  app.post('/admin/emails/settings', requireAdmin, wrap(async (req, res) => {
    try {
      await mailer.saveAdminSettings(req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, '/admin/emails/settings', err);
      throw err;
    }
    res.redirect(303, '/admin/emails/settings?ok=saved');
  }));

  // template is what the form shows — after a mistake, what was typed.
  async function templateForm(req, res, template, { status = 200, error = null, saved = null } = {}) {
    if (error) req.query.error = error;
    render(req, res, 'admin-email-template', {
      title: (saved && saved.name) || 'New template', section: 'emails',
      template, saved, placeholders: emails.PLACEHOLDERS, maxBody: emails.MAX_BODY,
    }, status);
  }
  app.get('/admin/emails/templates/new', requireAdmin, wrap((req, res) => templateForm(req, res, {})));
  app.get('/admin/emails/templates/:id', requireAdmin, wrap(async (req, res) => {
    const template = id(req.params.id) && await emails.getTemplate(id(req.params.id));
    if (!template) return res.redirect('/admin/emails');
    return templateForm(req, res, template, { saved: template });
  }));
  app.post('/admin/emails/templates', requireAdmin, wrap(async (req, res) => {
    let newId;
    try {
      newId = await emails.createTemplate(req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return templateForm(req, res, req.body || {}, { status: 400, error: err.message });
      throw err;
    }
    res.redirect(303, `/admin/emails/templates/${newId}?ok=saved`);
  }));
  app.post('/admin/emails/templates/:id', requireAdmin, wrap(async (req, res) => {
    const templateId = id(req.params.id);
    try {
      await emails.updateTemplate(templateId, req.body || {});
    } catch (err) {
      if (err.code === 'INVALID_INPUT') {
        return templateForm(req, res, req.body || {}, { status: 400, error: err.message, saved: await emails.getTemplate(templateId) });
      }
      throw err;
    }
    res.redirect(303, `/admin/emails/templates/${templateId}?ok=saved`);
  }));
  app.post('/admin/emails/templates/:id/delete', requireAdmin, wrap(async (req, res) => {
    await emails.deleteTemplate(id(req.params.id));
    res.redirect(303, '/admin/emails?ok=template-deleted');
  }));

  // A test to the signed-in admin — with their own details filled in.
  app.post('/admin/emails/test', requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const path = /^\/admin\/emails\/[\w/?=&%,.-]*$/.test(body.back) ? body.back : '/admin/emails';
    const template = id(body.template_id) && await emails.getTemplate(id(body.template_id));
    if (!template) return back(res, path, new Error('Pick a template first.'));
    try {
      await mailer.sendMail(emails.buildEmail(template, await users.findUserById(req.session.user.id)));
    } catch (err) {
      console.error('Test email failed:', err.message);
      return back(res, path, new Error(err.code === 'NOT_CONFIGURED' ? err.message : `The test didn’t send: ${err.message}`));
    }
    res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}ok=test-sent`);
  }));

  // Who a send is for, from the users list's form: the ticked users, or
  // scope=all and its filters. ids come as ids=1&ids=2 or a list ids=1,2.
  function audienceFrom(source) {
    if (source.scope === 'all') {
      return { filters: { q: String(source.q || ''), plan: String(source.plan || ''), status: String(source.status || '') } };
    }
    const raw = source.ids && typeof source.ids === 'object' ? Object.values(source.ids) : [source.ids];
    return { ids: [...new Set(raw.join(',').split(',').map(id).filter(Boolean))] };
  }

  // Step before sending: what goes out, and to how many people.
  app.get('/admin/emails/send', requireAdmin, wrap(async (req, res) => {
    const audience = audienceFrom(req.query);
    if (audience.ids && !audience.ids.length) return back(res, '/admin/users', new Error('Tick at least one user to email.'));
    const [templates, { recipients, skipped }, configured] = await Promise.all([
      emails.listTemplates(), emails.resolveAudience(audience), mailer.isConfigured(),
    ]);
    const template = id(req.query.template_id) ? await emails.getTemplate(id(req.query.template_id)) : null;
    const sample = recipients[0] || await users.findUserById(req.session.user.id);
    render(req, res, 'admin-email-send', {
      title: 'Send email', section: 'emails', templates, template, configured,
      audience: audience.ids ? { ids: audience.ids.join(',') } : { scope: 'all', ...audience.filters },
      recipients: recipients.slice(0, 5), count: recipients.length, skipped, sample,
      preview: template && emails.buildEmail(template, sample),
      sendKey: crypto.randomUUID(),
      selfPath: req.originalUrl.replace(/&(ok|error)=[^&]*/g, ''),
    });
  }));

  app.post('/admin/emails/send', requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const template = id(body.template_id) && await emails.getTemplate(id(body.template_id));
    if (!template) return back(res, '/admin/users', new Error('Pick a template first.'));
    if (!/^[0-9a-f-]{36}$/.test(body.send_key)) return back(res, '/admin/users', new Error('Please start the send again.'));
    if (!(await mailer.isConfigured())) return back(res, '/admin/emails/settings', new Error('Add your SMTP details before sending.'));
    let campaignId;
    try {
      campaignId = await emails.createCampaign(template, audienceFrom(body), { sendKey: body.send_key, sentBy: req.session.user.email });
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return back(res, '/admin/users', err);
      throw err;
    }
    res.redirect(303, `/admin/emails/campaigns/${campaignId}?ok=sending`);
  }));

  app.get('/admin/emails/campaigns/:id', requireAdmin, wrap(async (req, res) => {
    const campaign = id(req.params.id) && await emails.getCampaign(id(req.params.id));
    if (!campaign) return res.redirect('/admin/emails');
    render(req, res, 'admin-email-campaign', { title: campaign.subject, section: 'emails', campaign });
  }));
  const campaignAction = (fn, ok) => wrap(async (req, res) => {
    await fn(id(req.params.id));
    res.redirect(303, `/admin/emails/campaigns/${id(req.params.id)}?ok=${ok}`);
  });
  app.post('/admin/emails/campaigns/:id/pause', requireAdmin, campaignAction((c) => emails.pauseCampaign(c), 'paused'));
  app.post('/admin/emails/campaigns/:id/resume', requireAdmin, campaignAction((c) => emails.resumeCampaign(c), 'resumed'));
  app.post('/admin/emails/campaigns/:id/cancel', requireAdmin, campaignAction((c) => emails.cancelCampaign(c), 'cancelled'));

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
