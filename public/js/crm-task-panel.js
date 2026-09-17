// Asana-style right-hand slide-over for CRM tasks. Clicking a task title
// anywhere (the Tasks board, My Tasks, a contact's task panel, or a
// subtask row inside the panel itself) opens/updates this panel instead of
// navigating away -- the underlying GET /dashboard/crm/tasks/:id page is
// still a full, working page on its own (direct link, reload, no-JS), this
// just fetches that same page and shows only its ".admin-content" in a
// drawer. Every form inside the panel (edit, reassign, subtasks, toggle)
// posts through fetch the same way, then swaps the panel's content for
// whatever the server redirected back to -- no page-specific wiring needed
// as routes change.
(function () {
  var TASK_URL_RE = /^\/dashboard\/crm\/tasks\/\d+$/;

  var panel = null;
  var backdrop = null;
  var panelBody = null;

  function buildPanel() {
    if (panel) return;

    backdrop = document.createElement('div');
    backdrop.className = 'task-panel-backdrop';
    backdrop.addEventListener('click', closePanel);

    panel = document.createElement('aside');
    panel.className = 'task-panel';
    panel.innerHTML =
      '<div class="task-panel-head">' +
      '<button type="button" class="task-panel-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="task-panel-body"><div class="task-panel-loading">Loading…</div></div>';
    panel.querySelector('.task-panel-close').addEventListener('click', closePanel);
    panelBody = panel.querySelector('.task-panel-body');

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
  }

  function extractAdminContent(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var content = doc.querySelector('.admin-content');
    return content ? content.innerHTML : html;
  }

  // Setting .innerHTML never executes embedded <script> tags (e.g. the
  // description editor's setup in crm-task.ejs, or its <script src> for
  // Quill itself) -- replacing each with a freshly-created <script> node
  // does. Runs them in order, one at a time, waiting for each `src` script
  // to actually finish loading before moving to the next -- otherwise an
  // inline script that assumes an earlier <script src> already ran (e.g.
  // "new Quill(...)" assuming the Quill library loaded) fires too early on
  // this path, since a script *inserted via JS* -- unlike one the browser's
  // own HTML parser hits directly -- does not block subsequent script
  // insertion on an external file loading.
  function runScripts(container) {
    var scripts = Array.prototype.slice.call(container.querySelectorAll('script'));
    return scripts.reduce(function (chain, old) {
      return chain.then(function () {
        return new Promise(function (resolve) {
          var fresh = document.createElement('script');
          for (var i = 0; i < old.attributes.length; i++) {
            fresh.setAttribute(old.attributes[i].name, old.attributes[i].value);
          }
          fresh.textContent = old.textContent;
          if (fresh.src) {
            fresh.onload = resolve;
            fresh.onerror = resolve; // don't block the rest of the page over one failed script
          }
          old.parentNode.replaceChild(fresh, old);
          if (!fresh.src) resolve(); // inline scripts already ran synchronously above
        });
      });
    }, Promise.resolve());
  }

  function renderInto(target, html) {
    target.innerHTML = extractAdminContent(html);
    runScripts(target);
  }

  function isOpen() {
    return !!panel && panel.classList.contains('open');
  }

  function openPanel(url, replace) {
    buildPanel();
    panelBody.innerHTML = '<div class="task-panel-loading">Loading…</div>';
    panel.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('task-panel-open');

    if (replace) {
      history.replaceState({ taskPanel: true }, '', url);
    } else {
      history.pushState({ taskPanel: true }, '', url);
    }
    loadInto(url);
  }

  function loadInto(url) {
    fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (html) { renderInto(panelBody, html); })
      .catch(function () {
        panelBody.innerHTML = '<p class="empty-state">Could not load this task.</p>';
      });
  }

  function closePanel() {
    if (!isOpen()) return;
    history.back(); // popstate handler below does the actual hide + refresh
  }

  function hidePanelVisual() {
    if (!panel) return;
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('task-panel-open');
  }

  // Re-fetches whatever page we've landed back on and patches its own
  // ".admin-content" in place, so edits made inside the panel (reassign,
  // priority, a completed subtask...) show up on the list underneath
  // without a full reload.
  function refreshMainContent() {
    fetch(location.href)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var current = document.querySelector('.admin-content');
        if (current) renderInto(current, html);
      })
      .catch(function () {});
  }

  window.addEventListener('popstate', function () {
    if (!isOpen()) return;
    hidePanelVisual();
    refreshMainContent();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });

  // Open/drill-down: any ".crm-task-title" link that points at a task
  // detail page (not the board root, not an external media link).
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a.crm-task-title');
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (!TASK_URL_RE.test(href)) return;
    e.preventDefault();
    openPanel(href, isOpen());
  });

  // Every form submitted from inside the panel goes through fetch instead
  // of a normal navigation. e.defaultPrevented lets a cancelled
  // onsubmit="return confirm(...)" (still on the form itself) short-circuit
  // this, same as it would a normal submit.
  document.addEventListener('submit', function (e) {
    if (!panel || !panel.contains(e.target)) return;
    if (e.defaultPrevented) return;
    e.preventDefault();

    var form = e.target;
    var isSelfDelete = form.classList.contains('crm-task-delete-self');
    var fd = new FormData(form);

    fetch(form.getAttribute('action'), { method: 'POST', body: fd })
      .then(function (res) {
        if (isSelfDelete) {
          closePanel();
          return;
        }
        return res.text().then(function (html) {
          renderInto(panelBody, html);
          history.replaceState({ taskPanel: true }, '', res.url);
        });
      })
      .catch(function () {
        panelBody.innerHTML = '<p class="empty-state">Something went wrong. Try again.</p>';
      });
  });
})();
