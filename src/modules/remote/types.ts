export type RemoteConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type RemoteOsType = 'Windows' | 'Linux' | 'macOS' | 'Unknown' | null;
export type RemoteWorkspacePane = 'files' | 'terminal' | 'transfers';

export interface RemoteConnectionRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  osType: RemoteOsType;
  status: RemoteConnectionStatus;
}

export interface RemoteTerminalTab {
  id: string;
  connectionId: string;
  title: string;
  cwd: string;
  lines: string[];
}
