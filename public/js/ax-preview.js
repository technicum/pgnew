// Live preview beside an app editor (booking service, course) — the
// payment page builder's layout: fields on the left, what visitors will
// see on the right, updated as you type. The preview markup lives in the
// view; this binds it to the fields of the editor's form[data-pv-form]:
//
//   data-pv-text="title"        textContent ← the field (data-pv-empty when blank)
//   data-pv-show="cover_url"    hidden while the field is blank
//   data-pv-img="cover_url"     src ← the field
//   data-pv-rich="description"  rendered in lib/richText.js's small format
//   data-pv-lines="outcomes"    one <li> per non-empty line
//
// Anything page-specific (prices, choices) is a function the view puts in
// window.axPreview, called with get(name) after every change.
(function () {
  var form = document.querySelector('form[data-pv-form]');
  var screen = document.querySelector('[data-pv-screen]');
  if (!form || !screen) return;

  function get(name) {
    var els = form.querySelectorAll('[name="' + name + '"]');
    if (!els.length) return '';
    var el = els[0];
    if (el.type === 'radio') {
      var on = form.querySelector('[name="' + name + '"]:checked');
      return on ? on.value : '';
    }
    if (el.type === 'checkbox') return el.checked ? el.value : '';
    return String(el.value || '').trim();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function inline(t) {
    return t
      .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)/g, '<a>$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  }
  // Same rules as lib/richText.js, for the preview only.
  function rich(text) {
    var out = [];
    var list = null;
    var para = [];
    var flush = function () {
      if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
      if (list) { out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>'); list = null; }
    };
    esc(text).split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      var m;
      if (!line) return flush();
      if ((m = line.match(/^#{2,3}\s+(.*)$/))) { flush(); out.push('<h3>' + inline(m[1]) + '</h3>'); return undefined; }
      if ((m = line.match(/^[-*]\s+(.*)$/)) || (m = line.match(/^\d{1,3}[.)]\s+(.*)$/))) {
        var tag = /^\d/.test(line) ? 'ol' : 'ul';
        if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
        if (list && list.tag !== tag) flush();
        if (!list) list = { tag: tag, items: [] };
        list.items.push('<li>' + inline(m[1]) + '</li>');
        return undefined;
      }
      if (list) flush();
      para.push(inline(line));
      return undefined;
    });
    flush();
    return out.join('');
  }

  function paint() {
    screen.querySelectorAll('[data-pv-text]').forEach(function (el) {
      el.textContent = get(el.getAttribute('data-pv-text')) || el.getAttribute('data-pv-empty') || '';
    });
    screen.querySelectorAll('[data-pv-show]').forEach(function (el) {
      el.hidden = !get(el.getAttribute('data-pv-show'));
    });
    screen.querySelectorAll('[data-pv-img]').forEach(function (el) {
      var src = get(el.getAttribute('data-pv-img'));
      if (src && el.getAttribute('src') !== src) el.setAttribute('src', src);
    });
    screen.querySelectorAll('[data-pv-rich]').forEach(function (el) {
      el.innerHTML = rich(get(el.getAttribute('data-pv-rich')));
    });
    screen.querySelectorAll('[data-pv-lines]').forEach(function (el) {
      el.innerHTML = get(el.getAttribute('data-pv-lines')).split(/\r?\n/)
        .map(function (l) { return l.replace(/^\s*[-*•]\s*/, '').trim(); }).filter(Boolean).slice(0, 10)
        .map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    });
    if (typeof window.axPreview === 'function') window.axPreview(get, screen);
  }

  form.addEventListener('input', paint);
  form.addEventListener('change', paint);
  // Image fields fill their input from an upload, then fire 'change'.
  paint();
})();
