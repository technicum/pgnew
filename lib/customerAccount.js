// Buyer sign-in and saved addresses, on the merchant's store subdomain
// (lib/storefront.js routes /account/... here):
//
//   GET/POST /account/login              sign in   (?next=/pay/<slug> to go back to checkout)
//   GET/POST /account/signup             create an account
//   POST     /account/logout             sign out
//   GET      /account                    saved delivery addresses
//   POST     /account/addresses          add one
//   POST     /account/addresses/:id/default | /delete
//
// The signed-in buyer lives in req.session.customer — separate from
// req.session.user (a creator signed in to the dashboard on the main
// domain). The session cookie is per host, so a buyer signs in once per
// store with the same account.
const {
  findCustomerByEmail, createCustomer, verifyCustomerPassword, toPublicCustomer,
  cleanAddress, listAddresses, addAddress, deleteAddress, setDefaultAddress, MAX_ADDRESSES,
} = require('./customers');

const ACCOUNT_PATH = /^\/account(?:\/(login|signup|logout|addresses)(?:\/(\d+)\/(default|delete))?)?\/?$/;

function matchAccountPath(req) {
  const m = req.path.toLowerCase().match(ACCOUNT_PATH);
  if (!m) return null;
  const [, action = 'home', id, sub] = m;
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const ok = (action === 'home' && isRead)
    || ((action === 'login' || action === 'signup') && (isRead || req.method === 'POST'))
    || (action === 'logout' && req.method === 'POST')
    || (action === 'addresses' && req.method === 'POST');
  return ok ? { action, id: id ? Number(id) : null, sub: sub || null } : null;
}

// Where to go after signing in — only back to a page on this store, never
// to another site (?next=//evil.example).
function safeNext(raw) {
  const next = String(raw || '');
  return /^\/(pay\/[a-z0-9-]+|book\/[a-z0-9-]+|account)\/?$/i.test(next) ? next : '/account';
}

function signIn(req, customer) {
  // A fresh session id on sign-in, so one fixed before it can't be reused.
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.customer = toPublicCustomer(customer);
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

async function handleAccountRequest(req, res, owner, { action, id, sub }, { siteName }) {
  const customer = req.session.customer || null;
  const next = safeNext(req.query.next || req.body?.next);
  const view = (name, status, locals) => res.status(status).render(name, {
    owner, siteName, customer, next, ...locals,
  });

  // --- sign in / sign up -------------------------------------------------
  if (action === 'login' || action === 'signup') {
    if (customer) return res.redirect(303, next);
    const isSignup = action === 'signup';
    const values = {
      name: String(req.body?.name || '').trim().slice(0, 120),
      email: String(req.body?.email || '').trim().slice(0, 190),
    };
    const form = (status, error) => view('customer-auth', status, {
      title: `${isSignup ? 'Create an account' : 'Sign in'} — ${owner.name}`,
      mode: action, values, error,
    });
    if (req.method !== 'POST') return form(200, null);

    const password = String(req.body?.password || '');
    if (isSignup) {
      if (!values.name) return form(400, 'Add your name to continue.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return form(400, 'That email address doesn’t look right.');
      if (password.length < 8) return form(400, 'Use at least 8 characters for your password.');
      try {
        await signIn(req, await createCustomer({ ...values, password }));
      } catch (err) {
        if (err.code === 'EMAIL_TAKEN') return form(400, 'An account with that email already exists — sign in instead.');
        throw err;
      }
      return res.redirect(303, next);
    }
    if (!values.email || !password) return form(400, 'Enter your email and password.');
    const found = await findCustomerByEmail(values.email);
    if (!found || !(await verifyCustomerPassword(found, password))) {
      return form(400, 'That email and password don’t match an account.');
    }
    await signIn(req, found);
    return res.redirect(303, next);
  }

  if (action === 'logout') {
    delete req.session.customer;
    return res.redirect(303, next === '/account' ? '/account/login' : next);
  }

  // Everything below is the signed-in buyer's own addresses.
  if (!customer) return res.redirect(303, `/account/login?next=${encodeURIComponent(next === '/account' ? '/account' : next)}`);

  const home = async (status, error, values) => view('customer-account', status, {
    title: `Your account — ${owner.name}`,
    addresses: await listAddresses(customer.id),
    maxAddresses: MAX_ADDRESSES,
    error,
    values: values || { label: '', name: customer.name, line: '', city: '', pincode: '', phone: '' },
  });

  if (action === 'home') return home(200, null);

  // --- addresses ---------------------------------------------------------
  if (id) {
    if (sub === 'delete') await deleteAddress(customer.id, id);
    else await setDefaultAddress(customer.id, id);
    return res.redirect(303, '/account');
  }
  const raw = {
    label: req.body?.label, name: req.body?.name, line: req.body?.address,
    city: req.body?.city, pincode: req.body?.pincode, phone: req.body?.phone,
  };
  const { address, error } = cleanAddress(raw);
  const values = raw;
  if (error) return home(400, error, values);
  try {
    await addAddress(customer.id, address, { makeDefault: req.body?.make_default === '1' });
  } catch (err) {
    if (err.code === 'TOO_MANY_ADDRESSES') return home(400, err.message, values);
    throw err;
  }
  return res.redirect(303, '/account');
}

module.exports = { matchAccountPath, handleAccountRequest };
