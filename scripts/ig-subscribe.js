// Subscribes every connected Instagram account to the app's webhooks:
// GET /{ig-user-id}/subscribed_apps, then POST it with
// subscribed_fields=comments,messages on graph.facebook.com, then GET again,
// printing Meta's response to each. Accounts
// connected before the connect flow did this need it once.
//
//   node scripts/ig-subscribe.js            subscribe + print every account
//   node scripts/ig-subscribe.js --check    only print current subscribed_apps
//
// Run from the app folder so .env is found. Never prints tokens.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../lib/db');
const ig = require('../lib/instagram');

const checkOnly = process.argv.includes('--check');
const show = (x) => JSON.stringify(x, null, 2);

async function main() {
  if (!ig.instagramEnabled()) {
    console.error(`Instagram is switched off; missing in .env: ${ig.missingConfig().join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Graph API: ${ig.API}${checkOnly ? '  (check only)' : ''}`);
  const [rows] = await pool.query('SELECT user_id, ig_user_id, username, token, needs_reconnect, token_expires_at FROM PDZ_instagram_accounts ORDER BY user_id');
  if (!rows.length) console.log('No connected Instagram accounts.');

  for (const row of rows) {
    console.log(`\n=== @${row.username} ig_user_id=${row.ig_user_id} (PageZaper user ${row.user_id})${row.needs_reconnect ? '  [needs_reconnect=1]' : ''} token_expires_at=${row.token_expires_at || 'never'}`);
    let token;
    try {
      token = ig.decryptToken(row.token);
    } catch (err) {
      console.error('  ✗ cannot decrypt the stored token (TOKEN_ENC_KEY changed?) — the account must reconnect.');
      continue;
    }
    try {
      console.log('  GET subscribed_apps (before):', show(await ig.getSubscribedApps(token, row.ig_user_id)));
    } catch (err) {
      console.error('  ✗ GET subscribed_apps failed:', err.message, show(err.meta));
    }
    if (checkOnly) continue;
    try {
      const sub = await ig.subscribeToComments(token, row.ig_user_id);
      console.log(`  ✓ POST subscribed_apps?subscribed_fields=${sub.fields} →`, show(sub.response));
    } catch (err) {
      console.error('  ✗ POST subscribed_apps failed:', err.message, show(err.meta));
      continue;
    }
    try {
      console.log('  GET subscribed_apps (after):', show(await ig.getSubscribedApps(token, row.ig_user_id)));
    } catch (err) {
      console.error('  ✗ GET subscribed_apps failed:', err.message, show(err.meta));
    }
  }
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
