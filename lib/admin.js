// Platform admin panel data (server.js /admin/*): the overview, the users
// list and one user's page. Writes go through lib/users.js and lib/plans.js.
//
// Counts read other apps' tables, which may not exist yet on a fresh install
// (each app creates its own on first use) — a missing table counts as 0.
const pool = require('./db');
const { listPlans, defaultPlan } = require('./plans');
const { platformTotals } = require('./orders');
const { findUserById, ensureUsersTable } = require('./users');

const PER_PAGE = 50;

async function safeRows(sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return [];
    throw err;
  }
}
async function safeCount(sql, params = []) {
  const rows = await safeRows(sql, params);
  return rows.length ? Number(Object.values(rows[0])[0]) || 0 : 0;
}

// Paid payment-page orders per creator.
const ORDER_STATS = `(SELECT user_id, COUNT(*) AS paid_orders, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(platform_fee), 0) AS fees
  FROM PDZ_orders WHERE status = 'paid' GROUP BY user_id)`;

async function overview() {
  await ensureUsersTable();
  await platformTotals(); // also makes sure PDZ_orders exists
  const [[counts]] = await pool.query(`
    SELECT COUNT(*) AS users,
           SUM(created_at >= NOW() - INTERVAL 7 DAY) AS new_7,
           SUM(created_at >= NOW() - INTERVAL 30 DAY) AS new_30,
           SUM(status = 'suspended') AS suspended
    FROM PDZ_users`);
  const [plans, def, totals, recent, byPlan, topSellers] = await Promise.all([
    listPlans(),
    defaultPlan(),
    platformTotals(),
    pool.query('SELECT id, name, email, handle, created_at, status FROM PDZ_users ORDER BY created_at DESC, id DESC LIMIT 8').then(([r]) => r),
    pool.query('SELECT plan_id, COUNT(*) AS n FROM PDZ_users GROUP BY plan_id').then(([r]) => r),
    pool.query(`SELECT u.id, u.name, u.handle, o.paid_orders, o.revenue, o.fees FROM ${ORDER_STATS} o
                JOIN PDZ_users u ON u.id = o.user_id ORDER BY o.revenue DESC LIMIT 5`).then(([r]) => r),
  ]);
  // Users per plan; anyone without a plan (or on a removed one) is on the default.
  const perPlan = new Map(plans.map((p) => [p.id, 0]));
  byPlan.forEach((r) => {
    const id = perPlan.has(r.plan_id) ? r.plan_id : def.id;
    perPlan.set(id, perPlan.get(id) + Number(r.n));
  });
  // Signups per day for the last 14 days, oldest first.
  // Days as local 'YYYY-MM-DD' on both sides (toISOString would be UTC — a
  // day early here).
  const [daily] = await pool.query(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM PDZ_users
    WHERE created_at >= CURDATE() - INTERVAL 13 DAY GROUP BY day`);
  const byDay = new Map(daily.map((d) => [d.day, Number(d.n)]));
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const signups = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    signups.push({ day: ymd(d), n: byDay.get(ymd(d)) || 0 });
  }
  return {
    users: Number(counts.users) || 0,
    new7: Number(counts.new_7) || 0,
    new30: Number(counts.new_30) || 0,
    suspended: Number(counts.suspended) || 0,
    totals,
    plans: plans.map((p) => ({ ...p, users: perPlan.get(p.id) || 0 })),
    recent,
    topSellers,
    signups,
  };
}

// The users list: search (name, email, store link), plan and status
// filters, newest first, PER_PAGE at a time.
async function listUsers({ q = '', plan = '', status = '', page = 1 } = {}) {
  await ensureUsersTable();
  await platformTotals();
  const def = await defaultPlan();
  const where = [];
  const params = [];
  const term = String(q).trim().slice(0, 100);
  if (term) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.handle LIKE ?)');
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }
  const planId = Number(plan);
  if (Number.isInteger(planId) && planId > 0) {
    if (planId === def.id) {
      where.push('(u.plan_id IS NULL OR u.plan_id = ? OR u.plan_id NOT IN (SELECT id FROM PDZ_plans))');
      params.push(planId);
    } else {
      where.push('u.plan_id = ?');
      params.push(planId);
    }
  }
  if (status === 'active' || status === 'suspended') {
    where.push('u.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM PDZ_users u ${whereSql}`, params);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.handle, u.plan_id, u.status, u.created_at,
            COALESCE(o.paid_orders, 0) AS paid_orders, COALESCE(o.revenue, 0) AS revenue
     FROM PDZ_users u LEFT JOIN ${ORDER_STATS} o ON o.user_id = u.id
     ${whereSql} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`,
    [...params, PER_PAGE, (current - 1) * PER_PAGE],
  );
  return { users: rows, total: Number(total), page: current, pages };
}

// One creator: their account, plan, what they've built, and their sales.
async function userDetail(id) {
  const user = await findUserById(id);
  if (!user) return null;
  const uid = user.id;
  const [pages, magnets, blocks, contacts, services, events, courses, bookings, sales, recentOrders] = await Promise.all([
    safeCount('SELECT COUNT(*) FROM PDZ_payment_pages WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_lead_magnets WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_blocks WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_contacts WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_booking_services WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_events WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_courses WHERE user_id = ?', [uid]),
    safeCount('SELECT COUNT(*) FROM PDZ_bookings WHERE user_id = ?', [uid]),
    safeRows(`SELECT COUNT(*) AS paid_orders, COALESCE(SUM(total), 0) AS revenue, COALESCE(SUM(platform_fee), 0) AS fees
              FROM PDZ_orders WHERE user_id = ? AND status = 'paid'`, [uid]),
    safeRows(`SELECT id, buyer_name, buyer_email, total, platform_fee, status, source, created_at
              FROM PDZ_orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 8`, [uid]),
  ]);
  const s = sales[0] || {};
  return {
    user,
    counts: { pages, magnets, blocks, contacts, services, events, courses, bookings },
    sales: { paid_orders: Number(s.paid_orders) || 0, revenue: Number(s.revenue) || 0, fees: Number(s.fees) || 0 },
    recentOrders,
  };
}

module.exports = { overview, listUsers, userDetail, PER_PAGE };
