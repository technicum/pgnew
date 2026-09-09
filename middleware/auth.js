const { adminPortalUrl } = require('./tenant');

// Requires both a logged-in admin AND that the admin belongs to the store
// whose subdomain this request came in on. The session cookie is shared
// across every *.pagezaper.com subdomain, so without the store_id check an
// admin logged into their own store could otherwise browse straight into
// another merchant's /admin just by visiting that store's subdomain.
// Staff sign in at admin.pagezaper.com (the single login gateway) — that's
// where every redirect here sends them.
function requireAdmin(req, res, next) {
  if (!req.store) {
    req.flash('error', 'Please log in first.');
    return res.redirect(adminPortalUrl(req, '/login'));
  }
  if (req.session && req.session.admin && req.session.admin.store_id === req.store.id) {
    return next();
  }
  req.flash('error', 'Please log in to continue.');
  return res.redirect(adminPortalUrl(req, '/login'));
}

// Stricter than requireAdmin: also requires the Admin role specifically, not
// Manager. Used only on the couple of actions where Manager's "can edit and
// add, but not delete users or pages" limit applies (staff deletion, page
// deletion) — run this AFTER requireAdmin so req.session.admin is already set.
function requireAdminRole(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.role === 'admin') {
    return next();
  }
  req.flash('error', "Only an Admin can do that — Managers don't have permission.");
  return res.redirect(req.get('Referer') || '/admin');
}

// Platform super-admin: a separate account/session from any store's admins,
// used to manage every store from one place (routes/platformAdmin.js). Not
// tied to req.store at all — it works from the root domain only.
function requirePlatformAdmin(req, res, next) {
  if (req.session && req.session.platformAdmin) return next();
  req.flash('error', 'Please log in to continue.');
  return res.redirect('/platform-admin/login');
}

// Storefront shopper accounts (pz_customers). Mirrors requireAdmin's
// store_id check: the session cookie is shared across every
// *.pagezaper.com subdomain, so without this a customer logged into one
// store could otherwise browse straight into another store's /account.
function requireCustomer(req, res, next) {
  if (!req.store) return res.redirect('/');
  if (req.session && req.session.customer && req.session.customer.store_id === req.store.id) {
    return next();
  }
  req.flash('error', 'Please log in to view your account.');
  return res.redirect('/account/login');
}

module.exports = { requireAdmin, requireAdminRole, requirePlatformAdmin, requireCustomer };
