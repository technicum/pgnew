// The Overview page's data. An account with no sale yet sees a roadmap, not
// metrics: three steps worked out from what it has actually done, unfinished
// ones first. The first sale or booking retires the roadmap for good and the
// stats, chart and recent orders take over.
const { normalizeStoreSettings } = require('./storeSettings');
const { listBlocks } = require('./blocks');
const { listServices, countConfirmed } = require('./bookings');
const { listCourses } = require('./courses');
const { listEvents } = require('./events');
const { listPaymentPages, formatINR } = require('./paymentPages');
const { overviewStats } = require('./orders');
const { APPS } = require('./apps');

// Store blocks that sell something. A 'booking' block only opens /book, so
// the services behind it are what count.
const SELLING_BLOCKS = new Set(['course', 'download', 'membership', 'event', 'tip']);

const listPhrase = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const paiseLabel = (paise) => (paise ? formatINR(paise) : 'Free');

// Everything live on the store, as { title, price }.
async function liveProducts(userId) {
  const [blocks, services, courses, events, pages] = await Promise.all([
    listBlocks(userId), listServices(userId), listCourses(userId), listEvents(userId), listPaymentPages(userId),
  ]);
  return [
    ...services.filter((s) => s.visible).map((s) => ({ title: s.title, price: s.priceLabel })),
    ...blocks.filter((b) => b.visible && SELLING_BLOCKS.has(b.type)).map((b) => ({ title: b.title, price: b.price })),
    ...courses.filter((c) => c.visible).map((c) => ({ title: c.title, price: paiseLabel(c.price) })),
    ...events.filter((e) => e.visible).map((e) => ({ title: e.title, price: paiseLabel(e.price) })),
    ...pages.filter((p) => p.visible).map((p) => ({ title: p.title, price: '' })),
  ];
}

function setupSteps(account, products, host) {
  const settings = normalizeStoreSettings(account.store_settings);
  const [first] = products;
  const more = products.length > 1 ? ` and ${products.length - 1} more` : '';
  const added = [
    settings.photo && 'photo',
    account.bio && 'bio',
    settings.contactType !== 'none' && 'contact button',
  ].filter(Boolean);
  return [
    {
      title: 'Launch your store',
      done: added.length > 0,
      note: added.length ? `${capitalize(listPhrase(added))} added — the only link-in-bio you’ll need.` : 'Add your photo, bio and contact button.',
      action: { label: 'Set up store', href: '/dashboard/builder' },
    },
    {
      title: 'Create a product',
      done: products.length > 0,
      note: first ? `${first.title}${first.price ? `, ${first.price}` : ''}${more} — live.` : 'Sell a service, course, download or membership.',
      action: { label: 'Create', href: '/dashboard/builder' },
    },
    {
      title: 'Share your link',
      done: !!account.link_shared_at,
      note: `${host} — put it in your Instagram bio.`,
      copy: true,
    },
  ];
}

// account: the full PDZ_users row. Returns { setup, stats } — setup is null
// once there's a sale or booking; stats are always filled in.
async function overview(account, storeUrl) {
  const host = storeUrl.replace(/^https?:\/\//, '');
  const [products, stats, bookings] = await Promise.all([
    liveProducts(account.id), overviewStats(account.id), countConfirmed(account.id),
  ]);
  const summary = { ...stats, productsLive: products.length };
  if (stats.sales > 0 || bookings > 0) return { setup: null, stats: summary };

  const steps = setupSteps(account, products, host);
  return {
    setup: {
      steps: [...steps.filter((s) => !s.done), ...steps.filter((s) => s.done)],
      done: steps.filter((s) => s.done).length,
      total: steps.length,
    },
    stats: summary,
  };
}

// Up to three apps the account hasn't added yet.
const exploreApps = (installed) => APPS.filter((a) => !a.core && !installed.includes(a.id)).slice(0, 3);

// The community cards show once their invite link is set in .env.
function communityCards() {
  const cards = [];
  if (process.env.COMMUNITY_TELEGRAM_URL) {
    cards.push({ key: 'telegram', title: 'Join our Telegram community', note: 'Whatever is on your mind, we’re always here to help.', label: 'Join now', href: process.env.COMMUNITY_TELEGRAM_URL, external: true });
  }
  if (process.env.COMMUNITY_WHATSAPP_URL) {
    cards.push({ key: 'whatsapp', title: 'Join our WhatsApp community', note: 'Swap notes with other creators selling on the platform.', label: 'Join now', href: process.env.COMMUNITY_WHATSAPP_URL, external: true });
  }
  cards.push({ key: 'report', title: 'Bug report or feature request', note: 'Tell us what would make your dashboard better.', label: 'Report', href: '/dashboard/apps#ideas' });
  return cards;
}

module.exports = { overview, exploreApps, communityCards };
