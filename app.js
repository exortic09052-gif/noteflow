/* =============================================================
   NoteFlow â€” app.js
   -------------------------------------------------------------
   THE CONTROLLER. This is the "glue" that connects everything:

        DOM events  â†’  app.js  â†’  store actions  â†’  (store persists
        via db.js)  â†’  store notifies  â†’  ui.js re-renders.

   app.js holds NO state of its own and does NO rendering. It only:
     â€¢ boots the app (load Lucide, hydrate the store, first paint)
     â€¢ listens for user events (ONE delegated click listener, plus
       input/keydown handlers)
     â€¢ translates each event into the correct store action
     â€¢ wires autosave, keyboard shortcuts, import/export, undo

   Read this file top-to-bottom like a story: boot first, then the
   event wiring, then the individual handlers.
   ============================================================= */

import * as store from './store.js';
import * as ui from './ui.js';
import { debounce, download, readFileAsText, $, mount } from './utils.js';


/* =============================================================
   1. BOOT SEQUENCE
   -------------------------------------------------------------
   Runs once on load. Order matters:
     1. make sure Lucide icons are available (for ui.js)
     2. subscribe ui.render to the store (so changes repaint)
     3. hydrate: pull notes/folders out of IndexedDB into state
     4. wire up all event listeners
     5. register the service worker (PWA offline support)
   ============================================================= */
async function boot() {
  await ensureLucide();

  // Whenever the store changes, ui.render runs with the new state.
  store.subscribe(ui.render);

  // Reflect the current theme's icon (moon/sun) on first paint.
  ui.updateThemeIcon();

  // Load persisted data â†’ triggers the first real render.
  try {
    await store.hydrate();
  } catch (err) {
    console.error('Failed to load your notes:', err);
    ui.toast('Couldnâ€™t open local storage. Notes may not save.');
  }

  wireEvents();
  registerServiceWorker();
}

/*
   ensureLucide â€” the icon library is injected by the host as a
   global (window.lucide). If it's not ready yet, wait briefly.
   This keeps ui.js's refreshIcons() safe on the very first paint.
*/
function ensureLucide() {
  return new Promise((resolve) => {
    if (window.lucide) return resolve();
    let tries = 0;
    const timer = setInterval(() => {
      if (window.lucide || tries++ > 40) { // ~2s max
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}


/* =============================================================
   2. EVENT WIRING
   -------------------------------------------------------------
   We attach a SMALL number of listeners at the document level and
   let them handle everything via delegation. Why delegation?
   Because ui.js constantly creates/destroys note cards, chips,
   and toasts. If we bound listeners to each element, we'd have to
   re-bind on every render. Instead we listen ONCE on a stable
   parent and read data-action off whatever was clicked. New
   elements "just work" with zero re-binding.
   ============================================================= */
function wireEvents() {
  // --- One click listener to rule them all. ---
  document.addEventListener('click', onClick);

  // --- Editor typing â†’ autosave (input events). ---
  mount('editor-title').addEventListener('input', onEditorInput);
  mount('editor-body').addEventListener('input', onEditorInput);

  // --- Tag input: Enter adds a tag. ---
  mount('editor-tag-input').addEventListener('keydown', onTagInputKeydown);

  // --- Search box: live-filter as you type. ---
  const searchForm = $('[data-action="search"]');
  const searchInput = searchForm.querySelector('.search__input');
  searchInput.addEventListener('input', onSearchInput);
  searchForm.addEventListener('reset', () => {
    store.setSearch('');
    toggleSearchClear(searchInput);
  });

  // --- Import file picker: fires when a file is chosen. ---
  mount('import-input').addEventListener('change', onImportFile);

  // --- Global keyboard shortcuts. ---
  document.addEventListener('keydown', onGlobalKeydown);
}


/* =============================================================
   3. THE DELEGATED CLICK HANDLER
   -------------------------------------------------------------
   Reads data-action from the clicked element (or its nearest
   ancestor that has one) and routes to the matching store action.
   This is the single "switchboard" for almost every button.
   ============================================================= */
function onClick(event) {
  // Find the nearest element carrying a data-action.
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action, id, filter, tag } = target.dataset;

  switch (action) {
    /* --- creating --- */
    case 'new-note':
      store.createNote();
      ui.closeSidebar(); // in case we're on mobile with the drawer open
      break;

    case 'new-folder': {
      const name = prompt('Folder name');
      if (name && name.trim()) store.createFolder(name.trim());
      break;
    }

    /* --- opening / navigating --- */
    case 'open':
      store.selectNote(id);
      break;

    case 'filter':
      applyFilter(filter, id || tag);
      ui.closeSidebar();
      break;

    case 'clear-filters':
      event.preventDefault();
      store.clearFilters();
      break;

    /* --- note actions --- */
    case 'toggle-pin':
      // Stop the click from ALSO opening the card underneath.
      event.stopPropagation();
      store.togglePin(id);
      break;

    case 'delete-note':
      handleDelete(id || mount('editor').dataset.id);
      break;

    case 'move-note':
      handleMove(id || mount('editor').dataset.id);
      break;

    /* --- NEW (Phase 1 / Feature 1): export the open note as PDF --- */
    case 'export-pdf':
      handleExportPdf(id || mount('editor').dataset.id);
      break;

    case 'close-editor':
      store.selectNote(null);
      break;

    /* --- tags --- */
    case 'remove-tag':
      store.removeTag(id, tag);
      break;

    /* --- folders --- */
    case 'rename-folder': {
      event.stopPropagation();
      const current = store.getFolders().find((f) => f.id === id);
      const name = prompt('Rename folder', current ? current.name : '');
      if (name && name.trim()) store.renameFolder(id, name.trim());
      break;
    }

    /* --- theme --- */
    case 'toggle-theme':
      toggleTheme();
      break;

    /* --- sidebar drawer (mobile) --- */
    case 'toggle-sidebar':
      ui.toggleSidebar();
      break;
    case 'close-sidebar':
      ui.closeSidebar();
      break;

    /* --- import / export --- */
    case 'export':
      handleExport();
      break;
    case 'import':
      // Programmatically open the hidden file input.
      mount('import-input').click();
      break;
  }
}

/*
   applyFilter â€” small adapter so the click handler stays clean.
   'all'/'pinned' take no value; 'folder'/'tag' carry an id/tag.
*/
function applyFilter(type, value) {
  if (type === 'folder') store.setFilter('folder', value);
  else if (type === 'tag') store.setFilter('tag', value);
  else store.setFilter(type); // 'all' | 'pinned'
}


/* =============================================================
   4. AUTOSAVE (debounced)
   -------------------------------------------------------------
   As the user types in the title or body, we:
     â€¢ immediately show "Savingâ€¦"
     â€¢ wait until they PAUSE (debounce), then write once to the
       store (which persists to IndexedDB) and show "Saved".

   debounce (from utils.js) is what turns a burst of keystrokes
   into a single save. 600ms feels responsive without hammering
   the database on every letter.
   ============================================================= */
const saveNow = debounce(async () => {
  const id = mount('editor').dataset.id;
  if (!id) return;

  const title = mount('editor-title').value;
  const body = mount('editor-body').value;

  await store.updateNote(id, { title, body });
  ui.setSaveStatus('saved');
}, 600);

function onEditorInput() {
  // Instant feedback that a save is coming; the real write is debounced.
  ui.setSaveStatus('saving');
  saveNow();
}


/* =============================================================
   5. TAGS + SEARCH input handlers
   ============================================================= */
function onTagInputKeydown(event) {
  // Enter (or comma) commits the typed tag.
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    const input = event.currentTarget;
    const id = mount('editor').dataset.id;
    if (id && input.value.trim()) {
      store.addTag(id, input.value);
      input.value = '';
    }
  }
  // Backspace on an empty input removes the last tag (a nice touch).
  if (event.key === 'Backspace' && !event.currentTarget.value) {
    const note = store.getSelectedNote();
    if (note && note.tags.length) {
      store.removeTag(note.id, note.tags[note.tags.length - 1]);
    }
  }
}

/*
   Search is live but lightly debounced so very fast typing doesn't
   trigger a re-render on literally every keystroke.
*/
const pushSearch = debounce((text) => store.setSearch(text), 120);

function onSearchInput(event) {
  const input = event.currentTarget;
  pushSearch(input.value);
  toggleSearchClear(input);
}

/* Show/hide the little "clear" (Ã—) button based on content. */
function toggleSearchClear(input) {
  const clearBtn = input.parentElement.querySelector('.search__clear');
  if (clearBtn) clearBtn.hidden = input.value.length === 0;
}


/* =============================================================
   6. DELETE + UNDO
   -------------------------------------------------------------
   store.deleteNote returns the removed note. We hand that to a
   toast with an "Undo" action that simply restores it. The store
   owns the data; app.js just orchestrates the offer to undo.
   ============================================================= */
async function handleDelete(id) {
  if (!id) return;
  const removed = await store.deleteNote(id);
  if (!removed) return;

  ui.toast('Note deleted', {
    actionLabel: 'Undo',
    onAction: () => store.restoreNote(removed),
    duration: 6000,
  });
}

/*
   handleMove â€” pick a destination folder for a note. We keep the
   UI dependency-free with a numbered prompt (0 = no folder). A
   nicer popover could replace this later without touching store.
*/
function handleMove(id) {
  if (!id) return;
  const folders = store.getFolders();
  if (folders.length === 0) {
    ui.toast('No folders yet. Create one first.');
    return;
  }

  const menu = ['0. No folder', ...folders.map((f, i) => `${i + 1}. ${f.name}`)].join('\n');
  const choice = prompt(`Move note to:\n${menu}`);
  if (choice == null) return;

  const n = parseInt(choice, 10);
  if (Number.isNaN(n) || n < 0 || n > folders.length) return;

  const folderId = n === 0 ? null : folders[n - 1].id;
  store.moveNote(id, folderId);
}


/* =============================================================
   6b. EXPORT NOTE AS PDF   â˜… NEW (Phase 1 / Feature 1)
   -------------------------------------------------------------
   Strategy: use the BROWSER'S NATIVE print-to-PDF instead of a
   third-party library. Why:
     â€¢ zero dependencies â†’ stays fully offline (no CDN to cache)
     â€¢ real, selectable, searchable text with proper pagination
     â€¢ works on Android Chrome (Print â†’ "Save as PDF")

   How it works:
     1. Build a clean, self-contained print document (its own
        light styles, independent of the app's theme).
     2. Load it into a HIDDEN <iframe> (popups are unreliable
        inside an installed/standalone PWA; an iframe is not).
     3. Call print() on the iframe, then remove it afterward.

   This is a pure READ action: it reads the open note from the
   store and writes nothing. No store/db/schema involvement.
   ============================================================= */
function handleExportPdf(id) {
  // The button lives in the editor, so the target is the open note.
  const note = store.getSelectedNote();
  if (!note || (id && note.id !== id)) {
    ui.toast('Open a note first to export it.');
    return;
  }

  const html = buildPrintDocument(note);
  printViaIframe(html, () => ui.toast('Opening printâ€¦ choose â€œSave as PDFâ€.'));
}

/*
   escapeHtml â€” turn user text into safe HTML for the print doc.
   The note body/title can contain characters like < > & that
   would otherwise be interpreted as markup. We convert them so
   they render literally (this is the same XSS-safety principle
   ui.js uses with textContent).
*/
function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/*
   buildPrintDocument(note) â€” return a full HTML string for print.
   It's intentionally standalone (its own <style>) so the PDF looks
   clean and consistent regardless of dark mode or the app's CSS.
   Title falls back to the first body line; tags/date shown as meta.
*/
function buildPrintDocument(note) {
  // Derive a sensible title even if the user never typed one.
  const rawTitle =
    (note.title && note.title.trim()) ||
    (note.body || '').split('\n')[0].trim() ||
    'Untitled note';

  const title = escapeHtml(rawTitle);
  const body = escapeHtml(note.body || '');
  const date = new Date(note.updatedAt || Date.now()).toLocaleString();
  const tags = (note.tags || []).map((t) => '#' + escapeHtml(t)).join('  ');

  // A4-friendly margins, readable measure, real print typography.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  @page { margin: 20mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1c1a22;
    line-height: 1.6;
    margin: 0;
  }
  .doc { max-width: 72ch; margin: 0 auto; }
  h1 {
    font-size: 22pt;
    line-height: 1.2;
    margin: 0 0 6pt;
    letter-spacing: -0.01em;
  }
  .meta {
    font-size: 9pt;
    color: #6b6676;
    margin-bottom: 16pt;
    padding-bottom: 10pt;
    border-bottom: 1px solid #e2dfe8;
  }
  .meta .tags { color: #5b3fc4; }
  /* Preserve the note's line breaks & spacing exactly as typed. */
  .body {
    font-size: 11.5pt;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
</head>
<body>
  <div class="doc">
    <h1>${title}</h1>
    <div class="meta">
      <div>${date}</div>
      ${tags ? `<div class="tags">${tags}</div>` : ''}
    </div>
    <div class="body">${body}</div>
  </div>
</body>
</html>`;
}

/*
   printViaIframe(html, onReady) â€” render HTML in a hidden iframe
   and trigger the print dialog. Using an iframe (not window.open)
   keeps this working inside an installed PWA and avoids popup
   blockers. We clean the iframe up after printing.
*/
function printViaIframe(html, onReady) {
  const iframe = document.createElement('iframe');
  // Keep it out of sight but still renderable (display:none can
  // suppress printing in some engines, so we hide it off-screen).
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.setAttribute('aria-hidden', 'true');

  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  // Wait for the iframe document to finish laying out before printing.
  const triggerPrint = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      if (onReady) onReady();
    } catch (err) {
      console.error('Print failed:', err);
      ui.toast('Could not open the print dialog.');
    }
    // Remove the iframe a moment after the print dialog is handled.
    setTimeout(() => iframe.remove(), 1000);
  };

  // 'load' is the reliable signal; fall back to a short timeout.
  if (iframe.contentWindow.document.readyState === 'complete') {
    setTimeout(triggerPrint, 50);
  } else {
    iframe.addEventListener('load', triggerPrint, { once: true });
    setTimeout(triggerPrint, 500); // safety net if 'load' never fires
  }
}


/* =============================================================
   7. EXPORT / IMPORT (JSON backup of ALL notes)
   -------------------------------------------------------------
   Export: ask the store to serialize, then trigger a download.
   Import: read the chosen file, parse JSON, ask whether to merge
   or replace, and hand it to the store. All the data logic lives
   in store.js; app.js only handles the file plumbing + prompts.
   ============================================================= */
function handleExport() {
  const data = store.toJSON();
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  download(`slate-backup-${stamp}.json`, JSON.stringify(data, null, 2));
  ui.toast('Exported your notes');
}

async function onImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await readFileAsText(file);
    const data = JSON.parse(text);

    // Ask how to bring the data in. OK = replace, Cancel = merge.
    const replace = confirm(
      'Import notes.\n\nOK = REPLACE everything with this file.\nCancel = MERGE into your current notes.'
    );

    await store.importJSON(data, { replace });
    ui.toast('Import complete');
  } catch (err) {
    console.error(err);
    ui.toast(err.message || 'Could not import that file.');
  } finally {
    // Reset the input so choosing the same file again still fires.
    event.target.value = '';
  }
}


/* =============================================================
   8. THEME TOGGLE
   -------------------------------------------------------------
   Flip data-theme on <html>, persist the choice, and update the
   icon. The inline script in index.html already applied the saved
   theme before paint; this just lets the user change it.
   ============================================================= */
function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('slate:theme', next); } catch (e) { /* ignore */ }
  ui.updateThemeIcon();
}


/* =============================================================
   9. KEYBOARD SHORTCUTS
   -------------------------------------------------------------
     Ctrl/Cmd + K  â†’ focus search
     Ctrl/Cmd + N  â†’ new note
     Escape        â†’ close editor (mobile) or clear search focus
   We ignore shortcuts while typing in a field (except Escape and
   the search/new combos, which use a modifier so they're safe).
   ============================================================= */
function onGlobalKeydown(event) {
  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('.search__input').focus();
    return;
  }

  if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    store.createNote();
    return;
  }

  if (event.key === 'Escape') {
    // If a note is open on mobile, Escape backs out to the list.
    if (store.getView().selectedId) store.selectNote(null);
    ui.closeSidebar();
  }
}


/* =============================================================
   10. SERVICE WORKER (PWA)
   -------------------------------------------------------------
   Registers sw.js (File 9) so the app works offline and is
   installable. Wrapped in a guard so a missing SW never breaks
   the app during local development.
   ============================================================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Register after load so it never competes with first paint.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}


/* ============ GO ============ */
boot();
