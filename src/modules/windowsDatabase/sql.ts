import type { WindowsDatabaseEngine, WindowsDatabaseInstance } from './types';

const READONLY_QUERY_HINTS: Record<WindowsDatabaseEngine, string> = {
  mysql: 'Readonly queries only: only SELECT / SHOW / DESCRIBE / EXPLAIN.',
  sqlserver:
    'Readonly queries only: only SELECT / EXEC sp_help / EXEC sp_columns / EXEC sp_tables.',
  postgresql: 'Readonly queries only: only SELECT / WITH / EXPLAIN.',
};

export function getReadonlyQueryHint(engine: WindowsDatabaseEngine): string {
  return READONLY_QUERY_HINTS[engine];
}

export function getWindowsDatabaseDisplayName(instance: WindowsDatabaseInstance): string {
  return instance.port == null
    ? instance.displayName
    : `${instance.displayName}:${instance.port}`;
}
