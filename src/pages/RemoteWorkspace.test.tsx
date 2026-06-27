/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RemoteWorkspaceProvider } from '../modules/remote/RemoteWorkspaceProvider';
import RemoteWorkspace from './RemoteWorkspace';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === 'remote_list_transfer_tasks') {
      return [];
    }

    throw new Error(`Unexpected command: ${command}`);
  }),
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

describe('RemoteWorkspace', () => {
  it('renders the remote shell with file and transfer workspace panes', () => {
    const { container } = render(
      <RemoteWorkspaceProvider>
        <RemoteWorkspace />
      </RemoteWorkspaceProvider>,
    );

    expect(
      screen.getByRole('heading', { name: 'Remote Workspace' }),
    ).toBeInTheDocument();
    expect(container.querySelector('.remote-workspace-shell')).toBeInTheDocument();
    expect(container.querySelector('.remote-workspace-panel-main')).toBeInTheDocument();
    expect(container.querySelector('.remote-workspace-shell .ant-card')).not.toBeInTheDocument();
    expect(screen.getByText('Saved Hosts')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Transfers' })).toBeInTheDocument();
    expect(
      screen.getByText('Connect a host to start browsing files.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Session Snapshot')).toBeInTheDocument();
  });
});
