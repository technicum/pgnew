// Login sessions, backed by MySQL (via lib/db.js's pool) instead of
// express-session's default MemoryStore — which lives inside the Node
// process, so every `pm2 restart` (i.e. every deploy) logged everyone out.
//
// Same lazy-migration pattern as lib/users.js — PDZ_sessions is created on
// first use, no separate migration step. Written against express-session's
// Store interface directly rather than pulling in express-mysql-session, so
// a deploy stays `git pull` + restart with no npm install on the VPS.
const session = require('express-session');
const pool = require('./db');

const TABLE = 'PDZ_sessions';
// Fallback lifetime for a session whose cookie has no expiry of its own
// (server.js sets a 30-day maxAge, so this shouldn't normally apply).
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;
// Expired rows are cleared out in the background, not on every request.
const CLEANUP_INTERVAL_MS = 1000 * 60 * 60;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sid VARCHAR(128) NOT NULL PRIMARY KEY,
        data MEDIUMTEXT NOT NULL,
        expires BIGINT NOT NULL,
        INDEX (expires)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function expiryOf(sess) {
  const expires = sess && sess.cookie && sess.cookie.expires;
  const ms = expires ? new Date(expires).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Date.now() + DEFAULT_TTL_MS;
}

class MySQLSessionStore extends session.Store {
  constructor() {
    super();
    const timer = setInterval(() => {
      this.clearExpired().catch((err) => console.error('Session cleanup failed:', err));
    }, CLEANUP_INTERVAL_MS);
    // Never the thing keeping the process alive.
    timer.unref();
  }

  async clearExpired() {
    await ensureTable();
    await pool.query(`DELETE FROM ${TABLE} WHERE expires < ?`, [Date.now()]);
  }

  get(sid, callback) {
    ensureTable()
      .then(() => pool.query(`SELECT data FROM ${TABLE} WHERE sid = ? AND expires >= ? LIMIT 1`, [sid, Date.now()]))
      .then(([rows]) => callback(null, rows[0] ? JSON.parse(rows[0].data) : null))
      .catch((err) => callback(err));
  }

  set(sid, sess, callback) {
    ensureTable()
      .then(() => pool.query(
        `INSERT INTO ${TABLE} (sid, data, expires) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), expires = VALUES(expires)`,
        [sid, JSON.stringify(sess), expiryOf(sess)],
      ))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  // Called instead of set() when a request didn't change the session
  // (resave: false) — just pushes the expiry forward.
  touch(sid, sess, callback) {
    ensureTable()
      .then(() => pool.query(`UPDATE ${TABLE} SET expires = ? WHERE sid = ?`, [expiryOf(sess), sid]))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }

  destroy(sid, callback) {
    ensureTable()
      .then(() => pool.query(`DELETE FROM ${TABLE} WHERE sid = ?`, [sid]))
      .then(() => callback && callback(null))
      .catch((err) => callback && callback(err));
  }
}

module.exports = { MySQLSessionStore };
