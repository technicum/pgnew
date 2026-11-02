// AutoDM (Explore apps): when someone comments a keyword on a creator's
// Instagram post, send them a DM. views/autodm.ejs is the dashboard page,
// lib/instagram.js the calls to Instagram.
//
//   installAutoDmWebhooks(app)            before the session middleware
//   installAutoDm(app, { requireAuth, siteName })
//
// Promises made in views/privacy-policy.ejs that this file keeps: tokens are
// encrypted, Disconnect and Meta's removal callbacks delete everything stored
// here, and the activity log is purged after 90 days. Change them together.
const crypto = require('crypto');
const pool = require('./db');
const ig = require('./instagram');
const { lazyTables, cleanText, inputError } = require('./appKit');

const ACCOUNTS = 'PDZ_instagram_accounts';
const AUTOMATIONS = 'PDZ_autodm_automations';
const LOG = 'PDZ_autodm_log';

const LOG_DAYS = 90;
const MAX_DM_BYTES = 1000; // Instagram's limit on a message's text
const MAX_REPLY = 300;
const JOB_EVERY_MS = 6 * 60 * 60 * 1000;

const ensureTables = lazyTables([
  `CREATE TABLE IF NOT EXISTS ${ACCOUNTS} (
    user_id INT NOT NULL PRIMARY KEY,
    ig_user_id VARCHAR(40) NOT NULL,
    scoped_id VARCHAR(40) NOT NULL DEFAULT '',
    username VARCHAR(100) NOT NULL DEFAULT '',
    token TEXT NOT NULL,
    token_expires_at DATETIME NULL DEFAULT NULL,
    needs_reconnect TINYINT(1) NOT NULL DEFAULT 0,
    connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ig_user (ig_user_id),
    INDEX (scoped_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${AUTOMATIONS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    media_id VARCHAR(40) NOT NULL DEFAULT '',
    media_label VARCHAR(120) NOT NULL DEFAULT '',
    keywords VARCHAR(500) NOT NULL DEFAULT '',
    dm_text TEXT NOT NULL,
    link_url VARCHAR(500) NOT NULL DEFAULT '',
    comment_reply VARCHAR(${MAX_REPLY}) NOT NULL DEFAULT '',
    active TINYINT(1) NOT NULL DEFAULT 1,
    sent_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (user_id)
  )`,
  // Added after the table existed in production.
  ...["name VARCHAR(190) NOT NULL DEFAULT ''", 'profile_picture_url TEXT NULL', "scopes VARCHAR(255) NOT NULL DEFAULT ''",
    "token_type VARCHAR(30) NOT NULL DEFAULT ''", "client_business_id VARCHAR(40) NOT NULL DEFAULT ''", "config_id VARCHAR(40) NOT NULL DEFAULT ''",
    'updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
  ].map((column) => ({ sql: `ALTER TABLE ${ACCOUNTS} ADD COLUMN ${column}`, ignore: ['ER_DUP_FIELDNAME'] })),
  // comment_id is unique so a webhook Meta delivers twice sends one DM.
  `CREATE TABLE IF NOT EXISTS ${LOG} (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    automation_id INT NOT NULL,
    comment_id VARCHAR(60) NOT NULL,
    commenter_id VARCHAR(40) NOT NULL DEFAULT '',
    commenter_name VARCHAR(100) NOT NULL DEFAULT '',
    comment_text VARCHAR(300) NOT NULL DEFAULT '',
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    error VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY comment (comment_id),
    INDEX (user_id, created_at),
    INDEX (automation_id, commenter_id),
    INDEX (created_at)
  )`,
]);

// --- Accounts ---
async function getAccount(userId) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${ACCOUNTS} WHERE user_id = ? LIMIT 1`, [userId]);
  return row || null;
}

// Instagram's picture links expire, so the Settings page keeps this one fresh.
// A failure just leaves the stored details in place.
async function refreshProfile(account) {
  try {
    const profile = await ig.fetchProfile(ig.decryptToken(account.token), account.ig_user_id);
    const picture = profile.profile_picture_url || '';
    const username = cleanText(profile.username, 100) || account.username;
    await pool.query(`UPDATE ${ACCOUNTS} SET username = ?, name = ?, profile_picture_url = ? WHERE user_id = ?`,
      [username, cleanText(profile.name, 190), picture, account.user_id]);
    return { ...account, username, profile_picture_url: picture };
  } catch (err) {
    if (err.tokenInvalid) {
      await markNeedsReconnect(account.user_id);
      return { ...account, needs_reconnect: 1 };
    }
    return account;
  }
}

// A new token from the login → the stored account. One token can cover several
// Instagram accounts, but a PageZaper account holds one: the first is used.
// Tags a failure with the step it happened in, so the connect error says where.
const step = (name, promise) => promise.catch((err) => {
  if (!err.step) err.step = name;
  throw err;
});

async function connectAccount(userId, accessToken) {
  await step('preparing the database', ensureTables());
  const token = await step('checking the token', ig.inspectToken(accessToken));
  if (!token.valid) throw new Error('Meta says the new token isn’t valid.');
  if (ig.REQUIRED_SCOPES.some((scope) => !token.scopes.includes(scope))) {
    throw inputError('Instagram didn’t grant every permission PageZaper needs. Please connect again and allow them all.');
  }
  const [business, accounts] = await Promise.all([
    step('reading the business (/me)', ig.fetchBusiness(accessToken)),
    step('listing Instagram accounts (/me/assigned_instagram_accounts)', ig.listAssignedAccounts(accessToken)),
  ]);
  const first = accounts[0] || (token.igUserIds[0] ? { id: token.igUserIds[0] } : null);
  if (!first) throw inputError('No Instagram account was shared. Connect again and choose your Business or Creator account.');
  const igUserId = String(first.id);
  const profile = await step('reading the Instagram profile', ig.fetchProfile(accessToken, igUserId)).catch((err) => {
    if (!first.username) throw err;
    return first;
  });
  const [[taken]] = await step('checking existing connections', pool.query(`SELECT user_id FROM ${ACCOUNTS} WHERE ig_user_id = ? AND user_id <> ? LIMIT 1`, [igUserId, userId]));
  if (taken) throw inputError(`@${profile.username} is already connected to another PageZaper account.`);
  await step('subscribing to comment webhooks', ig.subscribeToComments(accessToken, igUserId));
  await step('saving the account', pool.query(
    `INSERT INTO ${ACCOUNTS} (user_id, ig_user_id, scoped_id, username, name, profile_picture_url, scopes, token_type, client_business_id, config_id, token, token_expires_at, needs_reconnect)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE ig_user_id = VALUES(ig_user_id), scoped_id = VALUES(scoped_id), username = VALUES(username),
       name = VALUES(name), profile_picture_url = VALUES(profile_picture_url), scopes = VALUES(scopes), token_type = VALUES(token_type),
       client_business_id = VALUES(client_business_id), config_id = VALUES(config_id),
       token = VALUES(token), token_expires_at = VALUES(token_expires_at), needs_reconnect = 0`,
    [userId, igUserId, String(business.id || ''), cleanText(profile.username, 100), cleanText(profile.name, 190), profile.profile_picture_url || '',
      cleanText(token.scopes.join(','), 255), cleanText(token.type, 30), String(business.client_business_id || ''), String(process.env.FB_LOGIN_CONFIG_ID || ''),
      ig.encryptToken(accessToken), token.expiresAt],
  ));
}

async function deleteEverything(userId) {
  await ensureTables();
  await pool.query(`DELETE FROM ${LOG} WHERE user_id = ?`, [userId]);
  await pool.query(`DELETE FROM ${AUTOMATIONS} WHERE user_id = ?`, [userId]);
  await pool.query(`DELETE FROM ${ACCOUNTS} WHERE user_id = ?`, [userId]);
}

// Disconnect: stop Instagram sending us events, then delete. A failed call to
// Instagram (say the token was already revoked) never blocks the delete.
async function disconnect(userId) {
  const account = await getAccount(userId);
  if (account) {
    try {
      await ig.unsubscribe(ig.decryptToken(account.token), account.ig_user_id);
    } catch (err) {
      console.error('AutoDM: unsubscribe failed on disconnect:', err.message);
    }
  }
  await deleteEverything(userId);
}

// Meta's callbacks identify the person by either id, depending on the app type.
async function deleteByMetaUser(metaUserId) {
  await ensureTables();
  const id = String(metaUserId || '');
  if (!id) return;
  const [rows] = await pool.query(`SELECT user_id FROM ${ACCOUNTS} WHERE ig_user_id = ? OR scoped_id = ?`, [id, id]);
  await Promise.all(rows.map((r) => deleteEverything(r.user_id)));
}

const markNeedsReconnect = (userId) => pool.query(`UPDATE ${ACCOUNTS} SET needs_reconnect = 1 WHERE user_id = ?`, [userId]);

// --- Automations ---
const parseKeywords = (raw) => [...new Set(String(raw || '').split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean))];

function dmMessage(a) {
  return a.link_url ? `${a.dm_text}\n\n${a.link_url}` : a.dm_text;
}

function readAutomation(body) {
  const out = {
    name: cleanText(body.name, 120),
    media_id: /^\d{1,40}$/.test(String(body.media_id || '')) ? String(body.media_id) : '',
    media_label: cleanText(body.media_label, 120),
    keywords: parseKeywords(body.keywords).join(', ').slice(0, 500),
    dm_text: cleanText(body.dm_text, 2000),
    link_url: cleanText(body.link_url, 500),
    comment_reply: cleanText(body.comment_reply, MAX_REPLY),
  };
  if (!out.name) throw inputError('Give this automation a name.');
  if (!out.dm_text) throw inputError('Write the message to send.');
  if (out.link_url && !/^https:\/\/[^\s]+$/i.test(out.link_url)) throw inputError('The link needs to start with https://');
  if (Buffer.byteLength(dmMessage(out), 'utf8') > MAX_DM_BYTES) throw inputError('That message is too long for Instagram — keep the message and link under 1000 characters.');
  if (!out.media_id) out.media_label = '';
  return out;
}

async function listAutomations(userId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${AUTOMATIONS} WHERE user_id = ? ORDER BY id DESC`, [userId]);
  return rows;
}

async function getAutomation(userId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${AUTOMATIONS} WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
  return row || null;
}

async function createAutomation(userId, body) {
  await ensureTables();
  const a = readAutomation(body);
  await pool.query(`INSERT INTO ${AUTOMATIONS} SET ?`, [{ ...a, user_id: userId }]);
}

async function updateAutomation(userId, id, body) {
  await ensureTables();
  await pool.query(`UPDATE ${AUTOMATIONS} SET ? WHERE id = ? AND user_id = ?`, [readAutomation(body), id, userId]);
}

async function setAutomationActive(userId, id, active) {
  await ensureTables();
  await pool.query(`UPDATE ${AUTOMATIONS} SET active = ? WHERE id = ? AND user_id = ?`, [active ? 1 : 0, id, userId]);
}

async function deleteAutomation(userId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${AUTOMATIONS} WHERE id = ? AND user_id = ?`, [id, userId]);
}

async function listActivity(userId, limit = 50) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT l.*, a.name AS automation_name FROM ${LOG} l LEFT JOIN ${AUTOMATIONS} a ON a.id = l.automation_id
     WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ?`,
    [userId, limit],
  );
  return rows;
}

// --- Matching a comment ---
// Whole words, any case, any script: "guide" matches "Guide please!" but not
// "guidelines"; "free guide" matches as a phrase.
const words = (text) => ` ${String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;

function matchesKeywords(commentText, keywords) {
  const list = parseKeywords(keywords);
  if (!list.length) return true; // no keywords: every comment
  const haystack = words(commentText);
  return list.some((k) => {
    const needle = words(k);
    return needle.trim() && haystack.includes(needle);
  });
}

// The automation for a comment: one set on this post before one on every
// post, and only one ever fires.
function pickAutomation(automations, mediaId, text) {
  const live = automations.filter((a) => a.active && (!a.media_id || a.media_id === mediaId) && matchesKeywords(text, a.keywords));
  return live.find((a) => a.media_id) || live[0] || null;
}

// --- Handling one comment from the webhook ---
async function handleComment(igUserId, value) {
  const commentId = String(value?.comment_id || value?.id || '');
  const fromId = String(value?.from?.id || '');
  const mediaId = String(value?.media?.id || '');
  if (!commentId || !fromId) return;
  // Our own public reply arrives as a comment too; answering it would loop.
  if (fromId === igUserId) return;

  const [[account]] = await pool.query(
    `SELECT a.*, u.status AS user_status FROM ${ACCOUNTS} a JOIN PDZ_users u ON u.id = a.user_id WHERE a.ig_user_id = ? LIMIT 1`,
    [igUserId],
  );
  if (!account || account.user_status === 'suspended' || account.needs_reconnect) return;

  const automations = await listAutomations(account.user_id);
  const automation = pickAutomation(automations, mediaId, value.text);
  if (!automation) return;

  // One DM per person per automation, however many times they comment.
  const [[seen]] = await pool.query(
    `SELECT id FROM ${LOG} WHERE automation_id = ? AND commenter_id = ? AND status = 'sent' LIMIT 1`,
    [automation.id, fromId],
  );
  if (seen) return;

  // The insert claims the comment, so a repeat delivery stops here.
  const [claim] = await pool.query(
    `INSERT IGNORE INTO ${LOG} (user_id, automation_id, comment_id, commenter_id, commenter_name, comment_text) VALUES (?, ?, ?, ?, ?, ?)`,
    [account.user_id, automation.id, commentId, fromId, cleanText(value.from.username, 100), cleanText(value.text, 300)],
  );
  if (!claim.affectedRows) return;

  const finish = (status, error = '') => pool.query(`UPDATE ${LOG} SET status = ?, error = ? WHERE comment_id = ?`, [status, cleanText(error, 255), commentId]);
  try {
    const token = ig.decryptToken(account.token);
    await ig.sendPrivateReply(token, account.ig_user_id, commentId, dmMessage(automation));
    await finish('sent');
    await pool.query(`UPDATE ${AUTOMATIONS} SET sent_count = sent_count + 1 WHERE id = ?`, [automation.id]);
    if (automation.comment_reply) {
      // The DM already went out; a failed public reply is only noted.
      await ig.replyToComment(token, commentId, automation.comment_reply).catch((err) => finish('sent', `DM sent. Comment reply failed: ${err.message}`));
    }
  } catch (err) {
    await finish('failed', err.message);
    if (err.tokenInvalid) await markNeedsReconnect(account.user_id);
  }
}

async function handleWebhook(payload) {
  await ensureTables();
  if (payload?.object !== 'instagram') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        // One bad comment mustn't drop the rest of the batch.
        await handleComment(String(entry.id), change.value).catch((err) => console.error('AutoDM: comment failed:', err));
      }
    }
  }
}

// --- Upkeep: keep the 90-day promise, and pause accounts whose token ran out ---
// System user tokens have no refresh call: one set to expire can only be
// replaced by the client connecting again.
async function runUpkeep() {
  await ensureTables();
  await pool.query(`DELETE FROM ${LOG} WHERE created_at < NOW() - INTERVAL ? DAY`, [LOG_DAYS]);
  await pool.query(`UPDATE ${ACCOUNTS} SET needs_reconnect = 1 WHERE needs_reconnect = 0 AND token_expires_at < NOW()`);
}

// --- Routes ---
const OK_MESSAGES = {
  connected: 'Instagram connected.',
  disconnected: 'Instagram disconnected. Your token, automations and activity have been deleted.',
  saved: 'Saved.',
  deleted: 'Deleted.',
};

// Meta's calls carry no session, so these sit before the session middleware.
// The raw body for the signature comes from express.json in server.js.
function installAutoDmWebhooks(app) {
  app.get('/webhooks/instagram', (req, res) => {
    const token = String(req.query['hub.verify_token'] || '');
    if (ig.instagramEnabled() && req.query['hub.mode'] === 'subscribe' && token === process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
      return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  app.post('/webhooks/instagram', (req, res) => {
    if (!ig.instagramEnabled() || !ig.validWebhookSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(403);
    // Answer at once: Meta retries and eventually disables slow webhooks.
    res.sendStatus(200);
    handleWebhook(req.body).catch((err) => console.error('AutoDM: webhook failed:', err));
  });

  // The app was removed on Instagram's side.
  app.post('/webhooks/instagram/deauthorize', (req, res, next) => {
    const data = ig.instagramEnabled() ? ig.parseSignedRequest(req.body?.signed_request) : null;
    if (!data) return res.sendStatus(403);
    deleteByMetaUser(data.user_id).then(() => res.sendStatus(200), next);
  });

  // Deletion runs before this answers, so the status page has nothing to look up.
  app.post('/webhooks/instagram/data-deletion', (req, res, next) => {
    const data = ig.instagramEnabled() ? ig.parseSignedRequest(req.body?.signed_request) : null;
    if (!data) return res.sendStatus(403);
    deleteByMetaUser(data.user_id).then(() => {
      const code = crypto.randomBytes(8).toString('hex');
      res.json({ url: `${req.protocol}://${req.get('host')}/instagram/data-deletion?code=${code}`, confirmation_code: code });
    }, next);
  });

  app.get('/instagram/data-deletion', (req, res) => {
    res.type('text/plain').send('Your Instagram data has been deleted from PageZaper. Deletion requests are completed as soon as they are received.');
  });
}

function installAutoDm(app, { requireAuth, siteName }) {
  const id = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
  const fail = (res, target, err) => res.redirect(303, `${target}?error=${encodeURIComponent(err.message)}`);
  const action = (target, fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return fail(res, typeof target === 'function' ? target(req) : target, err);
      next(err);
    }
  };

  const page = async (req, res, editing) => {
    const userId = req.session.user.id;
    const account = ig.instagramEnabled() ? await getAccount(userId) : null;
    const [automations, activity] = account ? await Promise.all([listAutomations(userId), listActivity(userId)]) : [[], []];
    // Posts for the picker. If this fails the page still works: "every post".
    let media = [];
    let mediaError = false;
    if (account && !account.needs_reconnect) {
      try {
        media = await ig.listMedia(ig.decryptToken(account.token), account.ig_user_id);
      } catch (err) {
        mediaError = true;
        if (err.tokenInvalid) {
          await markNeedsReconnect(userId);
          account.needs_reconnect = 1;
        }
      }
    }
    res.render('autodm', {
      title: `AutoDM — ${siteName}`,
      user: req.session.user,
      enabled: ig.instagramEnabled(),
      account, automations, activity, media, mediaError, editing,
      flash: req.query.error
        ? { kind: 'error', text: String(req.query.error).slice(0, 200) }
        : OK_MESSAGES[req.query.ok] ? { kind: 'ok', text: OK_MESSAGES[req.query.ok] } : null,
    });
  };

  app.get('/dashboard/autodm', requireAuth, async (req, res, next) => {
    try { await page(req, res, null); } catch (err) { next(err); }
  });

  app.post('/dashboard/autodm/automations', requireAuth, action('/dashboard/autodm', async (req, res) => {
    await createAutomation(req.session.user.id, req.body || {});
    res.redirect(303, '/dashboard/autodm?ok=saved');
  }));

  app.get('/dashboard/autodm/automations/:id', requireAuth, async (req, res, next) => {
    try {
      const editing = id(req.params.id) && await getAutomation(req.session.user.id, id(req.params.id));
      if (!editing) return res.redirect('/dashboard/autodm');
      await page(req, res, editing);
    } catch (err) { next(err); }
  });

  app.post('/dashboard/autodm/automations/:id', requireAuth, action((req) => `/dashboard/autodm/automations/${id(req.params.id)}`, async (req, res) => {
    await updateAutomation(req.session.user.id, id(req.params.id), req.body || {});
    res.redirect(303, '/dashboard/autodm?ok=saved');
  }));

  app.post('/dashboard/autodm/automations/:id/toggle', requireAuth, action('/dashboard/autodm', async (req, res) => {
    await setAutomationActive(req.session.user.id, id(req.params.id), req.body?.active === '1');
    res.redirect(303, '/dashboard/autodm?ok=saved');
  }));

  app.post('/dashboard/autodm/automations/:id/delete', requireAuth, action('/dashboard/autodm', async (req, res) => {
    await deleteAutomation(req.session.user.id, id(req.params.id));
    res.redirect(303, '/dashboard/autodm?ok=deleted');
  }));

  if (ig.instagramEnabled()) {
    const upkeep = () => runUpkeep().catch((err) => console.error('AutoDM upkeep failed:', err));
    setInterval(upkeep, JOB_EVERY_MS).unref();
    setTimeout(upkeep, 60 * 1000).unref();
  }
}

module.exports = {
  installAutoDm, installAutoDmWebhooks, matchesKeywords, pickAutomation, readAutomation, dmMessage, handleWebhook, runUpkeep, disconnect, deleteByMetaUser, connectAccount, getAccount, refreshProfile, OK_MESSAGES,
};
