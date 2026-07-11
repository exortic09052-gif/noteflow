/* =============================================================
   NoteFlow â€” store.js
   -------------------------------------------------------------
   THE SINGLE SOURCE OF TRUTH.

   Everything the UI shows is derived from the `state` object in
   this file. The rules that keep the app sane:

     â€¢ Nobody outside this file mutates `state` directly.
       They call actions here (createNote, togglePin, setSearchâ€¦).
     â€¢ Every action that changes data does TWO things, in order:
         1. update the in-memory `state`   (instant, for the UI)
         2. persist the change via db.js    (durable, on disk)
       Then it notifies subscribers so the UI re-renders.
     â€¢ The DB is the durable copy; `state` is the fast working
       copy. On startup we load the DB INTO state once (hydrate).

   -------------------------------------------------------------
   DATA SHAPES
   -------------------------------------------------------------
   Note = {
     id:        string,        // uid()
     title:     string,
     body:      string,
     tags:      string[],      // normalized, e.g. ["work","q3"]
     folderId:  string | null, // which folder, or null = none
     pinned:    boolean,
     createdAt: number,        // ms timestamp
     updatedAt: number,        // ms timestamp
     deletedAt: number | null, // â˜… NEW: null = alive, number = in Trash
   }

   Folder = {
     id:   string,
     name: string,
     createdAt: number,
   }

   -------------------------------------------------------------
   â˜… TRASH MODEL (Phase 1 / Feature 3)
   -------------------------------------------------------------
   "Deleting" a note now SOFT-deletes it: we stamp deletedAt with
   the current time. Trashed notes are hidden everywhere except
   the Trash view. From Trash you can RESTORE (clear deletedAt) or
   DELETE FOREVER (purge = real DB removal). Backward compatible:
   notes without deletedAt are treated as alive.
   ============================================================= */

import * as db from './db.js';
import { uid, now, normalizeTag, matchesQuery, deriveTitle } from './utils.js';


/* ============ 1. STATE STRUCTURE ============ */
const state = {
  // --- data ---
  notes: [],    // array of Note objects (unsorted; we sort on read)
  folders: [],  // array of Folder objects

  // --- current view ---
  filter: { type: 'all', value: null },
  //   type: 'all'    â†’ every LIVE note              (value ignored)
  //   type: 'pinned' â†’ only pinned LIVE notes       (value ignored)
  //   type: 'folder' â†’ LIVE notes in a folder       (value = folderId)
  //   type: 'tag'    â†’ LIVE notes with a tag        (value = tag string)
  //   type: 'trash'  â†’ only TRASHED notes           (value ignored) â˜… NEW

  search: '',        // current search query text
  selectedId: null,  // id of the note open in the editor
};


/* ============ 2. SUBSCRIBE / NOTIFY ============ */
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}


/* ============ 3. READ HELPERS ============ */

/*
   Small internal predicate: is a note "alive" (not trashed)?
   Treating a MISSING deletedAt as alive is what keeps old notes
   and old backups working with zero migration.
*/
function isAlive(note) {
  return !note.deletedAt;
}

export function getAllNotes() {
  return state.notes;
}

export function getSelectedNote() {
  return state.notes.find((n) => n.id === state.selectedId) || null;
}

export function getView() {
  return { filter: state.filter, search: state.search, selectedId: state.selectedId };
}

export function getFolders() {
  return state.folders;
}

/*
   getTagCounts() â€” tag cloud data. Excludes trashed notes so the
   cloud reflects only live content.
*/
export function getTagCounts() {
  const counts = new Map();
  for (const note of state.notes) {
    if (!isAlive(note)) continue; // skip trashed
    for (const tag of note.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/*
   getCounts() â€” sidebar badges. Live counts exclude trashed
   notes; `trash` counts only trashed ones.
*/
export function getCounts() {
  const live = state.notes.filter(isAlive);
  return {
    all: live.length,
    pinned: live.filter((n) => n.pinned).length,
    trash: state.notes.length - live.length,           // â˜… NEW
    byFolder: (folderId) => live.filter((n) => n.folderId === folderId).length,
  };
}


/* ============ 4. FILTER + SEARCH + SORT ============ */
/*
   getVisibleNotes() applies, in order:
     1. FILTER  (all / pinned / folder / tag / trash)
        - Trash view shows ONLY trashed notes.
        - Every other view shows ONLY live notes.
     2. SEARCH  (via matchesQuery)
     3. SORT
        - Trash: most-recently-trashed first.
        - Others: pinned first, then most-recently-updated.
*/
export function getVisibleNotes() {
  const { filter, search } = state;

  // --- 1. FILTER ---
  let list;
  if (filter.type === 'trash') {
    // Only trashed notes here.
    list = state.notes.filter((note) => !isAlive(note));
  } else {
    // Everywhere else: only live notes, then the specific filter.
    list = state.notes.filter(isAlive).filter((note) => {
      switch (filter.type) {
        case 'pinned': return note.pinned;
        case 'folder': return note.folderId === filter.value;
        case 'tag':    return (note.tags || []).includes(filter.value);
        case 'all':
        default:       return true;
      }
    });
  }

  // --- 2. SEARCH ---
  list = list.filter((note) => matchesQuery(note, search));

  // --- 3. SORT (copy first so we never mutate state.notes) ---
  if (filter.type === 'trash') {
    return [...list].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  }
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pinned to the top
    return b.updatedAt - a.updatedAt;                    // newer first
  });
}


/* ============ 5. VIEW ACTIONS ============ */
export function setFilter(type, value = null) {
  state.filter = { type, value };
  notify();
}

export function clearFilters() {
  state.filter = { type: 'all', value: null };
  state.search = '';
  notify();
}

export function setSearch(text) {
  state.search = text;
  notify();
}

export function selectNote(id) {
  state.selectedId = id;
  notify();
}


/* ============ 6. DATA ACTIONS ============ */

/** Create a brand-new empty note, select it, and persist. Returns it. */
export async function createNote(partial = {}) {
  const timestamp = now();
  const note = {
    id: uid(),
    title: '',
    body: '',
    tags: [],
    folderId: state.filter.type === 'folder' ? state.filter.value : null,
    pinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null, // â˜… alive by default
    ...partial,
  };

  state.notes.push(note);
  state.selectedId = note.id;
  notify();

  await db.putNote(note);
  return note;
}

/** Patch fields on a note (used by autosave and tag edits). */
export async function updateNote(id, changes) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return null;

  Object.assign(note, changes, { updatedAt: now() });

  notify();
  await db.putNote(note);
  return note;
}

/** Toggle a note's pinned flag. */
export async function togglePin(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned = !note.pinned;
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}

/*
   deleteNote(id) â€” â˜… SOFT delete.
   Stamps deletedAt so the note moves to Trash (still in the DB,
   just flagged). If it was open in the editor, close the editor.
   Returns the note so app.js can offer an Undo (which restores it).
*/
export async function deleteNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return null;

  note.deletedAt = now();
  if (state.selectedId === id) state.selectedId = null;

  notify();
  await db.putNote(note); // persist the flag (NOT a real delete)
  return note;
}

/*
   restoreNote(idOrNote) â€” â˜… clear deletedAt so the note returns
   to its normal place. Accepts either a note id or a note object
   (the Undo toast passes the object it received from deleteNote).
*/
export async function restoreNote(idOrNote) {
  const id = typeof idOrNote === 'string' ? idOrNote : idOrNote && idOrNote.id;
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  note.deletedAt = null;
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}

/*
   purgeNote(id) â€” â˜… PERMANENT delete (Delete forever).
   Removes the note from state AND from IndexedDB. Not reversible.
*/
export async function purgeNote(id) {
  const index = state.notes.findIndex((n) => n.id === id);
  if (index === -1) return;

  state.notes.splice(index, 1);
  if (state.selectedId === id) state.selectedId = null;

  notify();
  await db.deleteNote(id); // the real DB removal (db.js unchanged)
}

/*
   emptyTrash() â€” â˜… permanently delete EVERY trashed note.
   Returns how many were purged (for a confirmation toast).
*/
export async function emptyTrash() {
  const trashed = state.notes.filter((n) => !isAlive(n));
  if (trashed.length === 0) return 0;

  const ids = new Set(trashed.map((n) => n.id));
  state.notes = state.notes.filter((n) => !ids.has(n.id));
  if (ids.has(state.selectedId)) state.selectedId = null;

  // If we were viewing Trash, it's now empty â€” stay put; the view
  // will just show its empty state.
  notify();

  // Persist: remove each from the DB.
  for (const id of ids) {
    await db.deleteNote(id);
  }
  return trashed.length;
}


/* ============ 7. TAG ACTIONS ============ */
export async function addTag(id, rawTag) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  const tag = normalizeTag(rawTag);
  if (!tag) return;
  if (note.tags.includes(tag)) return;

  note.tags = [...note.tags, tag];
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}

export async function removeTag(id, tag) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.tags = note.tags.filter((t) => t !== tag);
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}


/* ============ 8. FOLDER ACTIONS ============ */
export async function createFolder(name) {
  const folder = { id: uid(), name: name.trim() || 'New folder', createdAt: now() };
  state.folders.push(folder);
  notify();
  await db.putFolder(folder);
  return folder;
}

export async function renameFolder(id, name) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  folder.name = name.trim() || folder.name;
  notify();
  await db.putFolder(folder);
}

/*
   deleteFolder(id) â€” remove a folder. Notes inside are NOT
   deleted; they move back to "no folder" (folderId = null).
*/
export async function deleteFolder(id) {
  state.folders = state.folders.filter((f) => f.id !== id);

  const affected = state.notes.filter((n) => n.folderId === id);
  for (const note of affected) {
    note.folderId = null;
    note.updatedAt = now();
  }

  if (state.filter.type === 'folder' && state.filter.value === id) {
    state.filter = { type: 'all', value: null };
  }

  notify();
  await db.deleteFolder(id);
  await db.bulkPutNotes(affected);
}

export async function moveNote(id, folderId) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.folderId = folderId;
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}


/* ============ 9. HYDRATE ============ */
export async function hydrate() {
  const [notes, folders] = await Promise.all([
    db.getAllNotes(),
    db.getAllFolders(),
  ]);
  // Normalize on load so legacy notes gain deletedAt = null, etc.
  state.notes = (notes || []).map(normalizeNote);
  state.folders = (folders || []).map(normalizeFolder);
  notify();
}


/* ============ 10. EXPORT / IMPORT ============ */
export function toJSON() {
  return {
    app: 'slate',
    version: 1,
    exportedAt: now(),
    notes: state.notes,   // deletedAt travels with each note automatically
    folders: state.folders,
  };
}

export async function importJSON(data, { replace = false } = {}) {
  if (!data || !Array.isArray(data.notes)) {
    throw new Error('That file doesnâ€™t look like a NoteFlow export.');
  }

  const incomingNotes = data.notes.map(normalizeNote);
  const incomingFolders = Array.isArray(data.folders)
    ? data.folders.map(normalizeFolder)
    : [];

  if (replace) {
    await db.clearAll();
    state.notes = incomingNotes;
    state.folders = incomingFolders;
  } else {
    const noteMap = new Map(state.notes.map((n) => [n.id, n]));
    for (const n of incomingNotes) noteMap.set(n.id, n);
    state.notes = Array.from(noteMap.values());

    const folderMap = new Map(state.folders.map((f) => [f.id, f]));
    for (const f of incomingFolders) folderMap.set(f.id, f);
    state.folders = Array.from(folderMap.values());
  }

  notify();
  await db.bulkPutFolders(state.folders);
  await db.bulkPutNotes(state.notes);
}

/*
   normalizeNote / normalizeFolder â€” defensive cleanup so old or
   partial records always have every field with the right type.
   â˜… deletedAt defaults to null (alive) â€” this is the whole reason
   legacy notes and old backups keep working with no migration.
*/
function normalizeNote(raw = {}) {
  const timestamp = now();
  return {
    id: raw.id || uid(),
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(normalizeTag).filter(Boolean) : [],
    folderId: raw.folderId ?? null,
    pinned: Boolean(raw.pinned),
    createdAt: Number(raw.createdAt) || timestamp,
    updatedAt: Number(raw.updatedAt) || timestamp,
    // Accept a real timestamp; anything else (undefined/null/0) = alive.
    deletedAt: Number(raw.deletedAt) > 0 ? Number(raw.deletedAt) : null,
  };
}

function normalizeFolder(raw = {}) {
  return {
    id: raw.id || uid(),
    name: typeof raw.name === 'string' ? raw.name : 'Folder',
    createdAt: Number(raw.createdAt) || now(),
  };
}
