// Course lesson videos — kept out of public/ so there is no URL that
// simply serves the file. A student's player gets a short-lived link
// signed for that student and lesson (videoToken), and the store serves
// the file only for a valid one (lib/appStorefront.js → /course/:slug/
// video/:lessonId).
//
// This makes casually saving or sharing a video hard: no download button,
// no permanent URL, a link that dies in an hour and names whose it was.
// It is not DRM — someone determined can still capture what plays on
// their screen. The player's moving watermark (public/js/course-player.js)
// is what makes such a copy traceable to the student. Real DRM (Widevine
// / FairPlay) needs a video host like VdoCipher, Gumlet or Mux.
//
// Uploads stream straight to disk (no buffering a 1 GB file in memory):
// the browser sends the file as the raw request body with its own
// Content-Type, the first bytes are checked to be an MP4 / WebM, and the
// filename is always generated here.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'private', 'course-videos');
const MB = 1024 * 1024;
const MAX_VIDEO_BYTES = 2048 * MB;
const TYPES = { 'video/mp4': '.mp4', 'video/webm': '.webm' };
const LINK_SECONDS = 60 * 60;

function secret() {
  return process.env.SESSION_SECRET || 'pagezaper-dev-secret-change-in-production';
}

function mediaError(message, status = 400) {
  const err = new Error(message);
  err.code = 'INVALID_UPLOAD';
  err.status = status;
  return err;
}

function looksLikeVideo(mime, head) {
  if (mime === 'video/mp4') return head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
  if (mime === 'video/webm') return head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

// Streams the request body to disk. Resolves to the stored name
// ('user-<id>/<file>'), which is what the lesson keeps.
async function saveVideoFromRequest(req, userId) {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[mime];
  if (!ext) throw mediaError('Upload an MP4 or WebM video.');
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_VIDEO_BYTES) throw mediaError(`That video is too big — keep it under ${MAX_VIDEO_BYTES / 1024 / MB} GB.`, 413);

  const dirName = `user-${Number(userId)}`;
  await fsp.mkdir(path.join(ROOT, dirName), { recursive: true });
  const name = `${dirName}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`;
  const full = path.join(ROOT, name);
  const temp = `${full}.part`;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(temp);
    let size = 0;
    let head = Buffer.alloc(0);
    let checked = false;
    const fail = (err) => {
      req.unpipe(out);
      out.destroy();
      req.resume();
      fsp.rm(temp, { force: true }).finally(() => reject(err));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) return fail(mediaError(`That video is too big — keep it under ${MAX_VIDEO_BYTES / 1024 / MB} GB.`, 413));
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 12) {
          checked = true;
          if (!looksLikeVideo(mime, head)) return fail(mediaError('That file doesn’t look like an MP4 or WebM video.'));
        }
      }
      return undefined;
    });
    req.on('aborted', () => fail(mediaError('The upload was cut off. Please try again.')));
    out.on('error', fail);
    out.on('finish', () => {
      if (!size) return fail(mediaError('That file is empty.'));
      if (!checked && !looksLikeVideo(mime, head)) return fail(mediaError('That file doesn’t look like an MP4 or WebM video.'));
      return resolve();
    });
    req.pipe(out);
  });
  await fsp.rename(temp, full);
  return name;
}

// The stored name → its path on disk, or null if it isn't one of ours.
function videoPath(name) {
  if (!/^user-\d+\/[\w.-]+\.(mp4|webm)$/.test(String(name || ''))) return null;
  return path.join(ROOT, name);
}

async function removeVideo(name) {
  const full = videoPath(name);
  if (full) await fsp.rm(full, { force: true }).catch((err) => console.error('Removing course video failed:', err));
}

// `what` keeps a video's key from opening a download, and back.
function sign(lessonId, who, exp, what) {
  return crypto.createHmac('sha256', secret()).update(`course-${what}.${lessonId}.${who}.${exp}`).digest('base64url');
}

function linkToken(lessonId, who, what) {
  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return `${who}.${exp}.${sign(lessonId, who, exp, what)}`;
}

function checkLinkToken(lessonId, key, what) {
  const m = String(key || '').match(/^(\d+)\.(\d+)\.([\w-]+)$/);
  if (!m) return null;
  const [, who, exp, sig] = m;
  if (Number(exp) < Date.now() / 1000) return null;
  const expected = sign(lessonId, who, exp, what);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { who: Number(who) };
}

// A link key for one lesson's video. `who` is the student's id, or 0 for a
// free preview lesson anyone can watch.
const videoToken = (lessonId, who) => linkToken(lessonId, who, 'video');
// → { who } for a valid, unexpired key for this lesson, else null.
const checkVideoToken = (lessonId, key) => checkLinkToken(lessonId, key, 'video');
// The same for a download (lib/appStorefront.js → /course/:slug/file/:id).
const fileToken = (lessonId, who) => linkToken(lessonId, who, 'file');
const checkFileToken = (lessonId, key) => checkLinkToken(lessonId, key, 'file');

// Sends the file (Range requests included, so seeking works) with headers
// that keep it out of caches and inline. A request for the URL as a page
// of its own (pasted into the address bar) is refused — only the player's
// own <video> fetches it. Download managers can fake that header; this
// just stops the casual "open in new tab → save".
function sendVideo(req, res, name) {
  const full = videoPath(name);
  if (!full) return res.status(404).end();
  if (req.get('sec-fetch-dest') === 'document') {
    return res.status(403).type('text').send('This video can only be watched in the course.');
  }
  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  return res.sendFile(full, { acceptRanges: true, cacheControl: false, lastModified: false, etag: false }, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode === 404 ? 404 : 500).end();
  });
}

// --- Downloads ---------------------------------------------------------------
// A course's downloadable files (PDFs, worksheets, slides…), kept beside
// the videos and sent only to an enrolled student — or anyone, for a free
// preview — through a signed link that dies in an hour. Unlike a video, a
// download is meant to be saved, so it's sent as an attachment under the
// name it was uploaded with (X-File-Name, URI-encoded).

const FILE_ROOT = path.join(__dirname, '..', 'private', 'course-files');
const MAX_FILE_BYTES = 500 * MB;
// Extension → how its first bytes start (null: plain text, just no NULs).
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const FILE_TYPES = {
  pdf: [0x25, 0x50, 0x44, 0x46], zip: ZIP, docx: ZIP, xlsx: ZIP, pptx: ZIP, epub: ZIP,
  png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff],
  mp3: 'mp3', txt: null, csv: null,
};
const FILE_ACCEPT = Object.keys(FILE_TYPES).map((e) => `.${e}`).join(',');

function looksLikeFile(ext, head) {
  const sig = FILE_TYPES[ext];
  if (sig === null) return !head.includes(0);
  if (sig === 'mp3') return head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  return head.length >= sig.length && sig.every((b, i) => head[i] === b);
}

// Streams the request body to disk. → { name: 'user-<id>/<file>', label: the
// original file name, size }.
async function saveFileFromRequest(req, userId) {
  let label = '';
  try { label = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch (err) { label = ''; }
  label = label.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 200);
  const ext = (label.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (!label || !ext || !(ext.toLowerCase() in FILE_TYPES)) {
    throw mediaError(`Upload a ${Object.keys(FILE_TYPES).filter((e) => e !== 'jpeg').join(', ').toUpperCase()} file.`);
  }
  const type = ext.toLowerCase();
  const tooBig = () => mediaError(`That file is too big — keep it under ${MAX_FILE_BYTES / MB} MB.`, 413);
  if (Number(req.headers['content-length']) > MAX_FILE_BYTES) throw tooBig();

  const dirName = `user-${Number(userId)}`;
  await fsp.mkdir(path.join(FILE_ROOT, dirName), { recursive: true });
  const name = `${dirName}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}.${type}`;
  const full = path.join(FILE_ROOT, name);
  const temp = `${full}.part`;
  let size = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(temp);
    let head = Buffer.alloc(0);
    let checked = false;
    const fail = (err) => {
      req.unpipe(out);
      out.destroy();
      req.resume();
      fsp.rm(temp, { force: true }).finally(() => reject(err));
    };
    const wrongType = () => mediaError(`That file doesn’t look like a ${type.toUpperCase()}.`);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return fail(tooBig());
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 512) {
          checked = true;
          if (!looksLikeFile(type, head.subarray(0, 512))) return fail(wrongType());
        }
      }
      return undefined;
    });
    req.on('aborted', () => fail(mediaError('The upload was cut off. Please try again.')));
    out.on('error', fail);
    out.on('finish', () => {
      if (!size) return fail(mediaError('That file is empty.'));
      if (!checked && !looksLikeFile(type, head)) return fail(wrongType());
      return resolve();
    });
    req.pipe(out);
  });
  await fsp.rename(temp, full);
  return { name, label, size };
}

function filePath(name) {
  if (!/^user-\d+\/[\w.-]+\.[a-z0-9]{2,5}$/.test(String(name || ''))) return null;
  return path.join(FILE_ROOT, name);
}

async function removeFile(name) {
  const full = filePath(name);
  if (full) await fsp.rm(full, { force: true }).catch((err) => console.error('Removing course file failed:', err));
}

// Sends a download as an attachment, named as it was uploaded.
function sendCourseFile(res, name, label) {
  const full = filePath(name);
  if (!full) return res.status(404).end();
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.download(full, label || path.basename(full), { cacheControl: false, lastModified: false, etag: false }, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode === 404 ? 404 : 500).end();
  });
}

// "2.4 MB" for the outline and the download button.
function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

module.exports = {
  MAX_VIDEO_BYTES,
  saveVideoFromRequest,
  removeVideo,
  videoToken,
  checkVideoToken,
  sendVideo,
  MAX_FILE_BYTES,
  FILE_ACCEPT,
  saveFileFromRequest,
  removeFile,
  fileToken,
  checkFileToken,
  sendCourseFile,
  sizeLabel,
};
