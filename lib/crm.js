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
async function listContacts(ownerUserId, segment, storeId) {
  const ownerStoreIds = await getOwnerStoreIds(ownerUserId);
  const filter = segment === 'customers' ? 'c.customer_id IS NOT NULL' : 'c.customer_id IS NULL';

  if (storeId && ownerStoreIds.includes(Number(storeId))) {
    const [rows] = await pool.query(
      `SELECT c.*, s.name AS store_name
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
    `SELECT c.*, s.name AS store_name
     FROM ${TABLES.contacts} c
     LEFT JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE (c.store_id IN (?) OR (c.store_id IS NULL AND c.owner_user_id = ?)) AND ${filter}
     ORDER BY c.created_at DESC`,
    [ownerStoreIds, ownerUserId]
  );
  return rows;
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
// as the automatic match-on-signup would eventually do. Returns the
// customer id, or null if the contact wasn't found or was already linked.
// A contact with no site (see the CREATE TABLE comment) can't be converted
// -- pz_customers is inherently a per-store login, so pick a site first.
async function convertToCustomer(ownerUserId, contactId) {
  const contact = await getContact(ownerUserId, contactId);
  if (!contact || contact.customer_id) return null;
  if (!contact.store_id) {
    throw new Error('Assign this contact to a site before moving it to Customers.');
  }

  const [[existingCustomer]] = await pool.query(
    `SELECT id FROM ${TABLES.customers} WHERE store_id = ? AND email = ?`,
    [contact.store_id, contact.email]
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
      [contact.store_id, contact.name, contact.email, passwordHash, contact.phone]
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
    `SELECT t.*, c.name AS contact_name, s.name AS store_name, u.name AS assignee_name
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
    `SELECT t.*, c.name AS contact_name, s.name AS store_name, u.name AS assignee_name
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

module.exports = {
  resolveCrmAccess,
  getOwnerStores,
  getOwnerStoreIds,
  listContacts,
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
