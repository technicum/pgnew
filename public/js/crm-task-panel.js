// Asana-style right-hand slide-over for CRM tasks. Clicking a task title
// anywhere (the Tasks board, My Tasks, a contact's task panel, or a
// subtask row inside the panel itself) opens/updates this panel instead of
// navigating away -- the underlying GET /dashboard/crm/tasks/:id page is
// still a full, working page on its own (direct link, no-JS), this just
// fetches that same page and shows only its ".admin-content" in a drawer.
// Every form inside the panel (edit, reassign, subtasks, toggle) posts
// through fetch the same way, then swaps the panel's content for whatever
// the server redirected back to -- no page-specific wiring needed as
// routes change.
//
// Deliberately does NOT touch the URL bar or browser history (no
// pushState/popstate) -- it's pure client-side overlay state on top of
// whatever list page you're already on. That means it isn't deep-linkable
// (a shared URL never opens the panel by itself, only the full page's own
// GET route can), but the tradeoff is deliberate: reloading the page while
// the panel is open always lands back on that underlying list, never on
// the task's own full-page view -- which is what you want when the panel
// is meant to feel like a transient overlay, not a real navigation.
(function () {
  var TASK_URL_RE = /^\/dashboard\/crm\/tasks\/\d+$/;

  var panel = null;
  var backdrop = null;
  var panelBody = null;

  var toast = null;
  var toastTimer = null;

  function buildPanel() {
    if (panel) return;

    backdrop = document.createElement('div');
    backdrop.className = 'task-panel-backdrop';
    backdrop.addEventListener('click', closePanel);

    panel = document.createElement('aside');
    panel.className = 'task-panel';
    panel.innerHTML =
      '<div class="task-panel-head">' +
      '<div class="task-panel-toast" hidden></div>' +
      '<button type="button" class="task-panel-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="task-panel-body"><div class="task-panel-loading">Loading…</div></div>';
    panel.querySelector('.task-panel-close').addEventListener('click', closePanel);
    panelBody = panel.querySelector('.task-panel-body');
    toast = panel.querySelector('.task-panel-toast');

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
  }

  function showToast(message, isError) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle('task-panel-toast-error', !!isError);
    toast.hidden = false;
    toast.classList.add('show');
    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2200);
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

  function openPanel(url) {
    buildPanel();
    panelBody.innerHTML = '<div class="task-panel-loading">Loading…</div>';
    panel.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('task-panel-open');
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
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('task-panel-open');
    // Always re-fetch the underlying page -- cheap, and simpler/more
    // reliably correct than trying to track whether anything inside the
    // panel actually changed before deciding to bother.
    refreshMainContent();
  }

  // Re-fetches the page you're actually on (never changed by the panel)
  // and patches its own ".admin-content" in place, so edits made inside
  // the panel (reassign, priority, a completed subtask...) show up on the
  // list underneath without a full reload.
  function refreshMainContent() {
    fetch(location.href)
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var current = document.querySelector('.admin-content');
        if (current) renderInto(current, html);
      })
      .catch(function () {});
  }

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
    openPanel(href);
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
    var successMessage = form.dataset.successMessage || 'Saved';

    // FormData sent straight to fetch() gets encoded as multipart/form-data
    // -- but the server only parses application/x-www-form-urlencoded
    // (server.js's express.urlencoded()), same as a normal <form> submit
    // sends. Left as FormData, every field silently vanishes server-side
    // (req.body comes back empty), which is why "Save changes" looked like
    // it did nothing: the title-required check failed on an empty title
    // and redirected back with nothing saved, no visible error. Converting
    // to URLSearchParams makes fetch send the same encoding a real form
    // submit would.
    var params = new URLSearchParams();
    new FormData(form).forEach(function (value, key) { params.append(key, value); });

    fetch(form.getAttribute('action'), { method: 'POST', body: params })
      .then(function (res) {
        if (!res.ok) {
          // A failed request's body is Express's plain error page, not this
          // app's markup -- rendering it into the panel would just show
          // broken/empty-looking output. Leave the panel's current content
          // alone and surface the failure instead.
          showToast('Something went wrong -- try again.', true);
          return null;
        }
        if (isSelfDelete) {
          closePanel();
          return null;
        }
        return res.text().then(function (html) {
          renderInto(panelBody, html);
          showToast(successMessage);
        });
      })
      .catch(function () {
        showToast('Something went wrong -- try again.', true);
      });
  });
})();

// Tasks board infinite scroll -- no-ops on every other page (the list only
// exists on views/platform/crm-tasks.ejs). Fetches the same GET
// /dashboard/crm/tasks route with ?offset=, then pulls just the new <li>
// rows out of the response and appends them -- same fetch-a-real-page-and-
// extract-a-piece approach as the slide-over panel above, so the route
// itself never needs a separate JSON/fragment mode.
(function () {
  var list = document.getElementById('crmTaskList');
  var sentinel = document.querySelector('.crm-task-load-status');
  if (!list || !sentinel) return;

  var loading = false;
  var observer = null;

  function nearViewport(el) {
    var rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight + 600;
  }

  function loadMore() {
    if (loading || list.dataset.hasMore !== '1') return;
    loading = true;
    sentinel.hidden = false;
    sentinel.textContent = 'Loading more…';

    fetch('/dashboard/crm/tasks?offset=' + encodeURIComponent(list.dataset.nextOffset))
      .then(function (res) { return res.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var freshList = doc.getElementById('crmTaskList');
        if (freshList) {
          Array.prototype.forEach.call(freshList.children, function (li) {
            list.appendChild(li);
          });
          list.dataset.hasMore = freshList.dataset.hasMore || '';
          list.dataset.nextOffset = freshList.dataset.nextOffset || '0';
        } else {
          list.dataset.hasMore = '';
        }
      })
      .catch(function () {
        sentinel.textContent = 'Could not load more -- scroll to retry.';
      })
      .then(function () {
        loading = false;
        sentinel.hidden = true;
        if (list.dataset.hasMore !== '1') {
          if (observer) observer.disconnect();
        } else if (nearViewport(sentinel)) {
          // The page just appended is short enough that the sentinel is
          // still on screen -- IntersectionObserver only fires on an
          // enter/exit transition, so without this it would never refire
          // and loading would silently stall on a tall viewport.
          loadMore();
        }
      });
  }

  if (list.dataset.hasMore === '1' && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) loadMore();
    }, { rootMargin: '600px' });
    observer.observe(sentinel);
  }
})();
