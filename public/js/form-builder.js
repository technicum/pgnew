// Visual field builder for the Forms module (views/admin/form-edit.ejs).
// The two locked fields (name/phone) render as static rows straight from
// EJS -- this script only manages the draggable list of extra fields, then
// serializes the whole list to JSON into #fieldsJsonInput right before the
// surrounding <form> submits, for routes/admin.js's POST /forms/:id/edit
// to parse. Drag-to-reorder mirrors admin-menus.js's handle-initiated
// pattern (mousedown on the handle arms dragging for just that row, so
// clicking into a label input or a button never starts a drag) but flat --
// no nesting, since a form's fields are just an ordered list.
(function () {
  "use strict";
  var DATA = window.__FORM_BUILDER__;
  if (!DATA) return;

  var list = document.getElementById("customFieldsList");
  var emptyMsg = document.getElementById("customFieldsEmpty");
  var limitMsg = document.getElementById("formFieldsLimitMsg");
  var addButtons = document.querySelectorAll(".form-field-add");
  var form = document.getElementById("formEditForm");
  var fieldsJsonInput = document.getElementById("fieldsJsonInput");
  var maxCustom = DATA.maxCustom || 10;

  function refreshEmptyState() {
    var count = list.querySelectorAll(".form-field-row").length;
    emptyMsg.hidden = count > 0;
    var atMax = count >= maxCustom;
    limitMsg.hidden = !atMax;
    Array.prototype.forEach.call(addButtons, function (btn) { btn.disabled = atMax; });
  }

  function fieldRow(field) {
    var li = document.createElement("li");
    li.className = "form-field-row";

    var head = document.createElement("div");
    head.className = "form-field-row-head";

    var handle = document.createElement("span");
    handle.className = "form-field-drag-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";
    head.appendChild(handle);

    var labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "form-field-label-input";
    labelInput.maxLength = 60;
    labelInput.placeholder = "Field label";
    labelInput.value = field.label || "";
    head.appendChild(labelInput);

    var typeSelect = document.createElement("select");
    typeSelect.className = "form-field-type-select";
    (DATA.fieldTypes || []).forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = (DATA.fieldTypeLabels && DATA.fieldTypeLabels[t]) || t;
      if (t === field.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    head.appendChild(typeSelect);

    var reqLabel = document.createElement("label");
    reqLabel.className = "form-field-required-toggle";
    var reqCheckbox = document.createElement("input");
    reqCheckbox.type = "checkbox";
    reqCheckbox.checked = !!field.required;
    reqLabel.appendChild(reqCheckbox);
    reqLabel.appendChild(document.createTextNode("Required"));
    head.appendChild(reqLabel);

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
    return li;
  }

  (DATA.fields || [])
    .filter(function (f) { return f.key !== "name" && f.key !== "phone"; })
    .forEach(function (f) { list.appendChild(fieldRow(f)); });
  refreshEmptyState();

  Array.prototype.forEach.call(addButtons, function (btn) {
    btn.addEventListener("click", function () {
      if (list.querySelectorAll(".form-field-row").length >= maxCustom) return;
      var row = fieldRow({ label: "", type: btn.dataset.type, required: false });
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
      var label = row.querySelector(".form-field-label-input").value.trim();
      if (!label) return; // a blank label is dropped silently rather than blocking save
      fields.push({
        label: label,
        type: row.querySelector(".form-field-type-select").value,
        required: row.querySelector(".form-field-required-toggle input").checked,
      });
    });
    fieldsJsonInput.value = JSON.stringify(fields);
  });
})();
