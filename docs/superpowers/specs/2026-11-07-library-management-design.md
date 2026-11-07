# Local library management

Continue phase 5 with nested folders, folder rename/move and document rename/move.
The user chose this priority and delegated subsequent implementation decisions.

## Approach

Extend the existing Library service, Radix menus/modals and workspace state. This is
the only useful approach at this scale: replacing the storage model or introducing
drag-and-drop would add migration and accessibility costs without closing more gaps.
Use explicit destination selectors, including the library root, and nested lists with
expand/collapse controls. Folder operations and document moves organize local metadata;
linked filesystem originals are not renamed or moved. Existing sync scope is unchanged
(direct documents of the configured sync folder, no folder hierarchy sync).

## Acceptance

- Nested folders can be created, navigated, renamed and moved through the UI.
- Documents can be renamed and moved through accessible localized dialogs.
- Reject blank/duplicate sibling names, cycles and missing/deleted destinations in
  storage transactions; failed operations leave existing metadata and text intact.
- Synced documents retain their remote ref when moved and continue syncing regardless
  of their local folder. Moving local documents directly into the configured sync
  folder enrolls them in sync; destination selection communicates both behaviors.
- No schema migration, dependency addition, release publishing or data deletion.
- Test both Memory/IndexedDB and rendered React flows; run typecheck, full tests and
  production build. Record actual Windows verification separately from inherited claims.
