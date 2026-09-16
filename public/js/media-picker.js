/*
 * Reusable media picker modal — one instance shared by the whole admin.
 *
 * Usage from any page that has loaded this script and the store's own
 * admin CSS (the .media-picker-* rules live in public/css/admin.css):
 *
 *   MediaPicker.open(function (file) {
 *     // file.url is what you want in a URL field.
 *     // file.mime_type / file.original_name are also available.
 *   });
 *
 * Pass a second argument to restrict both the grid and the modal's own
 * upload button to one file family — e.g. a video URL field only wants to
 * see/upload videos, not get images mixed into the same picker:
 *
 *   MediaPicker.open(callback, { accept: 'video/' });
 *
 * `accept` is a mime-type prefix ('image/', 'video/'); omit it to show and
 * accept everything the library allows.
 *
 * The modal is built lazily on first use and reused after that. It talks
 * to the same store-scoped endpoints as the standalone Library page
 * (/admin/media/list, /admin/media/upload) — the current admin session's
 * store id is what scopes every request, exactly like the Library page.
 */
(function () {
  // Mirrors lib/media.js's ALLOWED_MIME_TYPES, split by family so the
  // upload <input accept> can be narrowed per call. Keep in sync with that
  // file if the set of supported types ever changes.
  var ACCEPT_BY_PREFIX = {
    'image/': 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml',
    'video/': 'video/mp4,video/webm',
  };
  var ACCEPT_ALL = 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml,video/mp4,video/webm,application/pdf';

  var overlayEl = null;
  var gridEl = null;
  var fileInput = null;
  var currentCallback = null;
  var currentAccept = null; // mime-prefix filter for the open() call in progress, or null for "everything"

  function ensureModal() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'media-picker-overlay';
    overlayEl.hidden = true;
    overlayEl.innerHTML =
      '<div class="media-picker-modal" role="dialog" aria-modal="true" aria-label="Choose media">' +
        '<div class="media-picker-header">' +
          '<h3>Choose media</h3>' +
          '<button type="button" class="media-picker-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="media-picker-body">' +
          '<div class="media-picker-upload-row">' +
            '<input type="file" class="media-picker-file-input" multiple hidden />' +
            '<button type="button" class="btn btn-secondary media-picker-upload-btn">Upload new file</button>' +
          '</div>' +
          '<div class="media-picker-grid"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlayEl);

    gridEl = overlayEl.querySelector('.media-picker-grid');
    fileInput = overlayEl.querySelector('.media-picker-file-input');
    var uploadBtn = overlayEl.querySelector('.media-picker-upload-btn');
    var closeBtn = overlayEl.querySelector('.media-picker-close');

    uploadBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files);
      fileInput.value = '';
    });
    closeBtn.addEventListener('click', close);
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlayEl && !overlayEl.hidden) close();
    });
  }

  function close() {
    if (overlayEl) overlayEl.hidden = true;
    currentCallback = null;
    currentAccept = null;
  }

  // A thumbnail for one grid item: an actual preview for images and videos
  // (browsers show a video's first frame from `preload="metadata"` even
  // without ever playing it), a plain badge for anything else (PDF).
  function thumbFor(f) {
    var mime = f.mime_type || '';
    if (mime.indexOf('image/') === 0) {
      var img = document.createElement('img');
      img.src = f.url;
      img.alt = f.original_name;
      img.loading = 'lazy';
      return img;
    }
    if (mime.indexOf('video/') === 0) {
      var video = document.createElement('video');
      video.src = f.url;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      return video;
    }
    var badge = document.createElement('div');
    badge.className = 'media-card-filetype';
    badge.textContent = mime === 'application/pdf' ? 'PDF' : 'FILE';
    return badge;
  }

  function renderItems(files) {
    gridEl.innerHTML = '';
    if (!files.length) {
      var empty = document.createElement('p');
      empty.className = 'media-picker-empty';
      empty.textContent = 'No files yet. Upload your first one above.';
      gridEl.appendChild(empty);
      return;
    }
    files.forEach(function (f) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'media-picker-item';
      btn.title = f.original_name;
      btn.appendChild(thumbFor(f));
      btn.addEventListener('click', function () { select(f); });
      gridEl.appendChild(btn);
    });
  }

  function select(file) {
    var cb = currentCallback;
    close();
    if (cb) cb(file);
  }

  function loadFiles() {
    gridEl.innerHTML = '<p class="media-picker-empty">Loading…</p>';
    fetch('/admin/media/list?limit=100', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var files = (data && data.ok && data.files) || [];
        if (currentAccept) {
          files = files.filter(function (f) { return f.mime_type && f.mime_type.indexOf(currentAccept) === 0; });
        }
        renderItems(files);
      })
      .catch(function () { renderItems([]); });
  }

  function uploadFiles(fileList) {
    var formData = new FormData();
    Array.prototype.forEach.call(fileList, function (file) { formData.append('files', file); });
    fetch('/admin/media/upload', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && data.files && data.files.length) {
          // Picking the picker's own "Upload new file" button almost always
          // means "I want to use this file right now" — auto-select the
          // first uploaded file instead of making the merchant hunt for the
          // thing they just added to the grid.
          select(data.files[0]);
        } else {
          alert((data && data.error) || 'Upload failed.');
          loadFiles();
        }
      })
      .catch(function () {
        alert('Upload failed.');
        loadFiles();
      });
  }

  window.MediaPicker = {
    open: function (callback, opts) {
      ensureModal();
      currentCallback = callback;
      currentAccept = (opts && opts.accept) || null;
      fileInput.setAttribute('accept', (currentAccept && ACCEPT_BY_PREFIX[currentAccept]) || ACCEPT_ALL);
      overlayEl.hidden = false;
      loadFiles();
    },
  };
})();
