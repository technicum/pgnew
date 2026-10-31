// The Overview page's data. An account with no sale yet sees progress, not
// metrics: four steps worked out from what it has actually done, with the
// first one not done as the step to act on. The first sale or booking retires
// the checklist for good and the stats, chart and recent orders take over.
const { normalizeStoreSettings } = require('./storeSettings');
const { listBlocks } = require('./blocks');
const { listServices, countConfirmed } = require('./bookings');
const { listCourses } = require('./courses');
const { listEvents } = require('./events');
const { listPaymentPages, formatINR } = require('./paymentPages');
const { overviewStats } = require('./orders');

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
  const added = [
    settings.photo && 'photo',
    account.bio && 'bio',
    settings.contactType !== 'none' && 'contact button',
  ].filter(Boolean);
  const [first] = products;
  const more = products.length > 1 ? ` and ${products.length - 1} more` : '';

  const steps = [
    {
      key: 'build',
      title: 'Build your page',
      done: added.length > 0,
      note: added.length ? `${capitalize(listPhrase(added))} added.` : 'Add a photo, bio and contact button so customers know who you are.',
      action: { label: 'Build my page', href: '/dashboard/builder' },
    },
    {
      key: 'sell',
      title: 'Add what you sell',
      done: products.length > 0,
      note: first ? `${first.title}${first.price ? `, ${first.price}` : ''}${more} — live.` : 'A service, course, download or membership customers can buy.',
      action: { label: 'Add what you sell', href: '/dashboard/builder' },
    },
    {
      key: 'share',
      title: 'Share your link',
      done: !!account.link_shared_at,
      note: `${host} — put it in your Instagram bio.`,
      copy: true,
    },
    {
      key: 'booking',
      title: 'Get your first booking',
      done: false, // the first one replaces this checklist
      note: 'Unlocks once someone pays — this is where your revenue and orders show up.',
      activeNote: 'Waiting on your first customer — your revenue and orders will show up here.',
      copy: true,
    },
  ];
  const active = steps.find((s) => !s.done);
  return steps.map((s) => ({ ...s, state: s.done ? 'done' : s === active ? 'active' : 'locked' }));
}

const HEADLINES = {
  build: ['Let’s build your page', (host) => `A few details and ${host} will feel like yours.`],
  sell: ['Now add what you sell', () => 'Your page needs something to buy or book before you share it.'],
  share: ['You’re almost ready to share your page', (host) => `One step left before ${host} is ready for customers.`],
  booking: ['Your page is ready for customers', (host) => `Share ${host} wherever your customers already are.`],
};

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
  const [headline, sub] = HEADLINES[steps.find((s) => s.state === 'active').key];
  return {
    setup: { steps, done: steps.filter((s) => s.done).length, total: steps.length, headline, sub: sub(host) },
    stats: summary,
  };
}

module.exports = { overview };
