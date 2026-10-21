// Onboarding: the 7 steps a new account goes through, the same for every
// business type — only what's inside them comes from the type's preset
// (lib/presets.js). There is no business-specific code here: everything
// type-dependent is read from the preset.
//
//   1 account (the /signup form)  2 business type  3 basics  4 what you offer
//   5 hours (skipped when preset.hours is false)  6 look  7 live
//
// Progress is one row per user in PDZ_onboarding: the step to show next
// and every step's answers (data). An account with no row — everyone from
// before onboarding existed — counts as finished.
//
// Each step writes the real records as it's saved (services, hours, store
// settings, blocks), and keeps the ids of what it created in data.created,
// so saving a step again updates those records instead of adding more.
const pool = require('./db');
const kit = require('./appKit');
const { PRESETS, PRESET_BY_KEY, presetFor } = require('./presets');
const { TEMPLATES, TEMPLATE_BY_KEY } = require('./templates');
const users = require('./users');
const bookings = require('./bookings');
const blocks = require('./blocks');
const { normalizeStoreSettings } = require('./storeSettings');
const { setAppInstalled, APP_BY_ID } = require('./apps');
const storeDraft = require('./storeDraft');

const TABLE = 'PDZ_onboarding';
const STEPS = 7;
const FIRST = 2; // step 1 is the signup form itself
const TIMEZONE = 'Asia/Kolkata';
const MAX_CUSTOM_ROWS = 10;
const MIN_HANDLE = 3;

const ensureTable = kit.lazyTables([`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    user_id INT NOT NULL PRIMARY KEY,
    step TINYINT NOT NULL DEFAULT ${FIRST},
    data MEDIUMTEXT NULL,
    completed_at TIMESTAMP NULL DEFAULT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
`]);

const parse = (json) => {
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch (err) { return {}; }
};

// --- progress --------------------------------------------------------------

async function getProgress(userId) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT step, data, completed_at FROM ${TABLE} WHERE user_id = ?`, [userId]);
  if (!row) return null;
  return { step: row.step, data: parse(row.data), completed: !!row.completed_at };
}

// A new account (email signup or a Google account just created).
async function start(userId) {
  await ensureTable();
  await pool.query(`INSERT IGNORE INTO ${TABLE} (user_id, step, data) VALUES (?, ?, '{}')`, [userId, FIRST]);
}

// Where a signed-in person goes: onboarding if it's unfinished, else the dashboard.
async function homeFor(userId) {
  const progress = await getProgress(userId);
  return progress && !progress.completed ? '/onboarding' : '/dashboard';
}

async function saveProgress(userId, step, data, completed = false) {
  await pool.query(
    `UPDATE ${TABLE} SET step = ?, data = ?${completed ? ', completed_at = NOW()' : ''} WHERE user_id = ?`,
    [step, JSON.stringify(data), userId],
  );
}

// The steps this type goes through, in order.
function stepsFor(preset) {
  const all = [2, 3, 4, 5, 6, 7];
  return preset.hours === false ? all.filter((n) => n !== 5) : all;
}
function nextStep(n, preset) {
  const list = stepsFor(preset);
  return list[list.indexOf(n) + 1] || STEPS;
}
function prevStep(n, preset) {
  const list = stepsFor(preset);
  const i = list.indexOf(n);
  return i > 0 ? list[i - 1] : null;
}

// The step to show: the one asked for, if it's been reached; else the saved one.
function stepToShow(progress, asked, preset) {
  const reached = progress.step;
  let n = Number(asked);
  if (!Number.isInteger(n) || n < FIRST || n > reached) n = reached;
  if (!stepsFor(preset).includes(n)) n = nextStep(n, preset);
  return n;
}

// --- validation helpers ------------------------------------------------------

function stepError(message, values) {
  const err = kit.inputError(message);
  err.values = values;
  return err;
}

// Same rule as every handle (lib/users.js slugify): lowercase letters and
// digits, up to 24.
const cleanHandle = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
const reserved = (handle) => require('./storefront').RESERVED_HANDLES.has(handle);

// Why a handle can't be used, or null if it can.
async function handleProblem(handle, userId) {
  if (handle.length < MIN_HANDLE) return `Use at least ${MIN_HANDLE} letters or numbers.`;
  if (reserved(handle)) return 'That link is reserved — try another.';
  if (await users.handleTaken(handle, userId)) return 'That link is taken — try another.';
  return null;
}

// GET /onboarding/handle: is it free, and if not, a free one close to it.
async function checkHandle(value, userId) {
  const handle = cleanHandle(value);
  const problem = await handleProblem(handle, userId);
  if (!problem) return { available: true, handle, suggestion: handle, message: '' };
  let suggestion = '';
  if (handle.length >= MIN_HANDLE) {
    for (let n = 2; n < 50 && !suggestion; n += 1) {
      const candidate = `${handle.slice(0, 24 - String(n).length)}${n}`;
      if (!(await handleProblem(candidate, userId))) suggestion = candidate;
    }
  }
  return { available: false, handle, suggestion, message: problem };
}

// A 10-digit Indian mobile, with or without +91 / 0 in front → '+91XXXXXXXXXX'.
function indianMobile(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

// Rupees as typed → paise; '' stays null ("no price yet").
function pricePaise(raw, name) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    return bookings.priceFromForm(text);
  } catch (err) {
    throw kit.inputError(`${name}: ${err.message}`);
  }
}
const priceLabel = (paise) => (paise ? `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : 'Free');

// --- step 4 rows ---------------------------------------------------------------

// The rows step 4 shows: the saved answers (if they're for this type) or
// the preset's items plus its empty custom rows.
function offerRows(preset, data) {
  const saved = data.offer && data.offer.type === preset.key ? data.offer.rows : null;
  if (saved) return saved;
  const rows = preset.items.map((item) => ({
    key: item.key,
    on: true,
    name: item.name,
    minutes: item.minutes ? String(item.minutes) : '',
    price: item.price ?? '',
  }));
  for (let i = 1; i <= (preset.customRows || 0); i += 1) rows.push({ key: `c${i}`, on: false, name: '', minutes: '30', price: '' });
  return rows;
}

// What a row is: its preset item, or a custom row (always a bookable service).
function rowKind(preset, key) {
  const item = preset.items.find((i) => i.key === key);
  return item ? { kind: item.kind, attend: item.attend || preset.attend, fixed: true } : { kind: 'service', attend: preset.attend, fixed: false };
}

// The form's rows[i][…], cleaned. Only the preset's own keys and c1…c10 are accepted.
function readRows(preset, body) {
  const raw = Array.isArray(body.rows) ? body.rows : Object.values(body.rows || {});
  const allowed = new Set([...preset.items.map((i) => i.key), ...Array.from({ length: MAX_CUSTOM_ROWS }, (_, i) => `c${i + 1}`)]);
  const seen = new Set();
  const rows = [];
  for (const r of raw) {
    const key = String((r && r.key) || '');
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      on: !!(r.on),
      name: kit.cleanText(r.name, 80),
      minutes: String(r.minutes ?? '').replace(/\D/g, '').slice(0, 3),
      price: String(r.price ?? '').trim().slice(0, 12),
    });
  }
  return rows;
}

// --- the steps -------------------------------------------------------------------

// What each step's view needs.
async function stepView(user, progress, n) {
  const data = progress.data;
  const preset = presetFor(data.type || user.business_type);
  const settings = normalizeStoreSettings(user.store_settings);
  const base = {
    step: n,
    steps: STEPS,
    back: n === FIRST ? null : prevStep(n, preset),
    canSkip: [4, 5, 6].includes(n),
    preset,
    error: null,
  };
  if (n === 2) return { ...base, presets: PRESETS, values: { type: data.type || '' } };
  if (n === 3) {
    const b = data.basics || {};
    return {
      ...base,
      values: {
        businessName: b.businessName || '',
        handle: b.handle || '',
        area: b.area || '',
        city: b.city || '',
        whatsapp: b.whatsapp || '',
      },
    };
  }
  if (n === 4) return { ...base, values: { rows: offerRows(preset, data) }, maxCustom: MAX_CUSTOM_ROWS };
  if (n === 5) {
    return {
      ...base,
      values: data.hours || { days: [1, 2, 3, 4, 5, 6], opens: '10:00', closes: '19:00', lunch: false, lunchFrom: '13:00', lunchTo: '14:00' },
    };
  }
  if (n === 6) {
    const offered = offerRows(preset, data).filter((r) => r.on && r.name).slice(0, 2).map((r) => ({
      name: r.name,
      price: r.price === '' ? '' : (() => { try { return priceLabel(pricePaise(r.price, r.name)); } catch (e) { return ''; } })(),
    }));
    return {
      ...base,
      templates: TEMPLATES.map((t) => ({ ...t, accent: t.accent || preset.accent })),
      values: { template: data.template || 'classic' },
      sample: {
        name: user.name,
        location: settings.location,
        cta: preset.primaryCta,
        offered,
        initials: user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || 'U',
      },
    };
  }
  // 7: the live page.
  const unpriced = offerRows(preset, data).filter((r) => r.on && r.name && r.price === '').map((r) => r.name);
  return {
    ...base,
    canSkip: false,
    nextSteps: [...(unpriced.length ? [`Add prices for ${unpriced.join(', ')} — they stay hidden until you do`] : []), ...preset.nextSteps],
  };
}

// Saves step n from its form. Returns the step to show next. A problem
// throws INVALID_INPUT with .values (what was typed) for the form.
async function saveStep(user, n, body, { skip = false } = {}) {
  await ensureTable();
  const progress = await getProgress(user.id);
  if (!progress) throw kit.inputError('Your setup is already finished.');
  const data = { ...progress.data };
  let preset = presetFor(data.type || user.business_type);

  if (skip && [4, 5, 6].includes(n)) {
    // Nothing saved — just on to the next step.
  } else if (n === 2) {
    const type = String(body.type || '');
    if (!PRESET_BY_KEY.has(type)) throw stepError('Pick the option closest to your business.', { type: '' });
    data.type = type;
    preset = presetFor(type);
    await users.setBusinessType(user.id, type);
  } else if (n === 3) {
    await saveBasics(user, body, data);
  } else if (n === 4) {
    await saveOffer(user, preset, body, data);
  } else if (n === 5) {
    if (preset.hours !== false) await saveHoursStep(user, body, data);
  } else if (n === 6) {
    await saveLook(user, preset, body, data);
  } else if (n === 7) {
    await saveProgress(user.id, STEPS, data, true);
    return null;
  } else {
    throw kit.inputError('That step doesn’t exist.');
  }

  const next = nextStep(n, preset);
  await saveProgress(user.id, Math.max(progress.step, next), data);
  return next;
}

// Step 3: business name → the account/store name; link → handle; area +
// city → location; WhatsApp → the contact button.
async function saveBasics(user, body, data) {
  const values = {
    businessName: kit.cleanText(body.businessName, 120),
    handle: cleanHandle(body.handle),
    area: kit.cleanText(body.area, 28),
    city: kit.cleanText(body.city, 28),
    whatsapp: kit.cleanText(body.whatsapp, 20),
  };
  if (!values.businessName) throw stepError('Enter your business name.', values);
  // Left blank (no script to suggest one): made from the business name.
  if (!values.handle) {
    const made = await checkHandle(values.businessName, user.id);
    values.handle = made.available ? made.handle : made.suggestion;
  }
  const problem = await handleProblem(values.handle, user.id);
  if (problem) throw stepError(`Your link: ${problem}`, values);
  const phone = values.whatsapp ? indianMobile(values.whatsapp) : null;
  if (values.whatsapp && !phone) throw stepError('Enter a 10-digit Indian mobile number for WhatsApp, like 98765 43210.', values);

  const current = normalizeStoreSettings(user.store_settings);
  const location = [values.area, values.city].filter(Boolean).join(', ');
  const contact = phone
    ? { contactType: 'whatsapp', contactValue: phone }
    // Number removed: a WhatsApp button from before goes too.
    : current.contactType === 'whatsapp' ? { contactType: 'none', contactValue: '' } : {};
  const settings = normalizeStoreSettings({ ...current, location, ...contact });
  try {
    await pool.query(
      'UPDATE PDZ_users SET name = ?, handle = ?, store_settings = ? WHERE id = ?',
      [values.businessName, values.handle, JSON.stringify(settings), user.id],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw stepError('Your link: That link is taken — try another.', values);
    throw err;
  }
  await storeDraft.patchDraft(user.id, (state) => {
    state.profile = { ...(state.profile || {}), name: values.businessName, handle: values.handle };
    state.settings = { ...(state.settings || {}), location, ...contact };
  });
  data.basics = values;
}

// Step 4: ticked rows become booking services or store blocks; rows
// created before and now unticked are removed (or hidden, if a service
// already has bookings). A row without a price stays hidden.
async function saveOffer(user, preset, body, data) {
  const rows = readRows(preset, body);
  const ticked = rows.filter((r) => r.on && (r.name || rowKind(preset, r.key).fixed));
  // Check everything before writing anything.
  const plan = ticked.map((r) => {
    const { kind, attend } = rowKind(preset, r.key);
    const name = r.name || preset.items.find((i) => i.key === r.key).name;
    const minutes = Number(r.minutes);
    if (kind === 'service' && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 480)) {
      throw stepError(`${name}: the time needs to be between 5 and 480 minutes.`, { rows });
    }
    let paise;
    try { paise = pricePaise(r.price, name); } catch (err) { throw stepError(err.message, { rows }); }
    return { key: r.key, kind, attend, name, minutes, paise };
  });

  const created = { services: {}, blocks: {}, ...(data.created || {}) };
  created.services = { ...created.services };
  created.blocks = { ...created.blocks };
  const location = normalizeStoreSettings(user.store_settings).location;

  // Booking services.
  const serviceKeys = new Set();
  for (const p of plan.filter((x) => x.kind === 'service')) {
    serviceKeys.add(p.key);
    const fields = {
      title: p.name,
      duration_min: p.minutes,
      price: p.paise || 0,
      visible: p.paise !== null,
      attend: p.attend,
      location: p.attend === 'online' ? '' : location,
    };
    let id = created.services[p.key];
    if (id && !(await bookings.getService(user.id, id))) id = null; // deleted in the meantime
    if (!id) id = await bookings.createService(user.id, { title: p.name, duration_min: p.minutes, price: '0' });
    await bookings.updateServiceBasics(user.id, id, fields);
    created.services[p.key] = id;
  }
  for (const [key, id] of Object.entries(created.services)) {
    if (serviceKeys.has(key)) continue;
    if (await bookings.serviceHasBookings(user.id, id)) {
      await bookings.setServiceVisible(user.id, id, false);
    } else {
      await bookings.deleteService(user.id, id);
      delete created.services[key];
    }
  }

  // Store blocks for the other kinds (download, course, event): hidden
  // until they have a price.
  const blockKeys = new Set();
  for (const p of plan.filter((x) => x.kind !== 'service')) {
    blockKeys.add(p.key);
    const id = await ensureBlock(user.id, created.blocks[p.key], p.kind);
    await blocks.updateBlock(user.id, id, {
      title: p.name,
      price: p.paise === null ? '' : priceLabel(p.paise),
      visible: p.paise !== null,
    });
    created.blocks[p.key] = id;
  }

  // The booking block: the store's way to /book, while any service is visible.
  const bookable = plan.some((p) => p.kind === 'service' && p.paise !== null);
  if (bookable || created.blocks.booking) {
    const id = await ensureBlock(user.id, created.blocks.booking, 'booking');
    await blocks.updateBlock(user.id, id, { title: preset.primaryCta, visible: bookable });
    created.blocks.booking = id;
    blockKeys.add('booking');
  }
  for (const [key, id] of Object.entries(created.blocks)) {
    if (blockKeys.has(key)) continue;
    await blocks.deleteBlock(user.id, id);
    delete created.blocks[key];
  }

  // The type's apps, where they exist (lib/apps.js).
  for (const appId of preset.apps) {
    if (APP_BY_ID.has(appId) && !APP_BY_ID.get(appId).core) await setAppInstalled(user.id, appId, true);
  }

  await syncDraftBlocks(user.id, Object.values(created.blocks));
  data.offer = { type: preset.key, rows };
  data.created = created;
}

// An onboarding block that still exists, or a new one of the type.
async function ensureBlock(userId, id, type) {
  if (id && (await blocks.listBlocks(userId)).some((b) => b.id === id)) return id;
  return (await blocks.createBlock(userId, { type })).id;
}

// Onboarding's blocks as they are live now, in a Builder v2 draft if one is
// open: updated or added there, and removed ones taken out.
async function syncDraftBlocks(userId, ids) {
  const live = await blocks.listBlocks(userId);
  const mine = new Set(ids);
  const liveIds = new Set(live.map((b) => b.id));
  await storeDraft.patchDraft(userId, (state) => {
    const list = Array.isArray(state.blocks) ? state.blocks : [];
    const kept = list.filter((b) => !(b && b.id > 0 && !liveIds.has(b.id)));
    for (const b of live.filter((x) => mine.has(x.id))) {
      const copy = { id: b.id, type: b.type, title: b.title, sub: b.sub, price: b.price, visible: !!b.visible, items: b.items };
      const i = kept.findIndex((x) => x && x.id === b.id);
      if (i === -1) kept.push(copy); else kept[i] = copy;
    }
    state.blocks = kept;
  });
}

// Step 5: open days, opening and closing time, an optional lunch break.
async function saveHoursStep(user, body, data) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => body[`day_${d}`]);
  const values = {
    days,
    opens: String(body.opens || ''),
    closes: String(body.closes || ''),
    lunch: !!body.lunch,
    lunchFrom: String(body.lunchFrom || ''),
    lunchTo: String(body.lunchTo || ''),
  };
  const time = (t) => kit.TIME_RE.test(t);
  if (!days.length) throw stepError('Pick at least one day you’re open.', values);
  if (!time(values.opens) || !time(values.closes) || values.opens >= values.closes) {
    throw stepError('Your closing time needs to be after your opening time.', values);
  }
  let ranges = [[values.opens, values.closes]];
  if (values.lunch) {
    if (!time(values.lunchFrom) || !time(values.lunchTo) || values.lunchFrom >= values.lunchTo
      || values.lunchFrom <= values.opens || values.lunchTo >= values.closes) {
      throw stepError('The lunch break needs to start and end between your opening and closing time.', values);
    }
    ranges = [[values.opens, values.lunchFrom], [values.lunchTo, values.closes]];
  }
  const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => (days.includes(d) ? ranges.map((r) => [...r]) : []));
  await bookings.saveHours(user.id, hours, TIMEZONE);
  data.hours = values;
}

// Step 6: the template's theme, font, buttons and accent; the booking
// block (and the rest onboarding made) first on the page.
async function saveLook(user, preset, body, data) {
  const template = TEMPLATE_BY_KEY.get(String(body.template || ''));
  if (!template) throw stepError('Pick a look for your page.', { template: 'classic' });
  const accent = template.accent || preset.accent;
  const settings = normalizeStoreSettings({ ...normalizeStoreSettings(user.store_settings), ...template.settings });
  await users.updateStoreSettings(user.id, settings);
  await users.updateDesign(user.id, { accentColor: accent, showBadge: user.show_badge === undefined ? true : !!user.show_badge });

  const created = (data.created && data.created.blocks) || {};
  const first = [created.booking, ...Object.entries(created).filter(([k]) => k !== 'booking').map(([, id]) => id)].filter(Boolean);
  const live = await blocks.listBlocks(user.id);
  const order = [...first.filter((id) => live.some((b) => b.id === id)), ...live.map((b) => b.id).filter((id) => !first.includes(id))];
  if (order.length) await blocks.reorderBlocks(user.id, order);

  await storeDraft.patchDraft(user.id, (state) => {
    state.settings = { ...(state.settings || {}), ...template.settings };
    state.design = { ...(state.design || {}), accent };
  });
  data.template = template.key;
}

module.exports = {
  STEPS, FIRST, getProgress, start, homeFor, stepToShow, stepView, saveStep, checkHandle, indianMobile, presetFor,
};
