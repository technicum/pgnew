// The creator's media library: their uploaded images and videos
// (GET /dashboard/media), to reuse one instead of uploading it again.
//
// Any file input marked data-library gets a "Library" button beside its
// upload button. Picking a file there fires a "media:pick" event on that
// input with { url } — each page's upload code listens for it and does what
// it does after an upload. Uploading from the library goes through the same
// /dashboard/uploads, which hands back the existing file when it's a
// duplicate (lib/uploads.js).
//
//   window.mediaLibrary.open({ kind: 'image' | 'video' }) → Promise<url | null>
(function () {
  if (window.mediaLibrary) return;

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/css/media-library.css';
  document.head.appendChild(css);

  const LIMITS = { image: 5, video: 30 };
  const ACCEPT = { image: 'image/jpeg,image/png,image/webp,image/gif', video: 'video/mp4,video/webm' };

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sizeLabel(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  const dateLabel = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  // --- the popup -------------------------------------------------------------
  let el = null;
  let files = null; // loaded once per page view, refreshed after changes
  let state = null; // { kind, resolve, opener }

  function build() {
    el = document.createElement('div');
    el.className = 'ml-backdrop';
    el.hidden = true;
    el.innerHTML = `
      <div class="ml-dialog" role="dialog" aria-modal="true" aria-labelledby="mlTitle">
        <div class="ml-head">
          <div>
            <h2 id="mlTitle">Media library</h2>
            <p class="ml-sub" data-ml-sub></p>
          </div>
          <input type="file" hidden data-ml-file />
          <button type="button" class="ml-upload" data-ml-upload>
            <svg viewBox="0 0 24 24" fill="none" width="15" height="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
            <span data-ml-upload-label>Upload new</span>
          </button>
          <button type="button" class="ml-close" data-ml-close aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" width="18" height="18" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <p class="ml-note" data-ml-note hidden></p>
        <div class="ml-body" data-ml-body></div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('[data-ml-close]')) return close(null);
      if (e.target.closest('[data-ml-upload]')) return el.querySelector('[data-ml-file]').click();
      const del = e.target.closest('[data-ml-delete]');
      if (del) return removeFile(del);
      const tile = e.target.closest('[data-ml-pick]');
      if (tile) close(tile.dataset.mlPick);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll('button:not([disabled])')]
          .filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    el.querySelector('[data-ml-file]').addEventListener('change', upload);
  }

  function note(text, kind) {
    const n = el.querySelector('[data-ml-note]');
    n.hidden = !text;
    n.textContent = text || '';
    n.className = `ml-note${kind === 'error' ? ' is-error' : ''}`;
  }

  function render() {
    const body = el.querySelector('[data-ml-body]');
    const kind = state.kind;
    const word = kind === 'video' ? 'videos' : 'images';
    el.querySelector('[data-ml-sub]').textContent = `Your uploaded ${word} — pick one to use it again.`;
    if (files === null) {
      body.innerHTML = '<p class="ml-empty">Loading your media…</p>';
      return;
    }
    const list = files.filter((f) => f.kind === kind);
    if (!list.length) {
      body.innerHTML = `<p class="ml-empty">No ${word} yet — upload one and it’ll be here to reuse anywhere.</p>`;
      return;
    }
    body.innerHTML = `<div class="ml-grid">${list.map((f) => `
      <div class="ml-tile">
        <button type="button" class="ml-pick" data-ml-pick="${escapeHTML(f.url)}" aria-label="Use ${escapeHTML(f.name)}">
          ${f.kind === 'image'
            ? `<img src="${escapeHTML(f.url)}" alt="" loading="lazy" />`
            : `<video src="${escapeHTML(f.url)}#t=0.5" muted preload="metadata"></video><span class="ml-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>`}
        </button>
        <div class="ml-meta">
          <span>${sizeLabel(f.size)} · ${escapeHTML(dateLabel(f.modified))}</span>
          ${f.usedIn.length
            ? `<span class="ml-used" title="${escapeHTML(f.usedIn.join(', '))}">In use</span>`
            : `<button type="button" class="ml-del" data-ml-delete="${escapeHTML(f.url)}" aria-label="Delete this file">Delete</button>`}
        </div>
      </div>`).join('')}</div>`;
  }

  async function load() {
    try {
      const res = await fetch('/dashboard/media', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      files = data.files;
    } catch (err) {
      files = [];
      note(err.message || 'Could not load your media.', 'error');
    }
    if (state) render();
  }

  async function upload(e) {
    const input = e.target;
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const kind = state.kind;
    if (!file.type.startsWith(`${kind}/`)) return note(kind === 'video' ? 'Choose an MP4 or WebM video.' : 'Choose a JPG, PNG, WebP or GIF image.', 'error');
    if (file.size > LIMITS[kind] * 1024 * 1024) return note(`That file is too big — keep ${kind}s under ${LIMITS[kind]} MB.`, 'error');
    const label = el.querySelector('[data-ml-upload-label]');
    label.textContent = 'Uploading…';
    try {
      const res = await fetch('/dashboard/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      files = null; // refreshed next time
      close(data.url);
      if (data.reused) toast('That file was already in your library — used the existing copy.');
    } catch (err) {
      note(err.message || 'Could not upload that file.', 'error');
    } finally {
      label.textContent = 'Upload new';
    }
  }

  async function removeFile(btn) {
    if (!btn.classList.contains('is-armed')) {
      btn.classList.add('is-armed');
      btn.textContent = 'Sure?';
      setTimeout(() => { if (btn.isConnected) { btn.classList.remove('is-armed'); btn.textContent = 'Delete'; } }, 3000);
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/dashboard/media/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: btn.dataset.mlDelete }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      files = files.filter((f) => f.url !== btn.dataset.mlDelete);
      note('Deleted.');
      render();
    } catch (err) {
      note(err.message || 'Could not delete that file.', 'error');
      btn.disabled = false;
    }
  }

  function open({ kind = 'image' } = {}) {
    if (!el) build();
    return new Promise((resolve) => {
      state = { kind: kind === 'video' ? 'video' : 'image', resolve, opener: document.activeElement };
      el.querySelector('[data-ml-file]').accept = ACCEPT[state.kind];
      note('');
      el.hidden = false;
      document.documentElement.classList.add('ml-open');
      render();
      load();
      el.querySelector('.ml-close').focus();
    });
  }

  function close(url) {
    if (!state) return;
    const { resolve, opener } = state;
    state = null;
    el.hidden = true;
    document.documentElement.classList.remove('ml-open');
    if (opener && opener.focus) opener.focus();
    resolve(url);
  }

  // A small message on the page after the popup closes.
  function toast(text) {
    const t = document.createElement('div');
    t.className = 'ml-toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // --- "Library" buttons beside marked upload inputs -------------------------
  function kindOf(input) {
    return input.dataset.library === 'video' || /video/.test(input.accept || '') ? 'video' : 'image';
  }
  function enhance(input) {
    if (input.dataset.libraryReady) return;
    input.dataset.libraryReady = '1';
    // The button goes after the upload control (the label that holds the input).
    const anchor = input.closest('label') || input;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ml-open-btn ${anchor.className || ''}`.replace(/\bpz-upload-btn\b|\bis-busy\b/g, '').trim();
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>Library</span>';
    btn.addEventListener('click', async () => {
      const url = await open({ kind: kindOf(input) });
      if (url) input.dispatchEvent(new CustomEvent('media:pick', { detail: { url }, bubbles: true }));
    });
    anchor.insertAdjacentElement('afterend', btn);
  }
  function scan(root) {
    root.querySelectorAll('input[type=file][data-library]').forEach(enhance);
  }
  // Upload controls drawn later (product cards, say) get theirs too.
  new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.matches && n.matches('input[type=file][data-library]')) enhance(n);
    else scan(n);
  }))).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document));
  else scan(document);

  window.mediaLibrary = { open, toast };
})();
