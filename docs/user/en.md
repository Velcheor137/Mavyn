# Mavyn — user guide

## Installing

- **Web / PWA:** open the address your administrator gave you (or run it locally, see README).
  In Chromium-based browsers choose *Install app* in the address bar to get a standalone window
  that works offline.
- **Windows / Linux / Android apps:** not released yet.

In the web version, documents are stored **in this browser on this device**. Clearing site data deletes them;
use *Export → Markdown* to keep copies.

Native development builds store the library in `library.sqlite3` in the application's data
directory. Close the previous app version before upgrading. First startup copies the previous webview library into SQLite and keeps the original
IndexedDB database as a backup. Failed imports do not replace existing data. For a native database
backup, close every app window/process before copying the complete app data directory, including
any SQLite `-wal`/`-shm` files; do not copy only the database file while the app is running.

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

## Keeping history

Settings → **Version history** → **History retention** defaults to **Keep all revisions**.
The balanced policy keeps every revision from the last 30 days and then the latest per UTC day
for a year. Initial/current versions and the history of documents in Trash stay protected.
Selecting a policy does not delete anything. **Clean up history** asks for confirmation before
permanently removing old revisions; current document text remains unchanged.

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

**Signing in.** The web app served by a server always starts with a sign-in page; nothing is shown
before you sign in. On a brand-new server the page asks to set up the server instead: paste the
setup token (the administrator finds it with `docker compose logs server | grep "setup token"`),
enter a name and a password of at least 10 characters. Each account has its own local library in
the browser. A device you signed in on before also opens while the server is unreachable.

**Afterwards:**

1. Settings → **Server** shows the signed-in account.
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

New documents are created in the folder you are viewing, so a document made inside the synced
folder is uploaded automatically.

**Sign out** in the same section returns to the sign-in page. Tick *Remove synced documents from this device* on shared
computers. Documents with changes that were never uploaded are always kept as local documents.
Copies already on a device cannot be deleted remotely.

The Windows/Linux/Android apps and QR-code setup do not support sync yet.
