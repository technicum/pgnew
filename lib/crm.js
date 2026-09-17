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
// owner runs -- each row is tagged with which site it came from. Pass
// storeId to narrow to one site instead of "all sites" (the default).
async function listContacts(ownerUserId, segment, storeId) {
  const ownerStoreIds = await getOwnerStoreIds(ownerUserId);
  if (!ownerStoreIds.length) return [];
  const storeIds = storeId && ownerStoreIds.includes(Number(storeId)) ? [Number(storeId)] : ownerStoreIds;
  const filter = segment === 'customers' ? 'c.customer_id IS NOT NULL' : 'c.customer_id IS NULL';
  const [rows] = await pool.query(
    `SELECT c.*, s.name AS store_name
     FROM ${TABLES.contacts} c
     JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE c.store_id IN (?) AND ${filter}
     ORDER BY c.created_at DESC`,
    [storeIds]
  );
  return rows;
}

async function getContact(ownerUserId, contactId) {
  const storeIds = await getOwnerStoreIds(ownerUserId);
  if (!storeIds.length) return null;
  const [[contact]] = await pool.query(
    `SELECT c.*, s.name AS store_name
     FROM ${TABLES.contacts} c
     JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE c.id = ? AND c.store_id IN (?)`,
    [contactId, storeIds]
  );
  return contact || null;
}

// Manually moves a lead into Customers -- either links it to a real
// pz_customers row that already exists for that email at that store (e.g.
// they signed up separately and nothing has matched the two yet), or
// creates one with a random password so they have a real account, the same
// as the automatic match-on-signup would eventually do. Returns the
// customer id, or null if the contact wasn't found or was already linked.
async function convertToCustomer(ownerUserId, contactId) {
  const contact = await getContact(ownerUserId, contactId);
  if (!contact || contact.customer_id) return null;

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

// ---- Tasks -- a follow-up attached to one contact.
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
     JOIN ${TABLES.contacts} c ON c.id = t.contact_id
     JOIN ${TABLES.stores} s ON s.id = c.store_id
     WHERE t.owner_user_id = ? AND t.assigned_to = ?
     ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.created_at DESC`,
    [ownerUserId, assigneeUserId]
  );
  return rows;
}

async function createTask(ownerUserId, contactId, { title, due_date, assigned_to }) {
  await pool.query(
    `INSERT INTO ${TABLES.crmTasks} (owner_user_id, contact_id, title, due_date, assigned_to) VALUES (?, ?, ?, ?, ?)`,
    [ownerUserId, contactId, title, due_date || null, assigned_to || null]
  );
}

async function setTaskDone(ownerUserId, taskId, done) {
  await pool.query(`UPDATE ${TABLES.crmTasks} SET done = ? WHERE owner_user_id = ? AND id = ?`, [done ? 1 : 0, ownerUserId, taskId]);
}

async function deleteTask(ownerUserId, taskId) {
  await pool.query(`DELETE FROM ${TABLES.crmTasks} WHERE owner_user_id = ? AND id = ?`, [ownerUserId, taskId]);
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
  createTask,
  setTaskDone,
  deleteTask,
};
