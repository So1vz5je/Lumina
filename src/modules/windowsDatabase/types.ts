export type WindowsDatabaseEngine = 'mysql' | 'sqlserver' | 'postgresql';

export type WindowsDatabaseAction =
  | 'listDatabases'
  | 'listTables'
  | 'describeTable'
  | 'previewTable'
  | 'runReadonlyQuery';

export interface WindowsDatabaseInstance {
  id: string;
  engine: WindowsDatabaseEngine;
  displayName: string;
  source: string;
  status: string;
  path: string;
  version: string;
  host: string;
  port: number | null;
  credentialMode: 'detected' | 'manual' | 'unavailable';
  credentialLabel: string;
}

export interface WindowsDatabaseTableRef {
  catalog?: string;
  schema?: string;
  name: string;
}

export interface WindowsDatabaseColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  key?: string;
  defaultValue?: string;
  extra?: string;
}

export interface WindowsDatabasePreviewResult {
  columns: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
  truncated: boolean;
}

export interface WindowsDatabaseQueryRequest {
  engine: WindowsDatabaseEngine;
  instanceId: string;
  sql: string;
  rowLimit: number;
}

export type WindowsDatabaseMutationAction = 'insertRow' | 'updateRow' | 'deleteRow';

export interface WindowsDatabaseRowIdentity {
  columns: Array<{
    name: string;
    value: string | number | boolean | null;
  }>;
}

export interface WindowsDatabaseEditableColumn extends WindowsDatabaseColumn {
  required: boolean;
  generated: boolean;
  identity: boolean;
}

export interface WindowsDatabaseMutationRequest {
  engine: WindowsDatabaseEngine;
  action: WindowsDatabaseMutationAction;
  instanceId: string;
  database: string;
  schema?: string;
  table: string;
  values?: Record<string, string | number | boolean | null>;
  rowIdentity?: WindowsDatabaseRowIdentity;
  generatedColumns?: string[];
}

export interface WindowsDatabaseMutationResponse {
  affectedRows: number | null;
  message: string;
}
