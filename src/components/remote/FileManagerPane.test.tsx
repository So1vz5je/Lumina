/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteWorkspaceProvider, useRemoteWorkspace } from '../../modules/remote/RemoteWorkspaceProvider';
import { FileManagerPane } from './FileManagerPane';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === 'remote_list_directory') {
      return {
        connectionId: 'conn-1',
        path: '/var/www',
        parentPath: '/var',
        osType: 'Linux',
        entries: [
          {
            path: '/var/www/html',
            name: 'html',
            entryType: 'directory',
            size: 0,
            modifiedAt: '2026-06-27T10:00:00Z',
            permissions: 'drwxr-xr-x',
            isHidden: false,
          },
        ],
      };
    }

    throw new Error(`Unexpected command: ${command}`);
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
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

function FileManagerPaneHarness() {
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

  return <FileManagerPane refreshToken={0} />;
}

describe('FileManagerPane', () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it('renders a themeable remote file manager workbench surface', async () => {
    const { container } = render(
      <RemoteWorkspaceProvider>
        <FileManagerPaneHarness />
      </RemoteWorkspaceProvider>,
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote_list_directory', expect.anything()));
    expect(container.querySelector('.remote-file-manager-pane')).toBeInTheDocument();
    expect(container.querySelector('.remote-file-manager-path')).toBeInTheDocument();
    expect(container.querySelector('.remote-file-manager-toolbar')).toBeInTheDocument();
    expect(container.querySelector('.remote-file-manager-table')).toBeInTheDocument();
    expect(screen.getByText('html')).toBeInTheDocument();
  });
});
