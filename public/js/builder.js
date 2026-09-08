// Real page builder frontend — talks to the JSON API in routes/admin.js
// (mounted under /admin/pages/:id/sections...). Field edits auto-save on
// blur/change; add/delete/toggle/reorder call the API then update the DOM
// (add/toggle reload the page since the new/changed markup differs per
// section type — simplest way to stay correct without duplicating every
// section's HTML in JS).
(function () {
  const canvas = document.getElementById('builder-canvas');
  if (!canvas) return;

  const pageId = canvas.dataset.pageId;
  const base = `/admin/pages/${pageId}/sections`;

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());
  }

  // ---- Add section ----
  document.querySelectorAll('.builder-add-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      post(base, { type: btn.dataset.type }).then(function (res) {
        if (res && res.ok) {
          location.reload();
        } else {
          btn.disabled = false;
          alert((res && res.error) || 'Could not add that section.');
        }
      });
    });
  });

  // ---- Field auto-save ----
  canvas.addEventListener('change', function (e) {
    const field = e.target.closest('[data-field]');
    if (!field) return;
    const card = e.target.closest('.builder-card');
    const sectionId = card.dataset.sectionId;
    const key = field.dataset.field;

    let patch;
    if (key.indexOf('.') !== -1) {
      // "quotes.0.quote" / "quotes.0.author" -> { quotes: [{ quote, author }] }
      const parts = key.split('.'); // ['quotes', '0', 'quote'|'author']
      const thisKey = parts[2];
      const otherKey = thisKey === 'quote' ? 'author' : 'quote';
      const otherField = card.querySelector(`[data-field="quotes.0.${otherKey}"]`);
      const quote = {};
      quote[thisKey] = field.value;
      quote[otherKey] = otherField ? otherField.value : '';
      patch = { quotes: [quote] };
    } else {
      patch = {};
      patch[key] = field.value;
    }

    field.classList.add('builder-field-saving');
    post(`${base}/${sectionId}`, { fields: patch }).finally(function () {
      field.classList.remove('builder-field-saving');
    });
  });

  // ---- Delete / toggle ----
  canvas.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.builder-card');
    const sectionId = card.dataset.sectionId;

    if (btn.dataset.action === 'delete') {
      if (!confirm('Delete this section?')) return;
      post(`${base}/${sectionId}/delete`).then(function (res) {
        if (res && res.ok) {
          card.remove();
          if (!canvas.querySelector('.builder-card')) location.reload();
        }
      });
    } else if (btn.dataset.action === 'toggle') {
      post(`${base}/${sectionId}/toggle`).then(function (res) {
        if (res && res.ok) location.reload();
      });
    }
  });

  // ---- Drag-and-drop reorder ----
  let dragEl = null;
  canvas.addEventListener('dragstart', function (e) {
    const card = e.target.closest('.builder-card');
    if (!card) return;
    dragEl = card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.sectionId);
  });
  canvas.addEventListener('dragover', function (e) {
    if (!dragEl) return;
    e.preventDefault();
    const card = e.target.closest('.builder-card');
    if (!card || card === dragEl) return;
    const rect = card.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    canvas.insertBefore(dragEl, before ? card : card.nextSibling);
  });
  canvas.addEventListener('drop', function (e) {
    if (!dragEl) return;
    e.preventDefault();
    dragEl = null;
    const order = Array.from(canvas.querySelectorAll('.builder-card')).map(function (c) {
      return c.dataset.sectionId;
    });
    post(`${base}/reorder`, { order: order });
  });
  canvas.addEventListener('dragend', function () {
    dragEl = null;
  });
})();
