import type { RemoteOsType } from './types';

export type RemoteFileEntryType = 'file' | 'directory' | 'symlink';
export type RemoteTransferDirection = 'upload' | 'download';
export type RemoteTransferStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type RemoteConflictPolicy = 'overwrite' | 'merge' | 'skip';

export interface RemoteBreadcrumb {
  label: string;
  path: string;
}

export interface RemoteFileEntry {
  path: string;
  name: string;
  entryType: RemoteFileEntryType;
  size: number;
  modifiedAt: string | null;
  permissions: string | null;
  isHidden: boolean;
}

export interface RemoteDirectorySnapshot {
  connectionId: string;
  path: string;
  parentPath: string | null;
  osType: RemoteOsType;
  entries: RemoteFileEntry[];
}

export interface RemoteTransferConflict {
  path: string;
  reason: string;
}

export interface RemoteTransferTask {
  id: string;
  connectionId: string;
  direction: RemoteTransferDirection;
  sourcePaths: string[];
  targetPath: string;
  status: RemoteTransferStatus;
  totalItems: number;
  completedItems: number;
  totalBytes: number;
  bytesTransferred: number;
  conflictPolicy: RemoteConflictPolicy | null;
  lastError: string | null;
}

export interface RemoteTransferPreparation {
  taskPreview: RemoteTransferTask;
  conflicts: RemoteTransferConflict[];
  warnings: string[];
  estimatedItemCount: number;
}

export interface RemoteTransferStartRequest {
  connectionId: string;
  direction: RemoteTransferDirection;
  sourcePaths: string[];
  targetPath: string;
  conflictPolicy: RemoteConflictPolicy;
}

export interface RemoteTransferTaskRecord extends RemoteTransferTask {
  retryRequest?: RemoteTransferStartRequest | null;
}
