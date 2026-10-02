// A small, safe text format for merchant-written descriptions (a payment
// page's "About" section). The merchant writes plain text with a few
// markers — the builder's toolbar inserts them:
//
//   ## Heading            a line starting "## " (or "### ")
//   - item / * item       bullet list (consecutive lines)
//   1. item               numbered list (consecutive lines)
//   **bold**  *italic*    inline
//   [text](https://…)     link — http(s) and mailto only
//   blank line            new paragraph; a single newline is a line break
//
// Safe by construction: everything is HTML-escaped first, and only these
// patterns are turned back into a fixed set of tags — no attributes other
// than a link's href (which must start http://, https:// or mailto:), so
// there's no way to smuggle in script, style or event handlers.
//
// public/js/payment-pages.js has a copy of renderRichText for the
// builder's live preview; keep the two in step.
const MAX_LENGTH = 5000;

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Inline markers on one already-escaped line.
function inline(escaped) {
  return escaped
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\)/g, '<a href="$2" target="_blank" rel="nofollow noopener">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
}

function renderRichText(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').slice(0, MAX_LENGTH).trim();
  if (!text) return '';
  const out = [];
  let list = null; // { tag: 'ul' | 'ol', items: [] }
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  text.split('\n').forEach((rawLine) => {
    const line = escapeHTML(rawLine.trimEnd());
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d{1,3}[.)]\s+(.+)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
    } else {
      flushList();
      para.push(line);
    }
  });
  flushPara();
  flushList();
  return out.join('\n');
}

module.exports = { renderRichText, MAX_RICH_TEXT_LENGTH: MAX_LENGTH };
