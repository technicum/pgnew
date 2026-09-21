// Bulk lead import (Leads only, not Customers — see routes/platform.js's
// POST /dashboard/crm/leads/import) from an uploaded .xlsx/.xls/.csv file.
// The file can come from the merchant's own computer, or be fetched
// client-side from Google Drive (see public/js/crm-lead-import.js) and
// handed to this same endpoint as an ordinary file upload — this module
// never needs to know which path a file arrived by.
//
// Deliberately server-side-Google-credential-free: the Google Drive option
// uses Google's own Picker + OAuth (client-side, public Client ID/API key —
// see .env.example) to download the file's bytes straight to the browser,
// which then uploads it here exactly like a local file. No Drive API calls
// ever happen on this server.
const multer = require('multer');
const XLSX = require('xlsx');
const { sanitizeTags } = require('./contacts');

const MAX_ROWS = 2000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB comfortably covers a few thousand rows

// Column headers we recognize, case/space-insensitive, mapped to the
// contact field they fill — different tools (Sheets, Excel, a CRM export)
// spell these differently.
const HEADER_ALIASES = {
  name: 'name',
  'full name': 'name',
  'contact name': 'name',
  email: 'email',
  'email address': 'email',
  'e-mail': 'email',
  phone: 'phone',
  'phone number': 'phone',
  mobile: 'phone',
  tags: 'tags',
  labels: 'tags',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

// Parses an uploaded file buffer into { rows, errors }. rows are
// { name, email, phone, tags } ready to insert; errors are human-readable,
// referencing spreadsheet row numbers (counting the header row, so row 2 is
// the first data row — matching what the merchant actually sees in Excel).
function parseLeadFile(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    throw new Error('Could not read that file — please upload a .xlsx, .xls or .csv file.');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('That file has no sheet to import.');

  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!grid.length) throw new Error('That file is empty.');

  const columnFor = {}; // field -> column index, first match wins
  grid[0].map(normalizeHeader).forEach((h, i) => {
    const field = HEADER_ALIASES[h];
    if (field && !(field in columnFor)) columnFor[field] = i;
  });
  if (!('name' in columnFor) || !('email' in columnFor)) {
    throw new Error('The file needs a header row with at least a "Name" and an "Email" column.');
  }

  const rows = [];
  const errors = [];
  const totalDataRows = grid.length - 1;
  for (let i = 1; i < grid.length && rows.length < MAX_ROWS; i++) {
    const line = grid[i];
    if (!line || !line.some((cell) => String(cell || '').trim())) continue; // skip blank rows

    const name = String(line[columnFor.name] || '').trim().slice(0, 255);
    const email = String(line[columnFor.email] || '').trim().toLowerCase().slice(0, 255);
    const phone = 'phone' in columnFor ? String(line[columnFor.phone] || '').trim().slice(0, 50) : '';
    const tagsRaw = 'tags' in columnFor ? String(line[columnFor.tags] || '') : '';

    if (!name || !email) {
      errors.push(`Row ${i + 1}: needs both a name and an email.`);
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push(`Row ${i + 1}: "${email}" doesn't look like a valid email.`);
      continue;
    }
    rows.push({ name, email, phone: phone || null, tags: sanitizeTags(tagsRaw) });
  }

  if (totalDataRows > MAX_ROWS) {
    errors.push(`Only the first ${MAX_ROWS} rows were processed.`);
  }

  return { rows, errors };
}

// Mounted as `upload.single('file')` by the route. Memory storage — the
// file only ever needs to live long enough to be parsed above, never
// written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

module.exports = { parseLeadFile, upload };
