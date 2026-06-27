import {
  DeleteOutlined,
  DownloadOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FileOutlined,
  RedoOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Button,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import type {
  RemoteConflictPolicy,
  RemoteDirectorySnapshot,
  RemoteFileEntry,
  RemoteTransferPreparation,
  RemoteTransferStartRequest,
  RemoteTransferTask,
} from '../../modules/remote/fileManagerTypes';
import { useRemoteWorkspace } from '../../modules/remote/RemoteWorkspaceProvider';
import { FileConflictDialog } from './FileConflictDialog';

const { Text } = Typography;

export function FileManagerPane({
  refreshToken,
}: {
  refreshToken: number;
}) {
  const { state, dispatch } = useRemoteWorkspace();
  const [pendingTransfer, setPendingTransfer] = useState<{
    preparation: RemoteTransferPreparation;
    request: Omit<RemoteTransferStartRequest, 'conflictPolicy'>;
  } | null>(null);

  const activeConnection = state.connections.find(
    (connection) => connection.id === state.activeConnectionId,
  );

  useEffect(() => {
    if (!state.activeConnectionId) {
      return;
    }

    void loadDirectory('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeConnectionId]);

  useEffect(() => {
    if (!state.activeConnectionId || !state.remoteFiles.activePath) {
      return;
    }

    void loadDirectory(state.remoteFiles.activePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const loadDirectory = async (path: string) => {
    if (!state.activeConnectionId) {
      return;
    }

    dispatch({ type: 'files/loadingSet', payload: { isLoading: true } });

    try {
      const snapshot = await invoke<RemoteDirectorySnapshot>(
        'remote_list_directory',
        {
          connectionId: state.activeConnectionId,
          path,
        },
      );

      dispatch({ type: 'files/directoryLoaded', payload: snapshot });
    } catch (error) {
      dispatch({
        type: 'files/errorSet',
        payload: { message: String(error) },
      });
      message.error(`Failed to load directory: ${String(error)}`);
    }
  };

  const handleNewFolder = async () => {
    if (!state.activeConnectionId || !state.remoteFiles.activePath) {
      return;
    }

    const folderName = window.prompt('New folder name');
    if (!folderName) {
      return;
    }

    try {
      await invoke('remote_create_directory', {
        connectionId: state.activeConnectionId,
        path: joinRemotePath(
          state.remoteFiles.activePath,
          folderName,
          activeConnection?.osType,
        ),
      });
      message.success('Folder created');
      await loadDirectory(state.remoteFiles.activePath);
    } catch (error) {
      message.error(`Failed to create folder: ${String(error)}`);
    }
  };

  const handleRename = async () => {
    if (
      !state.activeConnectionId ||
      state.remoteFiles.selectedRemotePaths.length !== 1 ||
      !state.remoteFiles.activePath
    ) {
      return;
    }

    const sourcePath = state.remoteFiles.selectedRemotePaths[0];
    const pathSegments = sourcePath.split('/').filter(Boolean);
    const currentName =
      pathSegments[pathSegments.length - 1] ?? sourcePath;
    const nextName = window.prompt('Rename to', currentName);
    if (!nextName) {
      return;
    }

    try {
      await invoke('remote_rename_path', {
        connectionId: state.activeConnectionId,
        sourcePath,
        targetPath: joinRemotePath(
          state.remoteFiles.activePath,
          nextName,
          activeConnection?.osType,
        ),
      });
      message.success('Path renamed');
      await loadDirectory(state.remoteFiles.activePath);
    } catch (error) {
      message.error(`Failed to rename path: ${String(error)}`);
    }
  };

  const handleDelete = async () => {
    if (
      !state.activeConnectionId ||
      state.remoteFiles.selectedRemotePaths.length === 0 ||
      !state.remoteFiles.activePath
    ) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete ${state.remoteFiles.selectedRemotePaths.length} selected path(s)?`,
    );
    if (!shouldDelete) {
      return;
    }

    try {
      await invoke('remote_delete_paths', {
        connectionId: state.activeConnectionId,
        paths: state.remoteFiles.selectedRemotePaths,
        recursive: true,
      });
      dispatch({ type: 'files/selectionSet', payload: { paths: [] } });
      message.success('Selected paths deleted');
      await loadDirectory(state.remoteFiles.activePath);
    } catch (error) {
      message.error(`Failed to delete paths: ${String(error)}`);
    }
  };

  const handleUpload = async (directory: boolean) => {
    if (!state.activeConnectionId || !state.remoteFiles.activePath) {
      return;
    }

    const selected = await open({
      directory,
      multiple: true,
      title: directory ? 'Select folders to upload' : 'Select files to upload',
    });
    const localPaths = normalizeDialogSelection(selected);
    if (localPaths.length === 0) {
      return;
    }

    try {
      const preparation = await invoke<RemoteTransferPreparation>(
        'remote_prepare_upload',
        {
          connectionId: state.activeConnectionId,
          localPaths,
          remoteTargetPath: state.remoteFiles.activePath,
        },
      );

      await handleTransferPreparation(preparation, {
        connectionId: state.activeConnectionId,
        direction: 'upload',
        sourcePaths: localPaths,
        targetPath: state.remoteFiles.activePath,
      });
    } catch (error) {
      message.error(`Failed to prepare upload: ${String(error)}`);
    }
  };

  const handleDownload = async () => {
    if (
      !state.activeConnectionId ||
      state.remoteFiles.selectedRemotePaths.length === 0
    ) {
      return;
    }

    const localTargetPath = await open({
      directory: true,
      multiple: false,
      title: 'Select download destination',
    });
    if (!localTargetPath || Array.isArray(localTargetPath)) {
      return;
    }

    try {
      const preparation = await invoke<RemoteTransferPreparation>(
        'remote_prepare_download',
        {
          connectionId: state.activeConnectionId,
          remotePaths: state.remoteFiles.selectedRemotePaths,
          localTargetPath,
        },
      );

      await handleTransferPreparation(preparation, {
        connectionId: state.activeConnectionId,
        direction: 'download',
        sourcePaths: state.remoteFiles.selectedRemotePaths,
        targetPath: localTargetPath,
      });
    } catch (error) {
      message.error(`Failed to prepare download: ${String(error)}`);
    }
  };

  const handleTransferPreparation = async (
    preparation: RemoteTransferPreparation,
    request: Omit<RemoteTransferStartRequest, 'conflictPolicy'>,
  ) => {
    if (preparation.conflicts.length > 0) {
      setPendingTransfer({ preparation, request });
      return;
    }

    await startTransfer({ ...request, conflictPolicy: 'merge' });
  };

  const startTransfer = async (request: RemoteTransferStartRequest) => {
    try {
      const task = await invoke<RemoteTransferTask>('remote_start_transfer', {
        request,
      });
      dispatch({
        type: 'transfer/taskUpserted',
        payload: { ...task, retryRequest: request },
      });
      dispatch({
        type: 'workspace/paneActivated',
        payload: { pane: 'transfers' },
      });
      message.success('Transfer queued');
    } catch (error) {
      message.error(`Failed to start transfer: ${String(error)}`);
    }
  };

  const handleConflictConfirm = async (policy: RemoteConflictPolicy) => {
    if (!pendingTransfer) {
      return;
    }

    await startTransfer({
      ...pendingTransfer.request,
      conflictPolicy: policy,
    });
    setPendingTransfer(null);
  };

  if (!activeConnection) {
    return (
      <div className="remote-file-manager-pane remote-file-manager-empty">
        <Empty
          description="Connect a host to start browsing files."
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  return (
    <div className="remote-file-manager-pane">
      <div className="remote-file-manager-path">
        <div className="remote-file-manager-path-main">
          <span>Active Path</span>
          <strong>{state.remoteFiles.activePath ?? 'Loading remote root...'}</strong>
        </div>
        <div className="remote-file-manager-breadcrumbs">
          {state.remoteFiles.breadcrumbs.map((breadcrumb) => (
            <Button
              key={breadcrumb.path}
              onClick={() => void loadDirectory(breadcrumb.path)}
              size="small"
              type="text"
            >
              {breadcrumb.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="remote-file-manager-toolbar">
        <Button
          disabled={!state.remoteFiles.activePath}
          icon={<UploadOutlined />}
          onClick={() => void handleUpload(false)}
          type="primary"
        >
          Upload File
        </Button>
        <Button
          disabled={!state.remoteFiles.activePath}
          icon={<UploadOutlined />}
          onClick={() => void handleUpload(true)}
        >
          Upload Folder
        </Button>
        <Button
          disabled={state.remoteFiles.selectedRemotePaths.length === 0}
          icon={<DownloadOutlined />}
          onClick={() => void handleDownload()}
        >
          Download
        </Button>
        <Button
          disabled={!state.remoteFiles.activePath}
          icon={<FolderAddOutlined />}
          onClick={() => void handleNewFolder()}
        >
          New Folder
        </Button>
        <Button
          disabled={state.remoteFiles.selectedRemotePaths.length !== 1}
          onClick={() => void handleRename()}
        >
          Rename
        </Button>
        <Button
          danger
          disabled={state.remoteFiles.selectedRemotePaths.length === 0}
          icon={<DeleteOutlined />}
          onClick={() => void handleDelete()}
        >
          Delete
        </Button>
        <Button
          disabled={!state.remoteFiles.activePath}
          icon={<RedoOutlined />}
          onClick={() => void loadDirectory(state.remoteFiles.activePath ?? '')}
        >
          Refresh
        </Button>
      </div>

      {state.remoteFiles.lastError ? (
        <Tag color="error">{state.remoteFiles.lastError}</Tag>
      ) : null}

      <div className="remote-file-manager-table-shell">
        <Spin spinning={state.remoteFiles.isLoading}>
          <Table<RemoteFileEntry>
            className="remote-file-manager-table"
            columns={columns}
            dataSource={state.remoteFiles.entries}
            locale={{ emptyText: 'No files in this directory' }}
            pagination={false}
            rowKey="path"
            rowSelection={{
              selectedRowKeys: state.remoteFiles.selectedRemotePaths,
              onChange: (keys) =>
                dispatch({
                  type: 'files/selectionSet',
                  payload: { paths: keys.map(String) },
                }),
            }}
            size="small"
            onRow={(entry) => ({
              onDoubleClick: () => {
                if (entry.entryType === 'directory') {
                  void loadDirectory(entry.path);
                }
              },
            })}
          />
        </Spin>
      </div>

      <FileConflictDialog
        onCancel={() => setPendingTransfer(null)}
        onConfirm={(policy) => void handleConflictConfirm(policy)}
        open={Boolean(pendingTransfer)}
        preparation={pendingTransfer?.preparation ?? null}
      />
    </div>
  );
}

const columns: ColumnsType<RemoteFileEntry> = [
  {
    dataIndex: 'name',
    key: 'name',
    title: 'Name',
    render: (_value, entry) => (
      <Space size={8}>
        {entry.entryType === 'directory' ? <FolderOpenOutlined /> : <FileOutlined />}
        <Text>{entry.name}</Text>
      </Space>
    ),
  },
  {
    dataIndex: 'entryType',
    key: 'entryType',
    title: 'Type',
    render: (value: RemoteFileEntry['entryType']) => (
      <Tag>{value}</Tag>
    ),
  },
  {
    dataIndex: 'size',
    key: 'size',
    title: 'Size',
  },
  {
    dataIndex: 'modifiedAt',
    key: 'modifiedAt',
    title: 'Modified',
    render: (value: string | null) => value ?? '-',
  },
];

function normalizeDialogSelection(
  selection: string | string[] | null,
): string[] {
  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
}

function joinRemotePath(
  basePath: string,
  segment: string,
  osType: string | null | undefined,
) {
  const normalizedBase = basePath.replace(/\\/g, '/');
  const normalizedSegment = segment.replace(/\\/g, '/').replace(/^\/+/, '');

  if (normalizedBase === '/') {
    return `/${normalizedSegment}`;
  }

  if (osType === 'Windows' && /^[A-Za-z]:\/?$/.test(normalizedBase)) {
    return `${normalizedBase.replace(/\/$/, '')}/${normalizedSegment}`;
  }

  return `${normalizedBase.replace(/\/$/, '')}/${normalizedSegment}`;
}
