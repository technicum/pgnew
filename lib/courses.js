// Courses app — a course is an ordered list of lessons (text in the rich
// text format of lib/richText.js, plus an optional video). Its public page,
// meera.pagezaper.com/course/:slug (lib/appStorefront.js), shows the
// outline and takes enrolments; each student lands in Audience tagged
// 'course' and gets a private link, /course/:slug/learn/:token, that opens
// the lessons. A paid course places an order (lib/orders.js, with
// PageZaper's fee — lib/platform.js) and the same link is its checkout
// until it's paid.
//
// The curriculum is modules (PDZ_course_modules, in order), each holding
// items in order — kept in the lessons table, of three kinds (KINDS):
//   lesson — text plus an optional video (uploaded and kept private —
//            lib/courseMedia.js — or a YouTube / Vimeo link)
//   quiz   — multiple-choice questions (one or several right answers),
//            graded when the student submits; the score is kept
//            (PDZ_course_quiz_attempts) and submitting completes it
//   file   — a download (PDF, worksheet, slides…), kept private and
//            handed out through a short-lived signed link
// Items outside any module (module_id NULL) come first, under no heading.
// Any item can be a free preview. Courses from before modules had a
// module *name* on each lesson; those become real modules the first time
// the course's items are listed (adoptModuleNames).
//
// There's no email sending yet, so enrolling again with the same email
// hands back the same link — the way a student gets back in on a new
// device — for a free course. A paid course never hands an existing
// student's link back to whoever types their email; the creator can copy
// it from the Students list for anyone who lost it.
const pool = require('./db');
const kit = require('./appKit');
const { formatINR } = require('./paymentPages');
const { createOrder } = require('./orders');
const { removeVideo, removeFile } = require('./courseMedia');

const COURSES = 'PDZ_courses';
const LESSONS = 'PDZ_course_lessons';
const STUDENTS = 'PDZ_course_enrolments';
const PROGRESS = 'PDZ_course_progress';
const MODULES = 'PDZ_course_modules';
const ATTEMPTS = 'PDZ_course_quiz_attempts';
const DEVICES = 'PDZ_course_devices';
// A student's link opens on this many browsers; more are refused until
// the creator resets their devices. A video plays on one at a time.
const MAX_DEVICES = 2;
const PLAY_WINDOW_SECONDS = 45;
const KINDS = { lesson: 'Lesson', quiz: 'Quiz', file: 'Download' };
const MAX_LESSONS = 100; // items of every kind, per course
const MAX_MODULES = 30;
const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 6;
const MAX_OUTCOMES = 10;
const MAX_PRICE = 10000000; // ₹1,00,000 in paise

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
  // Paid courses, the course page's cover and "what you'll learn"; lessons
  // grouped into modules, free previews and uploaded (private) videos;
  // enrolments waiting for payment.
  ...[
    `ALTER TABLE ${COURSES} ADD COLUMN price INT NOT NULL DEFAULT 0`,
    `ALTER TABLE ${COURSES} ADD COLUMN cover_url VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${COURSES} ADD COLUMN outcomes VARCHAR(2000) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${LESSONS} ADD COLUMN module VARCHAR(120) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${LESSONS} ADD COLUMN preview TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE ${LESSONS} ADD COLUMN video_file VARCHAR(200) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${STUDENTS} ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'active'`,
    `ALTER TABLE ${STUDENTS} ADD COLUMN order_id INT NULL DEFAULT NULL`,
  ].map((sql) => ({ sql, ignore: ['ER_DUP_FIELDNAME'] })),
  // One row per lesson a student has marked complete.
  `CREATE TABLE IF NOT EXISTS ${PROGRESS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    lesson_id INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_student_lesson (student_id, lesson_id)
  )`,
  // Modules, and the three kinds of item in them: a quiz's questions as
  // JSON ([{ q, options: [..], correct: [indexes] }]); a download's stored
  // file, its original name and size.
  `CREATE TABLE IF NOT EXISTS ${MODULES} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    course_id INT NOT NULL,
    user_id INT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    title VARCHAR(120) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (course_id)
  )`,
  ...[
    `ALTER TABLE ${LESSONS} ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'lesson'`,
    `ALTER TABLE ${LESSONS} ADD COLUMN module_id INT NULL DEFAULT NULL`,
    `ALTER TABLE ${LESSONS} ADD COLUMN quiz MEDIUMTEXT NULL`,
    `ALTER TABLE ${LESSONS} ADD COLUMN file_name VARCHAR(200) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${LESSONS} ADD COLUMN file_label VARCHAR(200) NOT NULL DEFAULT ''`,
    `ALTER TABLE ${LESSONS} ADD COLUMN file_size BIGINT NOT NULL DEFAULT 0`,
  ].map((sql) => ({ sql, ignore: ['ER_DUP_FIELDNAME'] })),
  // The browsers a student's link has been opened on (lockDevice), and
  // which one is playing a video right now (claimPlayback).
  `CREATE TABLE IF NOT EXISTS ${DEVICES} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    device CHAR(64) NOT NULL,
    label VARCHAR(120) NOT NULL DEFAULT '',
    ip VARCHAR(64) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    play_started TIMESTAMP(3) NULL DEFAULT NULL,
    last_play TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_student_device (student_id, device)
  )`,
  { sql: `ALTER TABLE ${STUDENTS} ADD COLUMN blocked_tries INT NOT NULL DEFAULT 0`, ignore: ['ER_DUP_FIELDNAME'] },
  // Each time a student submits a quiz: the score and what they picked.
  `CREATE TABLE IF NOT EXISTS ${ATTEMPTS} (
    id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT NOT NULL,
    lesson_id INT NOT NULL,
    score INT NOT NULL DEFAULT 0,
    total INT NOT NULL DEFAULT 0,
    answers TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (student_id, lesson_id)
  )`,
]);

// "999", "499.50", "₹1,200" → paise. Blank or 0 is free.
function priceFromForm(raw) {
  const text = String(raw ?? '').replace(/[₹,\s]/g, '');
  if (!text) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw kit.inputError('The price needs to be an amount in rupees, like 999 or 499.50.');
  const paise = Math.round(Number(text) * 100);
  if (paise && paise < 100) throw kit.inputError('A paid course needs to cost at least ₹1 — or leave the price at 0 for free.');
  if (paise > MAX_PRICE) throw kit.inputError(`Keep the price up to ${formatINR(MAX_PRICE)}.`);
  return paise;
}

function courseFields(body) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError('Give the course a name.');
  const cover = kit.cleanText(body.cover_url, 500);
  if (cover && !/^(https?:\/\/|\/uploads\/)\S+$/i.test(cover)) throw kit.inputError('The cover needs to be an upload or an https:// link.');
  // "What you'll learn" — one point per line.
  const outcomes = String(body.outcomes || '').split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim().slice(0, 160)).filter(Boolean).slice(0, MAX_OUTCOMES);
  const fields = {
    title,
    description: kit.cleanText(body.description, 2000),
    cover_url: cover,
    outcomes: outcomes.join('\n'),
    visible: body.visible ? 1 : 0,
    marketplace: body.marketplace ? 1 : 0,
  };
  // The new-course form only sends a name.
  if (body.price !== undefined) fields.price = priceFromForm(body.price);
  return fields;
}

const WITH_COUNTS = `SELECT c.*,
  (SELECT COUNT(*) FROM ${LESSONS} l WHERE l.course_id = c.id AND l.kind = 'lesson') AS lesson_count,
  (SELECT COUNT(*) FROM ${LESSONS} l WHERE l.course_id = c.id AND l.kind = 'quiz') AS quiz_count,
  (SELECT COUNT(*) FROM ${LESSONS} l WHERE l.course_id = c.id AND l.kind = 'file') AS file_count,
  (SELECT COUNT(*) FROM ${STUDENTS} s WHERE s.course_id = c.id) AS student_count
  FROM ${COURSES} c`;

function toCourse(row) {
  const price = Number(row.price) || 0;
  return {
    ...row,
    visible: !!row.visible,
    price,
    priceLabel: price ? formatINR(price) : 'Free',
    outcomesList: String(row.outcomes || '').split('\n').filter(Boolean),
    lesson_count: Number(row.lesson_count || 0),
    quiz_count: Number(row.quiz_count || 0),
    file_count: Number(row.file_count || 0),
    // "4 lessons · 2 quizzes · 1 download" for lists.
    contentLabel: [
      `${Number(row.lesson_count || 0)} lesson${Number(row.lesson_count) === 1 ? '' : 's'}`,
      Number(row.quiz_count) ? `${row.quiz_count} quiz${Number(row.quiz_count) === 1 ? '' : 'zes'}` : '',
      Number(row.file_count) ? `${row.file_count} download${Number(row.file_count) === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · '),
    student_count: Number(row.student_count || 0),
  };
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
  const [media] = await pool.query(
    `SELECT video_file, file_name FROM ${LESSONS} WHERE course_id = ? AND user_id = ? AND (video_file <> '' OR file_name <> '')`,
    [id, userId],
  );
  await pool.query(
    `DELETE p FROM ${PROGRESS} p JOIN ${STUDENTS} s ON s.id = p.student_id WHERE s.course_id = ? AND s.user_id = ?`,
    [id, userId],
  );
  await pool.query(
    `DELETE a FROM ${ATTEMPTS} a JOIN ${STUDENTS} s ON s.id = a.student_id WHERE s.course_id = ? AND s.user_id = ?`,
    [id, userId],
  );
  await pool.query(
    `DELETE d FROM ${DEVICES} d JOIN ${STUDENTS} s ON s.id = d.student_id WHERE s.course_id = ? AND s.user_id = ?`,
    [id, userId],
  );
  await pool.query(`DELETE FROM ${LESSONS} WHERE course_id = ? AND user_id = ?`, [id, userId]);
  await pool.query(`DELETE FROM ${MODULES} WHERE course_id = ? AND user_id = ?`, [id, userId]);
  await pool.query(`DELETE FROM ${STUDENTS} WHERE course_id = ? AND user_id = ?`, [id, userId]);
  await Promise.all(media.map((m) => Promise.all([removeVideo(m.video_file), removeFile(m.file_name)])));
}

// --- Curriculum: modules and their items -----------------------------------

// A course from before modules: each lesson's module *name* becomes a
// real module (one per name, in the order they first appear), once.
async function adoptModuleNames(courseId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, module FROM ${LESSONS} WHERE course_id = ? AND module <> '' AND module_id IS NULL ORDER BY position ASC, id ASC`,
    [courseId],
  );
  if (!rows.length) return;
  const made = new Map();
  for (const row of rows) {
    if (!made.has(row.module)) {
      const [[found]] = await pool.query(`SELECT id FROM ${MODULES} WHERE course_id = ? AND title = ? LIMIT 1`, [courseId, row.module]);
      if (found) made.set(row.module, found.id);
      else {
        const [[{ top }]] = await pool.query(`SELECT COALESCE(MAX(position), 0) AS top FROM ${MODULES} WHERE course_id = ?`, [courseId]);
        const [result] = await pool.query(`INSERT INTO ${MODULES} SET ?`, [{ course_id: courseId, user_id: row.user_id, title: row.module, position: top + 1 }]);
        made.set(row.module, result.insertId);
      }
    }
    await pool.query(`UPDATE ${LESSONS} SET module_id = ?, module = '' WHERE id = ?`, [made.get(row.module), row.id]);
  }
}

async function listModules(courseId) {
  await ensureTables();
  await adoptModuleNames(courseId);
  const [rows] = await pool.query(`SELECT * FROM ${MODULES} WHERE course_id = ? ORDER BY position ASC, id ASC`, [courseId]);
  return rows;
}

// A quiz's questions — [{ q, options: [..], correct: [indexes] }].
function quizQuestions(item) {
  if (!item || !item.quiz) return [];
  try {
    const list = JSON.parse(item.quiz);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

// Every item, in course order: those outside a module first, then module
// by module. `module` is its module's title (or ''), `questions` a quiz's.
async function listLessons(courseId) {
  await ensureTables();
  await adoptModuleNames(courseId);
  const [rows] = await pool.query(
    `SELECT l.*, m.title AS module_title FROM ${LESSONS} l LEFT JOIN ${MODULES} m ON m.id = l.module_id
     WHERE l.course_id = ? ORDER BY m.id IS NOT NULL, m.position ASC, m.id ASC, l.position ASC, l.id ASC`,
    [courseId],
  );
  return rows.map((r) => {
    const { module_title: moduleTitle, ...item } = r;
    return { ...item, kind: KINDS[item.kind] ? item.kind : 'lesson', module: moduleTitle || '', questions: quizQuestions(item) };
  });
}

// The outline: items outside a module (title '', id null — left out when
// there are none), then every module with its items — [{ id, title,
// lessons }], each item numbered in course order. Modules with no items
// are kept (the editor shows them; public pages skip them).
function groupModules(lessons, modules = []) {
  const numbered = lessons.map((l, i) => ({ ...l, number: i + 1 }));
  const loose = numbered.filter((l) => !l.module_id || !modules.some((m) => m.id === l.module_id));
  const groups = loose.length ? [{ id: null, title: '', lessons: loose }] : [];
  modules.forEach((m) => groups.push({ id: m.id, title: m.title, lessons: numbered.filter((l) => l.module_id === m.id) }));
  return groups;
}

// How many of each kind — { lesson, quiz, file, video }.
function countKinds(lessons) {
  const counts = { lesson: 0, quiz: 0, file: 0, video: 0 };
  lessons.forEach((l) => {
    counts[l.kind] += 1;
    if (l.kind === 'lesson' && (l.video_file || l.video_url)) counts.video += 1;
  });
  return counts;
}

async function ownModuleId(courseId, userId, raw) {
  const moduleId = Number(raw) || 0;
  if (!moduleId) return null;
  const [[row]] = await pool.query(`SELECT id FROM ${MODULES} WHERE id = ? AND course_id = ? AND user_id = ?`, [moduleId, courseId, userId]);
  if (!row) throw kit.inputError('That module doesn’t exist.');
  return row.id;
}

async function addModule(userId, courseId, body) {
  await ensureTables();
  const title = kit.cleanText(body.title, 120);
  if (!title) throw kit.inputError('Give the module a name.');
  const [[{ n, top }]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS top FROM ${MODULES} WHERE course_id = ? AND user_id = ?`,
    [courseId, userId],
  );
  if (n >= MAX_MODULES) throw kit.inputError(`A course can have up to ${MAX_MODULES} modules.`);
  const [result] = await pool.query(`INSERT INTO ${MODULES} SET ?`, [{ course_id: courseId, user_id: userId, title, position: top + 1 }]);
  return result.insertId;
}

async function renameModule(userId, courseId, moduleId, body) {
  const title = kit.cleanText(body.title, 120);
  if (!title) throw kit.inputError('Give the module a name.');
  await pool.query(`UPDATE ${MODULES} SET title = ? WHERE id = ? AND course_id = ? AND user_id = ?`, [title, moduleId, courseId, userId]);
}

// Deleting a module keeps its items — they move out of it, to the top.
async function deleteModule(userId, courseId, moduleId) {
  const [result] = await pool.query(`DELETE FROM ${MODULES} WHERE id = ? AND course_id = ? AND user_id = ?`, [moduleId, courseId, userId]);
  if (result.affectedRows) await pool.query(`UPDATE ${LESSONS} SET module_id = NULL WHERE module_id = ? AND course_id = ?`, [moduleId, courseId]);
}

// Swaps a module with its neighbour (dir -1 = up, 1 = down), renumbering 1..n.
async function moveModule(userId, courseId, moduleId, dir) {
  const modules = (await listModules(courseId)).filter((m) => m.user_id === userId);
  const i = modules.findIndex((m) => m.id === moduleId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= modules.length) return;
  [modules[i], modules[j]] = [modules[j], modules[i]];
  await Promise.all(modules.map((m, k) => pool.query(`UPDATE ${MODULES} SET position = ? WHERE id = ?`, [k + 1, m.id])));
}

// A quiz's questions from the editor: qq_<n> (the question), qo_<n>_<k>
// (its choices) and qc_<n>_<k> (ticked = a right answer). Blank questions
// are dropped; a question needs two choices and at least one right one.
function quizFromForm(body) {
  const questions = [];
  for (let n = 0; n < MAX_QUESTIONS; n += 1) {
    const q = kit.cleanText(body[`qq_${n}`], 500);
    const options = [];
    const correct = [];
    for (let k = 0; k < MAX_OPTIONS; k += 1) {
      const text = kit.cleanText(body[`qo_${n}_${k}`], 200);
      if (!text) continue;
      if (body[`qc_${n}_${k}`]) correct.push(options.length);
      options.push(text);
    }
    if (!q && !options.length) continue;
    const label = `Question ${questions.length + 1}`;
    if (!q) throw kit.inputError(`${label} has choices but no question.`);
    if (options.length < 2) throw kit.inputError(`${label} needs at least two choices.`);
    if (!correct.length) throw kit.inputError(`${label} needs a right answer — tick it.`);
    questions.push({ q, options, correct });
  }
  return questions;
}

// The fields an item's form sends, for its kind.
function lessonFields(body, kind) {
  const title = kit.cleanText(body.title, 200);
  if (!title) throw kit.inputError(`Give the ${KINDS[kind].toLowerCase()} a title.`);
  const fields = {
    title,
    body: kit.cleanText(body.body, 20000),
    preview: body.preview ? 1 : 0,
  };
  if (kind === 'lesson') {
    const video = kit.cleanText(body.video_url, 500);
    if (video && !/^https?:\/\/\S+\.\S+/i.test(video)) throw kit.inputError('The video link needs to start with https://');
    fields.video_url = video;
  }
  if (kind === 'quiz' && body.quiz_form) fields.quiz = JSON.stringify(quizFromForm(body));
  return fields;
}

async function getLesson(courseId, lessonId) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${LESSONS} WHERE id = ? AND course_id = ?`, [lessonId, courseId]);
  return row ? { ...row, questions: quizQuestions(row) } : null;
}

// An uploaded video (lib/courseMedia.js) replaces — or, with '', removes —
// the lesson's own. Returns the file it replaced, for deleting.
async function setLessonVideo(userId, courseId, lessonId, file) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT video_file FROM ${LESSONS} WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonId, courseId, userId]);
  if (!row) throw kit.inputError('That lesson doesn’t exist.');
  await pool.query(`UPDATE ${LESSONS} SET video_file = ? WHERE id = ?`, [file, lessonId]);
  return row.video_file;
}

// A download's file ({ name, label, size } from lib/courseMedia.js, or
// null to remove it). Returns the stored file it replaced, for deleting.
async function setLessonFile(userId, courseId, lessonId, file) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT file_name FROM ${LESSONS} WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonId, courseId, userId]);
  if (!row) throw kit.inputError('That download doesn’t exist.');
  await pool.query(`UPDATE ${LESSONS} SET file_name = ?, file_label = ?, file_size = ? WHERE id = ?`, [
    file ? file.name : '', file ? file.label : '', file ? file.size : 0, lessonId,
  ]);
  return row.file_name;
}

// A new item — kind, title and module from the "Add" form; the rest is
// filled in by editing it. Goes to the end of its module.
async function addLesson(userId, courseId, body) {
  await ensureTables();
  const kind = KINDS[body.kind] ? body.kind : 'lesson';
  const fields = lessonFields(body, kind);
  const moduleId = await ownModuleId(courseId, userId, body.module_id);
  const [[{ n, top }]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS top FROM ${LESSONS} WHERE course_id = ? AND user_id = ?`,
    [courseId, userId],
  );
  if (n >= MAX_LESSONS) throw kit.inputError(`A course can have up to ${MAX_LESSONS} lessons, quizzes and downloads.`);
  const [result] = await pool.query(`INSERT INTO ${LESSONS} SET ?`, [{
    ...fields, kind, module_id: moduleId, course_id: courseId, user_id: userId, position: top + 1,
  }]);
  return result.insertId;
}

async function updateLesson(userId, courseId, lessonId, body) {
  const item = await getLesson(courseId, lessonId);
  if (!item || item.user_id !== userId) throw kit.inputError('That item doesn’t exist.');
  const fields = lessonFields(body, KINDS[item.kind] ? item.kind : 'lesson');
  if (body.module_id !== undefined) {
    const moduleId = await ownModuleId(courseId, userId, body.module_id);
    if (moduleId !== item.module_id) {
      // Moved to another module: it goes to the end of that one.
      const [[{ top }]] = await pool.query(`SELECT COALESCE(MAX(position), 0) AS top FROM ${LESSONS} WHERE course_id = ?`, [courseId]);
      fields.module_id = moduleId;
      fields.position = top + 1;
    }
  }
  await pool.query(`UPDATE ${LESSONS} SET ? WHERE id = ? AND course_id = ? AND user_id = ?`, [fields, lessonId, courseId, userId]);
}

async function deleteLesson(userId, courseId, lessonId) {
  const [[row]] = await pool.query(`SELECT video_file, file_name FROM ${LESSONS} WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonId, courseId, userId]);
  if (!row) return;
  await pool.query(`DELETE FROM ${LESSONS} WHERE id = ? AND course_id = ? AND user_id = ?`, [lessonId, courseId, userId]);
  await pool.query(`DELETE FROM ${PROGRESS} WHERE lesson_id = ?`, [lessonId]);
  await pool.query(`DELETE FROM ${ATTEMPTS} WHERE lesson_id = ?`, [lessonId]);
  await removeVideo(row.video_file);
  await removeFile(row.file_name);
}

// Swaps an item with its neighbour in the same module (dir -1 = up, 1 =
// down), renumbering the whole course so positions stay 1..n.
async function moveLesson(userId, courseId, lessonId, dir) {
  const lessons = (await listLessons(courseId)).filter((l) => l.user_id === userId);
  const i = lessons.findIndex((l) => l.id === lessonId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lessons.length || (lessons[j].module_id || null) !== (lessons[i].module_id || null)) return;
  [lessons[i], lessons[j]] = [lessons[j], lessons[i]];
  await Promise.all(lessons.map((l, k) => pool.query(`UPDATE ${LESSONS} SET position = ? WHERE id = ?`, [k + 1, l.id])));
}

// --- Quizzes ---------------------------------------------------------------

// Grades a submission (a_<n>: the index picked, or several for a question
// with more than one right answer). A question counts when exactly its
// right choices were picked. → { score, total, picked: [[indexes], ..] }
function gradeQuiz(item, body) {
  const questions = item.questions || quizQuestions(item);
  let score = 0;
  const picked = questions.map((question, n) => {
    const raw = body[`a_${n}`];
    const chosen = [...new Set((Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map(Number).filter((k) => Number.isInteger(k) && k >= 0 && k < question.options.length))].sort();
    const right = [...question.correct].sort();
    if (chosen.length === right.length && chosen.every((k, x) => k === right[x])) score += 1;
    return chosen;
  });
  return { score, total: questions.length, picked };
}

// Saves a graded submission and marks the quiz complete.
async function saveQuizAttempt(student, item, result) {
  await ensureTables();
  await pool.query(`INSERT INTO ${ATTEMPTS} SET ?`, [{
    student_id: student.id, lesson_id: item.id, score: result.score, total: result.total, answers: JSON.stringify(result.picked),
  }]);
  await setLessonDone(student, item.id, true);
}

// The student's latest submission of a quiz — { score, total, picked, created_at } — or null.
async function lastQuizAttempt(studentId, lessonId) {
  await ensureTables();
  const [[row]] = await pool.query(
    `SELECT * FROM ${ATTEMPTS} WHERE student_id = ? AND lesson_id = ? ORDER BY id DESC LIMIT 1`,
    [studentId, lessonId],
  );
  if (!row) return null;
  let picked = [];
  try { picked = JSON.parse(row.answers || '[]'); } catch (err) { picked = []; }
  return { score: row.score, total: row.total, picked, created_at: row.created_at };
}

// Each student's best score per quiz in a course — Map(studentId → Map(lessonId → { score, total })).
async function quizScores(courseId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT a.student_id, a.lesson_id, MAX(a.score) AS score, MAX(a.total) AS total
     FROM ${ATTEMPTS} a JOIN ${LESSONS} l ON l.id = a.lesson_id WHERE l.course_id = ? GROUP BY a.student_id, a.lesson_id`,
    [courseId],
  );
  const out = new Map();
  rows.forEach((r) => {
    if (!out.has(r.student_id)) out.set(r.student_id, new Map());
    out.get(r.student_id).set(r.lesson_id, { score: Number(r.score), total: Number(r.total) });
  });
  return out;
}

// --- Students --------------------------------------------------------------

// status: 'active' — can open the lessons (a free course, or paid)
//         'pending' — a paid course's enrolment waiting for its order
//         (lib/orders.js) to be paid; markOrderPaid() → activateFromOrder().

// A paid course: the enrolment is held as pending with an order for the
// price (`fee` from lib/platform.js), and its link opens the payment step.
// An email that already has access never gets the link handed back —
// typing someone else's email mustn't open a course they paid for.
// Returns { token } or { active: true }.
async function startPaidEnrolment(course, person, fee) {
  await ensureTables();
  const [[existing]] = await pool.query(`SELECT * FROM ${STUDENTS} WHERE course_id = ? AND email = ?`, [course.id, person.email]);
  if (existing && existing.status === 'active') return { active: true };
  if (existing && existing.order_id) {
    const [[order]] = await pool.query('SELECT status FROM PDZ_orders WHERE id = ?', [existing.order_id]);
    if (order && order.status === 'pending') return { token: existing.token };
  }
  let studentId = existing && existing.id;
  let token = existing && existing.token;
  if (!existing) {
    token = kit.newToken();
    try {
      const [result] = await pool.query(`INSERT INTO ${STUDENTS} SET ?`, [{ course_id: course.id, user_id: course.user_id, ...person, token, status: 'pending' }]);
      studentId = result.insertId;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      return startPaidEnrolment(course, person, fee); // a double submit — use the row it made
    }
  }
  const line = { id: course.id, title: course.title, type: 'course', qty: 1, unit: course.price, amount: course.price, shipFee: 0 };
  const order = await createOrder(course.user_id, { id: null, title: course.title }, { ...person, address: null, note: '' }, {
    lines: [line], subtotal: course.price, discount: 0, total: course.price, coupon: null, shipping: 0,
  }, fee);
  await pool.query(`UPDATE ${STUDENTS} SET order_id = ?, name = ?, phone = ? WHERE id = ?`, [order.id, person.name, person.phone || '', studentId]);
  return { token };
}

// Called by lib/orders.js once a course's order is paid.
async function activateFromOrder(order) {
  await ensureTables();
  const [result] = await pool.query(
    `UPDATE ${STUDENTS} SET status = 'active' WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
    [order.id, order.user_id],
  );
  if (!result.affectedRows) return;
  const [[s]] = await pool.query(
    `SELECT s.*, c.title AS course_title FROM ${STUDENTS} s JOIN ${COURSES} c ON c.id = s.course_id WHERE s.order_id = ? AND s.user_id = ?`,
    [order.id, order.user_id],
  );
  await kit.addToAudience(s.user_id, { name: s.name, email: s.email, phone: s.phone }, {
    source: 'course', sourceId: s.course_id, sourceName: s.course_title, note: `Bought: ${s.course_title}`,
  });
}

// --- Progress --------------------------------------------------------------

async function completedLessons(studentId) {
  await ensureTables();
  const [rows] = await pool.query(`SELECT lesson_id FROM ${PROGRESS} WHERE student_id = ?`, [studentId]);
  return new Set(rows.map((r) => r.lesson_id));
}

async function setLessonDone(student, lessonId, done) {
  await ensureTables();
  if (done) {
    await pool.query(`INSERT IGNORE INTO ${PROGRESS} (student_id, lesson_id) VALUES (?, ?)`, [student.id, lessonId]);
  } else {
    await pool.query(`DELETE FROM ${PROGRESS} WHERE student_id = ? AND lesson_id = ?`, [student.id, lessonId]);
  }
}

// --- Devices: one student's link, on their own browsers ---------------------
//
// A student's link is their key, so the first thing a sharer does is send
// it on. Each browser that opens it carries a random device id (a cookie,
// lib/appStorefront.js); the first MAX_DEVICES become the student's, and
// any other is refused — counted in blocked_tries so the creator can see a
// link going round — until the creator resets them (Students tab). Videos
// and downloads check the device too, so a signed link copied out of the
// page doesn't play elsewhere.

const deviceHash = (raw) => require('crypto').createHash('sha256').update(String(raw)).digest('hex');

// "Chrome on Windows" from a User-Agent, for the creator's list.
function deviceLabel(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'another device';
  return `${browser} on ${os}`;
}

// → true when this browser may open the student's course (registering it
// while there's room); false when they're already on MAX_DEVICES others.
async function lockDevice(student, rawDevice, { ua, ip } = {}) {
  await ensureTables();
  const device = deviceHash(rawDevice);
  const [[known]] = await pool.query(`SELECT id FROM ${DEVICES} WHERE student_id = ? AND device = ?`, [student.id, device]);
  if (known) {
    await pool.query(`UPDATE ${DEVICES} SET last_seen = NOW(), ip = ? WHERE id = ?`, [String(ip || '').slice(0, 64), known.id]);
    return true;
  }
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${DEVICES} WHERE student_id = ?`, [student.id]);
  if (n >= MAX_DEVICES) {
    await pool.query(`UPDATE ${STUDENTS} SET blocked_tries = blocked_tries + 1 WHERE id = ?`, [student.id]);
    return false;
  }
  await pool.query(`INSERT IGNORE INTO ${DEVICES} SET ?`, [{
    student_id: student.id, device, label: deviceLabel(ua), ip: String(ip || '').slice(0, 64),
  }]);
  return true;
}

// Whether this browser is one of the student's (for videos and downloads).
async function isStudentDevice(studentId, rawDevice) {
  if (!rawDevice) return false;
  await ensureTables();
  const [[row]] = await pool.query(`SELECT id FROM ${DEVICES} WHERE student_id = ? AND device = ?`, [studentId, deviceHash(rawDevice)]);
  return !!row;
}

// One video at a time: `start` (pressed play) makes this device the one
// playing; `tick` (every ~20 s while playing) keeps it so. → false when
// another of the student's devices started playing after this one — this
// one should stop.
async function claimPlayback(student, rawDevice, start) {
  await ensureTables();
  const device = deviceHash(rawDevice);
  const [[me]] = await pool.query(`SELECT id, play_started FROM ${DEVICES} WHERE student_id = ? AND device = ?`, [student.id, device]);
  if (!me) return false;
  if (start) {
    await pool.query(`UPDATE ${DEVICES} SET play_started = NOW(3), last_play = NOW() WHERE id = ?`, [me.id]);
    return true;
  }
  const [[newer]] = await pool.query(
    `SELECT id FROM ${DEVICES} WHERE student_id = ? AND id <> ? AND last_play > NOW() - INTERVAL ? SECOND AND play_started > ?`,
    [student.id, me.id, PLAY_WINDOW_SECONDS, me.play_started || new Date(0)],
  );
  if (newer) return false;
  await pool.query(`UPDATE ${DEVICES} SET last_play = NOW() WHERE id = ?`, [me.id]);
  return true;
}

// Each student's devices, for the Students tab — Map(studentId → [{ label, ip, created_at, last_seen }]).
async function listDevices(courseId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT d.student_id, d.label, d.ip, d.created_at, d.last_seen FROM ${DEVICES} d
     JOIN ${STUDENTS} s ON s.id = d.student_id WHERE s.course_id = ? ORDER BY d.created_at ASC`,
    [courseId],
  );
  const out = new Map();
  rows.forEach((r) => {
    if (!out.has(r.student_id)) out.set(r.student_id, []);
    out.get(r.student_id).push(r);
  });
  return out;
}

// Frees a student's device slots (a new phone, cleared cookies), and clears their blocked count.
async function resetDevices(userId, courseId, studentId) {
  await ensureTables();
  const [[student]] = await pool.query(`SELECT id FROM ${STUDENTS} WHERE id = ? AND course_id = ? AND user_id = ?`, [studentId, courseId, userId]);
  if (!student) return;
  await pool.query(`DELETE FROM ${DEVICES} WHERE student_id = ?`, [student.id]);
  await pool.query(`UPDATE ${STUDENTS} SET blocked_tries = 0 WHERE id = ?`, [student.id]);
}

// Enrols someone in a free course (or finds their enrolment) and returns their access token.
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

async function getStudentById(courseId, id) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${STUDENTS} WHERE course_id = ? AND id = ?`, [courseId, id]);
  return row || null;
}

async function getStudentByToken(courseId, token) {
  await ensureTables();
  const [[row]] = await pool.query(`SELECT * FROM ${STUDENTS} WHERE course_id = ? AND token = ?`, [courseId, token]);
  return row || null;
}

async function listStudents(userId, courseId) {
  await ensureTables();
  const [rows] = await pool.query(
    `SELECT s.id, s.name, s.email, s.phone, s.token, s.status, s.created_at, s.blocked_tries,
            (SELECT COUNT(*) FROM ${PROGRESS} p JOIN ${LESSONS} l ON l.id = p.lesson_id WHERE p.student_id = s.id AND l.course_id = s.course_id) AS done
     FROM ${STUDENTS} s WHERE s.course_id = ? AND s.user_id = ? ORDER BY s.created_at DESC`,
    [courseId, userId],
  );
  return rows.map((r) => ({ ...r, done: Number(r.done) || 0 }));
}

async function removeStudent(userId, courseId, id) {
  await ensureTables();
  const [result] = await pool.query(`DELETE FROM ${STUDENTS} WHERE id = ? AND course_id = ? AND user_id = ?`, [id, courseId, userId]);
  if (result.affectedRows) {
    await pool.query(`DELETE FROM ${PROGRESS} WHERE student_id = ?`, [id]);
    await pool.query(`DELETE FROM ${DEVICES} WHERE student_id = ?`, [id]);
    await pool.query(`DELETE FROM ${ATTEMPTS} WHERE student_id = ?`, [id]);
  }
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
  KINDS, MAX_QUESTIONS, MAX_OPTIONS,
  listLessons, getLesson, addLesson, updateLesson, deleteLesson, moveLesson, setLessonVideo, setLessonFile, groupModules, countKinds,
  listModules, addModule, renameModule, deleteModule, moveModule,
  gradeQuiz, saveQuizAttempt, lastQuizAttempt, quizScores,
  enrol, startPaidEnrolment, activateFromOrder, getStudentById, getStudentByToken, listStudents, removeStudent, videoEmbedUrl,
  completedLessons, setLessonDone,
  MAX_DEVICES, lockDevice, isStudentDevice, claimPlayback, listDevices, resetDevices,
};
