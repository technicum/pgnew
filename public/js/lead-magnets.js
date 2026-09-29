// Lead magnets dashboard — talks to the real /dashboard/lead-magnets/*
// JSON endpoints (server.js). Magnets start from
// window.__PZ_INITIAL_MAGNETS__ (rendered server-side from
// PDZ_lead_magnets); every edit fires a debounced fetch() to persist,
// same pattern as public/js/builder.js.
(function () {
  let magnets = window.__PZ_INITIAL_MAGNETS__ || [];
  const handle = window.__PZ_USER_HANDLE__;
  const siteDomain = window.__PZ_SITE_DOMAIN__;

  const magnetsList = document.getElementById('magnetsList');
  const emptyMagnets = document.getElementById('emptyMagnets');
  const magnetCount = document.getElementById('magnetCount');
  const magnetCountLabel = document.getElementById('magnetCountLabel');
  const saveStatus = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- save status + fetch helper --------------------------------------
  let pending = 0;
  let clearErrorTimer = null;
  function setSaving() {
    pending += 1;
    saveStatus.classList.remove('error');
    saveStatus.classList.add('saving');
    saveStatusText.textContent = 'Saving…';
  }
  function setSaved() {
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
      saveStatus.classList.remove('saving', 'error');
      saveStatusText.textContent = 'Saved';
    }
  }
  function setError(message) {
    pending = Math.max(0, pending - 1);
    saveStatus.classList.remove('saving');
    saveStatus.classList.add('error');
    saveStatusText.textContent = message || 'Couldn’t save';
    clearTimeout(clearErrorTimer);
    clearErrorTimer = setTimeout(() => {
      if (pending === 0) {
        saveStatus.classList.remove('error');
        saveStatusText.textContent = 'Saved';
      }
    }, 4000);
  }

  async function api(url, options) {
    setSaving();
    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        setError(data && data.error);
        throw new Error((data && data.error) || `Request failed (${res.status})`);
      }
      setSaved();
      return data;
    } catch (err) {
      if (pending > 0) setError();
      throw err;
    }
  }

  function debounce(fn, wait) {
    const timers = {};
    return function (key, ...args) {
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => fn(key, ...args), wait);
    };
  }

  // --- rendering -----------------------------------------------------
  function publicPath(magnet) {
    return `/l/${handle}/${magnet.slug}`;
  }
  function publicUrl(magnet) {
    return `${siteDomain}${publicPath(magnet)}`;
  }

  function magnetCardHTML(magnet) {
    return `
      <div class="pz-magnet-card${magnet.visible ? '' : ' pz-hidden'}" data-id="${magnet.id}">
        <div class="pz-magnet-top">
          <div class="pz-magnet-icon">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v4"/><path d="M12 15h.01"/></svg>
          </div>
          <div class="pz-magnet-fields">
            <div class="pz-magnet-title-row">
              <input type="text" class="pz-field-input pz-title" data-field="title" data-id="${magnet.id}" value="${escapeHTML(magnet.title)}" placeholder="Title" style="font-weight:600;" />
              <input type="text" class="pz-field-input" data-field="ctaText" data-id="${magnet.id}" value="${escapeHTML(magnet.cta_text)}" placeholder="Button text" style="max-width:160px;" />
            </div>
            <textarea class="pz-field-input" data-field="description" data-id="${magnet.id}" rows="1" placeholder="Description (optional)" style="resize:vertical;">${escapeHTML(magnet.description)}</textarea>
            <input type="url" class="pz-field-input" data-field="fileUrl" data-id="${magnet.id}" value="${escapeHTML(magnet.file_url)}" placeholder="Link to the file" />
          </div>
          <div class="pz-magnet-actions">
            <button type="button" class="pz-switch toggle-visible${magnet.visible ? ' on' : ''}" data-id="${magnet.id}" title="${magnet.visible ? 'Live — visible to anyone with the link' : 'Unpublished — the link shows a not-found page'}" aria-label="Toggle published"></button>
            <button type="button" class="pz-icon-btn remove-magnet" data-id="${magnet.id}" aria-label="Delete lead magnet">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
            </button>
          </div>
        </div>
        <div class="pz-magnet-stats">
          <div class="pz-copy-link">
            <input type="text" readonly value="${escapeHTML(publicUrl(magnet))}" data-path="${escapeHTML(publicPath(magnet))}" onclick="this.select()" />
            <button type="button" class="pz-copy-btn copy-link-btn" data-id="${magnet.id}">Copy link</button>
          </div>
          <span class="pz-magnet-stat"><strong>${magnet.signup_count || 0}</strong> ${magnet.signup_count === 1 ? 'signup' : 'signups'}</span>
        </div>
      </div>`;
  }

  function updateCount() {
    magnetCount.textContent = magnets.length;
    magnetCountLabel.textContent = magnets.length === 1 ? 'lead magnet' : 'lead magnets';
  }

  function render() {
    magnetsList.innerHTML = magnets.map(magnetCardHTML).join('');
    magnetsList.style.display = magnets.length ? '' : 'none';
    emptyMagnets.style.display = magnets.length ? 'none' : 'flex';
    updateCount();
    attachCardListeners();
  }

  const debouncedFieldSave = debounce((key, id, field, value) => {
    api(`/dashboard/lead-magnets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
  }, 600);

  function attachCardListeners() {
    magnetsList.querySelectorAll('input[data-field], textarea[data-field]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const id = Number(e.target.dataset.id);
        const field = e.target.dataset.field;
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        const key = field === 'ctaText' ? 'cta_text' : field === 'fileUrl' ? 'file_url' : field;
        magnet[key] = e.target.value;
        debouncedFieldSave(`${id}:${field}`, id, field, e.target.value);
      });
    });
    magnetsList.querySelectorAll('.toggle-visible').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.visible = magnet.visible ? 0 : 1;
        render();
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ visible: !!magnet.visible }),
        }).catch(() => {
          magnet.visible = magnet.visible ? 0 : 1;
          render();
        });
      });
    });
    magnetsList.querySelectorAll('.copy-link-btn').forEach((btn) => {
      // Capture the button/input synchronously — event.currentTarget is
      // only valid while the event is still dispatching, and this handler
      // awaits a promise, so reading e.currentTarget after that await can
      // read back null.
      btn.addEventListener('click', async (e) => {
        const clickedBtn = e.currentTarget;
        const id = Number(clickedBtn.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        const input = clickedBtn.previousElementSibling;
        const url = `${window.location.origin}${publicPath(magnet)}`;
        try {
          await navigator.clipboard.writeText(url);
        } catch (err) {
          if (input) { input.select(); document.execCommand('copy'); }
        }
        const original = clickedBtn.textContent;
        clickedBtn.textContent = 'Copied!';
        clickedBtn.classList.add('copied');
        setTimeout(() => {
          clickedBtn.textContent = original;
          clickedBtn.classList.remove('copied');
        }, 1600);
      });
    });
    magnetsList.querySelectorAll('.remove-magnet').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const card = magnetsList.querySelector(`.pz-magnet-card[data-id="${id}"]`);
        if (card) card.classList.add('pz-removing');
        const previous = magnets;
        api(`/dashboard/lead-magnets/${id}`, { method: 'DELETE' }).then(() => {
          magnets = magnets.filter((m) => m.id !== id);
          render();
        }).catch(() => {
          magnets = previous;
          if (card) card.classList.remove('pz-removing');
        });
      });
    });
  }

  // --- create form ------------------------------------------------------
  const form = document.getElementById('createMagnetForm');
  const titleInput = document.getElementById('magnetTitle');
  const ctaInput = document.getElementById('magnetCta');
  const descriptionInput = document.getElementById('magnetDescription');
  const fileUrlInput = document.getElementById('magnetFileUrl');
  const formError = document.getElementById('createFormError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    try {
      const created = await api('/dashboard/lead-magnets', {
        method: 'POST',
        body: JSON.stringify({
          title: titleInput.value,
          ctaText: ctaInput.value,
          description: descriptionInput.value,
          fileUrl: fileUrlInput.value,
        }),
      });
      magnets.unshift(created);
      render();
      form.reset();
      titleInput.focus();
    } catch (err) {
      formError.textContent = err.message || 'Could not create that lead magnet. Please try again.';
      formError.classList.add('show');
    }
  });

  render();
})();
