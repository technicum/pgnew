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
 * The modal is built lazily on first use and reused after that. It talks
 * to the same store-scoped endpoints as the standalone Library page
 * (/admin/media/list, /admin/media/upload) — the current admin session's
 * store id is what scopes every request, exactly like the Library page.
 */
(function () {
  var overlayEl = null;
  var gridEl = null;
  var fileInput = null;
  var currentCallback = null;

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
            '<input type="file" class="media-picker-file-input" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml,application/pdf" multiple hidden />' +
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
      if (f.mime_type && f.mime_type.indexOf('image/') === 0) {
        var img = document.createElement('img');
        img.src = f.url;
        img.alt = f.original_name;
        img.loading = 'lazy';
        btn.appendChild(img);
      } else {
        var badge = document.createElement('div');
        badge.className = 'media-card-filetype';
        badge.textContent = 'PDF';
        btn.appendChild(badge);
      }
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
        renderItems((data && data.ok && data.files) || []);
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
    open: function (callback) {
      ensureModal();
      currentCallback = callback;
      overlayEl.hidden = false;
      loadFiles();
    },
  };
})();
