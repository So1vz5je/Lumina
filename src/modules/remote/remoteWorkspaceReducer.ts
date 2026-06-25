import type {
  RemoteBreadcrumb,
  RemoteDirectorySnapshot,
  RemoteTransferStartRequest,
  RemoteTransferTask,
  RemoteTransferTaskRecord,
} from './fileManagerTypes';
import type {
  RemoteConnectionRecord,
  RemoteTerminalTab,
  RemoteWorkspacePane,
} from './types';

export interface RemoteFilesState {
  activePath: string | null;
  entries: RemoteDirectorySnapshot['entries'];
  breadcrumbs: RemoteBreadcrumb[];
  selectedRemotePaths: string[];
  isLoading: boolean;
  lastError: string | null;
}

export interface TransferQueueState {
  tasks: RemoteTransferTaskRecord[];
  activeTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
}

export interface RemoteWorkspaceState {
  activeWorkspacePane: RemoteWorkspacePane;
  connections: RemoteConnectionRecord[];
  activeConnectionId: string | null;
  terminalTabs: RemoteTerminalTab[];
  activeTerminalTabId: string | null;
  remoteFiles: RemoteFilesState;
  transferQueue: TransferQueueState;
}

export type RemoteWorkspaceAction =
  | { type: 'workspace/paneActivated'; payload: { pane: RemoteWorkspacePane } }
  | { type: 'connection/connected'; payload: RemoteConnectionRecord }
  | { type: 'connection/activated'; payload: { connectionId: string } }
  | { type: 'terminal/opened'; payload: RemoteTerminalTab }
  | {
      type: 'terminal/lineAppended';
      payload: { terminalTabId: string; line: string };
    }
  | { type: 'terminal/activated'; payload: { terminalTabId: string } }
  | { type: 'files/loadingSet'; payload: { isLoading: boolean } }
  | { type: 'files/errorSet'; payload: { message: string | null } }
  | { type: 'files/directoryLoaded'; payload: RemoteDirectorySnapshot }
  | { type: 'files/selectionSet'; payload: { paths: string[] } }
  | { type: 'transfer/taskUpserted'; payload: RemoteTransferTaskRecord }
  | {
      type: 'transfer/taskRequestAttached';
      payload: { taskId: string; retryRequest: RemoteTransferStartRequest };
    };

export function createInitialRemoteWorkspaceState(): RemoteWorkspaceState {
  return {
    activeWorkspacePane: 'files',
    connections: [],
    activeConnectionId: null,
    terminalTabs: [],
    activeTerminalTabId: null,
    remoteFiles: createInitialRemoteFilesState(),
    transferQueue: createInitialTransferQueueState(),
  };
}

export function remoteWorkspaceReducer(
  state: RemoteWorkspaceState,
  action: RemoteWorkspaceAction,
): RemoteWorkspaceState {
  switch (action.type) {
    case 'workspace/paneActivated':
      return { ...state, activeWorkspacePane: action.payload.pane };
    case 'connection/connected': {
      const existingIndex = state.connections.findIndex(
        (connection) => connection.id === action.payload.id,
      );
      const nextConnections =
        existingIndex === -1
          ? [...state.connections, action.payload]
          : state.connections.map((connection, index) =>
              index === existingIndex ? action.payload : connection,
            );

      return {
        ...state,
        connections: nextConnections,
        activeConnectionId: action.payload.id,
        remoteFiles: createInitialRemoteFilesState(),
      };
    }
    case 'connection/activated': {
      const hasConnection = state.connections.some(
        (connection) => connection.id === action.payload.connectionId,
      );

      if (!hasConnection) {
        return state;
      }

      return {
        ...state,
        activeConnectionId: action.payload.connectionId,
        remoteFiles: createInitialRemoteFilesState(),
      };
    }
    case 'terminal/opened': {
      const existingIndex = state.terminalTabs.findIndex(
        (terminalTab) => terminalTab.id === action.payload.id,
      );
      const nextTerminalTabs =
        existingIndex === -1
          ? [...state.terminalTabs, action.payload]
          : state.terminalTabs.map((terminalTab, index) =>
              index === existingIndex ? action.payload : terminalTab,
            );

      return {
        ...state,
        terminalTabs: nextTerminalTabs,
        activeTerminalTabId: action.payload.id,
      };
    }
    case 'terminal/lineAppended': {
      const hasTerminalTab = state.terminalTabs.some(
        (terminalTab) => terminalTab.id === action.payload.terminalTabId,
      );

      if (!hasTerminalTab) {
        return state;
      }

      return {
        ...state,
        terminalTabs: state.terminalTabs.map((terminalTab) =>
          terminalTab.id === action.payload.terminalTabId
            ? {
                ...terminalTab,
                lines: [...terminalTab.lines, action.payload.line],
              }
            : terminalTab,
        ),
      };
    }
    case 'terminal/activated': {
      const hasTerminalTab = state.terminalTabs.some(
        (terminalTab) => terminalTab.id === action.payload.terminalTabId,
      );

      if (!hasTerminalTab) {
        return state;
      }

      return { ...state, activeTerminalTabId: action.payload.terminalTabId };
    }
    case 'files/loadingSet':
      return {
        ...state,
        remoteFiles: {
          ...state.remoteFiles,
          isLoading: action.payload.isLoading,
        },
      };
    case 'files/errorSet':
      return {
        ...state,
        remoteFiles: {
          ...state.remoteFiles,
          isLoading: false,
          lastError: action.payload.message,
        },
      };
    case 'files/directoryLoaded':
      return {
        ...state,
        remoteFiles: {
          activePath: action.payload.path,
          entries: action.payload.entries,
          breadcrumbs: buildBreadcrumbs(action.payload.path),
          selectedRemotePaths: [],
          isLoading: false,
          lastError: null,
        },
      };
    case 'files/selectionSet':
      return {
        ...state,
        remoteFiles: {
          ...state.remoteFiles,
          selectedRemotePaths: action.payload.paths,
        },
      };
    case 'transfer/taskUpserted': {
      const nextTasks = upsertTransferTask(
        state.transferQueue.tasks,
        action.payload,
      );

      return {
        ...state,
        transferQueue: buildTransferQueueState(nextTasks),
      };
    }
    case 'transfer/taskRequestAttached': {
      const nextTasks = state.transferQueue.tasks.map((task) =>
        task.id === action.payload.taskId
          ? { ...task, retryRequest: action.payload.retryRequest }
          : task,
      );

      return {
        ...state,
        transferQueue: buildTransferQueueState(nextTasks),
      };
    }
    default:
      return state;
  }
}

function createInitialRemoteFilesState(): RemoteFilesState {
  return {
    activePath: null,
    entries: [],
    breadcrumbs: [],
    selectedRemotePaths: [],
    isLoading: false,
    lastError: null,
  };
}

function createInitialTransferQueueState(): TransferQueueState {
  return {
    tasks: [],
    activeTaskIds: [],
    completedTaskIds: [],
    failedTaskIds: [],
  };
}

function buildBreadcrumbs(path: string): RemoteBreadcrumb[] {
  const normalized = path.replace(/\\/g, '/');

  if (normalized === '/') {
    return [{ label: '/', path: '/' }];
  }

  const windowsDriveMatch = normalized.match(/^[A-Za-z]:\/?/);
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[0].replace(/\/$/, '');
    const rest = normalized.slice(windowsDriveMatch[0].length).split('/').filter(Boolean);
    const breadcrumbs: RemoteBreadcrumb[] = [{ label: drive, path: `${drive}/` }];
    let currentPath = `${drive}/`;

    for (const segment of rest) {
      currentPath = currentPath.endsWith('/')
        ? `${currentPath}${segment}`
        : `${currentPath}/${segment}`;
      breadcrumbs.push({ label: segment, path: currentPath });
    }

    return breadcrumbs;
  }

  const segments = normalized.split('/').filter(Boolean);
  const breadcrumbs: RemoteBreadcrumb[] = [{ label: '/', path: '/' }];
  let currentPath = '';

  for (const segment of segments) {
    currentPath = `${currentPath}/${segment}`;
    breadcrumbs.push({ label: segment, path: currentPath });
  }

  return breadcrumbs;
}

function upsertTransferTask(
  tasks: RemoteTransferTaskRecord[],
  task: RemoteTransferTaskRecord,
): RemoteTransferTaskRecord[] {
  const existingIndex = tasks.findIndex((candidate) => candidate.id === task.id);
  if (existingIndex === -1) {
    return [...tasks, task];
  }

  const existingTask = tasks[existingIndex];
  const nextTask = {
    ...existingTask,
    ...task,
    retryRequest: task.retryRequest ?? existingTask.retryRequest ?? null,
  };

  return tasks.map((candidate, index) =>
    index === existingIndex ? nextTask : candidate,
  );
}

function buildTransferQueueState(
  tasks: RemoteTransferTaskRecord[],
): TransferQueueState {
  return {
    tasks,
    activeTaskIds: tasks
      .filter((task) => task.status === 'queued' || task.status === 'running')
      .map((task) => task.id),
    completedTaskIds: tasks
      .filter((task) => task.status === 'completed' || task.status === 'cancelled')
      .map((task) => task.id),
    failedTaskIds: tasks
      .filter((task) => task.status === 'failed')
      .map((task) => task.id),
  };
}
