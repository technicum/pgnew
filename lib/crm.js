// Account-level CRM: works across every store one pz_users login runs,
// rather than being nested inside any single store's own /admin (see
// routes/platform.js's /dashboard/crm/* routes for where this is used).
//
// Two independent permission layers meet here, and it's worth keeping them
// straight:
//   - pz_user_roles says who can administer a given STORE (products, orders,
//     pages, everything).
//   - pz_crm_members says who can work a given CRM OWNER's leads/tasks.
// Being store staff does not imply CRM access, and being on someone's CRM
// team does not imply store access — the owner grants each separately.
const { pool, TABLES } = require('../db/database');

// Resolves a logged-in session (req.session.account.id) to a CRM context:
// either they own CRM themselves (they're the one who activated the
// account-scoped app), or they're a member of someone else's CRM team. A
// person can in principle be a member of more than one owner's team; v1
// keeps this simple and picks the first one. Returns null if this login has
// no CRM access anywhere.
async function resolveCrmAccess(userId) {
  const { isAccountAppActive } = require('./apps');
  if (await isAccountAppActive(userId, 'crm')) {
    return { ownerUserId: userId, role: 'owner' };
  }
  const [[member]] = await pool.query(
    `SELECT owner_user_id, role FROM ${TABLES.crmMembers} WHERE member_user_id = ? ORDER BY id ASC LIMIT 1`,
    [userId]
  );
  if (member) return { ownerUserId: member.owner_user_id, role: member.role };
  return null;
}

// Every active store this owner administers or manages — the scope of
// their CRM. Mirrors the exact join routes/platform.js's own /dashboard
// already runs to list "your stores".
async function getOwnerStores(ownerUserId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.name, s.subdomain
     FROM ${TABLES.userRoles} ur
     JOIN ${TABLES.stores} s ON s.id = ur.store_id
     WHERE ur.user_id = ? AND ur.role IN ('admin', 'manager') AND s.status = 'active'
     ORDER BY s.created_at ASC`,
    [ownerUserId]
  );
  return rows;
}

async function getOwnerStoreIds(ownerUserId) {
  const stores = await getOwnerStores(ownerUserId);
  return stores.map((s) => s.id);
}

// ---- Contacts (leads / customers), aggregated across every store the
// owner runs -- each row is tagged with which site it came from, or with
// no site at all for a general inquiry (see pz_contacts.owner_user_id).
// Pass storeId to narrow to one site instead of "all sites" (the default,
// which also includes the no-site contacts a specific-site filter leaves
// out on purpose -- picking "Site A" shouldn't surface general leads).
// Each row also carries its earliest still-open follow-up date (next_followup)
// and how many open ones it has (open_followups), for the list's "Next
// follow-up" column.
const NEXT_FOLLOWUP_COLUMNS = `
  (SELECT MIN(f.due_date) FROM ${TABLES.crmFollowups} f WHERE f.contact_id = c.id AND f.done = 0) AS next_followup,
  (SELECT COUNT(*) FROM ${TABLES.crmFollowups} f WHERE f.contact_id = c.id AND f.done = 0) AS open_followups`;

async function listContacts(ownerUserId, segment, storeId) {
  const ownerStoreIds = await getOwnerStoreIds(ownerUserId);
  const filter = segment === 'customers' ? 'c.customer_id IS NOT NULL' : 'c.customer_id IS NULL';

  if (storeId && ownerStoreIds.includes(Number(storeId))) {
    const [rows] = await pool.query(
      `SELECT c.*, s.name AS store_name, ${NEXT_FOLLOWUP_COLUMNS}
       FROM ${TABLES.contacts} c
       JOIN ${TABLES.stores} s ON s.id = c.store_id
       WHERE c.store_id = ? AND ${filter}
       ORDER BY c.created_at DESC`,
      [Number(storeId)]
    );
    return rows;
  }

  if (!ownerStoreIds.length) ownerStoreIds.push(0); // keeps the IN (?) below valid SQL when the owner runs no stores
  const [rows] = await pool.query(
    `SELECT c.*, s.name AS store_name, ${NEXT_FOLLOWUP_COLUMNS}
     FROM ${TABLES.contacts} c
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE (c.store_id IN (?) OR (c.store_id IS NULL AND c.owner_user_id = ?)) AND ${filter}
     ORDER BY c.created_at DESC`,
    [ownerStoreIds, ownerUserId]
  );
  return rows;
}

// The tags this owner has used before, most-used first -- powers the
// "choose from the most used tags" shortcut next to the tag input (same
// idea as WordPress's post-tags meta box).
async function listTagCounts(ownerUserId, limit = 15) {
  const ownerStoreIds = await getOwnerStoreIds(ownerUserId);
  if (!ownerStoreIds.length) ownerStoreIds.push(0); // keeps the IN (?) below valid SQL when the owner runs no stores
  const [rows] = await pool.query(
    `SELECT tags FROM ${TABLES.contacts}
     WHERE (store_id IN (?) OR (store_id IS NULL AND owner_user_id = ?)) AND tags IS NOT NULL`,
    [ownerStoreIds, ownerUserId]
  );
  const counts = new Map();
  rows.forEach((row) => {
    (row.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

async function getContact(ownerUserId, contactId) {
  const storeIds = await getOwnerStoreIds(ownerUserId);
  storeIds.push(0); // keeps the IN (?) below valid SQL when the owner runs no stores
  const [[contact]] = await pool.query(
    `SELECT c.*, s.name AS store_name
     FROM ${TABLES.contacts} c
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE c.id = ? AND (c.store_id IN (?) OR (c.store_id IS NULL AND c.owner_user_id = ?))`,
    [contactId, storeIds, ownerUserId]
  );
  return contact || null;
}

// Manually moves a lead into Customers -- either links it to a real
// pz_customers row that already exists for that email at that store (e.g.
// they signed up separately and nothing has matched the two yet), or
// creates one with a random password so they have a real account, the same
// as the automatic match-on-signup would eventually do. Whether they ever
// actually checked out is irrelevant -- this is a manual promotion, not a
// record of a purchase. Returns the customer id, or null if the contact
// wasn't found or was already linked.
// pz_customers is inherently a per-store login, so a contact with no site
// yet (a general inquiry) needs one picked at conversion time -- storeId
// covers that case and is otherwise ignored for a contact that already has
// a site.
async function convertToCustomer(ownerUserId, contactId, storeId) {
  const contact = await getContact(ownerUserId, contactId);
  if (!contact || contact.customer_id) return null;

  let targetStoreId = contact.store_id;
  if (!targetStoreId) {
    const ownerStoreIds = await getOwnerStoreIds(ownerUserId);
    if (!storeId || !ownerStoreIds.includes(Number(storeId))) {
      throw new Error('Choose one of your sites to move this contact to Customers.');
    }
    targetStoreId = Number(storeId);

    const [[dupe]] = await pool.query(
      `SELECT id FROM ${TABLES.contacts} WHERE store_id = ? AND email = ?`,
      [targetStoreId, contact.email]
    );
    if (dupe) {
      throw new Error(`A contact with email "${contact.email}" already exists for that site.`);
    }
    // Keeps the store_id/owner_user_id invariant from the CREATE TABLE
    // comment intact -- owner_user_id is only ever set while store_id is
    // NULL, so it clears the moment a site is attached.
    await pool.query(
      `UPDATE ${TABLES.contacts} SET store_id = ?, owner_user_id = NULL WHERE id = ?`,
      [targetStoreId, contact.id]
    );
  }

  const [[existingCustomer]] = await pool.query(
    `SELECT id FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`,
    [targetStoreId, contact.email]
  );

  let customerId;
  if (existingCustomer) {
    customerId = existingCustomer.id;
  } else {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const randomPassword = crypto.randomBytes(9).toString('base64');
    const passwordHash = bcrypt.hashSync(randomPassword, 10);
    const [result] = await pool.query(
      `INSERT INTO ${TABLES.customers} (store_id, name, email, password_hash, phone) VALUES (?, ?, ?, ?, ?)`,
      [targetStoreId, contact.name, contact.email, passwordHash, contact.phone]
    );
    customerId = result.insertId;
  }

  await pool.query(`UPDATE ${TABLES.contacts} SET customer_id = ? WHERE id = ?`, [customerId, contact.id]);
  return customerId;
}

// ---- CRM team -- independent of pz_user_roles; see the file comment.
async function listCrmTeam(ownerUserId) {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, m.role, m.created_at
     FROM ${TABLES.crmMembers} m
     JOIN ${TABLES.users} u ON u.id = m.member_user_id
     WHERE m.owner_user_id = ?
     ORDER BY (m.role = 'manager') DESC, u.name ASC`,
    [ownerUserId]
  );
  return rows;
}

// Every person a task can be assigned to for this owner's CRM: the owner
// themself, plus their CRM team. Used to populate the assignee dropdown and
// to validate a submitted assignee actually belongs to this CRM.
async function listAssignableUsers(ownerUserId) {
  const [[owner]] = await pool.query(`SELECT id, name, email FROM ${TABLES.users} WHERE id = ?`, [ownerUserId]);
  const team = await listCrmTeam(ownerUserId);
  const list = owner ? [{ ...owner, role: 'owner' }] : [];
  return list.concat(team);
}

async function isAssignable(ownerUserId, userId) {
  if (!userId) return true; // unassigned is always valid
  const users = await listAssignableUsers(ownerUserId);
  return users.some((u) => u.id === Number(userId));
}

// Adds (or re-adds) a CRM team member by email -- reuses an existing
// pz_users login if that email already has one (same pattern as
// routes/admin.js's own /settings/team invite), rather than creating a
// second account for the same person.
async function addCrmMember(ownerUserId, { name, email, password, role }) {
  const bcrypt = require('bcryptjs');
  const [[existingUser]] = await pool.query(`SELECT id FROM ${TABLES.users} WHERE email = ?`, [email]);
  let userId;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters for a new team member.');
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    const [result] = await pool.query(`INSERT INTO ${TABLES.users} (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, passwordHash]);
    userId = result.insertId;
  }
  if (userId === ownerUserId) {
    throw new Error("That's your own account already.");
  }
  const [[existingMember]] = await pool.query(
    `SELECT id FROM ${TABLES.crmMembers} WHERE owner_user_id = ? AND member_user_id = ?`,
    [ownerUserId, userId]
  );
  if (existingMember) {
    throw new Error(`${email} is already on your CRM team.`);
  }
  await pool.query(
    `INSERT INTO ${TABLES.crmMembers} (owner_user_id, member_user_id, role) VALUES (?, ?, ?)`,
    [ownerUserId, userId, role === 'manager' ? 'manager' : 'member']
  );
}

async function removeCrmMember(ownerUserId, memberUserId) {
  await pool.query(`DELETE FROM ${TABLES.crmMembers} WHERE owner_user_id = ? AND member_user_id = ?`, [ownerUserId, memberUserId]);
}

// ---- Tasks -- a follow-up, either attached to one contact or "standalone"
// (contact_id NULL) for CRM work that isn't about any one lead/customer.

// Very small allowlist sanitizer for the task description's rich-text HTML
// (there's no sanitize-html/DOMPurify dependency in this project -- see
// package.json). Strips script/style/iframe/object tags entirely (including
// their content), then strips any on*="..." event-handler attribute and any
// href/src using a javascript: URL. It is not a full HTML parser and isn't
// meant to allow arbitrary markup back in -- the editor that produces this
// HTML (the contenteditable toolbar in crm-tasks.ejs) only ever emits a
// small, known set of tags (b/i/u/strike, ul/ol/li, a, img, p, div, br).
function sanitizeDescriptionHtml(html) {
  if (!html) return null;
  let out = String(html);
  out = out.replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
  out = out.replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
  out = out.trim();
  return out || null;
}

const VALID_PRIORITIES = ['low', 'medium', 'high'];
function sanitizePriority(priority) {
  return VALID_PRIORITIES.includes(priority) ? priority : 'medium';
}

async function listTasksForContact(contactId) {
  const [rows] = await pool.query(
    `SELECT t.*, u.name AS assignee_name
     FROM ${TABLES.crmTasks} t
     LEFT JOIN ${TABLES.users} u ON u.id = t.assigned_to
     WHERE t.contact_id = ?
     ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
    [contactId]
  );
  return rows;
}

// Every open (or recently done) task assigned to one person across this
// owner's whole CRM -- this is the "my tasks" view a team member lands on.
async function listTasksForAssignee(ownerUserId, assigneeUserId) {
  const [rows] = await pool.query(
    `SELECT t.*, c.name AS contact_name, c.email AS contact_email, s.name AS store_name
     FROM ${TABLES.crmTasks} t
     LEFT JOIN ${TABLES.contacts} c ON c.id = t.contact_id
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE t.owner_user_id = ? AND t.assigned_to = ?
     ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
    [ownerUserId, assigneeUserId]
  );
  return rows;
}

// The full Tasks tab -- every task under this owner's CRM, contact-linked
// or standalone, with optional filters. assignee can be a user id,
// 'unassigned', or falsy/'' for "everyone".
async function listTasks(ownerUserId, { search, due, assignee } = {}) {
  const clauses = ['t.owner_user_id = ?'];
  const params = [ownerUserId];
  if (search && search.trim()) {
    clauses.push('t.title LIKE ?');
    params.push(`%${search.trim()}%`);
  }
  if (due) {
    clauses.push('t.due_date = ?');
    params.push(due);
  }
  if (assignee === 'unassigned') {
    clauses.push('t.assigned_to IS NULL');
  } else if (assignee) {
    clauses.push('t.assigned_to = ?');
    params.push(Number(assignee));
  }
  const [rows] = await pool.query(
    `SELECT t.*, c.name AS contact_name, s.name AS store_name, s.subdomain AS store_subdomain, u.name AS assignee_name
     FROM ${TABLES.crmTasks} t
     LEFT JOIN ${TABLES.contacts} c ON c.id = t.contact_id
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     LEFT JOIN ${TABLES.users} u ON u.id = t.assigned_to
     WHERE ${clauses.join(' AND ')}
     ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
    params
  );
  return rows;
}

// One task for the detail panel, scoped to this owner's CRM. Returns null
// if it doesn't exist or belongs to someone else's CRM.
async function getTask(ownerUserId, taskId) {
  const [[task]] = await pool.query(
    `SELECT t.*, c.id AS contact_id_ref, c.name AS contact_name, s.name AS store_name, s.subdomain AS store_subdomain, u.name AS assignee_name
     FROM ${TABLES.crmTasks} t
     LEFT JOIN ${TABLES.contacts} c ON c.id = t.contact_id
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     LEFT JOIN ${TABLES.users} u ON u.id = t.assigned_to
     WHERE t.id = ? AND t.owner_user_id = ?`,
    [taskId, ownerUserId]
  );
  return task || null;
}

// contactId is optional -- omit it (or pass null) for a standalone task not
// tied to any lead/customer.
async function createTask(ownerUserId, { contactId, title, description, priority, due_date, assigned_to }) {
  const [result] = await pool.query(
    `INSERT INTO ${TABLES.crmTasks} (owner_user_id, contact_id, title, description, priority, due_date, assigned_to)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      contactId || null,
      title,
      sanitizeDescriptionHtml(description),
      sanitizePriority(priority),
      due_date || null,
      assigned_to || null,
    ]
  );
  return result.insertId;
}

async function updateTask(ownerUserId, taskId, { title, description, priority, due_date, assigned_to }) {
  await pool.query(
    `UPDATE ${TABLES.crmTasks} SET title = ?, description = ?, priority = ?, due_date = ?, assigned_to = ?
     WHERE owner_user_id = ? AND id = ?`,
    [title, sanitizeDescriptionHtml(description), sanitizePriority(priority), due_date || null, assigned_to || null, ownerUserId, taskId]
  );
}

async function reassignTask(ownerUserId, taskId, assignedTo) {
  await pool.query(`UPDATE ${TABLES.crmTasks} SET assigned_to = ? WHERE owner_user_id = ? AND id = ?`, [
    assignedTo || null,
    ownerUserId,
    taskId,
  ]);
}

async function setTaskDone(ownerUserId, taskId, done) {
  await pool.query(`UPDATE ${TABLES.crmTasks} SET done = ? WHERE owner_user_id = ? AND id = ?`, [done ? 1 : 0, ownerUserId, taskId]);
}

async function deleteTask(ownerUserId, taskId) {
  await pool.query(`DELETE FROM ${TABLES.crmTasks} WHERE owner_user_id = ? AND id = ?`, [ownerUserId, taskId]);
}

// ---- Subtasks -- a small checklist item nested under one task.
async function listSubtasks(taskId) {
  const [rows] = await pool.query(
    `SELECT st.*, u.name AS assignee_name
     FROM ${TABLES.crmSubtasks} st
     LEFT JOIN ${TABLES.users} u ON u.id = st.assigned_to
     WHERE st.task_id = ?
     ORDER BY st.done ASC, st.created_at ASC`,
    [taskId]
  );
  return rows;
}

async function createSubtask(ownerUserId, taskId, { title, due_date, assigned_to }) {
  const task = await getTask(ownerUserId, taskId);
  if (!task) throw new Error('Task not found.');
  await pool.query(`INSERT INTO ${TABLES.crmSubtasks} (task_id, title, due_date, assigned_to) VALUES (?, ?, ?, ?)`, [
    taskId,
    title,
    due_date || null,
    assigned_to || null,
  ]);
}

// Scoped through the parent task's owner_user_id, so a subtask id alone
// can't be used to touch another CRM's data.
async function setSubtaskDone(ownerUserId, subtaskId, done) {
  await pool.query(
    `UPDATE ${TABLES.crmSubtasks} st JOIN ${TABLES.crmTasks} t ON t.id = st.task_id
     SET st.done = ? WHERE st.id = ? AND t.owner_user_id = ?`,
    [done ? 1 : 0, subtaskId, ownerUserId]
  );
}

async function deleteSubtask(ownerUserId, subtaskId) {
  await pool.query(
    `DELETE st FROM ${TABLES.crmSubtasks} st JOIN ${TABLES.crmTasks} t ON t.id = st.task_id
     WHERE st.id = ? AND t.owner_user_id = ?`,
    [subtaskId, ownerUserId]
  );
}

// Which task a subtask belongs to -- used to redirect back to the right
// drawer after a subtask action, without trusting a client-supplied id.
async function getSubtaskTaskId(ownerUserId, subtaskId) {
  const [[row]] = await pool.query(
    `SELECT st.task_id FROM ${TABLES.crmSubtasks} st JOIN ${TABLES.crmTasks} t ON t.id = st.task_id
     WHERE st.id = ? AND t.owner_user_id = ?`,
    [subtaskId, ownerUserId]
  );
  return row ? row.task_id : null;
}

// ---- Follow-ups -- a scheduled "get back to this contact on this day",
// separate from tasks. Each one belongs to a contact and can optionally link
// to one task (the work it's about). The Follow-ups screen is the daily
// "what do I need to do" list, so most of what's here is date bucketing.

// Server-local YYYY-MM-DD. mysql2 reads/writes DATE columns in the same
// local time zone, so comparing against this string lines up with due_date.
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A follow-up's time is optional; only accept a plain HH:MM (or HH:MM:SS).
function sanitizeDueTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(value || '').trim());
  return m ? `${m[1]}:${m[2]}:00` : null;
}

function sanitizeDueDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

// Every task a follow-up on this contact could be linked to: that contact's
// own open tasks plus the owner's standalone ones (no contact).
async function listLinkableTasks(ownerUserId, contactId) {
  const [rows] = await pool.query(
    `SELECT id, title, contact_id FROM ${TABLES.crmTasks}
     WHERE owner_user_id = ? AND done = 0 AND (contact_id = ? OR contact_id IS NULL)
     ORDER BY contact_id IS NULL, due_date IS NULL, due_date ASC, created_at DESC`,
    [ownerUserId, contactId]
  );
  return rows;
}

// Returns the task id only if it is one this follow-up may legitimately link
// to (see listLinkableTasks) -- anything else, including another CRM's task
// id, becomes null rather than an error.
async function resolveLinkableTask(ownerUserId, contactId, taskId) {
  const id = parseInt(taskId, 10);
  if (!id) return null;
  const [[task]] = await pool.query(
    `SELECT id FROM ${TABLES.crmTasks} WHERE id = ? AND owner_user_id = ? AND (contact_id = ? OR contact_id IS NULL)`,
    [id, ownerUserId, contactId]
  );
  return task ? task.id : null;
}

const FOLLOWUP_SELECT = `SELECT f.*, c.name AS contact_name, c.customer_id AS contact_customer_id, s.name AS store_name, u.name AS assignee_name,
    t.title AS task_title, t.done AS task_done
  FROM ${TABLES.crmFollowups} f
  JOIN ${TABLES.contacts} c ON c.id = f.contact_id
  LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
  LEFT JOIN ${TABLES.users} u ON u.id = f.assigned_to
  LEFT JOIN ${TABLES.crmTasks} t ON t.id = f.task_id`;

// assignee: a user id, 'unassigned', or falsy for everyone.
function assigneeClause(assignee) {
  if (assignee === 'unassigned') return { sql: ' AND f.assigned_to IS NULL', params: [] };
  if (assignee) return { sql: ' AND f.assigned_to = ?', params: [Number(assignee)] };
  return { sql: '', params: [] };
}

// kind: 'lead' | 'customer', or falsy for both. A contact is a customer once
// it has a linked customer account (see listContacts).
function kindClause(kind) {
  if (kind === 'lead') return ' AND c.customer_id IS NULL';
  if (kind === 'customer') return ' AND c.customer_id IS NOT NULL';
  return '';
}

// view: 'today' | 'overdue' | 'upcoming' | 'done'
async function listFollowups(ownerUserId, { view, assignee, kind } = {}) {
  const today = todayStr();
  const who = assigneeClause(assignee);
  let where;
  let order = 'f.due_date ASC, f.due_time IS NULL, f.due_time ASC, f.id ASC';
  let limit = '';
  const params = [ownerUserId];
  if (view === 'overdue') {
    where = 'f.done = 0 AND f.due_date < ?';
    params.push(today);
  } else if (view === 'upcoming') {
    where = 'f.done = 0 AND f.due_date > ?';
    params.push(today);
  } else if (view === 'done') {
    where = 'f.done = 1';
    order = 'f.done_at DESC, f.id DESC';
    limit = ' LIMIT 100';
  } else {
    where = 'f.done = 0 AND f.due_date = ?';
    params.push(today);
  }
  const [rows] = await pool.query(
    `${FOLLOWUP_SELECT} WHERE f.owner_user_id = ? AND ${where}${who.sql}${kindClause(kind)} ORDER BY ${order}${limit}`,
    [...params, ...who.params]
  );
  return rows;
}

// Open follow-ups per bucket, for the tab badges.
async function countFollowups(ownerUserId, assignee, kind) {
  const today = todayStr();
  const who = assigneeClause(assignee);
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(f.due_date = ?), 0) AS today,
            COALESCE(SUM(f.due_date < ?), 0) AS overdue,
            COALESCE(SUM(f.due_date > ?), 0) AS upcoming
     FROM ${TABLES.crmFollowups} f
     JOIN ${TABLES.contacts} c ON c.id = f.contact_id
     WHERE f.owner_user_id = ? AND f.done = 0${who.sql}${kindClause(kind)}`,
    [today, today, today, ownerUserId, ...who.params]
  );
  return { today: Number(row.today), overdue: Number(row.overdue), upcoming: Number(row.upcoming) };
}

async function listFollowupsForContact(ownerUserId, contactId) {
  const [rows] = await pool.query(
    `${FOLLOWUP_SELECT} WHERE f.owner_user_id = ? AND f.contact_id = ?
     ORDER BY f.done ASC, f.due_date ASC, f.due_time IS NULL, f.due_time ASC, f.id ASC`,
    [ownerUserId, contactId]
  );
  return rows;
}

async function getFollowup(ownerUserId, followupId) {
  const [[row]] = await pool.query(`${FOLLOWUP_SELECT} WHERE f.id = ? AND f.owner_user_id = ?`, [followupId, ownerUserId]);
  return row || null;
}

async function createFollowup(ownerUserId, { contactId, title, note, due_date, due_time, assigned_to, task_id }) {
  const [result] = await pool.query(
    `INSERT INTO ${TABLES.crmFollowups} (owner_user_id, contact_id, task_id, title, note, due_date, due_time, assigned_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUserId,
      contactId,
      await resolveLinkableTask(ownerUserId, contactId, task_id),
      title,
      note ? String(note).trim().slice(0, 2000) || null : null,
      due_date,
      sanitizeDueTime(due_time),
      assigned_to || null,
    ]
  );
  return result.insertId;
}

async function updateFollowup(ownerUserId, followup, { title, note, due_date, due_time, assigned_to, task_id }) {
  await pool.query(
    `UPDATE ${TABLES.crmFollowups}
     SET title = ?, note = ?, due_date = ?, due_time = ?, assigned_to = ?, task_id = ?
     WHERE owner_user_id = ? AND id = ?`,
    [
      title,
      note ? String(note).trim().slice(0, 2000) || null : null,
      due_date,
      sanitizeDueTime(due_time),
      assigned_to || null,
      await resolveLinkableTask(ownerUserId, followup.contact_id, task_id),
      ownerUserId,
      followup.id,
    ]
  );
}

async function rescheduleFollowup(ownerUserId, followupId, dueDate) {
  await pool.query(`UPDATE ${TABLES.crmFollowups} SET due_date = ? WHERE owner_user_id = ? AND id = ?`, [dueDate, ownerUserId, followupId]);
}

async function setFollowupDone(ownerUserId, followupId, done) {
  await pool.query(
    `UPDATE ${TABLES.crmFollowups} SET done = ?, done_at = ${done ? 'NOW()' : 'NULL'} WHERE owner_user_id = ? AND id = ?`,
    [done ? 1 : 0, ownerUserId, followupId]
  );
}

async function deleteFollowup(ownerUserId, followupId) {
  await pool.query(`DELETE FROM ${TABLES.crmFollowups} WHERE owner_user_id = ? AND id = ?`, [ownerUserId, followupId]);
}

// What the sidebar badge shows: this person's open follow-ups due today or
// already overdue.
async function countFollowupsDue(ownerUserId, assigneeUserId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM ${TABLES.crmFollowups}
     WHERE owner_user_id = ? AND assigned_to = ? AND done = 0 AND due_date <= ?`,
    [ownerUserId, assigneeUserId, todayStr()]
  );
  return Number(row.c);
}

module.exports = {
  todayStr,
  sanitizeDueDate,
  listLinkableTasks,
  listFollowups,
  countFollowups,
  listFollowupsForContact,
  getFollowup,
  createFollowup,
  updateFollowup,
  rescheduleFollowup,
  setFollowupDone,
  deleteFollowup,
  countFollowupsDue,
  resolveCrmAccess,
  getOwnerStores,
  getOwnerStoreIds,
  listContacts,
  listTagCounts,
  getContact,
  convertToCustomer,
  listCrmTeam,
  listAssignableUsers,
  isAssignable,
  addCrmMember,
  removeCrmMember,
  listTasksForContact,
  listTasksForAssignee,
  listTasks,
  getTask,
  createTask,
  updateTask,
  reassignTask,
  setTaskDone,
  deleteTask,
  listSubtasks,
  createSubtask,
  setSubtaskDone,
  deleteSubtask,
  getSubtaskTaskId,
};
