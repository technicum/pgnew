// Ticks every .live-duration element's displayed text as a running clock,
// based on data-since (an ISO timestamp of when the current run started)
// and an optional data-base-seconds (time already banked before that) --
// used by the Attendance screen, the Tasks drawer's timer, and the header's
// active-timer banner. Purely client-side, so it never polls the server
// just to keep a number moving.
(function () {
  function formatDuration(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  }

  function tick() {
    document.querySelectorAll('.live-duration[data-since]').forEach(function (el) {
      var since = new Date(el.getAttribute('data-since')).getTime();
      if (isNaN(since)) return;
      var base = parseFloat(el.getAttribute('data-base-seconds')) || 0;
      el.textContent = formatDuration(base + (Date.now() - since) / 1000);
    });
  }

  tick();
  setInterval(tick, 15000);
})();
