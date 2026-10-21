// Onboarding niceties (views/signup.ejs, views/onboarding.ejs). Every step
// is a plain form post that works without this; here we add the password
// show/hide, the live link check, "+ Add your own" rows, the lunch-break
// toggle, Copy link, and a guard against double submits.
(function () {
  // --- password show / hide (step 1) -----------------------------------------
  document.querySelectorAll('[data-password-toggle]').forEach(function (btn) {
    var input = document.getElementById(btn.getAttribute('aria-controls'));
    if (!input) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.textContent = show ? 'Hide' : 'Show';
      input.focus();
    });
  });

  // --- one submit per step ------------------------------------------------------
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (form.dataset.sent) { e.preventDefault(); return; }
      form.dataset.sent = '1';
      if (form.classList.contains('ob-card')) form.classList.add('is-leaving');
    });
  });
  // Coming back with the browser's Back button: the form works again.
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-sent]').forEach(function (form) {
      delete form.dataset.sent;
      form.classList.remove('is-leaving');
    });
  });

  // --- step 3: the link, made from the business name and checked as you type ---------
  var nameInput = document.getElementById('businessName');
  var handleInput = document.getElementById('handle');
  var status = document.getElementById('handleStatus');
  if (handleInput && status) {
    var edited = !!handleInput.value;
    var timer = null;
    var seq = 0;
    var slug = function (v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24); };
    var say = function (text, kind) {
      status.textContent = text;
      status.classList.toggle('is-ok', kind === 'ok');
      status.classList.toggle('is-bad', kind === 'bad');
    };
    var check = function () {
      clearTimeout(timer);
      var value = slug(handleInput.value);
      if (!value) { say('Letters and numbers only. Leave it blank and we’ll make one from your business name.'); return; }
      timer = setTimeout(function () {
        var mine = ++seq;
        say('Checking…');
        fetch('/onboarding/handle?value=' + encodeURIComponent(value), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (out) {
            if (mine !== seq) return;
            if (!out) { say(''); return; }
            if (out.available) { say(out.handle + '.' + (status.getAttribute('data-domain') || '') + ' is available', 'ok'); return; }
            say(out.message + (out.suggestion ? ' ' : ''), 'bad');
            if (out.suggestion) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'ob-suggest';
              btn.textContent = 'Use ' + out.suggestion;
              btn.addEventListener('click', function () {
                handleInput.value = out.suggestion;
                edited = true;
                check();
                handleInput.focus();
              });
              status.appendChild(btn);
            }
          })
          .catch(function () { if (mine === seq) say(''); });
      }, 400);
    };
    handleInput.addEventListener('input', function () {
      edited = !!handleInput.value;
      var clean = slug(handleInput.value);
      if (clean !== handleInput.value) handleInput.value = clean;
      check();
    });
    if (nameInput) {
      nameInput.addEventListener('input', function () {
        if (edited) return;
        handleInput.value = slug(nameInput.value);
        check();
      });
    }
    if (handleInput.value) check();
  }

  // --- step 4: rows -----------------------------------------------------------------
  var offer = document.querySelector('[data-offer]');
  if (offer) {
    var addBtn = document.querySelector('[data-offer-add]');
    var template = offer.querySelector('[data-offer-template]');
    var maxCustom = Number(offer.getAttribute('data-max-custom')) || 10;
    var rows = function () { return offer.querySelectorAll('[data-offer-row]'); };
    var customKeys = function () {
      return Array.prototype.map.call(offer.querySelectorAll('input[type=hidden][name$="[key]"]'), function (i) { return i.value; })
        .filter(function (k) { return /^c\d+$/.test(k); });
    };
    var paintAdd = function () { addBtn.hidden = customKeys().length >= maxCustom; };
    offer.addEventListener('change', function (e) {
      if (!e.target.matches('[data-offer-on]')) return;
      e.target.closest('[data-offer-row]').classList.toggle('is-off', !e.target.checked);
    });
    if (addBtn && template) {
      paintAdd();
      addBtn.addEventListener('click', function () {
        var used = customKeys();
        var n = 1;
        while (used.indexOf('c' + n) !== -1) n += 1;
        var html = template.innerHTML.replace(/__i__/g, String(rows().length)).replace(/__key__/g, 'c' + n);
        var holder = document.createElement('div');
        holder.innerHTML = html.trim();
        var row = holder.firstChild;
        offer.insertBefore(row, template);
        row.querySelector('input[name$="[name]"]').focus();
        paintAdd();
      });
    }
  }

  // --- step 5: the lunch break's times show only when it's on --------------------------
  var lunch = document.querySelector('[data-lunch-toggle]');
  var lunchFields = document.querySelector('[data-lunch-fields]');
  if (lunch && lunchFields) {
    var paintLunch = function () { lunchFields.hidden = !lunch.checked; };
    lunch.addEventListener('change', paintLunch);
    paintLunch();
  }

  // --- step 7: copy link ------------------------------------------------------------------
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    if (!navigator.clipboard) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(btn.getAttribute('data-copy')).then(function () {
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy link'; }, 1800);
      }, function () { btn.textContent = 'Couldn’t copy'; });
    });
  });
})();
