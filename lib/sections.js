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
  heading: { name: 'Heading', group: 'Content' },
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
  row: { name: 'Row (columns)', group: 'Layout' },
};

const SECTION_TYPE_KEYS = Object.keys(SECTION_TYPES);

// Which section types are allowed to live nested inside a row's column
// (see the 'row' case below). Excludes 'row' itself (no nested rows, to
// keep the layout model — and its builder UI — from having to handle
// arbitrary recursion), and excludes the three types whose rendering needs
// its own store-wide data fetch (products/spotlight query the product
// catalog, collections reads the category list) — routes/storefront.js
// only does that fetch for top-level sections. Everything else is plain
// self-contained content, safe to nest.
const NESTABLE_SECTION_TYPES = SECTION_TYPE_KEYS.filter(
  (t) => !['row', 'products', 'spotlight', 'collections'].includes(t)
);

// Which of a section type's own `fields` are plain single text strings a
// merchant can individually select on the canvas to nudge its own
// margin/padding — separate from (and on top of) the section-level spacing
// above. Deliberately excludes array-item fields (testimonials' quotes,
// FAQ's items) since those don't have one stable element to target, and
// non-text fields (image_url, embed_url, product_id, etc).
const TEXT_ELEMENT_FIELDS = {
  hero: ['heading', 'subheading'],
  heading: ['heading'],
  richtext: ['heading', 'body'],
  text_image: ['heading', 'body'],
  gallery: ['heading'],
  video: ['heading'],
  products: ['heading'],
  spotlight: ['body', 'button'],
  collections: ['heading'],
  testimonials: ['heading'],
  logos: [],
  newsletter: ['heading', 'subtext', 'button'],
  faq: ['heading'],
  countdown: ['heading'],
  spacer: [],
  divider: [],
  row: [],
};

function defaultFields(type) {
  switch (type) {
    case 'hero':
      return {
        heading: 'Welcome to our store',
        subheading: 'Quality products, fast checkout, delivered to your door.',
        // bg_type 'none' keeps the section's plain background (the theme's
        // default), so every hero created before this field existed renders
        // exactly as it did — only an explicit choice turns on a color,
        // image or video background.
        bg_type: 'none',
        bg_color: '#FDE9C8',
        bg_image_url: '',
        bg_video_url: '',
        bg_overlay: false,
        // Only applied when bg_type isn't 'none' (see section.ejs) — lets a
        // merchant flip the heading/subheading to light text over a dark
        // color/image/video background, since a fixed dark text color would
        // otherwise turn unreadable against a dark background.
        text_theme: 'dark',
      };
    case 'heading':
      return { heading: 'Add a heading', align: 'left', size: 'l' };
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
    case 'row':
      // Empty until a column layout is picked in the builder (see
      // sanitizeRowColumns below for the shape once it is): each column is
      // { width, blocks: [{ id, type, fields, element_styles }] }, so a row
      // is entirely self-contained inside this one `fields` JSON blob — no
      // schema change needed to add it.
      return { columns: [] };
    default:
      return {};
  }
}

// A block nested inside a row's column reuses this same file's own
// per-type defaults/sanitizers (defaultFields/sanitizeFields/
// sanitizeAllElementStyles) recursively — a block is really just a section
// that lives in `fields.columns[i].blocks[j]` instead of its own database
// row, so it gets the exact same validation a top-level section does.
function sanitizeRowBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const type = block.type;
  if (!NESTABLE_SECTION_TYPES.includes(type)) return null;
  const id = (typeof block.id === 'string' && block.id.trim())
    ? block.id.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
    : ('blk_' + Math.random().toString(36).slice(2, 11));
  const fields = sanitizeFields(type, defaultFields(type), block.fields);
  const element_styles = sanitizeAllElementStyles(type, block.element_styles);
  return { id: id || ('blk_' + Math.random().toString(36).slice(2, 11)), type, fields, element_styles };
}

function sanitizeRowColumn(col) {
  const width = Number(col && col.width);
  const blocks = Array.isArray(col && col.blocks)
    ? col.blocks.slice(0, 6).map(sanitizeRowBlock).filter(Boolean)
    : [];
  return {
    width: Number.isFinite(width) && width > 0 ? Math.min(Math.max(width, 0.2), 5) : 1,
    blocks,
  };
}

// Up to 4 columns per row, up to 6 blocks per column — generous for any
// real layout, tight enough to bound the JSON payload.
function sanitizeRowColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns.slice(0, 4).map(sanitizeRowColumn);
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
    case 'hero': {
      if (typeof patch.heading === 'string') base.heading = patch.heading.slice(0, 200);
      if (typeof patch.subheading === 'string') base.subheading = patch.subheading.slice(0, 400);
      const bgType = oneOf(patch.bg_type, ['none', 'color', 'image', 'video']);
      if (bgType) base.bg_type = bgType;
      if (typeof patch.bg_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.bg_color)) base.bg_color = patch.bg_color;
      const bgImageUrl = str(patch.bg_image_url, 1000);
      if (bgImageUrl !== undefined) base.bg_image_url = bgImageUrl;
      const bgVideoUrl = str(patch.bg_video_url, 1000);
      if (bgVideoUrl !== undefined) base.bg_video_url = bgVideoUrl;
      if (typeof patch.bg_overlay === 'boolean') base.bg_overlay = patch.bg_overlay;
      const textTheme = oneOf(patch.text_theme, ['dark', 'light']);
      if (textTheme) base.text_theme = textTheme;
      break;
    }
    case 'heading': {
      const heading = str(patch.heading, 200);
      if (heading !== undefined) base.heading = heading;
      const align = oneOf(patch.align, ['left', 'center', 'right']);
      if (align) base.align = align;
      const size = oneOf(patch.size, ['s', 'm', 'l', 'xl']);
      if (size) base.size = size;
      break;
    }
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
    case 'row': {
      // The client always sends the whole columns array back (same pattern
      // as element_styles elsewhere) rather than a per-column patch, since
      // it's already holding the full row in local state whenever anything
      // inside it changes (layout picked, a block added/removed, a block's
      // own content or spacing edited).
      if (Array.isArray(patch.columns)) base.columns = sanitizeRowColumns(patch.columns);
      break;
    }
  }
  return base;
}

// Universal "module settings" every section gets regardless of type —
// stored on their own pz_page_sections columns (custom_class/custom_css),
// separate from the type-specific `fields` JSON above, since they apply
// identically to all 15 section types rather than needing a case per type.
//
// custom_css is intentionally NOT filtered for HTML/script content here —
// that would be easy to get wrong and easy to bypass. Instead the
// storefront renders it safely by assigning it to a <style> element's
// textContent (never innerHTML), which can't be broken out of by any
// string content, however it's escaped. See section.ejs's "custom CSS"
// block. Only a generous length cap is applied here, to bound storage/
// payload size.
function sanitizeSectionSettings(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.custom_class === 'string') {
    // Loosely validated as CSS class-name-ish tokens (letters, digits,
    // hyphens, underscores, spaces for multiple classes) so it can't smuggle
    // markup into the class="..." attribute it gets written into.
    out.custom_class = patch.custom_class.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 100);
  }
  if (typeof patch.custom_css === 'string') {
    out.custom_css = patch.custom_css.slice(0, 8000);
  }
  if (patch.min_height !== undefined) {
    const n = parseInt(patch.min_height, 10);
    // 0 = no override (the section keeps its natural height). Clamped well
    // above any real screen so a mis-drag can't wall off the rest of the page.
    out.min_height = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1200) : 0;
  }
  // Per-device visibility — independent of `hidden` (which hides a section
  // everywhere). Each is a plain on/off, coerced to 0/1 for storage.
  if (patch.hide_desktop !== undefined) out.hide_desktop = patch.hide_desktop ? 1 : 0;
  if (patch.hide_tablet !== undefined) out.hide_tablet = patch.hide_tablet ? 1 : 0;
  if (patch.hide_mobile !== undefined) out.hide_mobile = patch.hide_mobile ? 1 : 0;
  // Margin/padding on all four sides, clamped generously (well above any
  // real gap/inset a merchant would actually want) so a stray value can't
  // wall off the page. Left/right margin insets the (full-width) section
  // from the page edge, giving it a "boxed" look rather than moving it.
  const spacing = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 400) : 0; };
  if (patch.margin_top !== undefined) out.margin_top = spacing(patch.margin_top);
  if (patch.margin_bottom !== undefined) out.margin_bottom = spacing(patch.margin_bottom);
  if (patch.margin_left !== undefined) out.margin_left = spacing(patch.margin_left);
  if (patch.margin_right !== undefined) out.margin_right = spacing(patch.margin_right);
  if (patch.padding_top !== undefined) out.padding_top = spacing(patch.padding_top);
  if (patch.padding_bottom !== undefined) out.padding_bottom = spacing(patch.padding_bottom);
  if (patch.padding_left !== undefined) out.padding_left = spacing(patch.padding_left);
  if (patch.padding_right !== undefined) out.padding_right = spacing(patch.padding_right);
  return out;
}

// Per-element spacing (margin/padding on one text field inside a section,
// e.g. just the Hero heading) — stored as its own JSON column keyed by
// field name, e.g. { heading: { margin_top: 20 }, subheading: { padding_bottom: 8 } }.
// Distinct from sanitizeSectionSettings above, which governs the section as
// a whole. `field` must be one of TEXT_ELEMENT_FIELDS[type] — anything else
// (an unknown or array-item field, or a stale field from a since-changed
// section type) is silently ignored, and `currentStyles` is returned
// unchanged, so a bad request can't smuggle junk keys into storage.
// Spacing keys an element can carry. Unlike section-level spacing (top/
// bottom only — sections are full-width blocks), an individual text
// element also gets left/right: shifting a heading or button left/right
// within its section is a real, common thing to want, and left/right
// margin is how that's expressed. min_height is the element's own version
// of a section's height handle.
const ELEMENT_SPACING_KEYS = ['margin_top', 'margin_bottom', 'margin_left', 'margin_right', 'padding_top', 'padding_bottom', 'padding_left', 'padding_right'];

function sanitizeElementStyle(type, currentStyles, field, patch) {
  const out = Object.assign({}, currentStyles || {});
  const allowed = TEXT_ELEMENT_FIELDS[type] || [];
  if (!allowed.includes(field) || !patch || typeof patch !== 'object') return out;
  const spacing = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 400) : 0; };
  const entry = Object.assign({}, out[field] || {});
  ELEMENT_SPACING_KEYS.forEach((k) => {
    if (patch[k] !== undefined) entry[k] = spacing(patch[k]);
  });
  if (patch.min_height !== undefined) {
    const n = parseInt(patch.min_height, 10);
    entry.min_height = Number.isFinite(n) ? Math.min(Math.max(n, 0), 800) : 0;
  }
  // Free positioning — dragging the element's move handle anywhere inside
  // its section (or, nested, its column) detaches it from the normal flow.
  // `positioned` is the on/off switch; pos_left/pos_top are px from the
  // parent's own top-left corner (already clamped client-side to stay
  // inside those bounds, but re-clamped here too); el_width freezes the
  // box's width at the moment it left flow, so it doesn't collapse to
  // min-content once absolutely positioned.
  if (patch.positioned !== undefined) entry.positioned = !!patch.positioned;
  const pos = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 4000) : 0; };
  if (patch.pos_left !== undefined) entry.pos_left = pos(patch.pos_left);
  if (patch.pos_top !== undefined) entry.pos_top = pos(patch.pos_top);
  if (patch.el_width !== undefined) {
    const n = parseInt(patch.el_width, 10);
    entry.el_width = Number.isFinite(n) ? Math.min(Math.max(n, 20), 2000) : 0;
  }
  // Drop the entry once it's back to all-zero/false, so the JSON stays
  // clean instead of accumulating explicit-zero keys forever.
  const hasAny = Object.keys(entry).some((k) => entry[k]);
  if (hasAny) out[field] = entry; else delete out[field];
  return out;
}

// Bulk variant used by /sections/restore (undo/redo), which hands over a
// whole element_styles object at once rather than one field's patch —
// re-validates every field/value the same way sanitizeElementStyle does, so
// a snapshot can't write anything a normal edit couldn't have produced.
function sanitizeAllElementStyles(type, obj) {
  let out = {};
  if (!obj || typeof obj !== 'object') return out;
  const allowed = TEXT_ELEMENT_FIELDS[type] || [];
  allowed.forEach((field) => {
    if (obj[field] && typeof obj[field] === 'object') {
      out = sanitizeElementStyle(type, out, field, obj[field]);
    }
  });
  return out;
}

module.exports = {
  SECTION_TYPES,
  SECTION_TYPE_KEYS,
  NESTABLE_SECTION_TYPES,
  TEXT_ELEMENT_FIELDS,
  defaultFields,
  sanitizeFields,
  sanitizeSectionSettings,
  sanitizeElementStyle,
  sanitizeAllElementStyles,
};
