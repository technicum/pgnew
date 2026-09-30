// Lead magnets — a free download (a checklist, a PDF, a template) a
// merchant gives away in exchange for a visitor's name + email. Each one
// gets its own public page on the merchant's store subdomain, at
// meera.pagezaper.com/:slug (served by lib/storefront.js). A signup on
// that page lands straight in the merchant's Audience list
// (lib/contacts.js), tagged source='form'.
//
// Same lazy-migration pattern as lib/blocks.js and lib/contacts.js —
// PDZ_lead_magnets is created on first use, no separate migration step.
const pool = require('./db');

const TABLE = 'PDZ_lead_magnets';

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT '',
        slug VARCHAR(80) NOT NULL,
        description VARCHAR(500) NOT NULL DEFAULT '',
        cta_text VARCHAR(60) NOT NULL DEFAULT 'Get it free',
        file_url VARCHAR(500) NOT NULL DEFAULT '',
        visible TINYINT(1) NOT NULL DEFAULT 1,
        signup_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_slug (user_id, slug),
        INDEX (user_id)
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// Added after PDZ_lead_magnets already existed in production — same
// ALTER-and-swallow-duplicates approach as lib/users.js, safe on every boot.
let columnsReady = null;
function ensureColumns() {
  if (!columnsReady) {
    columnsReady = (async () => {
      const addColumn = async (sql) => {
        try {
          await pool.query(sql);
        } catch (err) {
          if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
      };
      await ensureTable();
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN view_count INT NOT NULL DEFAULT 0`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN collect_phone TINYINT(1) NOT NULL DEFAULT 0`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN success_message VARCHAR(300) NOT NULL DEFAULT ''`);
      // Builder additions: up to a few extra questions beyond name/email/phone
      // (stored as a small JSON array — VARCHAR rather than TEXT so the
      // DEFAULT works on older MySQL too), plus a per-magnet accent color and
      // a toggle for the cover graphic on the public page.
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN extra_questions VARCHAR(1000) NOT NULL DEFAULT '[]'`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN accent_color VARCHAR(7) NOT NULL DEFAULT '#1261ef'`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN show_cover TINYINT(1) NOT NULL DEFAULT 1`);
      // Name and email used to be fixed fields; now each can be switched
      // off like phone. Default on, so existing magnets keep their form.
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN collect_name TINYINT(1) NOT NULL DEFAULT 1`);
      await addColumn(`ALTER TABLE ${TABLE} ADD COLUMN collect_email TINYINT(1) NOT NULL DEFAULT 1`);
      // Dropdown questions carry their list of choices, which can outgrow
      // the original 1000 chars. MODIFY to the same definition is a no-op,
      // so this is safe on every boot too.
      await pool.query(`ALTER TABLE ${TABLE} MODIFY COLUMN extra_questions VARCHAR(2000) NOT NULL DEFAULT '[]'`);
    })().catch((err) => {
      columnsReady = null;
      throw err;
    });
  }
  return columnsReady;
}

// The slug is the public URL path (meera.pagezaper.com/<slug>), so it's
// kept to lowercase letters, digits and single dashes.
function normalizeSlug(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}

function slugify(str) {
  return normalizeSlug(str) || 'guide';
}

// Extra questions beyond the fixed name/email/phone fields — a small,
// merchant-defined list rendered on the public page and folded into the
// contact's note on signup (lib/storefront.js). Capped short so a few of
// them always fit in contacts.note (VARCHAR(300)) alongside the magnet name.
const MAX_EXTRA_QUESTIONS = 4;
const QUESTION_TYPES = new Set(['text', 'number', 'email', 'phone', 'url', 'date', 'dropdown', 'checkbox']);
// Dropdown choices — kept few and short so four dropdowns still fit in
// the extra_questions column.
const MAX_QUESTION_OPTIONS = 6;
const DEFAULT_ACCENT = '#1261ef';

function sanitizeQuestionOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const options = raw.map((o) => String(o || '').trim().slice(0, 30)).filter(Boolean);
  return [...new Set(options)].slice(0, MAX_QUESTION_OPTIONS);
}

function sanitizeExtraQuestions(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (err) { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, MAX_EXTRA_QUESTIONS).map((q, i) => {
    const type = QUESTION_TYPES.has(q && q.type) ? q.type : 'text';
    const question = {
      id: Number.isInteger(q && q.id) && q.id > 0 ? q.id : i + 1,
      type,
      label: (String((q && q.label) || '').trim().slice(0, 60)) || 'Question',
      required: !!(q && q.required),
    };
    if (type === 'dropdown') question.options = sanitizeQuestionOptions(q && q.options);
    return question;
  });
}

// A signup has to leave the merchant some way to reach the person, so the
// form can drop email or phone but never both.
function contactFieldError() {
  const err = new Error('Keep email or phone switched on — you need a way to reach people.');
  err.code = 'CONTACT_FIELD_REQUIRED';
  return err;
}

function sanitizeAccentColor(raw) {
  const value = String(raw || '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_ACCENT;
}

async function uniqueSlug(userId, title) {
  const base = slugify(title);
  const [rows] = await pool.query(`SELECT slug FROM ${TABLE} WHERE user_id = ? AND slug LIKE ?`, [userId, `${base}%`]);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

async function listLeadMagnets(userId) {
  await ensureColumns();
  const [rows] = await pool.query(
    `SELECT id, title, slug, description, cta_text, file_url, visible, signup_count, view_count,
            collect_name, collect_email, collect_phone, success_message, extra_questions, accent_color, show_cover, created_at
     FROM ${TABLE} WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map((row) => ({ ...row, extra_questions: sanitizeExtraQuestions(row.extra_questions) }));
}

async function createLeadMagnet(userId, {
  title, description, ctaText, fileUrl, successMessage, collectName, collectEmail, collectPhone,
  extraQuestions, accentColor, showCover,
}) {
  await ensureColumns();
  const trimmedTitle = String(title || '').trim().slice(0, 200);
  const trimmedDescription = String(description || '').trim().slice(0, 500);
  const trimmedCta = String(ctaText || '').trim().slice(0, 60) || 'Get it free';
  const trimmedFileUrl = String(fileUrl || '').trim().slice(0, 500);
  const trimmedSuccess = String(successMessage || '').trim().slice(0, 300);
  const name = collectName === undefined ? 1 : (collectName ? 1 : 0);
  const email = collectEmail === undefined ? 1 : (collectEmail ? 1 : 0);
  const phone = collectPhone ? 1 : 0;
  const questions = sanitizeExtraQuestions(extraQuestions);
  const accent = sanitizeAccentColor(accentColor);
  const cover = showCover === undefined ? 1 : (showCover ? 1 : 0);

  if (!trimmedTitle) {
    const err = new Error('Give it a title, like “Free pricing checklist”.');
    err.code = 'TITLE_REQUIRED';
    throw err;
  }
  if (!trimmedFileUrl) {
    const err = new Error('Add a link to the file — a Google Drive/Dropbox share link works fine.');
    err.code = 'FILE_URL_REQUIRED';
    throw err;
  }
  if (!/^https?:\/\//i.test(trimmedFileUrl)) {
    const err = new Error('That file link needs to start with http:// or https://');
    err.code = 'INVALID_FILE_URL';
    throw err;
  }
  if (!email && !phone) throw contactFieldError();

  const slug = await uniqueSlug(userId, trimmedTitle);
  const [result] = await pool.query(
    `INSERT INTO ${TABLE} (user_id, title, slug, description, cta_text, file_url, success_message, collect_name, collect_email, collect_phone, extra_questions, accent_color, show_cover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, trimmedTitle, slug, trimmedDescription, trimmedCta, trimmedFileUrl, trimmedSuccess, name, email, phone, JSON.stringify(questions), accent, cover],
  );
  return {
    id: result.insertId,
    title: trimmedTitle,
    slug,
    description: trimmedDescription,
    cta_text: trimmedCta,
    file_url: trimmedFileUrl,
    visible: 1,
    signup_count: 0,
    view_count: 0,
    collect_name: name,
    collect_email: email,
    collect_phone: phone,
    success_message: trimmedSuccess,
    extra_questions: questions,
    accent_color: accent,
    show_cover: cover,
    created_at: new Date(),
  };
}

// userId is scoped into every write below, same as lib/blocks.js and
// lib/contacts.js — one merchant can never edit, hide or delete a lead
// magnet belonging to someone else, even by guessing a valid id.
// Returns the slug as stored when it was changed, so the dashboard can show
// the link exactly as it now works.
async function updateLeadMagnet(userId, id, fields) {
  await ensureColumns();
  const sets = [];
  const values = [];
  let newSlug = null;
  if (fields.slug !== undefined) {
    newSlug = normalizeSlug(fields.slug);
    if (!newSlug) {
      const err = new Error('The link needs at least one letter or number.');
      err.code = 'SLUG_REQUIRED';
      throw err;
    }
    const [clash] = await pool.query(
      `SELECT id FROM ${TABLE} WHERE user_id = ? AND slug = ? AND id <> ? LIMIT 1`,
      [userId, newSlug, id],
    );
    if (clash.length) {
      const err = new Error('Another of your lead magnets already uses that link.');
      err.code = 'SLUG_TAKEN';
      throw err;
    }
    sets.push('slug = ?');
    values.push(newSlug);
  }
  if (fields.successMessage !== undefined) {
    sets.push('success_message = ?');
    values.push(String(fields.successMessage).trim().slice(0, 300));
  }
  if (fields.collectEmail !== undefined || fields.collectPhone !== undefined) {
    const [current] = await pool.query(
      `SELECT collect_email, collect_phone FROM ${TABLE} WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId],
    );
    if (current[0]) {
      const emailOn = fields.collectEmail !== undefined ? !!fields.collectEmail : !!current[0].collect_email;
      const phoneOn = fields.collectPhone !== undefined ? !!fields.collectPhone : !!current[0].collect_phone;
      if (!emailOn && !phoneOn) throw contactFieldError();
    }
  }
  if (fields.collectName !== undefined) {
    sets.push('collect_name = ?');
    values.push(fields.collectName ? 1 : 0);
  }
  if (fields.collectEmail !== undefined) {
    sets.push('collect_email = ?');
    values.push(fields.collectEmail ? 1 : 0);
  }
  if (fields.collectPhone !== undefined) {
    sets.push('collect_phone = ?');
    values.push(fields.collectPhone ? 1 : 0);
  }
  if (fields.title !== undefined) {
    const trimmed = String(fields.title).trim().slice(0, 200);
    if (!trimmed) {
      const err = new Error('Give it a title, like “Free pricing checklist”.');
      err.code = 'TITLE_REQUIRED';
      throw err;
    }
    sets.push('title = ?');
    values.push(trimmed);
  }
  if (fields.description !== undefined) {
    sets.push('description = ?');
    values.push(String(fields.description).trim().slice(0, 500));
  }
  if (fields.ctaText !== undefined) {
    sets.push('cta_text = ?');
    values.push(String(fields.ctaText).trim().slice(0, 60) || 'Get it free');
  }
  if (fields.fileUrl !== undefined) {
    const trimmed = String(fields.fileUrl).trim().slice(0, 500);
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      const err = new Error('That file link needs to start with http:// or https://');
      err.code = 'INVALID_FILE_URL';
      throw err;
    }
    sets.push('file_url = ?');
    values.push(trimmed);
  }
  if (fields.visible !== undefined) {
    sets.push('visible = ?');
    values.push(fields.visible ? 1 : 0);
  }
  if (fields.extraQuestions !== undefined) {
    sets.push('extra_questions = ?');
    values.push(JSON.stringify(sanitizeExtraQuestions(fields.extraQuestions)));
  }
  if (fields.accentColor !== undefined) {
    sets.push('accent_color = ?');
    values.push(sanitizeAccentColor(fields.accentColor));
  }
  if (fields.showCover !== undefined) {
    sets.push('show_cover = ?');
    values.push(fields.showCover ? 1 : 0);
  }
  if (!sets.length) return {};
  values.push(id, userId);
  try {
    await pool.query(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, values);
  } catch (err) {
    // Two saves racing past the check above — the unique key still holds.
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const taken = new Error('Another of your lead magnets already uses that link.');
    taken.code = 'SLUG_TAKEN';
    throw taken;
  }
  return newSlug ? { slug: newSlug } : {};
}

async function deleteLeadMagnet(userId, id) {
  await ensureColumns();
  await pool.query(`DELETE FROM ${TABLE} WHERE id = ? AND user_id = ?`, [id, userId]);
}

// Public lookup for the store's /:slug page — scoped to visible=1 so a
// merchant can unpublish a magnet without deleting its signup history.
async function getPublicLeadMagnet(userId, slug) {
  await ensureColumns();
  const [rows] = await pool.query(
    `SELECT id, title, slug, description, cta_text, file_url, collect_name, collect_email, collect_phone, success_message,
            extra_questions, accent_color, show_cover
     FROM ${TABLE} WHERE user_id = ? AND slug = ? AND visible = 1 LIMIT 1`,
    [userId, slug],
  );
  if (!rows[0]) return null;
  return { ...rows[0], extra_questions: sanitizeExtraQuestions(rows[0].extra_questions) };
}

async function incrementSignupCount(id) {
  await ensureColumns();
  await pool.query(`UPDATE ${TABLE} SET signup_count = signup_count + 1 WHERE id = ?`, [id]);
}

// Page loads of the public form — with signup_count it gives the dashboard
// a conversion rate.
async function incrementViewCount(id) {
  await ensureColumns();
  await pool.query(`UPDATE ${TABLE} SET view_count = view_count + 1 WHERE id = ?`, [id]);
}

module.exports = {
  listLeadMagnets,
  createLeadMagnet,
  updateLeadMagnet,
  deleteLeadMagnet,
  getPublicLeadMagnet,
  incrementSignupCount,
  incrementViewCount,
};
