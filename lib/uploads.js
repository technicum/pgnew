// Merchant uploads — for now just a lead magnet's cover image or video.
// Files land in public/uploads/user-<id>/ and are served by server.js's
// existing express.static(public/); public/uploads/ is gitignored, it's
// runtime data that lives on each machine's own disk.
//
// The browser sends the file itself as the request body (Content-Type set
// to the file's type), read with express.raw — no multipart parser
// dependency needed for one file at a time. The saved filename is always
// generated here, never taken from the visitor, and the first bytes are
// checked against the claimed type, so a renamed .html can't come back
// out of /uploads as a page.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads');

const MB = 1024 * 1024;
// SVG is left out on purpose — it can carry script and would be served
// from our own origin.
const UPLOAD_TYPES = {
  'image/jpeg': { ext: '.jpg', maxBytes: 5 * MB },
  'image/png': { ext: '.png', maxBytes: 5 * MB },
  'image/webp': { ext: '.webp', maxBytes: 5 * MB },
  'image/gif': { ext: '.gif', maxBytes: 5 * MB },
  'video/mp4': { ext: '.mp4', maxBytes: 30 * MB },
  'video/webm': { ext: '.webm', maxBytes: 30 * MB },
};
const MAX_UPLOAD_BYTES = 30 * MB;

// Magic numbers for each allowed type.
function looksLike(mime, buf) {
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  switch (mime) {
    case 'image/jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png': return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif': return ascii(0, 4) === 'GIF8';
    case 'image/webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/mp4': return ascii(4, 8) === 'ftyp';
    case 'video/webm': return buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default: return false;
  }
}

function uploadError(message) {
  const err = new Error(message);
  err.code = 'INVALID_UPLOAD';
  return err;
}

// Returns the public URL (/uploads/user-<id>/<file>) of the saved file.
async function saveUpload(userId, mime, buf) {
  const type = UPLOAD_TYPES[mime];
  if (!type || !Buffer.isBuffer(buf) || !buf.length) {
    throw uploadError('Upload a JPG, PNG, WebP or GIF image, or an MP4 or WebM video.');
  }
  if (buf.length > type.maxBytes) {
    throw uploadError(`That file is too big — keep ${mime.startsWith('video/') ? 'videos' : 'images'} under ${type.maxBytes / MB} MB.`);
  }
  if (!looksLike(mime, buf)) {
    throw uploadError('That file doesn’t look like the image or video it claims to be.');
  }
  const dirName = `user-${Number(userId)}`;
  const dir = path.join(UPLOAD_ROOT, dirName);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${type.ext}`;
  await fs.writeFile(path.join(dir, filename), buf);
  return `/uploads/${dirName}/${filename}`;
}

module.exports = { saveUpload, UPLOAD_TYPES, MAX_UPLOAD_BYTES };
