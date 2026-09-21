// Bulk-tag bar on the CRM leads/customers list: keeps the select-all box, the
// "N selected" label and the Apply button in step with the row checkboxes.
// The button is rendered disabled and this script enables it; the server also
// rejects an empty selection, so nothing depends on it for safety.
(function () {
  var form = document.getElementById('crmBulkTagForm');
  if (!form) return;

  var selectAll = document.getElementById('crmSelectAll');
  var count = document.getElementById('crmBulkCount');
  var apply = document.getElementById('crmBulkApply');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.crm-select-row'));

  function update() {
    var selected = rows.filter(function (r) { return r.checked; }).length;
    count.textContent = selected ? '(' + selected + ' selected)' : '(none selected)';
    apply.disabled = selected === 0;
    selectAll.checked = selected > 0 && selected === rows.length;
    selectAll.indeterminate = selected > 0 && selected < rows.length;
  }

  selectAll.addEventListener('change', function () {
    rows.forEach(function (r) { r.checked = selectAll.checked; });
    update();
  });
  rows.forEach(function (r) { r.addEventListener('change', update); });
  update();
})();
