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
  const contactCountLine = document.getElementById('contactCountLine');
  const saveStatus = document.getElementById('saveStatus');
  const saveStatusText = document.getElementById('saveStatusText');
  const searchInput = document.getElementById('contactSearch');
  const sourceFilter = document.getElementById('contactSourceFilter');
  const reachFilter = document.getElementById('contactReachFilter');
  const clearFiltersBtn = document.getElementById('contactClearFilters');

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
      <div class="pz-contact-row" data-id="${contact.id}"
        data-search="${escapeHTML(`${contact.name} ${contact.email} ${contact.phone} ${contact.note || ''}`.toLowerCase())}"
        data-email="${contact.email ? '1' : ''}" data-phone="${contact.phone ? '1' : ''}">
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

  // The list is grouped by source (lib/contacts.js SOURCES), in this order;
  // anything unrecognised lands with 'manual'. Within a source, contacts
  // that name what they came from (source_label, e.g. a lead magnet's
  // title — set server-side) get a group per name, headed by that name
  // with the source as a small label above it. Groups within a source keep
  // the list's newest-first order, so the most recently active is on top.
  const SOURCES = [
    { source: 'form', kind: 'Lead magnet', fallback: 'Lead magnet signups' },
    { source: 'newsletter', kind: 'Newsletter', fallback: 'Newsletter subscribers' },
    { source: 'storeform', kind: 'Form', fallback: 'Form replies' },
    { source: 'order', kind: 'Order', fallback: 'Orders' },
    { source: 'booking', kind: 'Booking', fallback: 'Bookings' },
    { source: 'event', kind: 'Event', fallback: 'Event RSVPs' },
    { source: 'course', kind: 'Course', fallback: 'Course students' },
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

  // Source filter options follow the groups actually on the page: one per
  // source, plus each named group (every lead magnet) under its source.
  // Values are "source:<source>" or "group:<source>|<label>".
  function renderSourceOptions(groups) {
    const current = sourceFilter.value;
    const opts = ['<option value="">All sources</option>'];
    SOURCES.forEach(({ source, fallback }) => {
      const inSource = groups.filter((g) => g.source === source);
      if (!inSource.length) return;
      const named = inSource.filter((g) => g.label);
      if (!named.length) {
        opts.push(`<option value="source:${source}">${escapeHTML(fallback)}</option>`);
        return;
      }
      opts.push(`<optgroup label="${escapeHTML(fallback)}">`);
      opts.push(`<option value="source:${source}">All ${escapeHTML(fallback.toLowerCase())}</option>`);
      inSource.forEach((g) => {
        opts.push(`<option value="${escapeHTML(`group:${source}|${g.label}`)}">${escapeHTML(g.title)}</option>`);
      });
      opts.push('</optgroup>');
    });
    sourceFilter.innerHTML = opts.join('');
    // Keep the choice across re-renders, unless that group has emptied out.
    sourceFilter.value = [...sourceFilter.options].some((o) => o.value === current) ? current : '';
  }

  function render() {
    const groups = groupContacts();
    renderSourceOptions(groups);
    contactsList.innerHTML = groups.map(({ source, kind, title, label, members }) => `
        <section class="pz-contact-group" data-source="${source}" data-key="${escapeHTML(`${source}|${label}`)}">
          <div class="pz-contact-group-head">
            <div>
              ${kind ? `<span class="pz-contact-group-kind">${escapeHTML(kind)}</span>` : ''}
              <h3>${escapeHTML(title)}</h3>
            </div>
            <span class="pz-contact-group-count" data-total="${members.length}">${countLabel(members.length)}</span>
          </div>
          ${members.map((c) => contactRowHTML(c, label)).join('')}
        </section>`).join('');
    attachRowListeners();
    applyFilters();
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

  // --- search + filters (client-side only) ----------------------------
  // Search matches name/email/phone/note; the source filter narrows to one
  // source or one named group (a single lead magnet); the contact-info
  // filter keeps people you can email, text, or both.
  function applyFilters() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const sourceValue = sourceFilter.value;
    const reach = reachFilter.value;
    const filtering = !!(q || sourceValue || reach);
    clearFiltersBtn.hidden = !filtering;

    const rowMatches = (row) => (!q || (row.dataset.search || '').includes(q))
      && (reach !== 'email' || row.dataset.email)
      && (reach !== 'phone' || row.dataset.phone)
      && (reach !== 'both' || (row.dataset.email && row.dataset.phone));
    const groupMatches = (group) => !sourceValue
      || (sourceValue.startsWith('source:') && group.dataset.source === sourceValue.slice(7))
      || (sourceValue.startsWith('group:') && group.dataset.key === sourceValue.slice(6));

    let visibleCount = 0;
    contactsList.querySelectorAll('.pz-contact-group').forEach((group) => {
      const inGroup = groupMatches(group);
      let shown = 0;
      group.querySelectorAll('.pz-contact-row').forEach((row) => {
        const match = inGroup && rowMatches(row);
        row.style.display = match ? '' : 'none';
        if (match) shown += 1;
      });
      visibleCount += shown;
      // A group with nothing matching drops out; the rest count their matches.
      const count = group.querySelector('.pz-contact-group-count');
      const total = Number(count.dataset.total);
      group.style.display = shown ? '' : 'none';
      count.textContent = shown < total ? `${shown} of ${total}` : countLabel(total);
    });

    contactCountLine.textContent = filtering && contacts.length
      ? `Showing ${visibleCount} of ${countLabel(contacts.length)}`
      : `${countLabel(contacts.length)} in your audience`;

    if (!contacts.length) {
      emptyContactsTitle.textContent = 'No one here yet';
      emptyContactsSub.textContent = 'Add the first person above, or come back once someone books or buys from your store.';
    } else if (!visibleCount) {
      emptyContactsTitle.textContent = 'No matches';
      emptyContactsSub.textContent = q
        ? `Nobody matches “${searchInput.value.trim()}” with these filters.`
        : 'Nobody matches these filters.';
    }
    emptyContacts.style.display = visibleCount ? 'none' : 'flex';
    contactsList.style.display = visibleCount ? '' : 'none';
    syncExport();
  }
  // --- export (client-side: every contact is already on the page) -----
  // A CSV of the people shown — the whole list, or only the rows matching
  // the search / filters — newest first, with a BOM so Excel reads UTF-8.
  const exportBtn = document.getElementById('exportContacts');
  const exportLabel = document.getElementById('exportContactsLabel');
  const SOURCE_NAMES = { form: 'Lead magnet', newsletter: 'Newsletter', storeform: 'Form', order: 'Order', booking: 'Booking', event: 'Event', course: 'Course', manual: 'Added by hand' };

  function shownContacts() {
    const visible = new Set();
    contactsList.querySelectorAll('.pz-contact-row').forEach((row) => {
      if (row.style.display !== 'none' && row.closest('.pz-contact-group').style.display !== 'none') visible.add(Number(row.dataset.id));
    });
    return contacts.filter((c) => visible.has(Number(c.id)));
  }
  // A cell, quoted, and kept from running as a formula in a spreadsheet
  // (=, +, -, @ at the start) — except a phone number like +91 98765 43210.
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-][\d\s().-]+$/.test(text))) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function syncExport() {
    const n = shownContacts().length;
    const filtering = !!(searchInput.value.trim() || sourceFilter.value || reachFilter.value);
    exportBtn.disabled = !n;
    exportLabel.textContent = filtering && n ? `Export ${countLabel(n)}` : 'Export CSV';
  }
  exportBtn.addEventListener('click', () => {
    const rows = shownContacts();
    if (!rows.length) return;
    const lines = [['Name', 'Email', 'Phone', 'Note', 'Source', 'From', 'Added on']].concat(rows.map((c) => [
      c.name, c.email, c.phone, c.note || '', SOURCE_NAMES[sourceOf(c)], sourceOf(c) === 'manual' ? '' : (c.source_label || ''),
      c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
    ]));
    const csv = '﻿' + lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audience-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  searchInput.addEventListener('input', applyFilters);
  sourceFilter.addEventListener('change', applyFilters);
  reachFilter.addEventListener('change', applyFilters);
  clearFiltersBtn.addEventListener('click', () => {
    searchInput.value = '';
    sourceFilter.value = '';
    reachFilter.value = '';
    applyFilters();
    searchInput.focus();
  });

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
