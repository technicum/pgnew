// Apps — the parts of the dashboard a creator switches on from "Explore
// apps" (/dashboard/apps). The Store is built in and always on; everything
// else is an app they add, which puts it in the sidebar and opens its
// dashboard routes. Removing an app only takes it out of the dashboard:
// pages it already published stay live, and adding it back brings
// everything back as it was.
//
// Installed apps are one row per creator (PDZ_user_apps). A creator with
// no row yet — everyone from before apps existed — starts with the apps
// they've already used, so nobody's existing pages disappear.
const pool = require('./db');

const TABLE = 'PDZ_user_apps';

// The catalog. `routes` are the dashboard paths that need the app;
// `nav` the sidebar entries it adds (an app can bring more than one).
const APPS = [
  {
    id: 'store',
    name: 'Store',
    core: true,
    tagline: 'Your link-in-bio storefront',
    description: 'Your page at your own link — profile, links, videos and everything you sell, in one place.',
    features: ['Your own link to share anywhere', 'Links, videos and socials', 'Design and theme controls'],
    color: '#1261ef',
    icon: '<path d="M3 9h18l-1.5-5h-15z"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
    href: '/dashboard/builder',
    routes: [],
    nav: [],
  },
  {
    id: 'payment-pages',
    name: 'Payment pages',
    tagline: 'Sell anything with one checkout link',
    description: 'Sell digital downloads, physical products or take “buy me a coffee” support — with coupons, orders, customer accounts and abandoned-cart tracking.',
    features: ['Single product, multi-product or coffee pages', 'Coupons and order management', 'Customers and abandoned carts'],
    color: '#0e8a5f',
    icon: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    href: '/dashboard/payment-pages',
    routes: ['/dashboard/payment-pages', '/dashboard/coupons', '/dashboard/orders'],
    nav: [
      { href: '/dashboard/payment-pages', label: 'Payment pages', icon: '<rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path><path d="M6 15h4"></path>' },
      { href: '/dashboard/coupons', label: 'Coupons', icon: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path><path d="M13 5v2"></path><path d="M13 17v2"></path><path d="M13 11v2"></path>' },
      { href: '/dashboard/orders', label: 'Orders', icon: '<path d="M16 10a4 4 0 0 1-8 0"></path><path d="M3.103 6.034h17.794"></path><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"></path>' },
    ],
  },
  {
    id: 'lead-magnets',
    name: 'Lead magnets',
    tagline: 'Grow your list with free downloads',
    description: 'Give away a guide, checklist or template in exchange for an email — every signup lands in your Audience.',
    features: ['Signup pages with your own questions', 'Cover image, video and colours', 'Signups saved to Audience'],
    color: '#7048e8',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v4"/><path d="M12 15h.01"/>',
    href: '/dashboard/lead-magnets',
    routes: ['/dashboard/lead-magnets'],
    nav: [
      { href: '/dashboard/lead-magnets', label: 'Lead magnets', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M12 8v4"></path><path d="M12 15h.01"></path>' },
    ],
  },
  {
    id: 'bookings',
    name: 'Bookings',
    tagline: 'Let people book time with you',
    description: 'Calls, consultations and coaching sessions — set your weekly hours and people pick an open slot.',
    features: ['Services with their own length and hours', 'Open slots shown automatically', 'Bookings saved to Audience'],
    color: '#e8590c',
    icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    href: '/dashboard/bookings',
    routes: ['/dashboard/bookings'],
    nav: [
      { href: '/dashboard/bookings', label: 'Bookings', icon: '<rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path><path d="m9 16 2 2 4-4"></path>' },
    ],
  },
  {
    id: 'events',
    name: 'Events',
    tagline: 'Workshops, webinars and meetups',
    description: 'Put an event online or at a venue, cap the seats and take RSVPs — online join links go only to people who register.',
    features: ['Online or in-person', 'Seat limits and RSVP list', 'Attendees saved to Audience'],
    color: '#c2255c',
    icon: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
    href: '/dashboard/events',
    routes: ['/dashboard/events'],
    nav: [
      { href: '/dashboard/events', label: 'Events', icon: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path><path d="M13 5v2"></path><path d="M13 17v2"></path><path d="M13 11v2"></path>' },
    ],
  },
  {
    id: 'courses',
    name: 'Courses',
    tagline: 'Teach in lessons, at their pace',
    description: 'Build a course from text and video lessons. Students enrol with their email and get their own link to the lessons.',
    features: ['Text and YouTube / Vimeo lessons', 'Reorder lessons any time', 'Students saved to Audience'],
    color: '#0c8599',
    icon: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    href: '/dashboard/courses',
    routes: ['/dashboard/courses'],
    nav: [
      { href: '/dashboard/courses', label: 'Courses', icon: '<path d="M12 7v14"></path><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path>' },
    ],
  },
];
const APP_BY_ID = new Map(APPS.map((a) => [a.id, a]));
const ADDABLE = APPS.filter((a) => !a.core).map((a) => a.id);

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        user_id INT NOT NULL PRIMARY KEY,
        apps VARCHAR(500) NOT NULL DEFAULT '[]',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

async function countRows(table, userId) {
  try {
    const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [userId]);
    return Number(row.n);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return 0;
    throw err;
  }
}

async function saveApps(userId, ids) {
  await pool.query(
    `INSERT INTO ${TABLE} (user_id, apps) VALUES (?, ?) ON DUPLICATE KEY UPDATE apps = VALUES(apps)`,
    [userId, JSON.stringify(ids)],
  );
}

// The creator's added apps (ids, catalog order). Core apps aren't listed.
async function installedApps(userId) {
  await ensureTable();
  const [[row]] = await pool.query(`SELECT apps FROM ${TABLE} WHERE user_id = ? LIMIT 1`, [userId]);
  if (row) {
    let ids = [];
    try { ids = JSON.parse(row.apps); } catch (err) { ids = []; }
    return ADDABLE.filter((id) => ids.includes(id));
  }
  // First visit since apps existed: start with what they already use.
  const [pages, magnets] = await Promise.all([countRows('PDZ_payment_pages', userId), countRows('PDZ_lead_magnets', userId)]);
  const ids = [pages && 'payment-pages', magnets && 'lead-magnets'].filter(Boolean);
  await saveApps(userId, ids);
  return ids;
}

async function setAppInstalled(userId, id, installed) {
  if (!ADDABLE.includes(id)) {
    const err = new Error('That app doesn’t exist.');
    err.code = 'UNKNOWN_APP';
    throw err;
  }
  const current = await installedApps(userId);
  const next = installed ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  await saveApps(userId, ADDABLE.filter((x) => next.includes(x)));
  return next;
}

// The app a dashboard path belongs to, or null for core pages.
function appForPath(path) {
  return APPS.find((a) => a.routes.some((r) => path === r || path.startsWith(`${r}/`))) || null;
}

module.exports = { APPS, APP_BY_ID, installedApps, setAppInstalled, appForPath };
