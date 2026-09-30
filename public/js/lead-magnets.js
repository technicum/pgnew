// Lead magnets dashboard — talks to the real /dashboard/lead-magnets/*
// JSON endpoints (server.js). Magnets start from
// window.__PZ_INITIAL_MAGNETS__ (rendered server-side from
// PDZ_lead_magnets); every edit fires a debounced fetch() to persist,
// same pattern as public/js/builder.js.
(function () {
  let magnets = window.__PZ_INITIAL_MAGNETS__ || [];
  // The merchant's store origin (https://meera.pagezaper.com) — every
  // lead magnet's public page hangs off it.
  const storeUrl = window.__PZ_STORE_URL__;

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
  function publicUrl(magnet) {
    return `${storeUrl}/${magnet.slug}`;
  }
  const storeHost = storeUrl.replace(/^https?:\/\//, '');

  // Dashboard field name -> the column name magnets carry from the server.
  const FIELD_KEYS = { ctaText: 'cta_text', fileUrl: 'file_url', successMessage: 'success_message' };

  // Which cards have "Page options" open — render() rebuilds every card,
  // so this is what keeps a panel open across a toggle or a save.
  const openOptions = new Set();

  function statsHTML(magnet) {
    const views = magnet.view_count || 0;
    const signups = magnet.signup_count || 0;
    // Views only started counting after signups did, so an older magnet
    // can have more signups than views — no honest rate to show for it.
    const rate = views > 0 && signups <= views ? `${Math.round((signups / views) * 100)}%` : '—';
    return `
          <span class="pz-magnet-stat"><strong>${views}</strong> ${views === 1 ? 'view' : 'views'}</span>
          <span class="pz-magnet-stat"><strong>${signups}</strong> ${signups === 1 ? 'signup' : 'signups'}</span>
          <span class="pz-magnet-stat"><strong>${rate}</strong> conversion</span>`;
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
            <details class="pz-magnet-options" data-id="${magnet.id}"${openOptions.has(magnet.id) ? ' open' : ''}>
              <summary>Page options</summary>
              <div class="pz-magnet-option">
                <label for="slug-${magnet.id}">Link</label>
                <div class="pz-slug-field">
                  <span>${escapeHTML(storeHost)}/</span>
                  <input type="text" id="slug-${magnet.id}" class="slug-input" data-id="${magnet.id}" value="${escapeHTML(magnet.slug)}" maxlength="60" spellcheck="false" autocapitalize="off" />
                </div>
                <p class="pz-option-hint">Changing this breaks any link you’ve already shared.</p>
                <p class="pz-field-error slug-error"></p>
              </div>
              <div class="pz-magnet-option">
                <label for="success-${magnet.id}">Thank-you message</label>
                <textarea id="success-${magnet.id}" class="pz-field-input" data-field="successMessage" data-id="${magnet.id}" rows="2" maxlength="300" placeholder="Shown after signup — leave blank for the default." style="padding:8px 11px; resize:vertical;">${escapeHTML(magnet.success_message || '')}</textarea>
              </div>
              <div class="pz-magnet-option pz-option-row">
                <button type="button" class="pz-switch toggle-phone${magnet.collect_phone ? ' on' : ''}" data-id="${magnet.id}" aria-label="Ask for a phone number" aria-pressed="${magnet.collect_phone ? 'true' : 'false'}"></button>
                <span>Also ask for a phone number <span class="pz-option-hint">(optional for the visitor)</span></span>
              </div>
            </details>
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
            <input type="text" readonly value="${escapeHTML(publicUrl(magnet).replace(/^https?:\/\//, ''))}" onclick="this.select()" />
            <button type="button" class="pz-copy-btn copy-link-btn" data-id="${magnet.id}">Copy link</button>
            <a class="pz-copy-btn" href="${escapeHTML(publicUrl(magnet))}" target="_blank" rel="noopener">Open</a>
          </div>${statsHTML(magnet)}
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
        magnet[FIELD_KEYS[field] || field] = e.target.value;
        debouncedFieldSave(`${id}:${field}`, id, field, e.target.value);
      });
    });
    magnetsList.querySelectorAll('.pz-magnet-options').forEach((details) => {
      details.addEventListener('toggle', () => {
        const id = Number(details.dataset.id);
        if (details.open) openOptions.add(id); else openOptions.delete(id);
      });
    });
    // The link saves when the field is left (or Enter is pressed), not per
    // keystroke — every half-typed value would briefly be the live URL.
    magnetsList.querySelectorAll('.slug-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      });
      input.addEventListener('change', () => {
        const id = Number(input.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet || input.value.trim() === magnet.slug) return;
        const errorEl = input.closest('.pz-magnet-option').querySelector('.slug-error');
        errorEl.classList.remove('show');
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ slug: input.value }),
        }).then((data) => {
          // The server tidies the slug (lowercase, dashes) — show what it kept.
          magnet.slug = (data && data.slug) || magnet.slug;
          render();
        }).catch((err) => {
          input.value = magnet.slug;
          errorEl.textContent = err.message || 'Couldn’t change the link.';
          errorEl.classList.add('show');
        });
      });
    });
    magnetsList.querySelectorAll('.toggle-phone').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const magnet = magnets.find((m) => m.id === id);
        if (!magnet) return;
        magnet.collect_phone = magnet.collect_phone ? 0 : 1;
        render();
        api(`/dashboard/lead-magnets/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ collectPhone: !!magnet.collect_phone }),
        }).catch(() => {
          magnet.collect_phone = magnet.collect_phone ? 0 : 1;
          render();
        });
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
        try {
          await navigator.clipboard.writeText(publicUrl(magnet));
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
      // Deleting takes the public page and its counts with it, so the
      // first click only arms the button; a second within 3s deletes.
      const icon = btn.innerHTML;
      let disarmTimer = null;
      btn.addEventListener('click', (e) => {
        if (!btn.classList.contains('confirm')) {
          btn.classList.add('confirm');
          btn.textContent = 'Delete?';
          disarmTimer = setTimeout(() => {
            btn.classList.remove('confirm');
            btn.innerHTML = icon;
          }, 3000);
          return;
        }
        clearTimeout(disarmTimer);
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
          btn.classList.remove('confirm');
          btn.innerHTML = icon;
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
