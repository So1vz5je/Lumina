import {
  CloudServerOutlined,
  DeploymentUnitOutlined,
  FolderOpenOutlined,
  ThunderboltOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Card, Col, Row, Space, Tabs, Typography, message } from 'antd';
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

function ShellCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      title={
        <Space size={8}>
          {icon}
          <Title level={5} style={{ margin: 0 }}>
            {title}
          </Title>
        </Space>
      }
      style={{ height: '100%', borderRadius: 16 }}
      styles={{ body: { height: '100%' } }}
    >
      {children}
    </Card>
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
    <Space orientation="vertical" size={20} style={{ width: '100%' }}>
      <div>
        <Title level={3} style={{ marginBottom: 8 }}>
          Remote Workspace
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          A dedicated shell for shared connections, multi-session terminals, and
          the remote tooling rebuilt from the LovelyERes product shape.
        </Paragraph>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={7}>
          <ShellCard title="Connections" icon={<CloudServerOutlined />}>
            <ConnectionSidebar
              activeConnectionId={activeSavedConnectionId}
              connections={savedConnections}
              connectLabel="Connect"
              description="Reconnect saved hosts into the shared remote workspace without leaving the shell."
              emptyDescription="No saved hosts loaded yet"
              onActivate={activateSavedConnection}
              onConnect={connectSavedConnection}
              title="Saved Hosts"
            />
          </ShellCard>
        </Col>

        <Col xs={24} xl={10}>
          <ShellCard title="Workspace" icon={<FolderOpenOutlined />}>
            <Tabs
              activeKey={state.activeWorkspacePane}
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
          </ShellCard>
        </Col>

        <Col xs={24} xl={7}>
          <ShellCard title="Session Details" icon={<DeploymentUnitOutlined />}>
            <SessionInspector />
          </ShellCard>
        </Col>
      </Row>
    </Space>
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
