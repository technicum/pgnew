// Plans creators are on (Platform admin → Plans, server.js /admin/plans).
//
// A plan has a name, prices (shown to creators; charging for them isn't wired
// up yet — an admin puts a creator on a plan), a description, a feature list,
// and optionally its own transaction fees: a creator on a plan with fees set
// pays those instead of the platform's defaults (lib/platform.js feesFor).
// Blank fees mean "the platform default".
//
// One plan is the default: every creator not put on another plan is on it.
// A "Free" default is created the first time, so there's always one.
const pool = require('./db');

const TABLE = 'PDZ_plans';
const MAX_PCT = 50;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(60) NOT NULL,
          description VARCHAR(300) NOT NULL DEFAULT '',
          features TEXT NULL,
          price_month INT NOT NULL DEFAULT 0,
          price_year INT NOT NULL DEFAULT 0,
          direct_pct DECIMAL(5,2) NULL DEFAULT NULL,
          marketplace_pct DECIMAL(5,2) NULL DEFAULT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE}`);
      if (!n) {
        await pool.query(
          `INSERT INTO ${TABLE} (name, description, features, is_default, sort_order) VALUES (?, ?, ?, 1, 0)`,
          ['Free', 'Everything you need to start selling.', 'Your store page\nPayment pages, bookings, events and courses\nAudience and lead magnets'],
        );
      }
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function inputError(message) {
  const err = new Error(message);
  err.code = 'INVALID_INPUT';
  return err;
}

function toPlan(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    features: String(row.features || '').split('\n').map((f) => f.trim()).filter(Boolean),
    price_month: row.price_month,
    price_year: row.price_year,
    direct_pct: row.direct_pct === null ? null : Number(row.direct_pct),
    marketplace_pct: row.marketplace_pct === null ? null : Number(row.marketplace_pct),
    is_default: !!row.is_default,
    active: !!row.active,
    sort_order: row.sort_order,
  };
}

// Plans change rarely and are read on every sale, so they're cached here
// (one server process); every change below clears it.
let cache = null;
async function listPlans() {
  if (!cache) {
    await ensureTable();
    const [rows] = await pool.query(`SELECT * FROM ${TABLE} ORDER BY sort_order ASC, price_month ASC, id ASC`);
    cache = rows.map(toPlan);
  }
  return cache;
}
const forget = () => { cache = null; };

async function getPlan(id) {
  return (await listPlans()).find((p) => p.id === Number(id)) || null;
}
async function defaultPlan() {
  const plans = await listPlans();
  return plans.find((p) => p.is_default) || plans[0];
}
// The plan a creator is on: their plan_id, or the default.
async function planOf(user) {
  return (user && user.plan_id && await getPlan(user.plan_id)) || defaultPlan();
}

// '499', '4,999.50' → paise; '' → 0.
function readPrice(raw, label) {
  const text = String(raw ?? '').replace(/[₹,\s]/g, '');
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw inputError(`${label} needs to be an amount in rupees, like 499.`);
  const paise = Math.round(Number(text) * 100);
  if (paise > 10000000) throw inputError(`${label} can be up to ₹1,00,000.`);
  return paise;
}
// '' → null (platform default); '5', '2.5' → a number from 0 to MAX_PCT.
function readPct(raw, label) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) > MAX_PCT) {
    throw inputError(`${label} needs to be a percentage from 0 to ${MAX_PCT}, like 5 or 2.5 — or blank for the platform default.`);
  }
  return Number(text);
}

function planFields(body) {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) throw inputError('Give the plan a name, like “Pro”.');
  const features = String(body.features || '').split('\n').map((f) => f.trim().slice(0, 120)).filter(Boolean).slice(0, 20);
  return {
    name,
    description: String(body.description || '').trim().slice(0, 300),
    features: features.join('\n'),
    price_month: readPrice(body.price_month, 'The monthly price'),
    price_year: readPrice(body.price_year, 'The yearly price'),
    direct_pct: readPct(body.direct_pct, 'The direct sales fee'),
    marketplace_pct: readPct(body.marketplace_pct, 'The marketplace sales fee'),
    active: body.active ? 1 : 0,
    sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
  };
}

async function createPlan(body) {
  await ensureTable();
  const f = planFields(body || {});
  const cols = Object.keys(f);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => f[c]),
  );
  forget();
  return result.insertId;
}

async function updatePlan(id, body) {
  await ensureTable();
  const plan = await getPlan(id);
  if (!plan) throw inputError('That plan doesn’t exist.');
  const f = planFields(body || {});
  // The default plan is always offered.
  if (plan.is_default) f.active = 1;
  const cols = Object.keys(f);
  await pool.query(`UPDATE ${TABLE} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => f[c]), plan.id]);
  forget();
}

async function setDefaultPlan(id) {
  await ensureTable();
  const plan = await getPlan(id);
  if (!plan) throw inputError('That plan doesn’t exist.');
  await pool.query(`UPDATE ${TABLE} SET is_default = (id = ?), active = IF(id = ?, 1, active)`, [plan.id, plan.id]);
  forget();
}

// Removing a plan moves anyone on it to the default plan. The default plan
// itself can't be removed — make another the default first.
async function deletePlan(id) {
  await ensureTable();
  const plan = await getPlan(id);
  if (!plan) throw inputError('That plan doesn’t exist.');
  if (plan.is_default) throw inputError('That’s the default plan — make another plan the default first.');
  await pool.query('UPDATE PDZ_users SET plan_id = NULL WHERE plan_id = ?', [plan.id]);
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ?`, [plan.id]);
  forget();
}

module.exports = {
  listPlans, getPlan, defaultPlan, planOf, createPlan, updatePlan, setDefaultPlan, deletePlan, MAX_PCT,
};
