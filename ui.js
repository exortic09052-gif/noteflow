/* =============================================================
   NoteFlow â€” ui.js
   -------------------------------------------------------------
   THE RENDERING LAYER. Its ONE job: turn `state` into DOM.

   Strict boundaries (this is what "no business logic" means):
     â€¢ ui.js READS from store.js (getVisibleNotes, getFoldersâ€¦).
     â€¢ ui.js NEVER writes to the store and NEVER touches db.js.
     â€¢ When the user clicks/types, ui.js does NOT decide what
       happens. Every interactive element just carries a
       data-action / data-id attribute. app.js listens for those
       and calls the right store action. Then the store notifies
       and we re-render here.

   Loop:
       state â†’ ui.js draws â†’ user acts â†’ app.js handles â†’
       store changes â†’ notify â†’ ui.js draws again.
   ============================================================= */

import * as store from './store.js';
import {
  mount, el, clear, formatDate, excerpt, deriveTitle,
} from './utils.js';


/* ============ CACHED MOUNT POINTS ============ */
const M = {
  smartFolders: mount('smart-folders'),
  folders:      mount('folders'),
  tags:         mount('tags'),
  listTitle:    mount('list-title'),
  listCount:    mount('list-count'),
  noteList:     mount('note-list'),
  listEmpty:    mount('list-empty'),
  editor:       mount('editor'),
  editorTitle:  mount('editor-title'),
  editorBody:   mount('editor-body'),
  editorTags:   mount('editor-tags'),
  tagInput:     mount('editor-tag-input'),
  saveStatus:   mount('save-status'),
  placeholder:  mount('editor-placeholder'),
  toasts:       mount('toasts'),
};

const workspace = document.querySelector('.workspace');
const sidebar   = document.getElementById('sidebar');
const scrim     = document.querySelector('.scrim');


/* ============ ICONS ============ */
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function icon(name) {
  return el('i', { 'data-lucide': name });
}


/* ============ MAIN RENDER ============ */
export function render(state) {
  renderSidebar(state);
  renderListHeader(state);
  renderNotes(state);
  renderEditor(state);
  syncResponsiveState(state);
  refreshIcons();
}


/* ============ SIDEBAR ============ */
function renderSidebar(state) {
  const counts = store.getCounts();
  const { filter } = state;

  /* --- Smart folders: All notes + Pinned + Trash --- */
  clear(M.smartFolders);
  M.smartFolders.append(
    navItem({
      iconName: 'layers',
      label: 'All notes',
      count: counts.all,
      active: filter.type === 'all',
      dataset: { action: 'filter', filter: 'all' },
    }),
    navItem({
      iconName: 'pin',
      label: 'Pinned',
      count: counts.pinned,
      active: filter.type === 'pinned',
      dataset: { action: 'filter', filter: 'pinned' },
    }),
    // â˜… NEW: Trash smart view. Only show a count when non-zero, to
    // keep the sidebar quiet when the trash is empty.
    navItem({
      iconName: 'trash-2',
      label: 'Trash',
      count: counts.trash || null,
      active: filter.type === 'trash',
      dataset: { action: 'filter', filter: 'trash' },
    }),
  );

  /* --- User folders --- */
  clear(M.folders);
  const folders = store.getFolders();
  if (folders.length === 0) {
    M.folders.append(el('li', { class: 'nav-empty', text: 'No folders yet' }));
  } else {
    for (const folder of folders) {
      M.folders.append(
        navItem({
          iconName: 'folder',
          label: folder.name,
          count: counts.byFolder(folder.id),
          active: filter.type === 'folder' && filter.value === folder.id,
          dataset: { action: 'filter', filter: 'folder', id: folder.id },
          menu: { action: 'rename-folder', id: folder.id },
        })
      );
    }
  }

  /* --- Tag cloud --- */
  clear(M.tags);
  const tags = store.getTagCounts();
  if (tags.length === 0) {
    M.tags.append(el('li', { class: 'nav-empty', text: 'No tags yet' }));
  } else {
    for (const { tag, count } of tags) {
      const isActive = filter.type === 'tag' && filter.value === tag;
      M.tags.append(
        el('li', {}, el('button', {
          class: 'tag' + (isActive ? ' is-active' : ''),
          type: 'button',
          dataset: { action: 'filter', filter: 'tag', id: tag },
          title: `${count} note${count === 1 ? '' : 's'}`,
          text: tag,
        }))
      );
    }
  }
}

function navItem({ iconName, label, count, active, dataset, menu }) {
  const btn = el('button', {
    class: 'nav-item' + (active ? ' is-active' : ''),
    type: 'button',
    dataset,
  }, [
    icon(iconName),
    el('span', { class: 'nav-item__label', text: label }),
    count != null ? el('span', { class: 'nav-item__count', text: String(count) }) : null,
  ]);

  if (menu) {
    btn.append(
      el('span', {
        class: 'icon-btn icon-btn--sm',
        role: 'button',
        'aria-label': 'Rename folder',
        dataset: menu,
      }, icon('pencil'))
    );
  }

  return el('li', {}, btn);
}


/* ============ LIST HEADER ============ */
function renderListHeader(state) {
  const { filter, search } = state;

  let title = 'All notes';
  if (filter.type === 'pinned') title = 'Pinned';
  else if (filter.type === 'trash') title = 'Trash';          // â˜… NEW
  else if (filter.type === 'tag') title = '#' + filter.value;
  else if (filter.type === 'folder') {
    const folder = store.getFolders().find((f) => f.id === filter.value);
    title = folder ? folder.name : 'Folder';
  }
  if (search.trim()) title = `Results for â€œ${search.trim()}â€`;

  M.listTitle.textContent = title;

  const visible = store.getVisibleNotes();

  // The meta area shows the count. In Trash, when there are items,
  // we ALSO render an "Empty trash" button here (pure data-action).
  clear(M.listCount);
  M.listCount.append(
    el('span', { text: visible.length + (visible.length === 1 ? ' note' : ' notes') })
  );

  if (filter.type === 'trash' && visible.length > 0) {
    M.listCount.append(
      el('button', {
        class: 'btn btn--ghost btn--sm list-pane__empty-trash',
        type: 'button',
        dataset: { action: 'empty-trash' },
        title: 'Permanently delete all notes in Trash',
      }, [icon('trash'), el('span', { text: 'Empty trash' })])
    );
  }
}


/* ============ NOTE LIST ============ */
function renderNotes(state) {
  const notes = store.getVisibleNotes();

  clear(M.noteList);

  if (notes.length === 0) {
    M.listEmpty.hidden = false;
    M.noteList.hidden = true;
    tuneEmptyState(state);
    return;
  }
  M.listEmpty.hidden = true;
  M.noteList.hidden = false;

  notes.forEach((note, i) => {
    M.noteList.append(noteCard(note, state.selectedId, i));
  });
}

function tuneEmptyState(state) {
  const titleEl = M.listEmpty.querySelector('.empty__title');
  const hintEl  = M.listEmpty.querySelector('.empty__hint');
  if (!titleEl || !hintEl) return;

  if (state.search.trim()) {
    titleEl.textContent = 'No matches';
    hintEl.textContent = 'Try a different word, or clear the search.';
  } else if (state.filter.type === 'trash') {           // â˜… NEW
    titleEl.textContent = 'Trash is empty';
    hintEl.textContent = 'Deleted notes wait here until you remove them for good.';
  } else if (state.filter.type === 'pinned') {
    titleEl.textContent = 'Nothing pinned';
    hintEl.textContent = 'Pin a note to keep it at the top.';
  } else if (state.filter.type === 'folder') {
    titleEl.textContent = 'This folder is empty';
    hintEl.textContent = 'New notes you make here will land in this folder.';
  } else {
    titleEl.textContent = 'Nothing here yet';
    hintEl.textContent = 'Your notes will show up in this space.';
  }
}

/*
   noteCard(note, selectedId, index)
   -------------------------------------------------------------
   A trashed note (note.deletedAt set) is rendered DIFFERENTLY:
     â€¢ it is NOT clickable to open in the editor,
     â€¢ its footer shows Restore + Delete-forever buttons,
     â€¢ it shows WHEN it was trashed instead of the updated date.
   A live note behaves exactly as before.
*/
function noteCard(note, selectedId, index) {
  const isTrashed = Boolean(note.deletedAt);
  const isSelected = note.id === selectedId;
  const folder = note.folderId
    ? store.getFolders().find((f) => f.id === note.folderId)
    : null;

  /* --- head: title + (pin, only for live notes) --- */
  const headChildren = [
    el('h3', { class: 'note-card__title', text: deriveTitle(note) }),
  ];
  if (!isTrashed) {
    headChildren.push(
      el('button', {
        class: 'note-card__pin' + (note.pinned ? ' is-pinned' : ''),
        type: 'button',
        'aria-label': note.pinned ? 'Unpin note' : 'Pin note',
        'aria-pressed': String(note.pinned),
        dataset: { action: 'toggle-pin', id: note.id },
      }, icon('pin'))
    );
  }
  const head = el('div', { class: 'note-card__head' }, headChildren);

  /* --- excerpt --- */
  const previewText = excerpt(note.body, 220);
  const excerptEl = previewText
    ? el('p', { class: 'note-card__excerpt', text: previewText })
    : null;

  /* --- foot --- */
  const footChildren = [];

  if (isTrashed) {
    // Show when it was trashed, then the two recovery actions.
    footChildren.push(
      el('span', { class: 'note-card__date', text: 'Deleted ' + formatDate(note.deletedAt) })
    );
    footChildren.push(
      el('span', { class: 'note-card__trash-actions' }, [
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          dataset: { action: 'restore-note', id: note.id },
        }, [icon('rotate-ccw'), el('span', { text: 'Restore' })]),
        el('button', {
          class: 'btn btn--ghost btn--sm btn--danger-text',
          type: 'button',
          dataset: { action: 'purge-note', id: note.id },
        }, [icon('trash-2'), el('span', { text: 'Delete' })]),
      ])
    );
  } else {
    footChildren.push(
      el('span', { class: 'note-card__date', text: formatDate(note.updatedAt) })
    );
    if (folder) {
      footChildren.push(
        el('span', { class: 'note-card__folder' }, [icon('folder'), folder.name])
      );
    }
    if (note.tags && note.tags.length) {
      footChildren.push(
        el('span', { class: 'note-card__tags' },
          note.tags.slice(0, 3).map((t) => el('span', { class: 'chip', text: t }))
        )
      );
    }
  }
  const foot = el('div', { class: 'note-card__foot' }, footChildren);

  /* --- the card --- */
  const cardProps = {
    class: 'note-card'
      + (isSelected ? ' is-selected' : '')
      + (isTrashed ? ' is-trashed' : ''),
    style: `--i:${Math.min(index, 12)}`,
  };
  // Only LIVE cards open the editor on click / keyboard.
  if (!isTrashed) {
    Object.assign(cardProps, {
      dataset: { action: 'open', id: note.id },
      tabindex: '0',
      role: 'button',
      'aria-label': deriveTitle(note),
    });
  }

  return el('li', cardProps, [head, excerptEl, foot]);
}


/* ============ EDITOR ============ */
function renderEditor(state) {
  const note = store.getSelectedNote();

  if (!note) {
    M.editor.hidden = true;
    if (M.placeholder) M.placeholder.hidden = false;
    return;
  }
  M.editor.hidden = false;
  if (M.placeholder) M.placeholder.hidden = true;

  if (M.editorTitle.value !== note.title) M.editorTitle.value = note.title;
  if (M.editorBody.value !== note.body)   M.editorBody.value = note.body;

  M.editor.dataset.id = note.id;

  const pinBtn = M.editor.querySelector('[data-action="toggle-pin"]');
  if (pinBtn) {
    pinBtn.setAttribute('aria-pressed', String(note.pinned));
    pinBtn.setAttribute('aria-label', note.pinned ? 'Unpin note' : 'Pin note');
  }

  renderEditorTags(note);
}

function renderEditorTags(note) {
  M.editorTags.querySelectorAll('.chip').forEach((c) => c.remove());

  const frag = document.createDocumentFragment();
  for (const tag of note.tags || []) {
    frag.append(
      el('span', { class: 'chip' }, [
        tag,
        el('button', {
          type: 'button',
          'aria-label': `Remove tag ${tag}`,
          dataset: { action: 'remove-tag', id: note.id, tag },
        }, icon('x')),
      ])
    );
  }
  M.editorTags.insertBefore(frag, M.tagInput);
}

export function setSaveStatus(stateName) {
  if (!M.saveStatus) return;
  if (stateName === 'saving') {
    M.saveStatus.textContent = 'Savingâ€¦';
    M.saveStatus.dataset.state = 'saving';
  } else {
    M.saveStatus.textContent = 'Saved';
    M.saveStatus.dataset.state = 'saved';
  }
}


/* ============ RESPONSIVE STATE ============ */
function syncResponsiveState(state) {
  const hasSelection = Boolean(state.selectedId);
  workspace.classList.toggle('has-selection', hasSelection);
  workspace.dataset.view = hasSelection ? 'editor' : 'list';
}

export function openSidebar() {
  sidebar.classList.add('is-open');
  if (scrim) scrim.hidden = false;
  const menuBtn = document.querySelector('[data-action="toggle-sidebar"]');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
}
export function closeSidebar() {
  sidebar.classList.remove('is-open');
  if (scrim) scrim.hidden = true;
  const menuBtn = document.querySelector('[data-action="toggle-sidebar"]');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
}
export function toggleSidebar() {
  if (sidebar.classList.contains('is-open')) closeSidebar();
  else openSidebar();
}


/* ============ THEME ICON ============ */
export function updateThemeIcon() {
  const btn = document.querySelector('[data-action="toggle-theme"]');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  clear(btn);
  btn.append(icon(isDark ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  refreshIcons();
}


/* ============ TOASTS ============ */
export function toast(message, { actionLabel, onAction, duration = 5000 } = {}) {
  const node = el('div', { class: 'toast', role: 'status' }, [
    el('span', { class: 'toast__msg', text: message }),
  ]);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };

  if (actionLabel && onAction) {
    node.append(
      el('button', {
        class: 'toast__action',
        type: 'button',
        text: actionLabel,
        on: { click: () => { onAction(); dismiss(); } },
      })
    );
  }

  M.toasts.append(node);
  refreshIcons();
  timer = setTimeout(dismiss, duration);
}
