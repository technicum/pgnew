// Audience page — talks to the real /dashboard/audience/* JSON endpoints
// (server.js). Contacts start from window.__PZ_INITIAL_CONTACTS__
// (rendered server-side from PDZ_contacts); add/delete each fire a
// fetch() to persist. Search is client-side only, over what's already
// on the page — nothing new to fetch for that.
(function () {
  let contacts = window.__PZ_INITIAL_CONTACTS__ || [];

  const contactsList = document.getElementById('contactsList');
  const emptyContacts = document.getElementById('emptyContacts');
  const emptyContactsTitle = document.getElementById('emptyContactsTitle');
  const emptyContactsSub = document.getElementById('emptyContactsSub');
  const contactCount = document.getElementById('contactCount');
  const contactCountLabel = document.getElementById('contactCountLabel');
  const saveStatus = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');
  const searchInput = document.getElementById('contactSearch');

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
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

  // --- rendering -----------------------------------------------------
  // groupLabel: the heading this row sits under — a signup's note starts
  // "Lead magnet: <title>", which the heading already says, so only the
  // answers after it are shown.
  function contactRowHTML(contact, groupLabel) {
    const metaParts = [];
    if (contact.email) metaParts.push(escapeHTML(contact.email));
    if (contact.phone) metaParts.push(escapeHTML(contact.phone));
    const metaHTML = metaParts.length
      ? `<div class="pz-contact-meta">${metaParts.map((p) => `<span>${p}</span>`).join('')}</div>`
      : '';
    let note = contact.note || '';
    const prefix = `Lead magnet: ${contact.source_name || groupLabel}`;
    if (groupLabel && contact.source === 'form' && note.startsWith(prefix)) {
      note = note.slice(prefix.length).replace(/^\s*—\s*/, '');
    }
    const noteHTML = note ? `<div class="pz-contact-note">${escapeHTML(note)}</div>` : '';
    return `
      <div class="pz-contact-row" data-id="${contact.id}" data-search="${escapeHTML(`${contact.name} ${contact.email} ${contact.phone}`.toLowerCase())}">
        <div class="pz-contact-avatar">${escapeHTML(initials(contact.name))}</div>
        <div class="pz-contact-main">
          <div class="pz-contact-name">${escapeHTML(contact.name || 'Untitled')}</div>
          ${metaHTML}
          ${noteHTML}
        </div>
        <button type="button" class="pz-icon-btn remove-contact" data-id="${contact.id}" aria-label="Remove person">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>`;
  }

  function updateCount() {
    contactCount.textContent = contacts.length;
    contactCountLabel.textContent = contacts.length === 1 ? 'person' : 'people';
  }

  // The list is grouped by source (lib/contacts.js SOURCES), in this order;
  // anything unrecognised lands with 'manual'. Within a source, contacts
  // that name what they came from (source_label, e.g. a lead magnet's
  // title — set server-side) get a group per name, headed by that name
  // with the source as a small label above it. Groups within a source keep
  // the list's newest-first order, so the most recently active is on top.
  const SOURCES = [
    { source: 'form', kind: 'Lead magnet', fallback: 'Lead magnet signups' },
    { source: 'order', kind: 'Order', fallback: 'Orders' },
    { source: 'booking', kind: 'Booking', fallback: 'Bookings' },
    { source: 'manual', kind: '', fallback: 'Added by hand' },
  ];
  function sourceOf(contact) {
    return SOURCES.some((s) => s.source === contact.source) ? contact.source : 'manual';
  }
  function groupContacts() {
    const groups = [];
    SOURCES.forEach(({ source, kind, fallback }) => {
      const byLabel = new Map();
      contacts.filter((c) => sourceOf(c) === source).forEach((c) => {
        const label = source === 'manual' ? '' : String(c.source_label || '').trim();
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(c);
      });
      byLabel.forEach((members, label) => {
        groups.push({ source, kind: label ? kind : '', title: label || fallback, label, members });
      });
    });
    return groups;
  }
  function countLabel(n) {
    return `${n} ${n === 1 ? 'person' : 'people'}`;
  }

  function render() {
    contactsList.innerHTML = groupContacts().map(({ source, kind, title, label, members }) => `
        <section class="pz-contact-group" data-source="${source}">
          <div class="pz-contact-group-head">
            <div>
              ${kind ? `<span class="pz-contact-group-kind">${escapeHTML(kind)}</span>` : ''}
              <h3>${escapeHTML(title)}</h3>
            </div>
            <span class="pz-contact-group-count" data-total="${members.length}">${countLabel(members.length)}</span>
          </div>
          ${members.map((c) => contactRowHTML(c, label)).join('')}
        </section>`).join('');
    contactsList.style.display = contacts.length ? '' : 'none';
    if (contacts.length) {
      emptyContacts.style.display = 'none';
    } else {
      emptyContactsTitle.textContent = 'No one here yet';
      emptyContactsSub.textContent = 'Add the first person above, or come back once someone books or buys from your store.';
      emptyContacts.style.display = 'flex';
    }
    updateCount();
    attachRowListeners();
    applySearch();
  }

  function attachRowListeners() {
    contactsList.querySelectorAll('.remove-contact').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = Number(e.currentTarget.dataset.id);
        const row = contactsList.querySelector(`.pz-contact-row[data-id="${id}"]`);
        if (row) row.classList.add('pz-removing');
        const previous = contacts;
        api(`/dashboard/audience/${id}`, { method: 'DELETE' }).then(() => {
          contacts = contacts.filter((c) => c.id !== id);
          render();
        }).catch(() => {
          contacts = previous;
          if (row) row.classList.remove('pz-removing');
        });
      });
    });
  }

  // --- search (client-side only) --------------------------------------
  function applySearch() {
    const q = (searchInput.value || '').trim().toLowerCase();
    let visibleCount = 0;
    contactsList.querySelectorAll('.pz-contact-row').forEach((row) => {
      const match = !q || (row.dataset.search || '').includes(q);
      row.style.display = match ? '' : 'none';
      if (match) visibleCount += 1;
    });
    // A group with nothing matching drops out; the rest count their matches.
    contactsList.querySelectorAll('.pz-contact-group').forEach((group) => {
      const shown = [...group.querySelectorAll('.pz-contact-row')].filter((r) => r.style.display !== 'none').length;
      const count = group.querySelector('.pz-contact-group-count');
      group.style.display = shown ? '' : 'none';
      count.textContent = q ? `${shown} of ${count.dataset.total}` : countLabel(Number(count.dataset.total));
    });
    if (q && contacts.length) {
      if (visibleCount === 0) {
        emptyContactsTitle.textContent = 'No matches';
        emptyContactsSub.textContent = `Nobody in your audience matches “${q}”.`;
        emptyContacts.style.display = 'flex';
        contactsList.style.display = 'none';
      } else {
        emptyContacts.style.display = 'none';
        contactsList.style.display = '';
      }
    } else if (contacts.length) {
      emptyContacts.style.display = 'none';
      contactsList.style.display = '';
    }
  }
  searchInput.addEventListener('input', applySearch);

  // --- add-person form --------------------------------------------------
  const form = document.getElementById('addContactForm');
  const nameInput = document.getElementById('contactName');
  const emailInput = document.getElementById('contactEmail');
  const phoneInput = document.getElementById('contactPhone');
  const noteInput = document.getElementById('contactNote');
  const formError = document.getElementById('contactFormError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.remove('show');
    const payload = {
      name: nameInput.value,
      email: emailInput.value,
      phone: phoneInput.value,
      note: noteInput.value,
    };
    try {
      const created = await api('/dashboard/audience', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      contacts.unshift(created);
      render();
      form.reset();
      nameInput.focus();
    } catch (err) {
      formError.textContent = err.message || 'Could not add that person. Please try again.';
      formError.classList.add('show');
    }
  });

  render();
})();
