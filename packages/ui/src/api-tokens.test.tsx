import { cleanup, fireEvent, render as renderDom, screen, waitFor, within } from '@testing-library/react';
import { createI18n, I18nextProvider } from '@mdr/i18n';
import { render } from '@mdr/markdown-engine';
import type { PlatformAdapter } from '@mdr/platform';
import { Library, MemoryBackend } from '@mdr/storage';
import { FakeServer } from '@mdr/sync-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { resetSyncForTests, ServicesProvider, useSync, type AppServices } from './index.ts';

function platform(kind: PlatformAdapter['kind']): PlatformAdapter {
  return {
    kind,
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
}

function open(server: FakeServer, kind: PlatformAdapter['kind'], isAdmin: boolean) {
  const i18n = createI18n('en');
  const services: AppServices = {
    library: new Library(new MemoryBackend()),
    platform: platform(kind),
    i18n,
    renderMarkdown: async (source, options) => render(source, options),
    appVersion: 'test',
    server: { baseUrl: 'https://notes.example', api: server.client(), health: async () => true },
  };
  useSync.setState({ available: true, user: { id: 'user', username: 'admin', is_admin: isAdmin } });
  renderDom(
    <I18nextProvider i18n={i18n}>
      <ServicesProvider services={services}>
        <SettingsDialog open onOpenChange={() => {}} />
      </ServicesProvider>
    </I18nextProvider>,
  );
}

describe('API keys in settings', () => {
  beforeEach(() => {
    globalThis.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  });
  afterEach(() => {
    cleanup();
    resetSyncForTests();
  });

  it('is shown only to server administrators on the website', () => {
    open(new FakeServer(), 'web', false);
    expect(screen.queryByRole('heading', { name: 'API keys' })).toBeNull();
    cleanup();
    open(new FakeServer(), 'desktop', true);
    expect(screen.queryByRole('heading', { name: 'API keys' })).toBeNull();
    cleanup();
    open(new FakeServer(), 'web', true);
    expect(screen.getByRole('heading', { name: 'API keys' })).toBeTruthy();
  });

  it('creates a key with the chosen scope, shows it once with the MCP command, and revokes it', async () => {
    const server = new FakeServer();
    server.libraries = [...server.libraries, { id: '0190f0a0-0000-7000-8000-0000000000bb', name: 'Work', role: 'editor' }];
    open(server, 'web', true);
    expect(await screen.findByText('No keys yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Claude Code' } });
    fireEvent.click(screen.getByLabelText('All libraries, including new ones'));
    fireEvent.click(screen.getByLabelText('Work'));
    fireEvent.click(screen.getByLabelText('Read and write'));
    fireEvent.click(screen.getByLabelText('Allow deleting documents and folders'));
    fireEvent.change(screen.getByLabelText('Expires'), { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));

    const key = (await screen.findByLabelText('Key')) as HTMLInputElement;
    expect(key.value).toMatch(/^mvn_/);
    expect(server.tokens[0]).toMatchObject({
      name: 'Claude Code',
      access: 'write',
      can_delete: true,
      all_libraries: false,
      library_ids: ['0190f0a0-0000-7000-8000-0000000000bb'],
      expires_at: null,
    });
    const command = screen.getByLabelText('Command for Claude Code (MCP)') as HTMLTextAreaElement;
    expect(command.value).toBe(`claude mcp add --transport http mavyn https://notes.example/mcp --header "Authorization: Bearer ${key.value}"`);

    // After "Done" the key itself is gone; the list shows only its last characters.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Key')).toBeNull();
    const list = screen.getByRole('list', { name: 'API keys' });
    expect(within(list).getByText(`mvn_…${key.value.slice(-4)}`)).toBeTruthy();
    expect(within(list).getByText(/read, write and delete · Work/)).toBeTruthy();
    expect(within(list).getByText(/Never used · No expiry/)).toBeTruthy();

    fireEvent.click(within(list).getByRole('button', { name: 'Revoke key Claude Code' }));
    fireEvent.click(within(list).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(server.tokens).toHaveLength(0));
    expect(await screen.findByText('No keys yet.')).toBeTruthy();
  });
});
