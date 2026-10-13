// Platform admin → Media (server.js /admin/media): every creator's uploaded
// files, whether anything still uses them, and the clean-up of ones that
// don't.
//
// Files live in three places, always as <root>/user-<id>/<generated name>:
//   public/uploads          — images and videos (lib/uploads.js), referenced
//                             in the database as /uploads/user-<id>/<file>
//   private/course-videos   — lesson videos  } (lib/courseMedia.js), referenced
//   private/course-files    — lesson files   }  as user-<id>/<file>
//
// "In use" means that user-<id>/<file> appears anywhere in the database: every
// text column of every PDZ_ table is searched, so a feature added later that
// stores an upload is covered without changes here. A file nothing uses can be
// deleted once it's UNUSED_DAYS old (by its last-modified time) — the delay
// covers an upload whose page isn't saved yet. Deleting re-checks both, file by
// file, at the moment of deletion.
const fsp = require('fs/promises');
const path = require('path');
const pool = require('./db');

const UNUSED_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = path.join(__dirname, '..');
const ROOTS = {
  uploads: { dir: path.join(BASE, 'public', 'uploads'), label: 'Upload', public: true },
  'course-videos': { dir: path.join(BASE, 'private', 'course-videos'), label: 'Lesson video', public: false },
  'course-files': { dir: path.join(BASE, 'private', 'course-files'), label: 'Lesson file', public: false },
};
// What each table is, in words, for "Used in".
const TABLE_LABELS = {
  PDZ_users: 'Store profile',
  PDZ_blocks: 'Store module',
  PDZ_payment_pages: 'Payment page',
  PDZ_lead_magnets: 'Lead magnet',
  PDZ_booking_services: 'Booking service',
  PDZ_booking_settings: 'Booking page',
  PDZ_events: 'Event',
  PDZ_courses: 'Course',
  PDZ_course_lessons: 'Course lesson',
  PDZ_orders: 'Order',
};
const LABELS_LOWER = new Map(Object.entries(TABLE_LABELS).map(([t, l]) => [t.toLowerCase(), l]));
const REF = /user-(\d+)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const KEY = /^(uploads|course-videos|course-files)\/user-(\d+)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'webm']);
function kindOf(root, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (root === 'course-videos') return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

// Every stored file: { key, ref, root, userId, name, size, modified }.
// Half-written uploads (.part) are skipped — they're still arriving.
async function listFiles() {
  const files = [];
  for (const [root, { dir }] of Object.entries(ROOTS)) {
    let userDirs = [];
    try { userDirs = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    for (const ud of userDirs) {
      const m = ud.isDirectory() && ud.name.match(/^user-(\d+)$/);
      if (!m) continue;
      const entries = await fsp.readdir(path.join(dir, ud.name), { withFileTypes: true });
      for (const f of entries) {
        if (!f.isFile() || f.name.endsWith('.part')) continue;
        const stat = await fsp.stat(path.join(dir, ud.name, f.name));
        files.push({
          key: `${root}/${ud.name}/${f.name}`,
          ref: `${ud.name}/${f.name}`,
          root,
          userId: Number(m[1]),
          name: f.name,
          size: stat.size,
          modified: stat.mtimeMs,
        });
      }
    }
  }
  return files;
}

// ref ("user-3/abc.png") → Set of where it's used ("Payment page", …).
async function usage() {
  const [cols] = await pool.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'PDZ\\_%'
       AND DATA_TYPE IN ('char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'json')`,
  );
  const byTable = new Map();
  cols.forEach(({ t, c }) => {
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(c);
  });
  const used = new Map();
  for (const [table, columns] of byTable) {
    // (Table names can come back lower-cased, depending on the server.)
    const label = TABLE_LABELS[table.toUpperCase().replace(/^PDZ_/, 'PDZ_')] || LABELS_LOWER.get(table.toLowerCase())
      || table.replace(/^pdz_/i, '').replace(/_/g, ' ');
    const q = (name) => `\`${name.replace(/`/g, '``')}\``;
    const [rows] = await pool.query(
      `SELECT CONCAT_WS(' ', ${columns.map(q).join(', ')}) AS refs_text FROM ${q(table)}
       WHERE ${columns.map((c) => `${q(c)} LIKE '%user-%'`).join(' OR ')}`,
    );
    rows.forEach(({ refs_text: text }) => {
      for (const m of String(text || '').matchAll(REF)) {
        const ref = `user-${m[1]}/${m[2]}`;
        if (!used.has(ref)) used.set(ref, new Set());
        used.get(ref).add(label);
      }
    });
  }
  return used;
}

function statusOf(file, usedIn, now) {
  if (usedIn.length) return 'used';
  return now - file.modified >= UNUSED_DAYS * DAY_MS ? 'deletable' : 'unused';
}

// Everything the admin page shows.
async function mediaReport() {
  const [files, used] = await Promise.all([listFiles(), usage()]);
  const ids = [...new Set(files.map((f) => f.userId))];
  const owners = new Map();
  if (ids.length) {
    const [rows] = await pool.query('SELECT id, name, handle, email FROM PDZ_users WHERE id IN (?)', [ids]);
    rows.forEach((u) => owners.set(u.id, u));
  }
  const now = Date.now();
  const list = files.map((f) => {
    const usedIn = [...(used.get(f.ref) || [])];
    const owner = owners.get(f.userId);
    const status = statusOf(f, usedIn, now);
    return {
      key: f.key,
      name: f.name,
      kind: kindOf(f.root, f.name),
      where: ROOTS[f.root].label,
      url: ROOTS[f.root].public ? `/uploads/${f.ref}` : null,
      size: f.size,
      modified: new Date(f.modified).toISOString(),
      deletableFrom: usedIn.length ? null : new Date(f.modified + UNUSED_DAYS * DAY_MS).toISOString(),
      status,
      usedIn,
      owner: owner
        ? { id: owner.id, name: owner.name, handle: owner.handle, email: owner.email }
        : { id: f.userId, name: `Deleted user #${f.userId}`, handle: '', email: '' },
    };
  }).sort((a, b) => (a.modified < b.modified ? -1 : 1));
  return { files: list, unusedDays: UNUSED_DAYS };
}

// Deletes the files named by key that are, right now, unused and old
// enough. → { deleted: [key], freed: bytes, skipped: [{ key, reason }] }
async function deleteMedia(keys) {
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, 5000);
  const result = { deleted: [], freed: 0, skipped: [] };
  if (!wanted.length) return result;
  const used = await usage();
  const now = Date.now();
  for (const key of wanted) {
    const m = key.match(KEY);
    if (!m) { result.skipped.push({ key, reason: 'Not a media file.' }); continue; }
    const [, root, userId, name] = m;
    const dir = path.join(ROOTS[root].dir, `user-${userId}`);
    const full = path.join(dir, name);
    // Never outside its own folder, whatever the key says.
    if (path.dirname(full) !== dir) { result.skipped.push({ key, reason: 'Not a media file.' }); continue; }
    let stat;
    try { stat = await fsp.stat(full); } catch (err) { result.skipped.push({ key, reason: 'Already gone.' }); continue; }
    if (used.has(`user-${userId}/${name}`)) { result.skipped.push({ key, reason: 'In use again.' }); continue; }
    if (now - stat.mtimeMs < UNUSED_DAYS * DAY_MS) { result.skipped.push({ key, reason: `Not ${UNUSED_DAYS} days old yet.` }); continue; }
    try {
      await fsp.unlink(full);
      result.deleted.push(key);
      result.freed += stat.size;
    } catch (err) {
      result.skipped.push({ key, reason: 'Couldn’t delete it.' });
    }
  }
  return result;
}

module.exports = { mediaReport, deleteMedia, UNUSED_DAYS };
