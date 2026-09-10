// Real drag-and-drop page builder — talks to the JSON API already mounted
// under /admin/pages/:id/sections... in routes/admin.js. Every action here
// (add/reorder/edit/hide/delete/publish) is a real, immediate save against
// pz_pages / pz_page_sections; there is no separate draft state to lose.
//
// Section types are driven entirely by window.__BUILDER__.sectionTypes,
// which comes straight from lib/sections.js — adding a new module later
// means adding it there (SECTION_TYPES + defaultFields + sanitizeFields),
// a render case in views/storefront/partials/section.ejs, and a matching
// case in renderSectionInner()/inspectorFieldsFor() below.
(function () {
  "use strict";
  var DATA = window.__BUILDER__;
  if (!DATA) return;

  var PAGE = DATA.page;
  var STORE = DATA.store;
  var SECTION_TYPES = DATA.sectionTypes;
  var BASE = "/admin/pages/" + PAGE.id + "/sections";

  /* ---------------------------------------------------------------
     Icons
  --------------------------------------------------------------- */
  var ICON = {
    hero: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="1.3"/><path d="M6 12.5h8M7.5 9.5h5"/></svg>',
    products: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="6" height="6" rx="1"/><rect x="11.5" y="2.5" width="6" height="6" rx="1"/><rect x="2.5" y="11.5" width="6" height="6" rx="1"/><rect x="11.5" y="11.5" width="6" height="6" rx="1"/></svg>',
    text_image: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="7" height="13" rx="1.1"/><path d="M13 6h4.5M13 9h4.5M13 12h3"/></svg>',
    testimonials: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6.5 6.5c-2 0-3 1.4-3 3.4S4.5 13 6.5 13"/><path d="M13.5 6.5c-2 0-3 1.4-3 3.4S11.5 13 13.5 13"/></svg>',
    newsletter: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2.5" y="4.5" width="15" height="11" rx="1.4"/><path d="m3 5.5 7 5.3 7-5.3"/></svg>',
    drag: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="7" cy="5" r="1.15"/><circle cx="13" cy="5" r="1.15"/><circle cx="7" cy="10" r="1.15"/><circle cx="13" cy="10" r="1.15"/><circle cx="7" cy="15" r="1.15"/><circle cx="13" cy="15" r="1.15"/></svg>',
    dup: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6.5" y="6.5" width="10" height="10" rx="1.4"/><path d="M13.5 6.5V4.8a1.3 1.3 0 0 0-1.3-1.3H4.8a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 9.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L14.5 6"/></svg>',
    eye: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 10s2.8-5.5 8-5.5S18 10 18 10s-2.8 5.5-8 5.5S2 10 2 10Z"/><circle cx="10" cy="10" r="2.2"/></svg>',
    eyeOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l14 14M8.3 8.4a2.2 2.2 0 0 0 3.1 3.1M6 5.4C3.6 6.7 2 10 2 10s2.8 5.5 8 5.5c1.4 0 2.6-.4 3.6-1M15.2 13.2C16.9 11.9 18 10 18 10s-2.8-5.5-8-5.5c-.6 0-1.2.05-1.7.15"/></svg>',
    image: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="1.3"/><circle cx="7" cy="8" r="1.3"/><path d="M3.5 15 8 10.5l2.5 2.5L14 9l2.5 3"/></svg>',
    richtext: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5h14M3 9h14M3 13h9"/></svg>',
    gallery: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="11" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="2.5" y="10" width="6.5" height="6.5" rx="1"/><rect x="11" y="10" width="6.5" height="6.5" rx="1"/></svg>',
    video: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="15" height="12" rx="1.3"/><path d="M8.2 7.5v5l4.3-2.5-4.3-2.5Z" fill="currentColor" stroke="none"/></svg>',
    spotlight: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10.5 2.5H16a1 1 0 0 1 1 1v5.5a1 1 0 0 1-.3.7l-7 7a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4l7-7a1 1 0 0 1 .2-.1Z"/><circle cx="13" cy="6" r="1"/></svg>',
    collections: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="4" rx="1"/><rect x="2.5" y="10.5" width="15" height="4" rx="1"/></svg>',
    logos: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M7 10h6M10 7v6"/></svg>',
    faq: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7.2"/><path d="M7.8 7.8a2.2 2.2 0 1 1 3.1 2c-.9.6-.9 1.1-.9 1.9"/><circle cx="10" cy="14" r=".2" fill="currentColor"/></svg>',
    countdown: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.2"/><path d="M10 6v4l3 2"/></svg>',
    spacer: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4h12M4 16h12M10 6.5v7"/></svg>',
    divider: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 10h14"/></svg>'
  };
  function icon(name) { return ICON[name] || ""; }

  /* ---------------------------------------------------------------
     State — server data is the source of truth; every mutation below
     also fires the matching API call, so "undo" (below) isn't a normal
     in-memory undo either: it replays an earlier snapshot of the section
     list against the database through POST .../sections/restore.
  --------------------------------------------------------------- */
  var state = { sections: DATA.sections.slice(), selectedId: null };

  function findSection(id) { return state.sections.find(function (s) { return String(s.id) === String(id); }); }
  function indexOf(id) { return state.sections.findIndex(function (s) { return String(s.id) === String(id); }); }

  function api(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function persistOrder() {
    setSaving(true);
    return api(BASE + "/reorder", { order: state.sections.map(function (s) { return s.id; }) })
      .then(function (res) { commitHistory(); return res; })
      .finally(function () { setSaving(false); });
  }

  /* ---------------------------------------------------------------
     Undo / redo — a stack of full section-list snapshots. Every
     mutating action (add/duplicate/delete/reorder/field edit/settings
     edit) calls commitHistory() once it has settled locally, which
     snapshots state.sections and pushes it on (truncating any redo
     branch first). Undo/redo just walk the stack and replay the target
     snapshot through /sections/restore, then adopt whatever section
     list the server hands back — no client-side id bookkeeping needed.
  --------------------------------------------------------------- */
  var history = { stack: [cloneSections(state.sections)], index: 0, restoring: false };
  var MAX_HISTORY = 60;

  function cloneSections(arr) {
    return JSON.parse(JSON.stringify(arr));
  }

  function commitHistory() {
    if (history.restoring) return;
    var snap = cloneSections(state.sections);
    // Skip a no-op push (e.g. a reorder drag that ends back where it started).
    if (JSON.stringify(snap) === JSON.stringify(history.stack[history.index])) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > MAX_HISTORY) history.stack.shift();
    history.index = history.stack.length - 1;
    updateHistoryButtons();
  }

  function restoreSnapshot(snapshot, successMsg) {
    history.restoring = true;
    setSaving(true);
    return api(BASE + "/restore", { sections: snapshot }).then(function (res) {
      setSaving(false);
      history.restoring = false;
      if (!res || !res.ok) { toast("Could not undo/redo that change.", true); return; }
      state.sections = res.sections.map(function (s) {
        return Object.assign({}, s, { fields: typeof s.fields === "string" ? JSON.parse(s.fields) : s.fields });
      });
      if (state.selectedId && !findSection(state.selectedId)) state.selectedId = null;
      renderAll();
      updateHistoryButtons();
      if (successMsg) toast(successMsg);
    });
  }

  function undo() {
    if (history.index <= 0) return;
    history.index--;
    restoreSnapshot(history.stack[history.index], "Undid last change");
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    restoreSnapshot(history.stack[history.index], "Redid change");
  }

  function updateHistoryButtons() {
    var undoBtn = document.getElementById("bUndoBtn");
    var redoBtn = document.getElementById("bRedoBtn");
    if (undoBtn) undoBtn.disabled = history.index <= 0;
    if (redoBtn) redoBtn.disabled = history.index >= history.stack.length - 1;
  }

  function setSaving(on) {
    var ind = document.getElementById("bSaveIndicator");
    var txt = document.getElementById("bSaveText");
    ind.classList.toggle("saving", on);
    txt.textContent = on ? "Saving…" : "Saved";
  }

  /* ---------------------------------------------------------------
     Rendering
  --------------------------------------------------------------- */
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // For dropping a merchant-supplied URL into a single-quoted CSS url() or a
  // double-quoted attribute: esc() alone only neutralizes & < >, so this
  // additionally closes off both quote characters a URL could use to break
  // out of whichever attribute it ends up in.
  function attrUrl(u) { return esc(u).replace(/'/g, "%27").replace(/"/g, "%22"); }

  // Converts a stored end_at (an ISO/UTC string, or "" if unset) to the
  // "YYYY-MM-DDTHH:mm" shape an <input type="datetime-local"> needs, in the
  // browser's own local time — the inverse of the toISOString() conversion
  // done where the input's value is saved (see wireInspector's change
  // handler), which is what keeps the countdown's deadline the same real
  // moment for every visitor regardless of their timezone.
  function toLocalInputValue(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function phTile(extraClass, styleAttr) {
    return '<div class="b-ph ' + (extraClass || "") + '"' + (styleAttr || "") + '>' + icon("image") + "</div>";
  }

  function renderSectionInner(sec) {
    var d = sec.fields;
    switch (sec.type) {
      case "hero":
        return '<div class="b-sec-pad b-sec-hero">' +
          '<h2 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h2>' +
          '<p data-field="subheading" contenteditable="true">' + esc(d.subheading) + '</p></div>';

      case "text_image":
        var imgStyle = d.image_url ? ' style="background-image:url(\'' + esc(d.image_url).replace(/'/g, "%27") + '\');"' : "";
        return '<div class="b-sec-pad b-sec-imgtext ' + (d.side === "left" ? "reverse" : "") + '">' +
          '<div class="b-sec-img-block b-ph"' + imgStyle + '>' + (d.image_url ? "" : icon("image")) + '</div>' +
          '<div><h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' +
          '<p data-field="body" contenteditable="true">' + esc(d.body) + '</p></div></div>';

      case "products":
        var count = Math.max(1, Math.min(48, parseInt(d.limit, 10) || 12));
        var items = DATA.products.slice(0, count);
        var cards;
        if (!items.length) {
          cards = '<div class="b-prod-empty">This store has no products yet — <a href="/admin/products/new" target="_blank">add one</a> to preview it here. The live page will always show your current catalog.</div>';
        } else {
          cards = items.map(function (p) {
            var imgStyle = p.image_url ? ' style="background-image:url(\'' + esc(p.image_url).replace(/'/g, "%27") + '\');"' : "";
            return '<div><div class="b-prod-card-img b-ph"' + imgStyle + '>' + (p.image_url ? "" : icon("image")) + '</div>' +
              '<div class="b-prod-card-name">' + esc(p.title) + '</div><div class="b-prod-card-price">' + money(p.price) + '</div></div>';
          }).join("");
        }
        return '<div class="b-sec-pad"><div class="b-sec-heading-row"><h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' +
          '<span>' + (DATA.products.length ? "showing " + Math.min(count, DATA.products.length) + " of " + DATA.products.length : "") + '</span></div>' +
          '<div class="b-prod-grid">' + cards + '</div></div>';

      case "testimonials":
        var q = (d.quotes && d.quotes[0]) || { quote: "", author: "" };
        return '<div class="b-sec-pad"><div class="b-sec-heading-row" style="justify-content:center;"><h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3></div>' +
          '<div class="b-testi-card"><div class="b-testi-stars">★★★★★</div>' +
          '<div class="b-testi-quote" data-field="quotes.0.quote" contenteditable="true">"' + esc(q.quote) + '"</div>' +
          '<div class="b-testi-name" data-field="quotes.0.author" contenteditable="true">' + esc(q.author) + '</div></div></div>';

      case "newsletter":
        return '<div class="b-sec-pad b-newsletter">' +
          '<h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' +
          '<p data-field="subtext" contenteditable="true">' + esc(d.subtext) + '</p>' +
          '<div class="b-newsletter-form"><input placeholder="you@example.com" disabled/>' +
          '<button style="background:var(--b-accent);color:var(--b-accent-ink);" data-field="button" contenteditable="true">' + esc(d.button) + '</button></div></div>';

      case "richtext":
        return '<div class="b-sec-pad b-richtext-' + (d.width === "wide" ? "wide" : "narrow") + '" style="text-align:' + (d.align === "left" ? "left" : "center") + ';">' +
          '<h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' +
          '<p data-field="body" contenteditable="true">' + esc(d.body) + '</p></div>';

      case "gallery": {
        var imgs = d.images || [];
        var tiles = imgs.length
          ? imgs.map(function (u) { return '<div class="b-ph b-gallery-tile" style="background-image:url(\'' + attrUrl(u) + '\');"></div>'; }).join("")
          : '<div class="b-prod-empty">No images yet — add image URLs from the panel on the right.</div>';
        return '<div class="b-sec-pad"><div class="b-sec-heading-row"><h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3></div>' +
          '<div class="b-gallery-grid" data-cols="' + d.cols + '">' + tiles + '</div></div>';
      }

      case "video": {
        var frame = d.embed_url
          ? '<div class="b-video-frame"><iframe src="' + attrUrl(d.embed_url) + '" loading="lazy" allowfullscreen></iframe></div>'
          : '<div class="b-video-frame b-ph"><div>' + icon("video") + '<div class="b-video-hint">Paste a video URL in the panel</div></div></div>';
        return '<div class="b-sec-pad"><h3 style="margin-bottom:16px;" data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' + frame + '</div>';
      }

      case "spotlight": {
        var sp = d.product_id ? DATA.products.filter(function (p) { return String(p.id) === String(d.product_id); })[0] : null;
        if (!sp) return '<div class="b-sec-pad"><div class="b-prod-empty">No product selected — choose one from the panel on the right.</div></div>';
        var spImgStyle = sp.image_url ? ' style="background-image:url(\'' + attrUrl(sp.image_url) + '\');"' : "";
        return '<div class="b-sec-pad b-spotlight ' + (d.side === "left" ? "reverse" : "") + '">' +
          '<div class="b-spotlight-media b-ph"' + spImgStyle + '>' + (sp.image_url ? "" : icon("image")) + '</div>' +
          '<div><h3>' + esc(sp.title) + '</h3>' +
          '<div class="b-spotlight-price">' + money(sp.price) + '</div>' +
          '<p data-field="body" contenteditable="true">' + esc(d.body) + '</p>' +
          '<span data-field="button" contenteditable="true" style="display:inline-block;background:var(--b-accent);color:var(--b-accent-ink);font-weight:700;font-size:13px;padding:9px 16px;border-radius:8px;">' + esc(d.button) + '</span></div></div>';
      }

      case "collections": {
        var cats = DATA.categories || [];
        var swatches = ["#F5F1E8", "#F3E4D6", "#FDE9C7", "#E7EEF6", "#EDEAF6", "#DDEAD9"];
        var collInner = cats.length
          ? '<div class="b-coll-grid" data-cols="' + d.cols + '">' + cats.map(function (c, i) {
              return '<div class="b-coll-card" style="background:' + swatches[i % swatches.length] + ';"><span>' + esc(c.name) + '</span></div>';
            }).join("") + '</div>'
          : '<div class="b-prod-empty">No categories yet — add some from Products &rsaquo; Categories and they’ll show up here automatically.</div>';
        return '<div class="b-sec-pad"><div class="b-sec-heading-row"><h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3></div>' + collInner + '</div>';
      }

      case "logos": {
        var names = d.names || [];
        if (!names.length) return '<div class="b-sec-pad"><div class="b-prod-empty">No names yet — add them from the panel on the right.</div></div>';
        return '<div class="b-sec-pad b-logostrip">' + names.map(function (n) { return "<span>" + esc(n) + "</span>"; }).join("") + '</div>';
      }

      case "faq": {
        var items = d.items || [];
        var rows = items.map(function (f, idx) {
          return '<div class="b-faq-item">' +
            '<div class="b-faq-q" data-field="items.' + idx + '.q" contenteditable="true">' + esc(f.q) + '</div>' +
            '<div class="b-faq-a" data-field="items.' + idx + '.a" contenteditable="true">' + esc(f.a) + '</div></div>';
        }).join("");
        return '<div class="b-sec-pad" style="max-width:640px;margin:0 auto;"><h3 style="margin-bottom:6px;" data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' + rows + '</div>';
      }

      case "countdown":
        return '<div class="b-sec-pad b-countdown">' +
          '<h3 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h3>' +
          (d.end_at ? '<div class="b-countdown-hint">Counts down to ' + esc(new Date(d.end_at).toLocaleString()) + '</div>' : '<div class="b-countdown-hint">Set an end date/time in the panel</div>') +
          '</div>';

      case "spacer":
        return '<div class="b-spacer-preview" data-h="' + d.height + '"><span>Spacer</span></div>';

      case "divider":
        return d.style === "dots" ? '<div class="b-divider-preview b-divider-dots">• • • • •</div>' : '<div class="b-divider-preview"><hr/></div>';

      default:
        return '<div class="b-sec-pad"><div class="b-inspector-hint">Unknown section type "' + esc(sec.type) + '".</div></div>';
    }
  }

  // spacer/divider already have their own height concept, so they don't get
  // a resize handle or a min-height override on top of it.
  var NO_RESIZE_TYPES = { spacer: true, divider: true };

  function applyHeightStyle(rootEl, minHeight) {
    if (!rootEl) return;
    if (minHeight && minHeight > 0) {
      rootEl.style.minHeight = minHeight + "px";
      rootEl.style.display = "flex";
      rootEl.style.flexDirection = "column";
      rootEl.style.justifyContent = "center";
    } else {
      rootEl.style.minHeight = "";
      rootEl.style.display = "";
      rootEl.style.flexDirection = "";
      rootEl.style.justifyContent = "";
    }
  }

  function heightRootEl(id) {
    var wrap = document.querySelector('.b-csec[data-id="' + id + '"]');
    return wrap ? wrap.firstElementChild : null;
  }

  // Same root element as heightRootEl (the section's own top-level tag) --
  // named separately since margin/padding are a distinct concern from
  // min-height, wired up through their own gutter drag handles below.
  function spacingRootEl(id) {
    return heightRootEl(id);
  }

  function applySpacingStyle(rootEl, sec) {
    if (!rootEl) return;
    rootEl.style.marginTop = sec.margin_top ? sec.margin_top + "px" : "";
    rootEl.style.marginBottom = sec.margin_bottom ? sec.margin_bottom + "px" : "";
    rootEl.style.paddingTop = sec.padding_top ? sec.padding_top + "px" : "";
    rootEl.style.paddingBottom = sec.padding_bottom ? sec.padding_bottom + "px" : "";
  }

  function renderCanvas() {
    var sortable = document.getElementById("bSortable");
    sortable.innerHTML = "";
    if (!state.sections.length) {
      sortable.innerHTML = '<div class="b-canvas-empty">Drag a section here to start building this page</div>';
      return;
    }
    state.sections.forEach(function (sec) {
      var wrap = el('<div class="b-csec" data-id="' + sec.id + '"></div>');
      wrap.innerHTML = renderSectionInner(sec);
      var resizable = !NO_RESIZE_TYPES[sec.type];
      if (resizable) {
        applyHeightStyle(wrap.firstElementChild, sec.min_height);
        applySpacingStyle(wrap.firstElementChild, sec);
      }
      var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
      var hiddenDevices = [];
      if (sec.hide_desktop) hiddenDevices.push("desktop");
      if (sec.hide_tablet) hiddenDevices.push("tablet");
      if (sec.hide_mobile) hiddenDevices.push("mobile");
      var visibilityTag = hiddenDevices.length ? " · hidden on " + hiddenDevices.join(", ") : "";
      var toolbar = el(
        '<div class="b-csec-toolbar">' +
          '<span class="b-csec-tag">' + esc(label) + (sec.hidden ? " · hidden" : "") + esc(visibilityTag) + '</span>' +
          '<button class="b-drag-handle" data-action="drag" title="Drag to reorder">' + icon("drag") + '</button>' +
          '<button data-action="dup" title="Duplicate">' + icon("dup") + '</button>' +
          '<button data-action="toggle" title="' + (sec.hidden ? "Show on storefront" : "Hide from storefront") + '">' + icon(sec.hidden ? "eyeOff" : "eye") + '</button>' +
          '<button data-action="del" title="Delete">' + icon("trash") + '</button>' +
        '</div>'
      );
      wrap.appendChild(toolbar);
      if (resizable) {
        wrap.appendChild(el('<div class="b-csec-resize" data-action="resize" title="Drag to resize this section’s height"><span></span></div>'));
        wrap.appendChild(el('<div class="b-csec-margin b-csec-margin-top" data-action="margin-top" title="Drag to add space above this section"></div>'));
        wrap.appendChild(el('<div class="b-csec-margin b-csec-margin-bottom" data-action="margin-bottom" title="Drag to add space below this section"></div>'));
      }
      if (sec.id === state.selectedId) wrap.classList.add("is-selected");
      if (sec.hidden) wrap.classList.add("is-hidden-sec");
      if (sec.hide_desktop) wrap.dataset.hideDesktop = "1";
      if (sec.hide_tablet) wrap.dataset.hideTablet = "1";
      if (sec.hide_mobile) wrap.dataset.hideMobile = "1";
      sortable.appendChild(wrap);
    });
  }

  // Drag-to-resize: distinct from the reorder/insert drag system above (no
  // drop targets, just a live height readout), so it gets its own small
  // pointer session rather than reusing startDrag().
  function startResize(e, sec, rootEl) {
    if (!rootEl) return;
    e.preventDefault();
    e.stopPropagation();
    var startY = e.clientY;
    var startHeight = rootEl.getBoundingClientRect().height;

    function clamp(n) { return Math.max(0, Math.min(1200, Math.round(n))); }

    function liveInput() {
      // Keep the inspector's numeric field in sync if it's open on this
      // same section while the handle is being dragged.
      return document.querySelector('input[type="number"][data-field="__min_height"]');
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      var h = clamp(startHeight + (p.clientY - startY));
      applyHeightStyle(rootEl, h);
      var input = liveInput();
      if (input) input.value = h;
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      var finalHeight = clamp(parseFloat(rootEl.style.minHeight) || 0);
      applyHeightStyle(rootEl, finalHeight);
      sec.min_height = finalHeight;
      var input = liveInput();
      if (input) input.value = finalHeight;
      saveSettings(sec.id, { min_height: finalHeight });
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // Drag-to-stretch for the gutter margin handles above/below a section --
  // its own small pointer session, parallel to startResize above but for a
  // different property (margin-top/margin-bottom instead of min-height) and
  // a different sign (dragging the TOP handle further up should grow
  // margin-top, the opposite direction from dragging the bottom one down).
  function startMarginDrag(e, sec, rootEl, side) {
    if (!rootEl) return;
    e.preventDefault();
    e.stopPropagation();
    var startY = e.clientY;
    var key = side === "top" ? "margin_top" : "margin_bottom";
    var startVal = sec[key] || 0;
    var sign = side === "top" ? -1 : 1;

    function clamp(n) { return Math.max(0, Math.min(400, Math.round(n))); }
    function liveInput() { return document.querySelector('input[type="number"][data-field="__' + key + '"]'); }

    function apply(v) {
      sec[key] = v;
      applySpacingStyle(rootEl, sec);
      var input = liveInput();
      if (input) input.value = v;
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      apply(clamp(startVal + sign * (p.clientY - startY)));
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      var patch = {};
      patch[key] = sec[key] || 0;
      saveSettings(sec.id, patch);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  var LIB_GROUP_ORDER = ["Content", "Commerce", "Engagement", "Layout"];

  function renderLibrary() {
    var body = document.getElementById("bLibraryBody");
    body.innerHTML = "";
    var byGroup = {};
    Object.keys(SECTION_TYPES).forEach(function (type) {
      var g = SECTION_TYPES[type].group || "More";
      (byGroup[g] = byGroup[g] || []).push(type);
    });
    var groups = LIB_GROUP_ORDER.concat(Object.keys(byGroup).filter(function (g) { return LIB_GROUP_ORDER.indexOf(g) === -1; }));
    groups.forEach(function (g) {
      var types = byGroup[g];
      if (!types || !types.length) return;
      var groupEl = el('<div class="b-lib-group"><div class="b-lib-group-label">' + esc(g) + '</div></div>');
      types.forEach(function (type) {
        var row = el(
          '<div class="b-lib-item" data-type="' + type + '">' +
            '<div class="b-lib-item-icon">' + icon(type) + '</div>' +
            '<div class="b-lib-item-label">' + esc(SECTION_TYPES[type].name) + '</div>' +
          '</div>'
        );
        groupEl.appendChild(row);
      });
      body.appendChild(groupEl);
    });
    body.appendChild(el('<div class="b-lib-note">More section types are on the way — new ones will show up in this list as they ship.</div>'));
  }

  function renderLayers() {
    var body = document.getElementById("bLayersBody");
    body.innerHTML = "";
    if (!state.sections.length) {
      body.innerHTML = '<div class="b-layer-empty">No sections yet</div>';
      return;
    }
    state.sections.forEach(function (sec) {
      var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
      var row = el(
        '<div class="b-layer-row ' + (sec.id === state.selectedId ? "selected" : "") + ' ' + (sec.hidden ? "is-hidden" : "") + '" data-id="' + sec.id + '">' +
          '<span class="b-drag-handle" data-action="drag">' + icon("drag") + '</span>' +
          '<span class="b-layer-row-icon">' + icon(sec.type) + '</span>' +
          '<span class="b-layer-row-label">' + esc(label) + '</span>' +
        '</div>'
      );
      body.appendChild(row);
    });
  }

  function renderAll() {
    renderCanvas();
    renderLayers();
    renderInspector();
  }

  /* ---------------------------------------------------------------
     Inspector — only the fields lib/sections.js actually persists for
     each type. Free text (headings, bodies, quotes) is edited straight
     on the canvas instead; this panel is for structural choices only.
  --------------------------------------------------------------- */
  function field(labelText, innerHtml) {
    return '<div class="b-field">' + (labelText ? '<span class="b-field-label">' + labelText + '</span>' : "") + innerHtml + '</div>';
  }
  function segHtml(name, options, current) {
    return '<div class="b-seg" data-field="' + name + '">' + options.map(function (o) {
      return '<button data-val="' + o.val + '" class="' + (String(o.val) === String(current) ? "active" : "") + '">' + o.label + '</button>';
    }).join("") + '</div>';
  }
  function selectHtml(name, options, current) {
    return '<select class="b-select-native" data-field="' + name + '">' + options.map(function (o) {
      return '<option value="' + o.val + '" ' + (String(o.val) === String(current) ? "selected" : "") + '>' + o.label + '</option>';
    }).join("") + '</select>';
  }
  function textHtml(name, current, placeholder) {
    return '<input class="b-text-native" type="text" data-field="' + name + '" value="' + esc(current || "") + '" placeholder="' + esc(placeholder || "") + '" />';
  }
  function textareaHtml(name, current, placeholder) {
    return '<textarea class="b-text-native b-textarea-native" rows="4" data-field="' + name + '" placeholder="' + esc(placeholder || "") + '">' + esc(current || "") + '</textarea>';
  }
  function dateTimeHtml(name, isoCurrent) {
    return '<input class="b-text-native" type="datetime-local" data-field="' + name + '" value="' + esc(toLocalInputValue(isoCurrent)) + '" />';
  }

  function inspectorFieldsFor(sec) {
    var d = sec.fields;
    switch (sec.type) {
      case "hero":
        return field("", '<div class="b-inspector-hint">Click the heading or subheading on the canvas to edit it.</div>');
      case "text_image":
        return field("Image position", segHtml("side", [{ val: "right", label: "Right" }, { val: "left", label: "Left" }], d.side)) +
          field("Image URL", textHtml("image_url", d.image_url, "https://…")) +
          field("", '<div class="b-inspector-hint">No upload yet — paste a hosted image URL. Click the heading or body text to edit it.</div>');
      case "products":
        return field("Products to show", selectHtml("limit", [{ val: "4", label: "4" }, { val: "8", label: "8" }, { val: "12", label: "12" }, { val: "24", label: "24" }, { val: "48", label: "48" }], String(d.limit))) +
          field("", '<div class="b-inspector-hint">Shows your ' + DATA.products.length + ' most recent products. Click the heading to edit it.</div>');
      case "testimonials":
        return field("", '<div class="b-inspector-hint">Click the heading, quote or name on the canvas to edit it.</div>');
      case "newsletter":
        return field("", '<div class="b-inspector-hint">Click the heading, text or button label on the canvas to edit it. The sign-up form is disabled here so you don’t submit it by accident.</div>');
      case "richtext":
        return field("Width", segHtml("width", [{ val: "narrow", label: "Narrow" }, { val: "wide", label: "Wide" }], d.width)) +
          field("Alignment", segHtml("align", [{ val: "left", label: "Left" }, { val: "center", label: "Center" }], d.align)) +
          field("", '<div class="b-inspector-hint">Click the heading or body text on the canvas to edit it.</div>');
      case "gallery":
        return field("Columns", segHtml("cols", [{ val: "2", label: "2" }, { val: "3", label: "3" }], d.cols)) +
          field("Image URLs", textareaHtml("images", (d.images || []).join("\n"), "One image URL per line, up to 6")) +
          field("", '<div class="b-inspector-hint">No upload yet — paste hosted image URLs, one per line. Click the heading to edit it.</div>');
      case "video":
        return field("Video URL", textHtml("embed_url", d.embed_url, "https://www.youtube.com/embed/…")) +
          field("", '<div class="b-inspector-hint">Paste an embeddable video link — a YouTube/Vimeo “embed” URL works best. Click the heading to edit it.</div>');
      case "spotlight": {
        var prodOptions = DATA.products.map(function (p) { return { val: String(p.id), label: p.title }; });
        var picker = prodOptions.length
          ? selectHtml("product_id", [{ val: "", label: "Choose a product…" }].concat(prodOptions), String(d.product_id || ""))
          : '<div class="b-inspector-hint">Add a product first, then come back here to spotlight it.</div>';
        return field("Product", picker) +
          field("Image position", segHtml("side", [{ val: "right", label: "Right" }, { val: "left", label: "Left" }], d.side)) +
          field("", '<div class="b-inspector-hint">Click the description or button label on the canvas to edit it.</div>');
      }
      case "collections":
        return field("Columns", segHtml("cols", [{ val: "2", label: "2" }, { val: "3", label: "3" }], d.cols)) +
          field("", '<div class="b-inspector-hint">Shows all ' + (DATA.categories ? DATA.categories.length : 0) + ' of your store’s categories automatically. Click the heading to edit it.</div>');
      case "logos":
        return field("Names", textareaHtml("names", (d.names || []).join("\n"), "One name per line, up to 8")) +
          field("", '<div class="b-inspector-hint">Plain text only — good for press mentions or partner names.</div>');
      case "faq":
        return field("", '<div class="b-inspector-hint">Click any question or answer on the canvas to edit it.</div>');
      case "countdown":
        return field("Ends at", dateTimeHtml("end_at", d.end_at)) +
          field("", '<div class="b-inspector-hint">Shown in your local time here, but counts down to the same moment for every visitor. Click the heading to edit it.</div>');
      case "spacer":
        return field("Height", segHtml("height", [{ val: "s", label: "S" }, { val: "m", label: "M" }, { val: "l", label: "L" }, { val: "xl", label: "XL" }], d.height));
      case "divider":
        return field("Style", segHtml("style", [{ val: "line", label: "Line" }, { val: "dots", label: "Dots" }], d.style));
      default:
        return "";
    }
  }

  // Universal "module settings" every section type gets, below its own
  // content fields: a custom CSS class and a raw custom CSS box. Saved
  // through a separate endpoint (saveSettings, below) and separate columns
  // from `fields`, since these apply identically regardless of type.
  function checkHtml(name, checked, labelText) {
    return '<label class="b-check"><input type="checkbox" data-field="' + name + '" ' + (checked ? "checked" : "") + ' /> ' + esc(labelText) + '</label>';
  }

  function spacingPairHtml(topField, bottomField, topVal, bottomVal) {
    return '<div class="b-spacing-pair">' +
      '<label>Top<input class="b-text-native" type="number" min="0" max="400" step="4" data-field="' + topField + '" value="' + (topVal || 0) + '" /></label>' +
      '<label>Bottom<input class="b-text-native" type="number" min="0" max="400" step="4" data-field="' + bottomField + '" value="' + (bottomVal || 0) + '" /></label>' +
    '</div>';
  }

  function sectionSettingsHtml(sec) {
    var resizable = !NO_RESIZE_TYPES[sec.type];
    var heightRow = resizable
      ? field("Height", '<input class="b-text-native" type="number" min="0" max="1200" step="10" data-field="__min_height" value="' + (sec.min_height || 0) + '" />' +
          '<div class="b-field-hint">Drag the handle at the bottom of the section on the canvas, or type a height in pixels. 0 keeps it at its natural height.</div>')
      : "";
    var visibilityRow = field("Show on", '<div class="b-check-row">' +
        checkHtml("__show_desktop", !sec.hide_desktop, "Desktop") +
        checkHtml("__show_tablet", !sec.hide_tablet, "Tablet") +
        checkHtml("__show_mobile", !sec.hide_mobile, "Mobile") +
      '</div>' +
      '<div class="b-field-hint">Uncheck a device to hide this section there only. Preview it with the desktop/tablet/mobile switcher above the canvas.</div>');
    var spacingRows = resizable
      ? field("Margin (space around this section)", spacingPairHtml("__margin_top", "__margin_bottom", sec.margin_top, sec.margin_bottom) +
          '<div class="b-field-hint">Drag the thin handles just above/below the section on the canvas, or type pixels here.</div>') +
        field("Padding (space inside its own edges)", spacingPairHtml("__padding_top", "__padding_bottom", sec.padding_top, sec.padding_bottom))
      : "";
    return '<div class="b-inspector-divider"></div>' +
      '<div class="b-inspector-section-label">Section settings</div>' +
      visibilityRow +
      heightRow +
      spacingRows +
      field("Custom CSS class", textHtml("__custom_class", sec.custom_class, "e.g. my-hero-tweak")) +
      field("Custom CSS", textareaHtml("__custom_css", sec.custom_css, "#" + pzSelector(sec.id) + " {\n  \n}")) +
      field("", '<div class="b-inspector-hint">Applies only to this section on your live storefront. Target it with <code>#' + pzSelector(sec.id) + '</code> to keep changes scoped there.</div>');
  }
  function pzSelector(id) { return "pz-section-" + id; }

  function renderInspector() {
    var panel = document.getElementById("bInspector");
    var sec = state.selectedId ? findSection(state.selectedId) : null;
    if (!sec) { panel.hidden = true; return; }
    panel.hidden = false;
    var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
    document.getElementById("bInspectorIcon").innerHTML = icon(sec.type);
    document.getElementById("bInspectorTitle").textContent = label;
    document.getElementById("bInspectorType").textContent = "section · " + sec.type + (sec.hidden ? " · hidden" : "");
    document.getElementById("bInspectorBody").innerHTML = inspectorFieldsFor(sec) + sectionSettingsHtml(sec);
  }

  /* ---------------------------------------------------------------
     Selection & toolbar actions
  --------------------------------------------------------------- */
  function selectSection(id) {
    state.selectedId = id;
    document.querySelectorAll(".b-csec").forEach(function (n) { n.classList.toggle("is-selected", n.dataset.id === String(id)); });
    document.querySelectorAll(".b-layer-row").forEach(function (n) { n.classList.toggle("selected", n.dataset.id === String(id)); });
    renderInspector();
  }

  function toast(msg, isError) {
    var t = document.getElementById("bToast");
    t.classList.toggle("is-error", !!isError);
    document.getElementById("bToastText").textContent = msg;
    t.hidden = false;
    requestAnimationFrame(function () { t.classList.add("show"); });
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { t.hidden = true; }, 200);
    }, 2000);
  }

  function addSectionAt(type, index) {
    setSaving(true);
    api(BASE, { type: type }).then(function (res) {
      if (!res || !res.ok) { setSaving(false); return toast(res && res.error ? res.error : "Could not add that section.", true); }
      var sec = res.section;
      state.sections.splice(index, 0, sec);
      state.selectedId = sec.id;
      renderAll();
      var label = (SECTION_TYPES[type] && SECTION_TYPES[type].name) || type;
      persistOrder().then(function () { toast(label + " added"); });
    });
  }

  function duplicateSection(id) {
    var idx = indexOf(id);
    if (idx < 0) return;
    var src = state.sections[idx];
    setSaving(true);
    api(BASE, { type: src.type }).then(function (res) {
      if (!res || !res.ok) { setSaving(false); return toast("Could not duplicate that section.", true); }
      var newSec = res.section;
      return api(BASE + "/" + newSec.id, { fields: src.fields }).then(function (fres) {
        newSec.fields = (fres && fres.ok) ? fres.fields : newSec.fields;
        newSec.hidden = src.hidden;
        state.sections.splice(idx + 1, 0, newSec);
        state.selectedId = newSec.id;
        renderAll();
        return persistOrder().then(function () { toast("Section duplicated"); });
      });
    });
  }

  function deleteSection(id) {
    if (!confirm("Delete this section? You can undo it with the undo button (or Ctrl+Z) right after.")) return;
    setSaving(true);
    api(BASE + "/" + id + "/delete").then(function (res) {
      setSaving(false);
      if (!res || !res.ok) return toast("Could not delete that section.", true);
      var idx = indexOf(id);
      if (idx >= 0) state.sections.splice(idx, 1);
      if (state.selectedId === id) state.selectedId = null;
      renderAll();
      commitHistory();
      toast("Section deleted");
    });
  }

  function toggleHidden(id) {
    var sec = findSection(id);
    if (!sec) return;
    setSaving(true);
    api(BASE + "/" + id + "/toggle").then(function (res) {
      setSaving(false);
      if (!res || !res.ok) return toast("Could not update that section.", true);
      sec.hidden = !sec.hidden;
      renderAll();
      commitHistory();
      toast(sec.hidden ? "Hidden from your storefront" : "Now visible on your storefront");
    });
  }

  function saveField(id, patch) {
    setSaving(true);
    return api(BASE + "/" + id, { fields: patch }).then(function (res) {
      setSaving(false);
      if (res && res.ok) {
        var sec = findSection(id);
        if (sec) sec.fields = res.fields;
        commitHistory();
      } else {
        toast("Could not save that change.", true);
      }
    });
  }

  // Universal module settings (custom_class / custom_css) — separate
  // endpoint and columns from saveField()/fields above, since these are the
  // same for every section type rather than type-specific.
  function saveSettings(id, patch) {
    setSaving(true);
    return api(BASE + "/" + id + "/settings", patch).then(function (res) {
      setSaving(false);
      if (res && res.ok) {
        var sec = findSection(id);
        if (sec) {
          if (patch.custom_class !== undefined) sec.custom_class = res.custom_class;
          if (patch.custom_css !== undefined) sec.custom_css = res.custom_css;
          if (patch.min_height !== undefined) sec.min_height = res.min_height;
          if (patch.hide_desktop !== undefined) sec.hide_desktop = res.hide_desktop;
          if (patch.hide_tablet !== undefined) sec.hide_tablet = res.hide_tablet;
          if (patch.hide_mobile !== undefined) sec.hide_mobile = res.hide_mobile;
          if (patch.margin_top !== undefined) sec.margin_top = res.margin_top;
          if (patch.margin_bottom !== undefined) sec.margin_bottom = res.margin_bottom;
          if (patch.padding_top !== undefined) sec.padding_top = res.padding_top;
          if (patch.padding_bottom !== undefined) sec.padding_bottom = res.padding_bottom;
          renderCanvas();
        }
        commitHistory();
      } else {
        toast("Could not save that change.", true);
      }
    });
  }

  /* ---------------------------------------------------------------
     Drag & drop (pointer-based; handles library-insert and reorder)
  --------------------------------------------------------------- */
  var drag = null;

  function sectionEls() { return Array.prototype.slice.call(document.querySelectorAll("#bSortable > .b-csec")); }
  function clearDropMarkers() { document.querySelectorAll(".b-csec").forEach(function (n) { n.classList.remove("is-drop-target-before", "is-drop-target-after"); }); }

  function computeDropIndex(clientY, excludeId) {
    var els = sectionEls().filter(function (n) { return n.dataset.id !== String(excludeId); });
    if (!els.length) return { index: 0, targetEl: null, before: true };
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { index: i, targetEl: els[i], before: true };
    }
    return { index: els.length, targetEl: els[els.length - 1], before: false };
  }
  function showDropMarker(info) {
    clearDropMarkers();
    if (info.targetEl) info.targetEl.classList.add(info.before ? "is-drop-target-before" : "is-drop-target-after");
  }

  function startDrag(e, kind, payload) {
    e.preventDefault();
    var ghost = document.getElementById("bDragGhost");
    var label = kind === "insert" ? (SECTION_TYPES[payload] && SECTION_TYPES[payload].name) || payload : (function () {
      var s = findSection(payload); return (SECTION_TYPES[s.type] && SECTION_TYPES[s.type].name) || s.type;
    })();
    var iconName = kind === "insert" ? payload : findSection(payload).type;
    ghost.innerHTML = icon(iconName) + "<span>" + esc(label) + "</span>";
    ghost.hidden = false;
    drag = { kind: kind, payload: payload };
    moveGhost(e.clientX, e.clientY);

    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      moveGhost(p.clientX, p.clientY);
      var canvasEl = document.getElementById("bCanvas");
      var r = canvasEl.getBoundingClientRect();
      if (p.clientX >= r.left - 40 && p.clientX <= r.right + 40 && p.clientY >= r.top - 20 && p.clientY <= r.bottom + 20) {
        var excl = drag.kind === "reorder" ? drag.payload : null;
        drag.dropInfo = computeDropIndex(p.clientY, excl);
        showDropMarker(drag.dropInfo);
      } else {
        drag.dropInfo = null;
        clearDropMarkers();
      }
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ghost.hidden = true;
      clearDropMarkers();
      finishDrag();
      drag = null;
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function moveGhost(x, y) {
    if (!drag) return;
    var ghost = document.getElementById("bDragGhost");
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
  }

  function finishDrag() {
    if (!drag || !drag.dropInfo) return;
    if (drag.kind === "insert") {
      addSectionAt(drag.payload, drag.dropInfo.index);
    } else if (drag.kind === "reorder") {
      var fromIdx = indexOf(drag.payload);
      if (fromIdx < 0) return;
      var moving = state.sections.splice(fromIdx, 1)[0];
      state.sections.splice(drag.dropInfo.index, 0, moving);
      renderAll();
      persistOrder();
    }
  }

  /* ---------------------------------------------------------------
     Event wiring
  --------------------------------------------------------------- */
  function wireLibrary() {
    document.getElementById("bLibraryBody").addEventListener("pointerdown", function (e) {
      var item = e.target.closest(".b-lib-item");
      if (!item) return;
      startDrag(e, "insert", item.dataset.type);
    });
  }

  function wireLayers() {
    var body = document.getElementById("bLayersBody");
    body.addEventListener("pointerdown", function (e) {
      var handle = e.target.closest('[data-action="drag"]');
      var row = e.target.closest(".b-layer-row");
      if (!row || !handle) return;
      startDrag(e, "reorder", row.dataset.id);
    });
    body.addEventListener("click", function (e) {
      var row = e.target.closest(".b-layer-row");
      if (!row || e.target.closest('[data-action="drag"]')) return;
      selectSection(row.dataset.id);
    });
  }

  function wireCanvas() {
    var canvas = document.getElementById("bCanvas");

    canvas.addEventListener("pointerdown", function (e) {
      var resizeHandle = e.target.closest('[data-action="resize"]');
      if (resizeHandle) {
        var rhost = e.target.closest(".b-csec");
        if (!rhost) return;
        var sec = findSection(rhost.dataset.id);
        if (!sec) return;
        startResize(e, sec, rhost.firstElementChild);
        return;
      }
      var marginHandle = e.target.closest('[data-action="margin-top"], [data-action="margin-bottom"]');
      if (marginHandle) {
        var mhost = e.target.closest(".b-csec");
        if (!mhost) return;
        var msec = findSection(mhost.dataset.id);
        if (!msec) return;
        var side = marginHandle.dataset.action === "margin-top" ? "top" : "bottom";
        startMarginDrag(e, msec, mhost.firstElementChild, side);
        return;
      }
      var handle = e.target.closest('[data-action="drag"]');
      if (!handle) return;
      var host = e.target.closest(".b-csec");
      if (!host) return;
      startDrag(e, "reorder", host.dataset.id);
    });

    canvas.addEventListener("click", function (e) {
      var actionBtn = e.target.closest("[data-action]");
      var host = e.target.closest(".b-csec");
      if (!host) return;
      var id = host.dataset.id;

      if (actionBtn) {
        var action = actionBtn.dataset.action;
        if (action === "dup") return duplicateSection(id);
        if (action === "del") return deleteSection(id);
        if (action === "toggle") return toggleHidden(id);
        if (action === "drag" || action === "resize" || action === "margin-top" || action === "margin-bottom") return;
      }
      selectSection(id);
    });

    canvas.addEventListener("focusout", function (e) {
      var f = e.target.closest("[data-field]");
      if (!f || !f.isContentEditable) return;
      var host = e.target.closest(".b-csec");
      var sec = findSection(host.dataset.id);
      if (!sec) return;
      var key = f.dataset.field;
      var value = f.textContent.trim();
      var patch;
      if (key.indexOf(".") !== -1) {
        // "arrayKey.idx.subKey" (e.g. "quotes.0.author" or "items.2.a") ->
        // { arrayKey: [...] }. Rebuilds every item in the array from
        // whatever's currently live on the canvas for this section, keyed
        // off the existing item's own keys, so editing one field never
        // clobbers its siblings (other items, or the other field on the
        // same item).
        var parts = key.split(".");
        var arrayKey = parts[0], idx = parseInt(parts[1], 10), subKey = parts[2];
        var existingArr = sec.fields[arrayKey] || [];
        var newArr = existingArr.map(function (item, i) {
          var out = Object.assign({}, item);
          Object.keys(item).forEach(function (k) {
            var sibling = host.querySelector('[data-field="' + arrayKey + '.' + i + '.' + k + '"]');
            if (sibling) out[k] = sibling.textContent.trim();
          });
          return out;
        });
        if (newArr[idx]) newArr[idx][subKey] = value;
        patch = {};
        patch[arrayKey] = newArr;
      } else {
        patch = {};
        patch[key] = value;
      }
      saveField(sec.id, patch);
    });
  }

  function wireInspector() {
    document.getElementById("bInspectorBody").addEventListener("click", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var segBtn = e.target.closest(".b-seg button");
      if (segBtn) {
        var wrap = segBtn.closest(".b-seg");
        var patch = {};
        patch[wrap.dataset.field] = segBtn.dataset.val;
        sec.fields[wrap.dataset.field] = segBtn.dataset.val;
        renderAll();
        saveField(sec.id, patch);
      }
    });
    document.getElementById("bInspectorBody").addEventListener("change", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var sel = e.target.closest("select[data-field]");
      if (sel) {
        var patch = {};
        patch[sel.dataset.field] = sel.value;
        sec.fields[sel.dataset.field] = sel.value;
        renderAll();
        saveField(sec.id, patch);
        return;
      }
      // datetime-local reports the admin's own local wall-clock time; convert
      // to a UTC ISO string before saving so the countdown lands on the same
      // real moment for every visitor, whatever timezone they're in.
      var dt = e.target.closest('input[type="datetime-local"][data-field]');
      if (dt) {
        var iso = "";
        if (dt.value) {
          var parsed = new Date(dt.value);
          if (!isNaN(parsed.getTime())) iso = parsed.toISOString();
        }
        var patch2 = {};
        patch2[dt.dataset.field] = iso;
        sec.fields[dt.dataset.field] = iso;
        renderAll();
        saveField(sec.id, patch2);
        return;
      }
      var hin = e.target.closest('input[type="number"][data-field="__min_height"]');
      if (hin) {
        var h = Math.max(0, Math.min(1200, parseInt(hin.value, 10) || 0));
        hin.value = h;
        sec.min_height = h;
        applyHeightStyle(heightRootEl(sec.id), h);
        saveSettings(sec.id, { min_height: h });
        return;
      }
      var spacingIn = e.target.closest('input[type="number"][data-field^="__margin_"], input[type="number"][data-field^="__padding_"]');
      if (spacingIn) {
        var sKey = spacingIn.dataset.field.slice(2); // "__margin_top" -> "margin_top"
        var sVal = Math.max(0, Math.min(400, parseInt(spacingIn.value, 10) || 0));
        spacingIn.value = sVal;
        sec[sKey] = sVal;
        applySpacingStyle(spacingRootEl(sec.id), sec);
        var sPatch = {};
        sPatch[sKey] = sVal;
        saveSettings(sec.id, sPatch);
        return;
      }
      // "Show on Desktop/Tablet/Mobile" checkboxes are the positive framing
      // on screen, but stored/sent as the inverse hide_* flags.
      var showBox = e.target.closest('input[type="checkbox"][data-field^="__show_"]');
      if (showBox) {
        var device = showBox.dataset.field.replace("__show_", "");
        var hideKey = "hide_" + device;
        sec[hideKey] = !showBox.checked;
        var patch3 = {};
        patch3[hideKey] = !showBox.checked;
        saveSettings(sec.id, patch3);
      }
    });
    document.getElementById("bInspectorBody").addEventListener("focusout", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var ta = e.target.closest('textarea.b-textarea-native[data-field]');
      if (ta) {
        // "__custom_css" is a universal module setting, not a type field:
        // saved raw (no line-splitting) through saveSettings(), not saveField().
        if (ta.dataset.field === "__custom_css") {
          sec.custom_css = ta.value;
          saveSettings(sec.id, { custom_css: ta.value });
          return;
        }
        var lines = ta.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
        var patch = {};
        patch[ta.dataset.field] = lines;
        sec.fields[ta.dataset.field] = lines;
        renderAll();
        saveField(sec.id, patch);
        return;
      }
      var input = e.target.closest('input.b-text-native[data-field]');
      if (input && input.type !== "datetime-local" && input.type !== "number") {
        if (input.dataset.field === "__custom_class") {
          sec.custom_class = input.value;
          saveSettings(sec.id, { custom_class: input.value });
          return;
        }
        var patch2 = {};
        patch2[input.dataset.field] = input.value;
        sec.fields[input.dataset.field] = input.value;
        renderCanvas();
        saveField(sec.id, patch2);
      }
    });
  }

  function wireTopbar() {
    document.getElementById("bUndoBtn").addEventListener("click", undo);
    document.getElementById("bRedoBtn").addEventListener("click", redo);

    // Ctrl/Cmd+Z and Ctrl+Y (or Shift+Ctrl/Cmd+Z) drive the builder's own
    // undo stack -- but only when focus isn't inside a text field or
    // contenteditable heading/body, where the same shortcut should keep
    // doing the browser's normal per-keystroke text undo instead.
    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key.toLowerCase() !== "z" && e.key.toLowerCase() !== "y") return;
      var active = document.activeElement;
      var inTextField = active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      if (inTextField) return;
      var key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      else if (key === "y") { e.preventDefault(); redo(); }
    });

    document.getElementById("bViewportToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      document.querySelectorAll("#bViewportToggle button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById("bCanvasFrame").dataset.vp = btn.dataset.vp;
    });

    var publishBtn = document.getElementById("bPublishBtn");
    function paintPublishBtn() {
      publishBtn.textContent = PAGE.status === "published" ? "Unpublish" : "Publish";
      publishBtn.classList.toggle("is-published", PAGE.status === "published");
    }
    paintPublishBtn();
    publishBtn.addEventListener("click", function () {
      var nextStatus = PAGE.status === "published" ? "draft" : "published";
      publishBtn.disabled = true;
      api("/admin/pages/" + PAGE.id + "/publish", { status: nextStatus }).then(function (res) {
        publishBtn.disabled = false;
        if (res && res.ok) {
          PAGE.status = res.status;
          paintPublishBtn();
          toast(PAGE.status === "published" ? "Published to your storefront" : "Unpublished — saved as a draft");
        } else {
          toast("Could not update publish status.", true);
        }
      });
    });
  }

  function wireRail() {
    document.querySelectorAll(".b-rail-btn[data-panel]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".b-rail-btn[data-panel]").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var which = btn.dataset.panel;
        document.getElementById("bPanelLibrary").hidden = which !== "library";
        document.getElementById("bPanelLayers").hidden = which !== "layers";
      });
    });
  }

  /* ---------------------------------------------------------------
     Boot
  --------------------------------------------------------------- */
  renderLibrary();
  renderAll();
  wireLibrary();
  wireLayers();
  wireCanvas();
  wireInspector();
  wireTopbar();
  wireRail();
})();
