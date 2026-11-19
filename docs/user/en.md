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

- **New document** (Alt+N) creates a Markdown note and opens it in split view.
- **New file…** (Alt+Shift+N) creates an empty text or code file with any name and extension
  (`notes.txt`, `script.py`, `Dockerfile`).
- **Open file** (Ctrl+O) asks how to add files:
  - *Add to Mavyn* — the app keeps its own copy.
  - *Edit the file in place* — saves go back to the file on disk (Chrome/Edge only; the browser asks
    for permission). If another program changed the file, the app does **not** overwrite it and
    offers to load the newer version or save yours as a copy. Text, code, Word, Excel and
    OpenDocument files can be edited in place; PDF is always added as a copy.
- Drag files onto the window to add them to the library: Markdown, any text or code file, Word,
  Excel, OpenDocument and PDF.
- New, opened and dropped files go into the folder (and tag) you are viewing; the heading above
  the document list says where you are. The open folder is remembered for the next start.
- **Download** and **Move to trash** sit in the document toolbar.
  After deleting, the notification offers **Undo**.
- Large documents (thousands of lines) render in the background without freezing the window.

## Organizing the library

Use **New folder** beside Folders to create a root folder. The folder's **…** menu
offers **New subfolder**, **Rename folder** and **Move folder**. Expand/collapse arrows
show nested folders. Names must be unique within the same parent (case-insensitive).
Move dialogs exclude the folder itself and its descendants.

In the document's **More actions** menu, **Rename** edits the library file name and
**Move to folder** chooses a destination, including **Library root**. The text stays intact. A
Markdown document with a heading is listed by its heading, otherwise by its file name; other text
files are listed by their file name. Linked files keep their names and locations on disk.

**Delete folder** in the folder's **…** menu moves the folder, its subfolders and their
documents to Trash after confirmation. The synced folder itself cannot be deleted from the menu.

New documents are named "Untitled", "Untitled 2" and so on, so names in one folder stay distinct.

## Reading and editing

- Switch **Read / Source / Split** in the document toolbar (Ctrl+E toggles read/source).
- Click a checkbox in reading mode to tick a task: exactly that `[ ]` changes in the file.
- Edits save automatically (the indicator shows *Saved*, *Saving…*, *Unsaved changes*).
  Ctrl+S saves immediately. Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) works across saves and checkbox clicks.
- Double-click a block in the reader (split view) to jump to its source line.
- Mavyn keeps only the current text of each document: there is no version history. Undo works while
  the document is open.

## Text and code files

Any text file can be added: plain text, logs, configuration, source code in any language, files
without an extension. They open in the source editor with syntax highlighting chosen by the file
name; there is no reading view. Search covers their content (the first 4 million characters of very
large files). Files up to 256 MB can be edited.

- The encoding is detected on import (UTF-8, UTF-16, Windows-1251, KOI8-R, Shift_JIS and others) and
  the file is written back in the same encoding. **More actions → Encoding** shows it: *Reopen with
  encoding* re-reads the original file if the text looks garbled (linked files, or copies not edited
  yet), *Save with encoding* converts it. A character the encoding cannot store stops the save with a
  message instead of being lost.
- **CSV/TSV** files open as an editable **Table** (switch to **Text** for the raw file). Edits are
  written back as CSV with the same delimiter and line endings; CSV has no formatting or formulas.

## Word, Excel, OpenDocument and PDF documents

Besides text, the library accepts **docx**, **xlsx**, **ods** and **pdf** files — via **Open file**,
drag and drop, or "Open with".

- **Spreadsheets** (xlsx, ods) open in an editor: cell values and formulas (recalculated as you type),
  rows, columns and sheets, fonts, colours, borders, alignment, number formats, merged cells, column
  widths and row heights. Ctrl+C/Ctrl+V copy and paste cells as text.
- **Word documents** open in the exact page view; **Edit** switches to the editor: text, bold/italic
  and other character formatting, the document's paragraph styles, alignment, lists, tables and
  pictures. The editor follows the document's styles and page width but does not show page breaks.
- **PDF** is view-only.
- Edits save automatically a few seconds after you stop typing.
- If a file contains something Mavyn cannot save (charts, pivot tables, macros, embedded objects,
  comments, tracked changes, functions the formula engine does not know), your first edit creates a
  copy next to it — "Name (edited)" — and the original stays untouched. A notice says why.
- **More actions → Restore original** opens the file as it was imported, as a copy.
- Search finds these documents by name only. **Download original** saves the current file.
- The limit is 50 MB per file. Legacy `.doc` and `.xls` are not supported.
- With a server connected the files sync between devices. If the same file was changed on two
  devices, the document shows a conflict: *Open the other version* (read only), *Keep my version*,
  *Use server version* or *Keep both*. Files are never merged.

## Supported Markdown

GitHub Flavored Markdown (tables, task lists, strikethrough, autolinks, footnotes, `:emoji:`),
math with `$…$` and `$$…$$`, Mermaid diagrams in ```` ```mermaid ```` blocks, callouts such as
`> [!NOTE]` (and Obsidian-style `> [!tip]- Title` in the Extended dialect), front matter, and safe
HTML. Scripts and other active content in documents are always removed. Images load only over
HTTPS; relative image paths are not available in the web version.

## Shortcuts

| Action | Keys |
|---|---|
| New document | Alt+N |
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
3. The library appears as a folder of the same name. Everything inside it — subfolders,
   documents, their names and locations — is the same on the server and on every device:
   create, rename, move or delete a folder or document on one device and the others follow.
   Documents outside that folder stay on this device only. If the account has a single server
   library, it is connected automatically.

If the same field (say, a document's name) was changed on two devices at once, the change that
reached the server first stays; different fields (name on one, folder on the other) are both kept.
Identical folders created on two devices while offline are merged. A synced document moved to a
folder outside sync keeps syncing its text but stays in its old place on the other devices.

The status next to *Settings* shows Synced, Waiting to sync, Syncing, Offline or Conflict; click it
to sync now. You can keep working offline — changes upload when the connection returns.

If the same document was changed on the server and here in overlapping places, the document shows
a **conflict** banner. Nothing is overwritten. Choose *Keep my version*, *Use server version*
(your text is discarded — there is no version history) or *Keep both* (your text moves to a separate
document).
*Show server version* displays the differences first.

New documents are created in the folder you are viewing, so a document made inside the synced
folder is uploaded automatically.

**Sign out** in the same section returns to the sign-in page. Tick *Remove synced documents from this device* on shared
computers. Documents with changes that were never uploaded are always kept as local documents.
Copies already on a device cannot be deleted remotely.

In the Windows/Linux/Android apps, enter the server address in Settings → **Server**; the rest
works the same. QR-code setup is not supported yet.


## API keys and connecting Claude (MCP)

A server administrator can create an **API key** for themselves so scripts and AI assistants can work
with the documents on the server. This is only in the web app: Settings → **API keys** → *Create key*.

- **Libraries** — all of them (including future ones) or only the chosen ones. The key cannot see
  the others.
- **Access** — *Read only* or *Read and write*. Deleting documents and folders is a separate checkbox.
- **Expires** — in 30, 90 or 365 days, or never. You can revoke a key at any time; programs using it
  lose access immediately.

The key is shown **once** — copy it right away. It acts as you, so keep it like a password. Next to it
is a ready-made command for Claude Code:

```bash
claude mcp add --transport http mavyn https://your-server/mcp --header "Authorization: Bearer mvn_…"
```

Claude Code then sees your libraries: it searches and reads documents (Word, Excel, OpenDocument and
PDF as text), edits text documents, uploads and replaces whole files, creates and moves folders.
Changes reach your devices on their next sync. The web version of claude.ai cannot connect this way
yet. Your own scripts can use the same key with the HTTP API — see `docs/api.md`.
