// WordPress-style tag input: turns a plain, comma-separated text field
// (marked data-tag-input) into an editable row of removable chips, plus
// wires up any "choose from the most used tags" suggestion buttons next to
// it. Progressive enhancement -- the underlying field keeps its real
// name="tags" and a comma-separated value the whole time (see
// lib/contacts.js's sanitizeTags), so the form still works with no JS at
// all; this script only swaps in a nicer front end for it once it runs.
(function () {
  function parseTags(raw) {
    return String(raw || '')
      .split(',')
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  function setup(input) {
    if (input.dataset.tagEditorReady) return;
    input.dataset.tagEditorReady = '1';

    var tags = parseTags(input.value);
    var placeholder = input.placeholder || 'Add a tag...';
    input.type = 'hidden';

    var field = input.closest('.crm-tag-field');
    var hint = field && field.querySelector('.crm-tag-hint');
    if (hint) hint.hidden = true;

    var box = document.createElement('div');
    box.className = 'crm-tag-editor';

    var textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'crm-tag-editor-input';

    function sync() {
      input.value = tags.join(', ');
    }

    function addTag(raw) {
      var value = raw.trim().slice(0, 30);
      if (!value) return;
      var exists = tags.some(function (t) { return t.toLowerCase() === value.toLowerCase(); });
      if (!exists && tags.length < 10) tags.push(value);
      render();
    }

    function removeTag(index) {
      tags.splice(index, 1);
      render();
    }

    function render() {
      Array.prototype.slice.call(box.querySelectorAll('.crm-tag-editor-chip')).forEach(function (el) { el.remove(); });
      tags.forEach(function (tag, i) {
        var chip = document.createElement('span');
        chip.className = 'crm-tag-editor-chip';

        var label = document.createElement('span');
        label.textContent = tag;

        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'crm-tag-editor-remove';
        removeBtn.setAttribute('aria-label', 'Remove tag ' + tag);
        removeBtn.innerHTML = '&times;';
        removeBtn.addEventListener('click', function () { removeTag(i); });

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        box.insertBefore(chip, textInput);
      });
      textInput.placeholder = tags.length ? 'Add another tag...' : placeholder;
      sync();
    }

    textInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag(textInput.value);
        textInput.value = '';
      } else if (e.key === 'Backspace' && !textInput.value && tags.length) {
        // WordPress-style: backspace on an empty field edits the last tag
        // back into the text field instead of just deleting it outright.
        textInput.value = tags.pop();
        render();
      }
    });

    // Covers clicking away without pressing Enter/comma, and is also the
    // safety net for a plain form submit (a submit button click blurs the
    // focused text field before the submit event fires).
    textInput.addEventListener('blur', function () {
      if (textInput.value) { addTag(textInput.value); textInput.value = ''; }
    });

    box.addEventListener('click', function (e) {
      if (e.target === box) textInput.focus();
    });

    box.appendChild(textInput);
    input.parentNode.insertBefore(box, input.nextSibling);
    render();

    if (field) {
      var suggestions = field.querySelector('.crm-tag-suggestions');
      if (suggestions) {
        suggestions.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-tag]');
          if (!btn) return;
          addTag(btn.dataset.tag);
        });
      }
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-tag-input]'), setup);
})();
