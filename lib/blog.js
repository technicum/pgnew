// The platform blog (Platform admin → Blog; public at /blog and /blog/:slug).
// Posts are written in lib/richText.js's small format, with pictures
// (![caption](url)) allowed, and have their own SEO title, description and
// share image. Drafts are only seen by admins (the preview link).
const pool = require('./db');
const { renderRichText } = require('./richText');

const TABLE = 'PDZ_blog_posts';
const MAX_BODY = 60000;
const PER_PAGE = 12;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        slug VARCHAR(120) NOT NULL UNIQUE,
        excerpt VARCHAR(400) NOT NULL DEFAULT '',
        body MEDIUMTEXT NULL,
        cover_url VARCHAR(500) NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'draft',
        published_at DATETIME NULL DEFAULT NULL,
        author_name VARCHAR(120) NOT NULL DEFAULT '',
        seo_title VARCHAR(70) NOT NULL DEFAULT '',
        seo_description VARCHAR(160) NOT NULL DEFAULT '',
        share_image VARCHAR(500) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (status, published_at)
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

function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}
const imageUrl = (v, label) => {
  const url = String(v || '').trim().slice(0, 500);
  if (url && !/^(https:\/\/|\/uploads\/)[^\s"'<>]+$/i.test(url)) throw inputError(`${label} needs to be an upload or an https:// link.`);
  return url;
};

// What a page shows: the row, plus its rendered body, reading time and whether it's live.
function toPost(row) {
  if (!row) return null;
  const words = String(row.body || '').split(/\s+/).filter(Boolean).length;
  return {
    ...row,
    html: renderRichText(row.body, { max: MAX_BODY, images: true }),
    minutes: Math.max(1, Math.round(words / 220)),
    live: row.status === 'published' && row.published_at && new Date(row.published_at) <= new Date(),
  };
}

async function uniqueSlug(base, exceptId = 0) {
  const root = base || 'post';
  const [rows] = await pool.query(`SELECT slug FROM ${TABLE} WHERE (slug = ? OR slug LIKE ?) AND id <> ?`, [root, `${root}-%`, exceptId]);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

function postFields(body) {
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) throw inputError('Give the post a title.');
  const status = body.status === 'published' ? 'published' : 'draft';
  let publishedAt = null;
  if (body.published_at) {
    // datetime-local: 'YYYY-MM-DDTHH:MM'
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.published_at)) throw inputError('That publish date doesn’t look right.');
    publishedAt = body.published_at.slice(0, 16).replace('T', ' ') + ':00';
  }
  return {
    title,
    excerpt: String(body.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    body: String(body.body || '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_BODY),
    cover_url: imageUrl(body.cover_url, 'The cover'),
    status,
    published_at: publishedAt,
    author_name: String(body.author_name || '').trim().slice(0, 120),
    seo_title: String(body.seo_title || '').replace(/\s+/g, ' ').trim().slice(0, 70),
    seo_description: String(body.seo_description || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    share_image: imageUrl(body.share_image, 'The share image'),
  };
}

async function listPosts() {
  await ensureTable();
  const [rows] = await pool.query(`SELECT id, title, slug, excerpt, status, published_at, updated_at, author_name, cover_url FROM ${TABLE} ORDER BY COALESCE(published_at, created_at) DESC, id DESC`);
  return rows.map((r) => ({ ...r, live: r.status === 'published' && r.published_at && new Date(r.published_at) <= new Date() }));
}

async function getPost(id) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
  return toPost(row);
}

// Public: a published post whose date has come — or any post, for an admin's preview.
async function getPostBySlug(slug, { includeDrafts = false } = {}) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT * FROM ${TABLE} WHERE slug = ? LIMIT 1`, [String(slug || '').slice(0, 120)]);
  const post = toPost(row);
  if (!post || (!post.live && !includeDrafts)) return null;
  return post;
}

async function listPublished({ page = 1 } = {}) {
  await ensureTable();
  const where = `status = 'published' AND published_at IS NOT NULL AND published_at <= NOW()`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${where}`);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const [rows] = await pool.query(
    `SELECT id, title, slug, excerpt, cover_url, published_at, author_name, body FROM ${TABLE} WHERE ${where}
     ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
    [PER_PAGE, (current - 1) * PER_PAGE],
  );
  return { posts: rows.map((r) => { const p = toPost(r); delete p.body; delete p.html; return p; }), page: current, pages, total: Number(total) };
}

async function createPost(body, { authorName = '' } = {}) {
  await ensureTable();
  const f = postFields(body || {});
  if (!f.author_name) f.author_name = authorName;
  if (f.status === 'published' && !f.published_at) f.published_at = new Date();
  f.slug = await uniqueSlug(slugify(body.slug) || slugify(f.title));
  const cols = Object.keys(f);
  const [result] = await pool.query(`INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => f[c]));
  return result.insertId;
}

async function updatePost(id, body) {
  await ensureTable();
  const current = await getPost(id);
  if (!current) throw inputError('That post doesn’t exist.');
  const f = postFields(body || {});
  // Publishing for the first time with no date: now.
  if (f.status === 'published' && !f.published_at) f.published_at = current.published_at || new Date();
  const wanted = slugify(body.slug) || slugify(f.title);
  f.slug = wanted === current.slug ? wanted : await uniqueSlug(wanted, current.id);
  const cols = Object.keys(f);
  await pool.query(`UPDATE ${TABLE} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => f[c]), current.id]);
}

async function deletePost(id) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
}

// For sitemap.xml.
async function sitemapPosts() {
  await ensureTable();
  const [rows] = await pool.query(`SELECT slug, updated_at FROM ${TABLE} WHERE status = 'published' AND published_at <= NOW() ORDER BY published_at DESC LIMIT 5000`);
  return rows;
}

module.exports = {
  listPosts, getPost, getPostBySlug, listPublished, createPost, updatePost, deletePost, sitemapPosts, MAX_BODY,
};
