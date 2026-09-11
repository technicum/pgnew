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
  // Which of a section type's own text fields can be individually selected
  // on the canvas for their own margin/padding (see lib/sections.js's
  // TEXT_ELEMENT_FIELDS, the single source of truth this mirrors).
  var TEXT_ELEMENT_FIELDS = DATA.textElementFields || {};
  // Every section type's blank-slate fields (lib/sections.js's own
  // defaultFields, mirrored server-side into window.__BUILDER__ — see
  // routes/admin.js's SECTION_DEFAULT_FIELDS) — lets addSectionAt/
  // insertComponent construct a brand-new section entirely client-side now
  // that adding one no longer round-trips to the server (see the Draft /
  // Save architecture below).
  var DEFAULT_FIELDS = DATA.sectionDefaultFields || {};
  function isTextElementField(type, fieldKey) { return (TEXT_ELEMENT_FIELDS[type] || []).indexOf(fieldKey) !== -1; }
  // Which section types a row's column will accept — mirrors lib/sections.js's
  // NESTABLE_SECTION_TYPES (no nested rows, and the 3 types that need their
  // own store-wide data fetch — products/spotlight/collections — are
  // top-level only). Used to grey those out as column drop targets and keep
  // the library-drag-into-column flow from offering them.
  var NESTABLE_TYPES = DATA.nestableTypes || [];
  function isNestable(type) { return NESTABLE_TYPES.indexOf(type) !== -1; }
  // 'page' (a page's own body content), 'header' or 'footer' — the latter
  // two cover both a store's global header/footer and one page's override
  // of it (see routes/admin.js's three builder-rendering routes). Gates
  // which types the library panel offers, mirroring lib/sections.js's own
  // `contexts` on SECTION_TYPES so the canvas never offers a drop the
  // server would then refuse.
  var CONTEXT = DATA.context || "page";
  function isAllowedInContext(type) {
    var def = SECTION_TYPES[type];
    return !!def && (def.contexts || ["page"]).indexOf(CONTEXT) !== -1;
  }
  var BASE = DATA.sectionsBase;
  var COMPONENTS_BASE = "/admin/components";
  // How many row-in-row levels the builder will let a merchant nest —
  // mirrors lib/sections.js's own MAX_ROW_DEPTH exactly (see
  // findBlockInSection/canNestRowAt below); kept as a literal here rather
  // than sent from the server since it's not expected to change independently.
  var MAX_ROW_DEPTH = 3;

  /* ---------------------------------------------------------------
     Icons
  --------------------------------------------------------------- */
  var ICON = {
    hero: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="1.3"/><path d="M6 12.5h8M7.5 9.5h5"/></svg>',
    heading: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4v12M13 4v12M4 10h9"/><path d="M15.5 8.5V13"/></svg>',
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
    divider: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 10h14"/></svg>',
    row: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4" width="6.2" height="12" rx="1"/><rect x="11.3" y="4" width="6.2" height="12" rx="1"/></svg>',
    html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6 3 10l4 4M13 6l4 4-4 4M11.3 4.5 8.7 15.5"/></svg>',
    component: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m10 2.5 6.5 3.4v8.2L10 17.5l-6.5-3.4V5.9L10 2.5Z"/><path d="M3.5 5.9 10 9.3l6.5-3.4M10 9.3v8.2"/></svg>',
    move: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v14M3 10h14M6 6 3.5 8.5M14 6l2.5 2.5M6 14l-2.5-2.5M14 14l2.5-2.5"/></svg>',
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg>',
    // Header/footer builder types.
    logo: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6L10 2.5Z"/><path d="M10 2.5v15M3.5 6l6.5 3.5 6.5-3.5"/></svg>',
    nav_menu: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h8"/></svg>',
    promo_bar: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="15" height="8" rx="1.4"/><path d="M6 10h8"/></svg>',
    link_columns: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4v12M4 6h4M4 9h3M11 4v12M11 6h5M11 9h4M11 12h3.5"/></svg>',
    social_icons: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="5.5" cy="10" r="2.3"/><circle cx="14.5" cy="5.5" r="2.3"/><circle cx="14.5" cy="14.5" r="2.3"/><path d="M7.5 8.8l4.9-2.6M7.5 11.2l4.9 2.6"/></svg>',
    copyright: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M12.3 7.8a2.7 2.7 0 1 0 0 4.4"/></svg>'
  };
  function icon(name) { return ICON[name] || ICON.html; }

  /* ---------------------------------------------------------------
     State — server data is the source of truth; every mutation below
     also fires the matching API call, so "undo" (below) isn't a normal
     in-memory undo either: it replays an earlier snapshot of the section
     list against the database through POST .../sections/restore.
  --------------------------------------------------------------- */
  // selectedFieldKey: the data-field name of a text element that's
  // individually sub-selected within the selected section (e.g. "heading"),
  // for the per-element spacing panel in the inspector — null when just the
  // section itself is selected. Always scoped to state.selectedId's section.
  // inspectorTab: "content" (type-specific fields + the sub-selected
  // element's spacing panel) or "settings" (universal section settings —
  // visibility, height, margin/padding, custom class/CSS). Sticky across
  // selections; selectSection() forces it to "content" when a field is
  // freshly sub-selected, since that's where its panel lives.
  // selectedBlockId: when the sub-selected field belongs to a block nested
  // inside one of a row's columns (rather than a top-level section's own
  // field), this holds that block's id and selectedFieldKey is scoped to it
  // instead. Always cleared together with selectedFieldKey.
  // dirty: true once any edit has been made since the page loaded (or since
  // the last successful Save) — drives the "Unsaved changes" indicator and
  // the Save button's enabled state (see updateDirtyUI/doSave below).
  var state = { sections: DATA.sections.slice(), selectedId: null, selectedFieldKey: null, selectedBlockId: null, inspectorTab: "content", components: (DATA.components || []).slice(), dirty: false };

  function findSection(id) { return state.sections.find(function (s) { return String(s.id) === String(id); }); }
  function indexOf(id) { return state.sections.findIndex(function (s) { return String(s.id) === String(id); }); }

  // Locates one block nested inside a row section's columns by id, wherever
  // it lives — a row can now nest inside another row's column, up to
  // MAX_ROW_DEPTH deep, so this recurses into any block that is itself type
  // "row" rather than only scanning the section's own top-level columns.
  // Returns { block, col, colIndex, blockIndex, containerLevel } or null.
  //
  // containerLevel is the nesting level this exact block was (or would be)
  // validated at server-side by lib/sections.js's sanitizeRowBlock — 1 for a
  // block sitting directly in the top-level section's own columns, 2 for one
  // nested inside a level-1 row's column, 3 for one nested inside a level-2
  // row's column (the deepest MAX_ROW_DEPTH allows). Kept in exact lockstep
  // with sections.js's own depth threading (see its comment) so the canvas
  // never shows a drop as allowed that the server would then silently drop.
  //
  // A row's whole layout is small (<=4 columns, <=6 blocks each, <=3 levels
  // deep) so a recursive scan here is plenty fast.
  function findBlockInSection(sec, blockId) {
    if (!sec || sec.type !== "row" || !sec.fields || !Array.isArray(sec.fields.columns) || !blockId) return null;
    function searchCols(cols, level) {
      for (var c = 0; c < cols.length; c++) {
        var blocks = cols[c].blocks || [];
        for (var b = 0; b < blocks.length; b++) {
          var blk = blocks[b];
          if (String(blk.id) === String(blockId)) {
            return { block: blk, col: cols[c], colIndex: c, blockIndex: b, containerLevel: level };
          }
          if (blk.type === "row" && blk.fields && Array.isArray(blk.fields.columns)) {
            var found = searchCols(blk.fields.columns, level + 1);
            if (found) return found;
          }
        }
      }
      return null;
    }
    return searchCols(sec.fields.columns, 1);
  }

  // Whether a "row" library item can be dropped into the column identified
  // by (sectionId's row section, rowBlockId) without exceeding MAX_ROW_DEPTH
  // — rowBlockId is null/falsy for the top-level section's own columns, or
  // a nested row block's id for one of ITS columns. Mirrors
  // lib/sections.js's sanitizeRowBlock reject condition exactly: a block
  // dropped into a column evaluated at parentLevel only survives (if it's a
  // row) when parentLevel < MAX_ROW_DEPTH.
  function canNestRowAt(sec, rowBlockId) {
    if (!rowBlockId) return 1 < MAX_ROW_DEPTH; // the top-level row's own columns
    var found = findBlockInSection(sec, rowBlockId);
    if (!found || found.block.type !== "row") return false;
    var parentLevel = found.containerLevel + 1; // this row's own level == its columns' parentLevel
    return parentLevel < MAX_ROW_DEPTH;
  }

  function genBlockId() { return "blk_" + Math.random().toString(36).slice(2, 11); }

  // Deep-clones a block (a row's own nested tree included) and regenerates
  // every nested block's id — used when cloning a saved component into a
  // page, so the copy can never collide with an id already used elsewhere
  // on that page (or the component's own stored copy, if inserted twice).
  // The clone's own outer id is left untouched by design: a component
  // inserted at the top level becomes a brand-new page SECTION with a fresh
  // database id assigned server-side (see insertComponent), and one inserted
  // into a column gets a fresh id assigned by the caller — either way this
  // function's caller decides the root id, this only has to guarantee no
  // collisions among what's nested underneath it.
  function cloneWithFreshIds(block) {
    var copy = JSON.parse(JSON.stringify(block));
    function walk(b) {
      if (b.type === "row" && b.fields && Array.isArray(b.fields.columns)) {
        b.fields.columns.forEach(function (col) {
          (col.blocks || []).forEach(function (nb) {
            nb.id = genBlockId();
            walk(nb);
          });
        });
      }
    }
    walk(copy);
    return copy;
  }

  function api(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  // Reordering is a purely local edit now (see the WordPress-style Save
  // button architecture below) — this just records the new order in the
  // undo/redo history and marks the draft dirty; the array's own order IS
  // the order, sent as-is whenever Save runs.
  function persistOrder() {
    commitHistory();
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------
     Draft / Save architecture
     ---------------------------------------------------------------
     Every edit below (add/duplicate/delete/reorder/field/settings/style)
     mutates state.sections in the browser ONLY — nothing reaches the
     database until the merchant clicks the Save button (doSave, wired in
     wireTopbar). This is the WordPress-style trade: no more autosave, an
     explicit "Unsaved changes" / "All changes saved" indicator, and a
     single POST .../sections/save on Save that both persists the whole
     section tree and records it as a new, browsable/restorable revision
     (see wireRevisions and routes/admin.js's scopeSaveSections).

     Undo/redo is a stack of full section-list snapshots, exactly as
     before, except it's now pure client-side state — no network round
     trip — since nothing is live until Save anyway. Every mutating action
     calls commitHistory() once it has settled locally, which snapshots
     state.sections and pushes it on (truncating any redo branch first).
     The undo/redo stack itself is reset to a single checkpoint every time
     Save succeeds (see doSave) — once a change is saved it can't be
     undone past, the same way most editors treat a save as a checkpoint.
  --------------------------------------------------------------- */
  var history = { stack: [cloneSections(state.sections)], index: 0, restoring: false };
  var MAX_HISTORY = 60;

  // A brand-new, not-yet-saved section/component gets one of these instead
  // of a real database id — applySectionsDiff on the server never matches
  // it against an existing row, so it always inserts a fresh one and hands
  // back the real id in the Save response (see doSave). Safe to compare
  // with String(...) === String(...) everywhere ids are already compared.
  function genSectionId() { return "tmp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

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
    state.dirty = true;
    updateHistoryButtons();
    updateDirtyUI();
  }

  function restoreSnapshot(snapshot) {
    history.restoring = true;
    state.sections = cloneSections(snapshot);
    if (state.selectedId && !findSection(state.selectedId)) {
      state.selectedId = null; state.selectedFieldKey = null; state.selectedBlockId = null;
    }
    renderAll();
    updateHistoryButtons();
    updateDirtyUI();
    history.restoring = false;
  }

  function undo() {
    if (history.index <= 0) return;
    history.index--;
    restoreSnapshot(history.stack[history.index]);
    toast("Undid last change");
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    restoreSnapshot(history.stack[history.index]);
    toast("Redid change");
  }

  function updateHistoryButtons() {
    var undoBtn = document.getElementById("bUndoBtn");
    var redoBtn = document.getElementById("bRedoBtn");
    if (undoBtn) undoBtn.disabled = history.index <= 0;
    if (redoBtn) redoBtn.disabled = history.index >= history.stack.length - 1;
  }

  // Paints the "Unsaved changes" / "All changes saved" indicator and
  // enables/disables the Save button to match state.dirty. Once any edit
  // is made this stays "Unsaved changes" until an explicit Save succeeds —
  // undoing back to the original content doesn't clear it (the same
  // conservative call most editors make), so Save is always safe to click.
  function updateDirtyUI() {
    var ind = document.getElementById("bDirtyIndicator");
    var txt = document.getElementById("bDirtyText");
    var btn = document.getElementById("bSaveBtn");
    if (ind) ind.classList.toggle("is-dirty", !!state.dirty);
    if (txt && !ind.classList.contains("is-saving")) txt.textContent = state.dirty ? "Unsaved changes" : "All changes saved";
    if (btn) btn.disabled = !state.dirty;
  }

  // Only toggled around the actual Save network call (see doSave) — a
  // distinct, momentary "Saving…" state layered on top of updateDirtyUI's
  // dirty/clean painting.
  function setSavingUI(on) {
    var ind = document.getElementById("bDirtyIndicator");
    var txt = document.getElementById("bDirtyText");
    if (ind) ind.classList.toggle("is-saving", on);
    if (on && txt) txt.textContent = "Saving…";
  }

  // The Save button's handler — the only place any of this screen's
  // content edits ever reach the server. Sends the full current section
  // tree (including any client-only "tmp_..." ids from sections added or
  // duplicated since the last save) to the scope's /sections/save route,
  // which persists it and records the result as a new revision; adopts the
  // server's response (now carrying real database ids for anything new)
  // as the live state and resets the undo/redo stack to that checkpoint.
  function doSave() {
    if (!state.dirty) return Promise.resolve();
    var btn = document.getElementById("bSaveBtn");
    if (btn) btn.disabled = true;
    setSavingUI(true);
    return api(BASE + "/save", { sections: state.sections }).then(function (res) {
      setSavingUI(false);
      if (!res || !res.ok) {
        toast(res && res.error ? res.error : "Could not save your changes.", true);
        updateDirtyUI();
        return;
      }
      state.sections = res.sections.map(function (s) {
        return Object.assign({}, s, { fields: typeof s.fields === "string" ? JSON.parse(s.fields) : s.fields });
      });
      if (state.selectedId && !findSection(state.selectedId)) {
        state.selectedId = null; state.selectedFieldKey = null; state.selectedBlockId = null;
      }
      state.dirty = false;
      history = { stack: [cloneSections(state.sections)], index: 0, restoring: false };
      updateHistoryButtons();
      updateDirtyUI();
      renderAll();
      toast("Saved");
    }).catch(function () {
      setSavingUI(false);
      updateDirtyUI();
      toast("Could not save your changes — check your connection.", true);
    });
  }

  /* ---------------------------------------------------------------
     Rendering
  --------------------------------------------------------------- */
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  // Wraps the first case-insensitive match of `query` inside `text` in
  // <mark>, HTML-escaping both the matched and unmatched parts — used by
  // the library and page-sections search boxes.
  function highlight(text, query) {
    if (!query) return esc(text);
    var i = text.toLowerCase().indexOf(query.toLowerCase());
    if (i === -1) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + query.length)) + "</mark>" + esc(text.slice(i + query.length));
  }
  // A pointer-based drag that ends somewhere other than where it started
  // still makes the browser fire one native "click" at the release point
  // once pointerup finishes. If that point happens to be a button with its
  // own click handler (e.g. a column's "+" add-block button), the stray
  // click re-fires that handler right after the drag's own drop logic —
  // duplicating or clobbering what the drop just did. Call this at the
  // start of a drop handler to swallow that one trailing click.
  function swallowNextClick() {
    var fn = function (ce) { ce.stopPropagation(); document.removeEventListener("click", fn, true); };
    document.addEventListener("click", fn, true);
    setTimeout(function () { document.removeEventListener("click", fn, true); }, 600);
  }

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

  // ownerBlockId: undefined/null when `sec` is a top-level page section;
  // otherwise the id of the row BLOCK this call is rendering (i.e. `sec` is
  // itself one of a row's nested blocks, passed in recursively from the
  // "row" case below). Only the "row" case reads it — it stamps
  // data-row-owner onto its own column markup so click/drag handlers know
  // which row (the top-level section, or this specific nested row block)
  // a column belongs to, however deep it's nested.
  function renderSectionInner(sec, ownerBlockId) {
    var d = sec.fields;
    switch (sec.type) {
      case "hero":
        var heroBgType = d.bg_type || "none";
        var heroBgStyle = "";
        var heroMedia = "";
        if (heroBgType === "color" && d.bg_color) {
          heroBgStyle = ' style="background:' + esc(d.bg_color) + ';"';
        } else if (heroBgType === "image" && d.bg_image_url) {
          heroBgStyle = ' style="background-image:url(\'' + esc(d.bg_image_url).replace(/'/g, "%27") + '\');background-size:cover;background-position:center;"';
        } else if (heroBgType === "video" && d.bg_video_url) {
          heroMedia = '<video class="b-sec-hero-video" src="' + esc(d.bg_video_url) + '" autoplay muted loop playsinline></video>';
        }
        if ((heroBgType === "image" || heroBgType === "video") && d.bg_overlay) {
          heroMedia += '<div class="b-sec-hero-overlay"></div>';
        }
        var heroLight = heroBgType !== "none" && d.text_theme === "light";
        return '<div class="b-sec-pad b-sec-hero' + (heroBgType !== "none" ? " has-custom-bg" : "") + (heroLight ? " has-light-text" : "") + '"' + heroBgStyle + '>' +
          heroMedia +
          '<h2 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h2>' +
          '<p data-field="subheading" contenteditable="true">' + esc(d.subheading) + '</p></div>';

      case "heading":
        return '<div class="b-sec-pad b-heading b-heading-' + (d.size || "l") + '" style="text-align:' + (d.align || "left") + ';">' +
          '<h2 data-field="heading" contenteditable="true">' + esc(d.heading) + '</h2></div>';

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

      case "html":
        return '<div class="b-sec-pad"><div class="b-html-block-preview b-ph"><div>' + icon("html") +
          '<div class="b-video-hint">Custom HTML/CSS — edit the code in the panel on the right, then use Preview (top bar) to see it rendered. Runs in a sandboxed frame on your live storefront.</div></div></div></div>';

      case "logo":
        return '<div class="b-sec-pad b-logo-block">' +
          (d.image_url
            ? '<img class="b-logo-img" src="' + attrUrl(d.image_url) + '" alt="" style="height:' + (d.height || 32) + 'px;" />'
            : '<span class="b-logo-text">' + esc(STORE.name) + '</span>') +
          '</div>';

      case "nav_menu": {
        // Previews the actual picked menu (see routes/admin.js's
        // loadMenuContext + lib/menus.js's resolveMenu) — already resolved
        // to real labels the moment the page loaded, so switching the
        // picker re-renders instantly with no round trip, the same as the
        // product-grid/collection-list previews above.
        var menuItems = (d.menu_id && DATA.resolvedMenus && DATA.resolvedMenus[d.menu_id]) || [];
        var navHtml = menuItems.length
          ? menuItems.map(function (item) {
              var kids = (item.children || []).length ? ' <span class="b-nav-caret">▾</span>' : "";
              return '<span class="b-nav-link">' + esc(item.label || "(untitled)") + kids + '</span>';
            }).join("")
          : d.menu_id
          ? '<span class="b-prod-empty" style="padding:0;">This menu has no items yet — add some from its editor.</span>'
          : '<span class="b-prod-empty" style="padding:0;">No menu picked yet — choose one from the panel on the right.</span>';
        var navIcons = [];
        if (d.show_search) navIcons.push("Search");
        if (d.show_account) navIcons.push("Account");
        if (d.show_cart) navIcons.push("Cart");
        return '<div class="b-sec-pad b-nav-block"><div class="b-nav-links">' + navHtml + '</div>' +
          (navIcons.length ? '<div class="b-nav-icons">' + navIcons.map(function (n) { return "<span>" + n + "</span>"; }).join("") + '</div>' : '') +
          '</div>';
      }

      case "promo_bar":
        return '<div class="b-promo-bar" style="background:' + esc(d.bg_color || "#111") + ';color:' + esc(d.text_color || "#fff") + ';">' +
          '<span data-field="text" contenteditable="true">' + esc(d.text) + '</span>' +
          (d.link_text ? '<span class="b-promo-link">' + esc(d.link_text) + '</span>' : "") +
          (d.dismissible ? '<span class="b-promo-close">&times;</span>' : "") +
          '</div>';

      case "link_columns": {
        var lcCols = d.columns || [];
        if (!lcCols.length) return '<div class="b-sec-pad"><div class="b-prod-empty">No columns yet — add some from the panel on the right.</div></div>';
        return '<div class="b-sec-pad b-linkcols">' + lcCols.map(function (c) {
          return '<div class="b-linkcol"><h4>' + esc(c.heading || "(untitled)") + '</h4>' +
            (c.links || []).map(function (l) { return '<div class="b-linkcol-link">' + esc(l.label) + '</div>'; }).join("") +
            '</div>';
        }).join("") + '</div>';
      }

      case "social_icons": {
        var socLinks = d.links || [];
        if (!socLinks.length) return '<div class="b-sec-pad"><div class="b-prod-empty">No icons yet — add some from the panel on the right.</div></div>';
        return '<div class="b-sec-pad b-social-icons">' + socLinks.map(function (l) {
          return '<span class="b-social-chip">' + esc(l.platform) + '</span>';
        }).join("") + '</div>';
      }

      case "copyright":
        return '<div class="b-sec-pad b-copyright-block" style="text-align:center;">' +
          '<div data-field="text" contenteditable="true">' + esc(d.text || ("© " + new Date().getFullYear() + " " + STORE.name + ". All rights reserved.")) + '</div>' +
          '<div class="b-copyright-links">' +
          (d.show_powered_by ? "<span>Powered by PageZaper</span>" : "") +
          (d.show_admin_link ? "<span>Store admin</span>" : "") +
          '</div></div>';

      case "row": {
        var cols = d.columns || [];
        if (!cols.length) {
          return '<div class="b-row-picker">' +
            '<p>Pick a column layout to start</p>' +
            '<div class="b-layout-opts">' +
              rowLayoutOptHtml("1", "1 column", ownerBlockId) +
              rowLayoutOptHtml("1,1", "2 equal", ownerBlockId) +
              rowLayoutOptHtml("1,1,1", "3 equal", ownerBlockId) +
              rowLayoutOptHtml("1.6,1", "60 / 40", ownerBlockId) +
            '</div></div>';
        }
        var colsHtml = cols.map(function (col, ci) {
          var blocksHtml = (col.blocks || []).map(function (blk) {
            var blabel = (SECTION_TYPES[blk.type] && SECTION_TYPES[blk.type].name) || blk.type;
            return '<div class="b-row-block" data-block-id="' + esc(blk.id) + '" data-col-index="' + ci + '">' +
              '<span class="b-row-block-tag">' + esc(blabel) + '</span>' +
              '<button class="b-row-block-save" data-block-action="save-component" title="Save as a reusable component">' + icon("component") + '</button>' +
              '<button class="b-row-block-del" data-block-action="del" title="Remove this block">' + icon("trash") + '</button>' +
              renderSectionInner(blk, blk.id) +
              '</div>';
          }).join("");
          var isEmptyCol = !(col.blocks || []).length;
          // The "+" doesn't open a type picker — it just drops in a rich
          // text block as a quick default, same as before — so it's labeled
          // for what it actually does. Dragging any item from the library
          // (or the Components panel) into this column is the real, general
          // way to add a section here, which is what the empty-state hint
          // above the button says outright instead of implying the button
          // itself offers a choice.
          var addHtml = (isEmptyCol ? '<div class="b-row-col-hint">Drop a section on this column</div>' : "") +
            '<button class="b-row-col-add" data-col-add="' + ci + '" data-row-owner="' + esc(ownerBlockId || "") + '" title="Add a rich text block — or drag any section from the library into this column">' +
            icon("plus") + '<span>Add rich text</span></button>';
          return '<div class="b-row-col' + (isEmptyCol ? " is-empty" : "") + '" data-col-drop="' + ci + '" data-row-owner="' + esc(ownerBlockId || "") + '">' + blocksHtml + addHtml + '</div>';
        }).join("");
        var templ = cols.map(function (c) { return (c.width || 1) + "fr"; }).join(" ");
        return '<div class="b-row-inner" style="grid-template-columns:' + templ + ';">' + colsHtml + '</div>';
      }

      default:
        return '<div class="b-sec-pad"><div class="b-inspector-hint">Unknown section type "' + esc(sec.type) + '".</div></div>';
    }
  }

  function rowLayoutOptHtml(colsSpec, label, ownerBlockId) {
    var parts = colsSpec.split(",");
    var bars = parts.map(function (f) { return '<span style="flex:' + f + '"></span>'; }).join("");
    return '<button type="button" class="b-layout-opt" data-row-layout="' + colsSpec + '" data-row-owner="' + esc(ownerBlockId || "") + '"><span class="b-layout-bars">' + bars + '</span><label>' + label + '</label></button>';
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
    rootEl.style.marginLeft = sec.margin_left ? sec.margin_left + "px" : "";
    rootEl.style.marginRight = sec.margin_right ? sec.margin_right + "px" : "";
    rootEl.style.paddingTop = sec.padding_top ? sec.padding_top + "px" : "";
    rootEl.style.paddingBottom = sec.padding_bottom ? sec.padding_bottom + "px" : "";
    rootEl.style.paddingLeft = sec.padding_left ? sec.padding_left + "px" : "";
    rootEl.style.paddingRight = sec.padding_right ? sec.padding_right + "px" : "";
  }

  // Per-element spacing: margin/padding/height on one text field inside a
  // section (e.g. just the Hero heading), applied straight to that field's
  // own contenteditable node — independent of applySpacingStyle above,
  // which is for the section as a whole. Unlike section-level spacing,
  // elements get left/right too (shifting one piece of text within its
  // section is a real thing to want, unlike a full-width section).
  function applyElStyleToNode(node, st) {
    if (!node) return;
    st = st || {};
    // Free positioning (the move handle) takes the field out of normal flow
    // entirely, so it supersedes margin — matches how the storefront's own
    // pzElStyle renders the same field (see section.ejs/block.ejs).
    if (st.positioned) {
      node.style.position = "absolute";
      node.style.left = (st.pos_left || 0) + "px";
      node.style.top = (st.pos_top || 0) + "px";
      node.style.width = st.el_width ? st.el_width + "px" : "";
      node.style.margin = "0";
    } else {
      node.style.position = "";
      node.style.left = "";
      node.style.top = "";
      node.style.width = "";
      node.style.marginTop = st.margin_top ? st.margin_top + "px" : "";
      node.style.marginBottom = st.margin_bottom ? st.margin_bottom + "px" : "";
      node.style.marginLeft = st.margin_left ? st.margin_left + "px" : "";
      node.style.marginRight = st.margin_right ? st.margin_right + "px" : "";
    }
    node.style.paddingTop = st.padding_top ? st.padding_top + "px" : "";
    node.style.paddingBottom = st.padding_bottom ? st.padding_bottom + "px" : "";
    node.style.paddingLeft = st.padding_left ? st.padding_left + "px" : "";
    node.style.paddingRight = st.padding_right ? st.padding_right + "px" : "";
    node.style.minHeight = st.min_height ? st.min_height + "px" : "";
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
      if (sec.element_styles) {
        Object.keys(sec.element_styles).forEach(function (fieldKey) {
          applyElStyleToNode(wrap.querySelector('[data-field="' + fieldKey + '"]'), sec.element_styles[fieldKey]);
        });
      }
      // A row's own text fields (none) vs. its nested blocks' — each block
      // gets its element_styles applied scoped to its own wrapper, since
      // two blocks in the same row can share a field name (e.g. two Rich
      // text blocks each have "heading"/"body").
      if (sec.type === "row") {
        wrap.querySelectorAll("[data-block-id]").forEach(function (blockEl) {
          var found = findBlockInSection(sec, blockEl.dataset.blockId);
          if (!found || !found.block.element_styles) return;
          Object.keys(found.block.element_styles).forEach(function (fieldKey) {
            applyElStyleToNode(blockEl.querySelector('[data-field="' + fieldKey + '"]'), found.block.element_styles[fieldKey]);
          });
        });
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
          '<button data-action="save-component" title="Save as a reusable component">' + icon("component") + '</button>' +
          '<button data-action="toggle" title="' + (sec.hidden ? "Show on storefront" : "Hide from storefront") + '">' + icon(sec.hidden ? "eyeOff" : "eye") + '</button>' +
          '<button data-action="del" title="Delete">' + icon("trash") + '</button>' +
        '</div>'
      );
      wrap.appendChild(toolbar);
      if (resizable) {
        wrap.appendChild(el('<div class="b-csec-resize" data-action="resize" title="Drag to resize this section’s height"><span></span></div>'));
        wrap.appendChild(el('<div class="b-csec-margin b-csec-margin-top" data-action="margin-top" title="Drag to add space above this section"></div>'));
        wrap.appendChild(el('<div class="b-csec-margin b-csec-margin-bottom" data-action="margin-bottom" title="Drag to add space below this section"></div>'));
        wrap.appendChild(el('<div class="b-csec-margin-v b-csec-margin-left" data-action="margin-left" title="Drag to add space to the left of this section"></div>'));
        wrap.appendChild(el('<div class="b-csec-margin-v b-csec-margin-right" data-action="margin-right" title="Drag to add space to the right of this section"></div>'));
      }
      if (sec.id === state.selectedId) {
        wrap.classList.add("is-selected");
        if (state.selectedFieldKey) {
          var selScope = state.selectedBlockId
            ? wrap.querySelector('[data-block-id="' + state.selectedBlockId + '"]')
            : wrap;
          var selFieldEl = selScope ? selScope.querySelector('[data-field="' + state.selectedFieldKey + '"]') : null;
          if (selFieldEl) selFieldEl.classList.add("is-field-selected");
          if (state.selectedBlockId) {
            var selBlockWrap = wrap.querySelector('[data-block-id="' + state.selectedBlockId + '"]');
            if (selBlockWrap) selBlockWrap.classList.add("is-block-selected");
          }
        }
      }
      if (sec.hidden) wrap.classList.add("is-hidden-sec");
      if (sec.hide_desktop) wrap.dataset.hideDesktop = "1";
      if (sec.hide_tablet) wrap.dataset.hideTablet = "1";
      if (sec.hide_mobile) wrap.dataset.hideMobile = "1";
      sortable.appendChild(wrap);
    });
    // The element-handle overlay lives inside whichever .b-csec currently
    // has a sub-selected field — but renderCanvas just rebuilt every .b-csec
    // from scratch, so it needs to be re-parented and repositioned onto the
    // fresh node for that field.
    positionElementHandles();
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
      positionElementHandles();
      var input = liveInput();
      if (input) input.value = h;
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      var finalHeight = clamp(parseFloat(rootEl.style.minHeight) || 0);
      applyHeightStyle(rootEl, finalHeight);
      sec.min_height = finalHeight;
      positionElementHandles();
      var input = liveInput();
      if (input) input.value = finalHeight;
      saveSettings(sec.id, { min_height: finalHeight });
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // A drag handle's direction maps to which mouse axis drives it and which
  // way along that axis grows the value — shared by both the section-level
  // margin handles below and the per-element ones further down. Dragging
  // the TOP/LEFT handle further up/left grows that side's spacing; dragging
  // BOTTOM/RIGHT further down/right grows that side.
  function spacingAxis(direction) { return (direction === "left" || direction === "right") ? "x" : "y"; }
  function spacingSign(direction) { return (direction === "top" || direction === "left") ? -1 : 1; }

  // Drag-to-stretch for the gutter/edge margin handles around a section --
  // its own small pointer session, parallel to startResize above but for a
  // different property (margin-top/bottom/left/right instead of min-height).
  function startMarginDrag(e, sec, rootEl, direction) {
    if (!rootEl) return;
    e.preventDefault();
    e.stopPropagation();
    var axis = spacingAxis(direction);
    var startPos = axis === "x" ? e.clientX : e.clientY;
    var key = "margin_" + direction;
    var startVal = sec[key] || 0;
    var sign = spacingSign(direction);

    function clamp(n) { return Math.max(0, Math.min(400, Math.round(n))); }
    function liveInput() { return document.querySelector('input[type="number"][data-field="__' + key + '"]'); }

    function apply(v) {
      sec[key] = v;
      applySpacingStyle(rootEl, sec);
      positionElementHandles();
      var input = liveInput();
      if (input) input.value = v;
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      var pos = axis === "x" ? p.clientX : p.clientY;
      apply(clamp(startVal + sign * (pos - startPos)));
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

  /* ---------------------------------------------------------------
     Per-element spacing overlay — a small floating set of drag handles
     that tracks whichever text element is currently sub-selected
     (state.selectedFieldKey). Built once at boot and re-parented onto the
     live field node whenever the selection or the canvas DOM changes,
     rather than inserted as a sibling of the text itself: these fields sit
     inside all sorts of surrounding layouts (flex rows next to other
     content, grids, etc), and a handle spliced into that flow would
     visually disrupt it. An absolutely-positioned overlay, sized to match
     the field's own bounding box each time, works regardless of what's
     around it and never touches the field's own (contenteditable) DOM.
  --------------------------------------------------------------- */
  var elementHandles = el(
    '<div class="b-el-handles" id="bElementHandles" hidden>' +
      '<div class="b-el-move" data-el-action="move" title="Drag to move this text anywhere in its section">' + icon("move") + '</div>' +
      '<div class="b-el-margin b-el-margin-top" data-el-action="margin-top" title="Drag to add space above"></div>' +
      '<div class="b-el-margin b-el-margin-bottom" data-el-action="margin-bottom" title="Drag to add space below"></div>' +
      '<div class="b-el-margin-v b-el-margin-left" data-el-action="margin-left" title="Drag to add space to the left"></div>' +
      '<div class="b-el-margin-v b-el-margin-right" data-el-action="margin-right" title="Drag to add space to the right"></div>' +
      '<div class="b-el-resize" data-el-action="resize" title="Drag to increase this text’s height"><span></span></div>' +
    '</div>'
  );
  document.body.appendChild(elementHandles);
  // Center-snap guides for the move handle, shared across drags the same
  // way elementHandles itself is — created once, shown/hidden/repositioned
  // rather than inserted and removed each time.
  var guideV = el('<div class="b-el-guide b-el-guide-v" hidden></div>');
  var guideH = el('<div class="b-el-guide b-el-guide-h" hidden></div>');
  document.body.appendChild(guideV);
  document.body.appendChild(guideH);

  // Resolves the sub-selected field to its live DOM node, whether it's a
  // top-level section's own field or one nested inside a row block
  // (state.selectedBlockId) — and, in the block case, that the block still
  // exists (it may have just been removed).
  function selectedFieldNode() {
    if (!state.selectedId || !state.selectedFieldKey) return null;
    var sec = findSection(state.selectedId);
    if (!sec) return null;
    var wrap = document.querySelector('.b-csec[data-id="' + state.selectedId + '"]');
    if (!wrap) return null;
    if (state.selectedBlockId) {
      var found = findBlockInSection(sec, state.selectedBlockId);
      if (!found || !isTextElementField(found.block.type, state.selectedFieldKey)) return null;
      var blockWrap = wrap.querySelector('[data-block-id="' + state.selectedBlockId + '"]');
      return blockWrap ? blockWrap.querySelector('[data-field="' + state.selectedFieldKey + '"]') : null;
    }
    if (!isTextElementField(sec.type, state.selectedFieldKey)) return null;
    return wrap.querySelector('[data-field="' + state.selectedFieldKey + '"]');
  }

  // The box a moved/positioned element is confined to: a block's own
  // wrapper when nested inside a row column (so its text can't wander over
  // a sibling block in the same column), otherwise the whole section.
  function elementBoundsEl(node) {
    return node.closest("[data-block-id]") || node.closest(".b-csec");
  }

  // Moves/sizes the overlay to exactly cover the sub-selected field's own
  // box. Both rects are viewport-relative, so their difference is correct
  // regardless of how the canvas is scrolled — no scroll-container math
  // needed, same trick sections' own position:relative handles rely on.
  function positionElementHandles() {
    var node = selectedFieldNode();
    if (!node) { elementHandles.hidden = true; return; }
    var wrap = elementBoundsEl(node);
    if (!wrap) { elementHandles.hidden = true; return; }
    if (elementHandles.parentNode !== wrap) wrap.appendChild(elementHandles);
    var wrapRect = wrap.getBoundingClientRect();
    var nodeRect = node.getBoundingClientRect();
    elementHandles.style.top = (nodeRect.top - wrapRect.top) + "px";
    elementHandles.style.left = (nodeRect.left - wrapRect.left) + "px";
    elementHandles.style.width = nodeRect.width + "px";
    elementHandles.style.height = nodeRect.height + "px";
    elementHandles.hidden = false;
  }

  // Everything that reads/writes the sub-selected field's own element_styles
  // and persists it — abstracted here because a top-level section's field
  // and a row block's field are stored (and saved) differently: the former
  // in that section's own element_styles column via the dedicated
  // /element-style endpoint, the latter inside sec.fields.columns via the
  // generic fields endpoint (see saveField). Returns null if nothing valid
  // is currently sub-selected.
  function elementStyleCtx() {
    if (!state.selectedId || !state.selectedFieldKey) return null;
    var sec = findSection(state.selectedId);
    if (!sec) return null;
    var fieldKey = state.selectedFieldKey;
    if (state.selectedBlockId) {
      var found = findBlockInSection(sec, state.selectedBlockId);
      if (!found) return null;
      return {
        sec: sec, fieldKey: fieldKey,
        getEntry: function () { return (found.block.element_styles && found.block.element_styles[fieldKey]) || {}; },
        setEntry: function (entry) {
          found.block.element_styles = found.block.element_styles || {};
          found.block.element_styles[fieldKey] = entry;
        },
        persist: function () { saveField(sec.id, { columns: sec.fields.columns }); },
      };
    }
    return {
      sec: sec, fieldKey: fieldKey,
      getEntry: function () { return (sec.element_styles && sec.element_styles[fieldKey]) || {}; },
      setEntry: function (entry) {
        sec.element_styles = sec.element_styles || {};
        sec.element_styles[fieldKey] = entry;
      },
      persist: function (patch) { saveElementStyle(sec.id, Object.assign({ field: fieldKey }, patch)); },
    };
  }

  // Which "fields" object and save path the inspector Content tab's
  // structural controls (segmented buttons, selects, textareas, text
  // inputs — not the per-element spacing/position panel above, which has
  // its own elementStyleCtx) are currently pointed at: the selected
  // section's own fields, or — when a row block is selected — that block's,
  // saved back through the generic fields endpoint the same way any other
  // columns edit is (see saveField/setRowLayout/insertBlockIntoColumn).
  function inspectorFieldTarget() {
    if (!state.selectedId) return null;
    var sec = findSection(state.selectedId);
    if (!sec) return null;
    if (state.selectedBlockId) {
      var found = findBlockInSection(sec, state.selectedBlockId);
      if (!found) return null;
      return {
        fields: found.block.fields,
        save: function (patch) {
          Object.assign(found.block.fields, patch);
          renderAll();
          saveField(sec.id, { columns: sec.fields.columns });
        },
      };
    }
    return {
      fields: sec.fields,
      save: function (patch) {
        Object.assign(sec.fields, patch);
        renderAll();
        saveField(sec.id, patch);
      },
    };
  }

  function startElementSpacingDrag(e, ctx, node, direction) {
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    var axis = spacingAxis(direction);
    var startPos = axis === "x" ? e.clientX : e.clientY;
    var key = "margin_" + direction;
    var current = ctx.getEntry()[key] || 0;
    var sign = spacingSign(direction);

    function clamp(n) { return Math.max(0, Math.min(400, Math.round(n))); }
    function liveInput() { return document.querySelector('input[type="number"][data-field="__elm_' + key + '"][data-el-field="' + ctx.fieldKey + '"]'); }

    function apply(v) {
      var entry = Object.assign({}, ctx.getEntry());
      entry[key] = v;
      ctx.setEntry(entry);
      applyElStyleToNode(node, entry);
      positionElementHandles();
      var input = liveInput();
      if (input) input.value = v;
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      var pos = axis === "x" ? p.clientX : p.clientY;
      apply(clamp(current + sign * (pos - startPos)));
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      var patch = {};
      patch[key] = ctx.getEntry()[key] || 0;
      ctx.persist(patch);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function startElementResize(e, ctx, node) {
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    var startY = e.clientY;
    var startHeight = node.getBoundingClientRect().height;

    function clamp(n) { return Math.max(0, Math.min(800, Math.round(n))); }
    function liveInput() { return document.querySelector('input[type="number"][data-field="__elm_min_height"][data-el-field="' + ctx.fieldKey + '"]'); }

    function apply(v) {
      var entry = Object.assign({}, ctx.getEntry());
      entry.min_height = v;
      ctx.setEntry(entry);
      applyElStyleToNode(node, entry);
      positionElementHandles();
      var input = liveInput();
      if (input) input.value = v;
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      apply(clamp(startHeight + (p.clientY - startY)));
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      ctx.persist({ min_height: ctx.getEntry().min_height || 0 });
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // Free move — drags the field out of normal flow onto an explicit spot
  // anywhere inside its bounds (elementBoundsEl: the block it's nested in,
  // or the whole section). Width is frozen at the moment it leaves flow (so
  // the box doesn't shrink to fit its own text once nothing is stretching
  // it), and dragging near the bounds' own center snaps to it, mirroring
  // the concept preview this was built from.
  function startElementMove(e, ctx, node) {
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    var bounds = elementBoundsEl(node);
    if (!bounds) return;
    var boundsRect = bounds.getBoundingClientRect();
    var startRect = node.getBoundingClientRect();
    var offX = e.clientX - startRect.left, offY = e.clientY - startRect.top;
    var entryStart = Object.assign({}, ctx.getEntry());
    if (!entryStart.positioned) {
      entryStart.positioned = true;
      entryStart.pos_left = Math.round(startRect.left - boundsRect.left);
      entryStart.pos_top = Math.round(startRect.top - boundsRect.top);
      entryStart.el_width = Math.round(startRect.width);
      ctx.setEntry(entryStart);
      applyElStyleToNode(node, entryStart);
    }

    function clampPos(n) { return Math.max(0, Math.min(4000, Math.round(n))); }
    function liveInputs() {
      return {
        left: document.querySelector('input[type="number"][data-field="__elm_pos_left"][data-el-field="' + ctx.fieldKey + '"]'),
        top: document.querySelector('input[type="number"][data-field="__elm_pos_top"][data-el-field="' + ctx.fieldKey + '"]'),
      };
    }
    function apply(left, top, showGuides) {
      var entry = Object.assign({}, ctx.getEntry());
      entry.pos_left = left;
      entry.pos_top = top;
      ctx.setEntry(entry);
      applyElStyleToNode(node, entry);
      positionElementHandles();
      var inputs = liveInputs();
      if (inputs.left) inputs.left.value = left;
      if (inputs.top) inputs.top.value = top;
      if (showGuides) { showGuides.v.hidden = !showGuides.snapX; showGuides.h.hidden = !showGuides.snapY; }
    }
    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      var br = bounds.getBoundingClientRect();
      var w = node.offsetWidth, h = node.offsetHeight;
      var left = p.clientX - br.left - offX;
      var top = p.clientY - br.top - offY;
      left = Math.max(0, Math.min(left, Math.max(0, br.width - w)));
      top = Math.max(0, Math.min(top, Math.max(0, br.height - h)));
      var centerX = br.width / 2, centerY = br.height / 2;
      var snapX = Math.abs((left + w / 2) - centerX) < 8;
      var snapY = Math.abs((top + h / 2) - centerY) < 8;
      if (snapX) left = centerX - w / 2;
      if (snapY) top = centerY - h / 2;
      if (snapX) { guideV.style.left = (br.left + centerX) + "px"; guideV.style.top = br.top + "px"; guideV.style.height = br.height + "px"; }
      if (snapY) { guideH.style.top = (br.top + centerY) + "px"; guideH.style.left = br.left + "px"; guideH.style.width = br.width + "px"; }
      apply(clampPos(left), clampPos(top), { v: guideV, h: guideH, snapX: snapX, snapY: snapY });
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      guideV.hidden = true;
      guideH.hidden = true;
      var entry = ctx.getEntry();
      ctx.persist({ positioned: true, pos_left: entry.pos_left || 0, pos_top: entry.pos_top || 0, el_width: entry.el_width || 0 });
      // The inspector's Position row (X/Y inputs, "Reset to normal
      // position") only renders once st.positioned is true, so the very
      // first move re-renders the inspector to bring it in — every drag
      // after that already has it on screen.
      renderInspector();
      positionElementHandles();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  elementHandles.addEventListener("pointerdown", function (e) {
    var actionEl = e.target.closest("[data-el-action]");
    if (!actionEl) return;
    e.stopPropagation();
    // A real drag ends with the pointer wherever it was released — not
    // necessarily still over the handle it started on (the move handle
    // especially: the field follows the cursor, but clamping against its
    // bounds can leave the cursor just past the field's edge). The browser
    // still fires a synthetic "click" at that release point once the
    // pointerup completes, and canvas's own click handler would read that
    // as "the user clicked this other spot" and clear/replace the very
    // sub-selection this drag just set. Swallow exactly that one click,
    // caught in the capture phase so it never reaches canvas's listener.
    var swallowClick = function (ce) { ce.stopPropagation(); document.removeEventListener("click", swallowClick, true); };
    document.addEventListener("click", swallowClick, true);
    setTimeout(function () { document.removeEventListener("click", swallowClick, true); }, 600);
    var ctx = elementStyleCtx();
    var node = selectedFieldNode();
    if (!ctx || !node) return;
    var action = actionEl.dataset.elAction;
    if (action === "resize") return startElementResize(e, ctx, node);
    if (action === "move") return startElementMove(e, ctx, node);
    startElementSpacingDrag(e, ctx, node, action.replace("margin-", ""));
  });

  var LIB_GROUP_ORDER = ["Content", "Commerce", "Engagement", "Layout"];

  function renderLibrary() {
    var body = document.getElementById("bLibraryBody");
    var clearBtn = document.getElementById("bLibSearchClear");
    var q = (document.getElementById("bLibSearch") || {}).value || "";
    q = q.trim();
    if (clearBtn) clearBtn.hidden = !q;
    body.innerHTML = "";
    var byGroup = {};
    Object.keys(SECTION_TYPES).forEach(function (type) {
      if (!isAllowedInContext(type)) return;
      var g = SECTION_TYPES[type].group || "More";
      (byGroup[g] = byGroup[g] || []).push(type);
    });
    var groups = LIB_GROUP_ORDER.concat(Object.keys(byGroup).filter(function (g) { return LIB_GROUP_ORDER.indexOf(g) === -1; }));
    var anyVisible = false;
    groups.forEach(function (g) {
      var types = byGroup[g];
      if (!types || !types.length) return;
      var matchingTypes = types.filter(function (type) {
        return !q || SECTION_TYPES[type].name.toLowerCase().indexOf(q.toLowerCase()) !== -1;
      });
      if (!matchingTypes.length) return;
      anyVisible = true;
      var groupEl = el('<div class="b-lib-group"><div class="b-lib-group-label">' + esc(g) + '</div></div>');
      matchingTypes.forEach(function (type) {
        var row = el(
          '<div class="b-lib-item" data-type="' + type + '">' +
            '<div class="b-lib-item-icon">' + icon(type) + '</div>' +
            '<div class="b-lib-item-label">' + highlight(SECTION_TYPES[type].name, q) + '</div>' +
          '</div>'
        );
        groupEl.appendChild(row);
      });
      body.appendChild(groupEl);
    });
    if (!anyVisible) {
      body.appendChild(el('<div class="b-side-no-results">No sections match “' + esc(q) + '”.</div>'));
    } else if (!q) {
      body.appendChild(el('<div class="b-lib-note">More section types are on the way — new ones will show up in this list as they ship.</div>'));
    }
  }

  function renderLayers() {
    var body = document.getElementById("bLayersBody");
    var clearBtn = document.getElementById("bLayerSearchClear");
    var q = (document.getElementById("bLayerSearch") || {}).value || "";
    q = q.trim();
    if (clearBtn) clearBtn.hidden = !q;
    body.innerHTML = "";
    if (!state.sections.length) {
      body.innerHTML = '<div class="b-layer-empty">No sections yet</div>';
      return;
    }
    var anyVisible = false;
    state.sections.forEach(function (sec) {
      var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
      var matches = !q || label.toLowerCase().indexOf(q.toLowerCase()) !== -1;
      if (!matches) return;
      anyVisible = true;
      var row = el(
        '<div class="b-layer-row ' + (sec.id === state.selectedId ? "selected" : "") + ' ' + (sec.hidden ? "is-hidden" : "") + '" data-id="' + sec.id + '">' +
          '<span class="b-drag-handle" data-action="drag">' + icon("drag") + '</span>' +
          '<span class="b-layer-row-icon">' + icon(sec.type) + '</span>' +
          '<span class="b-layer-row-label">' + highlight(label, q) + '</span>' +
        '</div>'
      );
      body.appendChild(row);
    });
    if (!anyVisible) {
      body.appendChild(el('<div class="b-side-no-results">No sections on this page match “' + esc(q) + '”.</div>'));
    }
  }

  // The Components panel — saved, reusable blocks (almost always a
  // configured row) a merchant built once and can drop onto any page on
  // their store. See saveAsComponent (how they get here) and insertComponent
  // (what "Insert" does) above.
  function renderComponents() {
    var body = document.getElementById("bComponentsBody");
    if (!body) return;
    body.innerHTML = "";
    if (!state.components.length) {
      body.innerHTML = '<div class="b-layer-empty">No components yet — save one from any section or row block’s own toolbar (the bookmark icon) to reuse it on other pages.</div>';
      return;
    }
    // A saved component always inserts as a top-level section on whichever
    // canvas is open — same top-level restriction as the section library
    // (isAllowedInContext), so a page-only component (e.g. a saved
    // products row) doesn't show up, and fail, on the header/footer canvas.
    var visibleComponents = state.components.filter(function (comp) { return isAllowedInContext(comp.block.type); });
    if (!visibleComponents.length) {
      body.innerHTML = '<div class="b-layer-empty">No components for this canvas yet.</div>';
      return;
    }
    visibleComponents.forEach(function (comp) {
      var label = (SECTION_TYPES[comp.block.type] && SECTION_TYPES[comp.block.type].name) || comp.block.type;
      var row = el(
        '<div class="b-comp-item">' +
          '<div class="b-lib-item-icon">' + icon(comp.block.type) + '</div>' +
          '<div class="b-comp-item-body">' +
            '<div class="b-comp-item-name">' + esc(comp.name) + '</div>' +
            '<div class="b-comp-item-type">' + esc(label) + '</div>' +
          '</div>' +
          '<button type="button" class="b-btn-outline b-comp-insert" data-comp-insert="' + comp.id + '">Insert</button>' +
          '<button type="button" class="b-comp-del" data-comp-del="' + comp.id + '" title="Remove from your library">' + icon("trash") + '</button>' +
        '</div>'
      );
      body.appendChild(row);
    });
  }

  function wireComponents() {
    var body = document.getElementById("bComponentsBody");
    if (!body) return;
    body.addEventListener("click", function (e) {
      var insertBtn = e.target.closest("[data-comp-insert]");
      if (insertBtn) {
        var comp = state.components.filter(function (c) { return String(c.id) === insertBtn.dataset.compInsert; })[0];
        if (comp) insertComponent(comp);
        return;
      }
      var delBtn = e.target.closest("[data-comp-del]");
      if (delBtn) deleteComponent(delBtn.dataset.compDel);
    });
  }

  // Scrolls the canvas to a section (used when a Page sections search
  // result or row is clicked) and gives it a brief highlight flash so the
  // jump is visible even when the section was already on screen.
  function jumpToSection(id) {
    var wrap = document.querySelector('.b-csec[data-id="' + id + '"]');
    if (!wrap) return;
    wrap.scrollIntoView({ behavior: "smooth", block: "center" });
    wrap.classList.add("is-flash-target");
    setTimeout(function () { wrap.classList.remove("is-flash-target"); }, 900);
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
  function colorHtml(name, current) {
    return '<input class="b-color-native" type="color" data-field="' + name + '" value="' + esc(current || "#ffffff") + '" />';
  }
  function dateTimeHtml(name, isoCurrent) {
    return '<input class="b-text-native" type="datetime-local" data-field="' + name + '" value="' + esc(toLocalInputValue(isoCurrent)) + '" />';
  }

  // ---- Text <-> structured-data helpers for the header/footer link
  // fields (link_columns.columns, social_icons.links). Each is edited as
  // plain lines in a textarea rather than a repeating add-row UI, then
  // parsed back into the shape lib/sections.js expects on focusout (see
  // wireInspector below). nav_menu used to have one here too, but it now
  // just points at a saved menu (see the "nav_menu" case above) built on
  // its own screen (views/admin/menu-edit.ejs), so there's no more
  // text-editing of its links here.
  var SOCIAL_PLATFORMS = ["instagram", "facebook", "twitter", "youtube", "tiktok", "pinterest", "linkedin", "custom"];

  // link_columns — a "# Heading" line starts a new column, followed by
  // its "Label | url" link lines.
  function parseColumnsText(text) {
    var out = [];
    (text || "").split("\n").forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (line.charAt(0) === "#") {
        out.push({ heading: line.slice(1).trim(), links: [] });
      } else {
        if (!out.length) out.push({ heading: "", links: [] });
        var parts = line.split("|");
        out[out.length - 1].links.push({ label: (parts[0] || "").trim(), url: (parts[1] || "").trim() });
      }
    });
    return out;
  }
  function columnsToText(columns) {
    return (columns || []).map(function (c) {
      var lines = ["# " + (c.heading || "")];
      (c.links || []).forEach(function (l) { lines.push((l.label || "") + " | " + (l.url || "")); });
      return lines.join("\n");
    }).join("\n\n");
  }

  // social_icons — "platform | url" per line; platform is matched
  // case-insensitively against SOCIAL_PLATFORMS, falling back to "custom".
  function parseSocialText(text) {
    var out = [];
    (text || "").split("\n").forEach(function (raw) {
      if (!raw.trim()) return;
      var parts = raw.split("|");
      var platform = (parts[0] || "").trim().toLowerCase();
      if (SOCIAL_PLATFORMS.indexOf(platform) === -1) platform = "custom";
      out.push({ platform: platform, url: (parts[1] || "").trim() });
    });
    return out;
  }
  function socialToText(links) {
    return (links || []).map(function (l) { return (l.platform || "custom") + " | " + (l.url || ""); }).join("\n");
  }

  function inspectorFieldsFor(sec) {
    var d = sec.fields;
    switch (sec.type) {
      case "hero": {
        var heroBg = d.bg_type || "none";
        var heroBgFields = "";
        if (heroBg === "color") {
          heroBgFields = field("Background color", colorHtml("bg_color", d.bg_color));
        } else if (heroBg === "image") {
          heroBgFields = field("Background image URL", textHtml("bg_image_url", d.bg_image_url, "https://…")) +
            field("", checkHtml("bg_overlay", !!d.bg_overlay, "Darken for text readability"));
        } else if (heroBg === "video") {
          heroBgFields = field("Background video URL", textHtml("bg_video_url", d.bg_video_url, "https://….mp4")) +
            field("", '<div class="b-inspector-hint">A direct video file link (.mp4 or .webm) — YouTube/Vimeo links won’t play here.</div>') +
            field("", checkHtml("bg_overlay", !!d.bg_overlay, "Darken for text readability"));
        }
        var heroTextTheme = heroBg !== "none"
          ? field("Text color", segHtml("text_theme", [{ val: "dark", label: "Dark" }, { val: "light", label: "Light" }], d.text_theme || "dark"))
          : "";
        return field("Heading", textHtml("heading", d.heading)) +
          field("Subheading", textareaHtml("subheading", d.subheading)) +
          field("Background", segHtml("bg_type", [{ val: "none", label: "None" }, { val: "color", label: "Color" }, { val: "image", label: "Image" }, { val: "video", label: "Video" }], heroBg)) +
          heroBgFields +
          heroTextTheme +
          field("", '<div class="b-inspector-hint">You can also click the heading or subheading directly on the canvas to edit it.</div>');
      }
      case "heading":
        return field("Size", selectHtml("size", [{ val: "s", label: "Small" }, { val: "m", label: "Medium" }, { val: "l", label: "Large" }, { val: "xl", label: "Extra large" }], d.size || "l")) +
          field("Alignment", segHtml("align", [{ val: "left", label: "Left" }, { val: "center", label: "Center" }, { val: "right", label: "Right" }], d.align || "left")) +
          field("", '<div class="b-inspector-hint">Click the heading on the canvas to edit it.</div>');
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
      case "row":
        return field("", '<div class="b-inspector-hint">' +
          (d.columns && d.columns.length
            ? "Drag any section from the library into a column, or click its + button — including another Row, to nest layouts inside each other. Click any text inside a column to edit it, the same way you edit a top-level section."
            : "Pick a column layout on the canvas to get started.") +
          '</div>');
      case "html":
        return field("HTML", textareaHtml("html", d.html, "<div class=\"my-block\">…</div>")) +
          field("CSS (optional)", textareaHtml("css", d.css, ".my-block { }")) +
          field("", '<div class="b-inspector-hint">Renders in a sandboxed frame on your live storefront — scripts run isolated from the rest of your site and can’t read its cookies or data. For developers comfortable writing raw markup; there’s no visual preview here, use Preview (top bar) to see it rendered.</div>');
      case "logo":
        return field("Image URL", textHtml("image_url", d.image_url, "https://…")) +
          field("Height (px)", textHtml("height", d.height, "32")) +
          field("", '<div class="b-inspector-hint">No upload yet — paste a hosted image URL. Leave it blank to show your store name as text instead.</div>');
      case "nav_menu": {
        var menuOptions = [{ val: "", label: "— No menu picked —" }].concat(
          (DATA.menus || []).map(function (m) { return { val: String(m.id), label: esc(m.name) }; })
        );
        var menuHint = (DATA.menus || []).length
          ? 'Pick which saved menu this shows. <a href="/admin/menus" target="_blank" rel="noopener">Manage menus</a> to add, remove, or reorder its links — changes there show up here and on your storefront automatically.'
          : 'You don’t have any menus yet. <a href="/admin/menus" target="_blank" rel="noopener">Create one</a>, then come back and pick it here.';
        return field("Menu", selectHtml("menu_id", menuOptions, String(d.menu_id || ""))) +
          field("", '<div class="b-inspector-hint">' + menuHint + '</div>') +
          field("", checkHtml("show_search", !!d.show_search, "Show search icon")) +
          field("", checkHtml("show_account", !!d.show_account, "Show account icon")) +
          field("", checkHtml("show_cart", !!d.show_cart, "Show cart icon"));
      }
      case "promo_bar":
        return field("Link URL (optional)", textHtml("link_url", d.link_url, "https://…")) +
          field("Link text", textHtml("link_text", d.link_text, "Shop now")) +
          field("Background color", colorHtml("bg_color", d.bg_color)) +
          field("Text color", colorHtml("text_color", d.text_color)) +
          field("", checkHtml("dismissible", !!d.dismissible, "Let visitors dismiss it")) +
          field("", '<div class="b-inspector-hint">Click the message on the canvas to edit it.</div>');
      case "link_columns":
        return field("Columns", textareaHtml("columns", columnsToText(d.columns), "# Shop\nHoodies | /shop/hoodies\nT-shirts | /shop/tshirts\n\n# Support\nContact | /pages/contact")) +
          field("", '<div class="b-inspector-hint">Start each column with “# Heading”, then list its links as “Label | URL”, one per line.</div>');
      case "social_icons":
        return field("Icons", textareaHtml("links", socialToText(d.links), "instagram | https://instagram.com/…\nfacebook | https://facebook.com/…")) +
          field("", '<div class="b-inspector-hint">One per line as “platform | URL”. Platforms: ' + SOCIAL_PLATFORMS.join(", ") + '.</div>');
      case "copyright":
        return field("", checkHtml("show_powered_by", !!d.show_powered_by, "Show “Powered by PageZaper”")) +
          field("", checkHtml("show_admin_link", !!d.show_admin_link, "Show store admin link")) +
          field("", '<div class="b-inspector-hint">Click the copyright text on the canvas to edit it — leave it blank there to auto-generate “© year store name”.</div>');
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

  // Four-way spacing grid (Top/Bottom/Left/Right), reused for both a
  // section's own margin/padding and a sub-selected element's — the caller
  // supplies each input's data-field name and current value.
  function spacingQuadHtml(topField, bottomField, leftField, rightField, topVal, bottomVal, leftVal, rightVal) {
    function inp(name, val) {
      return '<input class="b-text-native" type="number" min="0" max="400" step="4" data-field="' + name + '" value="' + (val || 0) + '" />';
    }
    return '<div class="b-spacing-quad">' +
      '<label>Top' + inp(topField, topVal) + '</label>' +
      '<label>Bottom' + inp(bottomField, bottomVal) + '</label>' +
      '<label>Left' + inp(leftField, leftVal) + '</label>' +
      '<label>Right' + inp(rightField, rightVal) + '</label>' +
    '</div>';
  }

  // Per-element spacing panel — shown only while a text field inside the
  // selected section is itself sub-selected (state.selectedFieldKey), on
  // the Content tab where the click-to-select interaction lives. Its
  // inputs use distinct "__elm_..." data-field names (plus data-el-field
  // naming which field they belong to) so wireInspector's change handler
  // can tell them apart from the section-level "__margin_"/"__padding_"
  // inputs on the Settings tab.
  function elementSpacingQuadHtml(fieldKey, prefix, st) {
    function name(k) { return '__elm_' + prefix + '_' + k; }
    function inp(k) {
      return '<input class="b-text-native" type="number" min="0" max="400" step="4" data-field="' + name(k) + '" data-el-field="' + esc(fieldKey) + '" value="' + (st[prefix + '_' + k] || 0) + '" />';
    }
    return '<div class="b-spacing-quad">' +
      '<label>Top' + inp("top") + '</label>' +
      '<label>Bottom' + inp("bottom") + '</label>' +
      '<label>Left' + inp("left") + '</label>' +
      '<label>Right' + inp("right") + '</label>' +
    '</div>';
  }
  function elementSettingsHtml(sec, fieldKey, st) {
    st = st || (sec.element_styles && sec.element_styles[fieldKey]) || {};
    var label = fieldKey.charAt(0).toUpperCase() + fieldKey.slice(1);
    var posRow = st.positioned
      ? field("Position", '<div class="b-pos-row">' +
          '<label>X<input class="b-text-native" type="number" min="0" max="4000" step="4" data-field="__elm_pos_left" data-el-field="' + esc(fieldKey) + '" value="' + (st.pos_left || 0) + '" /></label>' +
          '<label>Y<input class="b-text-native" type="number" min="0" max="4000" step="4" data-field="__elm_pos_top" data-el-field="' + esc(fieldKey) + '" value="' + (st.pos_top || 0) + '" /></label>' +
        '</div>' +
        '<button type="button" class="b-btn-outline b-el-unpin" data-el-unpin="' + esc(fieldKey) + '" style="margin-top:8px;">Reset to normal position</button>' +
        '<div class="b-field-hint">Dragged free of the normal layout — drag the dark handle on the canvas to move it, or type pixels here.</div>')
      : field("", '<div class="b-field-hint">Drag the dark handle on the selected text to move it anywhere inside its section.</div>');
    return '<div class="b-inspector-divider"></div>' +
      '<div class="b-inspector-section-label">“' + esc(label) + '” spacing & position</div>' +
      posRow +
      field("Height", '<input class="b-text-native" type="number" min="0" max="800" step="10" data-field="__elm_min_height" data-el-field="' + esc(fieldKey) + '" value="' + (st.min_height || 0) + '" />' +
        '<div class="b-field-hint">Drag the amber handle below the selected text on the canvas, or type a height in pixels.</div>') +
      field("Margin", elementSpacingQuadHtml(fieldKey, "margin", st) +
        '<div class="b-field-hint">Drag the thin handles around the selected text on the canvas, or type pixels here.</div>') +
      field("Padding", elementSpacingQuadHtml(fieldKey, "padding", st)) +
      field("", '<div class="b-inspector-hint">Just this text — on top of the section’s own margin/padding in Settings. Click elsewhere on the canvas to deselect it.</div>');
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
      ? field("Margin (space around this section)", spacingQuadHtml("__margin_top", "__margin_bottom", "__margin_left", "__margin_right", sec.margin_top, sec.margin_bottom, sec.margin_left, sec.margin_right) +
          '<div class="b-field-hint">Drag the thin handles around the section on the canvas, or type pixels here. Left/right inset the section from the page edge.</div>') +
        field("Padding (space inside its own edges)", spacingQuadHtml("__padding_top", "__padding_bottom", "__padding_left", "__padding_right", sec.padding_top, sec.padding_bottom, sec.padding_left, sec.padding_right))
      : "";
    return visibilityRow +
      heightRow +
      spacingRows +
      field("Custom CSS class", textHtml("__custom_class", sec.custom_class, "e.g. my-hero-tweak")) +
      field("Custom CSS", textareaHtml("__custom_css", sec.custom_css, "#" + pzSelector(sec.id) + " {\n  \n}")) +
      field("", '<div class="b-inspector-hint">Applies only to this section on your live storefront. Target it with <code>#' + pzSelector(sec.id) + '</code> to keep changes scoped there.</div>');
  }
  function pzSelector(id) { return "pz-section-" + id; }

  // Content tab = what this section (or its sub-selected text element) can
  // do/say — type-specific fields plus the per-element spacing panel.
  // Settings tab = universal section-wide settings — visibility, height,
  // margin/padding, custom class/CSS. Tab choice is sticky across
  // selections (state.inspectorTab) except selectSection() pins it to
  // "content" the moment a field gets freshly sub-selected.
  function renderInspector() {
    var panel = document.getElementById("bInspector");
    var sec = state.selectedId ? findSection(state.selectedId) : null;
    if (!sec) { panel.hidden = true; return; }
    panel.hidden = false;
    var selBlock = state.selectedBlockId ? findBlockInSection(sec, state.selectedBlockId) : null;
    var titleType = selBlock ? selBlock.block.type : sec.type;
    var label = (SECTION_TYPES[titleType] && SECTION_TYPES[titleType].name) || titleType;
    document.getElementById("bInspectorIcon").innerHTML = icon(titleType);
    document.getElementById("bInspectorTitle").textContent = label;
    document.getElementById("bInspectorType").textContent = selBlock
      ? "inside row · column " + (selBlock.colIndex + 1)
      : "section · " + sec.type + (sec.hidden ? " · hidden" : "");
    var fieldOwnerType = selBlock ? selBlock.block.type : sec.type;
    var fieldSel = (state.selectedFieldKey && isTextElementField(fieldOwnerType, state.selectedFieldKey)) ? state.selectedFieldKey : null;
    var fieldSt = fieldSel ? ((selBlock ? selBlock.block.element_styles : sec.element_styles) || {})[fieldSel] : null;
    var tab = state.inspectorTab === "settings" ? "settings" : "content";
    var contentPane = inspectorFieldsFor(selBlock ? selBlock.block : sec) + (fieldSel ? elementSettingsHtml(sec, fieldSel, fieldSt) : "");
    var tabsHtml = '<div class="b-inspector-tabs">' +
      '<button type="button" class="b-inspector-tab ' + (tab === "content" ? "active" : "") + '" data-tab="content">Content</button>' +
      '<button type="button" class="b-inspector-tab ' + (tab === "settings" ? "active" : "") + '" data-tab="settings">Settings</button>' +
    '</div>';
    document.getElementById("bInspectorBody").innerHTML =
      tabsHtml +
      '<div class="b-inspector-pane" data-pane="content"' + (tab === "content" ? "" : " hidden") + '>' + contentPane + '</div>' +
      '<div class="b-inspector-pane" data-pane="settings"' + (tab === "settings" ? "" : " hidden") + '>' + sectionSettingsHtml(sec) + '</div>';
  }

  /* ---------------------------------------------------------------
     Selection & toolbar actions
  --------------------------------------------------------------- */
  // fieldKey (optional): sub-selects one text element within this section
  // for the per-element spacing panel — pass null/omit to select just the
  // section itself (e.g. clicking blank canvas space, or a layer row).
  function selectSection(id, fieldKey, blockId) {
    state.selectedId = id;
    state.selectedFieldKey = fieldKey || null;
    state.selectedBlockId = blockId || null;
    document.querySelectorAll(".b-csec").forEach(function (n) { n.classList.toggle("is-selected", n.dataset.id === String(id)); });
    document.querySelectorAll(".b-layer-row").forEach(function (n) { n.classList.toggle("selected", n.dataset.id === String(id)); });
    document.querySelectorAll("[data-block-id]").forEach(function (n) {
      n.classList.toggle("is-block-selected", state.selectedBlockId ? n.dataset.blockId === String(state.selectedBlockId) : false);
    });
    document.querySelectorAll(".b-csec [data-field]").forEach(function (n) {
      var host = n.closest(".b-csec");
      var blockHost = n.closest("[data-block-id]");
      var sameBlock = state.selectedBlockId ? (blockHost && blockHost.dataset.blockId === String(state.selectedBlockId)) : !blockHost;
      var match = state.selectedFieldKey && host && host.dataset.id === String(id) && sameBlock && n.dataset.field === state.selectedFieldKey;
      n.classList.toggle("is-field-selected", !!match);
    });
    // Sub-selecting a field is what the user is here to work on — make sure
    // the Content tab (where its spacing panel lives) is the one showing.
    if (state.selectedFieldKey) state.inspectorTab = "content";
    positionElementHandles();
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

  // Every field this section type shape needs, blank — mirrors the plain
  // { id, type, fields, hidden, ...settings, element_styles } row shape the
  // server hands back for a saved section (see builder.ejs's window.__BUILDER__
  // and scopeListSections), just with a client-only id and no history yet.
  function blankSection(type, fields, elementStyles) {
    return {
      id: genSectionId(), type: type, fields: fields, hidden: false,
      custom_class: "", custom_css: "", min_height: 0,
      hide_desktop: false, hide_tablet: false, hide_mobile: false,
      margin_top: 0, margin_bottom: 0, margin_left: 0, margin_right: 0,
      padding_top: 0, padding_bottom: 0, padding_left: 0, padding_right: 0,
      element_styles: elementStyles || {},
    };
  }

  function addSectionAt(type, index) {
    var fields = JSON.parse(JSON.stringify(DEFAULT_FIELDS[type] || {}));
    var sec = blankSection(type, fields);
    state.sections.splice(index, 0, sec);
    state.selectedId = sec.id;
    state.selectedFieldKey = null;
    state.selectedBlockId = null;
    renderAll();
    commitHistory();
    var label = (SECTION_TYPES[type] && SECTION_TYPES[type].name) || type;
    toast(label + " added");
  }

  // Resolves which columns array a row-targeted action should act on: the
  // top-level section's own (rowBlockId falsy), or a nested row block's own
  // (rowBlockId set) — used by setRowLayout/insertBlockIntoColumn below so
  // both work identically whether the row being edited is the section
  // itself or one nested arbitrarily deep inside it. Returns null if
  // rowBlockId was given but doesn't resolve to an actual row block.
  function resolveRowFields(sec, rowBlockId) {
    if (!rowBlockId) return sec.fields;
    var found = findBlockInSection(sec, rowBlockId);
    if (!found || found.block.type !== "row") return null;
    found.block.fields = found.block.fields || { columns: [] };
    return found.block.fields;
  }

  // Picking (or re-picking) a row's column layout. widths e.g. [1,1] or
  // [1.6,1]. Existing columns keep their blocks where an index still
  // exists after the resize; columns beyond the new count are dropped —
  // confirmed first if any of them actually held content, since that's
  // the one destructive edge of this control. rowBlockId: null/falsy for
  // the top-level section's own layout, or a nested row block's id for
  // that row's own layout (see resolveRowFields).
  function setRowLayout(sectionId, rowBlockId, widths) {
    var sec = findSection(sectionId);
    if (!sec) return;
    var rowFields = resolveRowFields(sec, rowBlockId);
    if (!rowFields) return;
    var cols = rowFields.columns || [];
    var dropped = cols.slice(widths.length).some(function (c) { return (c.blocks || []).length; });
    if (dropped && !confirm("Switching to " + widths.length + " column" + (widths.length === 1 ? "" : "s") + " will remove the content in the column(s) that no longer fit. Continue?")) return;
    var nextCols = widths.map(function (w, i) { return { width: w, blocks: (cols[i] && cols[i].blocks) || [] }; });
    rowFields.columns = nextCols;
    if (state.selectedBlockId && !findBlockInSection(sec, state.selectedBlockId)) {
      state.selectedBlockId = null;
      state.selectedFieldKey = null;
    }
    // Always send the whole top-level tree — when rowBlockId is set,
    // rowFields is a nested object reached BY REFERENCE from sec.fields, so
    // the edit above is already part of it.
    saveField(sec.id, { columns: sec.fields.columns });
    renderAll();
  }

  // rowBlockId: null/falsy to insert into the top-level section's own
  // column, or a nested row block's id to insert into THAT row's column —
  // see resolveRowFields. Dropping a "row" item is refused (rather than
  // silently accepted and then discarded on save) once MAX_ROW_DEPTH would
  // be exceeded, mirroring canNestRowAt's gating during drag-and-drop so a
  // click on a column's own "+" button can't bypass the same limit.
  function insertBlockIntoColumn(sectionId, rowBlockId, colIndex, type) {
    var sec = findSection(sectionId);
    if (!sec || !isNestable(type)) return;
    if (type === "row" && !canNestRowAt(sec, rowBlockId)) return;
    var rowFields = resolveRowFields(sec, rowBlockId);
    if (!rowFields) return;
    var col = (rowFields.columns || [])[colIndex];
    if (!col) return;
    col.blocks = col.blocks || [];
    var blockId = genBlockId();
    col.blocks.push({ id: blockId, type: type, fields: {}, element_styles: {} });
    saveField(sec.id, { columns: sec.fields.columns });
    renderAll();
    var label = (SECTION_TYPES[type] && SECTION_TYPES[type].name) || type;
    toast(label + " added to the column");
  }

  // Inserts a saved component as a new TOP-LEVEL section at the end of the
  // page — same two-step pattern duplicateSection() below already uses
  // (create a blank section of the right type, then PATCH its fields),
  // since the section-creation endpoint only ever hands back that type's
  // plain defaults. Nested ids are regenerated (cloneWithFreshIds) so the
  // copy can never collide with the component's own stored ids, or with
  // another copy of the same component inserted earlier on this page. Once
  // on the canvas it's just an ordinary section — drag it anywhere with the
  // normal reorder handle.
  function insertComponent(component) {
    var fresh = cloneWithFreshIds(component.block);
    var sec = blankSection(component.block.type, fresh.fields, fresh.element_styles);
    state.sections.push(sec);
    state.selectedId = sec.id;
    state.selectedFieldKey = null;
    state.selectedBlockId = null;
    renderAll();
    commitHistory();
    toast('"' + component.name + '" added to the page');
  }

  // Prompts for a name and saves `block` (a top-level section's own
  // {id,type,fields,element_styles}, or one found via findBlockInSection for
  // a nested block) to the store's component library — see
  // routes/admin.js's POST /admin/components.
  function saveAsComponent(block) {
    var defaultName = (SECTION_TYPES[block.type] && SECTION_TYPES[block.type].name) || block.type;
    var name = window.prompt('Name this component (shown in your Components panel):', defaultName);
    if (name === null) return;
    name = name.trim();
    if (!name) return toast("Give it a name to save it.", true);
    api(COMPONENTS_BASE, { name: name, block: { id: block.id, type: block.type, fields: block.fields, element_styles: block.element_styles || {} } }).then(function (res) {
      if (!res || !res.ok) return toast(res && res.error ? res.error : "Could not save that component.", true);
      state.components.unshift(res.component);
      renderComponents();
      toast('Saved "' + res.component.name + '" to your components');
    });
  }

  function deleteComponent(id) {
    if (!confirm("Remove this component from your library? Copies already on your pages are unaffected.")) return;
    api(COMPONENTS_BASE + "/" + id + "/delete").then(function (res) {
      if (!res || !res.ok) return toast("Could not remove that component.", true);
      state.components = state.components.filter(function (c) { return String(c.id) !== String(id); });
      renderComponents();
      toast("Component removed");
    });
  }

  function removeBlock(sectionId, blockId) {
    var sec = findSection(sectionId);
    if (!sec) return;
    var found = findBlockInSection(sec, blockId);
    if (!found) return;
    found.col.blocks.splice(found.blockIndex, 1);
    if (state.selectedBlockId === blockId) {
      state.selectedBlockId = null;
      state.selectedFieldKey = null;
    }
    renderAll();
    saveField(sec.id, { columns: sec.fields.columns });
  }

  // Duplicates every attribute of the source section — type, fields, all
  // universal settings (custom class/CSS, spacing, per-device visibility)
  // and element styles — not just fields+hidden the way this used to only
  // copy fields (the rest came back blank from the create-then-patch round
  // trip): a duplicate should be a true copy, the same way WordPress's own
  // "Duplicate" is.
  function duplicateSection(id) {
    var idx = indexOf(id);
    if (idx < 0) return;
    var src = state.sections[idx];
    var newSec = Object.assign(cloneSections(src), { id: genSectionId() });
    state.sections.splice(idx + 1, 0, newSec);
    state.selectedId = newSec.id;
    state.selectedFieldKey = null;
    state.selectedBlockId = null;
    renderAll();
    commitHistory();
    toast("Section duplicated");
  }

  function deleteSection(id) {
    if (!confirm("Delete this section? You can undo it with the undo button (or Ctrl+Z) right after.")) return;
    var idx = indexOf(id);
    if (idx < 0) return;
    state.sections.splice(idx, 1);
    if (state.selectedId === id) { state.selectedId = null; state.selectedFieldKey = null; state.selectedBlockId = null; }
    renderAll();
    commitHistory();
    toast("Section deleted");
  }

  function toggleHidden(id) {
    var sec = findSection(id);
    if (!sec) return;
    sec.hidden = !sec.hidden;
    renderAll();
    commitHistory();
    toast(sec.hidden ? "Hidden from your storefront" : "Now visible on your storefront");
  }

  // The three functions below no longer talk to the network at all — every
  // edit accumulates in state.sections until the Save button (doSave, in
  // the Draft / Save architecture above) sends the whole tree at once. Each
  // still returns a resolved Promise purely so call sites written as
  // saveField(...).then(...) keep working unchanged.
  function saveField(id, patch) {
    var sec = findSection(id);
    if (sec) Object.assign(sec.fields, patch);
    commitHistory();
    return Promise.resolve();
  }

  // Universal module settings (custom_class / custom_css / spacing /
  // per-device visibility) — same shape as a section's own top-level
  // columns, just applied directly onto the section object rather than
  // nested under `fields`.
  function saveSettings(id, patch) {
    var sec = findSection(id);
    if (sec) {
      Object.assign(sec, patch);
      // Mirrors the old server-round-trip version, which always
      // re-rendered the canvas once a settings patch landed — most
      // callers already patch the specific bit of DOM they touched
      // (applyHeightStyle/applySpacingStyle) as a live-drag preview, but
      // custom_class/custom_css/per-device visibility don't, so this stays
      // unconditional rather than piecemeal per call site.
      renderCanvas();
    }
    commitHistory();
    return Promise.resolve();
  }

  // Per-element spacing (margin/padding/position on one text field inside a
  // section) — `patch` is { field: "heading", margin_top?: n, ... }. The
  // caller (elementStyleCtx.persist, see above) has always already applied
  // the same values via setEntry() before calling this, so this mainly just
  // records the change in history; the merge below is a defensive no-op
  // mirror of that, kept so this function is correct standalone too.
  function saveElementStyle(id, patch) {
    var sec = findSection(id);
    if (sec && patch && patch.field) {
      sec.element_styles = sec.element_styles || {};
      var entry = Object.assign({}, sec.element_styles[patch.field] || {});
      Object.keys(patch).forEach(function (k) { if (k !== "field") entry[k] = patch[k]; });
      sec.element_styles[patch.field] = entry;
    }
    commitHistory();
    return Promise.resolve();
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

  // Same idea as computeDropIndex/showDropMarker above, but scoped to the
  // Page structure (Layers) panel's own row list — lets a section be
  // reordered by dragging its row up/down inside that panel, without the
  // pointer ever having to cross over the canvas. Only counts rows the
  // current layer search hasn't hidden, and only while that search is
  // empty (see the guard at the call site) — a filtered subset can't map
  // cleanly back onto the full section array's indices.
  function layerRowEls() { return Array.prototype.slice.call(document.querySelectorAll("#bLayersBody .b-layer-row:not([hidden])")); }
  function clearLayerDropMarkers() { document.querySelectorAll(".b-layer-row").forEach(function (n) { n.classList.remove("is-drop-target-before", "is-drop-target-after"); }); }
  function computeLayerDropIndex(clientY, excludeId) {
    var els = layerRowEls().filter(function (n) { return n.dataset.id !== String(excludeId); });
    if (!els.length) return { index: 0, targetEl: null, before: true };
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return { index: i, targetEl: els[i], before: true };
    }
    return { index: els.length, targetEl: els[els.length - 1], before: false };
  }
  function showLayerDropMarker(info) {
    clearLayerDropMarkers();
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

    function clearColDropMarkers() { document.querySelectorAll(".b-row-col").forEach(function (n) { n.classList.remove("is-drop-target", "is-drop-blocked"); }); }

    function onMove(ev) {
      var p = ev.touches ? ev.touches[0] : ev;
      moveGhost(p.clientX, p.clientY);
      // Dragging a nestable library item over a row's column drops it into
      // that column instead of at the top level — checked first since a
      // column sits visually inside the section list computeDropIndex
      // already scans. Dragging a "row" item specifically is additionally
      // gated by canNestRowAt: shown as a blocked (not a normal) drop target
      // once MAX_ROW_DEPTH would be exceeded, rather than accepting the drop
      // and then silently discarding it on save — see lib/sections.js's
      // sanitizeRowBlock for the server-side half of that same limit.
      drag.colDropInfo = null;
      if (drag.kind === "insert" && isNestable(drag.payload)) {
        var overEl = document.elementFromPoint(p.clientX, p.clientY);
        var colEl = overEl && overEl.closest("[data-col-drop]");
        if (colEl) {
          var rowWrap = colEl.closest(".b-csec");
          var colSec = rowWrap ? findSection(rowWrap.dataset.id) : null;
          var colOwner = colEl.dataset.rowOwner || null;
          var colBlocked = drag.payload === "row" && (!colSec || !canNestRowAt(colSec, colOwner));
          clearColDropMarkers();
          colEl.classList.add(colBlocked ? "is-drop-blocked" : "is-drop-target");
          clearDropMarkers();
          if (!colBlocked) drag.colDropInfo = { sectionId: rowWrap.dataset.id, rowBlockId: colOwner, colIndex: parseInt(colEl.dataset.colDrop, 10) };
          return;
        }
      }
      clearColDropMarkers();

      // A reorder drag started from the Layers panel's own grip handle can
      // be dropped right there, without the pointer crossing into the
      // canvas — as long as that panel's search box is empty (a filtered
      // row list can't map back onto the full section array by position).
      if (drag.kind === "reorder") {
        var layersBody = document.getElementById("bLayersBody");
        var layerSearchEl = document.getElementById("bLayerSearch");
        var layerSearchEmpty = !layerSearchEl || !layerSearchEl.value.trim();
        var lRect = layersBody ? layersBody.getBoundingClientRect() : null;
        if (layerSearchEmpty && lRect && lRect.width && p.clientX >= lRect.left && p.clientX <= lRect.right && p.clientY >= lRect.top && p.clientY <= lRect.bottom) {
          drag.dropInfo = computeLayerDropIndex(p.clientY, drag.payload);
          clearDropMarkers();
          showLayerDropMarker(drag.dropInfo);
          return;
        }
      }
      clearLayerDropMarkers();

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
      clearColDropMarkers();
      clearLayerDropMarkers();
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
    if (!drag) return;
    // The drop may release the mouse over a clickable control that belongs
    // to a different section than the one being dragged (a column's "+"
    // button, another section's duplicate/delete/toggle icon) — swallow the
    // native click the browser is about to fire at that point so it can't
    // re-trigger that control right after the drop's own logic runs below.
    swallowNextClick();
    if (drag.kind === "insert" && drag.colDropInfo) {
      return insertBlockIntoColumn(drag.colDropInfo.sectionId, drag.colDropInfo.rowBlockId, drag.colDropInfo.colIndex, drag.payload);
    }
    if (!drag.dropInfo) return;
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
    var search = document.getElementById("bLibSearch");
    var clearBtn = document.getElementById("bLibSearchClear");
    if (search) search.addEventListener("input", renderLibrary);
    if (clearBtn) clearBtn.addEventListener("click", function () { search.value = ""; renderLibrary(); search.focus(); });
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
      jumpToSection(row.dataset.id);
      row.classList.add("is-flash");
      setTimeout(function () { row.classList.remove("is-flash"); }, 500);
    });
    var search = document.getElementById("bLayerSearch");
    var clearBtn = document.getElementById("bLayerSearchClear");
    if (search) search.addEventListener("input", renderLayers);
    if (clearBtn) clearBtn.addEventListener("click", function () { search.value = ""; renderLayers(); search.focus(); });
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
      var marginHandle = e.target.closest('[data-action="margin-top"], [data-action="margin-bottom"], [data-action="margin-left"], [data-action="margin-right"]');
      if (marginHandle) {
        var mhost = e.target.closest(".b-csec");
        if (!mhost) return;
        var msec = findSection(mhost.dataset.id);
        if (!msec) return;
        var direction = marginHandle.dataset.action.replace("margin-", "");
        startMarginDrag(e, msec, mhost.firstElementChild, direction);
        return;
      }
      var handle = e.target.closest('[data-action="drag"]');
      if (!handle) return;
      var host = e.target.closest(".b-csec");
      if (!host) return;
      startDrag(e, "reorder", host.dataset.id);
    });

    canvas.addEventListener("click", function (e) {
      // The element-handle overlay (drag handles for the sub-selected
      // text field's own margin/padding/height/position) manages selection
      // itself via its own pointerdown listener — a click bubbling up from
      // it must not reach the generic field-click logic below, which would
      // otherwise immediately clear the sub-selection a drag just set.
      if (e.target.closest("[data-el-action]")) return;

      var host = e.target.closest(".b-csec");
      if (!host) return;
      var id = host.dataset.id;
      var sec = findSection(id);
      if (!sec) return;

      var layoutBtn = e.target.closest("[data-row-layout]");
      if (layoutBtn) return setRowLayout(id, layoutBtn.dataset.rowOwner || null, layoutBtn.dataset.rowLayout.split(",").map(Number));

      var colAddBtn = e.target.closest("[data-col-add]");
      if (colAddBtn) return insertBlockIntoColumn(id, colAddBtn.dataset.rowOwner || null, parseInt(colAddBtn.dataset.colAdd, 10), "richtext");

      var blockDelBtn = e.target.closest('[data-block-action="del"]');
      if (blockDelBtn) {
        var delBlockHost = blockDelBtn.closest("[data-block-id]");
        if (delBlockHost) removeBlock(id, delBlockHost.dataset.blockId);
        return;
      }

      var blockSaveBtn = e.target.closest('[data-block-action="save-component"]');
      if (blockSaveBtn) {
        var saveBlockHost = blockSaveBtn.closest("[data-block-id]");
        var foundForSave = saveBlockHost ? findBlockInSection(sec, saveBlockHost.dataset.blockId) : null;
        if (foundForSave) saveAsComponent(foundForSave.block);
        return;
      }

      var actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        var action = actionBtn.dataset.action;
        if (action === "dup") return duplicateSection(id);
        if (action === "del") return deleteSection(id);
        if (action === "toggle") return toggleHidden(id);
        if (action === "save-component") return saveAsComponent(sec);
        if (action.indexOf("margin-") === 0 || action === "drag" || action === "resize") return;
      }

      // Clicking directly into a text element (not an array-item field like
      // a testimonial quote, and only when that field is one
      // lib/sections.js's TEXT_ELEMENT_FIELDS allows) additionally
      // sub-selects it, surfacing its own margin/padding/position panel in
      // the inspector — on top of the normal click-to-edit-text behavior,
      // which the browser handles on its own since these are
      // contenteditable. A field nested inside a row block resolves against
      // that block's own type, and carries its block id along.
      var fieldEl = e.target.closest("[data-field]");
      var fieldKey = null;
      var clickedBlockHost = e.target.closest("[data-block-id]");
      var blockId = clickedBlockHost ? clickedBlockHost.dataset.blockId : null;
      if (fieldEl && fieldEl.isContentEditable) {
        var fk = fieldEl.dataset.field;
        var found = clickedBlockHost ? findBlockInSection(sec, clickedBlockHost.dataset.blockId) : null;
        var ownerType = found ? found.block.type : sec.type;
        if (fk.indexOf(".") === -1 && isTextElementField(ownerType, fk)) fieldKey = fk;
      }
      selectSection(id, fieldKey, blockId);
    });

    canvas.addEventListener("focusout", function (e) {
      var f = e.target.closest("[data-field]");
      if (!f || !f.isContentEditable) return;
      var host = e.target.closest(".b-csec");
      var sec = findSection(host.dataset.id);
      if (!sec) return;
      var key = f.dataset.field;
      var value = f.textContent.trim();
      var blockHost = f.closest("[data-block-id]");

      if (blockHost) {
        // Same array-item-rebuild trick as below, scoped to this one block's
        // own fields rather than the section's — then the whole row's
        // columns tree is saved through the generic fields endpoint, since
        // a block's content lives inside sec.fields.columns, not its own row.
        var found = findBlockInSection(sec, blockHost.dataset.blockId);
        if (!found) return;
        if (key.indexOf(".") !== -1) {
          var bparts = key.split(".");
          var bArrayKey = bparts[0], bIdx = parseInt(bparts[1], 10), bSubKey = bparts[2];
          var bExisting = found.block.fields[bArrayKey] || [];
          var bNewArr = bExisting.map(function (item, i) {
            var out = Object.assign({}, item);
            Object.keys(item).forEach(function (k) {
              var sibling = blockHost.querySelector('[data-field="' + bArrayKey + '.' + i + '.' + k + '"]');
              if (sibling) out[k] = sibling.textContent.trim();
            });
            return out;
          });
          if (bNewArr[bIdx]) bNewArr[bIdx][bSubKey] = value;
          found.block.fields[bArrayKey] = bNewArr;
        } else {
          found.block.fields[key] = value;
        }
        saveField(sec.id, { columns: sec.fields.columns });
        return;
      }

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

    // Typing into the sub-selected field can change its own height (text
    // wrapping to a new line) — keep the element-handle overlay tracking it
    // live rather than only on the next full render. Guarded to the same
    // block as the current selection, since two blocks can share a field
    // name (e.g. two Rich text blocks both have "heading").
    canvas.addEventListener("input", function (e) {
      var f = e.target.closest("[data-field]");
      if (!f || !state.selectedFieldKey || f.dataset.field !== state.selectedFieldKey) return;
      var blockHost = f.closest("[data-block-id]");
      var sameBlock = state.selectedBlockId ? (blockHost && blockHost.dataset.blockId === String(state.selectedBlockId)) : !blockHost;
      if (sameBlock) positionElementHandles();
    });
  }

  function wireInspector() {
    document.getElementById("bInspectorBody").addEventListener("click", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var tabBtn = e.target.closest(".b-inspector-tab");
      if (tabBtn) {
        state.inspectorTab = tabBtn.dataset.tab === "settings" ? "settings" : "content";
        renderInspector();
        return;
      }
      var unpinBtn = e.target.closest("[data-el-unpin]");
      if (unpinBtn) {
        var unpinCtx = elementStyleCtx();
        if (!unpinCtx) return;
        var resetEntry = Object.assign({}, unpinCtx.getEntry());
        resetEntry.positioned = false;
        resetEntry.pos_left = 0;
        resetEntry.pos_top = 0;
        resetEntry.el_width = 0;
        unpinCtx.setEntry(resetEntry);
        applyElStyleToNode(selectedFieldNode(), resetEntry);
        positionElementHandles();
        renderInspector();
        unpinCtx.persist({ positioned: false, pos_left: 0, pos_top: 0, el_width: 0 });
        return;
      }
      var segBtn = e.target.closest(".b-seg button");
      if (segBtn) {
        var target = inspectorFieldTarget();
        if (!target) return;
        var wrap = segBtn.closest(".b-seg");
        var patch = {};
        patch[wrap.dataset.field] = segBtn.dataset.val;
        target.save(patch);
      }
    });
    document.getElementById("bInspectorBody").addEventListener("change", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var sel = e.target.closest("select[data-field]");
      if (sel) {
        var target = inspectorFieldTarget();
        if (!target) return;
        var patch = {};
        patch[sel.dataset.field] = sel.value;
        target.save(patch);
        return;
      }
      // datetime-local reports the admin's own local wall-clock time; convert
      // to a UTC ISO string before saving so the countdown lands on the same
      // real moment for every visitor, whatever timezone they're in.
      var dt = e.target.closest('input[type="datetime-local"][data-field]');
      if (dt) {
        var dtTarget = inspectorFieldTarget();
        if (!dtTarget) return;
        var iso = "";
        if (dt.value) {
          var parsed = new Date(dt.value);
          if (!isNaN(parsed.getTime())) iso = parsed.toISOString();
        }
        var patch2 = {};
        patch2[dt.dataset.field] = iso;
        dtTarget.save(patch2);
        return;
      }
      var hin = e.target.closest('input[type="number"][data-field="__min_height"]');
      if (hin) {
        var h = Math.max(0, Math.min(1200, parseInt(hin.value, 10) || 0));
        hin.value = h;
        sec.min_height = h;
        applyHeightStyle(heightRootEl(sec.id), h);
        positionElementHandles();
        saveSettings(sec.id, { min_height: h });
        return;
      }
      var elIn = e.target.closest('input[type="number"][data-field^="__elm_"]');
      if (elIn) {
        // "__elm_margin_top" -> "margin_top"; "__elm_min_height" -> "min_height"; "__elm_pos_left" -> "pos_left"
        var elKey = elIn.dataset.field.slice(6);
        var elMax = elKey === "min_height" ? 800 : (elKey === "pos_left" || elKey === "pos_top") ? 4000 : 400;
        var elVal = Math.max(0, Math.min(elMax, parseInt(elIn.value, 10) || 0));
        elIn.value = elVal;
        var elCtx = elementStyleCtx();
        if (!elCtx) return;
        var nextEntry = Object.assign({}, elCtx.getEntry());
        nextEntry[elKey] = elVal;
        elCtx.setEntry(nextEntry);
        applyElStyleToNode(selectedFieldNode(), nextEntry);
        positionElementHandles();
        var elPatch = {};
        elPatch[elKey] = elVal;
        elCtx.persist(elPatch);
        return;
      }
      var spacingIn = e.target.closest('input[type="number"][data-field^="__margin_"], input[type="number"][data-field^="__padding_"]');
      if (spacingIn) {
        var sKey = spacingIn.dataset.field.slice(2); // "__margin_top" -> "margin_top"
        var sVal = Math.max(0, Math.min(400, parseInt(spacingIn.value, 10) || 0));
        spacingIn.value = sVal;
        sec[sKey] = sVal;
        applySpacingStyle(spacingRootEl(sec.id), sec);
        positionElementHandles();
        var sPatch = {};
        sPatch[sKey] = sVal;
        saveSettings(sec.id, sPatch);
        return;
      }
      var colorIn = e.target.closest('input[type="color"][data-field]');
      if (colorIn) {
        var colorTarget = inspectorFieldTarget();
        if (!colorTarget) return;
        var colorPatch = {};
        colorPatch[colorIn.dataset.field] = colorIn.value;
        colorTarget.save(colorPatch);
        return;
      }
      // A plain boolean content field (e.g. hero's "Darken for text
      // readability" overlay toggle) — distinct from the "__show_" device
      // checkboxes below, which are settings, not fields.
      var boolBox = e.target.closest('input[type="checkbox"][data-field]:not([data-field^="__"])');
      if (boolBox) {
        var boolTarget = inspectorFieldTarget();
        if (!boolTarget) return;
        var boolPatch = {};
        boolPatch[boolBox.dataset.field] = boolBox.checked;
        boolTarget.save(boolPatch);
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
        // The "html"/"css" fields on an html-type section/block are one raw
        // multi-line string each (the merchant's own markup/CSS) — unlike
        // every other textarea here (gallery image URLs, logo names), which
        // is really a list, one item per line. No other section type has a
        // field named exactly "html" or "css", so this is an unambiguous way
        // to tell the two apart without a third data attribute.
        if (ta.dataset.field === "html" || ta.dataset.field === "css") {
          var rawTarget = inspectorFieldTarget();
          if (!rawTarget) return;
          var rawPatch = {};
          rawPatch[ta.dataset.field] = ta.value;
          rawTarget.save(rawPatch);
          return;
        }
        // "links" belongs to social_icons (platform/url) now that nav_menu
        // just points at a saved menu instead of storing its own. "columns"
        // only belongs to link_columns, but is parsed the same structured
        // way rather than falling through to the plain one-line-per-item
        // split below.
        if (ta.dataset.field === "links" || ta.dataset.field === "columns") {
          var structTarget = inspectorFieldTarget();
          if (!structTarget) return;
          var structPatch = {};
          if (ta.dataset.field === "columns") {
            structPatch.columns = parseColumnsText(ta.value);
          } else {
            structPatch.links = parseSocialText(ta.value);
          }
          structTarget.save(structPatch);
          return;
        }
        var taTarget = inspectorFieldTarget();
        if (!taTarget) return;
        var lines = ta.value.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
        var patch = {};
        patch[ta.dataset.field] = lines;
        taTarget.save(patch);
        return;
      }
      var input = e.target.closest('input.b-text-native[data-field]');
      if (input && input.type !== "datetime-local" && input.type !== "number") {
        if (input.dataset.field === "__custom_class") {
          sec.custom_class = input.value;
          saveSettings(sec.id, { custom_class: input.value });
          return;
        }
        var inTarget = inspectorFieldTarget();
        if (!inTarget) return;
        var patch2 = {};
        patch2[input.dataset.field] = input.value;
        inTarget.save(patch2);
      }
    });
  }

  function wireTopbar() {
    document.getElementById("bUndoBtn").addEventListener("click", undo);
    document.getElementById("bRedoBtn").addEventListener("click", redo);
    document.getElementById("bSaveBtn").addEventListener("click", doSave);

    // Ctrl/Cmd+Z and Ctrl+Y (or Shift+Ctrl/Cmd+Z) drive the builder's own
    // undo stack -- but only when focus isn't inside a text field or
    // contenteditable heading/body, where the same shortcut should keep
    // doing the browser's normal per-keystroke text undo instead. Ctrl/Cmd+S
    // saves — everywhere, even inside a text field, since a merchant reaching
    // for the browser's own save-page shortcut clearly means "save my work".
    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var key = e.key.toLowerCase();
      if (key === "s") { e.preventDefault(); doSave(); return; }
      if (key !== "z" && key !== "y") return;
      var active = document.activeElement;
      var inTextField = active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
      if (inTextField) return;
      if (key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      else if (key === "y") { e.preventDefault(); redo(); }
    });

    // Warn before leaving the page (closing the tab, navigating away, even
    // the Preview link opening in the same tab) while there's unsaved work.
    window.addEventListener("beforeunload", function (e) {
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    });

    document.getElementById("bViewportToggle").addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn) return;
      document.querySelectorAll("#bViewportToggle button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById("bCanvasFrame").dataset.vp = btn.dataset.vp;
      // The frame's width change animates (CSS transition), so reposition
      // the element-handle overlay once now and again once it's settled.
      positionElementHandles();
      setTimeout(positionElementHandles, 260);
    });

    window.addEventListener("resize", positionElementHandles);

    // The publish button only exists on the page-body builder (see
    // builder.ejs) — header/footer canvases (global or per-page override)
    // publish implicitly with every edit, same as the rest of the store.
    var publishBtn = document.getElementById("bPublishBtn");
    if (publishBtn) {
      var paintPublishBtn = function () {
        publishBtn.textContent = PAGE.status === "published" ? "Unpublish" : "Publish";
        publishBtn.classList.toggle("is-published", PAGE.status === "published");
      };
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

    // Per-page header/footer override toggle bar (page-body builder only —
    // see builder.ejs's b-layout-override-bar, rendered only when
    // context === "page"). Enable clones the store's global sections into
    // page-scoped ones and opens that override's own builder screen;
    // disable deletes them, reverting the page to the global layout.
    document.querySelectorAll("[data-layout-enable]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var region = btn.dataset.layoutEnable;
        btn.disabled = true;
        api("/admin/pages/" + PAGE.id + "/layout/" + region + "/enable", {}).then(function (res) {
          if (res && res.ok && res.redirect) {
            window.location.href = res.redirect;
          } else {
            btn.disabled = false;
            toast((res && res.error) || "Could not customize the " + region + " for this page.", true);
          }
        });
      });
    });
    document.querySelectorAll("[data-layout-disable]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var region = btn.dataset.layoutDisable;
        btn.disabled = true;
        api("/admin/pages/" + PAGE.id + "/layout/" + region + "/disable", {}).then(function (res) {
          if (res && res.ok) {
            window.location.reload();
          } else {
            btn.disabled = false;
            toast((res && res.error) || "Could not switch back to the global " + region + ".", true);
          }
        });
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
        var compPanel = document.getElementById("bPanelComponents");
        if (compPanel) compPanel.hidden = which !== "components";
      });
    });
  }

  // WordPress-style "Browse revisions" modal — one row per explicit Save
  // (or per restore, itself logged as a fresh save), newest first. The
  // scope's revisions live at a sibling route of BASE: BASE is always
  // ".../sections" (see sectionsBase in routes/admin.js's three builder
  // render calls), so swapping that last segment reaches ".../revisions"
  // without needing a second value threaded through window.__BUILDER__.
  function wireRevisions() {
    var REVISIONS_BASE = BASE.replace(/\/sections$/, "/revisions");
    var overlay = document.getElementById("bRevisionsOverlay");
    var body = document.getElementById("bRevisionsBody");
    if (!overlay || !body) return;

    function closeModal() { overlay.hidden = true; }

    function openModal() {
      overlay.hidden = false;
      body.innerHTML = '<p class="b-rev-empty">Loading…</p>';
      fetch(REVISIONS_BASE).then(function (r) { return r.json(); }).then(function (res) {
        if (!res || !res.ok || !res.revisions || !res.revisions.length) {
          body.innerHTML = '<p class="b-rev-empty">No saves yet — click Save to start keeping a history.</p>';
          return;
        }
        body.innerHTML = res.revisions.map(function (rev, i) {
          var when = new Date(rev.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
          var who = rev.created_by_name ? (" · " + esc(rev.created_by_name)) : "";
          var count = rev.section_count + (rev.section_count === 1 ? " section" : " sections");
          var right = i === 0
            ? '<span class="b-rev-current-tag">Current</span>'
            : '<button type="button" class="b-rev-restore" data-restore="' + rev.id + '">Restore</button>';
          return '<div class="b-rev-row' + (i === 0 ? ' is-current' : '') + '" data-id="' + rev.id + '">' +
            '<div class="b-rev-info"><span class="b-rev-when">' + esc(when) + '</span><span class="b-rev-meta">' + esc(count + who) + '</span></div>' +
            right + '</div>';
        }).join("");
      }).catch(function () {
        body.innerHTML = '<p class="b-rev-empty">Could not load revision history.</p>';
      });
    }

    document.getElementById("bHistoryBtn").addEventListener("click", openModal);
    document.getElementById("bRevisionsClose").addEventListener("click", closeModal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

    body.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-restore]");
      if (!btn) return;
      if (state.dirty && !confirm("You have unsaved changes on the canvas that restoring will overwrite. Restore this version anyway?")) return;
      if (!state.dirty && !confirm("Restore this saved version? Your current content is kept in history too, so nothing is lost.")) return;
      btn.disabled = true;
      btn.textContent = "Restoring…";
      api(REVISIONS_BASE + "/" + btn.dataset.restore + "/restore", {}).then(function (res) {
        if (!res || !res.ok) {
          toast(res && res.error ? res.error : "Could not restore that revision.", true);
          btn.disabled = false;
          btn.textContent = "Restore";
          return;
        }
        state.sections = res.sections.map(function (s) {
          return Object.assign({}, s, { fields: typeof s.fields === "string" ? JSON.parse(s.fields) : s.fields });
        });
        state.selectedId = null; state.selectedFieldKey = null; state.selectedBlockId = null;
        state.dirty = false;
        history = { stack: [cloneSections(state.sections)], index: 0, restoring: false };
        updateHistoryButtons();
        updateDirtyUI();
        renderAll();
        closeModal();
        toast("Restored — this is now the current, saved version");
      });
    });
  }

  /* ---------------------------------------------------------------
     Boot
  --------------------------------------------------------------- */
  renderLibrary();
  renderComponents();
  renderAll();
  wireLibrary();
  wireLayers();
  wireComponents();
  wireCanvas();
  wireInspector();
  wireTopbar();
  wireRail();
  wireRevisions();
  updateHistoryButtons();
  updateDirtyUI();
})();
