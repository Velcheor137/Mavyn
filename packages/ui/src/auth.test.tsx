import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createI18n, I18nextProvider } from '@mdr/i18n';
import { FakeServer } from '@mdr/sync-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, type AuthenticatedUser } from './index.ts';

function renderGate(server: FakeServer, opts: { healthy?: boolean; remembered?: AuthenticatedUser | null } = {}) {
  const onAuthenticated = vi.fn();
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <AuthGate api={server.client()} health={async () => opts.healthy ?? true} remembered={opts.remembered ?? null} onAuthenticated={onAuthenticated} />
    </I18nextProvider>,
  );
  return onAuthenticated;
}

describe('AuthGate', () => {
  afterEach(cleanup);

  it('requires signing in before anything else and rejects a wrong password', async () => {
    const server = new FakeServer();
    server.password = 'correct horse battery';
    const onAuthenticated = renderGate(server);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('New document')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    expect(onAuthenticated).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ username: 'admin' }), false));
  });

  it('opens directly when the session cookie is still valid', async () => {
    const onAuthenticated = renderGate(new FakeServer());
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ id: 'user' }), false));
  });

  it('asks for the first administrator on a new server', async () => {
    const server = new FakeServer();
    server.setupToken = 'token';
    server.password = 'a long passphrase';
    const onAuthenticated = renderGate(server);
    expect(await screen.findByRole('heading', { name: 'Set up the server' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ username: 'admin' }), false));
  });

  it('opens offline only for an account that signed in on this device before', async () => {
    const remembered = { id: 'u1', username: 'me', is_admin: false };
    const offline = renderGate(new FakeServer(), { healthy: false, remembered });
    await waitFor(() => expect(offline).toHaveBeenCalledWith(remembered, true));
    cleanup();

    const stranger = renderGate(new FakeServer(), { healthy: false });
    expect(await screen.findByText(/server is not reachable/)).toBeInTheDocument();
    expect(stranger).not.toHaveBeenCalled();
  });
});
