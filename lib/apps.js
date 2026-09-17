// Paid-app helpers (CRM is the first app). Mirrors the themes/store_themes
// marketplace pattern already used elsewhere in this codebase: pz_apps is
// the catalog, pz_store_apps is a per-store install, and pz_plan_apps lets
// a plan tier bundle an app in for free. This file is the single source of
// truth for "is app X on for store Y right now" so the admin nav
// (res.locals.activeAppSlugs, set once per request in routes/admin.js) and
// any route guard both agree with the Apps marketplace screen.
const { pool, TABLES } = require('../db/database');

// Every app slug active for this store: either bundled free by its plan, or
// individually activated via pz_store_apps.is_active. storePlanSlug is
// req.store.plan ('free' | 'starter' | 'pro' today) — pass it in rather
// than re-querying pz_stores here.
async function getActiveAppSlugs(storeId, storePlanSlug) {
  const [rows] = await pool.query(
    `SELECT DISTINCT a.slug
     FROM ${TABLES.apps} a
     LEFT JOIN ${TABLES.storeApps} sa ON sa.app_id = a.id AND sa.store_id = ? AND sa.is_active = 1
     LEFT JOIN ${TABLES.planApps} pa ON pa.app_id = a.id
     LEFT JOIN ${TABLES.plans} p ON p.id = pa.plan_id AND p.slug = ?
     WHERE sa.id IS NOT NULL OR p.id IS NOT NULL`,
    [storeId, storePlanSlug || null]
  );
  return rows.map((r) => r.slug);
}

async function isAppActive(storeId, slug, storePlanSlug) {
  const slugs = await getActiveAppSlugs(storeId, storePlanSlug);
  return slugs.includes(slug);
}

// Full marketplace listing for the Apps screen: every published *store*-
// scoped app plus this store's status against it (bundled by plan /
// individually active / available to activate). Account-scoped apps (CRM)
// are deliberately excluded here — they install against a login, not a
// store, and are activated from their own account-level screen instead
// (see the getActiveAccountAppSlugs/activateAccountApp family below).
async function listAppsForStore(storeId, storePlanSlug) {
  const [apps] = await pool.query(`SELECT * FROM ${TABLES.apps} WHERE status = 'published' AND scope = 'store' ORDER BY name`);
  const [storeAppRows] = await pool.query(
    `SELECT app_id, is_active FROM ${TABLES.storeApps} WHERE store_id = ?`,
    [storeId]
  );
  let planAppRows = [];
  if (storePlanSlug) {
    [planAppRows] = await pool.query(
      `SELECT pa.app_id FROM ${TABLES.planApps} pa
       JOIN ${TABLES.plans} p ON p.id = pa.plan_id
       WHERE p.slug = ?`,
      [storePlanSlug]
    );
  }
  const activeStoreAppIds = new Set(storeAppRows.filter((r) => r.is_active).map((r) => r.app_id));
  const bundledAppIds = new Set(planAppRows.map((r) => r.app_id));

  return apps.map((app) => {
    const bundled = bundledAppIds.has(app.id);
    const installed = activeStoreAppIds.has(app.id);
    return {
      ...app,
      price_cents: Number(app.price_cents),
      bundled,
      installed,
      active: bundled || installed,
    };
  });
}

async function activateApp(storeId, appId) {
  await pool.query(
    `INSERT INTO ${TABLES.storeApps} (store_id, app_id, is_active) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE is_active = 1`,
    [storeId, appId]
  );
}

async function deactivateApp(storeId, appId) {
  await pool.query(`UPDATE ${TABLES.storeApps} SET is_active = 0 WHERE store_id = ? AND app_id = ?`, [storeId, appId]);
}

// ---- Account-scoped apps (CRM) -- mirrors everything above, but keyed to
// a pz_users login (userId) via pz_user_apps instead of a store. Bundling
// by plan is checked against every ACTIVE store that login administers
// (role = 'admin' in pz_user_roles) -- if any one of them sits on a
// bundling plan, the account gets the app free, same spirit as "included
// in your Pro plan" at the store level.
async function getActiveAccountAppSlugs(userId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT a.slug
     FROM ${TABLES.apps} a
     LEFT JOIN ${TABLES.userApps} ua ON ua.app_id = a.id AND ua.user_id = ? AND ua.is_active = 1
     LEFT JOIN ${TABLES.planApps} pa ON pa.app_id = a.id
     LEFT JOIN ${TABLES.plans} p ON p.id = pa.plan_id
     LEFT JOIN ${TABLES.userRoles} ur ON ur.user_id = ? AND ur.role = 'admin'
     LEFT JOIN ${TABLES.stores} s ON s.id = ur.store_id AND s.status = 'active' AND s.plan = p.slug
     WHERE a.scope = 'account' AND (ua.id IS NOT NULL OR s.id IS NOT NULL)`,
    [userId, userId]
  );
  return rows.map((r) => r.slug);
}

async function isAccountAppActive(userId, slug) {
  const slugs = await getActiveAccountAppSlugs(userId);
  return slugs.includes(slug);
}

async function activateAccountApp(userId, appId) {
  await pool.query(
    `INSERT INTO ${TABLES.userApps} (user_id, app_id, is_active) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE is_active = 1`,
    [userId, appId]
  );
}

module.exports = {
  getActiveAppSlugs,
  isAppActive,
  listAppsForStore,
  activateApp,
  deactivateApp,
  getActiveAccountAppSlugs,
  isAccountAppActive,
  activateAccountApp,
};
