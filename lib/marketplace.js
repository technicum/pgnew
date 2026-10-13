// The PageZaper marketplace — /explore and the homepage's search: every
// course, session, event and payment page a creator has opted in to list
// ("List on the marketplace" in its editor), from every store.
//
// Each card links to the item on its creator's store with
// ?via=marketplace, which is how a sale gets credited to the marketplace
// (lib/platform.js) and charged the marketplace commission.
//
// Each source caps itself at 200 rows and the filtering happens here —
// plenty while the catalogue is small. Past a few thousand listed items
// this wants a proper search index (MySQL FULLTEXT or similar).
const { listMarketplacePages, formatINR } = require('./paymentPages');
const { listMarketplaceServices } = require('./bookings');
const { listMarketplaceEvents } = require('./events');
const { listMarketplaceCourses } = require('./courses');
const kit = require('./appKit');
const { suspendedUserIds } = require('./users');

const TYPES = {
  session: 'Sessions & appointments',
  course: 'Courses',
  event: 'Events',
  product: 'Products',
};
// One of each, for a card's badge.
const TYPE_ONE = { course: 'Course', session: 'Session', event: 'Event', product: 'Product' };

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '•';
}

function plainSummary(text, max = 140) {
  const plain = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+|^[-*]\s+|^\d+\.\s+/gm, '')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : plain;
}

// "₹499", "From ₹199" or "Pay what you want" for a payment page's products.
function pagePrice(page) {
  const prices = page.products.map((p) => (p.pricing === 'pwyw' ? (p.minimum || 0) : (p.price || 0)));
  if (!prices.length) return '';
  if (page.products.length === 1 && page.products[0].pricing === 'pwyw') {
    return prices[0] ? `From ${formatINR(prices[0])}` : 'Pay what you want';
  }
  const low = Math.min(...prices);
  return page.products.length > 1 && prices.some((p) => p !== low) ? `From ${formatINR(low)}` : formatINR(low);
}

// facts: short [icon, text] pairs under the title — icon is one of
// clock, video, pin, calendar, book, box (partials/market-card draws them).
function card(type, item, { path, title, summary, price, image, facts = [], location }) {
  facts = facts.filter((f) => f && f[1]);
  return {
    type,
    typeLabel: TYPES[type],
    typeOne: TYPE_ONE[type],
    key: `${type}-${item.id}`,
    // Which of the card art colours (explore.css .mk-tone-N) — stable per item.
    tone: [...`${type}${item.id}${item.title}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6,
    title: title || item.title,
    summary: plainSummary(summary),
    price,
    free: price === 'Free',
    image: /^(https?:\/\/|\/uploads\/)/i.test(image || '') ? image : '',
    facts,
    meta: facts.map((f) => f[1]).join(' · '),
    location: location || '',
    creator: item.owner_name,
    creatorInitials: initials(item.owner_name),
    handle: item.owner_handle,
    path: `${path}?via=marketplace`,
    created: new Date(item.created_at || 0).getTime(),
  };
}

async function listItems({ q = '', type = '' } = {}) {
  const [pages, services, events, courses, suspended] = await Promise.all([
    !type || type === 'product' ? listMarketplacePages() : [],
    !type || type === 'session' ? listMarketplaceServices() : [],
    !type || type === 'event' ? listMarketplaceEvents() : [],
    !type || type === 'course' ? listMarketplaceCourses() : [],
    suspendedUserIds(),
  ]);
  // Suspended creators (Platform admin → Users) aren't listed.
  const listed = (rows) => rows.filter((r) => !suspended.has(r.user_id));
  const items = [
    ...listed(courses).map((c) => card('course', c, {
      path: `/course/${c.slug}`, summary: c.description, price: c.priceLabel, image: c.cover_url,
      facts: [['book', c.contentLabel], ['video', 'Online']],
    })),
    ...listed(services).map((s) => card('session', s, {
      path: `/book/${s.slug}`, summary: s.description, price: s.priceLabel, image: s.cover_url,
      facts: [
        ['clock', `${s.duration_min} min`],
        s.attend === 'online' || s.attend === 'either' ? ['video', s.attend === 'either' ? 'Online or in person' : 'Online'] : null,
        s.attend !== 'online' && s.location ? ['pin', s.location] : null,
      ],
      location: s.attend === 'online' ? '' : s.location,
    })),
    ...listed(events).map((e) => card('event', e, {
      path: `/event/${e.slug}`, summary: e.description, price: e.priceLabel, image: e.cover_url,
      facts: [
        ['calendar', `${kit.formatDate(e.date)}, ${kit.formatTime(e.start_time)}`],
        e.mode === 'venue' ? ['pin', e.location || 'In person'] : ['video', 'Online'],
      ],
      location: e.mode === 'venue' ? e.location : '',
    })),
    // "Buy me a coffee" pages are tips for a creator's own fans, not
    // something to shop for — never listed, even if ticked.
    ...listed(pages).filter((p) => !p.products.every((x) => x.type === 'coffee')).map((p) => card('product', p, {
      path: `/pay/${p.slug}`, summary: p.description || p.about, price: pagePrice(p),
      image: p.cover_type === 'image' ? p.cover_image_url : '',
      facts: [p.products.length > 1 ? ['box', `${p.products.length} products`] : null],
    })),
  ];

  // Every word has to appear somewhere in the card: title, description,
  // creator, place or kind.
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const matches = (it) => {
    if (!words.length) return true;
    const hay = [it.title, it.summary, it.creator, it.handle, it.location, it.meta, it.typeLabel].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  // Title hits first, then newest.
  const titleHits = (it) => words.filter((w) => it.title.toLowerCase().includes(w)).length;
  return items
    .filter(matches)
    .sort((a, b) => titleHits(b) - titleHits(a) || b.created - a.created);
}

module.exports = { TYPES, TYPE_ONE, listItems };
