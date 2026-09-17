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

// Full marketplace listing for the Apps screen: every published app plus
// this store's status against it (bundled by plan / individually active /
// available to activate).
async function listAppsForStore(storeId, storePlanSlug) {
  const [apps] = await pool.query(`SELECT * FROM ${TABLES.apps} WHERE status = 'published' ORDER BY name`);
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

module.exports = { getActiveAppSlugs, isAppActive, listAppsForStore, activateApp, deactivateApp };
