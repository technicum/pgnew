// Full-screen editors (public/css/studio.css): tabs in the left panel and
// the preview's Desktop / Mobile switch. Both are remembered for the page
// (sessionStorage / localStorage — best-effort). A tab holding a field the
// browser flags as invalid on save is opened so the message is visible.
(function () {
  var store = function (kind, key, value) {
    try {
      var s = window[kind];
      if (value === undefined) return s.getItem(key);
      s.setItem(key, value);
    } catch (err) { /* storage off — just don't remember */ }
    return null;
  };

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-st-tab]'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('[data-st-panel]'));
  var foots = Array.prototype.slice.call(document.querySelectorAll('[data-st-foot]'));
  var tabKey = 'pz-studio-tab:' + location.pathname;
  var open = function (name, remember) {
    if (!tabs.some(function (t) { return t.getAttribute('data-st-tab') === name; })) name = tabs.length ? tabs[0].getAttribute('data-st-tab') : '';
    tabs.forEach(function (t) { t.setAttribute('aria-selected', t.getAttribute('data-st-tab') === name ? 'true' : 'false'); });
    panels.forEach(function (p) { p.hidden = p.getAttribute('data-st-panel') !== name; });
    // A tab can say which save bar it uses (data-st-foot="details lessons").
    foots.forEach(function (f) { f.hidden = f.getAttribute('data-st-foot').split(' ').indexOf(name) < 0; });
    if (remember) store('sessionStorage', tabKey, name);
    var scroll = document.querySelector('.st-scroll');
    if (scroll && remember) scroll.scrollTop = 0;
  };
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { open(t.getAttribute('data-st-tab'), true); });
  });
  // #tab-<name> opens that tab; a link to an element inside a tab
  // (#lessons, #lesson-12) opens its tab and scrolls to it.
  var target = null;
  try { target = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (err) { /* bad hash */ }
  var targetPanel = target && target.closest('[data-st-panel]');
  var wanted = (location.hash.match(/^#tab-(\w+)/) || [])[1] || (targetPanel && targetPanel.getAttribute('data-st-panel')) || store('sessionStorage', tabKey);
  if (tabs.length) open(wanted, !!targetPanel);
  if (targetPanel) target.scrollIntoView({ block: 'start' });

  document.addEventListener('invalid', function (e) {
    var panel = e.target.closest && e.target.closest('[data-st-panel]');
    if (panel && panel.hidden) open(panel.getAttribute('data-st-panel'), true);
  }, true);

  var device = document.querySelector('[data-st-device]');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-st-view]'));
  var show = function (view) {
    if (!device) return;
    view = view === 'mobile' ? 'mobile' : 'desktop';
    device.classList.toggle('is-mobile', view === 'mobile');
    device.classList.toggle('is-desktop', view !== 'mobile');
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-st-view') === view ? 'true' : 'false'); });
    store('localStorage', 'pz-studio-view', view);
  };
  buttons.forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-st-view')); }); });
  show(store('localStorage', 'pz-studio-view') || (window.innerWidth < 700 ? 'mobile' : 'desktop'));
})();
