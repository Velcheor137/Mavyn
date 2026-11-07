import { act, cleanup, fireEvent, render as renderDom, screen, waitFor } from '@testing-library/react';
import { createI18n, I18nextProvider } from '@mdr/i18n';
import { render } from '@mdr/markdown-engine';
import type { PlatformAdapter } from '@mdr/platform';
import { Library, MemoryBackend } from '@mdr/storage';
import { FakeServer } from '@mdr/sync-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell, DEFAULT_PREFERENCES, getSession, initSync, initWorkspace, openDocument, resetSyncForTests, resetWorkspaceForTests, ServicesProvider, usePreferences, useSync, useWorkspace, type AppServices } from './index.ts';
import { connectLibrary, signIn, syncNow } from './sync.ts';

const platform: PlatformAdapter = {
  kind: 'web',
  capabilities: { linkFiles: false, fileAssociations: false, print: false },
  pickFiles: async () => [],
  readLinked: async () => {
    throw new Error('no');
  },
  writeLinked: async () => {
    throw new Error('no');
  },
  saveAs: async () => {},
};

describe('sync in the app', () => {
  beforeEach(() => {
    globalThis.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  });
  afterEach(() => {
    cleanup();
    resetSyncForTests();
    resetWorkspaceForTests();
  });

  it('signs in, pulls a library, and resolves a conflict by keeping both versions', async () => {
    const server = new FakeServer();
    const seedId = '0190f0a0-0000-7000-8000-0000000000aa';
    await server.create({ id: seedId, file_name: 'shared.md', content: '# Shared\n\nline\n' }, 'seed-op');

    const library = new Library(new MemoryBackend());
    const i18n = createI18n('en');
    const services: AppServices = {
      library,
      platform,
      i18n,
      renderMarkdown: async (source, options) => render(source, options),
      appVersion: 'test',
      server: { baseUrl: 'https://notes.example', api: server.client(), health: async () => true },
    };
    usePreferences.setState({ ...DEFAULT_PREFERENCES, locale: 'en', autosaveDelayMs: 100 });
    await initWorkspace(services);
    await initSync(services);
    renderDom(
      <I18nextProvider i18n={i18n}>
        <ServicesProvider services={services}>
          <AppShell />
        </ServicesProvider>
      </I18nextProvider>,
    );

    await act(() => signIn('tester', 'a long passphrase'));
    expect(useSync.getState().user?.username).toBe('tester');
    await act(() => connectLibrary({ libraryId: server.libraryId }));
    await act(() => syncNow());
    await waitFor(() => expect(useWorkspace.getState().documents.some((d) => d.id === seedId)).toBe(true));
    expect(useWorkspace.getState().folders.map((f) => f.name)).toContain('Shared');

    // Overlapping edits: locally and on the server.
    await act(() => openDocument(seedId));
    const session = getSession(seedId)!;
    act(() => session.apply([{ from: session.text.indexOf('line'), to: session.text.indexOf('line') + 4, insert: 'mine' }], 'editor'));
    await act(() => session.flush());
    await server.edit(seedId, '# Shared\n\ntheirs\n');
    await act(() => syncNow());

    expect(await screen.findByText('Changed on the server too')).toBeTruthy();
    expect(server.docs.get(seedId)?.content).toBe('# Shared\n\ntheirs\n');
    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));

    await waitFor(() => expect(screen.queryByText('Changed on the server too')).toBeNull());
    expect(getSession(seedId)!.text).toBe('# Shared\n\ntheirs\n');
    const copy = useWorkspace.getState().documents.find((d) => d.fileName === 'shared (my version).md');
    expect(copy).toBeDefined();
    expect((await library.readContent(copy!.id)).text).toBe('# Shared\n\nmine\n');
    expect(useSync.getState().state?.kind).toBe('synced');
  });
});

describe('first run', () => {
  beforeEach(() => {
    globalThis.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  });
  afterEach(() => {
    cleanup();
    resetSyncForTests();
    resetWorkspaceForTests();
  });

  it('asks to create the administrator when the server has no users, then offers a library', async () => {
    const server = new FakeServer();
    server.setupToken = 'one-time-token';
    const library = new Library(new MemoryBackend());
    const i18n = createI18n('en');
    const services: AppServices = {
      library,
      platform,
      i18n,
      renderMarkdown: async (source, options) => render(source, options),
      appVersion: 'test',
      server: { baseUrl: 'https://notes.example', api: server.client(), health: async () => true },
    };
    usePreferences.setState({ ...DEFAULT_PREFERENCES, locale: 'en' });
    await initWorkspace(services);
    await initSync(services);
    renderDom(
      <I18nextProvider i18n={i18n}>
        <ServicesProvider services={services}>
          <AppShell />
        </ServicesProvider>
      </I18nextProvider>,
    );

    // The dialog opens by itself.
    expect(await screen.findByRole('dialog', { name: 'Set up the server' })).toBeTruthy();
    const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fill('Setup token', 'wrong');
    fill('Password', 'a long passphrase');
    fill('Repeat password', 'a different one');
    expect(screen.getByText('The passwords do not match.')).toBeTruthy();
    fill('Repeat password', 'a long passphrase');
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect(await screen.findByText(/setup token is wrong/)).toBeTruthy();

    fill('Setup token', 'one-time-token');
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    expect(await screen.findByText('The administrator account is ready.')).toBeTruthy();
    expect(useSync.getState().user?.username).toBe('admin');
    expect(useSync.getState().needsSetup).toBe(false);
    expect(screen.getByText('Server library to sync')).toBeTruthy();
  });
});
