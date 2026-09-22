// Ticks every .live-duration element's displayed text as a running clock
// ("H:MM:SS", or "M:SS" under an hour), based on data-since (an ISO
// timestamp of when the current run started) and an optional
// data-base-seconds (time already banked before that) -- used by the
// Attendance screen's "worked today", the Tasks drawer's timer, and the
// header's active-timer banner. Purely client-side, so it never polls the
// server just to keep a number moving. Mirrors lib/attendance.js's
// formatClock exactly, so the page never jumps between two different
// formats the instant this takes over from the server-rendered value.
(function () {
  function formatClock(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    var ss = String(sec).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
  }

  function tick() {
    document.querySelectorAll('.live-duration[data-since]').forEach(function (el) {
      var since = new Date(el.getAttribute('data-since')).getTime();
      if (isNaN(since)) return;
      var base = parseFloat(el.getAttribute('data-base-seconds')) || 0;
      el.textContent = formatClock(base + (Date.now() - since) / 1000);
    });
  }

  tick();
  setInterval(tick, 1000);
})();
