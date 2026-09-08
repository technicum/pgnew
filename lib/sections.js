// Canonical definition of the section types a store page can be built from.
// Shared by the admin builder API (routes/admin.js) and the storefront
// renderer (routes/storefront.js + views/storefront/partials/section.ejs),
// so both always agree on what fields a section of a given type has.

const SECTION_TYPES = {
  hero: { name: 'Hero banner' },
  products: { name: 'Product grid' },
  text_image: { name: 'Text + image' },
  testimonials: { name: 'Testimonials' },
  newsletter: { name: 'Newsletter' },
};

const SECTION_TYPE_KEYS = Object.keys(SECTION_TYPES);

function defaultFields(type) {
  switch (type) {
    case 'hero':
      return { heading: 'Welcome to our store', subheading: 'Quality products, fast checkout, delivered to your door.' };
    case 'products':
      return { heading: 'All products', limit: 12 };
    case 'text_image':
      return { heading: 'Our story', body: 'Tell customers what makes this store worth buying from.', side: 'right', image_url: '' };
    case 'testimonials':
      return {
        heading: 'What customers say',
        quotes: [
          { quote: 'Fast shipping and exactly as described.', author: 'A happy customer' },
        ],
      };
    case 'newsletter':
      return { heading: 'Stay in the loop', subtext: 'New arrivals and offers, straight to your inbox.', button: 'Subscribe' };
    default:
      return {};
  }
}

// Merges a partial fields object onto a section's existing (or default)
// fields, keeping only known keys for that type so the builder can't write
// arbitrary junk into the fields JSON column.
function sanitizeFields(type, currentFields, patch) {
  const base = Object.assign({}, defaultFields(type), currentFields || {});
  if (!patch || typeof patch !== 'object') return base;

  switch (type) {
    case 'hero':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.subheading === 'string') base.subheading = patch.subheading.slice(0, 400);
      break;
    case 'products':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (patch.limit !== undefined) {
        const n = parseInt(patch.limit, 10);
        base.limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 48) : base.limit;
      }
      break;
    case 'text_image':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.body === 'string') base.body = patch.body.slice(0, 1000);
      if (patch.side === 'left' || patch.side === 'right') base.side = patch.side;
      if (typeof patch.image_url === 'string') base.image_url = patch.image_url.slice(0, 1000);
      break;
    case 'testimonials':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (Array.isArray(patch.quotes)) {
        base.quotes = patch.quotes.slice(0, 3).map((q) => ({
          quote: typeof q.quote === 'string' ? q.quote.slice(0, 300) : '',
          author: typeof q.author === 'string' ? q.author.slice(0, 100) : '',
        }));
      }
      break;
    case 'newsletter':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.subtext === 'string') base.subtext = patch.subtext.slice(0, 300);
      if (typeof patch.button === 'string') base.button = patch.button.slice(0, 40);
      break;
  }
  return base;
}

module.exports = { SECTION_TYPES, SECTION_TYPE_KEYS, defaultFields, sanitizeFields };
