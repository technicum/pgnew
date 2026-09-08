function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }
  req.flash('error', 'Please log in to continue.');
  return res.redirect('/admin/login');
}

module.exports = { requireAdmin };
