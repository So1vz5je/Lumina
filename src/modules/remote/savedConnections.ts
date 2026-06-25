export type SavedConnectionAuthType = 'password' | 'key';

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SavedConnectionAuthType;
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

const STORAGE_KEY = 'emergency_ssh_connections';

export function loadSavedConnections(): SavedConnection[] {
  const rawConnections = localStorage.getItem(STORAGE_KEY);

  if (!rawConnections) {
    return [];
  }

  try {
    const parsedConnections = JSON.parse(rawConnections);
    return Array.isArray(parsedConnections) ? parsedConnections : [];
  } catch {
    return [];
  }
}

export function saveSavedConnections(connections: SavedConnection[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}
