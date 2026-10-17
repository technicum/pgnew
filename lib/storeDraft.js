// The store builder's draft (Builder v2): everything the builder edits —
// profile, socials, store settings, design and the ordered blocks — kept
// as one JSON state per user in PDZ_store_drafts. Every edit in the
// builder auto-saves here (PUT /dashboard/builder/draft); nothing on the
// public page changes until Publish copies the draft into the real tables
// (PDZ_users, PDZ_blocks) in one transaction. No draft row means the
// builder shows what's live, and the first edit creates one.
//
// A draft block keeps its PDZ_blocks id; a block added in the draft has a
// negative id until Publish inserts it. baseIds are the live block ids
// when the draft was started (set here, never by the client): Publish
// only deletes a live block the draft removed, so a block created
// elsewhere in the meantime is kept.
//
// The client's state is never trusted: it's cleaned on every save with
// the same rules as the builder's old save endpoints, and cleaned and
// checked again on Publish.
const pool = require('./db');
const kit = require('./appKit');
const { listBlocks, normalizeItems, TYPES } = require('./blocks');
const { findUserById } = require('./users');
const { normalizeStoreSettings } = require('./storeSettings');
const { normalizeSocials } = require('./socials');

const TABLE = 'PDZ_store_drafts';
const BLOCKS = 'PDZ_blocks';
const USERS = 'PDZ_users';
const MAX_BLOCKS = 100;
const DEFAULT_ACCENT = '#ff6b4a';

const ensureTable = kit.lazyTables([`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    user_id INT NOT NULL PRIMARY KEY,
    state MEDIUMTEXT NOT NULL,
    base_ids TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL DEFAULT NULL
  )
`]);

function draftError(code, message, field) {
  const err = new Error(message);
  err.code = code;
  if (field) err.field = field;
  return err;
}

// Same rule as signup's handles (lib/users.js slugify), minus its
// "creator" fallback: an emptied handle stays empty and Publish says so.
const cleanHandle = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
const text = (value, max) => String(value ?? '').slice(0, max);

// A state from anywhere (the client, a saved draft, a template), cleaned.
// liveTypes: the user's PDZ_blocks, id -> type. A positive id that isn't
// one of them (or has another type) becomes a new block, so a draft can
// never point at someone else's block or change a block's type.
function cleanState(input, liveTypes) {
  const source = input && typeof input === 'object' ? input : {};
  const profile = source.profile && typeof source.profile === 'object' ? source.profile : {};
  const design = source.design && typeof source.design === 'object' ? source.design : {};
  const seen = new Set();
  let nextTemp = 0;
  const raw = Array.isArray(source.blocks) ? source.blocks : [];
  raw.forEach((b) => {
    const n = b && Number(b.id);
    if (Number.isInteger(n) && n < nextTemp) nextTemp = n;
  });

  const blocks = [];
  for (const b of raw) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!b || !TYPES.has(b.type)) continue;
    let id = Number(b.id);
    if (!Number.isInteger(id) || id === 0 || seen.has(id) || (id > 0 && liveTypes.get(id) !== b.type)) id = --nextTemp;
    seen.add(id);
    blocks.push({
      id,
      type: b.type,
      title: text(b.title, 200),
      sub: text(b.sub, 200),
      price: text(b.price, 200),
      visible: !!b.visible,
      items: normalizeItems(b.type, b.items),
    });
  }

  return {
    profile: {
      name: text(profile.name, 120),
      handle: cleanHandle(profile.handle),
      bio: text(profile.bio, 280),
      socials: normalizeSocials(profile.socials),
    },
    settings: normalizeStoreSettings(source.settings),
    design: {
      accent: /^#[0-9a-f]{6}$/i.test(design.accent || '') ? design.accent.toLowerCase() : DEFAULT_ACCENT,
      showBadge: !!design.showBadge,
    },
    blocks,
  };
}

// What's on the public page now, as a builder state.
async function liveState(userId) {
  const [user, blocks] = await Promise.all([findUserById(userId), listBlocks(userId)]);
  if (!user) return null;
  return {
    user,
    state: {
      profile: { name: user.name, handle: user.handle, bio: user.bio || '', socials: normalizeSocials(user.socials) },
      settings: normalizeStoreSettings(user.store_settings),
      design: {
        accent: /^#[0-9a-f]{6}$/i.test(user.accent_color || '') ? user.accent_color.toLowerCase() : DEFAULT_ACCENT,
        showBadge: !!user.show_badge,
      },
      blocks: blocks.map((b) => ({
        id: b.id, type: b.type, title: b.title, sub: b.sub, price: b.price, visible: !!b.visible, items: b.items,
      })),
    },
  };
}

const typesOf = (blocks) => new Map(blocks.map((b) => [b.id, b.type]));

const parse = (json, fallback) => {
  try { return JSON.parse(json); } catch (err) { return fallback; }
};

async function readDraft(db, userId, lock = false) {
  const [[row]] = await db.query(
    `SELECT state, base_ids, version FROM ${TABLE} WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  if (!row) return null;
  return { state: parse(row.state, {}), baseIds: parse(row.base_ids, []), version: row.version };
}

// Plain-language list of what the draft changes on the live page — one
// entry per change, so its length is the "N changes" count.
const SETTING_NAMES = {
  photo: 'Photo', cover: 'Cover', tagline: 'Tagline', location: 'Location',
  contactType: 'Contact button', contactValue: 'Contact button', contactLabel: 'Contact button',
  announceOn: 'Announcement', announceText: 'Announcement', announceUrl: 'Announcement',
  socialsInHeader: 'Social icons', theme: 'Background', font: 'Font', buttons: 'Button shape',
  seoTitle: 'SEO', seoDescription: 'SEO', shareImage: 'Share image',
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function pendingChanges(draft, live, baseIds) {
  const out = [];
  const p = draft.profile;
  const lp = live.profile;
  if (p.name !== lp.name) out.push('Name');
  if (p.handle !== lp.handle) out.push('Link');
  if (p.bio !== lp.bio) out.push('Bio');
  if (!same(p.socials, lp.socials)) out.push('Social links');
  const settingNames = new Set();
  for (const key of Object.keys(SETTING_NAMES)) {
    if (!same(draft.settings[key], live.settings[key])) settingNames.add(SETTING_NAMES[key]);
  }
  out.push(...settingNames);
  if (draft.design.accent !== live.design.accent) out.push('Accent color');
  if (draft.design.showBadge !== live.design.showBadge) out.push('Badge');

  const liveById = new Map(live.blocks.map((b) => [b.id, b]));
  const draftIds = new Set(draft.blocks.map((b) => b.id));
  for (const b of draft.blocks) {
    const was = liveById.get(b.id);
    if (!was) out.push(`New: ${b.title || b.type}`);
    else if (!same({ ...b }, { ...was })) out.push(`Edited: ${b.title || b.type}`);
  }
  const base = new Set(baseIds);
  for (const b of live.blocks) {
    if (base.has(b.id) && !draftIds.has(b.id)) out.push(`Removed: ${b.title || b.type}`);
  }
  const common = draft.blocks.filter((b) => liveById.has(b.id)).map((b) => b.id);
  const liveOrder = live.blocks.filter((b) => draftIds.has(b.id)).map((b) => b.id);
  if (common.join() !== liveOrder.join()) out.push('Order');
  return out;
}

// What the builder opens with: the draft, or the live page.
async function loadState(userId) {
  await ensureTable();
  const live = await liveState(userId);
  if (!live) return null;
  const draft = await readDraft(pool, userId);
  if (!draft) return { user: live.user, state: live.state, version: 0, changes: [] };
  const state = cleanState(draft.state, typesOf(live.state.blocks));
  return { user: live.user, state, version: draft.version, changes: pendingChanges(state, live.state, draft.baseIds) };
}

// Name and link: fine to keep in a draft, but Publish would refuse them.
async function problemsFor(userId, state) {
  const problems = {};
  if (!state.profile.name.trim()) problems.name = 'Naam khaali nahi ho sakta.';
  if (!state.profile.handle) problems.handle = 'Apna link likhein.';
  else {
    const [rows] = await pool.query(`SELECT id FROM ${USERS} WHERE handle = ? AND id != ? LIMIT 1`, [state.profile.handle, userId]);
    if (rows.length) problems.handle = 'Ye link pehle se kisi ka hai — koi aur chunein.';
  }
  return problems;
}

// One auto-save. baseVersion is the version the client last saw (0: no
// draft yet); another tab having saved since answers DRAFT_CONFLICT
// rather than overwrite it.
async function saveDraft(userId, input, baseVersion) {
  await ensureTable();
  const live = await liveState(userId);
  if (!live) throw draftError('NOT_FOUND', 'Not found');
  const liveIds = live.state.blocks.map((b) => b.id);
  const state = cleanState(input, typesOf(live.state.blocks));
  const json = JSON.stringify(state);
  const base = Number(baseVersion) || 0;
  let version;
  let baseIds;
  if (base === 0) {
    baseIds = liveIds;
    const [result] = await pool.query(
      `INSERT IGNORE INTO ${TABLE} (user_id, state, base_ids, version) VALUES (?, ?, ?, 1)`,
      [userId, json, JSON.stringify(baseIds)],
    );
    if (!result.affectedRows) throw draftError('DRAFT_CONFLICT', 'Ye page kisi aur tab mein badla gaya hai — reload karein.');
    version = 1;
  } else {
    const [result] = await pool.query(
      `UPDATE ${TABLE} SET state = ?, version = version + 1 WHERE user_id = ? AND version = ?`,
      [json, userId, base],
    );
    if (!result.affectedRows) throw draftError('DRAFT_CONFLICT', 'Ye page kisi aur tab mein badla gaya hai — reload karein.');
    version = base + 1;
    baseIds = (await readDraft(pool, userId)).baseIds;
  }
  return {
    version,
    changes: pendingChanges(state, live.state, baseIds),
    problems: await problemsFor(userId, state),
  };
}

// Publish: the draft onto the live page, all or nothing. Everything is
// cleaned and checked again here — under a per-user lock and with the
// draft and block rows locked — before anything is written.
async function publish(userId) {
  await ensureTable();
  await listBlocks(userId); // PDZ_blocks exists (and has its columns)
  const conn = await pool.getConnection();
  const lockName = `pz_publish_${userId}`;
  let locked = false;
  try {
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, 10) AS got', [lockName]);
    if (got !== 1) throw draftError('BUSY', 'Publish abhi chal raha hai — ek pal mein dobara try karein.');
    locked = true;
    await conn.beginTransaction();
    try {
      const draft = await readDraft(conn, userId, true);
      if (!draft) {
        await conn.rollback();
        return { published: false };
      }
      const [liveRows] = await conn.query(`SELECT id, type FROM ${BLOCKS} WHERE user_id = ? ORDER BY sort_order ASC, id ASC FOR UPDATE`, [userId]);
      const liveIds = liveRows.map((r) => r.id);
      const state = cleanState(draft.state, typesOf(liveRows));
      const { profile, settings, design, blocks } = state;

      if (!profile.name.trim()) throw draftError('INVALID_INPUT', 'Naam khaali nahi ho sakta.', 'name');
      if (!profile.handle) throw draftError('INVALID_INPUT', 'Apna link likhein.', 'handle');
      const [taken] = await conn.query(`SELECT id FROM ${USERS} WHERE handle = ? AND id != ? LIMIT 1`, [profile.handle, userId]);
      if (taken.length) throw draftError('HANDLE_TAKEN', 'Ye link pehle se kisi ka hai — koi aur chunein.', 'handle');

      try {
        await conn.query(
          `UPDATE ${USERS} SET name = ?, handle = ?, bio = ?, socials = ?, store_settings = ?, accent_color = ?, show_badge = ? WHERE id = ?`,
          [profile.name.trim(), profile.handle, profile.bio, JSON.stringify(profile.socials), JSON.stringify(settings),
            design.accent, design.showBadge ? 1 : 0, userId],
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw draftError('HANDLE_TAKEN', 'Ye link pehle se kisi ka hai — koi aur chunein.', 'handle');
        throw err;
      }

      const live = new Set(liveIds);
      const ids = new Map(); // draft id -> live id
      for (const [i, b] of blocks.entries()) {
        const items = normalizeItems(b.type, b.items);
        const itemsJson = items.length ? JSON.stringify(items) : null;
        if (b.id > 0 && live.has(b.id)) {
          // type stays as it is: a block never changes type.
          await conn.query(
            `UPDATE ${BLOCKS} SET title = ?, sub = ?, price = ?, visible = ?, items = ?, sort_order = ? WHERE id = ? AND user_id = ?`,
            [b.title, b.sub, b.price, b.visible ? 1 : 0, itemsJson, i, b.id, userId],
          );
          ids.set(b.id, b.id);
        } else {
          const [result] = await conn.query(
            `INSERT INTO ${BLOCKS} (user_id, type, title, sub, price, visible, sort_order, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, b.type, b.title, b.sub, b.price, b.visible ? 1 : 0, i, itemsJson],
          );
          ids.set(b.id, result.insertId);
        }
      }
      // Removed in the draft: deleted. Added elsewhere since the draft
      // began: kept, after the draft's blocks.
      const kept = new Set(ids.values());
      const base = new Set(draft.baseIds);
      let order = blocks.length;
      for (const id of liveIds) {
        if (kept.has(id)) continue;
        if (base.has(id)) await conn.query(`DELETE FROM ${BLOCKS} WHERE id = ? AND user_id = ?`, [id, userId]);
        else await conn.query(`UPDATE ${BLOCKS} SET sort_order = ? WHERE id = ? AND user_id = ?`, [order++, id, userId]);
      }

      await conn.query(`DELETE FROM ${TABLE} WHERE user_id = ?`, [userId]);
      await conn.commit();
      return { published: true, ids: Object.fromEntries(ids) };
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    conn.release();
  }
}

// Discard: drop the draft; the builder goes back to the live page.
async function discard(userId) {
  await ensureTable();
  await pool.query(`DELETE FROM ${TABLE} WHERE user_id = ?`, [userId]);
}

module.exports = { MAX_BLOCKS, cleanState, liveState, loadState, saveDraft, publish, discard };
