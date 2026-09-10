// Canonical definition of the section types a store page can be built from.
// Shared by the admin builder API (routes/admin.js) and the storefront
// renderer (routes/storefront.js + views/storefront/partials/section.ejs),
// so both always agree on what fields a section of a given type has.
//
// `group` is display-only — it decides which group heading a type shows
// under in the builder's "Add a section" panel (public/js/admin-builder.js).
// Header/footer are deliberately NOT modules here: the storefront already
// renders those as fixed chrome (views/storefront/partials/header.ejs and
// footer.ejs) around every page, so a page-builder "Header" block would
// just be a second, out-of-sync one.

const SECTION_TYPES = {
  hero: { name: 'Hero banner', group: 'Content' },
  richtext: { name: 'Rich text', group: 'Content' },
  text_image: { name: 'Text + image', group: 'Content' },
  gallery: { name: 'Image gallery', group: 'Content' },
  video: { name: 'Video', group: 'Content' },
  products: { name: 'Product grid', group: 'Commerce' },
  spotlight: { name: 'Product spotlight', group: 'Commerce' },
  collections: { name: 'Collection list', group: 'Commerce' },
  testimonials: { name: 'Testimonials', group: 'Engagement' },
  logos: { name: 'Logo strip', group: 'Engagement' },
  newsletter: { name: 'Newsletter', group: 'Engagement' },
  faq: { name: 'FAQ', group: 'Engagement' },
  countdown: { name: 'Countdown banner', group: 'Engagement' },
  spacer: { name: 'Spacer', group: 'Layout' },
  divider: { name: 'Divider', group: 'Layout' },
};

const SECTION_TYPE_KEYS = Object.keys(SECTION_TYPES);

function defaultFields(type) {
  switch (type) {
    case 'hero':
      return { heading: 'Welcome to our store', subheading: 'Quality products, fast checkout, delivered to your door.' };
    case 'richtext':
      return {
        heading: 'Our story',
        body: 'Tell customers what makes this store worth buying from — materials, craftsmanship, or the problem you set out to solve.',
        width: 'narrow',
        align: 'center',
      };
    case 'text_image':
      return { heading: 'Our story', body: 'Tell customers what makes this store worth buying from.', side: 'right', image_url: '' };
    case 'gallery':
      return { heading: 'From the studio', images: [], cols: '3' };
    case 'video':
      return { heading: 'See it in action', embed_url: '' };
    case 'products':
      return { heading: 'All products', limit: 12 };
    case 'spotlight':
      return { product_id: null, body: 'A closer look at one of our favorites.', button: 'Shop this product', side: 'right' };
    case 'collections':
      return { heading: 'Shop by category', cols: '3' };
    case 'testimonials':
      return {
        heading: 'What customers say',
        quotes: [
          { quote: 'Fast shipping and exactly as described.', author: 'A happy customer' },
        ],
      };
    case 'logos':
      return { names: [] };
    case 'newsletter':
      return { heading: 'Stay in the loop', subtext: 'New arrivals and offers, straight to your inbox.', button: 'Subscribe' };
    case 'faq':
      return {
        heading: 'Shipping & returns',
        items: [
          { q: 'How long does delivery take?', a: '3–5 working days, with dispatch within 24 hours on in-stock items.' },
          { q: "What's your return policy?", a: '30-day free returns on unworn items with tags attached.' },
          { q: 'Do you ship internationally?', a: 'Yes — reach out to support for rates to your country.' },
        ],
      };
    case 'countdown':
      return { heading: 'Sale ends soon', end_at: '' };
    case 'spacer':
      return { height: 'm' };
    case 'divider':
      return { style: 'line' };
    default:
      return {};
  }
}

// Merges a partial fields object onto a section's existing (or default)
// fields, keeping only known keys for that type — and validating/clamping
// each one — so the builder can't write arbitrary or oversized junk into
// the fields JSON column.
function sanitizeFields(type, currentFields, patch) {
  const base = Object.assign({}, defaultFields(type), currentFields || {});
  if (!patch || typeof patch !== 'object') return base;

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const oneOf = (v, allowed) => (allowed.includes(v) ? v : undefined);

  switch (type) {
    case 'hero':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.subheading === 'string') base.subheading = patch.subheading.slice(0, 400);
      break;
    case 'richtext': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      const body = str(patch.body, 1500);
      if (body !== undefined) base.body = body;
      const width = oneOf(patch.width, ['narrow', 'wide']);
      if (width) base.width = width;
      const align = oneOf(patch.align, ['left', 'center']);
      if (align) base.align = align;
      break;
    }
    case 'text_image':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.body === 'string') base.body = patch.body.slice(0, 1000);
      if (patch.side === 'left' || patch.side === 'right') base.side = patch.side;
      if (typeof patch.image_url === 'string') base.image_url = patch.image_url.slice(0, 1000);
      break;
    case 'gallery': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      if (Array.isArray(patch.images)) {
        base.images = patch.images
          .filter((u) => typeof u === 'string' && u.trim())
          .slice(0, 6)
          .map((u) => u.trim().slice(0, 1000));
      }
      const cols = oneOf(patch.cols, ['2', '3']);
      if (cols) base.cols = cols;
      break;
    }
    case 'video': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      if (typeof patch.embed_url === 'string') {
        const u = patch.embed_url.trim();
        base.embed_url = /^https?:\/\//i.test(u) ? u.slice(0, 500) : '';
      }
      break;
    }
    case 'products':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (patch.limit !== undefined) {
        const n = parseInt(patch.limit, 10);
        base.limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 48) : base.limit;
      }
      break;
    case 'spotlight': {
      if (patch.product_id !== undefined) {
        const n = parseInt(patch.product_id, 10);
        base.product_id = Number.isFinite(n) && n > 0 ? n : null;
      }
      const body = str(patch.body, 500);
      if (body !== undefined) base.body = body;
      const button = str(patch.button, 40);
      if (button !== undefined) base.button = button;
      const side = oneOf(patch.side, ['left', 'right']);
      if (side) base.side = side;
      break;
    }
    case 'collections': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      const cols = oneOf(patch.cols, ['2', '3']);
      if (cols) base.cols = cols;
      break;
    }
    case 'testimonials':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (Array.isArray(patch.quotes)) {
        base.quotes = patch.quotes.slice(0, 3).map((q) => ({
          quote: typeof q.quote === 'string' ? q.quote.slice(0, 300) : '',
          author: typeof q.author === 'string' ? q.author.slice(0, 100) : '',
        }));
      }
      break;
    case 'logos':
      if (Array.isArray(patch.names)) {
        base.names = patch.names
          .filter((n) => typeof n === 'string' && n.trim())
          .slice(0, 8)
          .map((n) => n.trim().slice(0, 40));
      }
      break;
    case 'newsletter':
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.subtext === 'string') base.subtext = patch.subtext.slice(0, 300);
      if (typeof patch.button === 'string') base.button = patch.button.slice(0, 40);
      break;
    case 'faq': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      if (Array.isArray(patch.items)) {
        base.items = patch.items.slice(0, 6).map((it) => ({
          q: typeof it.q === 'string' ? it.q.slice(0, 200) : '',
          a: typeof it.a === 'string' ? it.a.slice(0, 600) : '',
        }));
      }
      break;
    }
    case 'countdown': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      if (typeof patch.end_at === 'string') {
        const t = Date.parse(patch.end_at);
        base.end_at = Number.isFinite(t) ? patch.end_at.slice(0, 40) : '';
      }
      break;
    }
    case 'spacer': {
      const height = oneOf(patch.height, ['s', 'm', 'l', 'xl']);
      if (height) base.height = height;
      break;
    }
    case 'divider': {
      const style = oneOf(patch.style, ['line', 'dots']);
      if (style) base.style = style;
      break;
    }
  }
  return base;
}

module.exports = { SECTION_TYPES, SECTION_TYPE_KEYS, defaultFields, sanitizeFields };
