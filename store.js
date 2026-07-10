/* =============================================================
   SLATE — store.js
   -------------------------------------------------------------
   THE SINGLE SOURCE OF TRUTH.

   Everything the UI shows is derived from the `state` object in
   this file. The rules that keep the app sane:

     • Nobody outside this file mutates `state` directly.
       They call actions here (createNote, togglePin, setSearch…).
     • Every action that changes data does TWO things, in order:
         1. update the in-memory `state`   (instant, for the UI)
         2. persist the change via db.js    (durable, on disk)
       Then it notifies subscribers so the UI re-renders.
     • The DB is the durable copy; `state` is the fast working
       copy. On startup we load the DB INTO state once (hydrate).

   This is a mini "flux" pattern: state + actions + a subscribe()
   so ui.js can react. No framework required.

   -------------------------------------------------------------
   DATA SHAPES (so you know exactly what a note/folder looks like)
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
   }

   Folder = {
     id:   string,
     name: string,
     createdAt: number,
   }
   ============================================================= */

import * as db from './db.js';
import { uid, now, normalizeTag, matchesQuery, deriveTitle } from './utils.js';


/* ============ 1. STATE STRUCTURE ============ */
/*
   `state` holds two kinds of things:

     A. DATA loaded from the database:
          notes, folders

     B. UI / VIEW state — what the user is currently looking at:
          filter    → which slice of notes to show
          search    → the current search text
          selectedId → the note open in the editor (or null)

   Keeping view-state HERE (not scattered in the DOM) means the
   whole app can be re-rendered from this one object at any time.
*/
const state = {
  // --- data ---
  notes: [],    // array of Note objects (unsorted; we sort on read)
  folders: [],  // array of Folder objects

  // --- current view ---
  filter: { type: 'all', value: null },
  //   type: 'all'    → every note              (value ignored)
  //   type: 'pinned' → only pinned notes       (value ignored)
  //   type: 'folder' → notes in a folder       (value = folderId)
  //   type: 'tag'    → notes with a tag        (value = tag string)

  search: '',        // current search query text
  selectedId: null,  // id of the note open in the editor
};


/* ============ 2. SUBSCRIBE / NOTIFY ============ */
/*
   A dead-simple pub/sub. ui.js calls subscribe(render) once.
   Every action calls notify() after changing state, which runs
   all listeners. This is how the UI stays in sync automatically:
   change state → notify → UI re-renders from state.
*/
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  // Return an "unsubscribe" function in case it's ever needed.
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}


/* ============ 3. READ HELPERS (derived views) ============ */
/*
   These do NOT change state. They COMPUTE what the UI needs from
   the raw data + current view settings. Keeping derivation here
   (not in ui.js) means the display logic is testable and the UI
   stays "dumb": it just renders whatever these return.
*/

/** The full, unfiltered note array (rarely needed directly). */
export function getAllNotes() {
  return state.notes;
}

/** The note currently open in the editor, or null. */
export function getSelectedNote() {
  return state.notes.find((n) => n.id === state.selectedId) || null;
}

/** The current view settings (filter + search) — handy for the UI title. */
export function getView() {
  return { filter: state.filter, search: state.search, selectedId: state.selectedId };
}

/** All folders (for the sidebar). */
export function getFolders() {
  return state.folders;
}

/*
   getTagCounts() — build the tag cloud data.
   Returns [{ tag, count }] sorted by count (desc), then name.
   Derived fresh each call so it's always accurate. Adding tags
   elsewhere needs NO change here — it just recounts.
*/
export function getTagCounts() {
  const counts = new Map();
  for (const note of state.notes) {
    for (const tag of note.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts, ([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* Count helper for the sidebar "All"/"Pinned"/folder badges. */
export function getCounts() {
  return {
    all: state.notes.length,
    pinned: state.notes.filter((n) => n.pinned).length,
    byFolder: (folderId) => state.notes.filter((n) => n.folderId === folderId).length,
  };
}


/* ============ 4. FILTER + SEARCH + SORT ============ */
/*
   getVisibleNotes() is the heart of the read side. It applies,
   in order:
       1. the active FILTER  (all / pinned / folder / tag)
       2. the SEARCH query   (via matchesQuery from utils.js)
       3. SORTING             (pinned first, then most-recent)

   The UI calls this to know exactly what cards to draw. To add a
   NEW filter type later (say "archived"), you add one `case` in
   step 1 and nothing else in this function changes.
*/
export function getVisibleNotes() {
  const { filter, search } = state;

  // --- 1. FILTER ---
  let list = state.notes.filter((note) => {
    switch (filter.type) {
      case 'pinned':
        return note.pinned;
      case 'folder':
        return note.folderId === filter.value;
      case 'tag':
        return (note.tags || []).includes(filter.value);
      case 'all':
      default:
        return true;
    }
  });

  // --- 2. SEARCH ---
  // matchesQuery handles the empty-query case (returns everything).
  list = list.filter((note) => matchesQuery(note, search));

  // --- 3. SORT: pinned first, then newest updated first ---
  // Copy before sorting so we never mutate state.notes in place.
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pinned to the top
    return b.updatedAt - a.updatedAt;                    // newer first
  });
}


/* ============ 5. VIEW ACTIONS (change what's shown) ============ */
/*
   These change VIEW state only — no database writes, because
   nothing about the notes themselves changed.
*/

/** Switch the active filter, e.g. setFilter('folder', someFolderId). */
export function setFilter(type, value = null) {
  state.filter = { type, value };
  notify();
}

/** Reset to the default "All notes" view and clear search. */
export function clearFilters() {
  state.filter = { type: 'all', value: null };
  state.search = '';
  notify();
}

/** Update the live search text (called on every keystroke by app.js). */
export function setSearch(text) {
  state.search = text;
  notify();
}

/** Open a note in the editor (or pass null to close it). */
export function selectNote(id) {
  state.selectedId = id;
  notify();
}


/* ============ 6. DATA ACTIONS (change notes → also persist) ============ */
/*
   Pattern for EVERY data action:
     1. mutate state (so the UI updates instantly / optimistically)
     2. await db.* to persist
     3. notify() so listeners re-render

   We update state BEFORE awaiting the DB so the UI feels instant.
   If a write ever failed, we'd surface it — for a local single
   device app, IndexedDB failures are rare (mostly quota).
*/

/** Create a brand-new empty note, select it, and persist. Returns it. */
export async function createNote(partial = {}) {
  const timestamp = now();
  const note = {
    id: uid(),
    title: '',
    body: '',
    tags: [],
    // If we're inside a folder view, new notes land in that folder.
    folderId: state.filter.type === 'folder' ? state.filter.value : null,
    pinned: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...partial, // caller can override any of the above
  };

  state.notes.push(note);
  state.selectedId = note.id;
  notify();

  await db.putNote(note);
  return note;
}

/*
   updateNote(id, changes) — patch fields on a note.
   Used by autosave (title/body) and by tag edits. It merges the
   `changes` object over the existing note and bumps updatedAt.
*/
export async function updateNote(id, changes) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return null;

  // Merge changes in place, then refresh the "last edited" time.
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
   deleteNote(id) — remove a note.
   Returns the deleted note so the caller (app.js) can offer an
   "Undo" toast by re-creating it. If the deleted note was open,
   we close the editor.
*/
export async function deleteNote(id) {
  const index = state.notes.findIndex((n) => n.id === id);
  if (index === -1) return null;

  const [removed] = state.notes.splice(index, 1);
  if (state.selectedId === id) state.selectedId = null;

  notify();
  await db.deleteNote(id);
  return removed;
}

/*
   restoreNote(note) — put a previously deleted note back.
   Powers the "Undo" action on the delete toast.
*/
export async function restoreNote(note) {
  state.notes.push(note);
  notify();
  await db.putNote(note);
}


/* ============ 7. TAG ACTIONS ============ */
/*
   Tags live ON each note (note.tags is a string array). There is
   no separate "tags table" — the tag cloud is DERIVED by
   getTagCounts(). That's the beginner-friendly choice: adding or
   removing a tag is just editing an array on one note.
*/

/** Add a tag to a note (normalized, no duplicates). */
export async function addTag(id, rawTag) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;

  const tag = normalizeTag(rawTag);
  if (!tag) return;                       // ignore empty/garbage input
  if (note.tags.includes(tag)) return;    // no duplicates

  note.tags = [...note.tags, tag];
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}

/** Remove a tag from a note. */
export async function removeTag(id, tag) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.tags = note.tags.filter((t) => t !== tag);
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}


/* ============ 8. FOLDER ACTIONS ============ */

/** Create a folder and persist it. Returns it. */
export async function createFolder(name) {
  const folder = { id: uid(), name: name.trim() || 'New folder', createdAt: now() };
  state.folders.push(folder);
  notify();
  await db.putFolder(folder);
  return folder;
}

/** Rename a folder. */
export async function renameFolder(id, name) {
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  folder.name = name.trim() || folder.name;
  notify();
  await db.putFolder(folder);
}

/*
   deleteFolder(id) — remove a folder.
   Notes inside it are NOT deleted; they're moved back to "no
   folder" (folderId = null) so nothing is lost. Each affected
   note is re-saved. If we were viewing that folder, reset to All.
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
  // Persist: delete the folder, and re-save every note we touched.
  await db.deleteFolder(id);
  await db.bulkPutNotes(affected);
}

/** Move a note into a folder (or pass null to remove it from any folder). */
export async function moveNote(id, folderId) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.folderId = folderId;
  note.updatedAt = now();
  notify();
  await db.putNote(note);
}


/* ============ 9. HYDRATE (load DB → state on startup) ============ */
/*
   Called once by app.js when the app boots. It pulls everything
   out of IndexedDB into `state`, then notifies so the UI paints.
   After this, `state` and the DB stay in lock-step because every
   data action writes to both.
*/
export async function hydrate() {
  const [notes, folders] = await Promise.all([
    db.getAllNotes(),
    db.getAllFolders(),
  ]);
  state.notes = notes || [];
  state.folders = folders || [];
  notify();
}


/* ============ 10. EXPORT / IMPORT (backup as JSON) ============ */
/*
   toJSON() serializes everything into one portable object.
   We stamp a version + exportedAt so future imports can migrate
   old backups if the shape ever changes.
*/
export function toJSON() {
  return {
    app: 'slate',
    version: 1,
    exportedAt: now(),
    notes: state.notes,
    folders: state.folders,
  };
}

/*
   importJSON(data, { replace }) — load a backup.
     • replace = true  → wipe existing data first, then load.
     • replace = false → merge: imported items overwrite matching
                          ids, new ids are added.
   We validate lightly and normalize each record so a hand-edited
   or older file can't corrupt the app.
*/
export async function importJSON(data, { replace = false } = {}) {
  // Basic shape check — bail clearly if this isn't our format.
  if (!data || !Array.isArray(data.notes)) {
    throw new Error('That file doesn’t look like a Slate export.');
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
    // Merge by id: build maps so incoming records overwrite dupes.
    const noteMap = new Map(state.notes.map((n) => [n.id, n]));
    for (const n of incomingNotes) noteMap.set(n.id, n);
    state.notes = Array.from(noteMap.values());

    const folderMap = new Map(state.folders.map((f) => [f.id, f]));
    for (const f of incomingFolders) folderMap.set(f.id, f);
    state.folders = Array.from(folderMap.values());
  }

  notify();
  // Persist the whole new set in bulk.
  await db.bulkPutFolders(state.folders);
  await db.bulkPutNotes(state.notes);
}

/*
   normalizeNote / normalizeFolder — defensive cleanup.
   Guarantees every field exists and has the right type, filling
   sensible defaults. This is what makes import robust against
   partial or older files.
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
  };
}

function normalizeFolder(raw = {}) {
  return {
    id: raw.id || uid(),
    name: typeof raw.name === 'string' ? raw.name : 'Folder',
    createdAt: Number(raw.createdAt) || now(),
  };
}
