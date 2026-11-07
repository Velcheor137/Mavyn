# Local Library Management Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish local folder navigation and safe rename/move UI.
**Architecture:** Existing Library methods validate inside transactions. Shared dialogs
and a folder hierarchy helper serve Sidebar and DocumentMenu; no storage schema change.
**Tech Stack:** React, TypeScript, Radix, i18next, Vitest, IndexedDB.
**Spec:** docs/superpowers/specs/2026-11-07-library-management-design.md

## Global Constraints

- English/Russian UI strings; no data loss, silent sync detachment or new dependencies.
- Work on the fresh clone's feature branch. Local commits only; no release publishing.

## Review Focus

- Missing/deleted destinations: reject without metadata changes (Task 1).
- Unicode/case-equivalent sibling names: reject consistently (Task 1).
- Descendant/self destinations: no cycles or hanging traversal (Tasks 1–2).
- Synced documents: moves preserve sync identity and explicit scope (Tasks 1–2).
- UI failure: dialog remains open, error localized, input preserved (Task 2).

## Task 1: Storage invariants

Files: packages/storage/src/library.ts, library.test.ts; packages/core/src/errors.ts;
packages/i18n/src/locales/{en,ru}.json.
Interfaces: createFolder(name,parentId), renameFolder(id,name), moveFolder(id,parentId),
updateMeta(id,patch) preserve signatures and enforce valid active destinations.

- [x] Add table-driven tests on both backends: blank/duplicate names on rename,
  duplicate name on move, missing/deleted parents on create/move/document assignment,
  self/descendant moves, and remote document scope protection.
- [x] Run storage tests; observe expected failures before changing implementation.
- [x] Add common transactional folder validation and localized stable error codes.
- [x] Run storage tests, typecheck and full suite; commit the verified task.

## Task 2: Folder tree and management dialogs

Files: new packages/ui/src/components/{FolderTree,LibraryDialogs}.tsx;
Sidebar.tsx, DocumentMenu.tsx, styles.css, app.test.tsx; both locale catalogs.
Interfaces: folder actions receive the current Folder; dialogs invoke existing Library
methods, await success, refresh workspace and close only on success.

- [x] Add rendered tests for create nested → rename → move folder and document;
  exercise duplicate-name failure, collapse/expand and Russian language switching.
- [x] Observe failures, implement shared accessible forms, destination selector and
  recursive folder navigation. Exclude self/descendants from folder destinations.
- [x] Replace prompt-based document rename; add document move menu action.
- [x] Run UI tests, full tests, typecheck, web build; fix regressions and commit.

## Task 3: Documentation and review

- [x] Update both user guides and docs/status.md with behavior and tested limits.
- [x] Review the whole diff, including synchronization boundaries and failure paths.
- [x] Run final checks and leave a local branch with reviewable commits.
