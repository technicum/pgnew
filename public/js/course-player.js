// The course video player (views/app-course-learn.ejs [data-player]):
// our own controls in place of the browser's — so there's no download
// button or "Save video as…" menu — and the student's name, email and
// phone drifting slowly across the picture, fullscreen
// included (the whole player goes fullscreen, not the bare <video>), so a
// screen recording shows whose copy it was. The video itself comes from a
// signed link that expires and only plays on the student's own devices
// (lib/courseMedia.js, lib/courses.js lockDevice); it plays on one of them
// at a time (heartbeat below).
//
// None of this is DRM: it makes copying awkward and traceable, not
// impossible. Without this script the page still plays the video with the
// browser's controls (download hidden via controlslist).
(function () {
  var SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m23 9-6 6M17 9l6 6"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
    fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none">10</text></svg>',
  };

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (err) { /* private mode — no resume */ }
    return null;
  }

  function clock(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  }

  // The watermark drifts slowly to a new random spot every 20 seconds.
  function wander(box, mark) {
    var move = function () {
      var maxX = Math.max(0, box.clientWidth - mark.offsetWidth - 16);
      var maxY = Math.max(0, box.clientHeight - mark.offsetHeight - 56);
      mark.style.transform = 'translate(' + Math.round(8 + Math.random() * maxX) + 'px,' + Math.round(8 + Math.random() * maxY) + 'px)';
    };
    move();
    setInterval(move, 20000);
    window.addEventListener('resize', move);
    document.addEventListener('fullscreenchange', function () { setTimeout(move, 50); });
  }

  // One video at a time across a student's devices: the player tells the
  // store when it starts and every 20 s while playing; when another device
  // has started since, this one pauses (lib/courses.js claimPlayback).
  function heartbeat(box, video, msg) {
    var url = box.getAttribute('data-play');
    if (!url || !window.fetch) return;
    var timer = null;
    var send = function (start) {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: start }), credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) return;
          video.pause();
          msg.innerHTML = '<span></span> <button type="button" class="cp-reload">Play here</button>';
          msg.firstChild.textContent = data.message || 'This course is playing on another device.';
          msg.hidden = false;
          msg.querySelector('button').addEventListener('click', function () { msg.hidden = true; video.play(); });
        })
        .catch(function () { /* offline for a moment — try again on the next beat */ });
    };
    video.addEventListener('play', function () {
      send(true);
      clearInterval(timer);
      timer = setInterval(function () { if (!video.paused) send(false); }, 20000);
    });
    video.addEventListener('pause', function () { clearInterval(timer); });
  }

  // YouTube / Vimeo lessons: only the watermark is ours.
  document.querySelectorAll('.cp-embed [data-mark]').forEach(function (mark) {
    wander(mark.parentNode, mark);
  });

  document.querySelectorAll('[data-player]').forEach(function (box) {
    var video = box.querySelector('video');
    if (!video) return;
    var key = 'pz-pos:' + location.pathname;
    video.removeAttribute('controls');
    video.setAttribute('draggable', 'false');
    box.classList.add('cp-ready');

    box.insertAdjacentHTML('beforeend',
      (box.getAttribute('data-watermark') ? '<div class="cp-mark" aria-hidden="true"></div>' : '') +
      '<button type="button" class="cp-big" aria-label="Play">' + ICON.play + '</button>' +
      '<div class="cp-msg" hidden></div>' +
      '<div class="cp-bar">' +
        '<input class="cp-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">' +
        '<div class="cp-row">' +
          '<button type="button" class="cp-btn" data-act="play" aria-label="Play">' + ICON.play + '</button>' +
          '<button type="button" class="cp-btn" data-act="back" aria-label="Back 10 seconds">' + ICON.back + '</button>' +
          '<button type="button" class="cp-btn" data-act="fwd" aria-label="Forward 10 seconds">' + ICON.fwd + '</button>' +
          '<button type="button" class="cp-btn" data-act="mute" aria-label="Mute">' + ICON.vol + '</button>' +
          '<input class="cp-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">' +
          '<span class="cp-time">0:00 / 0:00</span>' +
          '<span class="cp-grow"></span>' +
          '<button type="button" class="cp-btn cp-speed" data-act="speed" aria-label="Playback speed">1×</button>' +
          '<button type="button" class="cp-btn" data-act="full" aria-label="Fullscreen">' + ICON.full + '</button>' +
        '</div>' +
      '</div>');

    var q = function (s) { return box.querySelector(s); };
    var mark = q('.cp-mark');
    if (mark) {
      mark.textContent = box.getAttribute('data-watermark');
      wander(box, mark);
    }
    var big = q('.cp-big');
    var seek = q('.cp-seek');
    var vol = q('.cp-vol');
    var time = q('.cp-time');
    var msg = q('.cp-msg');
    var btn = function (act) { return q('[data-act="' + act + '"]'); };

    var toggle = function () { if (video.paused || video.ended) video.play(); else video.pause(); };
    var skip = function (s) { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + s)); poke(); };
    var isFull = function () { return document.fullscreenElement === box || box.classList.contains('cp-fake-full'); };
    var full = function () {
      if (isFull()) {
        if (document.fullscreenElement) document.exitFullscreen();
        box.classList.remove('cp-fake-full');
        document.body.classList.remove('cp-lock');
      } else if (box.requestFullscreen) {
        box.requestFullscreen().catch(function () {});
      } else {
        // iPhone Safari has no element fullscreen — fill the window instead,
        // so the watermark stays on top.
        box.classList.add('cp-fake-full');
        document.body.classList.add('cp-lock');
      }
      setTimeout(paint, 60);
    };

    var paint = function () {
      var playing = !video.paused && !video.ended;
      btn('play').innerHTML = playing ? ICON.pause : ICON.play;
      btn('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
      big.hidden = playing;
      box.classList.toggle('is-playing', playing);
      btn('mute').innerHTML = video.muted || video.volume === 0 ? ICON.mute : ICON.vol;
      btn('full').innerHTML = isFull() ? ICON.exit : ICON.full;
      btn('speed').textContent = video.playbackRate + '×';
    };
    var tick = function () {
      var d = video.duration || 0;
      if (!seek.matches(':active')) seek.value = d ? Math.round((video.currentTime / d) * 1000) : 0;
      seek.style.setProperty('--p', (seek.value / 10) + '%');
      time.textContent = clock(video.currentTime) + ' / ' + clock(d);
    };

    // Controls fade while playing and the mouse is still.
    var idle;
    var poke = function () {
      box.classList.add('is-active');
      clearTimeout(idle);
      idle = setTimeout(function () { if (!video.paused) box.classList.remove('is-active'); }, 2500);
    };

    big.addEventListener('click', toggle);
    video.addEventListener('click', toggle);
    video.addEventListener('dblclick', full);
    btn('play').addEventListener('click', toggle);
    btn('back').addEventListener('click', function () { skip(-10); });
    btn('fwd').addEventListener('click', function () { skip(10); });
    btn('mute').addEventListener('click', function () { video.muted = !video.muted; if (!video.muted && !video.volume) video.volume = 1; vol.value = video.muted ? 0 : video.volume; paint(); });
    btn('full').addEventListener('click', full);
    btn('speed').addEventListener('click', function () {
      video.playbackRate = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length] || 1;
      paint();
    });
    vol.addEventListener('input', function () { video.volume = Number(vol.value); video.muted = video.volume === 0; paint(); });
    seek.addEventListener('input', function () {
      if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
      tick();
    });
    ['play', 'pause', 'ended', 'volumechange', 'ratechange'].forEach(function (e) { video.addEventListener(e, paint); });
    ['timeupdate', 'durationchange', 'loadedmetadata'].forEach(function (e) { video.addEventListener(e, tick); });
    document.addEventListener('fullscreenchange', paint);
    box.addEventListener('mousemove', poke);
    box.addEventListener('touchstart', poke, { passive: true });
    box.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    box.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' && e.key !== ' ') return;
      var k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); skip(-10); }
      else if (k === 'arrowright' || k === 'l') { e.preventDefault(); skip(10); }
      else if (k === 'f') { e.preventDefault(); full(); }
      else if (k === 'm') { e.preventDefault(); btn('mute').click(); }
      else if (k === 'escape' && box.classList.contains('cp-fake-full')) full();
      poke();
    });

    // Pick up where they left off (this lesson, this browser).
    video.addEventListener('loadedmetadata', function () {
      var at = Number(store(key));
      if (at > 5 && at < video.duration - 5) video.currentTime = at;
    });
    var last = 0;
    video.addEventListener('timeupdate', function () {
      if (Math.abs(video.currentTime - last) < 5) return;
      last = video.currentTime;
      store(key, String(Math.floor(video.currentTime)));
    });
    video.addEventListener('ended', function () { store(key, '0'); });

    // The signed link lasts an hour: if it runs out mid-lesson, a reload
    // gets a fresh one and resumes from the saved spot.
    video.addEventListener('error', function () {
      store(key, String(Math.floor(video.currentTime || 0)));
      msg.innerHTML = '<span>The video stopped loading.</span> <button type="button" class="cp-reload">Reload</button>';
      msg.hidden = false;
      msg.querySelector('button').addEventListener('click', function () { location.reload(); });
    });

    heartbeat(box, video, msg);
    paint();
    tick();
  });
})();
