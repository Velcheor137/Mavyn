# Mavyn — user guide

## Installing

- **Web / PWA:** open the address your administrator gave you (or run it locally, see README).
  In Chromium-based browsers choose *Install app* in the address bar to get a standalone window
  that works offline.
- **Windows / Linux / Android apps:** not released yet.

Your documents are stored **in this browser on this device**. Clearing site data deletes them;
use *Export → Markdown* to keep copies.

## Basics

- **New document** creates a note and opens it in split view.
- **Open file** (Ctrl+O) asks how to add files:
  - *Copy into library* — the app keeps its own copy with version history.
  - *Edit the original file* — saves go back to the file on disk (Chrome/Edge only; the browser asks
    for permission). If another program changed the file, the app does **not** overwrite it and
    offers to load the newer version or save yours as a copy.
- Drag `.md` files onto the window to copy them into the library.

## Organizing the library

Use **New folder** beside Folders to create a root folder. The folder's **…** menu
offers **New subfolder**, **Rename folder** and **Move folder**. Expand/collapse arrows
show nested folders. Names must be unique within the same parent (case-insensitive).
Move dialogs exclude the folder itself and its descendants.

In the document's **More actions** menu, **Rename** edits the library file name and
**Move to folder** chooses a destination, including **Library root**. Text and version
history stay intact. A heading-derived document title does not change when renaming.
Linked files keep their names and locations on disk.

Folder structure stays local. Moving an already synced document does not disconnect
it from its server library. Moving a local document directly into the configured sync
folder uploads it; subfolders are not enrolled automatically. Filename-only renames
are currently local metadata and may be replaced by a subsequent server refresh.

## Reading and editing

- Switch **Read / Source / Split** in the document toolbar (Ctrl+E toggles read/source).
- Click a checkbox in reading mode to tick a task: exactly that `[ ]` changes in the file.
- Edits save automatically (the indicator shows *Saved*, *Saving…*, *Unsaved changes*).
  Ctrl+S saves immediately. Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) works across saves and checkbox clicks.
- Double-click a block in the reader (split view) to jump to its source line.
- **Version history** (clock icon) shows earlier versions with changes; *Restore* creates a new
  version, nothing is lost.

## Supported Markdown

GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks, footnotes, `:emoji:`),
math with `$…$` and `$$…$$`, Mermaid diagrams in ```` ```mermaid ```` blocks, callouts such as
`> [!NOTE]` (and Obsidian-style `> [!tip]- Title` in the Extended dialect), front matter, and safe
HTML. Scripts and other active content in documents are always removed. Images load only over
HTTPS; relative image paths are not available in the web version.

## Shortcuts

| Action | Keys |
|---|---|
| Open file | Ctrl+O |
| Save now | Ctrl+S |
| Search library | Ctrl+K |
| Find in editor | Ctrl+F (in source view) |
| Toggle sidebar | Ctrl+\ |
| Next / previous tab | Ctrl+PageDown / Ctrl+PageUp (Ctrl+Tab in the desktop app) |
| Close tab | Alt+W (Ctrl+W in the desktop app) |
| Focus mode | Ctrl+Shift+F, Esc to leave |
| Bold / italic / link | Ctrl+B / Ctrl+I / Ctrl+K (in editor) |

On macOS use Cmd instead of Ctrl.

## Language and appearance

Settings → *Language* switches between English and Russian instantly. *Appearance* sets light,
dark or system theme and the accent color; *Reading* sets font, size, line height and width.

## Connecting to a server

When you open the web app from a self-hosted server (see the deployment guide), it can sync.

**First start of a new server.** The app opens *Set up the server* by itself. Paste the setup token
(the administrator finds it with `docker compose logs server | grep "setup token"`), enter a name and
a password of at least 10 characters, then choose or create a library. *Later* closes the window;
the same form is under Settings → Server.

**Afterwards:**

1. Settings → **Server** → sign in with the account your administrator created.
2. Choose a server library (or create one) and press **Start syncing**.
3. The library appears as a folder of the same name. Local documents directly in that folder
   are enrolled in sync. Once enrolled, they continue syncing even if moved elsewhere locally.
   Other local documents and nested folder structure stay on this device.

The status next to *Settings* shows Synced, Waiting to sync, Syncing, Offline or Conflict; click it
to sync now. You can keep working offline — changes upload when the connection returns.

If the same document was changed on the server and here in overlapping places, the document shows
a **conflict** banner. Nothing is overwritten. Choose *Keep my version*, *Use server version*
(your text stays in the document history) or *Keep both* (your text moves to a separate document).
*Show server version* displays the differences first.

**Sign out** in the same section. Tick *Remove synced documents from this device* on shared
computers. Documents with changes that were never uploaded are always kept as local documents.
Copies already on a device cannot be deleted remotely.

The Windows/Linux/Android apps and QR-code setup do not support sync yet.
