// Live preview: the real public page, rendered by the server from the
// editor's unsaved fields (lib/livePreview.js), shown in a sandboxed
// iframe. Each update loads into a second, hidden frame that's swapped in
// once it has drawn — no white flash — and lands where the last one was
// scrolled to. A field that wouldn't save yet keeps the last good page
// and says what to fix.
//
//   window.livePreview(box, request) → refresh()
//     box: the element the frames go in ([data-live-preview]); a
//          [data-live-status] next to it shows "Updating…" / the problem.
//     request(): one update — { url, body, type, note? } (note: shown under
//          the page, e.g. "showing stand-ins"), or { error } to skip it and
//          say what to fix.
//
// The studio editors (event, course, booking service) need no code: a
// [data-live-preview="<url>"] box is bound to their form[data-pv-form].
(function () {
  var scrollY = 0;
  window.addEventListener('message', function (e) {
    if (e.data && typeof e.data.pvScroll === 'number') scrollY = e.data.pvScroll;
  });
  // Reports the page's scroll to the editor, and restores it on load.
  var SCROLL = '<script>(function(){var y=__Y__;addEventListener("load",function(){scrollTo(0,y);});'
    + 'addEventListener("scroll",function(){parent.postMessage({pvScroll:scrollY},"*");},{passive:true});})();<\/script>';

  function livePreview(box, request) {
    var status = (box.closest('[data-live-wrap]') || document).querySelector('[data-live-status]');
    var current = null;
    var timer = null;
    var seq = 0;
    var say = function (text, bad) {
      if (!status) return;
      status.textContent = text || '';
      status.classList.toggle('is-bad', !!bad);
      status.hidden = !text;
    };

    function show(html) {
      var frame = document.createElement('iframe');
      frame.className = 'lp-frame is-loading';
      frame.title = 'Live preview';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('tabindex', '-1');
      frame.addEventListener('load', function () {
        frame.classList.remove('is-loading');
        if (current && current !== frame) current.remove();
        current = frame;
      });
      frame.srcdoc = html.replace(/<head>/i, function (m) { return m + SCROLL.replace('__Y__', String(Math.round(scrollY))); });
      box.appendChild(frame);
    }

    function refresh() {
      clearTimeout(timer);
      var mine = ++seq;
      var r = request();
      // The editor already knows a field won't do: say so, keep the last page.
      if (r.error) { say(r.error + ' — the preview updates once that’s fixed.', true); return; }
      say('Updating…');
      fetch(r.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': r.type, Accept: 'text/html' },
        body: r.body,
      }).then(function (res) {
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, text: text }; });
      }).then(function (out) {
        if (mine !== seq) return;
        if (out.ok) { say(r.note || ''); show(out.text); return; }
        var message = 'The preview couldn’t update.';
        try { message = JSON.parse(out.text).error || message; } catch (err) { /* not JSON */ }
        say(out.status === 422 ? message + ' — the preview updates once that’s fixed.' : message, true);
      }).catch(function () {
        if (mine === seq) say('The preview couldn’t update — check your connection.', true);
      });
    }
    refresh.soon = function () {
      clearTimeout(timer);
      timer = setTimeout(refresh, 350);
    };
    return refresh;
  }
  window.livePreview = livePreview;

  // The studio editors: their form, posted as a save would post it.
  document.querySelectorAll('[data-live-preview]').forEach(function (box) {
    var form = document.querySelector('form[data-pv-form]');
    var url = box.getAttribute('data-live-preview');
    if (!form || !url) return;
    var refresh = livePreview(box, function () {
      return { url: url, type: 'application/x-www-form-urlencoded', body: new URLSearchParams(new FormData(form)).toString() };
    });
    form.addEventListener('input', refresh.soon);
    // Image uploads fill their input, then fire 'change'.
    form.addEventListener('change', refresh.soon);
    // Question rows added / removed by buttons fire 'input' themselves.
    refresh();
  });
})();
