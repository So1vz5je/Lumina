import { Alert, Button, Empty, Input, InputNumber, Popconfirm, Space, Spin, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  buildChangedWindowsDatabaseValues,
  buildWindowsDatabaseRowIdentity,
  getWindowsDatabaseEditableColumns,
} from '../../modules/windowsDatabase/mutation';
import { getReadonlyQueryHint } from '../../modules/windowsDatabase/sql';
import type {
  WindowsDatabaseColumn,
  WindowsDatabaseEngine,
  WindowsDatabaseInstance,
  WindowsDatabaseMutationRequest,
  WindowsDatabaseMutationResponse,
  WindowsDatabasePreviewResult,
  WindowsDatabaseTableRef,
} from '../../modules/windowsDatabase/types';
import WindowsDatabaseRowEditor from './WindowsDatabaseRowEditor';

const { Text, Title } = Typography;
const { TextArea } = Input;

const NAV_WIDTH = 280;
const TABLE_SCROLL_HEIGHT = 280;
const DEFAULT_READONLY_ROW_LIMIT = 50;
const MAX_READONLY_ROW_LIMIT = 100;
const EMPTY_QUERY_ERROR = '请输入只读 SQL';
const READONLY_QUERY_ERROR = '只允许只读查询，禁止 INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE 等写入语句';
const MUTATION_GENERIC_ERROR = '写入失败，未修改数据';
const MUTATION_MISSING_IDENTITY_ERROR = '当前表缺少主键或唯一键，不能编辑或删除行';

const ENGINE_LABELS: Record<WindowsDatabaseEngine, string> = {
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  postgresql: 'PostgreSQL',
};

const CREDENTIAL_MODE_LABELS: Record<WindowsDatabaseInstance['credentialMode'], string> = {
  detected: '检测凭据',
  manual: '手动凭据',
  unavailable: '凭据不可用',
};

const READONLY_ALLOWED_PREFIXES: Record<WindowsDatabaseEngine, readonly string[]> = {
  mysql: ['select', 'show', 'describe', 'desc', 'explain'],
  sqlserver: ['select', 'with', 'exec sp_help', 'exec sp_columns', 'exec sp_tables'],
  postgresql: ['select', 'with', 'explain'],
};

const READONLY_DENIED_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'replace',
  'merge',
  'grant',
  'revoke',
] as const;

interface WindowsDatabaseWorkbenchProps {
  instance: WindowsDatabaseInstance;
  onRequest: (request: {
    action: 'listDatabases' | 'listTables' | 'describeTable' | 'previewTable' | 'runReadonlyQuery';
    instanceId: string;
    engine: WindowsDatabaseEngine;
    database?: string;
    schema?: string;
    table?: string;
    sql?: string;
    rowLimit?: number;
  }) => Promise<any>;
  onMutation?: (request: WindowsDatabaseMutationRequest) => Promise<WindowsDatabaseMutationResponse>;
}

interface QueryResultTable {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

function normalizeTables(input: unknown): WindowsDatabaseTableRef[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) {
      return [{ name: item.trim() }];
    }

    if (item && typeof item === 'object' && typeof (item as WindowsDatabaseTableRef).name === 'string') {
      const table = item as WindowsDatabaseTableRef;
      return [
        {
          catalog: table.catalog,
          schema: table.schema,
          name: table.name,
        },
      ];
    }

    return [];
  });
}

function normalizeColumns(input: unknown): WindowsDatabaseColumn[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof (item as WindowsDatabaseColumn).name !== 'string') {
      return [];
    }

    const column = item as WindowsDatabaseColumn;
    return [
      {
        name: column.name,
        dataType: column.dataType ?? '',
        nullable: Boolean(column.nullable),
        key: column.key,
        defaultValue: column.defaultValue,
        extra: column.extra,
      },
    ];
  });
}

function normalizeResult(input: unknown): QueryResultTable | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as {
    rows?: unknown;
    columns?: unknown;
    rowCount?: unknown;
    truncated?: unknown;
  };

  const rows = Array.isArray(candidate.rows)
    ? candidate.rows.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
  const columnsFromPayload = Array.isArray(candidate.columns)
    ? candidate.columns.filter((value): value is string => typeof value === 'string')
    : [];
  const columns =
    columnsFromPayload.length > 0
      ? columnsFromPayload
      : rows.length > 0
        ? Object.keys(rows[0])
        : [];

  return {
    columns,
    rows,
    rowCount: typeof candidate.rowCount === 'number' ? candidate.rowCount : rows.length,
    truncated: Boolean(candidate.truncated),
  };
}

function clampReadonlyRowLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_READONLY_ROW_LIMIT;
  }

  return Math.min(MAX_READONLY_ROW_LIMIT, Math.max(1, Math.trunc(value)));
}

function startsWithSqlPrefix(sql: string, prefix: string): boolean {
  if (sql === prefix) {
    return true;
  }

  if (!sql.startsWith(prefix)) {
    return false;
  }

  const nextCharacter = sql.charAt(prefix.length);
  return nextCharacter === '' || /\s|\(|\[|"|'|`/.test(nextCharacter);
}

function containsDeniedSqlKeyword(sql: string): boolean {
  const tokens = sql.split(/[^a-z0-9_]+/).filter(Boolean);
  return tokens.some((token) => READONLY_DENIED_KEYWORDS.includes(token as typeof READONLY_DENIED_KEYWORDS[number]));
}

function validateReadonlySql(engine: WindowsDatabaseEngine, value: string): string | null {
  const singleStatement = value.trim().replace(/;\s*$/, '').trim();

  if (!singleStatement) {
    return EMPTY_QUERY_ERROR;
  }

  if (singleStatement.includes(';')) {
    return READONLY_QUERY_ERROR;
  }

  const normalized = singleStatement.toLowerCase().replace(/\s+/g, ' ');
  const hasAllowedPrefix = READONLY_ALLOWED_PREFIXES[engine].some((prefix) =>
    startsWithSqlPrefix(normalized, prefix),
  );

  if (!hasAllowedPrefix || containsDeniedSqlKeyword(normalized)) {
    return READONLY_QUERY_ERROR;
  }

  if (
    (normalized.startsWith('select') && containsDeniedSqlKeyword(` ${normalized.replace(/\binto\b/g, ' update ')} `)) ||
    /\binto\s+(outfile|dumpfile)\b/.test(normalized) ||
    /\bcopy\b[\s\S]*\bto\b/.test(normalized) ||
    /\bto\s+program\b/.test(normalized)
  ) {
    return READONLY_QUERY_ERROR;
  }

  return null;
}

function buildSampleSql(
  engine: WindowsDatabaseEngine,
  database: string | null,
  table: WindowsDatabaseTableRef | null,
  rowLimit: number,
): string {
  if (!database || !table) {
    if (engine === 'sqlserver') {
      return `SELECT TOP (${DEFAULT_READONLY_ROW_LIMIT}) name FROM sys.databases ORDER BY name;`;
    }

    return 'SELECT 1;';
  }

  const schema = table.schema ?? 'dbo';

  if (engine === 'sqlserver') {
    return `SELECT TOP (${rowLimit}) * FROM [${database}].[${schema}].[${table.name}];`;
  }

  if (engine === 'postgresql') {
    return `SELECT * FROM "${schema}"."${table.name}" LIMIT ${rowLimit};`;
  }

  return `SELECT * FROM \`${database}\`.\`${table.name}\` LIMIT ${rowLimit};`;
}

function renderListState(loading: boolean, error: string | null, emptyText: string) {
  if (loading) {
    return (
      <div style={styles.centerState}>
        <Spin size="small" />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" title={error} showIcon style={{ margin: 12 }} />;
  }

  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} style={{ marginBlock: 24 }} />;
}

export function WindowsDatabaseWorkbench({
  instance,
  onRequest,
  onMutation,
}: WindowsDatabaseWorkbenchProps) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<WindowsDatabaseTableRef[]>([]);
  const [columns, setColumns] = useState<WindowsDatabaseColumn[]>([]);
  const [previewResult, setPreviewResult] = useState<QueryResultTable | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResultTable | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<WindowsDatabaseTableRef | null>(null);
  const [activeTab, setActiveTab] = useState('structure');
  const [sql, setSql] = useState(() => buildSampleSql(instance.engine, null, null, DEFAULT_READONLY_ROW_LIMIT));
  const [rowLimit, setRowLimit] = useState(DEFAULT_READONLY_ROW_LIMIT);
  const [editMode, setEditMode] = useState(false);
  const [rowEditorOpen, setRowEditorOpen] = useState(false);
  const [rowEditorMode, setRowEditorMode] = useState<'insert' | 'update'>('insert');
  const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationSuccess, setMutationSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadDatabases = async () => {
      setDatabaseLoading(true);
      setDatabaseError(null);
      setDatabases([]);
      setTables([]);
      setColumns([]);
      setPreviewResult(null);
      setQueryResult(null);
      setSelectedDatabase(null);
      setSelectedTable(null);
      setEditMode(false);
      setRowEditorOpen(false);
      setEditingRow(null);
      setMutationError(null);
      setMutationSuccess(null);
      setSql(buildSampleSql(instance.engine, null, null, DEFAULT_READONLY_ROW_LIMIT));

      try {
        const response = (await onRequest({
          action: 'listDatabases',
          instanceId: instance.id,
          engine: instance.engine,
        })) as { databases?: unknown };

        if (cancelled) {
          return;
        }

        const nextDatabases = Array.isArray(response?.databases)
          ? response.databases.filter((value): value is string => typeof value === 'string')
          : [];
        setDatabases(nextDatabases);
      } catch (error) {
        if (!cancelled) {
          setDatabaseError(error instanceof Error ? error.message : '加载数据库列表失败');
        }
      } finally {
        if (!cancelled) {
          setDatabaseLoading(false);
        }
      }
    };

    void loadDatabases();

    return () => {
      cancelled = true;
    };
  }, [instance.engine, instance.id, onRequest]);

  const previewColumns = useMemo(
    () =>
      (previewResult?.columns ?? []).map((column) => ({
        title: column,
        dataIndex: column,
        key: column,
        ellipsis: true,
      })),
    [previewResult],
  );

  const previewRows = useMemo(
    () =>
      (previewResult?.rows ?? []).map((row, index) => ({
        ...row,
        __workbenchRowKey: `${selectedTable?.name ?? 'preview'}-${index}`,
      })),
    [previewResult?.rows, selectedTable?.name],
  );

  const queryColumns = useMemo(
    () =>
      (queryResult?.columns ?? []).map((column) => ({
        title: column,
        dataIndex: column,
        key: column,
        ellipsis: true,
      })),
    [queryResult],
  );

  const queryRows = useMemo(
    () =>
      (queryResult?.rows ?? []).map((row, index) => ({
        ...row,
        __workbenchRowKey: `query-${index}`,
      })),
    [queryResult?.rows],
  );

  const editableColumns = useMemo(() => getWindowsDatabaseEditableColumns(columns), [columns]);

  const generatedColumnNames = useMemo(
    () =>
      columns
        .filter((column) => {
          const metadata = `${column.extra ?? ''} ${column.defaultValue ?? ''}`.toLowerCase();
          return metadata.includes('generated') || metadata.includes('auto_increment') || metadata.includes('identity');
        })
        .map((column) => column.name),
    [columns],
  );

  const openInsertEditor = () => {
    setRowEditorMode('insert');
    setEditingRow(null);
    setMutationError(null);
    setMutationSuccess(null);
    setRowEditorOpen(true);
  };

  const openUpdateEditor = (row: Record<string, unknown>) => {
    setRowEditorMode('update');
    setEditingRow(row);
    setMutationError(null);
    setMutationSuccess(null);
    setRowEditorOpen(true);
  };

  const handleDatabaseSelect = async (database: string) => {
    setSelectedDatabase(database);
    setSelectedTable(null);
    setTables([]);
    setColumns([]);
    setPreviewResult(null);
    setEditMode(false);
    setRowEditorOpen(false);
    setEditingRow(null);
    setMutationError(null);
    setMutationSuccess(null);
    setTableError(null);
    setDetailError(null);
    setSql(buildSampleSql(instance.engine, database, null, rowLimit));
    setTableLoading(true);

    try {
      const response = (await onRequest({
        action: 'listTables',
        instanceId: instance.id,
        engine: instance.engine,
        database,
      })) as { tables?: unknown };

      setTables(normalizeTables(response?.tables));
    } catch (error) {
      setTableError(error instanceof Error ? error.message : '加载表列表失败');
    } finally {
      setTableLoading(false);
    }
  };

  const loadSelectedTableDetails = async (table: WindowsDatabaseTableRef, database: string) => {
    const [columnResponse, previewResponse] = await Promise.all([
      onRequest({
        action: 'describeTable',
        instanceId: instance.id,
        engine: instance.engine,
        database,
        schema: table.schema,
        table: table.name,
      }),
      onRequest({
        action: 'previewTable',
        instanceId: instance.id,
        engine: instance.engine,
        database,
        schema: table.schema,
        table: table.name,
        rowLimit,
      }),
    ]);

    setColumns(normalizeColumns((columnResponse as { columns?: unknown })?.columns));
    setPreviewResult(normalizeResult(previewResponse));
  };

  const handleTableSelect = async (table: WindowsDatabaseTableRef) => {
    if (!selectedDatabase) {
      return;
    }

    setSelectedTable(table);
    setActiveTab('structure');
    setColumns([]);
    setPreviewResult(null);
    setRowEditorOpen(false);
    setEditingRow(null);
    setMutationError(null);
    setMutationSuccess(null);
    setDetailError(null);
    setDetailLoading(true);
    setSql(buildSampleSql(instance.engine, selectedDatabase, table, rowLimit));

    try {
      await loadSelectedTableDetails(table, selectedDatabase);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '加载表结构或预览失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const submitRowMutation = async (values: Record<string, string | number | boolean | null>) => {
    if (!onMutation || !selectedDatabase || !selectedTable) {
      return;
    }

    const rowIdentity =
      rowEditorMode === 'update' && editingRow
        ? buildWindowsDatabaseRowIdentity(columns, editingRow)
        : undefined;

    if (rowEditorMode === 'update' && !rowIdentity) {
      setMutationError(MUTATION_MISSING_IDENTITY_ERROR);
      return;
    }

    const requestValues =
      rowEditorMode === 'update' && editingRow
        ? buildChangedWindowsDatabaseValues(editingRow, values)
        : values;

    const request: WindowsDatabaseMutationRequest = {
      action: rowEditorMode === 'insert' ? 'insertRow' : 'updateRow',
      engine: instance.engine,
      instanceId: instance.id,
      database: selectedDatabase,
      schema: selectedTable.schema,
      table: selectedTable.name,
      values: requestValues,
      rowIdentity: rowIdentity ?? undefined,
      generatedColumns: generatedColumnNames,
    };

    setMutationLoading(true);
    setMutationError(null);
    setMutationSuccess(null);

    try {
      const response = await onMutation(request);
      setMutationSuccess(response.message);
      setRowEditorOpen(false);
      await loadSelectedTableDetails(selectedTable, selectedDatabase);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : MUTATION_GENERIC_ERROR);
    } finally {
      setMutationLoading(false);
    }
  };

  const deleteRow = async (row: Record<string, unknown>) => {
    if (!onMutation || !selectedDatabase || !selectedTable) {
      return;
    }

    const rowIdentity = buildWindowsDatabaseRowIdentity(columns, row);
    if (!rowIdentity) {
      setMutationError(MUTATION_MISSING_IDENTITY_ERROR);
      return;
    }

    setMutationLoading(true);
    setMutationError(null);
    setMutationSuccess(null);

    try {
      const response = await onMutation({
        action: 'deleteRow',
        engine: instance.engine,
        instanceId: instance.id,
        database: selectedDatabase,
        schema: selectedTable.schema,
        table: selectedTable.name,
        rowIdentity,
      });
      setMutationSuccess(response.message);
      await loadSelectedTableDetails(selectedTable, selectedDatabase);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : MUTATION_GENERIC_ERROR);
    } finally {
      setMutationLoading(false);
    }
  };

  const handleRunQuery = async () => {
    const trimmedSql = sql.trim();
    const validationError = validateReadonlySql(instance.engine, trimmedSql);

    if (validationError) {
      setQueryError(validationError);
      setQueryResult(null);
      setActiveTab('query');
      return;
    }

    const boundedRowLimit = clampReadonlyRowLimit(rowLimit);
    setRowLimit(boundedRowLimit);
    setQueryLoading(true);
    setQueryError(null);

    try {
      const response = await onRequest({
        action: 'runReadonlyQuery',
        instanceId: instance.id,
        engine: instance.engine,
        database: selectedDatabase ?? undefined,
        schema: selectedTable?.schema,
        table: selectedTable?.name,
        sql: trimmedSql,
        rowLimit: boundedRowLimit,
      });

      setQueryResult(normalizeResult(response));
      setActiveTab('query');
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : '只读查询执行失败');
    } finally {
      setQueryLoading(false);
    }
  };

  const previewActionColumns = editMode
    ? [
        {
          title: '操作',
          key: '__actions',
          fixed: 'right' as const,
          width: 150,
          render: (_: unknown, row: Record<string, unknown>) => {
            const identity = buildWindowsDatabaseRowIdentity(columns, row);

            return (
              <Space size={6}>
                <Button
                  size="small"
                  aria-label="编辑"
                  disabled={!identity || mutationLoading}
                  onClick={() => openUpdateEditor(row)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除这一行？"
                  disabled={!identity || mutationLoading}
                  onConfirm={() => void deleteRow(row)}
                >
                  <Button size="small" danger aria-label="删除" disabled={!identity || mutationLoading}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            );
          },
        },
      ]
    : [];
  const previewTableColumns = [...previewColumns, ...previewActionColumns];

  return (
    <div className="windows-database-workbench" data-testid="windows-database-workbench" style={styles.root}>
      <div style={styles.header}>
        <div style={styles.headerRow}>
          <Title level={5} style={{ margin: 0 }}>
            {ENGINE_LABELS[instance.engine]}
          </Title>
          <Tag color="blue">{instance.status}</Tag>
          <Tag>{instance.source}</Tag>
        </div>
        <div style={styles.metaRow}>
          <Text type="secondary">地址</Text>
          <Text>{instance.host}:{instance.port ?? '-'}</Text>
          <Text type="secondary">凭据</Text>
          <Text>{CREDENTIAL_MODE_LABELS[instance.credentialMode]}</Text>
          <Text type="secondary">{instance.credentialLabel}</Text>
        </div>
      </div>

      <div style={styles.workspace}>
        <div data-testid="windows-database-nav" style={styles.navRail}>
          <div style={styles.navSection}>
            <div style={styles.sectionHeader}>
              <Text strong>数据库</Text>
              <Text type="secondary">{databases.length}</Text>
            </div>
            <div data-testid="windows-database-db-list" style={styles.listViewport}>
              {databases.length === 0 ? (
                renderListState(databaseLoading, databaseError, '未返回数据库')
              ) : (
                <div style={styles.listStack}>
                  {databases.map((database) => (
                    <div key={database} style={styles.listItem}>
                      <div
                        className="windows-database-nav-button"
                        role="button"
                        tabIndex={0}
                        onClick={() => void handleDatabaseSelect(database)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            void handleDatabaseSelect(database);
                          }
                        }}
                        style={{
                          ...styles.navButton,
                          ...(selectedDatabase === database ? styles.navButtonActive : null),
                        }}
                      >
                        <span>{database}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ ...styles.navSection, borderBottom: 'none' }}>
            <div style={styles.sectionHeader}>
              <Text strong>表</Text>
              <Text type="secondary">{tables.length}</Text>
            </div>
            <div data-testid="windows-database-table-list" style={styles.listViewport}>
              {tables.length === 0 ? (
                renderListState(
                  tableLoading,
                  tableError,
                  selectedDatabase ? '当前数据库没有可浏览的表' : '先从上方选择数据库',
                )
              ) : (
                <div style={styles.listStack}>
                  {tables.map((table) => {
                    const tableKey = `${table.schema ?? 'default'}.${table.name}`;
                    const selected =
                      selectedTable?.name === table.name && selectedTable?.schema === table.schema;

                    return (
                      <div key={tableKey} style={styles.listItem}>
                        <div
                          className="windows-database-nav-button"
                          role="button"
                          tabIndex={0}
                          onClick={() => void handleTableSelect(table)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void handleTableSelect(table);
                            }
                          }}
                          style={{
                            ...styles.navButton,
                            ...(selected ? styles.navButtonActive : null),
                          }}
                        >
                          <span style={styles.tableName}>{table.name}</span>
                          {table.schema ? (
                            <Text type="secondary" style={styles.tableSchema}>
                              {table.schema}
                            </Text>
                          ) : null}
                          <span style={styles.visuallyHidden}>{tableKey}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={styles.resultPane}>
          <Tabs
            className="windows-database-tabs"
            activeKey={activeTab}
            onChange={setActiveTab}
            size="small"
            style={styles.tabs}
            items={[
              {
                key: 'structure',
                label: '结构',
                children: (
                  <div style={styles.tabPane}>
                    {detailError ? <Alert type="error" title={detailError} showIcon /> : null}
                    <div style={styles.tabSummary}>
                      <Text type="secondary">
                        {selectedTable
                          ? `${selectedDatabase}.${selectedTable.schema ? `${selectedTable.schema}.` : ''}${selectedTable.name}`
                          : '选择左侧表查看字段结构'}
                      </Text>
                    </div>
                    <div style={styles.tablePanel}>
                      <Spin spinning={detailLoading}>
                        {columns.length === 0 && !detailLoading ? (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无字段信息" style={styles.emptyState} />
                        ) : (
                          <Table
                            size="small"
                            pagination={false}
                            rowKey={(record) => record.name}
                            scroll={{ y: TABLE_SCROLL_HEIGHT, x: 720 }}
                            dataSource={columns}
                            columns={[
                              { title: '字段', dataIndex: 'name', key: 'name', width: 160 },
                              { title: '类型', dataIndex: 'dataType', key: 'dataType', width: 160 },
                              {
                                title: '允许空值',
                                dataIndex: 'nullable',
                                key: 'nullable',
                                width: 100,
                                render: (nullable: boolean) => (nullable ? 'YES' : 'NO'),
                              },
                              { title: '键', dataIndex: 'key', key: 'key', width: 120 },
                              { title: '默认值', dataIndex: 'defaultValue', key: 'defaultValue', width: 140 },
                              { title: '扩展', dataIndex: 'extra', key: 'extra' },
                            ]}
                          />
                        )}
                      </Spin>
                    </div>
                  </div>
                ),
              },
              {
                key: 'preview',
                label: '数据预览',
                children: (
                  <div style={styles.tabPane}>
                    {detailError ? <Alert type="error" title={detailError} showIcon /> : null}
                    {mutationError ? <Alert type="error" title={mutationError} showIcon /> : null}
                    {mutationSuccess ? <Alert type="success" title={mutationSuccess} showIcon /> : null}
                    <div style={styles.tabSummary}>
                      <Text type="secondary">
                        {previewResult
                          ? `返回 ${previewResult.rowCount} 行${previewResult.truncated ? '，结果已截断' : ''}`
                          : '预览固定行数的原始数据'}
                      </Text>
                    </div>
                    <div style={styles.queryToolbar}>
                      <Space size={8}>
                        <Text type="secondary">编辑模式</Text>
                        <Switch
                          size="small"
                          checked={editMode}
                          onChange={setEditMode}
                          aria-label="编辑模式"
                          disabled={!onMutation}
                        />
                      </Space>
                      {editMode ? (
                        <Button
                          size="small"
                          type="primary"
                          aria-label="新增行"
                          onClick={openInsertEditor}
                          disabled={!selectedTable || !onMutation || mutationLoading}
                        >
                          新增行
                        </Button>
                      ) : null}
                    </div>
                    <div style={styles.tablePanel}>
                      <Spin spinning={detailLoading}>
                        {!previewResult || previewResult.columns.length === 0 ? (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无预览数据" style={styles.emptyState} />
                        ) : (
                          <Table
                            size="small"
                            pagination={false}
                            rowKey="__workbenchRowKey"
                            scroll={{ y: TABLE_SCROLL_HEIGHT, x: 'max-content' }}
                            dataSource={previewRows}
                            columns={previewTableColumns}
                          />
                        )}
                      </Spin>
                    </div>
                  </div>
                ),
              },
              {
                key: 'query',
                label: '只读查询',
                children: (
                  <div style={styles.tabPane}>
                    <div style={styles.queryControls}>
                      <TextArea
                        rows={5}
                        value={sql}
                        onChange={(event) => {
                          setSql(event.target.value);
                          setQueryError(null);
                        }}
                        placeholder={getReadonlyQueryHint(instance.engine)}
                        spellCheck={false}
                      />
                      <div style={styles.queryToolbar}>
                        <Text type="secondary">{getReadonlyQueryHint(instance.engine)}</Text>
                        <div style={styles.queryActions}>
                          <Text type="secondary">行数上限</Text>
                          <InputNumber
                            size="small"
                            min={1}
                            max={MAX_READONLY_ROW_LIMIT}
                            value={rowLimit}
                            onInput={(value) => {
                              const parsedValue = Number(value);
                              if (Number.isFinite(parsedValue)) {
                                setRowLimit(clampReadonlyRowLimit(parsedValue));
                              }
                            }}
                            onChange={(value) =>
                              setRowLimit(clampReadonlyRowLimit(typeof value === 'number' ? value : DEFAULT_READONLY_ROW_LIMIT))
                            }
                          />
                          <Button
                            type="primary"
                            size="small"
                            aria-label="执行只读查询"
                            onClick={() => void handleRunQuery()}
                            loading={queryLoading}
                          >
                            执行
                          </Button>
                        </div>
                      </div>
                    </div>
                    {queryError ? <Alert type="error" title={queryError} showIcon /> : null}
                    <div style={styles.tablePanel}>
                      {queryResult && queryResult.columns.length > 0 ? (
                        <Table
                          size="small"
                          pagination={false}
                          rowKey="__workbenchRowKey"
                          scroll={{ y: TABLE_SCROLL_HEIGHT, x: 'max-content' }}
                          dataSource={queryRows}
                          columns={queryColumns}
                        />
                      ) : (
                        <div style={styles.centerState}>
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入只读 SQL 后执行查询" />
                        </div>
                      )}
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
      <WindowsDatabaseRowEditor
        open={rowEditorOpen}
        mode={rowEditorMode}
        columns={editableColumns}
        initialValues={editingRow ?? {}}
        onCancel={() => setRowEditorOpen(false)}
        onSubmit={(values) => void submitRowMutation(values)}
      />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #d9d9d9',
    borderRadius: 8,
    background: '#fff',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: '1px solid #f0f0f0',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flexShrink: 0,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  workspace: {
    display: 'flex',
    minHeight: 0,
    flex: 1,
    overflow: 'hidden',
  },
  navRail: {
    width: NAV_WIDTH,
    minWidth: NAV_WIDTH,
    maxWidth: NAV_WIDTH,
    borderRight: '1px solid #f0f0f0',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    overflow: 'hidden',
  },
  navSection: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: '1 1 0',
    borderBottom: '1px solid #f0f0f0',
    overflow: 'hidden',
  },
  sectionHeader: {
    padding: '10px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid #f5f5f5',
  },
  listViewport: {
    flex: '1 1 0',
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: 8,
  },
  listItem: {
    paddingInline: 0,
  },
  listStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  navButton: {
    width: '100%',
    border: '1px solid transparent',
    borderRadius: 6,
    background: 'transparent',
    padding: '8px 10px',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    cursor: 'pointer',
    minWidth: 0,
    outline: 'none',
  },
  navButtonActive: {
    background: '#e6f4ff',
    borderColor: 'transparent',
  },
  tableName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tableSchema: {
    fontSize: 12,
    flexShrink: 0,
  },
  resultPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  tabs: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  tabPane: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'hidden',
  },
  tabSummary: {
    minHeight: 22,
  },
  tablePanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  queryControls: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  queryToolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  queryActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  centerState: {
    height: '100%',
    minHeight: 120,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    marginBlock: 40,
  },
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
};

export default WindowsDatabaseWorkbench;
