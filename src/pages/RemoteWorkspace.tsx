import {
  DeploymentUnitOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Tabs, Typography, message } from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConnectionSidebar } from '../components/remote/ConnectionSidebar';
import { FileManagerPane } from '../components/remote/FileManagerPane';
import { SessionInspector } from '../components/remote/SessionInspector';
import { TerminalPane } from '../components/remote/TerminalPane';
import { TransferQueuePane } from '../components/remote/TransferQueuePane';
import type {
  RemoteTransferStartRequest,
  RemoteTransferTask,
} from '../modules/remote/fileManagerTypes';
import { useRemoteWorkspace } from '../modules/remote/RemoteWorkspaceProvider';
import {
  loadSavedConnections,
  type SavedConnection,
} from '../modules/remote/savedConnections';
import type { RemoteConnectionRecord } from '../modules/remote/types';

const { Paragraph, Title } = Typography;

function PanelHeading({
  title,
  icon,
  meta,
}: {
  title: string;
  icon: ReactNode;
  meta?: string;
}) {
  return (
    <div className="remote-workspace-panel-heading">
      <div className="remote-workspace-panel-title">
        {icon}
        <span>{title}</span>
      </div>
      {meta ? <span className="remote-workspace-panel-meta">{meta}</span> : null}
    </div>
  );
}

export default function RemoteWorkspace() {
  const { state, dispatch } = useRemoteWorkspace();
  const [savedConnections] = useState(() => loadSavedConnections());
  const [refreshToken, setRefreshToken] = useState(0);
  const activeConnection = useMemo(
    () =>
      state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      ) ?? null,
    [state.activeConnectionId, state.connections],
  );
  const activeSavedConnectionId = useMemo(
    () =>
      activeConnection
        ? savedConnections.find((connection) =>
            matchesSavedConnection(connection, activeConnection),
          )?.id ?? null
        : null,
    [activeConnection, savedConnections],
  );

  useEffect(() => {
    let progressCleanup: (() => void) | undefined;
    let finishedCleanup: (() => void) | undefined;
    let failedCleanup: (() => void) | undefined;
    let cancelled = false;

    const registerListeners = async () => {
      const handleTaskEvent = (task: RemoteTransferTask) => {
        dispatch({ type: 'transfer/taskUpserted', payload: task });

        if (
          task.connectionId === state.activeConnectionId &&
          (task.status === 'completed' ||
            task.status === 'cancelled' ||
            task.status === 'failed')
        ) {
          setRefreshToken((value) => value + 1);
        }
      };

      try {
        progressCleanup = await listen<RemoteTransferTask>(
          'remote://transfer-progress',
          (event) => handleTaskEvent(event.payload),
        );
        finishedCleanup = await listen<RemoteTransferTask>(
          'remote://transfer-finished',
          (event) => handleTaskEvent(event.payload),
        );
        failedCleanup = await listen<RemoteTransferTask>(
          'remote://transfer-failed',
          (event) => handleTaskEvent(event.payload),
        );

        if (cancelled) {
          progressCleanup?.();
          finishedCleanup?.();
          failedCleanup?.();
        }
      } catch {
        progressCleanup = undefined;
        finishedCleanup = undefined;
        failedCleanup = undefined;
      }
    };

    void registerListeners();

    return () => {
      cancelled = true;
      progressCleanup?.();
      finishedCleanup?.();
      failedCleanup?.();
    };
  }, [dispatch, state.activeConnectionId]);

  useEffect(() => {
    if (!state.activeConnectionId) {
      return;
    }

    const loadTasks = async () => {
      try {
        const tasks = await invoke<RemoteTransferTask[]>(
          'remote_list_transfer_tasks',
          {
            connectionId: state.activeConnectionId,
          },
        );

        tasks.forEach((task) =>
          dispatch({ type: 'transfer/taskUpserted', payload: task }),
        );
      } catch {
        // This command may not be ready during early startup.
      }
    };

    void loadTasks();
  }, [dispatch, state.activeConnectionId]);

  const activateSavedConnection = (savedConnectionId: string) => {
    const savedConnection = savedConnections.find(
      (connection) => connection.id === savedConnectionId,
    );

    if (!savedConnection) {
      return;
    }

    const connectedRecord = state.connections.find((connection) =>
      matchesSavedConnection(savedConnection, connection),
    );

    if (connectedRecord) {
      dispatch({
        type: 'connection/activated',
        payload: { connectionId: connectedRecord.id },
      });
    }
  };

  const connectSavedConnection = async (savedConnection: SavedConnection) => {
    const existingConnection = state.connections.find(
      (connection) =>
        connection.status === 'connected' &&
        matchesSavedConnection(savedConnection, connection),
    );

    if (existingConnection) {
      dispatch({
        type: 'connection/activated',
        payload: { connectionId: existingConnection.id },
      });
      return;
    }

    try {
      const record = await invoke<RemoteConnectionRecord>('remote_connect', {
        request: {
          name: savedConnection.name,
          host: savedConnection.host,
          port: savedConnection.port,
          username: savedConnection.username,
          password: savedConnection.password ?? null,
          privateKeyPath: savedConnection.keyPath ?? null,
          passphrase: savedConnection.passphrase ?? null,
        },
      });

      dispatch({ type: 'connection/connected', payload: record });
      message.success(`Connected to ${savedConnection.name}`);
    } catch (error) {
      message.error(
        `Failed to connect to ${savedConnection.name}: ${String(error)}`,
      );
    }
  };

  const handleCancelTransfer = async (taskId: string) => {
    try {
      await invoke('remote_cancel_transfer', { taskId });
      message.success('Transfer cancellation requested');
    } catch (error) {
      message.error(`Failed to cancel transfer: ${String(error)}`);
    }
  };

  const handleRetryTransfer = async (taskId: string) => {
    const task = state.transferQueue.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.retryRequest) {
      return;
    }

    try {
      const nextTask = await invoke<RemoteTransferTask>('remote_start_transfer', {
        request: task.retryRequest as RemoteTransferStartRequest,
      });
      dispatch({
        type: 'transfer/taskUpserted',
        payload: { ...nextTask, retryRequest: task.retryRequest },
      });
      message.success('Transfer retried');
    } catch (error) {
      message.error(`Failed to retry transfer: ${String(error)}`);
    }
  };

  return (
    <section className="remote-workspace-shell">
      <header className="remote-workspace-header">
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Remote Workspace
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 6 }}>
            Shared SSH workspace for files, retained terminals, and transfers.
          </Paragraph>
        </div>
        <div className="remote-workspace-active-host">
          <span>{activeConnection ? activeConnection.name : 'No active host'}</span>
          <strong>
            {activeConnection
              ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}`
              : 'Connect a saved host'}
          </strong>
        </div>
      </header>

      <div className="remote-workspace-grid">
        <aside className="remote-workspace-panel remote-workspace-panel-side">
          <ConnectionSidebar
            activeConnectionId={activeSavedConnectionId}
            connections={savedConnections}
            connectLabel="Connect"
            description="Reconnect saved hosts without leaving the workspace."
            emptyDescription="No saved hosts loaded yet"
            onActivate={activateSavedConnection}
            onConnect={connectSavedConnection}
            title="Saved Hosts"
          />
        </aside>

        <main className="remote-workspace-panel remote-workspace-panel-main">
          <PanelHeading
            icon={<FolderOpenOutlined />}
            meta={state.activeWorkspacePane}
            title="Workspace"
          />
          <Tabs
            activeKey={state.activeWorkspacePane}
            className="remote-workspace-tabs"
            destroyOnHidden={false}
            items={[
              {
                key: 'files',
                label: 'Files',
                children: <FileManagerPane refreshToken={refreshToken} />,
              },
              {
                key: 'terminal',
                label: 'Terminal',
                children: <TerminalPane />,
              },
              {
                key: 'transfers',
                label: 'Transfers',
                children: (
                  <TransferQueuePane
                    onCancel={handleCancelTransfer}
                    onRetry={handleRetryTransfer}
                    tasks={state.transferQueue.tasks}
                  />
                ),
              },
            ]}
            onChange={(pane) =>
              dispatch({
                type: 'workspace/paneActivated',
                payload: {
                  pane: pane as 'files' | 'terminal' | 'transfers',
                },
              })
            }
          />
        </main>

        <aside className="remote-workspace-panel remote-workspace-panel-side">
          <PanelHeading
            icon={<DeploymentUnitOutlined />}
            title="Session Snapshot"
          />
          <SessionInspector />
        </aside>
      </div>
    </section>
  );
}

function matchesSavedConnection(
  savedConnection: SavedConnection,
  connection: RemoteConnectionRecord,
) {
  return (
    savedConnection.host === connection.host &&
    savedConnection.port === connection.port &&
    savedConnection.username === connection.username
  );
}
