/* =============================================================
   NoteFlow â€” app.js
   -------------------------------------------------------------
   THE CONTROLLER. Glue between DOM events and store actions:

        DOM events  â†’  app.js  â†’  store actions  â†’  (store persists
        via db.js)  â†’  store notifies  â†’  ui.js re-renders.

   app.js holds NO state and does NO rendering. It boots the app,
   listens for events (one delegated click listener + a few input
   handlers), and translates each into the right store action.
   ============================================================= */

import * as store from './store.js';
import * as ui from './ui.js';
import { debounce, download, readFileAsText, $, mount } from './utils.js';


/* =============================================================
   1. BOOT SEQUENCE
   ============================================================= */
async function boot() {
  await ensureLucide();
  store.subscribe(ui.render);
  ui.updateThemeIcon();

  try {
    await store.hydrate();
  } catch (err) {
    console.error('Failed to load your notes:', err);
    ui.toast('Couldnâ€™t open local storage. Notes may not save.');
  }

  wireEvents();
  registerServiceWorker();
}

function ensureLucide() {
  return new Promise((resolve) => {
    if (window.lucide) return resolve();
    let tries = 0;
    const timer = setInterval(() => {
      if (window.lucide || tries++ > 40) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}


/* =============================================================
   2. EVENT WIRING
   ============================================================= */
function wireEvents() {
  document.addEventListener('click', onClick);

  mount('editor-title').addEventListener('input', onEditorInput);
  mount('editor-body').addEventListener('input', onEditorInput);
  mount('editor-tag-input').addEventListener('keydown', onTagInputKeydown);

  const searchForm = $('[data-action="search"]');
  const searchInput = searchForm.querySelector('.search__input');
  searchInput.addEventListener('input', onSearchInput);
  searchForm.addEventListener('reset', () => {
    store.setSearch('');
    toggleSearchClear(searchInput);
  });

  mount('import-input').addEventListener('change', onImportFile);
  document.addEventListener('keydown', onGlobalKeydown);
}


/* =============================================================
   3. DELEGATED CLICK HANDLER
   ============================================================= */
function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const { action, id, filter, tag } = target.dataset;

  switch (action) {
    /* --- creating --- */
    case 'new-note':
      store.createNote();
      ui.closeSidebar();
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
      event.stopPropagation();
      store.togglePin(id);
      break;

    case 'delete-note':
      handleDelete(id || mount('editor').dataset.id);
      break;

    case 'move-note':
      handleMove(id || mount('editor').dataset.id);
      break;

    /* --- Phase 1 / Feature 1: export as PDF --- */
    case 'export-pdf':
      handleExportPdf(id || mount('editor').dataset.id);
      break;

    /* --- Phase 1 / Feature 2: export as image --- */
    case 'export-image':
      handleExportImage(id || mount('editor').dataset.id);
      break;

    /* --- Phase 1 / Feature 3: Trash & Restore â˜… NEW --- */
    case 'restore-note':
      event.stopPropagation();
      store.restoreNote(id);
      ui.toast('Note restored');
      break;

    case 'purge-note':
      event.stopPropagation();
      handlePurge(id);
      break;

    case 'empty-trash':
      handleEmptyTrash();
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

    /* --- import / export (JSON) --- */
    case 'export':
      handleExport();
      break;
    case 'import':
      mount('import-input').click();
      break;
  }
}

function applyFilter(type, value) {
  if (type === 'folder') store.setFilter('folder', value);
  else if (type === 'tag') store.setFilter('tag', value);
  else store.setFilter(type); // 'all' | 'pinned' | 'trash'
}


/* =============================================================
   4. AUTOSAVE (debounced)
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
  ui.setSaveStatus('saving');
  saveNow();
}


/* =============================================================
   5. TAGS + SEARCH input handlers
   ============================================================= */
function onTagInputKeydown(event) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    const input = event.currentTarget;
    const id = mount('editor').dataset.id;
    if (id && input.value.trim()) {
      store.addTag(id, input.value);
      input.value = '';
    }
  }
  if (event.key === 'Backspace' && !event.currentTarget.value) {
    const note = store.getSelectedNote();
    if (note && note.tags.length) {
      store.removeTag(note.id, note.tags[note.tags.length - 1]);
    }
  }
}

const pushSearch = debounce((text) => store.setSearch(text), 120);

function onSearchInput(event) {
  const input = event.currentTarget;
  pushSearch(input.value);
  toggleSearchClear(input);
}

function toggleSearchClear(input) {
  const clearBtn = input.parentElement.querySelector('.search__clear');
  if (clearBtn) clearBtn.hidden = input.value.length === 0;
}


/* =============================================================
   6. DELETE + UNDO  (now soft-delete â†’ Trash)
   -------------------------------------------------------------
   store.deleteNote soft-deletes (moves to Trash) and returns the
   note. The Undo action restores it instantly. "Delete forever"
   and "Empty trash" are the permanent operations below.
   ============================================================= */
async function handleDelete(id) {
  if (!id) return;
  const removed = await store.deleteNote(id);
  if (!removed) return;

  ui.toast('Moved to Trash', {
    actionLabel: 'Undo',
    onAction: () => store.restoreNote(removed),
    duration: 6000,
  });
}

/*
   handlePurge â€” permanent, single-note delete from the Trash view.
   We confirm first because it can't be undone.
*/
async function handlePurge(id) {
  if (!id) return;
  const ok = confirm('Delete this note forever? This cannot be undone.');
  if (!ok) return;
  await store.purgeNote(id);
  ui.toast('Note permanently deleted');
}

/*
   handleEmptyTrash â€” permanently delete every trashed note.
   Confirmed, and reports how many were removed.
*/
async function handleEmptyTrash() {
  const ok = confirm('Empty the Trash? All notes in it will be permanently deleted.');
  if (!ok) return;
  const count = await store.emptyTrash();
  ui.toast(count ? `Deleted ${count} note${count === 1 ? '' : 's'}` : 'Trash is already empty');
}

/*
   handleMove â€” pick a destination folder via a numbered prompt.
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
   6b. EXPORT NOTE AS PDF   (Phase 1 / Feature 1)
   ============================================================= */
function handleExportPdf(id) {
  const note = store.getSelectedNote();
  if (!note || (id && note.id !== id)) {
    ui.toast('Open a note first to export it.');
    return;
  }
  const html = buildPrintDocument(note);
  printViaIframe(html, () => ui.toast('Opening printâ€¦ choose â€œSave as PDFâ€.'));
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanDateLine(note) {
  const created = note.createdAt ? new Date(note.createdAt) : null;
  const updated = note.updatedAt ? new Date(note.updatedAt) : null;
  const fmt = (d) => d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  if (created && updated && Math.abs(updated - created) > 60000) {
    return `Created ${fmt(created)} Â· Updated ${fmt(updated)}`;
  }
  if (updated) return fmt(updated);
  if (created) return fmt(created);
  return '';
}

function noteDisplayTitle(note) {
  return (
    (note.title && note.title.trim()) ||
    (note.body || '').split('\n')[0].trim() ||
    'Untitled note'
  );
}

function safeFilename(text = 'note') {
  return (
    text.trim().toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'note'
  );
}

function buildPrintDocument(note) {
  const title = escapeHtml(noteDisplayTitle(note));
  const body = escapeHtml(note.body || '');
  const dateLine = humanDateLine(note);
  const tags = (note.tags || []).map((t) => '#' + escapeHtml(t)).join('  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  @page { margin: 18mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #1c1a22; line-height: 1.6; orphans: 3; widows: 3;
  }
  .doc { max-width: 72ch; margin: 0 auto; }
  .head {
    break-inside: avoid; break-after: avoid;
    margin-bottom: 14pt; padding-bottom: 10pt; border-bottom: 1px solid #e2dfe8;
  }
  h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 6pt; letter-spacing: -0.01em; break-after: avoid; }
  .meta { font-size: 9pt; color: #6b6676; }
  .meta .tags { color: #5b3fc4; margin-top: 2pt; }
  .body { font-size: 11.5pt; white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word; }
</style>
</head>
<body>
  <div class="doc">
    <header class="head">
      <h1>${title}</h1>
      <div class="meta">
        ${dateLine ? `<div class="date">${escapeHtml(dateLine)}</div>` : ''}
        ${tags ? `<div class="tags">${tags}</div>` : ''}
      </div>
    </header>
    <div class="body">${body}</div>
  </div>
</body>
</html>`;
}

function printViaIframe(html, onReady) {
  const iframe = document.createElement('iframe');
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

  const triggerPrint = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      if (onReady) onReady();
    } catch (err) {
      console.error('Print failed:', err);
      ui.toast('Could not open the print dialog.');
    }
    setTimeout(() => iframe.remove(), 1000);
  };

  if (iframe.contentWindow.document.readyState === 'complete') {
    setTimeout(triggerPrint, 50);
  } else {
    iframe.addEventListener('load', triggerPrint, { once: true });
    setTimeout(triggerPrint, 500);
  }
}


/* =============================================================
   6c. EXPORT NOTE AS IMAGE (PNG/JPG)   (Phase 1 / Feature 2)
   ============================================================= */
async function handleExportImage(id) {
  const note = store.getSelectedNote();
  if (!note || (id && note.id !== id)) {
    ui.toast('Open a note first to export it.');
    return;
  }

  const wantPng = confirm(
    'Export as image:\n\nOK = PNG (sharp text, larger file)\nCancel = JPG (smaller file)'
  );
  const format = wantPng ? 'png' : 'jpg';

  try {
    const blob = await renderNoteToImageBlob(note, format);
    const name = `${safeFilename(noteDisplayTitle(note))}.${format}`;
    downloadBlob(blob, name);
    ui.toast(`Saved ${format.toUpperCase()} image`);
  } catch (err) {
    console.error('Image export failed:', err);
    ui.toast('Could not create the image.');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const rawLine of String(text).split('\n')) {
    if (rawLine === '') { lines.push(''); continue; }
    let current = '';
    for (const word of rawLine.split(/(\s+)/)) {
      const trial = current + word;
      if (ctx.measureText(trial).width > maxWidth && current) {
        lines.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current = trial;
      }
    }
    if (current.trim() !== '' || current === '') lines.push(current.trimEnd());
  }
  return lines;
}

function renderNoteToImageBlob(note, format) {
  return new Promise((resolve, reject) => {
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    const width = 800;
    const padding = 56;
    const contentW = width - padding * 2;

    const titleFont = '700 34px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const metaFont = '400 15px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const bodyFont = '400 19px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const titleLH = 42, metaLH = 22, bodyLH = 30;

    const measureCanvas = document.createElement('canvas');
    const mctx = measureCanvas.getContext('2d');

    mctx.font = titleFont;
    const titleLines = wrapText(mctx, noteDisplayTitle(note), contentW);

    const dateLine = humanDateLine(note);
    const tagsLine = (note.tags || []).map((t) => '#' + t).join('  ');

    mctx.font = bodyFont;
    const bodyLines = wrapText(mctx, note.body || '', contentW);

    let y = padding;
    y += titleLines.length * titleLH;
    y += 10;
    if (dateLine) y += metaLH;
    if (tagsLine) y += metaLH;
    y += 18;
    y += 1 + 22;
    y += bodyLines.length * bodyLH;
    y += padding;
    const height = Math.max(y, 240);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#1c1a22';
    ctx.font = titleFont;
    let cursorY = padding;
    for (const line of titleLines) {
      ctx.fillText(line, padding, cursorY);
      cursorY += titleLH;
    }
    cursorY += 10;

    ctx.font = metaFont;
    if (dateLine) {
      ctx.fillStyle = '#6b6676';
      ctx.fillText(dateLine, padding, cursorY);
      cursorY += metaLH;
    }
    if (tagsLine) {
      ctx.fillStyle = '#5b3fc4';
      ctx.fillText(tagsLine, padding, cursorY);
      cursorY += metaLH;
    }
    cursorY += 18;

    ctx.strokeStyle = '#e2dfe8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, cursorY + 0.5);
    ctx.lineTo(width - padding, cursorY + 0.5);
    ctx.stroke();
    cursorY += 22;

    ctx.font = bodyFont;
    ctx.fillStyle = '#2c2933';
    for (const line of bodyLines) {
      ctx.fillText(line, padding, cursorY);
      cursorY += bodyLH;
    }

    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const quality = format === 'png' ? undefined : 0.92;
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      mime,
      quality
    );
  });
}


/* =============================================================
   7. EXPORT / IMPORT (JSON backup of ALL notes)
   ============================================================= */
function handleExport() {
  const data = store.toJSON();
  const stamp = new Date().toISOString().slice(0, 10);
  download(`slate-backup-${stamp}.json`, JSON.stringify(data, null, 2));
  ui.toast('Exported your notes');
}

async function onImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await readFileAsText(file);
    const data = JSON.parse(text);

    const replace = confirm(
      'Import notes.\n\nOK = REPLACE everything with this file.\nCancel = MERGE into your current notes.'
    );

    await store.importJSON(data, { replace });
    ui.toast('Import complete');
  } catch (err) {
    console.error(err);
    ui.toast(err.message || 'Could not import that file.');
  } finally {
    event.target.value = '';
  }
}


/* =============================================================
   8. THEME TOGGLE
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
    if (store.getView().selectedId) store.selectNote(null);
    ui.closeSidebar();
  }
}


/* =============================================================
   10. SERVICE WORKER (PWA)
   ============================================================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}


/* ============ GO ============ */
boot();
