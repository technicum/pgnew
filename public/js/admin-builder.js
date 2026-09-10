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
    image: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="1.3"/><circle cx="7" cy="8" r="1.3"/><path d="M3.5 15 8 10.5l2.5 2.5L14 9l2.5 3"/></svg>'
  };
  function icon(name) { return ICON[name] || ""; }

  /* ---------------------------------------------------------------
     State — server data is the source of truth; every mutation below
     also fires the matching API call. No localStorage, no undo stack:
     there is nothing "unsaved" to lose.
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
    return api(BASE + "/reorder", { order: state.sections.map(function (s) { return s.id; }) }).finally(function () { setSaving(false); });
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

      default:
        return '<div class="b-sec-pad"><div class="b-inspector-hint">Unknown section type "' + esc(sec.type) + '".</div></div>';
    }
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
      var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
      var toolbar = el(
        '<div class="b-csec-toolbar">' +
          '<span class="b-csec-tag">' + esc(label) + (sec.hidden ? " · hidden" : "") + '</span>' +
          '<button class="b-drag-handle" data-action="drag" title="Drag to reorder">' + icon("drag") + '</button>' +
          '<button data-action="dup" title="Duplicate">' + icon("dup") + '</button>' +
          '<button data-action="toggle" title="' + (sec.hidden ? "Show on storefront" : "Hide from storefront") + '">' + icon(sec.hidden ? "eyeOff" : "eye") + '</button>' +
          '<button data-action="del" title="Delete">' + icon("trash") + '</button>' +
        '</div>'
      );
      wrap.appendChild(toolbar);
      if (sec.id === state.selectedId) wrap.classList.add("is-selected");
      if (sec.hidden) wrap.classList.add("is-hidden-sec");
      sortable.appendChild(wrap);
    });
  }

  function renderLibrary() {
    var body = document.getElementById("bLibraryBody");
    body.innerHTML = "";
    Object.keys(SECTION_TYPES).forEach(function (type) {
      var row = el(
        '<div class="b-lib-item" data-type="' + type + '">' +
          '<div class="b-lib-item-icon">' + icon(type) + '</div>' +
          '<div class="b-lib-item-label">' + esc(SECTION_TYPES[type].name) + '</div>' +
        '</div>'
      );
      body.appendChild(row);
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
      default:
        return "";
    }
  }

  function renderInspector() {
    var panel = document.getElementById("bInspector");
    var sec = state.selectedId ? findSection(state.selectedId) : null;
    if (!sec) { panel.hidden = true; return; }
    panel.hidden = false;
    var label = (SECTION_TYPES[sec.type] && SECTION_TYPES[sec.type].name) || sec.type;
    document.getElementById("bInspectorIcon").innerHTML = icon(sec.type);
    document.getElementById("bInspectorTitle").textContent = label;
    document.getElementById("bInspectorType").textContent = "section · " + sec.type + (sec.hidden ? " · hidden" : "");
    document.getElementById("bInspectorBody").innerHTML = inspectorFieldsFor(sec);
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
    if (!confirm("Delete this section? This can't be undone.")) return;
    setSaving(true);
    api(BASE + "/" + id + "/delete").then(function (res) {
      setSaving(false);
      if (!res || !res.ok) return toast("Could not delete that section.", true);
      var idx = indexOf(id);
      if (idx >= 0) state.sections.splice(idx, 1);
      if (state.selectedId === id) state.selectedId = null;
      renderAll();
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
        if (action === "drag") return;
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
        // "quotes.0.quote" / "quotes.0.author" -> { quotes: [{ quote, author }] }
        var parts = key.split(".");
        var thisKey = parts[2];
        var otherKey = thisKey === "quote" ? "author" : "quote";
        var otherField = host.querySelector('[data-field="quotes.0.' + otherKey + '"]');
        var qv = {};
        qv[thisKey] = value;
        qv[otherKey] = otherField ? otherField.textContent.trim() : "";
        patch = { quotes: [qv] };
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
      }
    });
    document.getElementById("bInspectorBody").addEventListener("focusout", function (e) {
      var sec = state.selectedId ? findSection(state.selectedId) : null;
      if (!sec) return;
      var input = e.target.closest('input.b-text-native[data-field]');
      if (input) {
        var patch = {};
        patch[input.dataset.field] = input.value;
        sec.fields[input.dataset.field] = input.value;
        renderCanvas();
        saveField(sec.id, patch);
      }
    });
  }

  function wireTopbar() {
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
    document.getElementById("bThemeToggle").addEventListener("click", function () {
      var root = document.body;
      var cur = root.getAttribute("data-theme");
      var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = !cur ? (sysDark ? "light" : "dark") : (cur === "dark" ? "light" : "dark");
      root.setAttribute("data-theme", next);
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
