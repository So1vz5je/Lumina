import { describe, expect, it } from 'vitest';
import {
  createInitialRemoteWorkspaceState,
  remoteWorkspaceReducer,
} from './remoteWorkspaceReducer';

describe('remoteWorkspaceReducer', () => {
  it('returns the expected initial state', () => {
    expect(createInitialRemoteWorkspaceState()).toEqual({
      activeWorkspacePane: 'files',
      connections: [],
      activeConnectionId: null,
      terminalTabs: [],
      activeTerminalTabId: null,
      remoteFiles: {
        activePath: null,
        entries: [],
        breadcrumbs: [],
        selectedRemotePaths: [],
        isLoading: false,
        lastError: null,
      },
      transferQueue: {
        tasks: [],
        activeTaskIds: [],
        completedTaskIds: [],
        failedTaskIds: [],
      },
    });
  });

  it('stores a connected host and marks it active', () => {
    const state = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
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
      },
    );

    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]).toMatchObject({
      id: 'conn-1',
      host: '10.0.0.15',
    });
    expect(state.activeConnectionId).toBe('conn-1');
  });

  it('activates a known connection', () => {
    const withConnection = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
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
      },
    );

    const activated = remoteWorkspaceReducer(withConnection, {
      type: 'connection/activated',
      payload: { connectionId: 'conn-1' },
    });

    expect(activated.activeConnectionId).toBe('conn-1');
  });

  it('updates an existing connection when the same id reconnects', () => {
    const firstState = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
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
      },
    );

    const updatedState = remoteWorkspaceReducer(firstState, {
      type: 'connection/connected',
      payload: {
        id: 'conn-1',
        name: 'prod-linux-updated',
        host: '10.0.0.99',
        port: 2222,
        username: 'admin',
        osType: 'Linux',
        status: 'connected',
      },
    });

    expect(updatedState.connections).toHaveLength(1);
    expect(updatedState.connections[0]).toMatchObject({
      id: 'conn-1',
      name: 'prod-linux-updated',
      host: '10.0.0.99',
      port: 2222,
      username: 'admin',
    });
  });

  it('ignores activation of unknown connections', () => {
    const withConnection = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
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
      },
    );

    const result = remoteWorkspaceReducer(withConnection, {
      type: 'connection/activated',
      payload: { connectionId: 'missing-connection' },
    });

    expect(result.activeConnectionId).toBe('conn-1');
  });

  it('stores the latest remote directory snapshot', () => {
    const state = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
        type: 'files/directoryLoaded',
        payload: {
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
              modifiedAt: '2026-04-13T09:00:00Z',
              permissions: 'drwxr-xr-x',
              isHidden: false,
            },
          ],
        },
      },
    );

    expect(state.remoteFiles.activePath).toBe('/var/www');
    expect(state.remoteFiles.entries).toHaveLength(1);
    expect(state.remoteFiles.breadcrumbs).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'www', path: '/var/www' },
    ]);
  });

  it('tracks transfer tasks by status buckets', () => {
    const runningState = remoteWorkspaceReducer(
      createInitialRemoteWorkspaceState(),
      {
        type: 'transfer/taskUpserted',
        payload: {
          id: 'task-1',
          connectionId: 'conn-1',
          direction: 'upload',
          sourcePaths: ['C:/logs'],
          targetPath: '/tmp/logs',
          status: 'running',
          totalItems: 4,
          completedItems: 1,
          totalBytes: 4096,
          bytesTransferred: 1024,
          conflictPolicy: 'merge',
          lastError: null,
        },
      },
    );

    const failedState = remoteWorkspaceReducer(runningState, {
      type: 'transfer/taskUpserted',
      payload: {
        ...runningState.transferQueue.tasks[0],
        status: 'failed',
        lastError: 'Permission denied',
      },
    });

    expect(runningState.transferQueue.activeTaskIds).toEqual(['task-1']);
    expect(failedState.transferQueue.failedTaskIds).toEqual(['task-1']);
    expect(failedState.transferQueue.tasks[0]).toMatchObject({
      status: 'failed',
      lastError: 'Permission denied',
    });
  });
});
