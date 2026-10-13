// Platform admin → Media (views/admin-media.ejs): the list of every uploaded
// file, filters, and deleting the ones nothing uses (POST /admin/media/delete,
// which re-checks each file — lib/adminMedia.js). Opens on "Ready to delete".
(function () {
  let files = window.__PZ_MEDIA__ || [];
  const UNUSED_DAYS = window.__PZ_UNUSED_DAYS__ || 90;
  const $ = (id) => document.getElementById(id);

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  const dateLabel = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const sum = (list) => list.reduce((t, f) => t + f.size, 0);

  const KIND_ICON = {
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  };
  const icon = (kind) => `<svg viewBox="0 0 24 24" fill="none" width="18" height="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_ICON[kind] || KIND_ICON.file}</svg>`;

  // --- creators filter -------------------------------------------------------
  const ownerSelect = $('mediaOwner');
  const owners = new Map();
  files.forEach((f) => owners.set(f.owner.id, f.owner));
  ownerSelect.innerHTML = '<option value="">All creators</option>' + [...owners.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => `<option value="${o.id}">${escapeHTML(o.name)}${o.handle ? ` (@${escapeHTML(o.handle)})` : ''}</option>`).join('');

  // --- list -------------------------------------------------------------------
  function statusHTML(f) {
    if (f.status === 'used') return `<span class="adm-pill is-used">In use</span><small>${escapeHTML(f.usedIn.join(', '))}</small>`;
    if (f.status === 'deletable') return '<span class="adm-pill is-ready">Ready to delete</span><small>Unused</small>';
    return `<span class="adm-pill">Unused</span><small>Can delete from ${escapeHTML(dateLabel(f.deletableFrom))}</small>`;
  }
  function rowHTML(f) {
    const preview = f.kind === 'image' && f.url
      ? `<img src="${escapeHTML(f.url)}" alt="" loading="lazy" />`
      : icon(f.kind);
    const name = f.url
      ? `<a href="${escapeHTML(f.url)}" target="_blank" rel="noopener">${escapeHTML(f.name)}</a>`
      : escapeHTML(f.name);
    return `
      <tr data-key="${escapeHTML(f.key)}">
        <td><span class="adm-thumb">${preview}</span></td>
        <td><span class="adm-name">${name}</span><small>${escapeHTML(f.where)}</small></td>
        <td><span class="adm-owner">${escapeHTML(f.owner.name)}</span><small>${escapeHTML(f.owner.email || (f.owner.handle ? `@${f.owner.handle}` : ''))}</small></td>
        <td class="adm-num">${sizeLabel(f.size)}</td>
        <td class="adm-num">${escapeHTML(dateLabel(f.modified))}</td>
        <td class="adm-status">${statusHTML(f)}</td>
        <td>${f.status === 'deletable' ? `<button type="button" class="ax-btn adm-del" data-delete="${escapeHTML(f.key)}">Delete</button>` : ''}</td>
      </tr>`;
  }

  const search = $('mediaSearch');
  const statusSelect = $('mediaStatus');
  const kindSelect = $('mediaKind');
  function shown() {
    const q = search.value.trim().toLowerCase();
    return files.filter((f) => (!statusSelect.value || f.status === statusSelect.value)
      && (!ownerSelect.value || String(f.owner.id) === ownerSelect.value)
      && (!kindSelect.value || f.kind === kindSelect.value)
      && (!q || `${f.name} ${f.owner.name} ${f.owner.handle} ${f.owner.email}`.toLowerCase().includes(q)));
  }

  const deleteAllBtn = $('deleteAllBtn');
  function render() {
    const list = shown();
    $('mediaRows').innerHTML = list.map(rowHTML).join('');
    const empty = $('mediaEmpty');
    empty.hidden = list.length > 0;
    empty.textContent = statusSelect.value === 'deletable' && !search.value && !ownerSelect.value && !kindSelect.value
      ? `Nothing to clean up — no file has gone unused for ${UNUSED_DAYS} days.`
      : 'No files match.';

    const used = files.filter((f) => f.status === 'used');
    const ready = files.filter((f) => f.status === 'deletable');
    $('statAll').textContent = files.length;
    $('statAllSize').textContent = sizeLabel(sum(files));
    $('statUsed').textContent = used.length;
    $('statUsedSize').textContent = sizeLabel(sum(used));
    $('statWaiting').textContent = files.filter((f) => f.status === 'unused').length;
    $('statReady').textContent = ready.length;
    $('statReadySize').textContent = ready.length ? `${sizeLabel(sum(ready))} to free up` : 'nothing to free up';

    // "Delete all ready" acts on what's listed (so a creator or type filter narrows it).
    const listedReady = list.filter((f) => f.status === 'deletable');
    deleteAllBtn.disabled = !listedReady.length;
    deleteAllBtn.textContent = listedReady.length
      ? `Delete ${listedReady.length} ready file${listedReady.length === 1 ? '' : 's'} (${sizeLabel(sum(listedReady))})`
      : 'Delete all ready';
    deleteAllBtn.classList.remove('is-armed');
  }
  [search, statusSelect, ownerSelect, kindSelect].forEach((el) => el.addEventListener('input', render));

  // --- deleting -----------------------------------------------------------------
  const flash = $('mediaFlash');
  function say(kind, text) {
    flash.hidden = false;
    flash.className = `ax-flash ${kind === 'error' ? 'ax-flash-error' : 'ax-flash-ok'}`;
    flash.textContent = text;
  }

  async function remove(keys) {
    const res = await fetch('/admin/media/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok || !data) throw new Error((data && data.error) || 'Could not delete those files.');
    const gone = new Set(data.deleted);
    files = files.filter((f) => !gone.has(f.key));
    // Ones the server refused (in use again, say) stop being offered.
    const skipped = new Map(data.skipped.map((s) => [s.key, s.reason]));
    files.forEach((f) => {
      if (skipped.has(f.key) && skipped.get(f.key) !== 'Already gone.') f.status = 'unused';
    });
    files = files.filter((f) => skipped.get(f.key) !== 'Already gone.');
    let text = data.deleted.length
      ? `Deleted ${data.deleted.length} file${data.deleted.length === 1 ? '' : 's'} — ${sizeLabel(data.freed)} freed.`
      : 'Nothing was deleted.';
    if (data.skipped.length) text += ` ${data.skipped.length} kept: ${[...new Set(data.skipped.map((s) => s.reason))].join(' ')}`;
    say(data.skipped.length && !data.deleted.length ? 'error' : 'ok', text);
    render();
  }

  // A second click confirms, the same as everywhere in the dashboard.
  function armed(btn, label) {
    if (btn.classList.contains('is-armed')) return true;
    btn.classList.add('is-armed');
    btn.dataset.was = btn.textContent;
    btn.textContent = label;
    setTimeout(() => {
      if (!btn.isConnected || !btn.classList.contains('is-armed')) return;
      btn.classList.remove('is-armed');
      btn.textContent = btn.dataset.was;
    }, 3000);
    return false;
  }

  $('mediaRows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete]');
    if (!btn || !armed(btn, 'Click again')) return;
    btn.disabled = true;
    try { await remove([btn.dataset.delete]); } catch (err) { say('error', err.message); btn.disabled = false; }
  });
  deleteAllBtn.addEventListener('click', async () => {
    const keys = shown().filter((f) => f.status === 'deletable').map((f) => f.key);
    if (!keys.length || !armed(deleteAllBtn, `Click again to delete ${keys.length}`)) return;
    deleteAllBtn.disabled = true;
    try { await remove(keys); } catch (err) { say('error', err.message); render(); }
  });

  // Nothing ready? Start on all files, so the page isn't blank.
  if (!files.some((f) => f.status === 'deletable')) statusSelect.value = '';
  render();
})();
