import { act, cleanup, fireEvent, render as renderDom, screen, waitFor } from '@testing-library/react';
import { createI18n, I18nextProvider } from '@mdr/i18n';
import { render } from '@mdr/markdown-engine';
import type { PlatformAdapter } from '@mdr/platform';
import { Library, MemoryBackend } from '@mdr/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function setup(text: string) {
  const library = new Library(new MemoryBackend());
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

  it('renders untrusted HTML inert and keeps raw-HTML checkboxes non-interactive', async () => {
    await setup('<input type="checkbox"> fake\n\n<img src=x onerror="window.__pwned=1">\n\n- [ ] real\n');
    const real = await screen.findByRole('checkbox', { name: /real/ });
    expect((real as HTMLInputElement).disabled).toBe(false);
    const all = screen.getAllByRole('checkbox');
    expect(all.filter((b) => !(b as HTMLInputElement).disabled)).toHaveLength(1);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
