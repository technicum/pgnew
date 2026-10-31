// Overview page: "Copy link" on the roadmap. The step only counts
// as done once the link really is on the clipboard.
(function () {
  var button = document.querySelector('[data-copy-link]');
  if (!button) return;
  var label = button.querySelector('[data-copy-label]');

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    var copied = document.execCommand('copy');
    field.remove();
    return copied ? Promise.resolve() : Promise.reject(new Error('Copy failed'));
  }

  button.addEventListener('click', function () {
    copy(button.getAttribute('data-copy-link')).then(function () {
      label.textContent = 'Link copied';
      return fetch('/dashboard/link-shared', { method: 'POST' });
    }).then(function (res) {
      if (res.ok) setTimeout(function () { location.reload(); }, 900);
    }).catch(function () {
      label.textContent = 'Try again';
    });
  });
})();
