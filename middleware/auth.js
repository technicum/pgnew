// Requires both a logged-in admin AND that the admin belongs to the store
// whose subdomain this request came in on. The session cookie is shared
// across every *.pagezaper.com subdomain, so without the store_id check an
// admin logged into their own store could otherwise browse straight into
// another merchant's /admin just by visiting that store's subdomain.
function requireAdmin(req, res, next) {
  if (!req.store) {
    req.flash('error', 'Please log in from your store\'s address.');
    return res.redirect('/login');
  }
  if (req.session && req.session.admin && req.session.admin.store_id === req.store.id) {
    return next();
  }
  req.flash('error', 'Please log in to continue.');
  return res.redirect('/admin/login');
}

module.exports = { requireAdmin };
