// Courses app — a course is an ordered list of lessons (text in the rich
// text format of lib/richText.js, plus an optional video). Its public page,
// meera.pagezaper.com/course/:slug (lib/appStorefront.js), shows the
// outline and takes enrolments; each student lands in Audience tagged
// 'course' and gets a private link, /course/:slug/learn/:token, that opens
// the lessons. Free for now — a paid course would go through the payment
// pages checkout before the link is handed out.
//
// There's no email sending yet, so enrolling again with the same email
// hands back the same link — the way a student gets back in on a new
// device. Fine for a free course; a paid one will need a real sign-in.
const pool = require('./db');
const kit = require('./appKit');

const COURSES = 'PDZ_courses';
const LESSONS = 'PDZ_course_lessons';
const STUDENTS = 'PDZ_course_enrolments';
const MAX_LESSONS = 100;

const ensureTables = kit.lazyTables([
  `CREATE TABLE IF NOT EXISTS ${COURSES} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT '',
    slug VARCHAR(80) NOT NULL,
    description VARCHAR(2000) NOT NULL DEFAULT '',
    visible TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_slug (user_id, slug),
    INDEX (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${LESSONS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    course_id INT NOT NULL,
    user_id INT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    title VARCHAR(200) NOT NULL DEFAULT '',
    body TEXT,
    video_url VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (course_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${STUDENTS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    course_id INT NOT NULL,
    user_id INT NOT NULL,
    name VARCHAR(200) NOT NULL DEFAULT '',
    email VARCHAR(255) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    token CHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_course_email (course_id, email),
    UNIQUE KEY uniq_token (token),
    INDEX (user_id)
  )`,
  // Listed on PageZaper's marketplace (/explore, lib/marketplace.js) — the creator opts in.
  { sql: `ALTER TABLE ${COURSES} ADD COLUMN marketplace TINYINT(1) NOT NULL DEFAULT 0`, ignore: ['ER_DUP_FIELDNAME'] },
]);

function courseFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the course a name.');
  return { title, description: kit.cleanText(body.description, 2000), visible: body.visible ? 1 : 0, marketplace: body.marketplace ? 1 : 0 };
}

const WITH_COUNTS = `SELECT c.*,
  (SELECT COUNT(*) FROM ${LESSONS} l WHERE l.course_id = c.id) AS lesson_count,
  (SELECT COUNT(*) FROM ${STUDENTS} s WHERE s.course_id = c.id) AS student_count
  FROM ${COURSES} c`;

function toCourse(row) {
  return { ...row, visible: !!row.visible, lesson_count: Number(row.lesson_count || 0), student_count: Number(row.student_count || 0) };
}

async function listCourses(userId) {
  await ensureTables();
  const [rows] = await pool.query(`${WITH_COUNTS} WHERE c.user_id = ? ORDER BY c.created_at DESC, c.id DESC`, [userId]);
  return rows.map(toCourse);
}

async function getCourse(userId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`${WITH_COUNTS} WHERE c.id = ? AND c.user_id = ?`, [id, userId]);
  return row ? toCourse(row) : null;
}

async function getPublicCourse(userId, slug) {
  await ensureTables();
  const [[row]] = await pool.query(`${WITH_COUNTS} WHERE c.user_id = ? AND c.slug = ? AND c.visible = 1`, [userId, slug]);
  return row ? toCourse(row) : null;
}

async function createCourse(userId, body) {
  await ensureTables();
  const fields = courseFields({ visible: 1, ...body });
  const slug = await kit.uniqueSlug(COURSES, userId, body.slug || fields.title, 'course');
  const [result] = await pool.query(`INSERT INTO ${COURSES} SET ?`, [{ ...fields, slug, user_id: userId }]);
  return result.insertId;
}

async function updateCourse(userId, id, body) {
  await ensureTables();
  const fields = courseFields(body);
  fields.slug = await kit.uniqueSlug(COURSES, userId, body.slug || fields.title, 'course', id);
  await pool.query(`UPDATE ${COURSES} SET ? WHERE id = ? AND user_id = ?`, [fields, id, userId]);
}

async function deleteCourse(userId, id) {
  await ensureTables();
  const [result] = await pool.query(`DELETE FROM ${COURSES} WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!result.affectedRows) return;
  await pool.query(`DELETE FROM ${LESSONS} WHERE course_id = ? AND user_id = ?`, [id, userId]);
  await pool.query(`DELETE FROM ${STUDENTS} WHERE course_id = ? AND user_id = ?`, [id, userId]);
}

// --- Lessons ---------------------------------------------------------------

async function listLessons(courseId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT * FROM ${LESSONS} WHERE course_id = ? ORDER BY position ASC, id ASC`, [courseId]);
  return rows;
}

function lessonFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the lesson a title.');
  const video = kit.cleanText(body.video_url, 500);
  if (video && !/^https?:\/\/\S+\.\S+/i.test(video)) throw kit.inputError('The video link needs to start with https://');
  return { title, body: kit.cleanText(body.body, 20000), video_url: video };
}

async function addLesson(userId, courseId, body) {
  const fields = lessonFields(body);
  const [[{ n, top }]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS top FROM ${LESSONS} WHERE course_id = ? AND user_id = ?`,
    [courseId, userId],
  );
  if (n >= MAX_LESSONS) throw kit.inputError(`A course can have up to ${MAX_LESSONS} lessons.`);
  const [result] = await pool.query(`INSERT INTO ${LESSONS} SET ?`, [{ ...fields, course_id: courseId, user_id: userId, position: top + 1 }]);
  return result.insertId;
}

async function updateLesson(userId, courseId, lessonId, body) {
  await pool.query(`UPDATE ${LESSONS} SET ? WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonFields(body), lessonId, courseId, userId]);
}

async function deleteLesson(userId, courseId, lessonId) {
  await pool.query(`DELETE FROM ${LESSONS} WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonId, courseId, userId]);
}

// Swaps a lesson with its neighbour (dir -1 = up, 1 = down), renumbering
// the whole list so positions stay 1..n.
async function moveLesson(userId, courseId, lessonId, dir) {
  const lessons = (await listLessons(courseId)).filter((l) => l.user_id === userId);
  const i = lessons.findIndex((l) => l.id === lessonId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lessons.length) return;
  [lessons[i], lessons[j]] = [lessons[j], lessons[i]];
  await Promise.all(lessons.map((l, k) => pool.query(`UPDATE ${LESSONS} SET position = ? WHERE id = ?`, [k + 1, l.id])));
}

// --- Students --------------------------------------------------------------

// Enrols someone (or finds their enrolment) and returns their access token.
async function enrol(course, person) {
  await ensureTables();
  const [[existing]] = await pool.query(`SELECT token FROM ${STUDENTS} WHERE course_id = ? AND email = ?`, [course.id, person.email]);
  if (existing) return { token: existing.token, already: true };
  const token = kit.newToken();
  try {
    await pool.query(`INSERT INTO ${STUDENTS} SET ?`, [{ course_id: course.id, user_id: course.user_id, ...person, token }]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const [[row]] = await pool.query(`SELECT token FROM ${STUDENTS} WHERE course_id = ? AND email = ?`, [course.id, person.email]);
    return { token: row.token, already: true };
  }
  return { token, already: false };
}

async function getStudentByToken(courseId, token) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${STUDENTS} WHERE course_id = ? AND token = ?`, [courseId, token]);
  return row || null;
}

async function listStudents(userId, courseId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT id, name, email, phone, created_at FROM ${STUDENTS} WHERE course_id = ? AND user_id = ? ORDER BY created_at DESC`,
    [courseId, userId],
  );
  return rows;
}

async function removeStudent(userId, courseId, id) {
  await ensureTables();
  await pool.query(`DELETE FROM ${STUDENTS} WHERE id = ? AND course_id = ? AND user_id = ?`, [id, courseId, userId]);
}

// A YouTube / Vimeo link as an embeddable player URL, or null (then the
// lesson just links to the video).
function videoEmbedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (err) { return null; }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com') id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/) || [])[1];
  if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const vid = (url.pathname.match(/(\d{5,})/) || [])[1];
    if (vid) return `https://player.vimeo.com/video/${vid}`;
  }
  return null;
}

// Live courses the creators listed on the marketplace (lib/marketplace.js), newest first.
async function listMarketplaceCourses() {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT x.*, u.handle AS owner_handle, u.name AS owner_name FROM (${WITH_COUNTS} WHERE c.visible = 1 AND c.marketplace = 1) x
     JOIN PDZ_users u ON u.id = x.user_id ORDER BY x.created_at DESC LIMIT 200`,
  );
  return rows.map(toCourse);
}

module.exports = {
  listMarketplaceCourses,
  listCourses, getCourse, getPublicCourse, createCourse, updateCourse, deleteCourse,
  listLessons, addLesson, updateLesson, deleteLesson, moveLesson,
  enrol, getStudentByToken, listStudents, removeStudent, videoEmbedUrl,
};
