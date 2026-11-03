// Razorpay Route Linked Accounts — how a creator gets paid for sales on a
// WordPress / WooCommerce store connected to PageZaper (lib/wcApi.js). Each
// creator who wants split payments gets a Linked Account under PageZaper's
// Razorpay account; at checkout the order carries a transfer to that
// account (the sale minus PageZaper's fee), and the fee simply stays with
// PageZaper.
//
// One row per creator per key set (PDZ_linked_accounts, unique on user_id +
// mode): a linked account made with the test keys doesn't exist on the live
// account, same as "rzp_test:order_…" refs in lib/razorpay.js.
//
// Onboarding is four Razorpay calls (v2 Accounts API):
//   1. POST  /v2/accounts                          → acc_…   (saved at once)
//   2. POST  /v2/accounts/:id/stakeholders         → sth_…
//   3. POST  /v2/accounts/:id/products {route}     → acc_prd_…
//   4. PATCH /v2/accounts/:id/products/:pid        settlements (bank + IFSC)
// Each id is saved as soon as it's returned, so a failure half-way picks up
// where it stopped next time instead of making a second account.
//
// status:  pending | needs_info | activated — our summary of Razorpay's
//          activation_status (rz_status keeps the raw one). It's only ever
//          set from what Razorpay's API returns — on submit, on a page view
//          (refresh) or after a signed webhook nudges us — never from the
//          browser. Only 'activated' accounts can receive split payments
//          (activatedAccount).
//
// Privacy: the bank account number and PAN are passed on to Razorpay and
// not stored here beyond their last four characters.
const pool = require('./db');
const razorpay = require('./razorpay');
const { inputError } = require('./appKit');

const TABLE = 'PDZ_linked_accounts';
const STATUSES = ['pending', 'needs_info', 'activated'];
const REFRESH_MS = 60 * 1000;

const BUSINESS_TYPES = {
  individual: 'Individual',
  proprietorship: 'Proprietorship',
  partnership: 'Partnership',
  llp: 'LLP',
  private_limited: 'Private limited',
  public_limited: 'Public limited',
  trust: 'Trust',
  society: 'Society',
  ngo: 'NGO',
  huf: 'HUF',
  not_yet_registered: 'Not yet registered',
};

// Razorpay needs a business category; a WooCommerce store is e-commerce.
// Razorpay checks the subcategory itself, and its error is shown as-is.
const CATEGORY = 'ecommerce';
const SUBCATEGORIES = {
  fashion_and_lifestyle: 'Fashion and lifestyle',
  electronics_and_furniture: 'Electronics and furniture',
  books: 'Books',
  gifting: 'Gifting',
  grocery: 'Grocery',
  arts_and_collectibles: 'Arts and collectibles',
  sports_products: 'Sports products',
  ecommerce_marketplace: 'Something else / a mix',
};

const STATES = ['ANDAMAN AND NICOBAR ISLANDS', 'ANDHRA PRADESH', 'ARUNACHAL PRADESH', 'ASSAM', 'BIHAR', 'CHANDIGARH',
  'CHHATTISGARH', 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU', 'DELHI', 'GOA', 'GUJARAT', 'HARYANA', 'HIMACHAL PRADESH',
  'JAMMU AND KASHMIR', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'LADAKH', 'LAKSHADWEEP', 'MADHYA PRADESH', 'MAHARASHTRA',
  'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ODISHA', 'PUDUCHERRY', 'PUNJAB', 'RAJASTHAN', 'SIKKIM', 'TAMIL NADU',
  'TELANGANA', 'TRIPURA', 'UTTAR PRADESH', 'UTTARAKHAND', 'WEST BENGAL'];

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        mode VARCHAR(4) NOT NULL,
        account_id VARCHAR(40) NOT NULL DEFAULT '',
        stakeholder_id VARCHAR(40) NOT NULL DEFAULT '',
        product_id VARCHAR(40) NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        rz_status VARCHAR(30) NOT NULL DEFAULT '',
        requirements TEXT NULL,
        legal_business_name VARCHAR(200) NOT NULL DEFAULT '',
        business_type VARCHAR(30) NOT NULL DEFAULT '',
        subcategory VARCHAR(60) NOT NULL DEFAULT '',
        contact_name VARCHAR(120) NOT NULL DEFAULT '',
        phone VARCHAR(15) NOT NULL DEFAULT '',
        pan_last4 VARCHAR(4) NOT NULL DEFAULT '',
        gst VARCHAR(15) NOT NULL DEFAULT '',
        address TEXT NULL,
        website VARCHAR(255) NOT NULL DEFAULT '',
        bank_last4 VARCHAR(4) NOT NULL DEFAULT '',
        ifsc VARCHAR(11) NOT NULL DEFAULT '',
        checked_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_mode (user_id, mode),
        INDEX (account_id)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function toAccount(row) {
  if (!row) return null;
  let requirements = [];
  let address = null;
  try { requirements = row.requirements ? JSON.parse(row.requirements) : []; } catch (err) { requirements = []; }
  try { address = row.address ? JSON.parse(row.address) : null; } catch (err) { address = null; }
  return { ...row, requirements, address };
}

// The key set linked accounts are made on right now: Razorpay's active
// mode ('test' | 'live'), or null when Razorpay is off.
function currentMode() {
  const cfg = razorpay.activeConfig();
  return cfg ? cfg.mode : null;
}

async function getAccount(userId, mode = currentMode()) {
  if (!mode) return null;
  await ensureTable();
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE user_id = ? AND mode = ? LIMIT 1`, [userId, mode]);
  return toAccount(rows[0]);
}

// The account a split payment may go to — only an activated one.
async function activatedAccount(userId, mode = currentMode()) {
  const acc = await getAccount(userId, mode);
  return acc && acc.status === 'activated' && /^acc_\w+$/.test(acc.account_id) ? acc : null;
}

// Razorpay's activation_status → ours.
function summarize(rzStatus) {
  if (rzStatus === 'activated') return 'activated';
  if (rzStatus === 'needs_clarification') return 'needs_info';
  return 'pending';
}

// What Razorpay still wants, trimmed to what the page shows.
function cleanRequirements(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((r) => ({
    field: String(r.field_reference || '').slice(0, 100),
    reason: String(r.reason_code || '').slice(0, 100),
    status: String(r.status || '').slice(0, 30),
    url: /^https:\/\//.test(String(r.resolution_url || '')) ? String(r.resolution_url).slice(0, 300) : '',
  }));
}

async function saveProductState(rowId, product) {
  const rzStatus = String(product.activation_status || '').slice(0, 30);
  await pool.query(
    `UPDATE ${TABLE} SET rz_status = ?, status = ?, requirements = ?, checked_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [rzStatus, summarize(rzStatus), JSON.stringify(cleanRequirements(product.requirements)), rowId],
  );
}

// --- the form -------------------------------------------------------------

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const GST_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The submitted form → what Razorpay needs. Throws INVALID_INPUT with a
// message for the first problem.
function readForm(body) {
  const f = {
    legal_business_name: text(body.legal_business_name, 200),
    business_type: text(body.business_type, 30),
    subcategory: text(body.subcategory, 60),
    contact_name: text(body.contact_name, 120),
    phone: String(body.phone || '').replace(/\D/g, '').slice(-10),
    pan: text(body.pan, 10).toUpperCase(),
    gst: text(body.gst, 15).toUpperCase(),
    street1: text(body.street1, 100),
    street2: text(body.street2, 100),
    city: text(body.city, 60),
    state: text(body.state, 60).toUpperCase(),
    postal_code: String(body.postal_code || '').replace(/\D/g, ''),
    website: text(body.website, 255),
    account_number: String(body.account_number || '').replace(/\s/g, ''),
    ifsc: text(body.ifsc, 11).toUpperCase(),
    beneficiary_name: text(body.beneficiary_name, 120),
    tnc: body.tnc === '1',
  };
  if (f.legal_business_name.length < 4) throw inputError('Enter your legal business name, as on your PAN or registration.');
  if (!BUSINESS_TYPES[f.business_type]) throw inputError('Pick a business type.');
  if (!SUBCATEGORIES[f.subcategory]) throw inputError('Pick what your store sells.');
  if (f.contact_name.length < 2) throw inputError('Enter a contact name.');
  if (!/^[6-9]\d{9}$/.test(f.phone)) throw inputError('Enter a 10-digit Indian mobile number.');
  if (!PAN_RE.test(f.pan)) throw inputError('That PAN doesn’t look right — it’s 10 characters, like ABCDE1234F.');
  if (f.gst && !GST_RE.test(f.gst)) throw inputError('That GSTIN doesn’t look right — it’s 15 characters. Leave it blank if you don’t have one.');
  if (f.gst && f.gst.slice(2, 12) !== f.pan) throw inputError('Your GSTIN should contain your PAN (characters 3 to 12).');
  if (f.street1.length < 3) throw inputError('Enter your registered address.');
  if (f.city.length < 2) throw inputError('Enter your city.');
  if (!STATES.includes(f.state)) throw inputError('Pick your state.');
  if (!/^[1-9]\d{5}$/.test(f.postal_code)) throw inputError('Enter a 6-digit PIN code.');
  let site;
  try { site = new URL(f.website); } catch (err) { site = null; }
  if (!site || !/^https?:$/.test(site.protocol) || !site.hostname.includes('.')) throw inputError('Enter your store’s website address, like https://mystore.in.');
  f.website = site.origin;
  if (!/^\d{9,18}$/.test(f.account_number)) throw inputError('Enter your bank account number (9 to 18 digits).');
  if (String(body.account_number_confirm || '').replace(/\s/g, '') !== f.account_number) throw inputError('The two bank account numbers don’t match.');
  if (!IFSC_RE.test(f.ifsc)) throw inputError('That IFSC doesn’t look right — it’s 11 characters, like HDFC0001234.');
  if (f.beneficiary_name.length < 3) throw inputError('Enter the name on the bank account.');
  if (!f.tnc) throw inputError('Accept Razorpay’s terms to continue.');
  return f;
}

// A Razorpay error the creator can act on (a bad field), else a generic one.
function razorpayError(err) {
  const desc = err.razorpay && err.razorpay.error && err.razorpay.error.description;
  if (err.status === 400 && desc) return inputError(`Razorpay: ${String(desc).slice(0, 200)}`);
  console.error('Razorpay Route call failed:', err.message);
  return inputError('Couldn’t reach Razorpay just now. Please try again in a minute.');
}

// Creates (or completes, or resubmits) the creator's Linked Account with
// what they entered. Returns the saved account.
async function submit(user, body) {
  const mode = currentMode();
  const cfg = mode && razorpay.configFor(mode);
  if (!cfg) throw inputError('Payouts aren’t available yet. Please try again later.');
  const f = readForm(body || {});
  await ensureTable();

  const address = { street1: f.street1, street2: f.street2, city: f.city, state: f.state, postal_code: f.postal_code, country: 'IN' };
  await pool.query(
    `INSERT INTO ${TABLE} (user_id, mode, legal_business_name, business_type, subcategory, contact_name, phone, pan_last4, gst, address, website, bank_last4, ifsc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE legal_business_name = VALUES(legal_business_name), business_type = VALUES(business_type),
       subcategory = VALUES(subcategory), contact_name = VALUES(contact_name), phone = VALUES(phone), pan_last4 = VALUES(pan_last4),
       gst = VALUES(gst), address = VALUES(address), website = VALUES(website), bank_last4 = VALUES(bank_last4), ifsc = VALUES(ifsc)`,
    [user.id, mode, f.legal_business_name, f.business_type, f.subcategory, f.contact_name, f.phone, f.pan.slice(-4), f.gst,
      JSON.stringify(address), f.website, f.account_number.slice(-4), f.ifsc],
  );
  let acc = await getAccount(user.id, mode);
  if (acc.status === 'activated') throw inputError('Your payout account is already active. Email hello@pagezaper.com to change its details.');

  const profile = {
    category: CATEGORY,
    subcategory: f.subcategory,
    addresses: { registered: { street1: f.street1, street2: f.street2 || f.city, city: f.city, state: f.state, postal_code: f.postal_code, country: 'IN' } },
  };
  const legalInfo = { pan: f.pan, ...(f.gst ? { gst: f.gst } : {}) };
  try {
    // 1. The account — made once, updated on a resubmit.
    if (!acc.account_id) {
      const created = await razorpay.api(cfg, 'POST', '/v2/accounts', {
        email: user.email,
        phone: f.phone,
        type: 'route',
        reference_id: `pz${user.id}`.slice(0, 20),
        legal_business_name: f.legal_business_name,
        business_type: f.business_type,
        contact_name: f.contact_name,
        profile,
        legal_info: legalInfo,
        notes: { pz_user: String(user.id), website: f.website },
      });
      await pool.query(`UPDATE ${TABLE} SET account_id = ? WHERE id = ?`, [String(created.id), acc.id]);
      acc.account_id = String(created.id);
    } else {
      await razorpay.api(cfg, 'PATCH', `/v2/accounts/${encodeURIComponent(acc.account_id)}`, {
        phone: f.phone,
        legal_business_name: f.legal_business_name,
        contact_name: f.contact_name,
        profile,
        legal_info: legalInfo,
        notes: { pz_user: String(user.id), website: f.website },
      });
    }
    const base = `/v2/accounts/${encodeURIComponent(acc.account_id)}`;
    // 2. Who's behind it.
    if (!acc.stakeholder_id) {
      const sth = await razorpay.api(cfg, 'POST', `${base}/stakeholders`, { name: f.contact_name, email: user.email });
      await pool.query(`UPDATE ${TABLE} SET stakeholder_id = ? WHERE id = ?`, [String(sth.id), acc.id]);
    }
    // 3. Ask for Route on it.
    if (!acc.product_id) {
      const product = await razorpay.api(cfg, 'POST', `${base}/products`, { product_name: 'route', tnc_accepted: true });
      await pool.query(`UPDATE ${TABLE} SET product_id = ? WHERE id = ?`, [String(product.id), acc.id]);
      acc.product_id = String(product.id);
    }
    // 4. Where the money goes.
    const product = await razorpay.api(cfg, 'PATCH', `${base}/products/${encodeURIComponent(acc.product_id)}`, {
      settlements: { account_number: f.account_number, ifsc_code: f.ifsc, beneficiary_name: f.beneficiary_name },
      tnc_accepted: true,
    });
    await saveProductState(acc.id, product);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') throw err;
    throw razorpayError(err);
  }
  return getAccount(user.id, mode);
}

// Asks Razorpay where the account's activation stands and saves it. Quiet
// on failure — the page shows the last known status.
async function refresh(acc, { force = false } = {}) {
  if (!acc || !acc.account_id || !acc.product_id) return acc;
  if (!force && acc.checked_at && Date.now() - new Date(acc.checked_at).getTime() < REFRESH_MS) return acc;
  const cfg = razorpay.configFor(acc.mode);
  if (!cfg) return acc;
  try {
    const product = await razorpay.api(cfg, 'GET', `/v2/accounts/${encodeURIComponent(acc.account_id)}/products/${encodeURIComponent(acc.product_id)}`);
    await saveProductState(acc.id, product);
  } catch (err) {
    console.error('Checking Razorpay linked account failed:', err.message);
    return acc;
  }
  return getAccount(acc.user_id, acc.mode);
}

// A signed Razorpay webhook (lib/razorpay.js) about an account: look it up
// and re-check it with the API — the payload itself is never believed.
async function refreshByAccountId(mode, accountId) {
  if (!/^acc_\w+$/.test(String(accountId || ''))) return;
  await ensureTable();
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE mode = ? AND account_id = ? LIMIT 1`, [mode, accountId]);
  if (rows[0]) await refresh(toAccount(rows[0]), { force: true });
}

module.exports = {
  STATUSES,
  BUSINESS_TYPES,
  SUBCATEGORIES,
  STATES,
  ensureTable,
  currentMode,
  getAccount,
  activatedAccount,
  readForm,
  submit,
  refresh,
  refreshByAccountId,
};
