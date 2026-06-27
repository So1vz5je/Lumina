/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkspaceProvider, useRemoteWorkspace } from '../../modules/remote/RemoteWorkspaceProvider';
import { TerminalPane } from './TerminalPane';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(
    async (command: string, payload?: Record<string, unknown>) => {
      if (command === 'remote_open_terminal_session') {
        return {
          id: 'term-1',
          connectionId: payload?.connectionId,
          title: payload?.title,
          cwd: '~',
        };
      }

      if (command === 'remote_run_terminal_command') {
        return null;
      }

      throw new Error(`Unexpected command: ${command}`);
    },
  ),
  listenMock: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

function TerminalPaneHarness() {
  const { dispatch } = useRemoteWorkspace();

  useEffect(() => {
    dispatch({
      type: 'connection/connected',
      payload: {
        id: 'conn-1',
        name: 'prod-linux',
        host: '10.0.0.15',
        port: 22,
        username: 'root',
        osType: 'Linux',
        status: 'connected',
      },
    });
  }, [dispatch]);

  return <TerminalPane />;
}

describe('TerminalPane', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    listenMock.mockClear();
  });

  it('adds a new terminal tab for the active connection', async () => {
    render(
      <RemoteWorkspaceProvider>
        <TerminalPaneHarness />
      </RemoteWorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));

    expect(await screen.findByRole('tab', { name: 'term-1' })).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('remote_open_terminal_session', {
      connectionId: 'conn-1',
      title: 'term-1',
    });
  });

  it('reuses the active connection terminal instead of opening a new one repeatedly', async () => {
    render(
      <RemoteWorkspaceProvider>
        <TerminalPaneHarness />
      </RemoteWorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(await screen.findByRole('tab', { name: 'term-1' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));

    expect(invokeMock.mock.calls.filter(([command]) => command === 'remote_open_terminal_session')).toHaveLength(1);
  });

  it('uses a full-height terminal workbench surface', async () => {
    const { container } = render(
      <RemoteWorkspaceProvider>
        <TerminalPaneHarness />
      </RemoteWorkspaceProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));

    expect(container.querySelector('.remote-terminal-pane')).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'term-1' })).toBeInTheDocument();
    expect(container.querySelector('.remote-terminal-output')).toBeInTheDocument();
    expect(container.querySelector('.remote-terminal-stage')).toBeInTheDocument();
  });
});
