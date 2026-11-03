// The PageZaper Pay WordPress plugin as a .zip, for the download on
// /woocommerce (server.js). Built in memory from wordpress/pagezaper-pay the
// first time it's asked for, so the download is always the plugin in this
// checkout — no build step, nothing to forget. Every file sits under
// pagezaper-pay/, which is what WordPress's "Upload Plugin" expects.
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'wordpress', 'pagezaper-pay');
const FOLDER = 'pagezaper-pay';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function listFiles(dir, base = '') {
  const out = [];
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// DOS date/time for the zip headers.
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function buildZip() {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of await listFiles(ROOT)) {
    const full = path.join(ROOT, ...rel.split('/'));
    const data = await fs.readFile(full);
    const { time, date } = dosTime((await fs.stat(full)).mtime);
    const name = Buffer.from(`${FOLDER}/${rel}`, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// The plugin's version, from its header.
async function readVersion() {
  const main = await fs.readFile(path.join(ROOT, 'pagezaper-pay.php'), 'utf8');
  const m = /^\s*\*\s*Version:\s*([\w.-]+)/m.exec(main);
  return m ? m[1] : '';
}

let cached = null;
// { zip: Buffer, version, filename }
function pluginZip() {
  if (!cached) {
    cached = Promise.all([buildZip(), readVersion()])
      .then(([zip, version]) => ({ zip, version, filename: `pagezaper-pay${version ? `-${version}` : ''}.zip` }))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

module.exports = { pluginZip };
