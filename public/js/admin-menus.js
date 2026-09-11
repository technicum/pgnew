// WordPress-style menu editor (views/admin/menu-edit.ejs). Talks to the
// JSON API mounted at routes/admin.js's "Menus" section (lib/menus.js).
//
// Additions (checkbox + "Add to menu", same as WordPress itself) save
// immediately -- there's nothing to lose by refreshing right after adding
// an item. Structure changes (drag to reorder/nest) are local-only until
// "Save arrangement" is clicked, same as WordPress's own menu screen, so a
// merchant can try out an arrangement before committing to it. Label/URL
// edits and the menu rename save on blur/submit.
(function () {
  "use strict";
  var DATA = window.__MENU_EDITOR__;
  if (!DATA) return;

  var list = document.getElementById("menuStructure");
  var emptyMsg = document.getElementById("menuStructureEmpty");
  var statusEl = document.getElementById("menuSaveStatus");
  var saveBtn = document.getElementById("saveArrangement");

  var statusTimer = null;
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "menu-save-status" + (kind ? " is-" + kind : "");
    if (statusTimer) clearTimeout(statusTimer);
    if (kind === "success") statusTimer = setTimeout(function () { statusEl.textContent = ""; statusEl.className = "menu-save-status"; }, 2500);
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || data.error) throw new Error((data && data.error) || "Something went wrong.");
        return data;
      });
    });
  }

  var TYPE_LABELS = { page: "Page", category: "Category", product: "Product", custom: "Custom" };

  function itemRow(item) {
    var li = document.createElement("li");
    li.className = "menu-item-row";
    li.dataset.id = item.id;
    li.dataset.type = item.type;

    var head = document.createElement("div");
    head.className = "menu-item-row-head";

    var handle = document.createElement("span");
    handle.className = "menu-drag-handle";
    handle.title = "Drag to reorder or nest";
    handle.textContent = "⠿";
    head.appendChild(handle);

    var badge = document.createElement("span");
    badge.className = "menu-item-type-badge";
    badge.textContent = TYPE_LABELS[item.type] || item.type;
    head.appendChild(badge);

    var labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "menu-item-label-input";
    labelInput.maxLength = 150;
    labelInput.value = item.label || "";
    labelInput.addEventListener("blur", function () {
      var val = labelInput.value.trim();
      if (!val) { labelInput.value = item.label || ""; return; }
      if (val === item.label) return;
      item.label = val;
      postJSON(DATA.itemsBase + "/" + item.id, { label: val })
        .then(function () { setStatus("Saved", "success"); })
        .catch(function (err) { setStatus(err.message, "error"); });
    });
    head.appendChild(labelInput);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "menu-item-remove";
    removeBtn.title = "Remove from menu";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", function () {
      postJSON(DATA.itemsBase + "/" + item.id + "/delete", {})
        .then(function () {
          li.remove();
          refreshEmptyState();
          setStatus("Removed", "success");
        })
        .catch(function (err) { setStatus(err.message, "error"); });
    });
    head.appendChild(removeBtn);

    li.appendChild(head);

    if (item.type === "custom") {
      var urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.className = "menu-item-url-input";
      urlInput.maxLength = 500;
      urlInput.value = item.url || "";
      urlInput.addEventListener("blur", function () {
        var val = urlInput.value.trim();
        if (!val) { urlInput.value = item.url || ""; return; }
        if (val === item.url) return;
        item.url = val;
        postJSON(DATA.itemsBase + "/" + item.id, { url: val })
          .then(function () { setStatus("Saved", "success"); })
          .catch(function (err) { setStatus(err.message, "error"); });
      });
      li.appendChild(urlInput);
    }

    var childrenList = document.createElement("ul");
    childrenList.className = "menu-item-children";
    (item.children || []).forEach(function (child) { childrenList.appendChild(itemRow(child)); });
    li.appendChild(childrenList);

    return li;
  }

  function refreshEmptyState() {
    var hasTop = list.querySelector(":scope > .menu-item-row") !== null;
    emptyMsg.hidden = hasTop;
  }

  (DATA.items || []).forEach(function (item) { list.appendChild(itemRow(item)); });
  refreshEmptyState();

  // ---------- Add items (checkbox lists + custom link) ----------

  document.querySelectorAll(".menu-src-tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".menu-src-tab-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      var tab = btn.dataset.tab;
      document.querySelectorAll("[data-tab-panel]").forEach(function (panel) {
        panel.hidden = panel.dataset.tabPanel !== tab;
      });
    });
  });

  var productFilter = document.querySelector('.menu-src-filter[data-filter="product"]');
  if (productFilter) {
    productFilter.addEventListener("input", function () {
      var q = productFilter.value.trim().toLowerCase();
      document.querySelectorAll('[data-checklist="product"] .menu-src-check').forEach(function (label) {
        var text = label.textContent.toLowerCase();
        label.style.display = !q || text.indexOf(q) !== -1 ? "" : "none";
      });
    });
  }

  function addResolvedItem(type, targetId, label) {
    return postJSON(DATA.itemsBase, { type: type, target_id: targetId, label: label }).then(function (result) {
      var item = { id: result.id, type: type, target_id: targetId, label: label, url: null, children: [] };
      list.appendChild(itemRow(item));
      refreshEmptyState();
      return item;
    });
  }

  document.querySelectorAll(".menu-src-add").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var type = btn.dataset.type;
      if (type === "custom") {
        var labelInput = document.getElementById("customLinkLabel");
        var urlInput = document.getElementById("customLinkUrl");
        var url = urlInput.value.trim();
        if (!url) { setStatus("Give the custom link a URL.", "error"); urlInput.focus(); return; }
        postJSON(DATA.itemsBase, { type: "custom", label: labelInput.value.trim() || "Link", url: url })
          .then(function (result) {
            var item = { id: result.id, type: "custom", label: labelInput.value.trim() || "Link", url: url, children: [] };
            list.appendChild(itemRow(item));
            refreshEmptyState();
            labelInput.value = "";
            urlInput.value = "";
            setStatus("Added", "success");
          })
          .catch(function (err) { setStatus(err.message, "error"); });
        return;
      }

      var checklist = document.querySelector('[data-checklist="' + type + '"]');
      var checked = Array.prototype.slice.call(checklist.querySelectorAll("input:checked"));
      if (!checked.length) { setStatus("Check at least one item first.", "error"); return; }

      var chain = Promise.resolve();
      checked.forEach(function (cb) {
        chain = chain.then(function () { return addResolvedItem(type, cb.value, cb.dataset.label); }).then(function () { cb.checked = false; });
      });
      chain.then(function () { setStatus("Added", "success"); }).catch(function (err) { setStatus(err.message, "error"); });
    });
  });

  // ---------- Rename ----------

  var renameForm = document.getElementById("menuRenameForm");
  renameForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("menuNameInput").value.trim();
    if (!name) return;
    postJSON(DATA.renameUrl, { name: name })
      .then(function () { setStatus("Renamed", "success"); document.title = document.title.replace(/^Edit menu:.*? ·/, "Edit menu: " + name + " ·"); })
      .catch(function (err) { setStatus(err.message, "error"); });
  });

  // ---------- Drag to reorder / nest ----------
  // Handle-initiated (mousedown on the ⠿ handle arms dragging for just that
  // row) so clicking into a label/url input, or the remove button, never
  // accidentally starts a drag.

  var draggingLi = null;

  list.addEventListener("mousedown", function (e) {
    var handle = e.target.closest(".menu-drag-handle");
    if (!handle) return;
    var row = handle.closest(".menu-item-row");
    if (row) row.setAttribute("draggable", "true");
  });
  document.addEventListener("mouseup", clearDraggableFlags);
  function clearDraggableFlags() {
    list.querySelectorAll(".menu-item-row[draggable]").forEach(function (row) { row.removeAttribute("draggable"); });
  }

  function hasChildren(li) {
    return li.querySelector(":scope > .menu-item-children > .menu-item-row") !== null;
  }
  function isNested(li) {
    return li.parentElement && li.parentElement.classList.contains("menu-item-children");
  }
  function clearDropMarkers() {
    list.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-nest").forEach(function (el) {
      el.classList.remove("is-drop-before", "is-drop-after", "is-drop-nest");
    });
  }

  list.addEventListener("dragstart", function (e) {
    var row = e.target.closest(".menu-item-row");
    if (!row || !row.getAttribute("draggable")) return;
    draggingLi = row;
    row.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", row.dataset.id); } catch (err) { /* Firefox needs this set; ignore if it throws */ }
  });

  list.addEventListener("dragend", function () {
    if (draggingLi) draggingLi.classList.remove("is-dragging");
    draggingLi = null;
    clearDropMarkers();
    clearDraggableFlags();
  });

  list.addEventListener("dragover", function (e) {
    if (!draggingLi) return;
    var row = e.target.closest(".menu-item-row");
    if (!row || row === draggingLi || draggingLi.contains(row)) return;
    e.preventDefault();
    clearDropMarkers();

    var rect = row.getBoundingClientRect();
    var offsetX = e.clientX - rect.left;
    var offsetY = e.clientY - rect.top;
    // Nesting is only offered when it would stay one level deep: the
    // dragged item can't already have children of its own, the drop
    // target must be top-level (not already someone's child), and the
    // cursor has to be over the right two-thirds of the row -- a small
    // rightward nudge, not the default drop.
    var canNest = !hasChildren(draggingLi) && !isNested(row) && offsetX > rect.width * 0.35;

    if (canNest && offsetY > rect.height * 0.25 && offsetY < rect.height * 0.95) {
      row.classList.add("is-drop-nest");
    } else if (offsetY < rect.height / 2) {
      row.classList.add("is-drop-before");
    } else {
      row.classList.add("is-drop-after");
    }
  });

  list.addEventListener("drop", function (e) {
    if (!draggingLi) return;
    var row = e.target.closest(".menu-item-row");
    if (!row || row === draggingLi || draggingLi.contains(row)) { clearDropMarkers(); return; }
    e.preventDefault();

    if (row.classList.contains("is-drop-nest")) {
      var childrenList = row.querySelector(":scope > .menu-item-children");
      childrenList.appendChild(draggingLi);
    } else if (row.classList.contains("is-drop-before")) {
      row.parentElement.insertBefore(draggingLi, row);
    } else if (row.classList.contains("is-drop-after")) {
      row.parentElement.insertBefore(draggingLi, row.nextSibling);
    }

    clearDropMarkers();
    refreshEmptyState();
    setStatus("Unsaved changes — click “Save arrangement” to keep them.");
  });

  saveBtn.addEventListener("click", function () {
    var structure = [];
    function walk(container, parentId) {
      Array.prototype.forEach.call(container.querySelectorAll(":scope > .menu-item-row"), function (row) {
        structure.push({ id: parseInt(row.dataset.id, 10), parent_id: parentId });
        var childrenList = row.querySelector(":scope > .menu-item-children");
        if (childrenList) walk(childrenList, parseInt(row.dataset.id, 10));
      });
    }
    walk(list, null);

    saveBtn.disabled = true;
    postJSON(DATA.itemsBase + "/structure", { structure: structure })
      .then(function () { setStatus("Saved", "success"); })
      .catch(function (err) { setStatus(err.message, "error"); })
      .then(function () { saveBtn.disabled = false; });
  });
})();
