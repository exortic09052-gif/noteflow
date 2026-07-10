/* =============================================================
   SLATE — utils.js
   -------------------------------------------------------------
   A tiny toolbox of pure, dependency-free helpers.

   "Pure" means: given the same input, they always return the
   same output and they don't secretly change anything else.
   That makes them easy to read, test, and reuse.

   Nothing in here knows about IndexedDB, the DOM structure of
   the app, or the note format. Keep it that way — this file is
   the bottom of the dependency chain. Everything imports FROM
   here; this file imports NOTHING.

   Each helper is exported on its own so other files can do:
       import { uid, debounce } from './utils.js';
   ============================================================= */


/* -------------------------------------------------------------
   uid() — generate a unique ID for a new note/folder.
   -------------------------------------------------------------
   We use the browser's built-in crypto.randomUUID() when it
   exists (all modern browsers). If it doesn't (very old ones),
   we fall back to a timestamp + random string, which is more
   than unique enough for a single-device notes app.
------------------------------------------------------------- */
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: "l4x9a2" style tail keeps it short but collision-safe here.
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}


/* -------------------------------------------------------------
   now() — current time as a millisecond timestamp.
   -------------------------------------------------------------
   We store dates as numbers (e.g. 1720598040000), not strings.
   Numbers are easy to compare (a > b), easy to sort, and take
   no guessing about time zones. We format them for humans only
   when displaying (see formatDate below).
------------------------------------------------------------- */
export function now() {
  return Date.now();
}


/* -------------------------------------------------------------
   debounce(fn, wait) — "wait until the user stops."
   -------------------------------------------------------------
   Returns a NEW function. Every time you call it, it resets a
   timer. The original `fn` only runs once the calls STOP for
   `wait` milliseconds.

   This is the heart of auto-save: the user types "h", "he",
   "hel", "hell", "hello" — but we don't want to hit the
   database on every keystroke. Debounce waits until they pause
   (say 600ms), then saves once.

   Example:
       const save = debounce(reallySave, 600);
       input.addEventListener('input', save); // fires once after typing stops
------------------------------------------------------------- */
export function debounce(fn, wait = 300) {
  let timer = null; // remembers the pending timeout between calls

  return function debounced(...args) {
    // Cancel the previous countdown, if any.
    clearTimeout(timer);
    // Start a fresh countdown. `this`/args are preserved for `fn`.
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}


/* -------------------------------------------------------------
   formatDate(ts) — turn a timestamp into friendly text.
   -------------------------------------------------------------
   Rules, from most recent to oldest:
     • under a minute  → "just now"
     • under an hour   → "12m ago"
     • under a day     → "3h ago"
     • yesterday       → "Yesterday"
     • this year       → "Mar 4"
     • older           → "Mar 4, 2024"

   This is display-only. The stored value never changes.
------------------------------------------------------------- */
export function formatDate(ts) {
  if (!ts) return '';

  const date = new Date(ts);
  const diffMs = Date.now() - ts;          // how long ago, in ms
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  if (diffHr < 24) return diffHr + 'h ago';

  // Was it yesterday? Compare calendar days, not just "24h ago".
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, yesterday)) return 'Yesterday';

  // Same calendar year → drop the year for a cleaner look.
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/* Small internal helper: are two Date objects on the same day? */
function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}


/* -------------------------------------------------------------
   excerpt(text, max) — a short preview of a note's body.
   -------------------------------------------------------------
   Collapses runs of whitespace into single spaces, trims, and
   cuts to `max` characters with an ellipsis. Used on the cards.
------------------------------------------------------------- */
export function excerpt(text = '', max = 180) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).trimEnd() + '…';
}


/* -------------------------------------------------------------
   deriveTitle(note) — a display title even when none was typed.
   -------------------------------------------------------------
   If the user gave a title, use it. Otherwise fall back to the
   first line of the body, or "Untitled" if the note is empty.
------------------------------------------------------------- */
export function deriveTitle(note) {
  if (note.title && note.title.trim()) return note.title.trim();
  const firstLine = (note.body || '').split('\n')[0].trim();
  return firstLine || 'Untitled';
}


/* -------------------------------------------------------------
   normalizeTag(raw) — clean up a tag the user typed.
   -------------------------------------------------------------
   Lowercases, trims, strips a leading "#", and collapses inner
   spaces to hyphens. So "  #To Do " becomes "to-do". Returns an
   empty string for junk input so callers can ignore it.
------------------------------------------------------------- */
export function normalizeTag(raw = '') {
  return raw
    .trim()
    .replace(/^#+/, '')      // drop leading hashes
    .toLowerCase()
    .replace(/\s+/g, '-')    // spaces → hyphens
    .replace(/[^\w-]/g, ''); // keep letters, numbers, underscore, hyphen
}


/* -------------------------------------------------------------
   matchesQuery(note, query) — does this note match a search?
   -------------------------------------------------------------
   Case-insensitive substring match across title, body, and
   tags. Every word in the query must appear SOMEWHERE (AND
   logic), so "budget trip" finds notes containing both words.
   An empty query matches everything.
------------------------------------------------------------- */
export function matchesQuery(note, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  // One big searchable string per note: title + body + tags.
  const haystack = [
    note.title || '',
    note.body || '',
    (note.tags || []).join(' '),
  ].join(' ').toLowerCase();

  // Split the query into words; require ALL of them to appear.
  return q.split(/\s+/).every((word) => haystack.includes(word));
}


/* -------------------------------------------------------------
   $ and $$ — short DOM lookup helpers.
   -------------------------------------------------------------
   $  → first matching element  (like document.querySelector)
   $$ → array of all matches    (like querySelectorAll, but a
        real Array so you can .map / .filter easily)

   The optional second arg lets you scope the search to a parent
   element instead of the whole document.
------------------------------------------------------------- */
export function $(selector, parent = document) {
  return parent.querySelector(selector);
}

export function $$(selector, parent = document) {
  return Array.from(parent.querySelectorAll(selector));
}


/* -------------------------------------------------------------
   mount(name, parent) — find one of our data-mount="..." hooks.
   -------------------------------------------------------------
   File 1's HTML is full of <div data-mount="note-list"> style
   anchors. This is just a readable shortcut for grabbing one:
       const list = mount('note-list');
------------------------------------------------------------- */
export function mount(name, parent = document) {
  return parent.querySelector(`[data-mount="${name}"]`);
}


/* -------------------------------------------------------------
   el(tag, props, children) — build a DOM element in one call.
   -------------------------------------------------------------
   A minimal "create element" helper so ui.js can build nodes
   without long chains of document.createElement + appendChild.

     el('button', { class: 'btn', 'data-action': 'save' }, 'Save')

   • props: attributes to set. A few special keys:
       - class     → sets className
       - text      → sets textContent (safe, no HTML injection)
       - dataset   → object of data-* attributes
       - on        → object of event listeners { click: fn }
   • children: a string, a node, or an array of them.

   We prefer textContent over innerHTML everywhere to avoid
   accidentally running HTML from a note's text (XSS-safe).
------------------------------------------------------------- */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue; // skip empty/false props

    if (key === 'class') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key === 'html') {
      // Escape hatch — only pass trusted strings here (e.g. icon markup).
      node.innerHTML = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  // Append children (accepts string | Node | array of those).
  const kids = Array.isArray(children) ? children : [children];
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  return node;
}


/* -------------------------------------------------------------
   clear(node) — remove all children of an element.
   -------------------------------------------------------------
   Handy before re-rendering a list: clear(list) then append
   fresh nodes. Faster and safer than node.innerHTML = ''.
------------------------------------------------------------- */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}


/* -------------------------------------------------------------
   download(filename, text) — trigger a file download.
   -------------------------------------------------------------
   Used by the Export feature. We wrap the text in a Blob,
   create a temporary link, click it, then clean up. This is the
   standard "save a file from the browser" pattern.
------------------------------------------------------------- */
export function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the object URL so we don't leak memory.
  URL.revokeObjectURL(url);
}


/* -------------------------------------------------------------
   readFileAsText(file) — read an uploaded file, as a Promise.
   -------------------------------------------------------------
   Used by Import. FileReader is callback-based and clunky, so
   we wrap it in a Promise for clean `await readFileAsText(f)`.
------------------------------------------------------------- */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
