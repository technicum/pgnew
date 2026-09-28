// Visual field builder for the Forms module (views/admin/form-edit.ejs).
// Every field -- including what used to be the locked name/phone pair --
// is a normal row here: add, rename, retype, resize, reorder, or remove
// any of them. This script builds the whole draggable list client-side,
// then serializes it to JSON into #fieldsJsonInput right before the
// surrounding <form> submits, for routes/admin.js's POST /forms/:id/edit
// to re-validate and save (see lib/forms.js's sanitizeFieldList -- it
// re-keys every field by its final position, so the client never needs to
// track or send a field's key). Drag-to-reorder mirrors admin-menus.js's
// handle-initiated pattern (mousedown on the handle arms dragging for just
// that row, so clicking into a label/option input or a button never starts
// a drag) but flat -- no nesting, since a form's fields are just an
// ordered list.
(function () {
  "use strict";
  var DATA = window.__FORM_BUILDER__;
  if (!DATA) return;

  var TYPE_ICO = {
    text: "Aa", textarea: "¶", email: "@", tel: "☎", number: "#",
    select: "▾", radio: "◉", checkbox: "☑",
  };
  var CHOICE_TYPES = DATA.choiceTypes || [];
  var FULL_WIDTH_TYPES = DATA.fullWidthTypes || [];
  var MAX_FIELDS = DATA.maxFields || 12;
  var MAX_OPTIONS = DATA.maxOptions || 30;
  var DEFAULT_OPTIONS = ["Option 1", "Option 2", "Option 3"];

  var list = document.getElementById("customFieldsList");
  var emptyMsg = document.getElementById("customFieldsEmpty");
  var limitMsg = document.getElementById("formFieldsLimitMsg");
  var addButtons = document.querySelectorAll(".form-field-add");
  var form = document.getElementById("formEditForm");
  var fieldsJsonInput = document.getElementById("fieldsJsonInput");

  function refreshEmptyState() {
    var count = list.querySelectorAll(".form-field-row").length;
    emptyMsg.hidden = count > 0;
    var atMax = count >= MAX_FIELDS;
    limitMsg.hidden = !atMax;
    Array.prototype.forEach.call(addButtons, function (btn) { btn.disabled = atMax; });
  }

  function fieldRow(f) {
    var li = document.createElement("li");
    li.className = "form-field-row";

    // ---- head: drag handle, type icon, label, type select, remove ----
    var head = document.createElement("div");
    head.className = "form-field-row-head";

    var handle = document.createElement("span");
    handle.className = "form-field-drag-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";
    head.appendChild(handle);

    var ico = document.createElement("span");
    ico.className = "form-field-type-ico";
    ico.textContent = TYPE_ICO[f.type] || "Aa";
    head.appendChild(ico);

    var labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "form-field-label-input";
    labelInput.maxLength = 80;
    labelInput.placeholder = "Field label";
    labelInput.value = f.label || "";
    head.appendChild(labelInput);

    var typeSelect = document.createElement("select");
    typeSelect.className = "form-field-type-select";
    (DATA.fieldTypes || []).forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = (DATA.fieldTypeLabels && DATA.fieldTypeLabels[t]) || t;
      if (t === f.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener("change", function () {
      ico.textContent = TYPE_ICO[typeSelect.value] || "Aa";
      sizeSelect.disabled = FULL_WIDTH_TYPES.indexOf(typeSelect.value) !== -1;
      var isChoice = CHOICE_TYPES.indexOf(typeSelect.value) !== -1;
      optionsRow.hidden = !isChoice;
      if (isChoice && !optionsList.children.length) {
        DEFAULT_OPTIONS.forEach(function (o) { addOptionRow(o, false); });
      }
    });
    head.appendChild(typeSelect);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "form-field-remove";
    removeBtn.title = "Remove field";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", function () {
      li.remove();
      refreshEmptyState();
    });
    head.appendChild(removeBtn);

    li.appendChild(head);

    // ---- meta row: size + required, indented under the label ----
    var meta = document.createElement("div");
    meta.className = "form-field-row-meta";

    var sizeWrap = document.createElement("label");
    sizeWrap.className = "form-field-size-wrap";
    sizeWrap.appendChild(document.createTextNode("Size"));
    var sizeSelect = document.createElement("select");
    sizeSelect.className = "form-field-size-select";
    [["small", "Small"], ["medium", "Medium"], ["large", "Large"]].forEach(function (pair) {
      var opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      if (pair[0] === (f.size || "medium")) opt.selected = true;
      sizeSelect.appendChild(opt);
    });
    sizeSelect.disabled = FULL_WIDTH_TYPES.indexOf(f.type) !== -1;
    sizeWrap.appendChild(sizeSelect);
    meta.appendChild(sizeWrap);

    var switchWrap = document.createElement("label");
    switchWrap.className = "form-field-required-toggle";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!f.required;
    switchWrap.appendChild(cb);
    switchWrap.appendChild(document.createTextNode("Required"));
    meta.appendChild(switchWrap);

    li.appendChild(meta);

    // ---- options row: only shown for dropdown/radio/checkbox -- a real
    // add/remove list of choices, not a comma-separated line ----
    var optionsRow = document.createElement("div");
    optionsRow.className = "form-field-options-row";

    var optionsLabel = document.createElement("p");
    optionsLabel.className = "form-field-options-label";
    optionsLabel.textContent = "Choices";
    optionsRow.appendChild(optionsLabel);

    var optionsList = document.createElement("ul");
    optionsList.className = "form-field-options-list";
    optionsRow.appendChild(optionsList);

    function addOptionRow(text, focus) {
      var oli = document.createElement("li");
      oli.className = "form-field-option-row";

      var bullet = document.createElement("span");
      bullet.className = "form-field-option-bullet";
      bullet.textContent = "•";
      oli.appendChild(bullet);

      var oInput = document.createElement("input");
      oInput.type = "text";
      oInput.className = "form-field-option-input";
      oInput.maxLength = 80;
      oInput.placeholder = "Option label";
      oInput.value = text || "";
      oli.appendChild(oInput);

      var oRemove = document.createElement("button");
      oRemove.type = "button";
      oRemove.className = "form-field-option-remove";
      oRemove.title = "Remove option";
      oRemove.textContent = "✕";
      oRemove.addEventListener("click", function () { oli.remove(); });
      oli.appendChild(oRemove);

      optionsList.appendChild(oli);
      if (focus) oInput.focus();
    }

    (f.options && f.options.length ? f.options : (CHOICE_TYPES.indexOf(f.type) !== -1 ? DEFAULT_OPTIONS : []))
      .forEach(function (o) { addOptionRow(o, false); });

    var addOptionBtn = document.createElement("button");
    addOptionBtn.type = "button";
    addOptionBtn.className = "form-field-option-add";
    addOptionBtn.textContent = "+ Add option";
    addOptionBtn.addEventListener("click", function () { addOptionRow("", true); });
    optionsRow.appendChild(addOptionBtn);

    // ---- paste a comma-separated list (e.g. a list of cities) to fill
    // the whole choice list in one go, instead of adding rows one by one --
    // this REPLACES whatever's currently in the list, since it's meant for
    // "here's my full list, use this" rather than appending to it. ----
    var pasteWrap = document.createElement("div");
    pasteWrap.className = "form-field-options-paste";

    var pasteInput = document.createElement("input");
    pasteInput.type = "text";
    pasteInput.className = "form-field-options-paste-input";
    pasteInput.placeholder = "Or paste a comma-separated list, e.g. Mumbai, Delhi, Bangalore";

    var pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.className = "form-field-options-paste-btn";
    pasteBtn.textContent = "Use list";

    function applyPastedList() {
      var parts = pasteInput.value
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(Boolean)
        .slice(0, MAX_OPTIONS);
      if (!parts.length) return;
      optionsList.innerHTML = "";
      parts.forEach(function (o) { addOptionRow(o, false); });
      pasteInput.value = "";
    }
    pasteBtn.addEventListener("click", applyPastedList);
    pasteInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyPastedList(); }
    });

    pasteWrap.appendChild(pasteInput);
    pasteWrap.appendChild(pasteBtn);
    optionsRow.appendChild(pasteWrap);

    optionsRow.hidden = CHOICE_TYPES.indexOf(f.type) === -1;
    li.appendChild(optionsRow);

    li._get = function () {
      return {
        label: labelInput.value.trim(),
        type: typeSelect.value,
        required: cb.checked,
        size: sizeSelect.value,
        options: Array.prototype.map.call(optionsList.querySelectorAll(".form-field-option-input"), function (inp) {
          return inp.value.trim();
        }).filter(Boolean),
      };
    };
    return li;
  }

  (DATA.fields || []).forEach(function (f) { list.appendChild(fieldRow(f)); });
  refreshEmptyState();

  Array.prototype.forEach.call(addButtons, function (btn) {
    btn.addEventListener("click", function () {
      if (list.querySelectorAll(".form-field-row").length >= MAX_FIELDS) return;
      var row = fieldRow({ label: btn.dataset.label || "", type: btn.dataset.type, required: false });
      list.appendChild(row);
      refreshEmptyState();
      row.querySelector(".form-field-label-input").focus();
    });
  });

  // ---------- Drag to reorder (flat list) ----------

  var draggingLi = null;

  list.addEventListener("mousedown", function (e) {
    var handle = e.target.closest(".form-field-drag-handle");
    if (!handle) return;
    var row = handle.closest(".form-field-row");
    if (row) row.setAttribute("draggable", "true");
  });
  document.addEventListener("mouseup", function () {
    list.querySelectorAll(".form-field-row[draggable]").forEach(function (row) { row.removeAttribute("draggable"); });
  });

  function clearDropMarkers() {
    list.querySelectorAll(".is-drop-before, .is-drop-after").forEach(function (el) {
      el.classList.remove("is-drop-before", "is-drop-after");
    });
  }

  list.addEventListener("dragstart", function (e) {
    var row = e.target.closest(".form-field-row");
    if (!row || !row.getAttribute("draggable")) return;
    draggingLi = row;
    row.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "1"); } catch (err) { /* Firefox needs this set; ignore if it throws */ }
  });

  list.addEventListener("dragend", function () {
    if (draggingLi) draggingLi.classList.remove("is-dragging");
    draggingLi = null;
    clearDropMarkers();
    list.querySelectorAll(".form-field-row[draggable]").forEach(function (row) { row.removeAttribute("draggable"); });
  });

  list.addEventListener("dragover", function (e) {
    if (!draggingLi) return;
    var row = e.target.closest(".form-field-row");
    if (!row || row === draggingLi) return;
    e.preventDefault();
    clearDropMarkers();
    var rect = row.getBoundingClientRect();
    if (e.clientY - rect.top < rect.height / 2) row.classList.add("is-drop-before");
    else row.classList.add("is-drop-after");
  });

  list.addEventListener("drop", function (e) {
    if (!draggingLi) return;
    var row = e.target.closest(".form-field-row");
    if (!row || row === draggingLi) { clearDropMarkers(); return; }
    e.preventDefault();
    if (row.classList.contains("is-drop-before")) list.insertBefore(draggingLi, row);
    else list.insertBefore(draggingLi, row.nextSibling);
    clearDropMarkers();
  });

  // ---------- Serialize on submit ----------

  form.addEventListener("submit", function () {
    var fields = [];
    list.querySelectorAll(".form-field-row").forEach(function (row) {
      var f = row._get();
      if (!f.label) return; // a blank label is dropped silently rather than blocking save
      fields.push(f);
    });
    fieldsJsonInput.value = JSON.stringify(fields);
  });
})();
