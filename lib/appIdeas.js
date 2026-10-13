// App ideas: creators suggest apps they'd like (Explore apps → "Suggest an
// app"), and admins review them (Platform admin → App ideas), giving each a
// status the creator sees next to their idea, and a private note.
const pool = require('./db');

const TABLE = 'PDZ_app_ideas';
const STATUSES = {
  new: 'New',
  planned: 'Planned',
  building: 'Being built',
  done: 'Shipped',
  declined: 'Not planned',
};
const CATEGORIES = ['Selling', 'Audience & marketing', 'Scheduling', 'Content & courses', 'Payments', 'Integrations', 'Something else'];

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(120) NOT NULL,
        description TEXT NULL,
        category VARCHAR(40) NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'new',
        admin_note VARCHAR(500) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (user_id), INDEX (status)
      )
    `).catch((err) => {
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

// A creator's suggestion. A few a day at most, so the form can't be used to spam.
async function submitIdea(userId, body) {
  await ensureTable();
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const description = String(body.description || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
  const category = CATEGORIES.includes(body.category) ? body.category : '';
  if (title.length < 3) throw inputError('Give your idea a short name, like “Instagram auto-replies”.');
  if (description.length < 10) throw inputError('Tell us a little about it — what it would do for you.');
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE user_id = ? AND created_at >= NOW() - INTERVAL 1 DAY`, [userId]);
  if (n >= 5) throw inputError('That’s plenty of ideas for one day — thank you! Send more tomorrow.');
  await pool.query(`INSERT INTO ${TABLE} (user_id, title, description, category) VALUES (?, ?, ?, ?)`, [userId, title, description, category]);
}

async function listMyIdeas(userId) {
  await ensureTable();
  const [rows] = await pool.query(`SELECT id, title, category, status, created_at FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`, [userId]);
  return rows.map((r) => ({ ...r, statusLabel: STATUSES[r.status] || STATUSES.new }));
}

async function listIdeas({ status = '' } = {}) {
  await ensureTable();
  const where = STATUSES[status] ? 'WHERE i.status = ?' : '';
  const [rows] = await pool.query(
    `SELECT i.*, u.name AS user_name, u.email AS user_email, u.handle AS user_handle
     FROM ${TABLE} i LEFT JOIN PDZ_users u ON u.id = i.user_id ${where}
     ORDER BY FIELD(i.status, 'new', 'planned', 'building', 'done', 'declined'), i.created_at DESC LIMIT 500`,
    where ? [status] : [],
  );
  const [counts] = await pool.query(`SELECT status, COUNT(*) AS n FROM ${TABLE} GROUP BY status`);
  return { ideas: rows, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) };
}

async function updateIdea(id, body) {
  await ensureTable();
  const status = STATUSES[body.status] ? body.status : 'new';
  const note = String(body.admin_note || '').trim().slice(0, 500);
  await pool.query(`UPDATE ${TABLE} SET status = ?, admin_note = ? WHERE id = ?`, [status, note, id]);
}

async function deleteIdea(id) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
}

module.exports = { STATUSES, CATEGORIES, submitIdea, listMyIdeas, listIdeas, updateIdea, deleteIdea };
