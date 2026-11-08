import { act, cleanup, fireEvent, render as renderDom, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { refreshLibrary } from './workspace.ts';
import { createI18n, I18nextProvider } from '@mdr/i18n';
import { AppError } from '@mdr/core';
import { render } from '@mdr/markdown-engine';
import type { PlatformAdapter } from '@mdr/platform';
import { Library, MemoryBackend, type LibraryOptions } from '@mdr/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, DEFAULT_PREFERENCES, getSession, initWorkspace, openDocument, resetWorkspaceForTests, ServicesProvider, usePreferences, type AppServices } from './index.ts';

const platform: PlatformAdapter = {
  kind: 'web',
  capabilities: { linkFiles: false, fileAssociations: false, print: false },
  pickFiles: async () => [],
  readLinked: async () => {
    throw new Error('not linked');
  },
  writeLinked: async () => {
    throw new Error('not linked');
  },
  saveAs: async () => {},
};

async function setup(text: string, options: LibraryOptions = {}) {
  const library = new Library(new MemoryBackend(), options);
  const i18n = createI18n('en');
  const services: AppServices = {
    library,
    platform,
    i18n,
    renderMarkdown: async (source, options) => render(source, options),
    appVersion: 'test',
  };
  const meta = await library.createDocument({ text, fileName: 'todo.md' });
  usePreferences.setState({ ...DEFAULT_PREFERENCES, locale: 'en', autosaveDelayMs: 200 });
  await initWorkspace(services);
  renderDom(
    <I18nextProvider i18n={i18n}>
      <ServicesProvider services={services}>
        <AppShell />
      </ServicesProvider>
    </I18nextProvider>,
  );
  await act(() => openDocument(meta.id));
  return { library, id: meta.id, i18n };
}

describe('AppShell', () => {
  beforeEach(() => {
    globalThis.matchMedia ??= ((query: string) =>
      ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  });
  afterEach(() => {
    cleanup();
    resetWorkspaceForTests();
  });

  it('toggles exactly the clicked task in the source, autosaves, and undoes', async () => {
    const source = '# Todo\r\n\r\n- [ ] same\r\n- [ ] same\r\n- [x] done\r\n';
    const { library, id } = await setup(source);

    const boxes = await screen.findAllByRole('checkbox', { name: /same/ });
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]!);

    const expected = source.replace('- [ ] same\r\n- [x] done', '- [x] same\r\n- [x] done');
    expect(getSession(id)!.text).toBe(expected);
    await waitFor(async () => expect((await library.readContent(id)).text).toBe(expected), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());

    // A second click before re-render must still hit the right marker.
    fireEvent.click(screen.getAllByRole('checkbox', { name: /same/ })[0]!);
    expect(getSession(id)!.text).toBe(expected.replace('- [ ] same', '- [x] same'));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(getSession(id)!.text).toBe(source);
    await waitFor(async () => expect((await library.readContent(id)).text).toBe(source), { timeout: 3000 });
  });

  it('switches the interface language at runtime', async () => {
    await setup('# Hi\n');
    expect(screen.getAllByText('New document').length).toBeGreaterThan(0);
    act(() => usePreferences.getState().set({ locale: 'ru' }));
    await waitFor(() => expect(screen.getAllByText('Новый документ').length).toBeGreaterThan(0));
    expect(document.documentElement.lang).toBe('ru');
  });

  it('creates nested folders, collapses them, rejects duplicate rename and moves them', async () => {
    const user = userEvent.setup();
    const { library } = await setup('# Local\n');
    const parent = await library.createFolder('Projects');
    await act(() => refreshLibrary());
    await user.click(screen.getByRole('button', { name: 'Folder actions: Projects' }));
    await user.click(screen.getByRole('menuitem', { name: 'New subfolder' }));
    let dialog = screen.getByRole('dialog', { name: 'New folder' });
    await user.type(within(dialog).getByLabelText('Folder name'), 'Drafts');
    await user.click(within(dialog).getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const child = (await library.listFolders()).find((f) => f.name === 'Drafts')!;
    expect(child.parentId).toBe(parent.id);
    await user.click(screen.getByRole('button', { name: 'Collapse Projects' }));
    expect(screen.queryByRole('button', { name: 'Folder actions: Drafts' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Projects' }));

    await library.createFolder('Taken', parent.id);
    await act(() => refreshLibrary());
    await user.click(screen.getByRole('button', { name: 'Folder actions: Drafts' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename folder' }));
    dialog = screen.getByRole('dialog', { name: 'Rename folder' });
    const input = within(dialog).getByLabelText('Folder name');
    await user.clear(input);
    await user.type(input, 'Taken');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A folder with this name already exists here.');
    expect(input).toHaveValue('Taken');
    await user.clear(input);
    await user.type(input, 'Ready');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Folder actions: Ready' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move folder' }));
    dialog = screen.getByRole('dialog', { name: 'Move folder' });
    expect(within(dialog).queryByRole('option', { name: /Ready/ })).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Destination'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(async () => expect((await library.listFolders()).find((f) => f.id === child.id)?.parentId).toBeNull());
  });

  it('renames and moves a document without changing source or history', async () => {
    const user = userEvent.setup();
    const source = '# Keep\r\n\r\n- [ ] task\r\n';
    const { library, id } = await setup(source);
    const parent = await library.createFolder('Проекты');
    const child = await library.createFolder('Работа', parent.id);
    await act(() => refreshLibrary());
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    let dialog = screen.getByRole('dialog', { name: 'Rename' });
    const input = within(dialog).getByLabelText('File name');
    await user.clear(input);
    await user.type(input, 'заметки.md');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await library.getDocument(id)).fileName).toBe('заметки.md');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to folder' }));
    dialog = screen.getByRole('dialog', { name: 'Move to folder' });
    await user.selectOptions(within(dialog).getByLabelText('Destination'), child.id);
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(async () => expect((await library.getDocument(id)).folderId).toBe(child.id));
    expect((await library.readContent(id)).text).toBe(source);
    expect(await library.listRevisions(id)).toHaveLength(1);
    act(() => usePreferences.getState().set({ locale: 'ru' }));
    expect(await screen.findByRole('button', { name: 'Действия с папкой: Работа' })).toBeTruthy();
  });

  it('updates the move warning when a document becomes synced while its dialog is open', async () => {
    const user = userEvent.setup();
    const { library, id } = await setup('# Local\n');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to folder' }));
    const dialog = screen.getByRole('dialog', { name: 'Move to folder' });
    const hint = 'This document continues syncing with its server library after moving.';
    expect(within(dialog).queryByText(hint)).toBeNull();
    await library.updateMeta(id, { remote: { serverId: 'server', libraryId: 'remote', baseRevisionId: 'r', baseHash: 'h', conflict: null } });
    await act(() => refreshLibrary());
    expect(within(dialog).getByText(hint)).toBeTruthy();
  });

  it('persists history retention but deletes old revisions only after explicit confirmation', async () => {
    const user = userEvent.setup();
    const end = Date.parse('2026-11-07T12:00:00Z');
    let clock = end - 400 * 86_400_000;
    const { library, id } = await setup('# History', { now: () => clock });
    clock = end - 399 * 86_400_000;
    let version = await library.saveContent(id, 'old', (await library.readContent(id)).version);
    clock = end;
    await library.saveContent(id, 'current', version);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    await user.selectOptions(await within(settings).findByRole('combobox', { name: 'History retention' }), 'balanced');
    await waitFor(async () => expect(await library.getHistoryRetention()).toBe('balanced'));
    expect(await library.listRevisions(id)).toHaveLength(3);
    await user.click(within(settings).getByRole('button', { name: 'Clean up history' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete old revisions?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete old revisions' }));
    await waitFor(async () => expect(await library.listRevisions(id)).toHaveLength(2));
    expect((await library.readContent(id)).text).toBe('current');
    expect(await screen.findByText('Removed 1 old revision')).toBeTruthy();
  });

  it('shows cleanup failures inside the confirmation dialog and keeps it open for retry', async () => {
    const user = userEvent.setup();
    const { library } = await setup('# Keep');
    await library.setHistoryRetention('balanced');
    vi.spyOn(library, 'pruneHistory').mockRejectedValueOnce(new AppError('storage.failed'));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    const cleanup = within(settings).getByRole('button', { name: 'Clean up history' });
    await waitFor(() => expect(cleanup).not.toBeDisabled());
    await user.click(cleanup);
    const confirm = screen.getByRole('dialog', { name: 'Delete old revisions?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete old revisions' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('Local storage failed.');
    expect(within(confirm).getByRole('button', { name: 'Delete old revisions' })).not.toBeDisabled();
  });

  it('creates a new document inside the open folder, shows it there and saves typed text', async () => {
    const { library } = await setup('# Existing\n');
    const folder = await library.createFolder('Work');
    await act(() => refreshLibrary());
    fireEvent.click(await screen.findByRole('button', { name: /^Work/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'New document' })[0]!);

    await waitFor(async () => expect((await library.listDocuments()).length).toBe(2));
    const created = (await library.listDocuments()).find((d) => d.title !== 'Existing')!;
    expect(created.folderId).toBe(folder.id);
    // Visible in the folder the user is looking at.
    const list = screen.getAllByRole('list').find((l) => l.classList.contains('doc-list'))!;
    expect(within(list).getByText('Untitled')).toBeInTheDocument();

    const session = getSession(created.id)!;
    act(() => session.apply([{ from: session.text.length, to: session.text.length, insert: 'typed text' }], 'editor'));
    await waitFor(async () => expect((await library.readContent(created.id)).text).toContain('typed text'), { timeout: 3000 });
  });

  it('creates a new document with the open tag or as a favorite', async () => {
    const { library } = await setup('# Tagged\n');
    const first = (await library.listDocuments())[0]!;
    await library.updateMeta(first.id, { tags: ['ideas'] });
    await act(() => refreshLibrary());
    fireEvent.click(await screen.findByRole('button', { name: /^ideas/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'New document' })[0]!);
    await waitFor(async () => expect((await library.listDocuments()).filter((d) => d.tags.includes('ideas'))).toHaveLength(2));
  });

  it('renders untrusted HTML inert and keeps raw-HTML checkboxes non-interactive', async () => {
    await setup('<input type="checkbox"> fake\n\n<img src=x onerror="window.__pwned=1">\n\n- [ ] real\n');
    const real = await screen.findByRole('checkbox', { name: /real/ });
    expect((real as HTMLInputElement).disabled).toBe(false);
    const all = screen.getAllByRole('checkbox');
    expect(all.filter((b) => !(b as HTMLInputElement).disabled)).toHaveLength(1);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
