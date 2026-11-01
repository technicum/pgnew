// The dashboard's Settings page (/dashboard/settings): the Instagram connection
// and deleting the account. views/dashboard-settings.ejs is the page; connecting
// and disconnecting Instagram themselves are in routes/instagram.js.
//
// Deleting is immediate and can't be undone. No table has a foreign key, so
// every PDZ_ table with a user_id column is cleared here, which also covers
// tables added later. Two things stay on purpose, because tax and accounting
// records have to be kept (views/privacy-policy.ejs, section 7) and money from
// sales lands in PageZaper's gateway account, so a creator may still be owed:
//   PDZ_orders           kept as they are
//   PDZ_deleted_accounts who those orders belonged to; only written if there
//                        are orders, as orders don't store the creator's details
const fs = require('fs/promises');
const path = require('path');
const pool = require('./db');
const autodm = require('./autodm');
const ig = require('./instagram');
const { findUserById, findUserByEmail, verifyPassword } = require('./users');
const { isAdminAccount } = require('./platform');
const { inputError } = require('./appKit');

const KEPT = 'pdz_orders';
const DELETED = 'PDZ_deleted_accounts';
// Keyed by the enrolment, not the creator.
const STUDENT_TABLES = ['pdz_course_progress', 'pdz_course_devices', 'pdz_course_quiz_attempts'];
const FILE_ROOTS = [['public', 'uploads'], ['private', 'course-videos'], ['private', 'course-files']];

async function deleteAccount(user) {
  const userId = Number(user.id);
  // Stops Instagram's webhooks as well as deleting the Instagram rows. Never
  // blocks the rest: Instagram being down mustn't keep someone's data here.
  await autodm.disconnect(userId).catch((err) => console.error(`Delete account: Instagram disconnect failed for user ${userId}:`, err.message));
  await pool.query(`CREATE TABLE IF NOT EXISTS ${DELETED} (
    former_user_id INT NOT NULL PRIMARY KEY,
    name VARCHAR(120) NOT NULL DEFAULT '',
    email VARCHAR(190) NOT NULL DEFAULT '',
    handle VARCHAR(100) NOT NULL DEFAULT '',
    deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [tables] = await conn.query(
      `SELECT t.TABLE_NAME AS name, c.COLUMN_NAME AS userColumn FROM INFORMATION_SCHEMA.TABLES t
       LEFT JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.COLUMN_NAME = 'user_id'
       WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME LIKE 'PDZ\\_%'`,
    );
    const find = (lower) => tables.find((t) => t.name.toLowerCase() === lower)?.name;

    const orders = find(KEPT);
    if (orders) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${orders}\` WHERE user_id = ?`, [userId]);
      if (n) {
        await conn.query(`REPLACE INTO ${DELETED} (former_user_id, name, email, handle) VALUES (?, ?, ?, ?)`, [userId, user.name, user.email, user.handle]);
      }
    }

    const students = find('pdz_course_enrolments');
    if (students) {
      for (const lower of STUDENT_TABLES) {
        const table = find(lower);
        if (table) await conn.query(`DELETE FROM \`${table}\` WHERE student_id IN (SELECT id FROM \`${students}\` WHERE user_id = ?)`, [userId]);
      }
    }
    for (const { name, userColumn } of tables) {
      if (userColumn && name.toLowerCase() !== KEPT) await conn.query(`DELETE FROM \`${name}\` WHERE user_id = ?`, [userId]);
    }
    await conn.query(`DELETE FROM \`${find('pdz_users')}\` WHERE id = ?`, [userId]);
    // Every browser it's logged in on, not just this one.
    const sessions = find('pdz_sessions');
    if (sessions) await conn.query(`DELETE FROM \`${sessions}\` WHERE data LIKE ?`, [`%"user":{"id":${userId},%`]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  // After the commit, so a failed delete never loses files.
  const base = path.join(__dirname, '..');
  await Promise.all(FILE_ROOTS.map((parts) => fs.rm(path.join(base, ...parts, `user-${userId}`), { recursive: true, force: true })
    .catch((err) => console.error(`Delete account: files not removed for user ${userId}:`, err.message))));
}

// What the form has to prove. An account made with Google has a random password
// nobody knows, so those confirm with the email alone.
async function confirmDeletion(sessionUser, body) {
  const stored = await findUserById(sessionUser.id);
  if (!stored) throw inputError('This account no longer exists.');
  if (await isAdminAccount(stored)) throw inputError('Admin accounts can’t be deleted here. Remove the admin access first.');
  if (String(body.confirm_email || '').trim().toLowerCase() !== String(stored.email).toLowerCase()) {
    throw inputError('Type your account email exactly to confirm.');
  }
  const user = await findUserByEmail(stored.email);
  if (!user.google_id && !(await verifyPassword(user, String(body.password || '')))) {
    throw inputError('That password isn’t right.');
  }
  return user;
}

// Forms have no CSRF token, so this one checks where the post came from.
function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch (err) {
    return false;
  }
}

function installSettings(app, { requireAuth, siteName }) {
  const HOME = '/dashboard/settings';

  app.get(HOME, requireAuth, async (req, res, next) => {
    try {
      const enabled = ig.instagramEnabled();
      let account = enabled ? await autodm.getAccount(req.session.user.id) : null;
      if (account && !account.needs_reconnect) account = await autodm.refreshProfile(account);
      const stored = await findUserById(req.session.user.id);
      res.render('dashboard-settings', {
        title: `Settings — ${siteName}`,
        user: req.session.user,
        enabled,
        account,
        needsPassword: !stored?.google_id,
        flash: req.query.error
          ? { kind: 'error', text: String(req.query.error).slice(0, 200) }
          : autodm.OK_MESSAGES[req.query.ok] ? { kind: 'ok', text: autodm.OK_MESSAGES[req.query.ok] } : null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${HOME}/delete-account`, requireAuth, async (req, res, next) => {
    const fail = (err) => res.redirect(303, `${HOME}?error=${encodeURIComponent(err.message)}#delete-account`);
    if (!sameOrigin(req)) return fail(new Error('Please try that again from this page.'));
    try {
      await deleteAccount(await confirmDeletion(req.session.user, req.body || {}));
      req.session.destroy(() => res.redirect(303, '/login?deleted=1'));
    } catch (err) {
      if (err.code === 'INVALID_INPUT') return fail(err);
      next(err);
    }
  });
}

module.exports = { installSettings, deleteAccount };
