// "Remind me in 1/3/6/12 months" quick-fill buttons next to a follow-up's
// due-date field (see partials/followup-form.ejs and crm-followup.ejs) --
// fills the nearest .crm-fu-date-row's date input with today + N months
// rather than making someone hand-calculate a date a year out. Delegated on
// document so it works for every instance of the widget on a page (a
// contact's "Schedule a follow-up" form and a follow-up's own edit form can
// both be present at once) without per-instance wiring.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.crm-fu-date-preset');
  if (!btn) return;
  var row = btn.closest('.crm-fu-date-row');
  var input = row && row.querySelector('input[type="date"]');
  if (!input) return;
  var months = parseInt(btn.getAttribute('data-months'), 10) || 0;
  var d = new Date();
  d.setMonth(d.getMonth() + months);
  var pad = function (n) { return String(n).padStart(2, '0'); };
  input.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
});
