# NoteFlow — Project Context

> A complete handoff document. If this chat is ever lost, paste this file into a new conversation and you (or any engineer/AI) can continue seamlessly. It describes what the app is, how it's built, every file's job, the data model, conventions, and what's left to do.

---

## 1. What this is

**NoteFlow** is a production-quality, offline-first **note-taking Progressive Web App (PWA)** built with **plain HTML, CSS, and vanilla JavaScript (ES modules)**. No frameworks, no build step. It runs from any static file server.

### Feature set
- Create, edit, delete, **search**, and **pin** notes
- **Folders** (organize notes) and **tags** (free-form labels)
- **Dark mode** (persisted, no flash on load)
- **Auto-save** (debounced, saves as you type)
- **Installable PWA** with full **offline** support
- **Export / Import** all data as JSON (merge or replace)
- Mobile-first responsive UI (Google Keep-style masonry card wall, own visual identity)

### Naming note
The user-facing app name is **NoteFlow** (set in `manifest.webmanifest`). Some **internal identifiers still use the original codename "Slate"** and are safe to leave or rename:
- `localStorage` theme key: `slate:theme`
- IndexedDB database name: `slate` (in `db.js` → `DB_NAME`)
- Export filename prefix: `slate-backup-YYYY-MM-DD.json` (in `app.js` → `handleExport`)
- Cache bucket prefix: `noteflow-v1` (already NoteFlow, in `sw.js`)

If you want everything unified to "NoteFlow", change those three "slate" references. Renaming `DB_NAME` starts a fresh empty database, so migrate/export first if there's real data.

---

## 2. Architecture at a glance

Strict one-directional data flow, mini "flux" pattern, no framework:

```
  DOM event
     │
     ▼
  app.js (controller)  ── translates event → store action
     │
     ▼
  store.js (single source of truth)
     │   1. mutate in-memory state
     │   2. persist via db.js
     │   3. notify() subscribers
     ▼
  ui.js (pure render)  ── redraws DOM from state
     │
     ▼
  screen  ── user acts again → loop repeats
```

### Golden rules (keep these intact)
1. **Only `db.js` touches IndexedDB.** Nothing else references `indexedDB`.
2. **Only `store.js` owns state.** Nobody mutates state from outside; they call store actions.
3. **`ui.js` is pure rendering.** It reads the store and writes DOM. It has **no business logic** and never writes to the store or db. Interactive elements carry `data-action` / `data-id`; app.js interprets them.
4. **`app.js` is glue only.** No state, no rendering. It wires events → store actions.
5. **`utils.js` imports nothing.** It's the bottom of the dependency chain.

### Dependency order (also the build/read order)
`index.html` → `style.css` → `utils.js` → `db.js` → `store.js` → `ui.js` → `app.js` → `manifest.webmanifest` → `sw.js`

---

## 3. Files (9 total) and what each does

| File | Role | Key points |
|---|---|---|
| **index.html** | Static app shell | Semantic structure only. Dynamic regions are `data-mount="..."` hooks; interactive elements use `data-action="..."`. Inline `<head>` script sets theme before paint (kills flash) — the one allowed inline JS. Loads `app.js` as a module. |
| **style.css** | All styling | OKLCH color tokens in `:root`; dark mode via `[data-theme="dark"]` overriding the same vars. 4pt spacing scale. Masonry card wall via CSS `columns` (no JS). Mobile-first; sidebar is an off-canvas drawer, becomes a permanent rail at ≥900px. `prefers-reduced-motion` honored. |
| **utils.js** | Pure helpers | `uid`, `now`, `debounce` (powers autosave/search), `formatDate` (relative), `excerpt`, `deriveTitle`, `normalizeTag`, `matchesQuery` (multi-word AND search), DOM helpers `$`, `$$`, `mount`, `el` (XSS-safe builder — uses textContent), `clear`, `download`, `readFileAsText`. Imports nothing. |
| **db.js** | IndexedDB layer (ONLY) | DB name `slate`, version `1`. Two object stores: `notes`, `folders` (both keyed by `id`). Indexes on notes: `by_updated`, `by_folder`, `by_pinned`. Promise-wrapped CRUD, `bulkPut*`, `clearAll`. Schema changes: bump `DB_VERSION`, add an `if (oldVersion < N)` block in `runUpgrade` — never edit an old block. |
| **store.js** | Single source of truth | Holds `state` (notes, folders, filter, search, selectedId). `subscribe/notify` pub-sub. `getVisibleNotes()` = filter → search → sort (pinned first, then newest). Actions: create/update/delete/restore note, togglePin, add/removeTag, folder CRUD, moveNote, hydrate, toJSON/importJSON. Every data action: mutate state → await db → notify. |
| **ui.js** | Pure render | Subscribes via `render(state)`. Renders sidebar, list header, note cards (staggered `--i` entrance), editor, tag chips, toasts. Caret guard: only sets input.value when changed (smooth typing). Exports `setSaveStatus`, `toast`, `openSidebar/closeSidebar/toggleSidebar`, `updateThemeIcon`. Uses Lucide icons, re-runs `refreshIcons()` after each render. |
| **app.js** | Controller (glue) | `boot()`: ensure Lucide → subscribe ui.render → hydrate → wire events → register SW. ONE delegated click listener routes `data-action` via switch. Autosave = `debounce(save, 600)`. Search debounced 120ms. Keyboard: Cmd/Ctrl+K search, Cmd/Ctrl+N new, Esc close. Import/export plumbing. Undo via toast + `store.restoreNote`. |
| **manifest.webmanifest** | Installability | name/short_name **NoteFlow**, `display: standalone`, relative `start_url`/`scope` (`.`), theme+bg `#f7f6f9`, icon placeholders in `icons/` (192/512 + maskable), a "New note" shortcut. |
| **sw.js** | Service worker (offline) | Cache `noteflow-v1`. `install` pre-caches app shell (atomic `addAll`) + `skipWaiting`. `activate` deletes old caches + `clients.claim`. `fetch`: navigations = network-first (fallback to cached index.html); assets = cache-first. Bump `CACHE_VERSION` on any shell change. |

---

## 4. Data model

```js
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
```

- **Timestamps are numbers** (ms), sorted/compared as numbers, formatted for humans only at display time.
- **Tags have no separate table.** They live on each note; the tag cloud is *derived* by `store.getTagCounts()`.
- **Deleting a folder is non-destructive:** its notes get `folderId = null`, never deleted.

### Export/Import JSON shape
```json
{
  "app": "slate",
  "version": 1,
  "exportedAt": 1720598040000,
  "notes": [ /* Note[] */ ],
  "folders": [ /* Folder[] */ ]
}
```
Import validates lightly and runs every record through `normalizeNote`/`normalizeFolder` so old/partial files can't corrupt state. Merge (by id) or replace (wipes first).

---

## 5. Conventions & decisions (the "why")

- **No framework, no build:** ES modules loaded directly; run from any static server.
- **`data-action` + one delegated listener:** ui.js creates/destroys elements constantly; delegation means zero re-binding.
- **Debounced autosave (600ms):** turns keystroke bursts into a single write; status flips to "Saving…" instantly for feedback.
- **Caret guard in the editor:** never reassign an input's `.value` unless it changed, or the cursor jumps mid-typing.
- **OKLCH + token-driven theming:** dark mode is a variable override, not an inversion; depth via lighter surfaces, not shadows.
- **Body is a `<textarea>`** (plain text), chosen for reliability and zero XSS surface. Rich text would be a separate, larger effort.
- **Native `prompt`/`confirm`** used for new-folder, move-to-folder, and import choice. Functional but blocking/ugly — first candidate for a polish pass (replace with a custom modal/popover; store actions stay unchanged).

---

## 6. How to run

1. Put all 9 files in one folder (flat, no subfolders except `icons/`).
2. Serve over **HTTP(S)**, not `file://` (service workers and modules require a server). E.g. `npx serve` or VS Code Live Server.
3. Open in a browser. Create notes; they persist in IndexedDB.
4. To install: look for the browser's install icon (needs the manifest + a registered SW, both present).
5. Offline: after the first load, disconnect — the app shell loads from cache and notes come from IndexedDB.

### Icons still needed
Add real PNGs to an `icons/` folder at these paths (referenced by the manifest):
`icon-192.png`, `icon-512.png`, `icon-maskable-192.png`, `icon-maskable-512.png`. Keep key art within the center ~80% for maskable versions.

---

## 7. Backlog / next steps (nice-to-haves, not built yet)

- [ ] Real app icons (replace placeholders) + optional favicon.
- [ ] Replace `prompt`/`confirm` with a styled modal/popover (native `<dialog>` recommended).
- [ ] Rich-text or Markdown body (currently plain text).
- [ ] Note archiving / trash with retention (delete is immediate + Undo toast today).
- [ ] Multi-tag filtering (currently one tag at a time).
- [ ] Reorder notes / manual sort.
- [ ] "Update available" UI prompt using the existing `SKIP_WAITING` message hook in `sw.js`.
- [ ] Read `?new=1` (from the manifest shortcut) on boot to auto-open a fresh note.
- [ ] Unify "slate" internal identifiers to "NoteFlow" (see §1) if desired.
- [ ] Optional: keyed/diffed rendering if note counts ever reach the thousands (full redraw is fine for normal use).

---

## 8. Status

**All 9 files complete and mutually consistent.** The app is functional end-to-end: create/edit/delete/search/pin, folders, tags, dark mode, autosave, export/import, installable, offline. Remaining items in §7 are enhancements, not blockers. Only hard requirement before "install" works in production is adding the real icon PNGs.
