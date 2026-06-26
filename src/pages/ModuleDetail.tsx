import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Card, Row, Col, Progress, Typography, Descriptions, Spin, Table, Tag, List, Input, Button, Space, Statistic, Checkbox, Popover, Dropdown, Modal, Select, Upload, message, Empty, Tabs, Switch, Alert, Collapse, Pagination } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import { ReloadOutlined, UserOutlined, ApiOutlined, DatabaseOutlined, DesktopOutlined, SettingOutlined, DownloadOutlined, EyeOutlined, NumberOutlined, UploadOutlined, MoreOutlined, SearchOutlined, FileSearchOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, exists } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { MenuProps } from 'antd';
import WindowsDatabaseWorkbench from '../components/windows/WindowsDatabaseWorkbench';
import WindowsPanelDetectionView from '../components/windows/WindowsPanelDetectionView';
import { parseWindowsPanelSections } from '../modules/windowsPanel/detection';
import type {
    WindowsDatabaseAction,
    WindowsDatabaseColumn,
    WindowsDatabaseEngine,
    WindowsDatabaseInstance,
    WindowsDatabaseMutationRequest,
    WindowsDatabaseMutationResponse,
    WindowsDatabaseTableRef,
} from '../modules/windowsDatabase/types';
import { isTauriRuntime } from '../utils/runtime';

const { Title, Text } = Typography;

const DIAGNOSTIC_TITLE = '\u91c7\u96c6\u8bca\u65ad';
const DIAGNOSTIC_REASON_NO_RECORDS = '\u672a\u53d1\u73b0\u8bb0\u5f55';
const DIAGNOSTIC_REASON_COLLECTION_FAILED = '\u91c7\u96c6\u5931\u8d25';
const DIAGNOSTIC_REASON_PARSE_FAILED = '\u89e3\u6790\u5931\u8d25';
const DIAGNOSTIC_EVIDENCE_SUMMARY = '\u67e5\u770b\u539f\u59cb\u8f93\u51fa / \u77ed\u8bc1\u636e';
const DIAGNOSTIC_NO_EVIDENCE = '\u672a\u6355\u83b7\u5230 stdout/stderr \u539f\u59cb\u8f93\u51fa';
const DIAGNOSTIC_TRUNCATED_SUFFIX = '\n... \u5df2\u622a\u65ad\uff0c\u5c55\u5f00\u539f\u59cb\u8f93\u51fa\u67e5\u770b\u5b8c\u6574\u5185\u5bb9';
const DIAGNOSTIC_NO_RECORDS_FALLBACK = '\u5df2\u5b8c\u6210\u91c7\u96c6\uff0c\u4f46\u6ca1\u6709\u53ef\u5c55\u793a\u8bb0\u5f55\u3002\u8bf7\u786e\u8ba4\u6743\u9650\u3001\u65e5\u5fd7\u8303\u56f4\u6216\u7cfb\u7edf\u4e0a\u662f\u5426\u5b58\u5728\u5bf9\u5e94\u6570\u636e\u3002';
const DIAGNOSTIC_COLLECTION_FAILED_FALLBACK = '\u8bf7\u68c0\u67e5\u91c7\u96c6\u547d\u4ee4\u8f93\u51fa\u3001\u7cfb\u7edf\u6743\u9650\uff0c\u4ee5\u53ca\u662f\u5426\u9700\u8981\u4ee5\u7ba1\u7406\u5458/root \u8fd0\u884c\u3002';
const DIAGNOSTIC_PARSE_FAILED_FALLBACK = '\u91c7\u96c6\u547d\u4ee4\u5df2\u8fd4\u56de\u5185\u5bb9\uff0c\u4f46\u8f93\u51fa\u683c\u5f0f\u4e0e\u89e3\u6790\u5668\u9884\u671f\u4e0d\u4e00\u81f4\u3002\u8bf7\u67e5\u770b\u539f\u59cb\u8f93\u51fa\u3002';
const WINDOWS_DATABASE_DETAIL_LABEL = '\u67e5\u770b\u8be6\u60c5';
const WINDOWS_DATABASE_DETAIL_TITLE = '\u6570\u636e\u5e93\u8be6\u60c5';

const compactEvidence = (value: string, maxLength = 1200): string => {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}${DIAGNOSTIC_TRUNCATED_SUFFIX}`;
};

interface WindowsDatabaseReadonlyRequest {
    action: WindowsDatabaseAction;
    instanceId: string;
    engine: WindowsDatabaseEngine;
    database?: string;
    schema?: string;
    table?: string;
    sql?: string;
    rowLimit?: number;
}

interface WindowsDatabaseReadonlyCommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number;
    exit_code?: number;
}

interface WindowsDatabaseMutationCommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number;
    exit_code?: number;
}

interface WindowsCollectionArtifact {
    path: string;
    totalCount: number;
    previewCount: number;
    format: string;
}

interface WindowsLogPageInfo {
    page: number;
    pageSize: number;
    totalCount: number | null;
}

interface EverythingSearchRequest {
    query: string;
    maxResults?: number;
    offset?: number;
    path?: string;
    filesOnly?: boolean;
    sort?: string;
    sortDescending?: boolean;
    includeTotalCount?: boolean;
}

interface EverythingSearchResult {
    fullPath: string;
    name: string;
    parentPath: string;
    extension: string;
    size?: number | null;
    dateModified?: string | null;
}

interface EverythingSearchPageResponse {
    results: EverythingSearchResult[];
    totalCount?: number | null;
    offset: number;
    limit: number;
    hasMore: boolean;
}

interface ModuleLoadOptions {
    windowsLogPage?: number;
    windowsLogPageSize?: number;
}

const WINDOWS_EVENT_LOG_PREVIEW_LIMIT = 500;
const WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE = 50;

const windowsEventLogModuleNames: Record<string, string> = {
    win_security_log: 'Security',
    win_system_log: 'System',
    win_app_log: 'Application',
    win_powershell_log: 'Windows PowerShell',
};

const windowsLogTimeRangeStartExpressions: Record<string, string> = {
    '1h': '(Get-Date).AddHours(-1)',
    '6h': '(Get-Date).AddHours(-6)',
    '24h': '(Get-Date).AddDays(-1)',
    '3d': '(Get-Date).AddDays(-3)',
};

const WINDOWS_DATABASE_DEFAULT_PORTS: Record<WindowsDatabaseEngine, number> = {
    mysql: 3306,
    sqlserver: 1433,
    postgresql: 5432,
};

const EVERYTHING_SEARCH_DEBOUNCE_MS = 250;
const EVERYTHING_LIVE_MAX_RESULTS = 50;
const MIN_EVERYTHING_LIVE_QUERY_LENGTH = 2;
const EVERYTHING_HASH_ALGORITHMS = [
    { label: 'MD5', value: 'md5' },
    { label: 'SHA1', value: 'sha1' },
    { label: 'SHA256', value: 'sha256' },
];

type EverythingHashAlgorithm = 'md5' | 'sha1' | 'sha256';

interface EverythingQueryParts {
    query: string;
    extension: string;
    hashAlgorithm: EverythingHashAlgorithm;
    hashValue: string;
    content: string;
}

const toRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const normalizeCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const readArtifactPreview = (value: unknown): {
    rows: any[];
    artifact: WindowsCollectionArtifact | null;
    previewLimit: number | null;
    pageInfo: WindowsLogPageInfo | null;
} => {
    if (isRecord(value) && Array.isArray(value.preview)) {
        const artifactPath = value.artifactPath ?? value.ArtifactPath;
        const previewLimit = Number(value.previewLimit ?? value.PreviewLimit);
        const page = Number(value.page ?? value.Page);
        const pageSize = Number(value.pageSize ?? value.PageSize);
        const totalCount = Number(value.totalCount ?? value.TotalCount);
        const rows = value.preview;
        const pageInfo = Number.isFinite(page) && Number.isFinite(pageSize)
            ? {
                page,
                pageSize,
                totalCount: Number.isFinite(totalCount) ? totalCount : null,
            }
            : null;

        if (!artifactPath) {
            return {
                rows,
                artifact: null,
                previewLimit: Number.isFinite(previewLimit) ? previewLimit : null,
                pageInfo,
            };
        }

        const resolvedTotalCount = Number.isFinite(totalCount) ? totalCount : rows.length;

        return {
            rows,
            artifact: {
                path: String(artifactPath),
                totalCount: resolvedTotalCount,
                previewCount: rows.length,
                format: String(value.format ?? value.Format ?? 'csv'),
            },
            previewLimit: Number.isFinite(previewLimit) ? previewLimit : null,
            pageInfo: pageInfo ?? {
                page: 1,
                pageSize: WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
                totalCount: resolvedTotalCount,
            },
        };
    }

    if (!isRecord(value) || !value.artifactPath) {
        return { rows: Array.isArray(value) ? value : [value], artifact: null, previewLimit: null, pageInfo: null };
    }

    const preview = Array.isArray(value.preview) ? value.preview : [];
    const totalCount = Number(value.totalCount ?? preview.length);
    const resolvedTotalCount = Number.isFinite(totalCount) ? totalCount : preview.length;
    return {
        rows: preview,
        artifact: {
            path: String(value.artifactPath),
            totalCount: resolvedTotalCount,
            previewCount: preview.length,
            format: String(value.format ?? 'csv'),
        },
        previewLimit: null,
        pageInfo: {
            page: 1,
            pageSize: WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
            totalCount: resolvedTotalCount,
        },
    };
};

const parseWindowsDatabasePort = (value: unknown): number | null => {
    const text = normalizeCell(value);
    if (!/^\d+$/.test(text)) return null;
    const port = Number.parseInt(text, 10);
    return port > 0 && port <= 65535 ? port : null;
};

const normalizeWindowsDatabaseHost = (value: unknown): string => {
    const host = normalizeCell(value);
    if (!host || host === '-' || host === '0.0.0.0' || host === '::' || host === '[::]') {
        return 'localhost';
    }
    return host;
};

const getWindowsDatabaseEngine = (record: unknown): WindowsDatabaseEngine | null => {
    const row = toRecord(record);
    const text = [
        row.databaseEngine,
        row.type,
        row.name,
        row.rawServiceName,
        row.path,
        row.detail,
    ].map(normalizeCell).join(' ').toLowerCase();

    if (text.includes('mssql') || text.includes('sql server') || text.includes('sqlservr')) return 'sqlserver';
    if (text.includes('mysql') || text.includes('mariadb') || text.includes('mysqld')) return 'mysql';
    if (text.includes('postgres') || text.includes('pgsql')) return 'postgresql';
    return null;
};

const extractSqlServerInstanceTarget = (record: Record<string, unknown>): string => {
    const explicitTarget = normalizeCell(record.instanceTarget);
    if (explicitTarget) return explicitTarget;

    const serviceName = normalizeCell(record.rawServiceName || record.serviceName);
    if (serviceName) return serviceName;

    const name = normalizeCell(record.name);
    const parenthesized = name.match(/\(([^)]+)\)/);
    if (parenthesized?.[1]) return parenthesized[1].trim();

    return 'MSSQLSERVER';
};

const buildWindowsDatabaseInstance = (record: unknown): WindowsDatabaseInstance | null => {
    const row = toRecord(record);
    const engine = getWindowsDatabaseEngine(row);
    if (!engine) return null;

    const host = normalizeWindowsDatabaseHost(row.host ?? row.localAddress);
    const port = parseWindowsDatabasePort(row.port);
    const defaultPort = WINDOWS_DATABASE_DEFAULT_PORTS[engine];
    const instanceTarget = engine === 'sqlserver'
        ? extractSqlServerInstanceTarget(row)
        : `${host}:${port ?? defaultPort}`;

    const status = normalizeCell(row.status) || '-';
    const source = normalizeCell(row.source) || '-';
    const credentialMode = row.credentialMode === 'unavailable'
        ? 'unavailable'
        : source.includes('\u5b89\u88c5') && !port
            ? 'unavailable'
            : 'detected';

    return {
        id: `${engine}:${instanceTarget}`,
        engine,
        displayName: normalizeCell(row.name) || normalizeCell(row.type) || engine,
        source,
        status,
        path: normalizeCell(row.path) || '-',
        version: normalizeCell(row.version) || '-',
        host,
        port: port ?? (engine === 'sqlserver' ? null : defaultPort),
        credentialMode,
        credentialLabel: credentialMode === 'unavailable'
            ? '\u672a\u53d1\u73b0\u8fd0\u884c\u5b9e\u4f8b'
            : '\u4f7f\u7528\u672c\u673a\u5ba2\u6237\u7aef\u548c\u5f53\u524d\u7528\u6237\u51ed\u636e',
    };
};

const tryParseJson = (value: string): unknown | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
};

const splitDelimitedLine = (line: string): string[] => {
    if (line.includes('\t')) {
        return line.split('\t').map(part => part.trim());
    }

    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        const next = line[i + 1];
        if (char === '"' && quoted && next === '"') {
            current += '"';
            i += 1;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === ',' && !quoted) {
            cells.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current.trim());
    return cells;
};

const getWindowsDatabaseOutputLines = (stdout: string): string[] =>
    stdout
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^[-\s]+$/.test(line))
        .filter(line => !/^\(\d+\s+rows?\s+affected\)$/i.test(line))
        .filter(line => !/^\(\d+\s+.*受影响.*\)$/i.test(line))
        .filter(line => !/^\(\d+\s+.*\uFFFD.*\)$/i.test(line))
        .filter(line => !/^rows?\s+affected/i.test(line));

const coerceStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => {
            if (typeof item === 'string') return item.trim();
            const row = toRecord(item);
            return normalizeCell(row.name ?? row.datname ?? row.database ?? row.Database ?? row.TABLE_NAME ?? row.table);
        })
        .filter(Boolean);
};

const parseListDatabasesOutput = (stdout: string): { databases: string[] } => {
    const lines = getWindowsDatabaseOutputLines(stdout);
    const databases = lines
        .map(line => splitDelimitedLine(line)[0] || line)
        .map(line => line.trim())
        .filter(line => line && !/^(name|datname|database)$/i.test(line));
    return { databases };
};

const parseListTablesOutput = (stdout: string): { tables: WindowsDatabaseTableRef[] } => {
    const lines = getWindowsDatabaseOutputLines(stdout);
    if (lines.length === 0) return { tables: [] };

    const header = splitDelimitedLine(lines[0]).map(cell => cell.toLowerCase());
    const tableNameIndex = header.findIndex(cell => ['table_name', 'tablename', 'name'].includes(cell));
    const schemaIndex = header.findIndex(cell => ['table_owner', 'schemaname', 'schema'].includes(cell));
    const startIndex = tableNameIndex >= 0 ? 1 : 0;

    const tables = lines.slice(startIndex).flatMap((line): WindowsDatabaseTableRef[] => {
        const cells = splitDelimitedLine(line);
        const name = tableNameIndex >= 0 ? cells[tableNameIndex] : cells[0];
        if (!name || /^(table_name|tablename|name)$/i.test(name)) return [];
        const schema = schemaIndex >= 0 ? cells[schemaIndex] : undefined;
        return [{ schema: schema || undefined, name }];
    });

    return { tables };
};

const parseDescribeTableOutput = (stdout: string): { columns: WindowsDatabaseColumn[] } => {
    const lines = getWindowsDatabaseOutputLines(stdout);
    if (lines.length === 0) return { columns: [] };

    const first = splitDelimitedLine(lines[0]).map(cell => cell.toLowerCase());
    const hasHeader = first.some(cell => ['field', 'column_name', 'name'].includes(cell));
    const nameIndex = hasHeader ? first.findIndex(cell => ['field', 'column_name', 'name'].includes(cell)) : 0;
    const typeIndex = hasHeader ? first.findIndex(cell => ['type', 'type_name', 'data_type', 'datatype'].includes(cell)) : 1;
    const nullableIndex = hasHeader ? first.findIndex(cell => ['null', 'nullable', 'is_nullable'].includes(cell)) : 2;
    const keyIndex = hasHeader ? first.findIndex(cell => ['key', 'column_key'].includes(cell)) : 3;
    const defaultIndex = hasHeader ? first.findIndex(cell => ['default', 'column_def'].includes(cell)) : 4;
    const extraIndex = hasHeader ? first.findIndex(cell => ['extra'].includes(cell)) : 5;

    const columns = lines.slice(hasHeader ? 1 : 0).flatMap((line): WindowsDatabaseColumn[] => {
        const cells = splitDelimitedLine(line);
        const name = cells[nameIndex] || cells[0];
        if (!name) return [];
        const nullableValue = nullableIndex >= 0 ? cells[nullableIndex] : '';
        return [{
            name,
            dataType: typeIndex >= 0 ? cells[typeIndex] || '' : '',
            nullable: /^(yes|y|true|1|nullable)$/i.test(nullableValue),
            key: keyIndex >= 0 ? cells[keyIndex] || undefined : undefined,
            defaultValue: defaultIndex >= 0 ? cells[defaultIndex] || undefined : undefined,
            extra: extraIndex >= 0 ? cells[extraIndex] || undefined : undefined,
        }];
    });

    return { columns };
};

const parsePreviewOutput = (stdout: string) => {
    const lines = getWindowsDatabaseOutputLines(stdout);
    if (lines.length === 0) {
        return { columns: [], rows: [], rowCount: 0, truncated: false };
    }

    const first = splitDelimitedLine(lines[0]);
    const hasHeader = lines.length > 1 && first.some(cell => /[A-Za-z_]/.test(cell));
    const columns = hasHeader ? first : first.map((_, index) => `column_${index + 1}`);
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const rows = dataLines.map(line => {
        const cells = splitDelimitedLine(line);
        return columns.reduce<Record<string, string>>((row, column, index) => {
            row[column] = cells[index] ?? '';
            return row;
        }, {});
    });

    return { columns, rows, rowCount: rows.length, truncated: false };
};

const normalizeWindowsDatabaseReadonlyResponse = (
    request: WindowsDatabaseReadonlyRequest,
    stdout: string,
) => {
    const json = tryParseJson(stdout);
    if (json && typeof json === 'object') {
        const payload = toRecord(json);
        if (request.action === 'listDatabases') {
            return { databases: coerceStringArray(payload.databases ?? payload.rows ?? json) };
        }
        if (request.action === 'listTables') {
            return { tables: Array.isArray(payload.tables) ? payload.tables : coerceStringArray(payload.rows ?? json).map(name => ({ name })) };
        }
        if (request.action === 'describeTable') {
            return { columns: Array.isArray(payload.columns) ? payload.columns : [] };
        }
        if (request.action === 'previewTable' || request.action === 'runReadonlyQuery') {
            return {
                columns: Array.isArray(payload.columns) ? payload.columns : [],
                rows: Array.isArray(payload.rows) ? payload.rows : [],
                rowCount: typeof payload.rowCount === 'number' ? payload.rowCount : Array.isArray(payload.rows) ? payload.rows.length : 0,
                truncated: Boolean(payload.truncated),
            };
        }
    }

    switch (request.action) {
        case 'listDatabases':
            return parseListDatabasesOutput(stdout);
        case 'listTables':
            return parseListTablesOutput(stdout);
        case 'describeTable':
            return parseDescribeTableOutput(stdout);
        case 'previewTable':
        case 'runReadonlyQuery':
            return parsePreviewOutput(stdout);
        default:
            return {};
    }
};

// 本地系统信息组件（优化版）
interface LocalDiskTableRow {
    key: string;
    mount: string;
    size: string;
    used: string;
    avail: string;
    percent: number;
}

const formatLocalDiskGb = (value: unknown): string => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `${value.toFixed(1)} GB`;
    }

    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }

    return '-';
};

const normalizeLocalDiskRows = (disks: any[]): LocalDiskTableRow[] => disks.map((disk, index) => {
    const mount = String(disk?.mount ?? disk?.mount_point ?? disk?.name ?? '-').trim() || '-';
    const percentValue = Number(disk?.percent ?? disk?.usage_percent ?? 0);

    return {
        key: `${mount}-${index}`,
        mount,
        size: formatLocalDiskGb(disk?.size ?? disk?.total_gb),
        used: formatLocalDiskGb(disk?.used ?? disk?.used_gb),
        avail: formatLocalDiskGb(disk?.avail ?? disk?.free_gb),
        percent: Number.isFinite(percentValue) ? Math.round(percentValue) : 0,
    };
});

const LocalSystemInfoView = ({ systemInfo, isDarkMode = false }: { systemInfo: SystemInfo; isDarkMode?: boolean }) => {
    const memoryPercent = useMemo(
        () => Math.round((systemInfo.used_memory_gb / systemInfo.total_memory_gb) * 100),
        [systemInfo.used_memory_gb, systemInfo.total_memory_gb]
    );

    const cpuUsage = useMemo(() => Math.round(systemInfo.cpu_usage), [systemInfo.cpu_usage]);
    const diskRows = useMemo(() => normalizeLocalDiskRows(systemInfo.disks), [systemInfo.disks]);

    const formatUptime = (seconds: number) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (days > 0) return `${days}天${hours}小时`;
        if (hours > 0) return `${hours}小时${minutes}分钟`;
        return `${minutes}分钟`;
    };

    return (
        <Space
            className={`local-system-info${isDarkMode ? ' local-system-info-dark' : ''}`}
            data-testid="local-system-info"
            direction="vertical"
            size="middle"
            style={{ width: '100%' }}
        >
            {/* 顶部横幅 */}
            <Card size="small">
                <Row align="middle" gutter={24}>
                    <Col flex="auto">
                        <Space size="middle">
                            <DesktopOutlined style={{ fontSize: 24, color: '#1890ff' }} />
                            <div>
                                <Title level={4} style={{ margin: 0 }}>{systemInfo.hostname}</Title>
                                <Text type="secondary">{systemInfo.os_name} ({systemInfo.architecture})</Text>
                            </div>
                        </Space>
                    </Col>
                    <Col>
                        <Statistic title="CPU" value={cpuUsage} suffix="%" valueStyle={{ fontSize: 20 }} />
                    </Col>
                    <Col>
                        <Statistic
                            title="内存"
                            value={`${systemInfo.used_memory_gb.toFixed(1)}/${systemInfo.total_memory_gb.toFixed(1)}`}
                            suffix="GB"
                            valueStyle={{ fontSize: 20 }}
                        />
                    </Col>
                    <Col>
                        <Statistic title="运行时间" value={formatUptime(systemInfo.uptime_seconds)} valueStyle={{ fontSize: 16 }} />
                    </Col>
                </Row>
            </Card>

            {/* 资源监控 */}
            <Card size="small" title="资源监控">
                <Row gutter={24}>
                    <Col span={8}>
                        <Statistic
                            title="CPU 使用率"
                            value={cpuUsage}
                            suffix="%"
                            valueStyle={{ color: cpuUsage > 80 ? '#cf1322' : '#3f8600', fontSize: 28 }}
                        />
                        <Progress
                            percent={cpuUsage}
                            strokeColor={cpuUsage > 80 ? '#cf1322' : '#52c41a'}
                            style={{ marginTop: 8 }}
                        />
                        <Text type="secondary">{systemInfo.cpu_model}</Text>
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="内存使用"
                            value={memoryPercent}
                            suffix="%"
                            valueStyle={{ color: memoryPercent > 80 ? '#cf1322' : '#3f8600', fontSize: 28 }}
                        />
                        <Progress
                            percent={memoryPercent}
                            strokeColor={memoryPercent > 80 ? '#cf1322' : '#52c41a'}
                            style={{ marginTop: 8 }}
                        />
                        <Text type="secondary">
                            {systemInfo.used_memory_gb.toFixed(1)} / {systemInfo.total_memory_gb.toFixed(1)} GB
                        </Text>
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="CPU 核心"
                            value={systemInfo.cpu_cores}
                            suffix="核"
                            valueStyle={{ fontSize: 28 }}
                        />
                        <div style={{ marginTop: 16 }}>
                            <Text type="secondary">磁盘数量: {diskRows.length}</Text>
                        </div>
                    </Col>
                </Row>
            </Card>

            {/* 详细信息 */}
            <Collapse>
                <Collapse.Panel header="系统详情" key="system">
                    <Descriptions size="small" column={2} bordered>
                        <Descriptions.Item label="操作系统">{systemInfo.os_name}</Descriptions.Item>
                        <Descriptions.Item label="系统版本">{systemInfo.os_version}</Descriptions.Item>
                        <Descriptions.Item label="内核版本">{systemInfo.kernel_version}</Descriptions.Item>
                        <Descriptions.Item label="架构">{systemInfo.architecture}</Descriptions.Item>
                        <Descriptions.Item label="主机名">{systemInfo.hostname}</Descriptions.Item>
                        <Descriptions.Item label="IP地址">{systemInfo.ip_addresses.join(', ') || '-'}</Descriptions.Item>
                        <Descriptions.Item label="开机时间">{systemInfo.boot_time_str}</Descriptions.Item>
                        <Descriptions.Item label="时区">{systemInfo.timezone}</Descriptions.Item>
                        <Descriptions.Item label="当前时间" span={2}>{systemInfo.current_time}</Descriptions.Item>
                    </Descriptions>
                </Collapse.Panel>
                {diskRows.length > 0 && (
                    <Collapse.Panel header="磁盘详情" key="disks">
                        <Table
                            dataSource={diskRows}
                            columns={[
                                { title: '挂载点', dataIndex: 'mount', key: 'mount' },
                                { title: '大小', dataIndex: 'size', key: 'size', width: 100 },
                                { title: '已用', dataIndex: 'used', key: 'used', width: 100 },
                                { title: '可用', dataIndex: 'avail', key: 'avail', width: 100 },
                                {
                                    title: '使用率',
                                    dataIndex: 'percent',
                                    key: 'percent',
                                    width: 180,
                                    render: (v: number) => (
                                        <Progress
                                            percent={v}
                                            size="small"
                                            status={v > 90 ? 'exception' : 'normal'}
                                        />
                                    )
                                },
                            ]}
                            size="small"
                            pagination={false}
                            scroll={{ y: 300 }}
                            rowKey="key"
                        />
                    </Collapse.Panel>
                )}
            </Collapse>
        </Space>
    );
};

// 远程系统信息组件（优化版）
const RemoteSystemInfoView = ({ systemInfo, isDarkMode = false }: { systemInfo: RemoteSystemInfo; isDarkMode?: boolean }) => {
    const memPercent = useMemo(
        () => Math.round(systemInfo.mem_percent || 0),
        [systemInfo.mem_percent]
    );

    const loadOneMinute = useMemo(
        () => Number.parseFloat((systemInfo.load_avg || '0').split(',')[0] || '0'),
        [systemInfo.load_avg]
    );

    const loadPressure = useMemo(() => {
        if (systemInfo.cpu_cores > 0 && Number.isFinite(loadOneMinute)) {
            return Math.round((loadOneMinute / systemInfo.cpu_cores) * 100);
        }
        return 0;
    }, [loadOneMinute, systemInfo.cpu_cores]);

    const sysInfoData = useMemo(() => {
        return [
            { key: 'hostname', label: '主机名', value: systemInfo.hostname },
            { key: 'os_type', label: '操作系统类型', value: systemInfo.os_type },
            { key: 'os_name', label: '操作系统版本', value: systemInfo.os_name || systemInfo.os_version },
            { key: 'pretty_name', label: '发行版名称', value: systemInfo.pretty_name },
            { key: 'kernel', label: '内核版本', value: systemInfo.kernel },
            { key: 'architecture', label: '系统架构', value: systemInfo.architecture },
            { key: 'cpu_model', label: 'CPU型号', value: systemInfo.cpu_model },
            { key: 'cpu_cores', label: 'CPU核心数', value: systemInfo.cpu_cores ? String(systemInfo.cpu_cores) : undefined },
            { key: 'ip_address', label: 'IP地址', value: systemInfo.ip_address },
            { key: 'uptime', label: '运行时间', value: systemInfo.uptime },
            { key: 'load_avg', label: '系统负载', value: systemInfo.load_avg },
        ].filter(item => item.value && item.value !== '-' && item.value !== '0');
    }, [systemInfo]);

    return (
        <Space
            className={`remote-system-info${isDarkMode ? ' remote-system-info-dark' : ''}`}
            data-testid="remote-system-info"
            direction="vertical"
            size="middle"
            style={{ width: '100%' }}
        >
            {/* 顶部横幅 */}
            <Card size="small">
                <Row align="middle" gutter={24}>
                    <Col flex="auto">
                        <Space size="middle">
                            <DesktopOutlined style={{ fontSize: 24, color: '#1890ff' }} />
                            <div>
                                <Title level={4} style={{ margin: 0 }}>{systemInfo.hostname}</Title>
                                <Text type="secondary">{systemInfo.pretty_name || systemInfo.os_type}</Text>
                            </div>
                        </Space>
                    </Col>
                    <Col>
                        <Statistic
                            title="负载"
                            value={loadOneMinute.toFixed(2)}
                            valueStyle={{ fontSize: 20, color: loadPressure > 100 ? '#cf1322' : '#3f8600' }}
                        />
                    </Col>
                    <Col>
                        <Statistic
                            title="内存"
                            value={`${systemInfo.mem_used}/${systemInfo.mem_total}`}
                            valueStyle={{ fontSize: 20 }}
                        />
                    </Col>
                    <Col>
                        <Statistic title="运行时间" value={systemInfo.uptime} valueStyle={{ fontSize: 16 }} />
                    </Col>
                </Row>
            </Card>

            {/* 资源监控 */}
            <Card size="small" title="资源监控">
                <Row gutter={24}>
                    <Col span={8}>
                        <Statistic
                            title="系统负载 (1min)"
                            value={loadOneMinute.toFixed(2)}
                            valueStyle={{ color: loadPressure > 100 ? '#cf1322' : '#3f8600', fontSize: 28 }}
                        />
                        <Progress
                            percent={Math.min(loadPressure, 100)}
                            strokeColor={loadPressure > 100 ? '#cf1322' : '#52c41a'}
                            status={loadPressure > 100 ? 'exception' : 'normal'}
                            style={{ marginTop: 8 }}
                        />
                        <Text type="secondary">
                            {systemInfo.cpu_cores} 核心 {loadPressure > 100 && '(过载)'}
                        </Text>
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="内存使用"
                            value={memPercent}
                            suffix="%"
                            valueStyle={{ color: memPercent > 80 ? '#cf1322' : '#3f8600', fontSize: 28 }}
                        />
                        <Progress
                            percent={memPercent}
                            strokeColor={memPercent > 80 ? '#cf1322' : '#52c41a'}
                            style={{ marginTop: 8 }}
                        />
                        <Text type="secondary">{systemInfo.mem_used} / {systemInfo.mem_total}</Text>
                    </Col>
                    <Col span={8}>
                        <Statistic
                            title="磁盘数量"
                            value={systemInfo.disks.length}
                            valueStyle={{ fontSize: 28 }}
                        />
                        <div style={{ marginTop: 16 }}>
                            <Text type="secondary">
                                最高使用率: {Math.max(...systemInfo.disks.map(d => d.percent))}%
                            </Text>
                        </div>
                    </Col>
                </Row>
            </Card>

            {/* 详细信息 */}
            <Collapse>
                <Collapse.Panel header="系统详情" key="system">
                    <Descriptions size="small" column={2} bordered>
                        {sysInfoData.map(item => (
                            <Descriptions.Item label={item.label} key={item.key}>
                                {item.value}
                            </Descriptions.Item>
                        ))}
                    </Descriptions>
                </Collapse.Panel>
                {systemInfo.disks.length > 0 && (
                    <Collapse.Panel header="磁盘详情" key="disks">
                        <Table
                            dataSource={systemInfo.disks}
                            columns={[
                                { title: '挂载点', dataIndex: 'mount', key: 'mount' },
                                { title: '大小', dataIndex: 'size', key: 'size', width: 100 },
                                { title: '已用', dataIndex: 'used', key: 'used', width: 100 },
                                { title: '可用', dataIndex: 'avail', key: 'avail', width: 100 },
                                {
                                    title: '使用率',
                                    dataIndex: 'percent',
                                    key: 'percent',
                                    width: 180,
                                    render: (v: number) => (
                                        <Progress
                                            percent={v}
                                            size="small"
                                            status={v > 90 ? 'exception' : 'normal'}
                                        />
                                    )
                                },
                            ]}
                            size="small"
                            pagination={false}
                            scroll={{ y: 300 }}
                            rowKey="mount"
                        />
                    </Collapse.Panel>
                )}
            </Collapse>
        </Space>
    );
};

interface ModuleDetailProps {
    moduleKey: string;
    mode: 'local' | 'remote';
    osType: string;
    privilegeMode: 'none' | 'sudo' | 'su';
    sudoPassword: string;
    onNavigate?: (moduleKey: string, path?: string) => void;
    defaultDownloadPath?: string;
    isDarkMode: boolean;
    glassEnabled: boolean;
    wallpaper: string;
    searchKeyword?: string;
    setSearchKeyword?: (val: string) => void;
    timeRange?: 'all' | '1h' | '6h' | '24h' | '3d';
    setTimeRange?: (val: any) => void;
    compactHeader?: boolean;
}

interface SystemInfo {
    os_name: string;
    os_version: string;
    hostname: string;
    kernel_version: string;
    architecture: string;
    cpu_cores: number;
    cpu_model: string;
    total_memory_gb: number;
    used_memory_gb: number;
    cpu_usage: number;
    uptime_seconds: number;
    boot_time_str: string;
    timezone: string;
    current_time: string;
    disks: any[];
    ip_addresses: string[];
}

interface RemoteSystemInfo {
    hostname: string;
    os_type: string;
    os_version: string;
    ip_address: string;
    kernel: string;
    uptime: string;
    load_avg: string;
    cpu_cores: number;
    cpu_percent: number;
    mem_total: string;
    mem_used: string;
    mem_percent: number;
    timezone: string;
    disks: { mount: string; size: string; used: string; avail: string; percent: number }[];
    // 扩展字段
    os_name?: string;
    id_like?: string;
    version_id?: string;
    pretty_name?: string;
    home_url?: string;
    bug_report_url?: string;
    architecture?: string;
    cpu_model?: string;
    issue_info?: string;
    redhat_release?: string;
}

interface CollectionDiagnostic {
    reason: string;
    severity: 'warning' | 'error' | 'info';
    suggestion: string;
    evidence: string[];
}

interface MysqlUserInfo {
    key: number;
    user: string;
    host: string;
    raw: string;
}

function splitCommandSections(output: string): Record<string, string> {
    const parts = output.split(/===([\w_:./-]+)===/);
    const sections: Record<string, string> = {};
    for (let i = 1; i < parts.length; i += 2) {
        sections[parts[i]] = parts[i + 1]?.trim() || '';
    }
    return sections;
}

function splitMysqlOutputRow(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed || /^\+[-+]+\+$/.test(trimmed)) return [];

    if (trimmed.includes('|')) {
        return trimmed.split('|').map(v => v.trim()).filter(Boolean);
    }

    if (trimmed.includes('\t')) {
        return trimmed.split('\t').map(v => v.trim()).filter(Boolean);
    }

    return trimmed.split(/\s+/).map(v => v.trim()).filter(Boolean);
}

function parseMysqlDatabases(output: string): string[] {
    return output.split(/\r?\n/)
        .map(line => splitMysqlOutputRow(line)[0] || '')
        .map(name => name.trim())
        .filter(name => name && !/^database(?:\s*\(.+\))?$/i.test(name))
        .filter(name => !/^(total|总用量)$/i.test(name));
}

function parseMysqlUsers(output: string): MysqlUserInfo[] {
    return output.split(/\r?\n/)
        .map((line, index) => {
            const cells = splitMysqlOutputRow(line);
            if (cells.length < 2) return null;

            const [user, host] = cells;
            if (/^user$/i.test(user) && /^host$/i.test(host)) return null;

            return {
                key: index,
                user: user || '-',
                host: host || '%',
                raw: line.trim(),
            };
        })
        .filter((row): row is MysqlUserInfo => Boolean(row));
}

function parseMysqlDatadir(output: string): string {
    const cleanValue = (value: string) => value.replace(/^['"`]+|['"`;]+$/g, '').trim();

    for (const line of output.split(/\r?\n/)) {
        const cells = splitMysqlOutputRow(line);
        const keyIndex = cells.findIndex(cell => /^datadir$/i.test(cell.replace(/['"`]/g, '')));
        if (keyIndex >= 0 && cells[keyIndex + 1]) {
            return cleanValue(cells[keyIndex + 1]);
        }

        const match = line.match(/\bdatadir\b\s*(?:[|=:]|\s{2,}|\t)\s*([^\s|]+)/i);
        if (match?.[1]) {
            return cleanValue(match[1]);
        }
    }

    return '';
}

const moduleLabels: Record<string, string> = {
    system_info: '系统信息',
    process_list: '进程列表',
    service_list: '系统服务',
    user_list: '用户列表',
    logged_users: '已登录用户',
    startup: '自启动信息',
    cron: '计划任务',
    history_cmd: '历史命令',
    disk_info: '磁盘信息',
    installed_software: '安装软件',
    network_conn: '网络连接',
    listen_ports: '监听端口',
    hosts_file: 'Hosts文件',
    dns_config: 'DNS配置',
    ssh_keys: 'SSH密钥',
    sudo_config: 'Sudo配置',
    ioc_file_search: 'IOC 文件搜索',
    file_scan: '文件扫描',
    suspicious_files: '可疑文件',
    webshell_scan: 'Webshell扫描',
    docker: 'Docker容器',
    docker_images: 'Docker镜像',
    panel: '面板检测',
    database: '数据库检测',
    terminal: '远程终端',
    firewall: '防火墙规则',
    // Linux日志
    auth_log: '认证日志',
    syslog: '系统日志',
    dmesg: '内核日志',
    failed_logins: '登录失败',
    login_history: '登录历史',
    lastlog: '最后登录',
    cron_log: '定时任务日志',
    web_access_log: 'Web访问日志',
    // 用户痕迹
    sudo_log: 'Sudo日志',
    bashrc_check: 'Bashrc检查',
    profile_check: 'Profile检查',
    recent_files: '最近访问文件',
    // 系统深度分析
    env_vars: '环境变量',
    ulimit_config: '系统限制',
    pam_config: 'PAM配置',
    sudoers_config: 'Sudoers配置',
    selinux_status: 'SELinux状态',
    // 工具
    file_manager: '文件管理',
    // Windows专用
    registry: '注册表分析',
    win_defender: 'Defender状态',
    win_firewall: 'Windows防火墙',
    win_security_log: '安全日志',
    win_system_log: '系统日志',
    win_app_log: '应用程序日志',
    win_powershell_log: 'PowerShell日志',
    security_events: '安全事件',
    process_anomaly: '进程异常检测',
    persistence: '持久化检测',
    rdp: 'RDP远程分析',
    browser: '浏览器历史',
    software: '软件安装分析',
    execution_trace: '执行痕迹',
    powershell_deep: 'PowerShell深度',
    defender_history: 'Defender检测历史',
    rdp_logon_trace: 'RDP登录链路',
    wmi_persistence: 'WMI持久化',
    bits_jobs: 'BITS任务',
    registry_persistence_deep: '注册表深度持久化',
};

const windowsModuleMeta: Record<string, { title: string; group: string; description: string }> = {
    system_info: { title: '主机概况', group: '系统总览', description: '操作系统、主机名、CPU、内存、启动时间与网络地址。' },
    disk_info: { title: '磁盘与卷', group: '系统总览', description: '本机卷、容量、可用空间和文件系统状态。' },
    env_vars: { title: '环境变量', group: '系统总览', description: '当前用户和系统进程可见的环境变量，重点关注 PATH、TEMP、代理和凭据痕迹。' },
    installed_software: { title: '软件清单', group: '系统总览', description: '注册表安装项、发布者、版本、安装路径和卸载命令。' },
    software: { title: '软件安装分析', group: '应用与服务', description: '以软件清单为基础梳理可疑安装项、异常路径和近期变更。' },
    user_list: { title: '本地账户', group: '身份与进程', description: '本地用户启用状态、描述信息和可登录性。' },
    logged_users: { title: '登录会话', group: '身份与进程', description: '当前控制台、RDP 和历史会话痕迹。' },
    process_list: { title: '运行进程', group: '身份与进程', description: '进程 PID、资源占用、进程名和可见路径。' },
    service_list: { title: '系统服务', group: '身份与进程', description: 'Windows 服务状态、启动类型和显示名称。' },
    process_anomaly: { title: '进程异常', group: '身份与进程', description: '高资源占用、临时目录运行、隐藏差异和可疑路径。' },
    startup: { title: '自启动项', group: '入口与持久化', description: 'Win32 启动项、命令、位置和归属用户。' },
    cron: { title: '计划任务', group: '入口与持久化', description: 'Task Scheduler 任务、动作、触发器、运行结果和作者。' },
    registry: { title: '注册表关键项', group: '入口与持久化', description: '常见 Run 键和持久化相关注册表值。' },
    persistence: { title: '持久化检测', group: '入口与持久化', description: '计划任务、自动服务、启动目录等持久化入口聚合。' },
    registry_persistence_deep: { title: '注册表深度持久化', group: '入口与持久化', description: 'IFEO Debugger、AppInit_DLLs、Winlogon、LSA 和可疑自动服务入口。' },
    wmi_persistence: { title: 'WMI 持久化', group: '入口与持久化', description: 'root\\subscription 下的事件过滤器、消费者和绑定关系。' },
    bits_jobs: { title: 'BITS 任务', group: '入口与持久化', description: '后台智能传输任务、远程 URL、本地文件和任务状态。' },
    rdp: { title: 'RDP 远程入口', group: '入口与持久化', description: '3389 连接、TermService 状态和远程桌面注册表配置。' },
    network_conn: { title: '活动连接', group: '网络暴露', description: 'TCP/UDP 连接、远端地址、状态、进程和路径。' },
    listen_ports: { title: '监听端口', group: '网络暴露', description: '监听服务、绑定地址、端口、PID 和进程路径。' },
    win_firewall: { title: 'Windows 防火墙', group: '网络暴露', description: '域、专用、公用配置文件状态与策略配置。' },
    dns_config: { title: 'DNS 配置', group: '网络暴露', description: '网卡 DNS 服务器和解析配置。' },
    hosts_file: { title: 'Hosts 文件', group: '网络暴露', description: 'Hosts 静态解析记录，关注劫持和异常域名。' },
    win_defender: { title: 'Defender 状态', group: '安全与日志', description: '实时防护、签名版本、引擎版本、扫描年龄和排除项。' },
    defender_history: { title: 'Defender 检测历史', group: '安全与日志', description: 'Defender 威胁、检测记录、隔离和排除项痕迹。' },
    security_events: { title: '高价值安全事件', group: '安全与日志', description: '登录失败、特权分配、账户变更、锁定等关键 Security 事件。' },
    rdp_logon_trace: { title: 'RDP 登录链路', group: '安全与日志', description: 'Security 登录事件和 TerminalServices 通道中的远程桌面登录链路。' },
    win_security_log: { title: 'Security 日志', group: '安全与日志', description: 'Windows Security 事件日志近端记录。' },
    win_system_log: { title: 'System 日志', group: '安全与日志', description: 'Windows System 事件日志近端记录。' },
    win_app_log: { title: 'Application 日志', group: '安全与日志', description: 'Windows Application 事件日志近端记录。' },
    win_powershell_log: { title: 'PowerShell 日志', group: '安全与日志', description: 'Windows PowerShell 事件日志和脚本执行痕迹。' },
    powershell_deep: { title: 'PowerShell 深度', group: '安全与日志', description: '4103/4104 脚本块日志、Windows PowerShell 事件和 PSReadLine 历史。' },
    ioc_file_search: { title: 'IOC 文件搜索', group: '文件与痕迹', description: '通过 Everything 索引按文件名、路径、扩展名和日期条件定位文件。' },
    file_scan: { title: '文件扫描', group: '文件与痕迹', description: '临时目录、用户可写目录和 Web 根目录中的近期/可执行文件。' },
    suspicious_files: { title: '可疑文件', group: '文件与痕迹', description: '临时目录可执行文件、隐藏可执行文件和近期变更。' },
    execution_trace: { title: '执行痕迹', group: '文件与痕迹', description: 'Prefetch、Amcache、ShimCache 等程序执行痕迹入口。' },
    recent_files: { title: '最近访问', group: '文件与痕迹', description: '用户目录近期访问和修改的文件痕迹。' },
    browser: { title: '浏览器痕迹', group: '文件与痕迹', description: 'Chrome、Edge、Firefox 配置目录和历史数据库位置。' },
    webshell_scan: { title: 'Webshell 扫描', group: '文件与痕迹', description: 'IIS、phpStudy、XAMPP、Wamp、宝塔等常见 Web 根目录关键函数命中。' },
    docker: { title: 'Docker 容器', group: '应用与服务', description: '本机 Docker 容器清单、运行状态、镜像和端口暴露。' },
    docker_images: { title: 'Docker 镜像', group: '应用与服务', description: '本机 Docker 镜像仓库、标签、镜像 ID、大小和创建时间。' },
    panel: { title: '面板检测', group: '应用与服务', description: 'Windows Web 面板、站点目录和 IIS 信息探测。' },
    database: { title: '数据库检测', group: '应用与服务', description: 'SQL Server、MySQL、PostgreSQL、Redis、MongoDB、Oracle 等数据库服务、端口和进程。' },
};

const getWindowsModuleMeta = (moduleKey: string) => windowsModuleMeta[moduleKey] || windowsModuleMeta[moduleKey === 'software' ? 'installed_software' : moduleKey];

const linuxModuleMeta: Record<string, { title: string; group: string; description: string; tool?: string }> = {
    system_info: { title: '系统信息', group: '主机概览', description: '汇总远程 Linux 主机版本、资源压力、网络地址和磁盘使用情况。' },
    process_list: { title: '进程列表', group: '主机概览', description: '远程主机运行进程、资源占用和命令基线。' },
    process_anomaly: { title: '进程异常检测', group: '主机概览', description: '比对 /proc、ps 和敏感路径，定位隐藏进程、删除进程和高资源占用。' },
    service_list: { title: '系统服务', group: '主机概览', description: '汇总 systemd 与 SysV 服务状态，快速识别异常服务。', tool: 'systemctl' },
    user_list: { title: '用户列表', group: '身份与访问', description: '解析 /etc/passwd 中的账号、UID、主目录和登录 shell。' },
    logged_users: { title: '已登录用户', group: '身份与访问', description: '查看当前登录会话和近期登录来源。', tool: 'who / last' },
    startup: { title: '自启动信息', group: '持久化', description: '检查启用服务、init.d 入口和系统自启动脚本。', tool: 'systemctl' },
    cron: { title: '计划任务(Cron)', group: '持久化', description: '聚合用户 crontab、/etc/cron*、spool cron 和 systemd timers。', tool: 'cron' },
    history_cmd: { title: '历史命令', group: '用户痕迹', description: '读取 shell 历史，辅助还原用户操作链。' },
    disk_info: { title: '磁盘信息', group: '主机概览', description: '查看文件系统容量、挂载点和使用率。', tool: 'df' },
    installed_software: { title: '安装软件', group: '资产清单', description: '汇总 dpkg、rpm、pacman、apk 等包管理器的软件清单。' },
    network_conn: { title: '网络连接', group: '网络暴露', description: '展示活动 TCP/UDP 连接、远端地址和进程映射。', tool: 'ss' },
    listen_ports: { title: '监听端口', group: '网络暴露', description: '定位监听端口、绑定地址和对应进程。', tool: 'ss' },
    hosts_file: { title: 'Hosts 文件', group: '网络暴露', description: '检查静态域名解析和可疑覆盖记录。' },
    dns_config: { title: 'DNS 配置', group: '网络暴露', description: '解析 resolv.conf 中的 nameserver、search 和 options 配置。' },
    firewall: { title: '防火墙规则', group: '网络暴露', description: '读取 iptables、ufw、firewalld 或 nftables 规则。' },
    ssh_keys: { title: 'SSH 密钥', group: '身份与访问', description: '检查用户和 root 的 SSH 密钥文件、授权入口和权限线索。' },
    sudo_config: { title: 'Sudo 配置', group: '身份与访问', description: '读取 sudoers 授权规则和潜在提权配置。' },
    suspicious_files: { title: '可疑文件', group: '文件与痕迹', description: '扫描 SUID/SGID、临时目录可执行文件和近期变更系统文件。' },
    webshell_scan: { title: 'Webshell 扫描', group: '文件与痕迹', description: '在 Web 根目录中查找 PHP/JSP/ASP 高风险函数命中。' },
    docker: { title: 'Docker 容器', group: '应用与服务', description: '列出容器状态、镜像、端口映射并支持日志和文件查看。', tool: 'docker' },
    docker_images: { title: 'Docker 镜像', group: '应用与服务', description: '列出镜像仓库、标签、镜像 ID、大小和创建时间。', tool: 'docker' },
    panel: { title: '面板检测', group: '应用与服务', description: '检测宝塔等 Web 面板配置、站点、数据库和日志线索。' },
    database: { title: '数据库检测', group: '应用与服务', description: '检查 MySQL、PostgreSQL、Redis、MongoDB 等数据库服务状态和清单。' },
    auth_log: { title: '认证日志', group: '日志分析', description: '解析 SSH 和系统认证日志中的登录、失败与授权事件。', tool: 'journalctl' },
    syslog: { title: '系统日志', group: '日志分析', description: '结构化系统日志，按进程、来源和严重性排查异常。', tool: 'journalctl' },
    dmesg: { title: '内核日志', group: '日志分析', description: '查看内核事件、驱动异常和安全相关内核日志。', tool: 'dmesg' },
    failed_logins: { title: '登录失败', group: '日志分析', description: '提取失败登录、无效用户和来源 IP。', tool: 'auth log' },
    login_history: { title: '登录历史', group: '日志分析', description: '查看 last 登录历史、登出时间和会话状态。', tool: 'last' },
    lastlog: { title: '最后登录', group: '日志分析', description: '汇总账号最后登录时间和终端来源。', tool: 'lastlog' },
    cron_log: { title: '定时任务日志', group: '日志分析', description: '检查 cron 执行记录和异常定时行为。', tool: 'journalctl' },
    web_access_log: { title: 'Web 访问日志', group: '日志分析', description: '解析 Nginx、Apache、httpd 和面板站点访问日志。' },
    sudo_log: { title: 'Sudo 日志', group: '用户痕迹', description: '提取 sudo 提权用户、目标用户、目录和执行命令。' },
    bashrc_check: { title: 'Bashrc 检查', group: '用户痕迹', description: '检查 shell 启动脚本中的别名、外联和可疑执行片段。' },
    profile_check: { title: 'Profile 检查', group: '用户痕迹', description: '检查系统和用户 profile 脚本中的持久化入口。' },
    recent_files: { title: '最近访问文件', group: '用户痕迹', description: '枚举近期变更文件，并标记敏感路径和风险类别。' },
    env_vars: { title: '环境变量', group: '深度分析', description: '识别代理、凭据、路径劫持和敏感环境变量。' },
    ulimit_config: { title: '系统限制', group: '深度分析', description: '展示 ulimit 输出和 limits.conf 规则。' },
    pam_config: { title: 'PAM 配置', group: '深度分析', description: '解析 PAM 服务、控制项、模块和认证安全配置。' },
    sudoers_config: { title: 'Sudoers 配置', group: '深度分析', description: '结构化 sudoers 主体、主机、run-as 和命令授权。' },
    selinux_status: { title: 'SELinux 状态', group: '深度分析', description: '检查 SELinux 或 AppArmor 启用状态和策略配置。' },
};

const getLinuxModuleMeta = (moduleKey: string) => linuxModuleMeta[moduleKey] || {
    title: moduleLabels[moduleKey] || moduleKey,
    group: 'Linux 分析',
    description: '通过 SSH 采集目标 Linux 主机数据并结构化展示。',
    tool: 'SSH Shell',
};

export const windowsLocalColumnTitles: Record<string, Record<string, string>> = {
    process_list: { user: '用户', pid: 'PID', cpu: 'CPU', mem: '内存', command: '进程名', path: '进程路径' },
    user_list: { username: '用户名', userType: '状态', comment: '描述', home: '用户目录', canLogin: '可登录', lastLogon: '最后登录' },
    logged_users: { user: '用户', terminal: '会话', sessionId: '会话 ID', state: '状态', idleTime: '空闲', time: '登录时间', ip: '来源地址', source: '来源' },
    service_list: { unit: '服务名', load: '加载', active: '状态', sub: '启动类型', description: '显示名称' },
    disk_info: { filesystem: '卷标', size: '容量', used: '已用', avail: '可用', percent: '使用率', mount: '盘符' },
    installed_software: { status: '状态', name: '软件名', version: '版本', publisher: '发布者', size: '大小', date: '安装日期', installLocation: '安装路径', uninstallCommand: '卸载命令', infoUrl: '信息链接' },
    software: { status: '状态', name: '软件名', version: '版本', publisher: '发布者', size: '大小', date: '安装日期', installLocation: '安装路径', uninstallCommand: '卸载命令', infoUrl: '信息链接' },
    network_conn: { protocol: '协议', local: '本地地址', peer: '远端地址', state: '状态', pid: 'PID', process: '进程', processPath: '进程路径' },
    listen_ports: { state: '状态', local: '本地地址', address: '绑定地址', port: '端口', pid: 'PID', process: '进程', processPath: '进程路径', peer: '远端地址' },
    startup: { unit: '启动项', state: '状态', preset: '用户', command: '命令', location: '位置', description: '描述' },
    cron: { taskPath: '任务路径', taskName: '任务名', state: '状态', actions: '动作', triggers: '触发器', lastRunTime: '上次运行', nextRunTime: '下次运行', lastResult: '结果', author: '作者', description: '描述' },
    registry: { section: '区域', name: '名称', command: '值 / 命令' },
    persistence: { type: '入口类型', name: '名称', status: '状态', detail: '动作 / 路径', trigger: '触发器', user: '用户', location: '位置' },
    registry_persistence_deep: { category: '类别', source: '来源', name: '名称', path: '路径', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    wmi_persistence: { category: '类别', source: '来源', name: '名称', path: '命名空间', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    bits_jobs: { category: '类别', source: '来源', name: '任务名', path: '路径 / URL', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    rdp: { type: '类型', local: '本地', remote: '远端', state: '状态', pid: 'PID', process: '进程', name: '名称', detail: '详情' },
    win_firewall: { profile: '配置文件', state: '状态', setting: '配置项', value: '值', raw: '原始行' },
    hosts_file: { ip: 'IP 地址', hostname: '主机名', risk: '风险', note: '说明' },
    dns_config: { interface: '网络接口', dns: 'DNS 服务器' },
    win_defender: { element: '检测项', status: '状态', value: '值' },
    defender_history: { category: '类别', source: '来源', name: '威胁 / 项目', path: '路径', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    security_events: { eventId: '事件 ID', time: '时间', eventType: '事件类型', username: '账号', sourceIp: '来源 IP', logonType: '登录类型', status: '状态', suspicious: '可疑', description: '描述' },
    rdp_logon_trace: { category: '类别', source: '来源', name: '事件', path: '通道', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    win_security_log: { time: '时间', id: '事件 ID', content: '消息' },
    win_system_log: { time: '时间', id: '事件 ID', content: '消息' },
    win_app_log: { time: '时间', id: '事件 ID', content: '消息' },
    win_powershell_log: { time: '时间', id: '事件 ID', content: '消息' },
    powershell_deep: { category: '类别', source: '来源', name: '事件 / 历史', path: '通道 / 文件', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    file_scan: { section: '类别', name: '文件名', path: '路径', directory: '目录', size: '大小', modified: '修改时间', extension: '扩展名', risk: '风险' },
    suspicious_files: { type: '类型', filename: '文件名', path: '路径', directory: '目录', risk: '风险', reason: '原因' },
    execution_trace: { category: '类别', source: '来源', name: '名称', path: '路径', time: '时间', detail: '详情', status: '状态', risk: '风险', eventId: '事件 ID', user: '账号', ip: '来源 IP' },
    recent_files: { name: '文件名', lastAccess: '最后访问时间', path: '路径', targetPath: '目标路径' },
    env_vars: { name: '变量名', risk: '风险', category: '分类', note: '说明', value: '值' },
    browser: { name: '浏览器', profile: '配置', value: '配置目录', lastWriteTime: '配置更新时间', historyPath: '历史库', historyLastWriteTime: '历史更新时间', status: '状态' },
    process_anomaly: { type: '异常类型', pid: 'PID', user: '用户', path: '路径 / 链接', detail: '详情', severity: '级别' },
    docker: { container_id: '容器 ID', image: '镜像', status: '状态', names: '名称', ports: '端口' },
    docker_images: { repository: '仓库', tag: '标签', image_id: '镜像 ID', size: '大小', created: '创建时间' },
    database: { source: '来源', name: '名称', type: '类型', status: '状态', port: '端口', pid: 'PID', version: '说明', path: '路径' },
};

const remoteCommands: Record<string, string> = {
    process_list: 'ps aux --sort=-%cpu 2>/dev/null',
    service_list: 'echo "===SYSTEMD_SERVICES==="; systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null; echo "===SYSV_SERVICES==="; service --status-all 2>/dev/null || chkconfig --list 2>/dev/null',
    user_list: 'cat /etc/passwd',
    logged_users: '(who -u 2>/dev/null || who 2>/dev/null) && echo "---LAST---" && last -n 50',
    startup: 'echo "===SYSTEMD_ENABLED==="; systemctl list-unit-files --type=service --state=enabled --no-pager --no-legend 2>/dev/null; echo "===INIT_D==="; find /etc/init.d -maxdepth 1 -type f -printf "%f\\n" 2>/dev/null || ls /etc/init.d/ 2>/dev/null',
    cron: `echo "===USER_CRONTAB:$(whoami 2>/dev/null || echo current)==="; crontab -l 2>/dev/null; echo "===ETC_CRONTAB==="; cat /etc/crontab 2>/dev/null; if [ -d /etc/cron.d ]; then for f in /etc/cron.d/*; do [ -f "$f" ] || continue; echo "===CRON_D:$(basename "$f")==="; cat "$f" 2>/dev/null; done; fi; for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do [ -d "$d" ] || continue; echo "===CRON_DIR:$d==="; find "$d" -maxdepth 1 -type f -printf "%f\\n" 2>/dev/null || ls "$d" 2>/dev/null; done; for d in /var/spool/cron /var/spool/cron/crontabs; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -f "$f" ] || continue; echo "===SPOOL_CRON:$(basename "$f")==="; cat "$f" 2>/dev/null; done; done; echo "===SYSTEMD_TIMERS==="; systemctl list-timers --all --no-pager --no-legend 2>/dev/null`,
    history_cmd: 'cat ~/.bash_history ~/.zsh_history 2>/dev/null',
    disk_info: 'df -h',
    installed_software: 'echo "===DPKG==="; dpkg -l 2>/dev/null; echo "===RPM==="; rpm -qa 2>/dev/null; echo "===PACMAN==="; pacman -Q 2>/dev/null; echo "===APK==="; apk info -v 2>/dev/null',
    network_conn: 'ss -tunp 2>/dev/null || netstat -tunp 2>/dev/null || ss -tun 2>/dev/null || netstat -tun 2>/dev/null',
    listen_ports: 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null',
    hosts_file: 'cat /etc/hosts',
    dns_config: 'cat /etc/resolv.conf',
    ssh_keys: 'echo "===SSH_DIR:~/.ssh==="; ls -la ~/.ssh/ 2>/dev/null; echo "===SSH_DIR:/root/.ssh==="; ls -la /root/.ssh/ 2>/dev/null',
    sudo_config: 'echo "===SUDOERS==="; grep -v "^#" /etc/sudoers 2>/dev/null | grep -v "^$"; if [ -d /etc/sudoers.d ]; then for f in /etc/sudoers.d/*; do [ -f "$f" ] || continue; echo "===SUDOERS_D:$(basename "$f")==="; grep -v "^#" "$f" 2>/dev/null | grep -v "^$"; done; fi',
    firewall: 'iptables -L -n 2>/dev/null || ufw status verbose 2>/dev/null || firewall-cmd --list-all 2>/dev/null || nft list ruleset 2>/dev/null',
    docker: 'docker ps -a --format "{{.ID}}|{{.Image}}|{{.Status}}|{{.Names}}|{{.Ports}}" 2>/dev/null',
    docker_images: 'docker images --format "{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}" 2>/dev/null',
    panel: `echo "===BT_DETECT==="; ls -la /www/server/panel/ 2>/dev/null; echo "===BT_CONFIG==="; cat /www/server/panel/data/default.pl 2>/dev/null; echo "===BT_USERNAME==="; cat /www/server/panel/data/admin_path.pl 2>/dev/null; echo "===BT_PORT==="; cat /www/server/panel/data/port.pl 2>/dev/null; echo "===BT_BIND==="; cat /www/server/panel/data/bind.pl 2>/dev/null; echo "===BT_DB_ROOT==="; cat /www/server/panel/data/db.pl /www/server/panel/data/mysql_root.pl /www/server/data/default.db.pl 2>/dev/null | head -1; echo "===BT_BASICAUTH==="; cat /www/server/panel/data/basic_auth.json 2>/dev/null; echo "===BT_USERINFO==="; cat /www/server/panel/data/userInfo.json 2>/dev/null; echo "===BT_SITES==="; ls -la /www/wwwroot 2>/dev/null; echo "===BT_VHOST==="; cat /www/server/panel/vhost/nginx/*.conf 2>/dev/null | head -300; echo "===BT_DATABASES==="; ls -la /www/server/data 2>/dev/null; echo "===BT_CRONTAB==="; cat /var/spool/cron/root 2>/dev/null; crontab -l 2>/dev/null; echo "===BT_FIREWALL==="; cat /www/server/panel/data/firewall.json 2>/dev/null; echo "===BT_PANEL_LOGS==="; tail -100 /www/server/panel/logs/error.log 2>/dev/null; echo "===BT_PY_QUERY==="; /www/server/panel/pyenv/bin/python3 -c "import sqlite3;c=sqlite3.connect('/www/server/panel/data/default.db').cursor();print('USERS:');[print(r) for r in c.execute('SELECT id,username,password,salt FROM users')];print('SITES:');[print(r) for r in c.execute('SELECT id,name,path,status,ps FROM sites')];print('DATABASES:');[print(r) for r in c.execute('SELECT id,name,username,password,accept,ps FROM databases')];print('LOGS:');[print(r) for r in c.execute('SELECT id,type,log,addtime FROM logs ORDER BY id DESC LIMIT 30')]" 2>/dev/null || /www/server/panel/pyenv/bin/python -c "import sqlite3;c=sqlite3.connect('/www/server/panel/data/default.db').cursor();print('USERS:');[print(r) for r in c.execute('SELECT id,username,password,salt FROM users')];print('SITES:');[print(r) for r in c.execute('SELECT id,name,path,status,ps FROM sites')];print('DATABASES:');[print(r) for r in c.execute('SELECT id,name,username,password,accept,ps FROM databases')];print('LOGS:');[print(r) for r in c.execute('SELECT id,type,log,addtime FROM logs ORDER BY id DESC LIMIT 30')]" 2>/dev/null || python3 -c "import sqlite3;c=sqlite3.connect('/www/server/panel/data/default.db').cursor();print('USERS:');[print(r) for r in c.execute('SELECT id,username,password,salt FROM users')];print('SITES:');[print(r) for r in c.execute('SELECT id,name,path,status,ps FROM sites')]" 2>/dev/null || python -c "import sqlite3;c=sqlite3.connect('/www/server/panel/data/default.db').cursor();print('USERS:');[print(r) for r in c.execute('SELECT id,username,password,salt FROM users')]" 2>/dev/null`,
    database: `echo "===MYSQL_VERSION==="; mysql --version 2>/dev/null || mysqld --version 2>/dev/null; echo "===MYSQL_STATUS==="; systemctl status mysql 2>/dev/null | head -5 || systemctl status mysqld 2>/dev/null | head -5 || service mysql status 2>/dev/null | head -3; echo "===MYSQL_ROOT_PWD==="; MYSQL_PWD_VAL=$(cat /www/server/panel/data/db.pl /www/server/panel/data/mysql_root.pl 2>/dev/null | head -1); echo "$MYSQL_PWD_VAL"; echo "===MYSQL_DATABASES==="; (if [ ! -z "$MYSQL_PWD_VAL" ]; then MYSQL_PWD="$MYSQL_PWD_VAL" mysql -u root -e "SHOW DATABASES;" 2>/dev/null; fi) || mysql -u root -e "SHOW DATABASES;" 2>/dev/null || (ls -1 /www/server/data /var/lib/mysql /usr/local/mysql/data 2>/dev/null | grep -vE "^(mysql|performance_schema|information_schema|sys|total|总用量)$"); echo "===MYSQL_USERS==="; (if [ ! -z "$MYSQL_PWD_VAL" ]; then MYSQL_PWD="$MYSQL_PWD_VAL" mysql -u root -e "SELECT user,host FROM mysql.user;" 2>/dev/null; fi) || mysql -u root -e "SELECT user,host FROM mysql.user;" 2>/dev/null; echo "===MYSQL_DATADIR==="; (if [ ! -z "$MYSQL_PWD_VAL" ]; then MYSQL_PWD="$MYSQL_PWD_VAL" mysql -u root -e "SHOW VARIABLES LIKE 'datadir';" 2>/dev/null; fi) || mysql -u root -e "SHOW VARIABLES LIKE 'datadir';" 2>/dev/null || (mysqladmin variables 2>/dev/null | grep datadir); echo "===MARIADB_VERSION==="; mariadb --version 2>/dev/null; echo "===POSTGRESQL_VERSION==="; psql --version 2>/dev/null; echo "===POSTGRESQL_STATUS==="; systemctl status postgresql 2>/dev/null | head -5; echo "===POSTGRESQL_DATABASES==="; sudo -u postgres psql -c "SELECT datname FROM pg_database WHERE datistemplate = false;" 2>/dev/null; echo "===REDIS_VERSION==="; redis-cli --version 2>/dev/null; echo "===REDIS_STATUS==="; systemctl status redis 2>/dev/null | head -5 || systemctl status redis-server 2>/dev/null | head -5; echo "===REDIS_INFO==="; redis-cli info 2>/dev/null | head -30; echo "===MONGODB_VERSION==="; mongod --version 2>/dev/null | head -2; echo "===MONGODB_STATUS==="; systemctl status mongod 2>/dev/null | head -5; echo "===MONGODB_DATABASES==="; mongo --eval "db.adminCommand('listDatabases')" 2>/dev/null || mongosh --eval "db.adminCommand('listDatabases')" 2>/dev/null`,
    // 日志分析命令
    auth_log: 'cat /var/log/auth.log 2>/dev/null || cat /var/log/secure 2>/dev/null || journalctl -t sshd -n 100 2>/dev/null',
    syslog: 'cat /var/log/syslog 2>/dev/null || cat /var/log/messages 2>/dev/null || journalctl -n 100 2>/dev/null',
    dmesg: 'dmesg --time-format iso 2>/dev/null || dmesg',
    failed_logins: 'grep -i "failed\\|failure\\|invalid" /var/log/auth.log 2>/dev/null || grep -i "failed\\|failure\\|invalid" /var/log/secure 2>/dev/null || journalctl _SYSTEMD_UNIT=sshd.service | grep -i "failed\\|failure"',
    login_history: 'last -F 2>/dev/null || last 2>/dev/null',
    lastlog: 'lastlog 2>/dev/null',
    cron_log: 'grep -i cron /var/log/syslog 2>/dev/null || grep -i cron /var/log/messages 2>/dev/null || journalctl _COMM=cron -n 100 2>/dev/null',
    web_access_log: 'cat /var/log/nginx/access.log* 2>/dev/null || cat /var/log/apache2/access.log* 2>/dev/null || cat /var/log/httpd/access_log* 2>/dev/null || cat /www/wwwlogs/*.log 2>/dev/null',
    // 安全扫描命令
    suspicious_files: `echo "===SUID===" && timeout 10 find /usr /bin /sbin -perm -4000 -type f 2>/dev/null | head -30 && echo "===SGID===" && timeout 10 find /usr /bin /sbin -perm -2000 -type f 2>/dev/null | head -30 && echo "===WORLD_WRITABLE===" && timeout 5 find /etc /var/log -perm -0002 -type f 2>/dev/null | head -20 && echo "===HIDDEN_EXE===" && find /tmp /var/tmp /dev/shm -name ".*" -type f -executable 2>/dev/null && echo "===TEMP_EXE===" && find /tmp /var/tmp /dev/shm -type f -executable 2>/dev/null | head -30 && echo "===RECENT_MODIFIED===" && find /bin /sbin /usr/bin /usr/sbin -mtime -7 -type f 2>/dev/null | head -20`,
    webshell_scan: `echo "===PHP===" && timeout 15 grep -rn --include="*.php" -E "eval\\(|base64_decode\\(|system\\(|exec\\(|shell_exec\\(" /var/www /www 2>/dev/null | head -30 && echo "===JSP===" && timeout 10 grep -rn --include="*.jsp" -E "ProcessBuilder|Runtime.getRuntime" /var 2>/dev/null | head -20 && echo "===ASP===" && timeout 10 grep -rn --include="*.asp*" -E "execute|eval|WScript" /var/www /www /inetpub 2>/dev/null | head -20`,
    // 用户痕迹分析命令
    sudo_log: 'grep -i sudo /var/log/auth.log 2>/dev/null || grep -i sudo /var/log/secure 2>/dev/null || journalctl _COMM=sudo -n 100 2>/dev/null',
    bashrc_check: 'echo "===ROOT===" && cat /root/.bashrc 2>/dev/null && echo "===USERS===" && cat /home/*/.bashrc 2>/dev/null',
    profile_check: 'echo "===PROFILE_D===" && ls -la /etc/profile.d/ 2>/dev/null && cat /etc/profile.d/*.sh 2>/dev/null && echo "===USER_PROFILE===" && cat /home/*/.profile 2>/dev/null && cat /home/*/.bash_profile 2>/dev/null',
    recent_files: 'find /home /root /tmp -type f -mtime -1 2>/dev/null | head -100',
    // 系统深度分析命令
    env_vars: 'env 2>/dev/null',
    ulimit_config: 'ulimit -a 2>/dev/null && echo "===LIMITS_CONF===" && cat /etc/security/limits.conf 2>/dev/null | grep -v "^#" | grep -v "^$"',
    pam_config: 'ls -la /etc/pam.d/ 2>/dev/null && echo "===COMMON_AUTH===" && cat /etc/pam.d/common-auth 2>/dev/null && echo "===SSHD===" && cat /etc/pam.d/sshd 2>/dev/null',
    sudoers_config: 'cat /etc/sudoers 2>/dev/null | grep -v "^#" | grep -v "^$" && echo "===SUDOERS_D===" && cat /etc/sudoers.d/* 2>/dev/null',
    selinux_status: 'sestatus 2>/dev/null || aa-status 2>/dev/null || cat /etc/selinux/config 2>/dev/null | grep "^SELINUX=" || echo "SELinux/AppArmor 未启用"',
    process_anomaly: `echo "===HIDDEN===" && ps -ef | awk '{print $2}' | sort -n > /tmp/ps_pids && ls /proc | grep -E '^[0-9]+$' | sort -n > /tmp/proc_pids && diff /tmp/ps_pids /tmp/proc_pids | grep ">" | awk '{print $2}' && rm /tmp/ps_pids /tmp/proc_pids && echo "===DELETED===" && ls -al /proc/*/exe 2>/dev/null | grep "deleted" | awk '{print $11, $1, $3}' && echo "===SENSITIVE_PATH===" && ps auxww | grep -E "/tmp/|/dev/shm/|/var/tmp/" | grep -v grep | awk '{print $2, $1, $11}' && echo "===HIGH_RESOURCES===" && ps aux --sort=-%cpu | head -6`,
    // Windows 专用命令 (PowerShell)
    win_security_log: 'try { Get-WinEvent -LogName Security | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[需要管理员权限] 请以管理员身份运行程序来查看安全日志" }',
    win_system_log: 'try { Get-WinEvent -LogName System | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_app_log: 'try { Get-WinEvent -LogName Application | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_powershell_log: 'try { Get-WinEvent -LogName "Windows PowerShell" | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_firewall: 'netsh advfirewall show allprofiles',
    registry: 'powershell -Command "echo ===HKLM_RUN===; Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 2>$null; echo ===HKCU_RUN===; Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 2>$null"',
};

// Windows 本地模式专用命令映射
const windowsWebshellDefaultRoots = [
    'C:\\inetpub\\wwwroot',
    'C:\\phpstudy_pro\\WWW',
    'C:\\xampp\\htdocs',
    'C:\\wamp64\\www',
    'C:\\BtSoft\\WebSites',
    'C:\\BtSoft\\wwwroot',
    'C:\\tomcat\\webapps',
];

function escapePowerShellSingleQuoted(value: string): string {
    return value.replace(/'/g, "''");
}

function quotePowerShellLiteral(value: string): string {
    return `'${escapePowerShellSingleQuoted(value)}'`;
}

function buildWindowsPreviewTextCommand(path: string): string {
    return `$ErrorActionPreference='Stop'; Get-Content -LiteralPath ${quotePowerShellLiteral(path)} -Encoding UTF8 -TotalCount 5000 -ErrorAction Stop`;
}

function buildWindowsPreviewBase64Command(path: string): string {
    return `$ErrorActionPreference='Stop'; $path=${quotePowerShellLiteral(path)}; [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))`;
}

function buildWindowsPreviewHexCommand(path: string): string {
    return `$ErrorActionPreference='Stop'; $path=${quotePowerShellLiteral(path)}; $stream=[IO.File]::OpenRead($path); try { $buffer=New-Object byte[] 65536; $read=$stream.Read($buffer,0,$buffer.Length); if ($read -le 0) { '' } else { -join ($buffer[0..($read-1)] | ForEach-Object { $_.ToString('x2') }) } } finally { $stream.Dispose() }`;
}

function buildWindowsWebshellScanCommand(customRoots = ''): string {
    const customWindowsRoots = customRoots
        .split(/\s+/)
        .map((root) => root.trim())
        .filter((root) => /^[a-zA-Z]:\\/.test(root) || root.startsWith('\\\\'));
    const roots = Array.from(new Set([...windowsWebshellDefaultRoots, ...customWindowsRoots]));
    const rootList = roots.map((root) => `'${escapePowerShellSingleQuoted(root)}'`).join(',');

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$roots = @(@(${rootList}) | Where-Object { Test-Path $_ }); function Find-Hits($title, [string[]]$extensions, [string[]]$patterns, [int]$limit) { Write-Output $title; if ($roots.Count -eq 0) { return }; $files = @(Get-ChildItem -LiteralPath $roots -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() } | Select-Object -First 2000); if ($files.Count -eq 0) { return }; Select-String -Path @($files.FullName) -Pattern $patterns -ErrorAction SilentlyContinue | Select-Object -First $limit | ForEach-Object { '{0}:{1}:{2}' -f $_.Path, $_.LineNumber, ($_.Line -replace '\\r|\\n', ' ') } }; Find-Hits '===PHP===' @('.php','.phtml','.php5','.inc') @('eval\\s*\\(','base64_decode\\s*\\(','assert\\s*\\(','system\\s*\\(','exec\\s*\\(','shell_exec\\s*\\(','passthru\\s*\\(','preg_replace\\s*\\(.*/e') 80; Find-Hits '===JSP===' @('.jsp','.jspx') @('ProcessBuilder','Runtime\\.getRuntime','getParameter\\s*\\(','cmd\\.exe','/bin/sh') 60; Find-Hits '===ASP===' @('.asp','.aspx','.asa') @('eval\\s*\\(','execute\\s*\\(','WScript\\.Shell','Server\\.CreateObject','cmd\\.exe') 60"`;
}

function buildWindowsTcpConnectionCommand(listenOnly = false): string {
    const netCmdlet = listenOnly ? 'Get-NetTCPConnection -State Listen' : 'Get-NetTCPConnection';
    const fallbackFilter = listenOnly ? "if ($state -ne 'LISTENING') { continue };" : '';

    return `powershell.exe -NoProfile -Command "try { @(${netCmdlet} -ErrorAction Stop | ForEach-Object { $conn = $_; $proc = $null; try { $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop } catch {}; [pscustomobject]@{ LocalAddress=$conn.LocalAddress; LocalPort=$conn.LocalPort; RemoteAddress=$conn.RemoteAddress; RemotePort=$conn.RemotePort; State=[string]$conn.State; OwningProcess=$conn.OwningProcess; ProcessName=if ($proc) { $proc.ProcessName } else { '' }; ProcessPath=if ($proc) { $proc.Path } else { '' } } }) | ConvertTo-Json -Compress -Depth 3 } catch { $rows = foreach ($line in (netstat -ano)) { $trim = $line.Trim(); if (-not $trim.StartsWith('TCP')) { continue }; $parts = $trim -split '\\s+'; if ($parts.Count -lt 5) { continue }; $local = $parts[1]; $remote = $parts[2]; $state = $parts[3]; ${fallbackFilter} $pidValue = $parts[4]; $localMatch = [regex]::Match($local, '^(?<addr>.+):(?<port>\\d+|\\*)$'); $remoteMatch = [regex]::Match($remote, '^(?<addr>.+):(?<port>\\d+|\\*)$'); [pscustomobject]@{ LocalAddress=if ($localMatch.Success) { $localMatch.Groups['addr'].Value } else { $local }; LocalPort=if ($localMatch.Success) { $localMatch.Groups['port'].Value } else { '' }; RemoteAddress=if ($remoteMatch.Success) { $remoteMatch.Groups['addr'].Value } else { $remote }; RemotePort=if ($remoteMatch.Success) { $remoteMatch.Groups['port'].Value } else { '' }; State=if ($state -eq 'LISTENING') { 'Listen' } else { $state }; OwningProcess=$pidValue; ProcessName=''; ProcessPath='' } }; @($rows) | ConvertTo-Json -Compress -Depth 3 }"`;
}

function buildWindowsRdpCommand(): string {
    return `powershell.exe -NoProfile -Command "echo ===RDP_CONN===; try { @(Get-NetTCPConnection -LocalPort 3389 -ErrorAction Stop | ForEach-Object { $conn = $_; $proc = $null; try { $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop } catch {}; [pscustomobject]@{ LocalAddress=$conn.LocalAddress; LocalPort=$conn.LocalPort; RemoteAddress=$conn.RemoteAddress; RemotePort=$conn.RemotePort; State=[string]$conn.State; OwningProcess=$conn.OwningProcess; ProcessName=if ($proc) { $proc.ProcessName } else { '' }; ProcessPath=if ($proc) { $proc.Path } else { '' } } }) | ConvertTo-Json -Compress -Depth 4 } catch { $rows = foreach ($line in (netstat -ano)) { $trim = $line.Trim(); if (-not $trim.StartsWith('TCP')) { continue }; $parts = $trim -split '\\s+'; if ($parts.Count -lt 5) { continue }; $local = $parts[1]; $remote = $parts[2]; $state = $parts[3]; $pidValue = $parts[4]; $localMatch = [regex]::Match($local, '^(?<addr>.+):(?<port>\\d+|\\*)$'); if (-not $localMatch.Success -or $localMatch.Groups['port'].Value -ne '3389') { continue }; $remoteMatch = [regex]::Match($remote, '^(?<addr>.+):(?<port>\\d+|\\*)$'); [pscustomobject]@{ LocalAddress=$localMatch.Groups['addr'].Value; LocalPort=$localMatch.Groups['port'].Value; RemoteAddress=if ($remoteMatch.Success) { $remoteMatch.Groups['addr'].Value } else { $remote }; RemotePort=if ($remoteMatch.Success) { $remoteMatch.Groups['port'].Value } else { '' }; State=if ($state -eq 'LISTENING') { 'Listen' } else { $state }; OwningProcess=$pidValue; ProcessName=''; ProcessPath='' } }; @($rows) | ConvertTo-Json -Compress -Depth 4 }; echo ===RDP_SERVICE===; @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'TermService' } | ForEach-Object { [pscustomobject]@{ Name=$_.Name; DisplayName=$_.DisplayName; Status=$_.State; StartType=$_.StartMode; PathName=$_.PathName; StartName=$_.StartName } }) | ConvertTo-Json -Compress -Depth 4; echo ===RDP_REGISTRY===; $ts = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -ErrorAction SilentlyContinue; $tcp = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -ErrorAction SilentlyContinue; [pscustomobject]@{ fDenyTSConnections=if ($ts) { $ts.fDenyTSConnections } else { $null }; UserAuthentication=if ($tcp) { $tcp.UserAuthentication } else { $null }; SecurityLayer=if ($tcp) { $tcp.SecurityLayer } else { $null }; PortNumber=if ($tcp) { $tcp.PortNumber } else { 3389 } } | ConvertTo-Json -Compress -Depth 4"`;
}

function getPathBaseName(filePath: string): string {
    return filePath.split(/[\\/]/).pop() || filePath;
}

function getPathDirectory(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    parts.pop();
    if (parts.length === 0) return '-';
    const separator = filePath.includes('\\') ? '\\' : '/';
    return parts.join(separator) || separator;
}

function formatFileSize(bytes: any): string {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${rounded} ${units[unitIndex]}`;
}

function normalizeEverythingExtension(result: EverythingSearchResult): string {
    const explicit = result.extension?.trim();
    const inferred = result.name.includes('.') ? result.name.split('.').pop() : '';
    const extension = explicit || inferred || '';
    if (!extension) return '';
    return extension.startsWith('.') ? extension : `.${extension}`;
}

function normalizeEverythingExtensionFilter(value: string): string {
    return value
        .split(/[,\s;]+/)
        .map((item) => item.trim().replace(/^\.+/, '').toLowerCase())
        .filter(Boolean)
        .join(';');
}

function quoteEverythingValue(value: string): string {
    return `"${value.trim().replace(/"/g, '\\"')}"`;
}

function isMeaningfulEverythingLiveQuery(value: string): boolean {
    return value.trim().replace(/[*?]/g, '').length >= MIN_EVERYTHING_LIVE_QUERY_LENGTH;
}

function buildEverythingSearchQuery(parts: EverythingQueryParts): string {
    const tokens: string[] = [];
    const query = parts.query.trim();
    const extension = normalizeEverythingExtensionFilter(parts.extension);
    const hashValue = parts.hashValue.trim();
    const content = parts.content.trim();

    if (query) tokens.push(query);
    if (extension) tokens.push(`ext:${extension}`);
    if (hashValue) tokens.push(`${parts.hashAlgorithm}:${hashValue}`);
    if (content) tokens.push(`content:${quoteEverythingValue(content)}`);

    return tokens.join(' ');
}

function formatEverythingDate(value?: string | null): string {
    return (value || '')
        .replace('T', ' ')
        .replace(/\.\d+Z?$/, '')
        .replace(/Z$/, '');
}

async function searchEverythingFiles(request: EverythingSearchRequest): Promise<EverythingSearchResult[]> {
    return invoke<EverythingSearchResult[]>('everything_search', { request });
}

async function searchEverythingFilesPage(request: EverythingSearchRequest): Promise<EverythingSearchPageResponse> {
    return invoke<EverythingSearchPageResponse>('everything_search_page', { request });
}

function buildCollectionDiagnostic(output: string, mode: 'local' | 'remote', sourceKey?: string): CollectionDiagnostic | null {
    if (mode !== 'remote') return null;

    const label = sourceKey ? `${moduleLabels[sourceKey] || sourceKey} (${sourceKey})` : '当前模块';
    const evidence = output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 8);

    if (evidence.length === 0) {
        return {
            reason: '无输出',
            severity: 'info',
            suggestion: `${label}：目标命令未返回内容。请确认该模块在目标系统上存在对应数据，或切换 sudo/root 后重新采集。`,
            evidence: ['远程命令执行成功但没有 stdout/stderr 内容。'],
        };
    }

    const sectionOnlyOutput = evidence.every(line => /^===[^=]+===$/.test(line));
    if (sectionOnlyOutput) {
        return {
            reason: '未发现记录',
            severity: 'info',
            suggestion: `${label}：命令已成功执行，但目标系统没有返回该模块的实际记录。可切换提权模式、调整扫描目录，或确认目标服务是否安装。`,
            evidence,
        };
    }

    const diagnosticLines = evidence.filter(line => {
        const lower = line.toLowerCase();
        const hasDiagnosticPhrase = (
            lower.includes('permission denied') ||
            lower.includes('operation not permitted') ||
            lower.includes('command not found') ||
            lower.includes('no such file or directory') ||
            lower.includes('a password is required') ||
            lower.includes('authentication failure') ||
            lower.includes('not in the sudoers file') ||
            lower.includes('sudo: no tty present') ||
            lower.includes('incorrect password') ||
            lower.includes('cannot access')
        );
        const looksLikeCommandError = /(^|\s)(cat|grep|find|ls|journalctl|systemctl|crontab|sudo|su|bash|sh|timeout):/.test(lower) &&
            /\b(denied|not found|no such|cannot|failed|error|required|incorrect|authentication|permitted)\b/.test(lower);
        return (
            hasDiagnosticPhrase ||
            looksLikeCommandError
        );
    });

    if (diagnosticLines.length === 0 || diagnosticLines.length < evidence.length) return null;

    const joined = evidence.join('\n').toLowerCase();
    if (joined.includes('permission denied') || joined.includes('operation not permitted') || joined.includes('not in the sudoers file')) {
        return {
            reason: '权限不足',
            severity: 'warning',
            suggestion: `${label}：该模块需要读取系统级配置或日志。请在连接页选择 sudo 或 root 权限后重新采集。`,
            evidence,
        };
    }
    if (joined.includes('a password is required') || joined.includes('incorrect password') || joined.includes('authentication failure') || joined.includes('sudo: no tty present')) {
        return {
            reason: '提权失败',
            severity: 'error',
            suggestion: `${label}：sudo/su 未成功执行。请检查提权方式和密码，或改用具备 root 权限的账号重新连接。`,
            evidence,
        };
    }
    if (joined.includes('command not found')) {
        return {
            reason: '命令缺失',
            severity: 'warning',
            suggestion: `${label}：目标系统缺少该模块依赖的命令。可安装对应工具，或使用同类模块交叉验证。`,
            evidence,
        };
    }
    if (joined.includes('no such file or directory')) {
        return {
            reason: '路径不存在',
            severity: 'info',
            suggestion: `${label}：目标系统没有该默认路径或服务。可调整扫描目录，或确认服务是否安装。`,
            evidence,
        };
    }

    return {
        reason: '采集失败',
        severity: 'warning',
        suggestion: `${label}：远程命令返回了错误信息。请检查目标系统权限、命令可用性和模块配置后重试。`,
        evidence,
    };
}

function buildWindowsPowerShellCommand(script: string): string {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/\s+/g, ' ').trim()}"`;
}

function buildWindowsPanelDetectionCommand(): string {
    return buildWindowsPowerShellCommand(`
        $diagnostics = New-Object System.Collections.Generic.List[string];
        function Test-ExistingPath($path) { return (-not [string]::IsNullOrWhiteSpace($path)) -and (Test-Path -LiteralPath $path -ErrorAction SilentlyContinue); }
        function Convert-ToJsonArray([object[]]$items, [int]$depth) { $array = @($items); ConvertTo-Json -Compress -Depth $depth -InputObject $array; }
        function Get-FirstExistingPath($paths) { foreach ($path in @($paths)) { if (Test-ExistingPath $path) { return $path; } }; return ''; }
        function Test-TextMatch($value, $patterns) { if ([string]::IsNullOrWhiteSpace([string]$value)) { return $false; }; $text = [string]$value; foreach ($pattern in @($patterns)) { if (-not [string]::IsNullOrWhiteSpace([string]$pattern) -and $text.IndexOf([string]$pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true; } }; return $false; }
        function Get-SiteCount($root) { if (-not (Test-ExistingPath $root)) { return 0; }; return @((Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Select-Object -First 200)).Count; }
        function Get-PanelSites($panelType, $panelName, $siteRoot) { if (-not (Test-ExistingPath $siteRoot)) { return @(); }; @(Get-ChildItem -LiteralPath $siteRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 200 | ForEach-Object { [pscustomobject]@{ Source=$panelType; PanelType=$panelType; Name=$_.Name; Path=$_.FullName; State='Present'; Bindings='-'; OwnerPanel=$panelName; Length=0; LastWriteTime=$_.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss'); } }); }
        function Get-PathMetadata($source, $path, $note) { if (-not (Test-ExistingPath $path)) { return $null; }; try { $item = Get-Item -LiteralPath $path -ErrorAction Stop; $length = if ($item.PSIsContainer) { 0 } else { [int64]$item.Length }; return [pscustomobject]@{ Source=$source; Path=$item.FullName; Length=$length; LastWriteTime=$item.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss'); Note=$note; }; } catch { return $null; } }
        function Get-RelatedServices($source, $patterns, $paths) { @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { (Test-TextMatch $_.Name $patterns) -or (Test-TextMatch $_.DisplayName $patterns) -or (Test-TextMatch $_.PathName $patterns) -or (Test-TextMatch $_.PathName $paths) } | Select-Object -First 80 | ForEach-Object { [pscustomobject]@{ Source=$source; Name=$_.Name; DisplayName=$_.DisplayName; State=$_.State; StartMode=$_.StartMode; PathName=$_.PathName; ProcessId=$_.ProcessId; } }); }
        function Get-UninstallEvidence($patterns) { $keys = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); foreach ($key in $keys) { foreach ($entry in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) { if ((Test-TextMatch $entry.DisplayName $patterns) -or (Test-TextMatch $entry.InstallLocation $patterns)) { return [string]$entry.DisplayName; } } }; return ''; }
        function Get-EsPath { $processPath = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path; $processDir = if ([string]::IsNullOrWhiteSpace($processPath)) { '' } else { Split-Path -Parent $processPath; }; $cwd = (Get-Location).Path; $candidates = @($env:LUMINA_ES_PATH, (Join-Path $cwd 'src-tauri\\bin\\everything\\es.exe'), (Join-Path $cwd 'bin\\everything\\es.exe'), (Join-Path $processDir 'bin\\everything\\es.exe'), (Join-Path $processDir 'resources\\bin\\everything\\es.exe'), 'C:\\Program Files\\Everything\\es.exe', 'C:\\Program Files (x86)\\Everything\\es.exe'); foreach ($candidate in $candidates) { if (Test-ExistingPath $candidate) { return $candidate; } }; return ''; }
        function Convert-EsLine($line, $query) { if ([string]::IsNullOrWhiteSpace($line)) { return $null; }; $columns = $line.TrimEnd([char]13).Split([char]9); if ($columns.Count -lt 6) { return $null; }; $length = [int64]0; [void][Int64]::TryParse(($columns[4] -replace ',', '').Trim(), [ref]$length); return [pscustomobject]@{ Source='everything'; Query=$query; FullPath=$columns[0].TrimStart([char]0xfeff); Name=$columns[1]; ParentPath=$columns[2]; Extension=$columns[3]; Length=$length; LastWriteTime=$columns[5]; }; }
        function Invoke-EsQuery($esPath, $query, $limit) { if ([string]::IsNullOrWhiteSpace($esPath)) { return @(); }; $args = @('-tsv','-no-header','-full-path-and-name','-name','-path-column','-extension','-size','-date-modified','-date-format','1','-size-format','1','-no-digit-grouping','-timeout','3000','-n',[string]$limit,$query); $lines = @(& $esPath @args 2>$null); @($lines | ForEach-Object { Convert-EsLine $_ $query } | Where-Object { $null -ne $_ }); }
        function Add-UniqueEsMatch($rows, $seen, $match) { if ($null -eq $match -or [string]::IsNullOrWhiteSpace($match.FullPath)) { return; }; $key = $match.FullPath.ToLowerInvariant(); if ($seen.ContainsKey($key)) { return; }; $seen[$key] = $true; $rows.Add($match) | Out-Null; }
        $panelDefinitions = @(
            @{ PanelType='baota_windows'; Name='BaoTa Windows'; Paths=@('C:\\BtSoft'); SiteRoots=@('C:\\wwwroot','C:\\BtSoft\\wwwroot','C:\\BtSoft\\WebSites'); ServicePatterns=@('bt','baota','BtWeb','BtTask','nginx','mysql'); RegistryPatterns=@('bt.cn','baota','BaoTa'); LogPaths=@('C:\\BtSoft\\panel\\logs\\error.log','C:\\BtSoft\\logs\\error.log','C:\\BtSoft\\wwwlogs'); },
            @{ PanelType='phpstudy'; Name='PhpStudy Pro'; Paths=@('C:\\phpstudy_pro','C:\\phpstudy','C:\\xp.cn'); SiteRoots=@('C:\\phpstudy_pro\\WWW','C:\\phpstudy\\WWW','C:\\xp.cn\\WWW'); ServicePatterns=@('phpstudy','Apache','Apache2.4','mysql','nginx'); RegistryPatterns=@('phpStudy','xp.cn'); LogPaths=@('C:\\phpstudy_pro\\COM\\log\\phpstudy.log','C:\\phpstudy_pro\\Extensions\\Apache2.4.39\\logs\\access.log','C:\\phpstudy_pro\\Extensions\\Nginx1.15.11\\logs\\access.log'); },
            @{ PanelType='xampp'; Name='XAMPP'; Paths=@('C:\\xampp'); SiteRoots=@('C:\\xampp\\htdocs'); ServicePatterns=@('xampp','Apache','Apache2.4','mysql','mariadb'); RegistryPatterns=@('XAMPP'); LogPaths=@('C:\\xampp\\apache\\logs\\access.log','C:\\xampp\\apache\\logs\\error.log','C:\\xampp\\mysql\\data\\mysql_error.log'); },
            @{ PanelType='wampserver'; Name='WampServer'; Paths=@('C:\\wamp64','C:\\wamp'); SiteRoots=@('C:\\wamp64\\www','C:\\wamp\\www'); ServicePatterns=@('wamp','wampapache','wampmysqld','Apache','mysql'); RegistryPatterns=@('WampServer','WAMP'); LogPaths=@('C:\\wamp64\\logs\\apache_error.log','C:\\wamp64\\logs\\apache_access.log','C:\\wamp\\logs\\apache_error.log'); }
        );
        $panelRows = New-Object System.Collections.Generic.List[object]; $siteRows = New-Object System.Collections.Generic.List[object]; $serviceRows = New-Object System.Collections.Generic.List[object]; $logRows = New-Object System.Collections.Generic.List[object]; $esMatches = New-Object System.Collections.Generic.List[object];
        $esPath = Get-EsPath; if ([string]::IsNullOrWhiteSpace($esPath)) { $diagnostics.Add('Everything ES.exe is unavailable; using path/service/registry fallback') | Out-Null; } else { $diagnostics.Add(('Everything ES.exe: ' + $esPath)) | Out-Null; $esSeen = @{}; $esQueries = @('phpstudy_pro','phpstudy','xp.cn','BtSoft','btpanel','xampp','wamp64','wampserver','httpd.conf','nginx.conf','phpstudy.log','access.log','error.log'); foreach ($query in $esQueries) { foreach ($match in @(Invoke-EsQuery $esPath $query 80)) { Add-UniqueEsMatch $esMatches $esSeen $match; } }; $diagnostics.Add(('Everything index matches: ' + $esMatches.Count)) | Out-Null; }
        foreach ($panel in $panelDefinitions) { $installPath = Get-FirstExistingPath $panel.Paths; $siteRoot = Get-FirstExistingPath $panel.SiteRoots; $registryName = Get-UninstallEvidence $panel.RegistryPatterns; $services = @(Get-RelatedServices $panel.PanelType $panel.ServicePatterns $panel.Paths); $detected = (-not [string]::IsNullOrWhiteSpace($installPath)) -or (-not [string]::IsNullOrWhiteSpace($registryName)) -or ($services.Count -gt 0); $siteCount = Get-SiteCount $siteRoot; $evidenceParts = @(); if (-not [string]::IsNullOrWhiteSpace($installPath)) { $evidenceParts += 'path'; }; if (-not [string]::IsNullOrWhiteSpace($registryName)) { $evidenceParts += 'registry'; }; if ($services.Count -gt 0) { $evidenceParts += 'service'; }; if ($siteCount -gt 0) { $evidenceParts += 'site_root'; }; $serviceState = if ($services.Count -gt 0) { (@($services | Select-Object -ExpandProperty State -Unique) -join '; ') } else { '-'; }; $panelRows.Add([pscustomobject]@{ PanelType=$panel.PanelType; Name=$panel.Name; Path=if ([string]::IsNullOrWhiteSpace($installPath)) { $panel.Paths[0] } else { $installPath; }; SiteRoot=if ([string]::IsNullOrWhiteSpace($siteRoot)) { $panel.SiteRoots[0] } else { $siteRoot; }; Detected=$detected; SiteCount=$siteCount; ServiceState=$serviceState; Evidence=if ($evidenceParts.Count -gt 0) { $evidenceParts -join '; ' } else { '-'; }; Notes=if ($detected) { 'detected' } else { 'not found'; }; }) | Out-Null; foreach ($site in @(Get-PanelSites $panel.PanelType $panel.Name $siteRoot)) { $siteRows.Add($site) | Out-Null; }; foreach ($service in $services) { $serviceRows.Add($service) | Out-Null; }; foreach ($logPath in @($panel.LogPaths)) { $meta = Get-PathMetadata $panel.PanelType $logPath 'panel log/config metadata'; if ($null -ne $meta) { $logRows.Add($meta) | Out-Null; } }; }
        $iisSites = @(); try { Import-Module WebAdministration -ErrorAction Stop; $iisSites = @(Get-Website -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Name=$_.Name; State=[string]$_.State; PhysicalPath=$_.PhysicalPath; Bindings=(@($_.Bindings.Collection | ForEach-Object { $_.bindingInformation }) -join '; '); } }); } catch { $diagnostics.Add('IIS WebAdministration module is unavailable') | Out-Null; if (Test-ExistingPath 'C:\\inetpub\\wwwroot') { $iisSites = @([pscustomobject]@{ Name='Default Web Root'; State='Present'; PhysicalPath='C:\\inetpub\\wwwroot'; Bindings='-'; }); } }
        foreach ($iisService in @(Get-RelatedServices 'iis' @('W3SVC','WAS','IISADMIN') @('inetsrv'))) { $serviceRows.Add($iisService) | Out-Null; }; foreach ($iisLogPath in @('C:\\inetpub\\logs\\LogFiles','C:\\Windows\\System32\\LogFiles\\HTTPERR')) { $meta = Get-PathMetadata 'iis' $iisLogPath 'IIS log directory metadata'; if ($null -ne $meta) { $logRows.Add($meta) | Out-Null; } }
        Write-Output '===PANELS==='; Convert-ToJsonArray -items $panelRows.ToArray() -depth 6; Write-Output '===ES_MATCHES==='; Convert-ToJsonArray -items $esMatches.ToArray() -depth 6; Write-Output '===SITES==='; Convert-ToJsonArray -items $siteRows.ToArray() -depth 6; Write-Output '===IIS_SITES==='; Convert-ToJsonArray -items $iisSites -depth 6; Write-Output '===SERVICES==='; Convert-ToJsonArray -items $serviceRows.ToArray() -depth 6; Write-Output '===LOGS==='; Convert-ToJsonArray -items $logRows.ToArray() -depth 6; Write-Output '===DIAGNOSTICS==='; Convert-ToJsonArray -items $diagnostics.ToArray() -depth 4;
    `);
}

export const windowsLocalCommands: Record<string, string> = {
    process_list: 'powershell.exe -NoProfile -Command "Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Compress"',
    service_list: 'powershell.exe -NoProfile -Command "Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress"',
    user_list: 'powershell.exe -NoProfile -Command "Get-LocalUser | Select-Object Name,Enabled,Description,LastLogon | ConvertTo-Json -Compress"',
    logged_users: `powershell.exe -NoProfile -Command "@([pscustomobject]@{ User=$env:USERNAME; SessionName='console'; SessionId=0; State='Active'; IdleTime='-'; LogonTime=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); Source='Local'; LogonType=2 }) | ConvertTo-Json -Compress -Depth 3"`,
    startup: 'powershell.exe -NoProfile -Command "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress"',
    cron: `powershell.exe -NoProfile -Command "try { @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object { $task = $_; $info = $null; try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop } catch {}; $actions = @($task.Actions | ForEach-Object { $parts = @($_.Execute, $_.Arguments, $_.ClassId) | Where-Object { $_ }; if ($parts.Count -gt 0) { ($parts -join ' ').Trim() } else { $_.ToString() } }) -join '; '; $triggers = @($task.Triggers | ForEach-Object { $parts = @($_.CimClass.CimClassName, $_.StartBoundary, $_.EndBoundary, $_.Enabled) | Where-Object { $_ -ne $null -and $_ -ne '' }; if ($parts.Count -gt 0) { ($parts -join ' | ').Trim() } else { ($_.ToString() -replace '\\s+', ' ').Trim() } }) -join '; '; [pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State=[string]$task.State; Author=$task.Author; Description=$task.Description; Actions=$actions; Triggers=$triggers; LastRunTime=if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }; NextRunTime=if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }; LastTaskResult=if ($info) { $info.LastTaskResult } else { $null } } }) | ConvertTo-Json -Compress -Depth 4 } catch { [pscustomobject]@{ error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 4 }"`,
    disk_info: `powershell.exe -NoProfile -Command "try { @(Get-Volume -ErrorAction Stop | Select-Object DriveLetter,FileSystemLabel,Size,SizeRemaining) | ConvertTo-Json -Compress -Depth 3 } catch { @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 3 -or $_.DriveType -eq 2 } | ForEach-Object { [pscustomobject]@{ DriveLetter=$_.DeviceID.TrimEnd(':'); FileSystemLabel=$_.VolumeName; Size=[int64]$_.Size; SizeRemaining=[int64]$_.FreeSpace } }) | ConvertTo-Json -Compress -Depth 3 }"`,
    installed_software: `powershell.exe -NoProfile -Command "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); @(Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Sort-Object DisplayName -Unique | Select-Object DisplayName,DisplayVersion,Publisher,InstallDate,InstallLocation,UninstallString,QuietUninstallString,EstimatedSize,URLInfoAbout,HelpLink) | ConvertTo-Json -Compress -Depth 3"`,
    network_conn: buildWindowsTcpConnectionCommand(false),
    listen_ports: buildWindowsTcpConnectionCommand(true),
    hosts_file: 'powershell.exe -NoProfile -Command "Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts"',
    dns_config: `powershell.exe -NoProfile -Command "try { @(Get-DnsClientServerAddress -ErrorAction Stop | Where-Object { $_.ServerAddresses -and $_.ServerAddresses.Count -gt 0 } | Select-Object InterfaceAlias,ServerAddresses) | ConvertTo-Json -Compress -Depth 4 } catch { @(Get-CimInstance Win32_NetworkAdapterConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPEnabled -and $_.DNSServerSearchOrder } | ForEach-Object { [pscustomobject]@{ InterfaceAlias=$_.Description; ServerAddresses=@($_.DNSServerSearchOrder) } }) | ConvertTo-Json -Compress -Depth 4 }"`,
    recent_files: `powershell.exe -NoProfile -Command "$shell = New-Object -ComObject WScript.Shell; Get-ChildItem ([Environment]::GetFolderPath('Recent')) -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $target = ''; try { $target = $shell.CreateShortcut($_.FullName).TargetPath } catch {}; [pscustomobject]@{ Name=$_.Name; FullName=$_.FullName; TargetPath=$target; LastAccessTime=$_.LastAccessTime.ToString('yyyy-MM-dd HH:mm:ss'); LastWriteTime=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') } } | ConvertTo-Json -Compress -Depth 3"`,
    env_vars: 'powershell.exe -NoProfile -Command "$vars = [Environment]::GetEnvironmentVariables(); $vars.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ Name=[string]$_; Value=[string]$vars[$_] } } | ConvertTo-Json -Compress -Depth 3"',
    file_scan: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$tempRoots = @($env:TEMP, (Join-Path $env:WINDIR 'Temp')) | Where-Object { $_ -and (Test-Path $_) }; function Emit($name, $items) { Write-Output ('===' + $name + '==='); @($items) | ConvertTo-Json -Compress -Depth 4 }; $recentTemp = @(Get-ChildItem -LiteralPath $tempRoots -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-1) } | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension); Emit 'RECENT_TEMP' $recentTemp; $execRoots = @((Join-Path $env:PUBLIC 'Downloads'), (Join-Path $env:USERPROFILE 'Downloads'), $env:APPDATA, (Join-Path $env:LOCALAPPDATA 'Temp')) | Where-Object { $_ -and (Test-Path $_) }; $executables = @(Get-ChildItem -LiteralPath $execRoots -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension); Emit 'USER_WRITABLE_EXECUTABLES' $executables; $webRoots = @('C:\\inetpub\\wwwroot','C:\\phpstudy_pro\\WWW','C:\\xampp\\htdocs','C:\\wamp64\\www','C:\\BtSoft\\WebSites') | Where-Object { Test-Path $_ }; $webFiles = @(Get-ChildItem -LiteralPath $webRoots -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) -and $_.Extension -match '^\\.(php|asp|aspx|jsp|jspx|js|config)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension); Emit 'RECENT_WEBROOT' $webFiles"`,
    suspicious_files: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$roots = @($env:TEMP, (Join-Path $env:WINDIR 'Temp'), (Join-Path $env:USERPROFILE 'Downloads'), $env:APPDATA, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }; Write-Output '===RECENT_TEMP==='; Get-ChildItem -LiteralPath @($env:TEMP, (Join-Path $env:WINDIR 'Temp')) -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-1) } | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===TEMP_EXE==='; Get-ChildItem -LiteralPath @($env:TEMP, (Join-Path $env:WINDIR 'Temp')) -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' } | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===HIDDEN_EXE==='; Get-ChildItem -LiteralPath $roots -File -Force -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::Hidden -and $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' } | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===RECENT_MODIFIED==='; Get-ChildItem -LiteralPath @((Join-Path $env:USERPROFILE 'Downloads'), $env:APPDATA, $env:LOCALAPPDATA) -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) -and $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 120 -ExpandProperty FullName"`,
    security_events: `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ids = @(4624,4625,4648,4672,4720,4722,4724,4725,4726,4728,4732,4738,4740,4776); try { @(Get-WinEvent -FilterHashtable @{LogName='Security'; ID=$ids} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); $eventType = switch ($_.Id) { 4624 { 'Logon success' } 4625 { 'Failed logon' } 4648 { 'Explicit credentials logon' } 4672 { 'Special privileges assigned' } 4720 { 'User created' } 4722 { 'User enabled' } 4724 { 'Password reset' } 4725 { 'User disabled' } 4726 { 'User deleted' } 4728 { 'Added to security group' } 4732 { 'Added to local group' } 4738 { 'User account changed' } 4740 { 'Account locked' } 4776 { 'Credential validation' } default { 'Security event' } }; $user = ''; if ($msg -match 'Account Name:\\s+([^\\s]+)') { $user = $Matches[1] }; $ip = ''; if ($msg -match 'Source Network Address:\\s+([^\\s]+)') { $ip = $Matches[1] }; $logonType = ''; if ($msg -match 'Logon Type:\\s+(\\d+)') { $logonType = $Matches[1] }; $status = ''; if ($msg -match 'Status:\\s+([^\\s]+)') { $status = $Matches[1] }; [pscustomobject]@{ EventId=$_.Id; TimeCreated=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); EventType=$eventType; Description=$msg.Substring(0, [Math]::Min(220, $msg.Length)); Username=$user; SourceIp=$ip; LogonType=$logonType; Status=$status; Suspicious=($_.Id -in @(4625,4672,4720,4726,4740)) } }) | ConvertTo-Json -Compress -Depth 4 } catch { [pscustomobject]@{ EventId='error'; TimeCreated=''; EventType='Error'; Description=$_.Exception.Message; Username=''; SourceIp=''; LogonType=''; Status=''; Suspicious=$true } | ConvertTo-Json -Compress -Depth 4 }"`,
    win_security_log: 'try { Get-WinEvent -LogName Security | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[需要管理员权限] 请以管理员身份运行程序来查看安全日志" }',
    win_system_log: 'try { Get-WinEvent -LogName System | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_app_log: 'try { Get-WinEvent -LogName Application | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_powershell_log: 'try { Get-WinEvent -LogName "Windows PowerShell" | Select-Object @{N="time";E={$_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss")}}, @{N="id";E={$_.Id}}, @{N="message";E={($_.Message -replace "`n", " " -replace "`r", " ").Substring(0, [Math]::Min(150, $_.Message.Length))}} | ConvertTo-Json -Compress } catch { Write-Host "[错误] $_" }',
    win_firewall: 'netsh advfirewall show allprofiles',
    registry: 'powershell -Command "echo ===HKLM_RUN===; Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run | Select-Object * -ExcludeProperty PS* | ConvertTo-Json -Compress; echo ===HKCU_RUN===; Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run | Select-Object * -ExcludeProperty PS* | ConvertTo-Json -Compress"',
    win_defender: 'powershell -Command "try { Get-MpComputerStatus | Select-Object AntivirusEnabled,AMServiceEnabled,AntispywareEnabled,BehaviorMonitorEnabled,IoavProtectionEnabled,OnAccessProtectionEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated | ConvertTo-Json -Compress } catch { echo @{error=\"需要管理员权限或Defender未运行\"} | ConvertTo-Json -Compress }"',
    persistence: 'powershell -Command "echo ===SCHEDULED_TASKS===; Get-ScheduledTask | Where-Object {$_.State -ne \'Disabled\'} | Select-Object TaskName,State,@{N=\'Action\';E={$_.Actions.Execute}} | Select-Object -First 20 | ConvertTo-Json -Compress; echo ===SERVICES_AUTO===; Get-Service | Where-Object {$_.StartType -eq \'Automatic\'} | Select-Object Name,DisplayName,Status | Select-Object -First 20 | ConvertTo-Json -Compress; echo ===STARTUP_FOLDER===; Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress"',
    rdp: 'powershell -Command "echo ===RDP_CONN===; Get-NetTCPConnection -LocalPort 3389 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress; echo ===RDP_SERVICE===; Get-Service TermService | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress"',
    docker: buildWindowsPowerShellCommand(`
        $docker = Get-Command docker.exe -ErrorAction SilentlyContinue;
        $desktopPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
        Write-Output '===DOCKER_INSTALL===';
        if ($docker -or (Test-Path $desktopPath)) {
            [pscustomobject]@{
                CommandPath = if ($docker) { $docker.Source } else { '' };
                Version = if ($docker) { (& docker version --format '{{.Client.Version}}' 2>$null | Select-Object -First 1) } else { '' };
                DesktopPath = if (Test-Path $desktopPath) { $desktopPath } else { '' };
            } | ConvertTo-Json -Compress -Depth 3;
        } else {
            @() | ConvertTo-Json -Compress;
        }
        Write-Output '===DOCKER_SERVICE===';
        $dockerServiceNames = @('com.docker.service', 'docker');
        @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -in $dockerServiceNames -or $_.Name -match 'docker' -or $_.DisplayName -match 'docker' -or $_.PathName -match 'docker'
        } | ForEach-Object {
            [pscustomobject]@{
                Name = $_.Name;
                DisplayName = $_.DisplayName;
                State = $_.State;
                StartMode = $_.StartMode;
                PathName = $_.PathName;
                ProcessId = $_.ProcessId;
            }
        }) | ConvertTo-Json -Compress -Depth 4;
        Write-Output '===DOCKER_CONTAINERS===';
        if ($docker) {
            @(docker ps -a --format '{{json .}}' 2>$null | ForEach-Object {
                try {
                    $row = $_ | ConvertFrom-Json;
                    [pscustomobject]@{
                        ID = $row.ID;
                        Image = $row.Image;
                        Status = $row.Status;
                        Names = $row.Names;
                        Ports = $row.Ports;
                    }
                } catch {}
            }) | ConvertTo-Json -Compress -Depth 4;
        } else {
            @() | ConvertTo-Json -Compress;
        }
    `),
    docker_images: buildWindowsPowerShellCommand(`
        $docker = Get-Command docker.exe -ErrorAction SilentlyContinue;
        $desktopPath = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
        Write-Output '===DOCKER_INSTALL===';
        if ($docker -or (Test-Path $desktopPath)) {
            [pscustomobject]@{
                CommandPath = if ($docker) { $docker.Source } else { '' };
                Version = if ($docker) { (& docker version --format '{{.Client.Version}}' 2>$null | Select-Object -First 1) } else { '' };
                DesktopPath = if (Test-Path $desktopPath) { $desktopPath } else { '' };
            } | ConvertTo-Json -Compress -Depth 3;
        } else {
            @() | ConvertTo-Json -Compress;
        }
        Write-Output '===DOCKER_IMAGES===';
        if ($docker) {
            @(docker images --format '{{json .}}' 2>$null | ForEach-Object {
                try {
                    $row = $_ | ConvertFrom-Json;
                    [pscustomobject]@{
                        Repository = $row.Repository;
                        Tag = $row.Tag;
                        ID = $row.ID;
                        Size = $row.Size;
                        CreatedAt = $row.CreatedAt;
                    }
                } catch {}
            }) | ConvertTo-Json -Compress -Depth 4;
        } else {
            @() | ConvertTo-Json -Compress;
        }
    `),
    panel: 'powershell -Command "echo ===PHPSTUDY===; if (Test-Path \'C:\\phpstudy_pro\') { echo \'PhpStudy Pro检测到\'; Get-ChildItem \'C:\\phpstudy_pro\\WWW\' -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | ConvertTo-Json -Compress } else { echo \'未检测到PhpStudy\' }; echo ===XAMPP===; if (Test-Path \'C:\\xampp\') { echo \'XAMPP检测到\'; Get-ChildItem \'C:\\xampp\\htdocs\' -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | ConvertTo-Json -Compress } else { echo \'未检测到XAMPP\' }; echo ===WAMPSERVER===; if (Test-Path \'C:\\wamp64\') { echo \'WampServer检测到\'; Get-ChildItem \'C:\\wamp64\\www\' -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | ConvertTo-Json -Compress } else { echo \'未检测到WampServer\' }; echo ===BAOTA_WIN===; if (Test-Path \'C:\\BtSoft\') { echo \'宝塔Windows版检测到\'; Get-ChildItem \'C:\\BtSoft\\WebSites\' -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | ConvertTo-Json -Compress } else { echo \'未检测到宝塔Windows版\' }; echo ===IIS===; Get-WebSite -ErrorAction SilentlyContinue | Select-Object Name,State,PhysicalPath,Bindings | ConvertTo-Json -Compress"',
    database: buildWindowsPowerShellCommand(`
        $dbPorts = @(1433,1434,3306,5432,6379,27017,27018,1521,9200,9300);
        $serviceRegex = 'SQL Server|MSSQL|SQLSERVER|MySQL|MariaDB|PostgreSQL|postgres|Redis|MongoDB|mongod|Oracle|Elasticsearch|ElasticSearch';
        Write-Output '===DB_SERVICES===';
        @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $serviceRegex -or $_.DisplayName -match $serviceRegex -or $_.PathName -match $serviceRegex } | ForEach-Object { [pscustomobject]@{ Name=$_.Name; DisplayName=$_.DisplayName; State=$_.State; Status=$_.State; StartMode=$_.StartMode; StartName=$_.StartName; PathName=$_.PathName; ProcessId=$_.ProcessId } }) | ConvertTo-Json -Compress -Depth 4;
        Write-Output '===DB_PORTS===';
        @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $dbPorts -and ($_.State -eq 'Listen' -or $_.State -eq 'Established') } | ForEach-Object { $proc = $null; try { $proc = Get-Process -Id $_.OwningProcess -ErrorAction Stop } catch {}; [pscustomobject]@{ LocalAddress=$_.LocalAddress; LocalPort=$_.LocalPort; State=[string]$_.State; OwningProcess=$_.OwningProcess; ProcessName=if ($proc) { $proc.ProcessName } else { '' }; ProcessPath=if ($proc) { $proc.Path } else { '' } } }) | ConvertTo-Json -Compress -Depth 4;
        Write-Output '===DB_PROCESSES===';
        @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'sqlservr|mysqld|mariadbd|postgres|redis-server|redis|mongod|oracle|tnslsnr|elastic' -or $_.CommandLine -match $serviceRegex } | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress -Depth 4;
        Write-Output '===DB_INSTALLS===';
        $uninstallPaths = @(
            'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
        );
        @(Get-ItemProperty $uninstallPaths -ErrorAction SilentlyContinue | Where-Object {
            $_.DisplayName -match $serviceRegex -or $_.Publisher -match $serviceRegex -or $_.InstallLocation -match $serviceRegex
        } | Sort-Object DisplayName -Unique | ForEach-Object {
            [pscustomobject]@{
                DisplayName = $_.DisplayName;
                DisplayVersion = $_.DisplayVersion;
                InstallLocation = $_.InstallLocation;
                Publisher = $_.Publisher;
                UninstallString = $_.UninstallString;
                Source = 'registry';
            }
        }) | ConvertTo-Json -Compress -Depth 4
    `),
    webshell_scan: buildWindowsWebshellScanCommand(),
    process_anomaly: 'powershell -Command "echo ===HIDDEN===; $ps = Get-Process | Select-Object -ExpandProperty Id; $wmi = Get-CimInstance Win32_Process | Select-Object -ExpandProperty ProcessId; Compare-Object $ps $wmi | Where-Object { $_.SideIndicator -eq \'==>\' } | Select-Object -ExpandProperty InputObject; echo ===SENSITIVE_PATH===; Get-Process | Where-Object { $_.Path -match \'Temp\' -or $_.Path -match \'Public\' } | Select-Object Id, UserName, Path; echo ===HIGH_RESOURCES===; Get-Process | Sort-Object -Descending CPU | Select-Object -First 5 | Select-Object Name, Id, CPU, WorkingSet"',
    bashrc_check: 'powershell -Command "$profilePath = $PROFILE.CurrentUserAllHosts; if (Test-Path $profilePath) { Get-Content $profilePath } else { Write-Output \'No user profile found\' }"',
    profile_check: 'powershell -Command "$profilePath = $PROFILE.AllUsersAllHosts; if (Test-Path $profilePath) { Get-Content $profilePath } else { Write-Output \'No system profile found\' }"',
    browser: 'powershell -Command "echo ===CHROME===; Get-Item \\"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\" -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime; echo ===EDGE===; Get-Item \\"$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\" -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime; echo ===FIREFOX===; Get-Item \\"$env:APPDATA\\Mozilla\\Firefox\\Profiles\\" -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime"',
};

windowsLocalCommands.panel = buildWindowsPanelDetectionCommand();
windowsLocalCommands.win_defender = `powershell.exe -NoProfile -Command "try { $status = Get-MpComputerStatus -ErrorAction Stop; $pref = $null; try { $pref = Get-MpPreference -ErrorAction SilentlyContinue } catch {}; [pscustomobject]@{ AntivirusEnabled=$status.AntivirusEnabled; AMServiceEnabled=$status.AMServiceEnabled; AntispywareEnabled=$status.AntispywareEnabled; BehaviorMonitorEnabled=$status.BehaviorMonitorEnabled; IoavProtectionEnabled=$status.IoavProtectionEnabled; OnAccessProtectionEnabled=$status.OnAccessProtectionEnabled; RealTimeProtectionEnabled=$status.RealTimeProtectionEnabled; NISEnabled=$status.NISEnabled; AntivirusSignatureLastUpdated=if ($status.AntivirusSignatureLastUpdated) { $status.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }; AntivirusSignatureVersion=$status.AntivirusSignatureVersion; AntispywareSignatureLastUpdated=if ($status.AntispywareSignatureLastUpdated) { $status.AntispywareSignatureLastUpdated.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }; AntispywareSignatureVersion=$status.AntispywareSignatureVersion; AMProductVersion=$status.AMProductVersion; AMEngineVersion=$status.AMEngineVersion; NISSignatureVersion=$status.NISSignatureVersion; QuickScanAge=$status.QuickScanAge; FullScanAge=$status.FullScanAge; ExclusionPath=if ($pref -and $pref.ExclusionPath) { @($pref.ExclusionPath) -join '; ' } else { '' }; ExclusionProcess=if ($pref -and $pref.ExclusionProcess) { @($pref.ExclusionProcess) -join '; ' } else { '' } } | ConvertTo-Json -Compress -Depth 4 } catch { [pscustomobject]@{ error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 4 }"`;

windowsLocalCommands.persistence = `powershell.exe -NoProfile -Command "echo ===SCHEDULED_TASKS===; try { @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.State -ne 'Disabled' } | Select-Object -First 200 | ForEach-Object { $task = $_; $actions = @($task.Actions | ForEach-Object { $parts = @($_.Execute, $_.Arguments, $_.ClassId) | Where-Object { $_ }; if ($parts.Count -gt 0) { ($parts -join ' ').Trim() } else { ($_.ToString() -replace '\\s+', ' ').Trim() } }) -join '; '; $triggers = @($task.Triggers | ForEach-Object { $parts = @($_.CimClass.CimClassName, $_.StartBoundary, $_.EndBoundary, $_.Enabled) | Where-Object { $_ -ne $null -and $_ -ne '' }; if ($parts.Count -gt 0) { ($parts -join ' | ').Trim() } else { ($_.ToString() -replace '\\s+', ' ').Trim() } }) -join '; '; [pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State=[string]$task.State; Actions=$actions; Triggers=$triggers; Author=$task.Author; Description=$task.Description } }) | ConvertTo-Json -Compress -Depth 5 } catch { @([pscustomobject]@{ Error=$_.Exception.Message }) | ConvertTo-Json -Compress -Depth 5 }; echo ===SERVICES_AUTO===; @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.StartMode -eq 'Auto' } | Select-Object -First 200 | ForEach-Object { [pscustomobject]@{ Name=$_.Name; DisplayName=$_.DisplayName; Status=$_.State; StartType=$_.StartMode; PathName=$_.PathName; StartName=$_.StartName } }) | ConvertTo-Json -Compress -Depth 4; echo ===STARTUP_FOLDER===; @(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name,Command,Location,User) | ConvertTo-Json -Compress -Depth 4"`;

windowsLocalCommands.rdp = buildWindowsRdpCommand();

windowsLocalCommands.execution_trace = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
$prefetchPath = Join-Path $env:WINDIR 'Prefetch';
if (Test-Path $prefetchPath) { Get-ChildItem -LiteralPath $prefetchPath -Filter '*.pf' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 200 | ForEach-Object { Add-Row 'Execution Trace' 'Prefetch' $_.BaseName $_.FullName $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') ('Size=' + $_.Length) 'warning' 'Present' } } else { Add-Row 'Execution Trace' 'Prefetch' 'Prefetch directory' $prefetchPath '' 'Prefetch directory not found or disabled' 'info' 'Missing' };
$amcachePath = Join-Path $env:WINDIR 'AppCompat\\Programs\\Amcache.hve';
if (Test-Path $amcachePath) { $amcache = Get-Item -LiteralPath $amcachePath -ErrorAction SilentlyContinue; if ($amcache) { Add-Row 'Execution Trace' 'Amcache' 'Amcache.hve' $amcache.FullName $amcache.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') ('Hive size=' + $amcache.Length) 'warning' 'Present' } } else { Add-Row 'Execution Trace' 'Amcache' 'Amcache.hve' $amcachePath '' 'Amcache hive not found' 'info' 'Missing' };
$shimKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\AppCompatCache';
try { $shim = Get-ItemProperty -LiteralPath $shimKey -ErrorAction Stop; Add-Row 'Execution Trace' 'ShimCache' 'AppCompatCache' $shimKey '' 'ShimCache registry value exists; export hive for full offline parsing' 'warning' 'Present' } catch { Add-Row 'Execution Trace' 'ShimCache' 'AppCompatCache' $shimKey '' $_.Exception.Message 'info' 'Unavailable' };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.powershell_deep = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
$ids = @(4103,4104,400,403,600,800);
foreach ($channel in @('Microsoft-Windows-PowerShell/Operational','Windows PowerShell')) { try { Get-WinEvent -FilterHashtable @{LogName=$channel; Id=$ids} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); $risk = if ($_.Id -eq 4104 -and $msg -match '(FromBase64String|DownloadString|IEX|Invoke-Expression|EncodedCommand|Net.WebClient)') { 'high' } elseif ($_.Id -in @(4103,4104)) { 'warning' } else { 'info' }; Add-Row 'PowerShell Deep' $channel ('Event ' + $_.Id) $channel $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') $msg.Substring(0, [Math]::Min(500, $msg.Length)) $risk 'Event' $_.Id } } catch { Add-Row 'PowerShell Deep' $channel 'Event query' $channel '' $_.Exception.Message 'info' 'Unavailable' } };
$historyCandidates = @();
try { $option = Get-PSReadLineOption -ErrorAction Stop; if ($option.HistorySavePath) { $historyCandidates += $option.HistorySavePath } } catch {};
if ($env:APPDATA) { $historyCandidates += (Join-Path $env:APPDATA 'Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt') };
$historyCandidates | Sort-Object -Unique | ForEach-Object { if ($_ -and (Test-Path $_)) { $item = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue; Get-Content -LiteralPath $_ -Tail 80 -ErrorAction SilentlyContinue | ForEach-Object { $risk = if ($_ -match '(FromBase64String|DownloadString|IEX|Invoke-Expression|EncodedCommand|Net.WebClient|Start-BitsTransfer|Add-MpPreference)') { 'high' } else { 'warning' }; Add-Row 'PowerShell Deep' 'PSReadLine' 'ConsoleHost_history' $item.FullName $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') $_ $risk 'History' } } };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.defender_history = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
if (Get-Command Get-MpThreat -ErrorAction SilentlyContinue) { try { @(Get-MpThreat -ErrorAction Stop) | ForEach-Object { $threatName = if ($_.ThreatName) { $_.ThreatName } elseif ($_.ThreatID) { $_.ThreatID } else { 'Threat' }; $severity = if ($_.SeverityID) { $_.SeverityID } else { 'Threat' }; Add-Row 'Defender History' 'Get-MpThreat' $threatName '' '' (($_ | Out-String).Trim()) 'high' $severity } } catch { Add-Row 'Defender History' 'Get-MpThreat' 'Threat query failed' '' '' $_.Exception.Message 'warning' 'Error' } } else { Add-Row 'Defender History' 'Get-MpThreat' 'Cmdlet unavailable' '' '' 'Get-MpThreat is not available on this host' 'info' 'Unavailable' };
if (Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue) { try { @(Get-MpThreatDetection -ErrorAction Stop) | ForEach-Object { $time = if ($_.InitialDetectionTime) { $_.InitialDetectionTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }; $threatName = if ($_.ThreatName) { $_.ThreatName } elseif ($_.ThreatID) { $_.ThreatID } else { 'Detection' }; $action = if ($_.ActionSuccess) { $_.ActionSuccess } else { 'Detection' }; Add-Row 'Defender History' 'Get-MpThreatDetection' $threatName ($_.Resources -join '; ') $time (($_ | Out-String).Trim()) 'high' $action } } catch { Add-Row 'Defender History' 'Get-MpThreatDetection' 'Detection query failed' '' '' $_.Exception.Message 'warning' 'Error' } };
try { $pref = Get-MpPreference -ErrorAction Stop; foreach ($field in @('ExclusionPath','ExclusionProcess','ExclusionExtension','ExclusionIpAddress')) { $values = @($pref.$field) | Where-Object { $_ }; foreach ($value in $values) { Add-Row 'Defender History' 'Get-MpPreference' $field ([string]$value) '' ('Defender exclusion: ' + $value) 'warning' 'Exclusion' } } } catch { Add-Row 'Defender History' 'Get-MpPreference' 'Preference query failed' '' '' $_.Exception.Message 'info' 'Unavailable' };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.rdp_logon_trace = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
try { Get-WinEvent -FilterHashtable @{LogName='Security'; Id=@(4624,4625)} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); $user = ''; if ($msg -match 'Account Name:\\s+([^\\s]+)') { $user = $Matches[1] }; $ip = ''; if ($msg -match 'Source Network Address:\\s+([^\\s]+)') { $ip = $Matches[1] }; $logonType = ''; if ($msg -match 'Logon Type:\\s+(\\d+)') { $logonType = $Matches[1] }; $risk = if ($_.Id -eq 4625) { 'warning' } elseif ($logonType -eq '10') { 'warning' } else { 'info' }; Add-Row 'RDP Logon Trace' 'Security' ('Event ' + $_.Id + ' LogonType ' + $logonType) 'Security' $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') $msg.Substring(0, [Math]::Min(500, $msg.Length)) $risk $logonType $_.Id $user $ip } } catch { Add-Row 'RDP Logon Trace' 'Security' '4624/4625 query failed' 'Security' '' $_.Exception.Message 'warning' 'Error' };
$channels = @(@{Name='Microsoft-Windows-TerminalServices-RemoteConnectionManager/Operational'; Id=@(1149)}, @{Name='Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'; Id=@(21,24,25,40)});
foreach ($channel in $channels) { try { Get-WinEvent -FilterHashtable @{LogName=$channel.Name; Id=$channel.Id} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); Add-Row 'RDP Logon Trace' 'TerminalServices' ('Event ' + $_.Id) $channel.Name $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') $msg.Substring(0, [Math]::Min(500, $msg.Length)) 'warning' 'Event' $_.Id } } catch { Add-Row 'RDP Logon Trace' 'TerminalServices' 'Channel query failed' $channel.Name '' $_.Exception.Message 'info' 'Unavailable' } };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.wmi_persistence = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
$ns = 'root\\subscription';
foreach ($class in @('__EventFilter','CommandLineEventConsumer','ActiveScriptEventConsumer','__FilterToConsumerBinding')) { try { @(Get-CimInstance -Namespace $ns -ClassName $class -ErrorAction Stop) | ForEach-Object { $name = if ($_.Name) { $_.Name } elseif ($_.__RELPATH) { $_.__RELPATH } else { $class }; $detail = @($_.Query, $_.CommandLineTemplate, $_.ScriptText, $_.Filter, $_.Consumer, $_.__RELPATH) | Where-Object { $_ } | Select-Object -First 3; Add-Row 'WMI Persistence' $class $name $ns '' ($detail -join ' | ') 'high' 'Present' } } catch { Add-Row 'WMI Persistence' $class 'Query failed' $ns '' $_.Exception.Message 'info' 'Unavailable' } };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.bits_jobs = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
try { $jobs = @(Get-BitsTransfer -AllUsers -ErrorAction Stop); if ($jobs.Count -eq 0) { Add-Row 'BITS Jobs' 'Get-BitsTransfer' 'No active BITS jobs' '' '' 'No BITS jobs returned for all users' 'info' 'Empty' }; $jobs | ForEach-Object { $remote = @($_.TransferFile | ForEach-Object { $_.RemoteName }) -join '; '; $local = @($_.TransferFile | ForEach-Object { $_.LocalName }) -join '; '; Add-Row 'BITS Jobs' 'Get-BitsTransfer' $_.DisplayName ($remote + ' -> ' + $local) '' (($_ | Out-String).Trim()) 'warning' $_.JobState } } catch { Add-Row 'BITS Jobs' 'Get-BitsTransfer' 'BITS query failed' '' '' $_.Exception.Message 'warning' 'Error'; try { bitsadmin /list /allusers /verbose 2>$null | Select-Object -First 200 | ForEach-Object { if ($_ -and $_.Trim()) { Add-Row 'BITS Jobs' 'bitsadmin' 'bitsadmin output' '' '' $_ 'info' 'Fallback' } } } catch {} };
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.registry_persistence_deep = buildWindowsPowerShellCommand(`
$rows = New-Object System.Collections.ArrayList;
function Add-Row { param($category,$source,$name,$path,$time,$detail,$risk='info',$status='',$eventId='',$user='',$ip=''); [void]$rows.Add([pscustomobject]@{ category=[string]$category; source=[string]$source; name=[string]$name; path=[string]$path; time=[string]$time; detail=[string]$detail; risk=[string]$risk; status=[string]$status; eventId=[string]$eventId; user=[string]$user; ip=[string]$ip }) }
$ifeoRoot = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options';
try { Get-ChildItem -LiteralPath $ifeoRoot -ErrorAction Stop | ForEach-Object { $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; if ($props.Debugger) { Add-Row 'Registry Persistence' 'Image File Execution Options' $_.PSChildName $_.Name '' ('Debugger=' + $props.Debugger) 'high' 'Present' } } } catch { Add-Row 'Registry Persistence' 'Image File Execution Options' 'IFEO query failed' $ifeoRoot '' $_.Exception.Message 'info' 'Unavailable' };
$windowsKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows';
try { $props = Get-ItemProperty -LiteralPath $windowsKey -ErrorAction Stop; foreach ($name in @('AppInit_DLLs','LoadAppInit_DLLs')) { $prop = $props.PSObject.Properties[$name]; if ($prop -and [string]$prop.Value -ne '') { Add-Row 'Registry Persistence' 'AppInit_DLLs' $name $windowsKey '' ([string]$prop.Value) 'high' 'Present' } } } catch { Add-Row 'Registry Persistence' 'AppInit_DLLs' 'Windows key query failed' $windowsKey '' $_.Exception.Message 'info' 'Unavailable' };
$winlogonKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
try { $props = Get-ItemProperty -LiteralPath $winlogonKey -ErrorAction Stop; foreach ($name in @('Shell','Userinit','Notify')) { $prop = $props.PSObject.Properties[$name]; if ($prop -and [string]$prop.Value -ne '') { $risk = if ([string]$prop.Value -match '(cmd|powershell|wscript|cscript|mshta|AppData|Temp|Public)') { 'high' } else { 'warning' }; Add-Row 'Registry Persistence' 'Winlogon' $name $winlogonKey '' ([string]$prop.Value) $risk 'Present' } } } catch {};
$lsaKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa';
try { $props = Get-ItemProperty -LiteralPath $lsaKey -ErrorAction Stop; foreach ($name in @('Authentication Packages','Security Packages','Notification Packages')) { $prop = $props.PSObject.Properties[$name]; if ($prop -and $prop.Value) { Add-Row 'Registry Persistence' 'LSA' $name $lsaKey '' (@($prop.Value) -join '; ') 'warning' 'Present' } } } catch {};
try { Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -and $_.PathName -match '(AppData|Temp|Public|Users|ProgramData|powershell|cmd.exe|wscript|cscript|mshta)' } | Select-Object -First 120 | ForEach-Object { Add-Row 'Registry Persistence' 'Service ImagePath' $_.Name $_.PathName '' ('StartName=' + $_.StartName + '; State=' + $_.State) 'warning' $_.State } } catch {};
$rows | ConvertTo-Json -Compress -Depth 5
`);

windowsLocalCommands.browser = `powershell.exe -NoProfile -Command "function Get-BrowserProfiles($browser, $root) { if (-not (Test-Path $root)) { return @() }; @(Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' -or $browser -eq 'Firefox' } | ForEach-Object { $history = if ($browser -eq 'Firefox') { Join-Path $_.FullName 'places.sqlite' } else { Join-Path $_.FullName 'History' }; [pscustomobject]@{ Browser=$browser; Profile=$_.Name; Path=$_.FullName; LastWriteTime=$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'); HistoryPath=if (Test-Path $history) { $history } else { '' }; HistoryLastWriteTime=if (Test-Path $history) { (Get-Item $history).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' } } }) }; echo ===CHROME===; @(Get-BrowserProfiles 'Chrome' (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data')) | ConvertTo-Json -Compress -Depth 4; echo ===EDGE===; @(Get-BrowserProfiles 'Edge' (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data')) | ConvertTo-Json -Compress -Depth 4; echo ===FIREFOX===; @(Get-BrowserProfiles 'Firefox' (Join-Path $env:APPDATA 'Mozilla\\Firefox\\Profiles')) | ConvertTo-Json -Compress -Depth 4"`;

function buildWindowsEventLogCommand(
    logName: string,
    startTimeExpression?: string,
    page = 1,
    pageSize = WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
): string {
    const currentPage = Math.max(1, Math.floor(page));
    const take = Math.min(500, Math.max(1, Math.floor(pageSize)));
    const skip = (currentPage - 1) * take;
    const maxEvents = skip + take;
    const safeLogName = logName.replace(/'/g, "''");
    const filter = startTimeExpression
        ? `@{LogName='${safeLogName}'; StartTime=${startTimeExpression}}`
        : `@{LogName='${safeLogName}'}`;
    const totalExpression = startTimeExpression
        ? `@(Get-WinEvent -FilterHashtable ${filter} -ErrorAction Stop | Measure-Object).Count`
        : `(Get-WinEvent -ListLog '${safeLogName}' -ErrorAction Stop).RecordCount`;

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $skip=${skip}; $take=${take}; try { $totalCount=[int64](${totalExpression}); $rows=@(Get-WinEvent -FilterHashtable ${filter} -MaxEvents ${maxEvents} -ErrorAction Stop | Select-Object -Skip $skip -First $take | ForEach-Object { $msg=($_.Message -replace '[\\r\\n]+', ' '); [pscustomobject]@{ time=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); id=$_.Id; message=$msg } }); [pscustomobject]@{ totalCount=$totalCount; page=${currentPage}; pageSize=${take}; isPaged=$true; preview=@($rows); format='json' } | ConvertTo-Json -Compress -Depth 5 } catch { if ($_.Exception.Message -match 'No events were found') { [pscustomobject]@{ totalCount=0; page=${currentPage}; pageSize=${take}; isPaged=$true; preview=@(); format='json' } | ConvertTo-Json -Compress -Depth 5 } else { [pscustomobject]@{ error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 4 } }"`;
}

function buildWindowsEventLogExportCommand(logName: string, startTimeExpression?: string): string {
    const safeName = logName.replace(/[^A-Za-z0-9]+/g, '_');
    const filter = startTimeExpression
        ? `@{LogName='${logName}'; StartTime=${startTimeExpression}}`
        : `@{LogName='${logName}'}`;

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dir=Join-Path ([IO.Path]::GetTempPath()) 'Lumina-IR'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; $path=Join-Path $dir ('${safeName}-' + $stamp + '.csv'); $count=0; $preview=New-Object System.Collections.Generic.List[object]; try { Get-WinEvent -FilterHashtable ${filter} -ErrorAction Stop | ForEach-Object { $msg=($_.Message -replace '[\\r\\n]+', ' '); $row=[pscustomobject]@{ time=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); id=$_.Id; message=$msg }; if ($count -lt ${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}) { [void]$preview.Add($row) }; $count++; $row } | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding UTF8; [pscustomobject]@{ artifactPath=$path; totalCount=$count; preview=@($preview | Select-Object -First ${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}); format='csv' } | ConvertTo-Json -Compress -Depth 5 } catch { if ($_.Exception.Message -match 'No events were found') { '' | Set-Content -LiteralPath $path -Encoding UTF8; [pscustomobject]@{ artifactPath=$path; totalCount=0; preview=@(); format='csv' } | ConvertTo-Json -Compress -Depth 5 } else { [pscustomobject]@{ error=$_.Exception.Message } | ConvertTo-Json -Compress -Depth 4 } }"`;
}

function buildWindowsSecurityEventsCommand(): string {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ids = @(4624,4625,4648,4672,4720,4722,4724,4725,4726,4728,4732,4738,4740,4776); try { $rows=@(Get-WinEvent -FilterHashtable @{LogName='Security'; ID=$ids} -MaxEvents ${WINDOWS_EVENT_LOG_PREVIEW_LIMIT} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); $eventType = switch ($_.Id) { 4624 { 'Logon success' } 4625 { 'Failed logon' } 4648 { 'Explicit credentials logon' } 4672 { 'Special privileges assigned' } 4720 { 'User created' } 4722 { 'User enabled' } 4724 { 'Password reset' } 4725 { 'User disabled' } 4726 { 'User deleted' } 4728 { 'Added to security group' } 4732 { 'Added to local group' } 4738 { 'User account changed' } 4740 { 'Account locked' } 4776 { 'Credential validation' } default { 'Security event' } }; $user = ''; if ($msg -match 'Account Name:\\s+([^\\s]+)') { $user = $Matches[1] }; $ip = ''; if ($msg -match 'Source Network Address:\\s+([^\\s]+)') { $ip = $Matches[1] }; $logonType = ''; if ($msg -match 'Logon Type:\\s+(\\d+)') { $logonType = $Matches[1] }; $status = ''; if ($msg -match 'Status:\\s+([^\\s]+)') { $status = $Matches[1] }; [pscustomobject]@{ EventId=$_.Id; TimeCreated=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); EventType=$eventType; Description=$msg; Username=$user; SourceIp=$ip; LogonType=$logonType; Status=$status; Suspicious=($_.Id -in @(4625,4672,4720,4726,4740)) } }); [pscustomobject]@{ previewLimit=${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}; isPreview=$true; preview=@($rows); format='json' } | ConvertTo-Json -Compress -Depth 5 } catch { if ($_.Exception.Message -match 'No events were found') { [pscustomobject]@{ previewLimit=${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}; isPreview=$true; preview=@(); format='json' } | ConvertTo-Json -Compress -Depth 5 } else { [pscustomobject]@{ EventId='error'; TimeCreated=''; EventType='Error'; Description=$_.Exception.Message; Username=''; SourceIp=''; LogonType=''; Status=''; Suspicious=$true } | ConvertTo-Json -Compress -Depth 4 } }"`;
}

function buildWindowsSecurityEventsExportCommand(): string {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ids = @(4624,4625,4648,4672,4720,4722,4724,4725,4726,4728,4732,4738,4740,4776); $dir=Join-Path ([IO.Path]::GetTempPath()) 'Lumina-IR'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; $path=Join-Path $dir ('security_events-' + $stamp + '.csv'); $count=0; $preview=New-Object System.Collections.Generic.List[object]; try { Get-WinEvent -FilterHashtable @{LogName='Security'; ID=$ids} -ErrorAction Stop | ForEach-Object { $msg = ($_.Message -replace '[\\r\\n]+', ' '); $eventType = switch ($_.Id) { 4624 { 'Logon success' } 4625 { 'Failed logon' } 4648 { 'Explicit credentials logon' } 4672 { 'Special privileges assigned' } 4720 { 'User created' } 4722 { 'User enabled' } 4724 { 'Password reset' } 4725 { 'User disabled' } 4726 { 'User deleted' } 4728 { 'Added to security group' } 4732 { 'Added to local group' } 4738 { 'User account changed' } 4740 { 'Account locked' } 4776 { 'Credential validation' } default { 'Security event' } }; $user = ''; if ($msg -match 'Account Name:\\s+([^\\s]+)') { $user = $Matches[1] }; $ip = ''; if ($msg -match 'Source Network Address:\\s+([^\\s]+)') { $ip = $Matches[1] }; $logonType = ''; if ($msg -match 'Logon Type:\\s+(\\d+)') { $logonType = $Matches[1] }; $status = ''; if ($msg -match 'Status:\\s+([^\\s]+)') { $status = $Matches[1] }; $row=[pscustomobject]@{ EventId=$_.Id; TimeCreated=$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); EventType=$eventType; Description=$msg; Username=$user; SourceIp=$ip; LogonType=$logonType; Status=$status; Suspicious=($_.Id -in @(4625,4672,4720,4726,4740)) }; if ($count -lt ${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}) { [void]$preview.Add($row) }; $count++; $row } | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding UTF8; [pscustomobject]@{ artifactPath=$path; totalCount=$count; preview=@($preview | Select-Object -First ${WINDOWS_EVENT_LOG_PREVIEW_LIMIT}); format='csv' } | ConvertTo-Json -Compress -Depth 5 } catch { if ($_.Exception.Message -match 'No events were found') { '' | Set-Content -LiteralPath $path -Encoding UTF8; [pscustomobject]@{ artifactPath=$path; totalCount=0; preview=@(); format='csv' } | ConvertTo-Json -Compress -Depth 5 } else { [pscustomobject]@{ EventId='error'; TimeCreated=''; EventType='Error'; Description=$_.Exception.Message; Username=''; SourceIp=''; LogonType=''; Status=''; Suspicious=$true } | ConvertTo-Json -Compress -Depth 4 } }"`;
}

export function getWindowsArtifactPageCommand(
    artifactPath: string,
    page = 1,
    pageSize = WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
    totalCount = 0,
): string {
    const currentPage = Math.max(1, Math.floor(page));
    const take = Math.min(500, Math.max(1, Math.floor(pageSize)));
    const skip = (currentPage - 1) * take;
    const safePath = artifactPath.replace(/'/g, "''");
    const safeTotalCount = Math.max(0, Math.floor(totalCount));

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $path='${safePath}'; $skip=${skip}; $take=${take}; try { if (-not (Test-Path -LiteralPath $path)) { throw ('Artifact not found: ' + $path) }; $rows=@(Import-Csv -LiteralPath $path | Select-Object -Skip $skip -First $take); [pscustomobject]@{ artifactPath=$path; totalCount=${safeTotalCount}; page=${currentPage}; pageSize=${take}; isPaged=$true; preview=@($rows); format='csv' } | ConvertTo-Json -Compress -Depth 5 } catch { $err=[pscustomobject]@{ error=$_.Exception.Message }; [pscustomobject]@{ artifactPath=$path; totalCount=${safeTotalCount}; page=${currentPage}; pageSize=${take}; isPaged=$true; preview=@($err); format='csv' } | ConvertTo-Json -Compress -Depth 5 }"`;
}

windowsLocalCommands.win_security_log = buildWindowsEventLogCommand('Security');
windowsLocalCommands.win_system_log = buildWindowsEventLogCommand('System');
windowsLocalCommands.win_app_log = buildWindowsEventLogCommand('Application');
windowsLocalCommands.win_powershell_log = buildWindowsEventLogCommand('Windows PowerShell');
windowsLocalCommands.security_events = buildWindowsSecurityEventsCommand();
windowsLocalCommands.logged_users = `powershell.exe -NoProfile -Command "$rows = @(); $queryCmd = Get-Command quser.exe,query.exe -ErrorAction SilentlyContinue | Select-Object -First 1; $lines = @(); if ($queryCmd) { if ($queryCmd.Name -eq 'query.exe') { $lines = @(& $queryCmd.Source user 2>$null) } else { $lines = @(& $queryCmd.Source 2>$null) } }; if ($lines.Count -gt 0) { foreach ($line in ($lines | Select-Object -Skip 1)) { $clean = ($line -replace '^\\s*>', '').Trim(); if (-not $clean) { continue }; if ($clean -match '^(?<User>\\S+)\\s+(?:(?<SessionName>\\S+)\\s+)?(?<SessionId>\\d+)\\s+(?<State>\\S+)\\s+(?<IdleTime>\\S+)\\s+(?<LogonTime>.+)$') { $session = $Matches.SessionName; $source = if ($session -match 'rdp|tcp') { 'Remote' } else { 'Local' }; $logonType = if ($source -eq 'Remote') { 10 } else { 2 }; $rows += [pscustomobject]@{ User=$Matches.User; SessionName=$session; SessionId=[int]$Matches.SessionId; State=$Matches.State; IdleTime=$Matches.IdleTime; LogonTime=$Matches.LogonTime.Trim(); Source=$source; LogonType=$logonType } } } }; if ($rows.Count -eq 0) { $rows = @([pscustomobject]@{ User=$env:USERNAME; SessionName='console'; SessionId=$null; State='Active'; IdleTime='-'; LogonTime='-'; Source='Local'; LogonType=2 }) }; $rows | ConvertTo-Json -Compress -Depth 3"`;
windowsLocalCommands.file_scan = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$winTemp = if ($env:WINDIR) { Join-Path $env:WINDIR 'Temp' } else { 'C:\\Windows\\Temp' }; $tempRoots = @($env:TEMP, $winTemp) | Where-Object { $_ -and (Test-Path $_) }; $publicDownloads = if ($env:PUBLIC) { Join-Path $env:PUBLIC 'Downloads' } else { $null }; $userDownloads = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'Downloads' } else { $null }; $execRoots = @($publicDownloads, $userDownloads, $env:APPDATA, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }; function Emit($name, $items) { Write-Output ('===' + $name + '==='); @($items) | ConvertTo-Json -Compress -Depth 4 }; $recentTemp = @(); foreach ($root in $tempRoots) { $recentTemp += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-1) }) }; Emit 'RECENT_TEMP' ($recentTemp | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension); $executables = @(); foreach ($root in $execRoots) { $executables += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' }) }; Emit 'USER_WRITABLE_EXECUTABLES' ($executables | Sort-Object LastWriteTime -Descending | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension); $webRoots = @('C:\\inetpub\\wwwroot','C:\\phpstudy_pro\\WWW','C:\\xampp\\htdocs','C:\\wamp64\\www','C:\\BtSoft\\WebSites') | Where-Object { Test-Path $_ }; $webFiles = @(); foreach ($root in $webRoots) { $webFiles += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) -and $_.Extension -match '^\\.(php|asp|aspx|jsp|jspx|js|config)$' }) }; Emit 'RECENT_WEBROOT' ($webFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 200 FullName,Name,Length,@{N='LastWriteTime';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')}},Extension)"`;
windowsLocalCommands.suspicious_files = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$winTemp = if ($env:WINDIR) { Join-Path $env:WINDIR 'Temp' } else { 'C:\\Windows\\Temp' }; $tempRoots = @($env:TEMP, $winTemp) | Where-Object { $_ -and (Test-Path $_) }; $userDownloads = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'Downloads' } else { $null }; $roots = @($tempRoots, $userDownloads, $env:APPDATA, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }; Write-Output '===RECENT_TEMP==='; $recentTemp = @(); foreach ($root in $tempRoots) { $recentTemp += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-1) }) }; $recentTemp | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===TEMP_EXE==='; $tempExe = @(); foreach ($root in $tempRoots) { $tempExe += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' }) }; $tempExe | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===HIDDEN_EXE==='; $hiddenExe = @(); foreach ($root in $roots) { $hiddenExe += @(Get-ChildItem -LiteralPath $root -File -Force -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::Hidden -and $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' }) }; $hiddenExe | Select-Object -First 80 -ExpandProperty FullName; Write-Output '===RECENT_MODIFIED==='; $recentExec = @(); foreach ($root in $roots) { $recentExec += @(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) -and $_.Extension -match '^\\.(exe|dll|ps1|bat|cmd|vbs|js|jar)$' }) }; $recentExec | Sort-Object LastWriteTime -Descending | Select-Object -First 120 -ExpandProperty FullName"`;
windowsLocalCommands.system_info = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254*' } | Select-Object -ExpandProperty IPAddress); [pscustomobject]@{ os_name=$os.Caption; os_version=$os.Version; hostname=$env:COMPUTERNAME; kernel_version=$os.BuildNumber; architecture=$os.OSArchitecture; cpu_cores=[int]$cs.NumberOfLogicalProcessors; cpu_model=$cpu.Name; total_memory_gb=[math]::Round($cs.TotalPhysicalMemory / 1GB, 2); used_memory_gb=[math]::Round(($cs.TotalPhysicalMemory - ($os.FreePhysicalMemory * 1KB)) / 1GB, 2); cpu_usage=0; uptime_seconds=[int]((Get-Date) - $os.LastBootUpTime).TotalSeconds; boot_time_str=$os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss'); timezone=(Get-TimeZone).Id; current_time=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); ip_addresses=$ips } | ConvertTo-Json -Compress -Depth 4"`;

export function getWindowsLocalCommand(
    moduleKey: string,
    webroot = '',
    options: { page?: number; pageSize?: number; startTimeExpression?: string } = {},
): string | undefined {
    const currentKey = moduleKey === 'software' ? 'installed_software' : moduleKey;
    if (currentKey === 'webshell_scan') {
        return buildWindowsWebshellScanCommand(webroot);
    }
    const logName = windowsEventLogModuleNames[currentKey];
    if (logName) {
        return buildWindowsEventLogCommand(logName, options.startTimeExpression, options.page, options.pageSize);
    }
    return windowsLocalCommands[currentKey];
}

export function getWindowsFullCollectionCommand(moduleKey: string, startTimeExpression?: string): string | undefined {
    const currentKey = moduleKey === 'software' ? 'installed_software' : moduleKey;
    if (currentKey === 'security_events') {
        return buildWindowsSecurityEventsExportCommand();
    }

    const logName = windowsEventLogModuleNames[currentKey];
    if (!logName) return undefined;

    return buildWindowsEventLogExportCommand(logName, startTimeExpression);
}

function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}天${hours}小时${minutes}分钟`;
    if (hours > 0) return `${hours}小时${minutes}分钟`;
    return `${minutes}分钟`;
}

export default function ModuleDetail({
    moduleKey,
    mode,
    osType,
    privilegeMode,
    sudoPassword,
    onNavigate,
    defaultDownloadPath,
    isDarkMode,
    glassEnabled,
    wallpaper,
    searchKeyword,
    setSearchKeyword,
    timeRange,
    setTimeRange,
    compactHeader = false
}: ModuleDetailProps) {
    const cardClass = glassEnabled ? 'glass-card' : '';
    const headerBg = wallpaper ? 'transparent' : (isDarkMode ? '#1a1a1a' : '#f5f5f5');
    const subCardBg = isDarkMode ? (glassEnabled ? 'transparent' : '#262626') : '#fafafa';
    const borderColor = isDarkMode ? '#434343' : '#f0f0f0';
    const isWindowsLocalMode = mode === 'local' && osType === 'Windows';
    const isLinuxRemoteMode = mode === 'remote' && osType === 'Linux';
    const isModuleWorkbenchMode = isWindowsLocalMode || isLinuxRemoteMode;
    const isCompactWindowsWorkspaceModule = isWindowsLocalMode && compactHeader;
    const workbenchShellClassName = isWindowsLocalMode
        ? 'windows-module-shell'
        : isLinuxRemoteMode
            ? 'linux-module-shell'
            : undefined;
    const workbenchWorkspaceClassName = isWindowsLocalMode
        ? 'windows-module-workspace'
        : isLinuxRemoteMode
            ? 'linux-module-workspace'
            : undefined;
    const workbenchHeaderClassName = isWindowsLocalMode
        ? `windows-module-header${isCompactWindowsWorkspaceModule ? ' windows-module-header-compact' : ''}`
        : isLinuxRemoteMode
            ? 'linux-module-header'
            : undefined;
    const workbenchTitlebarClassName = isWindowsLocalMode
        ? 'windows-module-titlebar'
        : isLinuxRemoteMode
            ? 'linux-module-titlebar'
            : undefined;
    const workbenchTitleClassName = isWindowsLocalMode
        ? 'windows-module-title'
        : isLinuxRemoteMode
            ? 'linux-module-title'
            : undefined;
    const workbenchMetaClassName = isWindowsLocalMode
        ? 'windows-module-meta'
        : isLinuxRemoteMode
            ? 'linux-module-meta'
            : undefined;
    const workbenchToolbarClassName = isWindowsLocalMode
        ? 'windows-module-toolbar'
        : isLinuxRemoteMode
            ? 'linux-module-toolbar'
            : undefined;
    const workbenchToolbarMainClassName = isWindowsLocalMode
        ? 'windows-module-toolbar-main'
        : isLinuxRemoteMode
            ? 'linux-module-toolbar-main'
            : undefined;
    const workbenchBodyClassName = isWindowsLocalMode
        ? 'windows-module-body'
        : isLinuxRemoteMode
            ? 'linux-module-body'
            : undefined;
    const effectiveModuleKey = moduleKey === 'software' ? 'installed_software' : moduleKey;
    const windowsMeta = isWindowsLocalMode ? getWindowsModuleMeta(moduleKey) : undefined;
    const linuxMeta = isLinuxRemoteMode ? getLinuxModuleMeta(moduleKey) : undefined;
    const moduleMeta = windowsMeta || linuxMeta;
    const displayTitle = moduleMeta?.title || moduleLabels[moduleKey] || moduleKey;
    const [localSearchKeyword, setLocalSearchKeyword] = useState('');
    const hasExternalSearch = typeof searchKeyword === 'string' && typeof setSearchKeyword === 'function';
    const effectiveSearchKeyword = hasExternalSearch ? searchKeyword : localSearchKeyword;
    const normalizedSearchKeyword = effectiveSearchKeyword.toLowerCase();
    const updateSearchKeyword = hasExternalSearch ? setSearchKeyword : setLocalSearchKeyword;
    const getFilteredTableData = (data: any[]) =>
        effectiveSearchKeyword
            ? data.filter(item =>
                Object.values(item).some(val =>
                    String(val).toLowerCase().includes(normalizedSearchKeyword)
                )
            )
            : data;
    const [loading, setLoading] = useState(true);
    const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
    const [remoteSystemInfo, setRemoteSystemInfo] = useState<RemoteSystemInfo | null>(null);
    const [tableData, setTableData] = useState<any[]>([]);
    const [listData, setListData] = useState<string[]>([]);
    const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
    const [rawOutput, setRawOutput] = useState<string>(''); // 原始命令输出
    const [collectionDiagnostic, setCollectionDiagnostic] = useState<CollectionDiagnostic | null>(null);
    const [collectionArtifact, setCollectionArtifact] = useState<WindowsCollectionArtifact | null>(null);
    const [collectionPreviewLimit, setCollectionPreviewLimit] = useState<number | null>(null);
    const [windowsLogPageInfo, setWindowsLogPageInfo] = useState<WindowsLogPageInfo | null>(null);
    const [fullCollectionLoading, setFullCollectionLoading] = useState(false);
    const [fullCollectionProgress, setFullCollectionProgress] = useState(0);
    const [fullCollectionStage, setFullCollectionStage] = useState('');
    const [iocSearchQuery, setIocSearchQuery] = useState('');
    const [iocSearchPath, setIocSearchPath] = useState('');
    const [iocSearchExtension, setIocSearchExtension] = useState('');
    const [iocHashAlgorithm, setIocHashAlgorithm] = useState<EverythingHashAlgorithm>('md5');
    const [iocHashValue, setIocHashValue] = useState('');
    const [iocContentQuery, setIocContentQuery] = useState('');
    const [iocSearchResults, setIocSearchResults] = useState<EverythingSearchResult[]>([]);
    const [iocSearchPage, setIocSearchPage] = useState(1);
    const [iocSearchTotalCount, setIocSearchTotalCount] = useState<number | null>(null);
    const [iocSearchHasMore, setIocSearchHasMore] = useState(false);
    const [iocSearchLoading, setIocSearchLoading] = useState(false);
    const [iocSearchError, setIocSearchError] = useState<string | null>(null);
    const iocSearchRequestSeq = useRef(0);
    const [dbSelectedDb, setDbSelectedDb] = useState<string>('');
    const [dbSelectedTable, setDbSelectedTable] = useState<string>('');
    const [dbTablesList, setDbTablesList] = useState<string[]>([]);
    const [dbColumnsList, setDbColumnsList] = useState<any[]>([]);
    const [dbTableData, setDbTableData] = useState<any[]>([]);
    const [dbExplorerLoading, setDbExplorerLoading] = useState(false);
    const [dbShowDebug, setDbShowDebug] = useState(false);
    const [windowsDatabaseWorkbenchOpen, setWindowsDatabaseWorkbenchOpen] = useState(false);
    const [selectedWindowsDatabaseInstance, setSelectedWindowsDatabaseInstance] = useState<WindowsDatabaseInstance | null>(null);

    const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
    const [terminalInput, setTerminalInput] = useState('');
    const [executing, setExecuting] = useState(false);
    const [terminalUser, setTerminalUser] = useState('user');
    const [terminalHost, setTerminalHost] = useState('host');
    const [terminalPath, setTerminalPath] = useState('~');
    const terminalRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // 文件管理状态
    const [filePath, setFilePath] = useState('/');
    const [fileList, setFileList] = useState<any[]>([]);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [viewingFile, setViewingFile] = useState<string | null>(null);
    const [hashModalOpen, setHashModalOpen] = useState(false);
    const [hashType, setHashType] = useState('md5');
    const [hashTarget, setHashTarget] = useState<any>(null);
    const [calculating, setCalculating] = useState(false);
    // 文件预览模态窗口状态
    const [previewModalOpen, setPreviewModalOpen] = useState(false);
    const [previewType, setPreviewType] = useState<'text' | 'image' | 'hex' | 'table'>('text');
    const [previewFileName, setPreviewFileName] = useState('');
    const [hexData, setHexData] = useState<number[]>([]);
    const [hexSearch, setHexSearch] = useState('');
    const [hexSearchResults, setHexSearchResults] = useState<number[]>([]);
    const [hexSearchMode, setHexSearchMode] = useState<'text' | 'hex'>('text');
    const [hexMatchLength, setHexMatchLength] = useState(0); // 记录匹配长度用于高亮
    const [currentMatchIndex, setCurrentMatchIndex] = useState(0); // 当前匹配索引
    const hexViewRef = useRef<HTMLDivElement>(null);
    const [imageBase64, setImageBase64] = useState<string | null>(null);
    // 路径编辑状态
    const [editingPath, setEditingPath] = useState(false);
    const [pathInput, setPathInput] = useState('/');
    // 文件/内容查找状态
    const [findModalOpen, setFindModalOpen] = useState(false);
    const [findType, setFindType] = useState<'file' | 'content'>('file');
    const [findQuery, setFindQuery] = useState('');
    const [findResults, setFindResults] = useState<any[]>([]);
    const [finding, setFinding] = useState(false);
    // Docker分析状态
    const [dockerInspectOpen, setDockerInspectOpen] = useState(false);
    const [dockerInspectData, setDockerInspectData] = useState<any>(null);
    const [dockerContainerId, setDockerContainerId] = useState('');
    const [dockerFileBrowserOpen, setDockerFileBrowserOpen] = useState(false);
    const [dockerFilePath, setDockerFilePath] = useState('/');
    const [dockerFileList, setDockerFileList] = useState<any[]>([]);

    // 扫描配置状态
    const [scanConfigOpen, setScanConfigOpen] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanDirs, setScanDirs] = useState({
        suid: '/usr /bin /sbin',
        webroot: '/var/www /www',
        temp: '/tmp /var/tmp /dev/shm',
    });

    // 终端自动滚动到底部
    useEffect(() => {
        if (!hasExternalSearch) {
            setLocalSearchKeyword('');
        }
    }, [effectiveModuleKey, hasExternalSearch]);

    useEffect(() => {
        if (terminalRef.current && moduleKey === 'terminal') {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [terminalOutput, moduleKey]);

    // 初始化终端 - 获取用户名、主机名和当前路径
    useEffect(() => {
        if (moduleKey === 'terminal' && mode === 'remote') {
            initTerminalPrompt();
        }
    }, [moduleKey, mode]);

    const handleOpenWindowsDatabaseWorkbench = useCallback((record: unknown) => {
        if (!isWindowsLocalMode || moduleKey !== 'database') {
            return;
        }

        const instance = buildWindowsDatabaseInstance(record);
        if (!instance) {
            message.warning('\u5f53\u524d\u6570\u636e\u5e93\u7c7b\u578b\u6682\u4e0d\u652f\u6301\u8be6\u60c5\u67e5\u770b');
            return;
        }

        setSelectedWindowsDatabaseInstance(instance);
        setWindowsDatabaseWorkbenchOpen(true);
    }, [isWindowsLocalMode, moduleKey]);

    const requestWindowsDatabaseReadonly = useCallback(async (request: WindowsDatabaseReadonlyRequest) => {
        const result = await invoke<WindowsDatabaseReadonlyCommandResult>('windows_database_readonly', { request });
        if (!result.success) {
            throw new Error(result.stderr || '\u6570\u636e\u5e93\u53ea\u8bfb\u8bf7\u6c42\u5931\u8d25');
        }

        return normalizeWindowsDatabaseReadonlyResponse(request, result.stdout || '');
    }, []);

    const requestWindowsDatabaseMutation = useCallback(async (
        request: WindowsDatabaseMutationRequest,
    ): Promise<WindowsDatabaseMutationResponse> => {
        const result = await invoke<WindowsDatabaseMutationCommandResult>('windows_database_mutation', { request });
        if (!result.success) {
            throw new Error(result.stderr || '\u5199\u5165\u5931\u8d25\uff0c\u672a\u4fee\u6539\u6570\u636e');
        }

        const stdout = result.stdout?.trim() ?? '';
        if (!stdout) {
            return { affectedRows: null, message: '\u5199\u5165\u5b8c\u6210' };
        }

        try {
            const parsed = JSON.parse(stdout) as Partial<WindowsDatabaseMutationResponse>;
            return {
                affectedRows: typeof parsed.affectedRows === 'number' ? parsed.affectedRows : null,
                message: parsed.message || '\u5199\u5165\u5b8c\u6210',
            };
        } catch {
            return { affectedRows: null, message: stdout || '\u5199\u5165\u5b8c\u6210' };
        }
    }, []);

    const buildIocFileSearchRequest = useCallback((): EverythingSearchRequest | null => {
        const nameQuery = iocSearchQuery.trim();
        const extension = normalizeEverythingExtensionFilter(iocSearchExtension);
        const hashValue = iocHashValue.trim();
        const content = iocContentQuery.trim();
        const path = iocSearchPath.trim();

        if (content && !path) {
            return null;
        }

        if (!isMeaningfulEverythingLiveQuery(nameQuery) && !extension && !hashValue && !content) {
            return null;
        }

        const query = buildEverythingSearchQuery({
            query: iocSearchQuery,
            extension: iocSearchExtension,
            hashAlgorithm: iocHashAlgorithm,
            hashValue: iocHashValue,
            content: iocContentQuery,
        });

        return {
            query: query || '*',
            path: path || undefined,
            maxResults: EVERYTHING_LIVE_MAX_RESULTS,
            offset: (Math.max(1, iocSearchPage) - 1) * EVERYTHING_LIVE_MAX_RESULTS,
            filesOnly: true,
            includeTotalCount: true,
        };
    }, [
        iocContentQuery,
        iocHashAlgorithm,
        iocHashValue,
        iocSearchPage,
        iocSearchExtension,
        iocSearchPath,
        iocSearchQuery,
    ]);

    const initTerminalPrompt = async () => {
        try {
            const [hostOut, pwdOut] = await Promise.all([
                executeRemoteCommand('hostname'),
                executeRemoteCommand('pwd'),
            ]);
            // 如果使用sudo/su提权，则显示为root用户
            if (privilegeMode === 'sudo' || privilegeMode === 'su') {
                setTerminalUser('root');
            } else {
                const userOut = await executeRemoteCommand('whoami');
                setTerminalUser(userOut.trim() || 'user');
            }
            setTerminalHost(hostOut.trim() || 'host');
            setTerminalPath(pwdOut.trim() || '~');
        } catch (e) {
            console.error('获取终端提示符信息失败:', e);
        }
    };

    useEffect(() => {
        if (moduleKey !== 'terminal') {
            loadData();
        } else {
            setLoading(false);
        }
    }, [moduleKey, mode, timeRange]);

    useEffect(() => {
        if (moduleKey === 'ioc_file_search' && iocSearchPage !== 1) {
            setIocSearchPage(1);
        }
    }, [
        iocContentQuery,
        iocHashAlgorithm,
        iocHashValue,
        iocSearchExtension,
        iocSearchPath,
        iocSearchQuery,
        moduleKey,
    ]);

    useEffect(() => {
        if (moduleKey !== 'ioc_file_search') return;

        const request = buildIocFileSearchRequest();
        const requestSeq = iocSearchRequestSeq.current + 1;
        iocSearchRequestSeq.current = requestSeq;

        if (!request) {
            setIocSearchResults([]);
            setIocSearchTotalCount(null);
            setIocSearchHasMore(false);
            setIocSearchLoading(false);
            setIocSearchError(null);
            setRawOutput('');
            return;
        }

        setIocSearchLoading(true);
        setIocSearchError(null);

        const timer = window.setTimeout(() => {
            searchEverythingFilesPage(request)
                .then((response) => {
                    if (iocSearchRequestSeq.current !== requestSeq) return;
                    setIocSearchResults(response.results);
                    setIocSearchTotalCount(typeof response.totalCount === 'number' ? response.totalCount : null);
                    setIocSearchHasMore(response.hasMore);
                    setRawOutput(JSON.stringify(response, null, 2));
                })
                .catch((error) => {
                    if (iocSearchRequestSeq.current !== requestSeq) return;
                    setIocSearchResults([]);
                    setIocSearchTotalCount(null);
                    setIocSearchHasMore(false);
                    setIocSearchError(String(error));
                })
                .finally(() => {
                    if (iocSearchRequestSeq.current === requestSeq) {
                        setIocSearchLoading(false);
                    }
                });
        }, EVERYTHING_SEARCH_DEBOUNCE_MS);

        return () => window.clearTimeout(timer);
    }, [buildIocFileSearchRequest, moduleKey]);

    const wrapCommand = (cmd: string): string => {
        if (mode !== 'remote') return cmd;
        switch (privilegeMode) {
            case 'sudo':
                return sudoPassword ? `echo '${sudoPassword}' | sudo -S ${cmd}` : `sudo ${cmd}`;
            case 'su':
                return sudoPassword ? `echo '${sudoPassword}' | su -c '${cmd}'` : `su -c '${cmd}'`;
            default:
                return cmd;
        }
    };

    const executeCommand = async (cmd: string): Promise<string> => {
        try {
            if (!isTauriRuntime()) {
                return '错误: 浏览器预览模式无法执行采集命令；请在 Tauri 桌面应用中使用本地/远程采集。';
            }

            if (mode === 'local') {
                const result = await invoke<{ stdout: string; stderr: string; success: boolean }>('execute_local_command', { command: cmd });
                return result.stdout || result.stderr || '';
            } else {
                const result = await invoke<{ stdout: string; stderr: string; success: boolean }>('ssh_execute', { command: wrapCommand(cmd) });
                return result.stdout || result.stderr || '';
            }
        } catch (error) {
            return `错误: ${error}`;
        }
    };

    const executeRemoteCommand = executeCommand; // 保持向后兼容

    // 终端专用命令执行 - 在sudo模式下使用sudo -i进入root shell执行
    const executeTerminalCommand = async (cmd: string, workingDir: string): Promise<string> => {
        try {
            let fullCmd: string;
            if (privilegeMode === 'sudo' && sudoPassword) {
                // 使用sudo -S执行命令，stderr重定向到stdout
                fullCmd = `echo '${sudoPassword}' | sudo -S sh -c 'cd ${workingDir} && ${cmd}' 2>&1`;
            } else if (privilegeMode === 'su' && sudoPassword) {
                fullCmd = `echo '${sudoPassword}' | su -c 'cd ${workingDir} && ${cmd}' 2>&1`;
            } else {
                // 普通模式，在指定目录执行
                fullCmd = `cd ${workingDir} && ${cmd} 2>&1`;
            }
            const result = await invoke<{ stdout: string; stderr: string }>('ssh_execute', { command: fullCmd });
            let output = result.stdout || result.stderr || '';
            // 过滤sudo密码提示和控制字符
            output = output
                .split('\n')
                .filter(line => !line.includes('[sudo]') && !line.includes('Password:') && !line.includes('password for'))
                .join('\n')
                .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // 移除控制字符
                .trim();
            return output;
        } catch (error) {
            return `错误: ${error}`;
        }
    };

    const loadData = async (options: ModuleLoadOptions = {}) => {
        // 文件管理和终端模块有自己的加载逻辑
        if (moduleKey === 'file_manager' || moduleKey === 'terminal' || moduleKey === 'ioc_file_search') {
            setLoading(false);
            return;
        }

        setLoading(true);
        setTableData([]);
        setListData([]);
        setCollectionDiagnostic(null);
        setCollectionArtifact(null);
        setCollectionPreviewLimit(null);
        setWindowsLogPageInfo(null);

        try {
            if (mode === 'local' && moduleKey === 'system_info') {
                const info = await invoke<SystemInfo>('get_system_info');
                setSystemInfo(info);
            } else if (mode === 'remote' && moduleKey === 'system_info') {
                await loadRemoteSystemInfo();
            } else {
                // 通用数据加载（本地/远程均使用通用命令）
                await loadRemoteData(options);
            }
        } catch (error) {
            console.error('加载数据失败:', error);
        } finally {
            setLoading(false);
        }
    };

    // 导出数据为CSV
    const exportToCsv = () => {
        if (tableData.length === 0) {
            message.warning('没有数据可导出');
            return;
        }

        const filteredData = getFilteredTableData(tableData);

        const configuredColumns = getAllColumns()
            .filter((col: any) => typeof col.dataIndex === 'string')
            .filter((col: any) => !hiddenColumns.includes(col.dataIndex))
            .filter((col: any) => filteredData.some(item => item[col.dataIndex] !== undefined));

        const fallbackKeys = Object.keys(filteredData[0] || {}).filter(k => k !== 'key' && !hiddenColumns.includes(k));
        const exportColumns = configuredColumns.length > 0
            ? configuredColumns.map((col: any) => ({
                key: col.dataIndex,
                title: typeof col.title === 'string' ? col.title : col.dataIndex,
            }))
            : fallbackKeys.map(key => ({ key, title: key }));

        // 生成CSV内容
        const header = exportColumns.map(col => col.title).join(',');
        const rows = filteredData.map(item =>
            exportColumns.map(col => {
                const raw = item[col.key];
                const val = String(raw ?? '').replace(/"/g, '""');
                return `"${val}"`;
            }).join(',')
        );
        const csvContent = [header, ...rows].join('\n');

        // 创建下载
        const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${moduleKey}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        message.success(`已导出 ${filteredData.length} 条记录`);
    };

    const loadRemoteSystemInfo = async () => {
        try {
            const [hostnameOut, osReleaseOut, uptimeOut, memOut, dfOut, cpuOut, ipOut, kernelOut, archOut, cpuModelOut, issueOut, redhatReleaseOut] = await Promise.all([
                executeRemoteCommand('hostname'),
                executeRemoteCommand('cat /etc/os-release 2>/dev/null'),
                executeRemoteCommand('uptime'),
                executeRemoteCommand('free -h | grep Mem'),
                executeRemoteCommand('df -h | grep -E "^/dev"'),
                executeRemoteCommand('nproc'),
                executeRemoteCommand('hostname -I 2>/dev/null | awk \'{print $1}\' || ip addr show | grep "inet " | head -1 | awk \'{print $2}\''),
                executeRemoteCommand('uname -r'),
                executeRemoteCommand('uname -m'),
                executeRemoteCommand('cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2'),
                executeRemoteCommand('cat /etc/issue 2>/dev/null | head -1'),
                executeRemoteCommand('cat /etc/redhat-release 2>/dev/null || cat /etc/centos-release 2>/dev/null || cat /etc/system-release 2>/dev/null'),
            ]);

            // 解析 os-release 的所有字段
            const osReleaseMap: Record<string, string> = {};
            for (const line of osReleaseOut.split('\n')) {
                const idx = line.indexOf('=');
                if (idx > 0) {
                    const key = line.substring(0, idx).trim();
                    const value = line.substring(idx + 1).trim().replace(/^"|"$/g, '');
                    osReleaseMap[key] = value;
                }
            }

            const osType = osReleaseMap['NAME'] || 'Linux';
            const osVersion = osReleaseMap['VERSION'] || '';
            const osName = osReleaseMap['OS_NAME'] || osReleaseMap['VERSION_CODENAME'] || osReleaseMap['VERSION'] || '';
            const idLike = osReleaseMap['ID_LIKE'] || osReleaseMap['ID'] || '';
            const versionId = osReleaseMap['VERSION_ID'] || '';
            const prettyName = osReleaseMap['PRETTY_NAME'] || osType;
            const homeUrl = osReleaseMap['HOME_URL'] || '';
            const bugReportUrl = osReleaseMap['BUG_REPORT_URL'] || '';

            // 解析 uptime
            const uptimeMatch = uptimeOut.match(/up\s+([^,]+)/);
            const loadMatch = uptimeOut.match(/load average:\s*(.+)/);

            // 解析内存
            const memParts = memOut.split(/\s+/);
            const memTotal = memParts[1] || '-';
            const memUsed = memParts[2] || '-';
            let memPercent = 0;
            if (memParts[1] && memParts[2]) {
                const parseSize = (s: string) => {
                    const num = parseFloat(s);
                    if (s.includes('G')) return num * 1024;
                    if (s.includes('M')) return num;
                    return num;
                };
                memPercent = Math.round((parseSize(memParts[2]) / parseSize(memParts[1])) * 100);
            }

            // 解析磁盘
            const disks: { mount: string; size: string; used: string; avail: string; percent: number }[] = [];
            for (const line of dfOut.split('\n')) {
                const parts = line.split(/\s+/);
                if (parts.length >= 6) {
                    disks.push({
                        mount: parts[5],
                        size: parts[1],
                        used: parts[2],
                        avail: parts[3],
                        percent: parseInt(parts[4]) || 0,
                    });
                }
            }

            setRemoteSystemInfo({
                hostname: hostnameOut.trim(),
                os_type: osType,
                os_version: osVersion || redhatReleaseOut.trim() || issueOut.replace(/\\n|\\l/g, '').trim(),
                ip_address: ipOut.trim().split('/')[0],
                kernel: kernelOut.trim(),
                uptime: uptimeMatch?.[1]?.trim() || '-',
                load_avg: loadMatch?.[1]?.trim() || '-',
                cpu_cores: parseInt(cpuOut.trim()) || 1,
                cpu_percent: 0,
                mem_total: memTotal,
                mem_used: memUsed,
                mem_percent: memPercent,
                timezone: 'CST',
                disks,
                // 扩展字段
                os_name: osName,
                id_like: idLike,
                version_id: versionId,
                pretty_name: prettyName || redhatReleaseOut.trim() || issueOut.replace(/\\n|\\l/g, '').trim(),
                home_url: homeUrl,
                bug_report_url: bugReportUrl,
                architecture: archOut.trim(),
                cpu_model: cpuModelOut.trim(),
                issue_info: issueOut.replace(/\\n|\\l/g, '').trim(),
                redhat_release: redhatReleaseOut.trim(),
            });
        } catch (error) {
            console.error('加载远程系统信息失败:', error);
        }
    };

    const loadRemoteData = async (options: ModuleLoadOptions = {}) => {
        let currentKey = moduleKey;
        // Alias for Windows software compatibility
        if (currentKey === 'software') currentKey = 'installed_software';

        let command = remoteCommands[currentKey];

        // 如果是 Windows 本地模式，优先使用 Windows 专用命令
        if (mode === 'local' && osType === 'Windows') {
            const windowsCommand = getWindowsLocalCommand(currentKey, scanDirs.webroot, {
                page: options.windowsLogPage ?? 1,
                pageSize: options.windowsLogPageSize
                    ?? windowsLogPageInfo?.pageSize
                    ?? WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
            });
            if (windowsCommand) {
                command = windowsCommand;
            }
        }

        if (!command) {
            setCollectionDiagnostic({
                reason: '模块未配置',
                severity: 'warning',
                suggestion: `${moduleLabels[currentKey] || currentKey} (${currentKey})：当前模式 ${mode}/${osType} 没有配置采集命令，或该模块不支持此系统。请切换匹配的系统模块，或补充 remoteCommands/windowsLocalCommands 映射。`,
                evidence: [
                    `module=${currentKey}`,
                    `mode=${mode}`,
                    `osType=${osType}`,
                ],
            });
            setRawOutput('');
            setTableData([]);
            setListData([]);
            return;
        }

        // 扫描模块设置加载状态
        if (currentKey === 'suspicious_files' || currentKey === 'webshell_scan') {
            setScanning(true);
        }

        // 可疑文件扫描使用自定义目录
        if (currentKey === 'suspicious_files' && !(mode === 'local' && osType === 'Windows')) {
            command = `echo "===SUID===" && timeout 10 find ${scanDirs.suid} -perm -4000 -type f 2>/dev/null | head -30 && echo "===SGID===" && timeout 10 find ${scanDirs.suid} -perm -2000 -type f 2>/dev/null | head -30 && echo "===WORLD_WRITABLE===" && timeout 5 find /etc /var/log -perm -0002 -type f 2>/dev/null | head -20 && echo "===HIDDEN_EXE===" && find ${scanDirs.temp} -name ".*" -type f -executable 2>/dev/null && echo "===TEMP_EXE===" && find ${scanDirs.temp} -type f -executable 2>/dev/null | head -30 && echo "===RECENT_MODIFIED===" && find /bin /sbin /usr/bin /usr/sbin -mtime -7 -type f 2>/dev/null | head -20`;
        }
        // Webshell扫描使用自定义目录
        if (currentKey === 'webshell_scan' && mode !== 'local') {
            command = `echo "===PHP===" && timeout 15 grep -rn --include="*.php" -E "eval\\(|base64_decode\\(|system\\(|exec\\(|shell_exec\\(" ${scanDirs.webroot} 2>/dev/null | head -30 && echo "===JSP===" && timeout 10 grep -rn --include="*.jsp" -E "ProcessBuilder|Runtime.getRuntime" ${scanDirs.webroot} 2>/dev/null | head -20 && echo "===ASP===" && timeout 10 grep -rn --include="*.asp*" -E "execute|eval|WScript" ${scanDirs.webroot} 2>/dev/null | head -20`;
        }

        // 日志时间过滤逻辑
        if (timeRange && timeRange !== 'all') {
            const timeMap: Record<string, string> = {
                '1h': '1 hour ago',
                '6h': '6 hours ago',
                '24h': '1 day ago',
                '3d': '3 days ago'
            };
            const since = timeMap[timeRange];
            const keyToCheck = currentKey; // Use effective key

            if (keyToCheck === 'auth_log') {
                command = `journalctl -t sshd --since "${since}" 2>/dev/null || journalctl _SYSTEMD_UNIT=sshd.service --since "${since}" 2>/dev/null || cat /var/log/auth.log /var/log/secure 2>/dev/null | tail -n 1000`;
            } else if (keyToCheck === 'syslog') {
                command = `journalctl --since "${since}" 2>/dev/null || cat /var/log/syslog /var/log/messages 2>/dev/null | tail -n 1000`;
            } else if (keyToCheck === 'failed_logins') {
                command = `journalctl _SYSTEMD_UNIT=sshd.service --since "${since}" 2>/dev/null | grep -i "failed\\|failure" || journalctl -t sshd --since "${since}" 2>/dev/null | grep -i "failed\\|failure" || (cat /var/log/auth.log /var/log/secure 2>/dev/null | grep -i "failed\\|failure" | tail -n 1000)`;
            } else if (keyToCheck === 'cron_log') {
                command = `journalctl _COMM=cron --since "${since}" 2>/dev/null || (cat /var/log/syslog /var/log/messages 2>/dev/null | grep -i cron | tail -n 1000)`;
            } else if (keyToCheck === 'sudo_log') {
                command = `journalctl _COMM=sudo --since "${since}" 2>/dev/null || (cat /var/log/auth.log /var/log/secure 2>/dev/null | grep -i sudo | tail -n 1000)`;
            } else if (keyToCheck === 'dmesg') {
                command = `journalctl -k --since "${since}" 2>/dev/null || dmesg | tail -n 1000`;
            } else if (keyToCheck === 'web_access_log') {
                command = `${command} | tail -n 3000`;
            } else if (['win_security_log', 'win_system_log', 'win_app_log', 'win_powershell_log'].includes(keyToCheck)) {
                const winSince = windowsLogTimeRangeStartExpressions[timeRange];
                const logName = windowsEventLogModuleNames[keyToCheck];
                command = buildWindowsEventLogCommand(
                    logName,
                    winSince,
                    options.windowsLogPage ?? 1,
                    options.windowsLogPageSize ?? windowsLogPageInfo?.pageSize ?? WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
                );
            }
        }

        try {
            const output = await executeRemoteCommand(command);
            setRawOutput(output);
            const diagnostic = buildCollectionDiagnostic(output, mode, currentKey);
            if (diagnostic) {
                setCollectionDiagnostic(diagnostic);
                setTableData([]);
                setListData([]);
                return;
            }
            if (!['suspicious_files', 'webshell_scan'].includes(currentKey)) {
                parseAndSetData(currentKey, output);
            }
        } finally {
            setScanning(false);
        }
    };

    const parseAndSetData = (key: string, output: string) => {
        const lines = output.split('\n').filter(l => l.trim());

        // 辅助函数：尝试解析JSON数组
        const tryParseJsonArray = (text: string): any[] | null => {
            try {
                const trimmed = text.trim();
                const parsed = JSON.parse(trimmed);
                return Array.isArray(parsed) ? parsed : [parsed];
            } catch {
                const queryUserLines = text
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);

                if (queryUserLines.length > 1 && queryUserLines[0].includes('USERNAME')) {
                    return queryUserLines
                        .slice(1)
                        .map((line) => line.replace(/^>/, '').trim())
                        .filter(Boolean)
                        .map((line) => {
                            const parts = line.split(/\s{2,}/).filter(Boolean);
                            const sessionName = (parts[1] || '').toLowerCase();
                            return {
                                User: parts[0] || '-',
                                LogonType: sessionName.includes('console') ? 2 : 10,
                                LogonTime: parts.slice(5).join(' ') || parts[4] || '-'
                            };
                        });
                }

                return null;
            }
        };

        const readSectionName = (line: string): string | null => {
            const match = line.trim().match(/^===([^=]+)===$/);
            return match ? match[1] : null;
        };

        const splitEndpoint = (endpoint: string): { address: string; port: string } => {
            const cleaned = (endpoint || '-').replace(/%[^:\]]+/, '');
            const bracketMatch = cleaned.match(/^(\[[^\]]+\]):(.+)$/);
            if (bracketMatch) {
                return { address: bracketMatch[1], port: bracketMatch[2] || '-' };
            }

            const idx = cleaned.lastIndexOf(':');
            if (idx > -1) {
                return {
                    address: cleaned.slice(0, idx) || '*',
                    port: cleaned.slice(idx + 1) || '-',
                };
            }

            return { address: cleaned || '-', port: '-' };
        };

        const parseSocketProcess = (text: string): { pid: string; process: string; processPath: string; pid_program: string } => {
            const quoted = text.match(/"([^"]+)",pid=(\d+)/);
            const netstat = text.match(/\b(\d+)\/([^\s,]+)/);
            const pidOnly = text.match(/pid=(\d+)/);
            const processOnly = text.match(/"([^"]+)"/);

            const pid = quoted?.[2] || netstat?.[1] || pidOnly?.[1] || '-';
            const process = quoted?.[1] || netstat?.[2] || processOnly?.[1] || '-';
            return {
                pid,
                process,
                processPath: '-',
                pid_program: pid !== '-' || process !== '-' ? [pid, process].filter(v => v !== '-').join('/') : '-',
            };
        };

        const parseLinuxSocketLine = (line: string, index: number) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) return null;

            const startsWithProto = /^(tcp|udp|raw)/i.test(parts[0]);
            let protocol = startsWithProto ? parts[0].toUpperCase() : 'TCP';
            let state = startsWithProto ? parts[1] : parts[0];
            let recv = startsWithProto ? parts[2] : parts[1];
            let send = startsWithProto ? parts[3] : parts[2];
            let local = startsWithProto ? parts[4] : parts[3];
            let peer = startsWithProto ? parts[5] : parts[4];
            let processText = startsWithProto ? parts.slice(6).join(' ') : parts.slice(5).join(' ');

            if (startsWithProto && /^\d+$/.test(parts[1] || '') && /^\d+$/.test(parts[2] || '')) {
                recv = parts[1] || '-';
                send = parts[2] || '-';
                local = parts[3] || '-';
                peer = parts[4] || '-';
                state = parts[5] || '-';
                processText = parts.slice(6).join(' ');
            }

            if (/^(tcp|udp)\d*$/i.test(state) && parts.length >= 6) {
                protocol = state.toUpperCase();
                state = parts[1] || '-';
                recv = parts[2] || '-';
                send = parts[3] || '-';
                local = parts[4] || '-';
                peer = parts[5] || '-';
                processText = parts.slice(6).join(' ');
            }

            const endpoint = splitEndpoint(local);
            const proc = parseSocketProcess(processText);
            return {
                key: index,
                protocol,
                proto: protocol,
                state,
                recv,
                send,
                local: local || '-',
                address: endpoint.address,
                port: endpoint.port,
                peer: peer || '-',
                ...proc,
            };
        };

        const detectLogSeverity = (message: string): string => {
            const lower = message.toLowerCase();
            if (/\b(error|err|critical|crit|panic|fatal|failed|failure|segfault|denied)\b/.test(lower)) return 'error';
            if (/\b(warn|warning|timeout|refused|invalid|blocked)\b/.test(lower)) return 'warning';
            if (/\b(accepted|success|started|completed)\b/.test(lower)) return 'success';
            return 'info';
        };

        const parseSyslogLine = (line: string, index: number, source = 'syslog') => {
            const dmesgMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
            if (dmesgMatch) {
                const message = dmesgMatch[2] || '';
                return {
                    key: index,
                    time: dmesgMatch[1],
                    host: '-',
                    process: 'kernel',
                    source,
                    severity: detectLogSeverity(message),
                    message,
                    content: message,
                    raw: line,
                };
            }

            const match = line.match(/^((?:\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})|(?:\d{4}-\d{2}-\d{2}T[^\s]+))\s+(\S+)\s+([^:]+):\s?(.*)$/);
            if (match) {
                return {
                    key: index,
                    time: match[1],
                    host: match[2],
                    process: match[3],
                    source,
                    severity: detectLogSeverity(match[4]),
                    message: match[4],
                    content: match[4],
                    raw: line,
                };
            }

            const message = line.substring(16) || line;
            return {
                key: index,
                time: line.substring(0, 15) || '-',
                host: '-',
                process: '-',
                source,
                severity: detectLogSeverity(message),
                message,
                content: message,
                raw: line,
            };
        };

        const detectSshKeyType = (filename: string): string => {
            if (filename === 'authorized_keys') return 'authorized key list';
            if (filename === 'known_hosts') return 'known_hosts';
            if (filename === 'config') return 'config';
            if (filename.endsWith('.pub')) return 'public key';
            if (/^id_[a-z0-9]+$/i.test(filename)) return 'private key';
            return 'file';
        };

        const parseLinuxPackageLine = (line: string, index: number, section: string) => {
            const trimmed = line.trim();
            if (!trimmed || readSectionName(trimmed) || /^(Desired=|正在|Name\s+Version|Name\s*:|Installed packages)/i.test(trimmed)) return null;

            if (trimmed.startsWith('ii')) {
                const parts = trimmed.split(/\s+/);
                if (parts.length < 3) return null;
                return {
                    key: index,
                    status: parts[0],
                    name: parts[1],
                    version: parts[2] || '-',
                    arch: parts[3] || '-',
                    publisher: section || 'dpkg',
                    date: '-',
                    size: '-',
                    installLocation: '-',
                    uninstallCommand: '-',
                    description: parts.slice(4).join(' ') || '-',
                };
            }

            const pacmanMatch = trimmed.match(/^(\S+)\s+(.+)$/);
            if (section === 'PACMAN' && pacmanMatch) {
                return {
                    key: index,
                    status: 'Installed',
                    name: pacmanMatch[1],
                    version: pacmanMatch[2],
                    arch: '-',
                    publisher: 'pacman',
                    date: '-',
                    size: '-',
                    installLocation: '-',
                    uninstallCommand: `pacman -R ${pacmanMatch[1]}`,
                    description: '-',
                };
            }

            if (!trimmed.includes(' ')) {
                const archMatch = trimmed.match(/\.(x86_64|aarch64|noarch|i[3-6]86|armv7hl|ppc64le|s390x)$/);
                const packageText = archMatch ? trimmed.slice(0, -archMatch[0].length) : trimmed;
                const rpmLike = packageText.match(/^(.+?)-([0-9].*)$/);
                if (rpmLike) {
                    return {
                        key: index,
                        status: 'Installed',
                        name: rpmLike[1],
                        version: rpmLike[2] || '-',
                        arch: archMatch?.[1] || '-',
                        publisher: section || (trimmed.includes('-r') ? 'apk/rpm' : 'rpm'),
                        date: '-',
                        size: '-',
                        installLocation: '-',
                        uninstallCommand: '-',
                        description: '-',
                    };
                }
            }

            if (pacmanMatch) {
                return {
                    key: index,
                    status: 'Installed',
                    name: pacmanMatch[1],
                    version: pacmanMatch[2],
                    arch: '-',
                    publisher: section || 'package',
                    date: '-',
                    size: '-',
                    installLocation: '-',
                    uninstallCommand: '-',
                    description: '-',
                };
            }

            return null;
        };

        const classifyShellConfigLine = (line: string) => {
            const trimmed = line.trim();
            const lower = trimmed.toLowerCase();
            const urlMatch = trimmed.match(/https?:\/\/[^\s'"|;]+/);
            const sourceMatch = trimmed.match(/^(?:source|\.)\s+(.+)$/);
            const aliasMatch = trimmed.match(/^alias\s+([^=\s]+)=/);
            const exportMatch = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);

            let type = 'command';
            let target = '-';
            let risk = 'info';
            let note = 'review';

            if (aliasMatch) {
                type = 'alias';
                target = aliasMatch[1];
                risk = 'warning';
                note = 'command-alias';
            } else if (sourceMatch) {
                type = 'source';
                target = sourceMatch[1].trim();
                risk = /\/tmp|\/dev\/shm|http|curl|wget/i.test(target) ? 'high' : 'warning';
                note = 'external-file';
            } else if (exportMatch) {
                type = 'environment';
                target = exportMatch[1];
                risk = target === 'PATH' && /\/tmp|\/dev\/shm/i.test(trimmed) ? 'warning' : 'info';
                note = target === 'PATH' ? 'path-change' : 'env-change';
            }

            if (/(curl|wget)\b/i.test(trimmed) && (/\|\s*(?:sh|bash|zsh)\b/i.test(trimmed) || urlMatch)) {
                type = 'remote-script';
                target = urlMatch?.[0] || target;
                risk = 'high';
                note = 'download-execute';
            } else if (/\b(eval|base64\s+-d|nc\s|ncat\s|socat\s|\/dev\/tcp)\b/i.test(trimmed)) {
                risk = 'high';
                note = 'suspicious-exec';
            } else if (lower.includes('nopasswd')) {
                risk = 'warning';
                note = 'privilege-change';
            }

            return { type, target, risk, note };
        };

        const parseShellConfigLines = (module: string, inputLines: string[]) => {
            let source = module === 'profile_check' ? 'PROFILE' : 'DEFAULT';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    source = section;
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return null;
                const classification = classifyShellConfigLine(trimmed);
                return {
                    key: i,
                    source,
                    ...classification,
                    command: trimmed,
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parsePamConfigLines = (inputLines: string[]) => {
            let service = 'DEFAULT';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    service = section;
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || /^total\s+\d+$/i.test(trimmed) || /^[dl-][rwx-]{9}\s/.test(trimmed)) return null;
                const parts = trimmed.split(/\s+/);
                if (parts.length < 3) {
                    return {
                        key: i,
                        service,
                        type: 'raw',
                        control: '-',
                        module: '-',
                        options: '-',
                        risk: 'info',
                        note: 'raw',
                        raw: trimmed,
                    };
                }

                const options = parts.slice(3).join(' ') || '-';
                const moduleName = parts[2] || '-';
                const lower = trimmed.toLowerCase();
                let risk = 'info';
                let note = 'standard';
                if (/pam_(tally2|faillock)|\bdeny=/.test(lower)) {
                    note = 'lockout';
                } else if (moduleName.includes('pam_google_authenticator') && lower.includes('nullok')) {
                    risk = 'warning';
                    note = 'optional-mfa';
                } else if (moduleName.includes('pam_permit')) {
                    risk = 'high';
                    note = 'permit-all';
                } else if (moduleName.includes('pam_rootok')) {
                    risk = 'warning';
                    note = 'root-bypass';
                }

                return {
                    key: i,
                    service,
                    type: parts[0] || '-',
                    control: parts[1] || '-',
                    module: moduleName,
                    options,
                    risk,
                    note,
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const getDiagnosticEvidence = (inputLines: string[] = lines): string[] => {
            const evidence = inputLines
                .map(line => line.trim())
                .filter(Boolean)
                .slice(0, 4)
                .map(line => compactEvidence(line, 360));
            return evidence.length > 0 ? evidence : [DIAGNOSTIC_NO_EVIDENCE];
        };

        const setNoRecordsDiagnostic = (sourceKey: string = key, inputLines: string[] = lines, suggestion?: string) => {
            const label = moduleLabels[sourceKey] || sourceKey;
            const diagnosticSuggestion = suggestion
                ? `${label} (${sourceKey})：${suggestion}`
                : `${label} (${sourceKey})：${DIAGNOSTIC_NO_RECORDS_FALLBACK}`;
            setCollectionDiagnostic({
                reason: DIAGNOSTIC_REASON_NO_RECORDS,
                severity: 'info',
                suggestion: diagnosticSuggestion,
                evidence: getDiagnosticEvidence(inputLines),
            });
            setTableData([]);
            setListData([]);
        };

        const setCollectionFailureDiagnostic = (sourceKey: string = key, message = '', suggestion?: string) => {
            const label = moduleLabels[sourceKey] || sourceKey;
            setCollectionDiagnostic({
                reason: DIAGNOSTIC_REASON_COLLECTION_FAILED,
                severity: 'error',
                suggestion: `${label} (${sourceKey})：${suggestion || DIAGNOSTIC_COLLECTION_FAILED_FALLBACK}`,
                evidence: message ? [compactEvidence(message)] : getDiagnosticEvidence(),
            });
            setTableData([]);
            setListData([]);
        };

        const setParseFailureDiagnostic = (sourceKey: string = key, message = '', suggestion?: string) => {
            const label = moduleLabels[sourceKey] || sourceKey;
            setCollectionDiagnostic({
                reason: DIAGNOSTIC_REASON_PARSE_FAILED,
                severity: 'warning',
                suggestion: `${label} (${sourceKey})：${suggestion || DIAGNOSTIC_PARSE_FAILED_FALLBACK}`,
                evidence: message ? [compactEvidence(message)] : getDiagnosticEvidence(),
            });
            setTableData([]);
            setListData([]);
        };

        const normalizeDfirValue = (value: any): string => {
            if (value === undefined || value === null || value === '') return '-';
            if (Array.isArray(value)) return value.map(normalizeDfirValue).filter(v => v !== '-').join('; ') || '-';
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
        };

        const parseWindowsGenericDfirJson = (sourceKey: string) => {
            const jsonData = tryParseJsonArray(output);
            if (!jsonData) {
                setParseFailureDiagnostic(sourceKey, output, `${moduleLabels[sourceKey] || sourceKey} 输出不是有效 JSON。请查看原始输出确认 PowerShell 是否被策略或权限拦截。`);
                return;
            }

            const errorOnly = jsonData.length === 1 && jsonData[0] && typeof jsonData[0] === 'object'
                && (jsonData[0].error || jsonData[0].Error)
                && !jsonData[0].category;
            if (errorOnly) {
                setCollectionFailureDiagnostic(sourceKey, String(jsonData[0].error ?? jsonData[0].Error));
                return;
            }

            const data = jsonData
                .filter((item: any) => item && typeof item === 'object')
                .map((item: any, i: number) => ({
                    key: i,
                    category: normalizeDfirValue(item.category ?? item.Category ?? moduleLabels[sourceKey] ?? sourceKey),
                    source: normalizeDfirValue(item.source ?? item.Source ?? sourceKey),
                    name: normalizeDfirValue(item.name ?? item.Name ?? item.title ?? item.Title),
                    path: normalizeDfirValue(item.path ?? item.Path ?? item.location ?? item.Location),
                    time: normalizeDfirValue(item.time ?? item.Time ?? item.TimeCreated ?? item.timeCreated),
                    detail: normalizeDfirValue(item.detail ?? item.Detail ?? item.description ?? item.Description ?? item.message ?? item.Message),
                    risk: normalizeDfirValue(item.risk ?? item.Risk ?? 'info'),
                    status: normalizeDfirValue(item.status ?? item.Status),
                    eventId: normalizeDfirValue(item.eventId ?? item.EventId ?? item.id ?? item.Id),
                    user: normalizeDfirValue(item.user ?? item.User ?? item.username ?? item.Username),
                    ip: normalizeDfirValue(item.ip ?? item.Ip ?? item.sourceIp ?? item.SourceIp),
                    raw: normalizeDfirValue(item.raw ?? item.Raw),
                }))
                .filter((item: any) => item.name !== '-' || item.detail !== '-' || item.path !== '-');

            if (data.length === 0) {
                setNoRecordsDiagnostic(sourceKey, lines, `${moduleLabels[sourceKey] || sourceKey} 命令已执行，但没有返回可展示记录。该主机可能没有对应痕迹，或当前用户权限不足。`);
            } else {
                setTableData(data);
                setListData([]);
                setCollectionDiagnostic(null);
            }
        };

        const isNoRecordOutputLine = (line: string): boolean => {
            const trimmed = line.trim();
            return (
                /^--\s*No entries\s*--$/i.test(trimmed) ||
                /^No entries\.?$/i.test(trimmed) ||
                /^No journal files were found\.?$/i.test(trimmed) ||
                /^--\s*No data\s*--$/i.test(trimmed)
            );
        };

        const parseSudoersLines = (inputLines: string[]) => {
            let source = 'sudoers';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    source = section;
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return null;

                if (/^Defaults\b/i.test(trimmed)) {
                    return {
                        key: i,
                        source,
                        principal: 'Defaults',
                        host: '-',
                        runAs: '-',
                        tag: '-',
                        command: trimmed.replace(/^Defaults\s*/i, '') || '-',
                        risk: /env_keep|secure_path/i.test(trimmed) ? 'info' : 'policy',
                        raw: trimmed,
                    };
                }

                const match = trimmed.match(/^(\S+)\s+(\S+)\s*=\s*(\([^)]+\))\s*(?:(NOPASSWD|PASSWD):\s*)?(.+)$/i);
                if (!match) {
                    return {
                        key: i,
                        source,
                        principal: trimmed.split(/\s+/)[0] || '-',
                        host: '-',
                        runAs: '-',
                        tag: '-',
                        command: trimmed,
                        risk: 'review',
                        raw: trimmed,
                    };
                }

                const command = match[5]?.trim() || '-';
                const tag = match[4]?.toUpperCase() || '-';
                let risk = 'standard';
                if (tag === 'NOPASSWD') risk = 'nopasswd';
                else if (command === 'ALL') risk = 'all-commands';

                return {
                    key: i,
                    source,
                    principal: match[1],
                    host: match[2],
                    runAs: match[3],
                    tag,
                    command,
                    risk,
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parseLinuxFirewallLines = (inputLines: string[]) => {
            let chain = '-';
            let source = 'iptables';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    source = section.toLowerCase();
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || /^target\s+prot\s+opt\s+source\s+destination/i.test(trimmed)) return null;

                const chainMatch = trimmed.match(/^Chain\s+(\S+)\s+\(policy\s+([^)]+)\)/i);
                if (chainMatch) {
                    chain = chainMatch[1];
                    return {
                        key: i,
                        source: 'iptables',
                        chain,
                        action: 'POLICY',
                        protocol: 'all',
                        from: '-',
                        to: '-',
                        port: '-',
                        options: chainMatch[2],
                        raw: trimmed,
                    };
                }

                const ufwMatch = trimmed.match(/^(\S+)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.+)?$/i);
                if (ufwMatch && !trimmed.includes('--')) {
                    const portProto = ufwMatch[1].split('/');
                    return {
                        key: i,
                        source: 'ufw',
                        chain: ufwMatch[3] || '-',
                        action: ufwMatch[2].toUpperCase(),
                        protocol: portProto[1] || 'all',
                        from: ufwMatch[4]?.trim() || '-',
                        to: '-',
                        port: portProto[0] || '-',
                        options: '-',
                        raw: trimmed,
                    };
                }

                const parts = trimmed.split(/\s+/);
                if (parts.length >= 5 && /^(ACCEPT|DROP|REJECT|RETURN|LOG|DNAT|SNAT|MASQUERADE)$/i.test(parts[0])) {
                    const options = parts.slice(5).join(' ');
                    const portMatch = options.match(/\b(?:dpt|spt|dports|sports):?([^\s,]+)/i);
                    return {
                        key: i,
                        source: source.includes('nft') ? 'nft' : 'iptables',
                        chain,
                        action: parts[0].toUpperCase(),
                        protocol: parts[1] || '-',
                        from: parts[3] || '-',
                        to: parts[4] || '-',
                        port: portMatch?.[1] || '-',
                        options: options || '-',
                        raw: trimmed,
                    };
                }

                const firewalldMatch = trimmed.match(/^(services|ports|sources|interfaces|rich rules):\s*(.*)$/i);
                if (firewalldMatch) {
                    return {
                        key: i,
                        source: 'firewalld',
                        chain: firewalldMatch[1],
                        action: 'CONFIG',
                        protocol: '-',
                        from: '-',
                        to: '-',
                        port: firewalldMatch[1].toLowerCase() === 'ports' ? firewalldMatch[2] || '-' : '-',
                        options: firewalldMatch[2] || '-',
                        raw: trimmed,
                    };
                }

                return {
                    key: i,
                    source: source || 'raw',
                    chain,
                    action: 'RAW',
                    protocol: '-',
                    from: '-',
                    to: '-',
                    port: '-',
                    options: trimmed,
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parseWindowsFirewallLines = (inputLines: string[]) => {
            let profile = 'global';
            return inputLines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed || /^-+$/.test(trimmed)) return null;

                const profileMatch = trimmed.match(/^(.+?)\s+Profile\s+Settings:?$/i);
                if (profileMatch) {
                    profile = profileMatch[1].trim();
                    return null;
                }

                const kvMatch = trimmed.match(/^([^:]+?)\s{2,}(.+)$/) || trimmed.match(/^([^:]+):\s*(.+)$/);
                if (!kvMatch) {
                    return { key: i, profile, setting: 'raw', value: trimmed, raw: trimmed };
                }

                return {
                    key: i,
                    profile,
                    setting: kvMatch[1].trim(),
                    value: kvMatch[2].trim(),
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parseSecurityStatusLines = (inputLines: string[]) => {
            let source = 'security';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    source = section;
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || isNoRecordOutputLine(trimmed)) return null;
                const kv = trimmed.match(/^([^:]+):\s*(.+)$/);
                const value = kv ? kv[2].trim() : trimmed;
                const lower = value.toLowerCase();
                return {
                    key: i,
                    source,
                    type: kv ? kv[1].trim() : 'status',
                    target: value,
                    risk: /(disabled|permissive|inactive|stopped)/i.test(lower) ? 'warning' : 'info',
                    note: /(enforcing|active|enabled)/i.test(lower) ? 'enabled' : 'review',
                    command: trimmed,
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parseLinuxRecentFileLines = (inputLines: string[]) => {
            return inputLines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed || /^(find:|ls:|error:)/i.test(trimmed)) return null;

                const pathMatch = trimmed.match(/(\/(?:[^\s]+\/)*[^\s]+)/);
                const path = pathMatch?.[1] || trimmed;
                const lastSlash = path.lastIndexOf('/');
                const directory = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
                const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
                const lowerPath = path.toLowerCase();

                let category = 'recent';
                let risk = 'info';
                let note = 'review';

                if (/\/\.ssh\/|\/etc\/(?:passwd|shadow|sudoers)|authorized_keys|id_rsa|id_ed25519/i.test(path)) {
                    category = 'sensitive';
                    risk = 'high';
                    note = 'credential-or-account-file';
                } else if (/^(?:\/tmp|\/var\/tmp|\/dev\/shm)\//i.test(path)) {
                    category = 'temporary';
                    risk = /\.(?:sh|py|pl|php|elf|bin)$/i.test(name) ? 'high' : 'warning';
                    note = 'temporary-write';
                } else if (/\/(?:www|html|public_html|nginx|apache2|httpd)\//i.test(path) || /\.(?:php|jsp|jspx|asp|aspx)$/i.test(name)) {
                    category = 'webroot';
                    risk = 'warning';
                    note = 'web-facing-file';
                } else if (/\.(?:sh|py|pl|rb|elf|bin)$/i.test(name) || lowerPath.includes('/bin/')) {
                    category = 'executable';
                    risk = 'warning';
                    note = 'executable';
                }

                return {
                    key: i,
                    name: name || path,
                    path,
                    directory,
                    category,
                    risk,
                    note,
                    lastAccess: '-',
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        const parseLinuxDnsConfigLines = (inputLines: string[]) => {
            let source = '/etc/resolv.conf';
            return inputLines.map((line, i) => {
                const section = readSectionName(line);
                if (section) {
                    source = section;
                    return null;
                }

                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return null;
                const [directive = 'raw', ...rest] = trimmed.split(/\s+/);
                const valueText = rest.join(' ').trim();
                const lowerDirective = directive.toLowerCase();

                if (lowerDirective === 'nameserver') {
                    return {
                        key: i,
                        source,
                        type: 'resolver',
                        value: rest[0] || '-',
                        detail: rest.slice(1).join(' ') || '-',
                        raw: trimmed,
                    };
                }

                if (lowerDirective === 'search') {
                    return {
                        key: i,
                        source,
                        type: 'search-domain',
                        value: rest.join(', ') || '-',
                        detail: valueText || '-',
                        raw: trimmed,
                    };
                }

                if (lowerDirective === 'domain') {
                    return {
                        key: i,
                        source,
                        type: 'domain',
                        value: valueText || '-',
                        detail: '-',
                        raw: trimmed,
                    };
                }

                if (lowerDirective === 'options') {
                    return {
                        key: i,
                        source,
                        type: 'resolver-option',
                        value: valueText || '-',
                        detail: valueText || '-',
                        raw: trimmed,
                    };
                }

                return {
                    key: i,
                    source,
                    type: lowerDirective || 'raw',
                    value: valueText || trimmed,
                    detail: '-',
                    raw: trimmed,
                };
            }).filter(Boolean);
        };

        switch (key) {
            case 'process_list': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            user: '-',
                            pid: String(item.Id || '-'),
                            cpu: item.CPU ? item.CPU.toFixed(1) : '0',
                            mem: item.WorkingSet64 ? (item.WorkingSet64 / 1048576).toFixed(1) + ' MB' : '-',
                            command: item.ProcessName || '-',
                            path: item.Path || '-'
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('process_list', lines, 'Windows 进程命令已执行，但没有返回进程记录。请确认 Get-Process 可用，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('process_list', output, 'Windows 进程列表输出不是有效 JSON。请检查 Get-Process 输出。');
                    }
                } else {
                    const data = lines.slice(1).filter(line => line.trim()).map((line, i) => {
                        const parts = line.split(/\s+/);
                        return { key: i, user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3], command: parts.slice(10).join(' ') };
                    });
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('process_list', lines, '进程列表命令已执行，但没有解析出进程记录。请确认 ps 输出格式，或检查目标系统是否限制命令执行。');
                    } else {
                        setTableData(data.slice(0, 25));
                    }
                }
                break;
            }
            case 'user_list': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => {
                            // 处理LastLogon - 可能是日期字符串或Date对象
                            let lastLogon = '-';
                            if (item.LastLogon) {
                                if (typeof item.LastLogon === 'string' && item.LastLogon.includes('/Date(')) {
                                    // PowerShell JSON日期格式 /Date(1234567890000)/
                                    const timestamp = parseInt(item.LastLogon.replace(/\/Date\((\d+)\)\//, '$1'));
                                    if (!isNaN(timestamp)) {
                                        lastLogon = new Date(timestamp).toLocaleString('zh-CN');
                                    }
                                } else {
                                    lastLogon = String(item.LastLogon);
                                }
                            }
                            return {
                                key: i,
                                username: item.Name || '-',
                                uid: '-',
                                gid: '-',
                                comment: item.Description || '-',
                                home: 'C:\\Users\\' + (item.Name || ''),
                                shell: '-',
                                userType: item.Enabled ? '已启用' : '已禁用',
                                userTypeColor: item.Enabled ? '#52c41a' : '#8c8c8c',
                                canLogin: item.Enabled,
                                lastLogon: lastLogon
                            };
                        });
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('user_list', lines, 'Windows 用户命令已执行，但没有返回本地用户记录。请确认 Get-LocalUser 可用，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('user_list', output, 'Windows 用户列表输出不是有效 JSON。请检查 Get-LocalUser 输出。');
                    }
                } else {
                    // 解析所有用户，并根据UID区分用户类型
                    const data = lines.filter(l => l.includes(':')).map((line, i) => {
                        const parts = line.split(':');
                        const uid = parseInt(parts[2]) || 0;
                        const shell = parts[6] || '';
                        // 判断用户类型
                        let userType = '普通用户';
                        let userTypeColor = '#52c41a'; // 绿色
                        if (uid === 0) {
                            userType = 'root';
                            userTypeColor = '#f5222d'; // 红色
                        } else if (uid < 1000) {
                            userType = '系统用户';
                            userTypeColor = '#faad14'; // 橙色
                        } else if (shell.includes('nologin') || shell.includes('false')) {
                            userType = '服务账户';
                            userTypeColor = '#8c8c8c'; // 灰色
                        }
                        return {
                            key: i,
                            username: parts[0],
                            uid: parts[2],
                            gid: parts[3],
                            comment: parts[4] || '-',
                            home: parts[5],
                            shell: parts[6],
                            userType: userType,
                            userTypeColor: userTypeColor,
                            canLogin: !shell.includes('nologin') && !shell.includes('false')
                        };
                    });
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('user_list', lines, '用户列表命令已执行，但没有解析出 /etc/passwd 用户记录。请确认文件权限或命令输出格式。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'logged_users': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            user: item.User || '-',
                            terminal: item.SessionName || (item.LogonType === 2 ? 'console' : (item.LogonType === 10 ? 'rdp' : '-')),
                            sessionId: item.SessionId !== null && item.SessionId !== undefined ? String(item.SessionId) : '-',
                            state: item.State || '-',
                            idleTime: item.IdleTime || '-',
                            time: item.LogonTime || '-',
                            login_time: item.LogonTime || '-',
                            duration: item.IdleTime || '-',
                            ip: item.ClientName || item.SourceIp || '-',
                            source: item.Source || (item.LogonType === 10 ? 'Remote' : 'Local')
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('logged_users', lines, 'Windows 登录会话命令已执行，但没有返回当前会话记录。请确认 quser/Get-CimInstance 输出，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('logged_users', output, 'Windows 登录会话输出不是有效 JSON。请检查 quser 或 PowerShell 输出。');
                    }
                } else {
                    // 分离 who 和 last 的输出
                    const whoSection = output.split('---LAST---')[0] || '';
                    const lastSection = output.split('---LAST---')[1] || '';

                    interface LoggedUser {
                        key: number;
                        user: string;
                        terminal: string;
                        sessionId: string;
                        state: string;
                        idleTime: string;
                        time: string;
                        login_time: string;
                        duration: string;
                        ip: string;
                        source: string;
                    }

                    const users: LoggedUser[] = [];

                    // 解析 who 输出 (格式: user terminal date time (display))
                    whoSection.split('\n').filter(l => l.trim()).forEach((line, i) => {
                        const parts = line.split(/\s+/);
                        if (parts.length >= 3) {
                            const user = parts[0];
                            const terminal = parts[1];
                            // 时间可能是 2024-12-17 09:33 格式
                            const ipMatch = line.match(/\(([^)]+)\)/);
                            const ip = ipMatch ? ipMatch[1] : '-';
                            const idleTime = parts[4] && !parts[4].startsWith('(') ? parts[4] : '-';
                            const sessionId = parts[5] && /^\d+$/.test(parts[5]) ? parts[5] : '-';
                            const time = `${parts[2] || '-'} ${parts[3] || ''}`.trim();
                            users.push({
                                key: users.length,
                                user,
                                terminal,
                                sessionId,
                                state: idleTime === 'old' ? 'Idle' : 'Active',
                                idleTime,
                                time,
                                login_time: time,
                                duration: idleTime,
                                ip,
                                source: 'Current'
                            });
                        }
                    });

                    // 解析 last 输出 (格式: user terminal ip date time - time (duration))
                    lastSection.split('\n').filter(l => l.trim() && !l.startsWith('wtmp') && !l.includes('begins')).forEach((line) => {
                        const parts = line.split(/\s+/);
                        if (parts.length >= 4 && parts[0] !== 'reboot') {
                            const user = parts[0];
                            const terminal = parts[1];
                            // 判断第三个字段是IP还是日期
                            let ip = '-';
                            let timeStart = 2;
                            if (parts[2] && /^\d{1,3}\.\d{1,3}\./.test(parts[2])) {
                                ip = parts[2];
                                timeStart = 3;
                            }
                            const remaining = parts.slice(timeStart).join(' ');
                            const time = parts.slice(timeStart, timeStart + 4).join(' ');
                            const durationMatch = remaining.match(/\(([^)]+)\)\s*$/);
                            const duration = remaining.includes('still logged in') ? 'still logged in' : durationMatch?.[1] || '-';
                            const state = remaining.includes('still logged in') ? 'Active' : remaining.includes('crash') ? 'Crash' : 'Closed';
                            users.push({
                                key: users.length,
                                user,
                                terminal,
                                sessionId: '-',
                                state,
                                idleTime: '-',
                                time: time.substring(0, 20),
                                login_time: time.substring(0, 20),
                                duration,
                                ip,
                                source: 'History'
                            });
                        }
                    });

                    if (users.length === 0) {
                        setNoRecordsDiagnostic('logged_users', lines, '登录会话命令已执行，但没有解析出当前会话或历史登录记录。请确认 who/last 输出格式，或扩大登录历史范围。');
                    } else {
                        setTableData(users.slice(0, 30));
                    }
                }
                break;
            }
            case 'history_cmd': {
                const cmds = lines.filter(l => l.trim() && !l.startsWith(':')).map((cmd, i) => ({
                    key: i,
                    index: i + 1,
                    command: cmd,
                }));
                if (cmds.length === 0) {
                    setNoRecordsDiagnostic('history_cmd', lines, '历史命令采集已执行，但没有解析出可展示命令。请确认 shell history 文件存在，或以目标用户身份重新采集。');
                } else {
                    setTableData(cmds);
                }
                break;
            }
            case 'disk_info': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData
                            .filter((item: any) => item.DriveLetter)  // 只保留有盘符的
                            .map((item: any, i: number) => {
                                const size = item.Size || 0;
                                const free = item.SizeRemaining || 0;
                                const used = size - free;
                                const sizeGB = (size / 1073741824).toFixed(1);
                                const freeGB = (free / 1073741824).toFixed(1);
                                const usedGB = (used / 1073741824).toFixed(1);
                                const usedPercent = size > 0 ? Math.round((used / size) * 100) : 0;
                                return {
                                    key: i,
                                    filesystem: item.FileSystemLabel || 'Local Disk',
                                    size: sizeGB + 'G',
                                    used: usedGB + 'G',
                                    avail: freeGB + 'G',
                                    percent: usedPercent,
                                    mount: item.DriveLetter + ':'
                                };
                            });
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('disk_info', lines, 'Windows 磁盘信息命令已执行，但没有返回带盘符的卷记录。请确认磁盘卷状态，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('disk_info', output, 'Windows 磁盘信息输出不是有效 JSON。请检查 Get-Volume 输出。');
                    }
                } else {
                    const data = lines.slice(1).filter(line => line.trim()).map((line, i) => {
                        const parts = line.split(/\s+/);
                        return { key: i, filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3], percent: parseInt(parts[4]) || 0, mount: parts[5] };
                    });
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('disk_info', lines, '磁盘信息命令已执行，但没有解析出文件系统记录。请确认 df 输出格式，或检查目标系统是否限制命令执行。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'listen_ports': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            proto: 'TCP',
                            protocol: 'TCP',
                            local: (item.LocalAddress || '-') + ':' + (item.LocalPort || '-'),
                            address: item.LocalAddress || '-',
                            port: item.LocalPort?.toString() || '-',
                            peer: '-',
                            state: item.State || 'LISTEN',
                            pid: item.OwningProcess?.toString() || '-',
                            process: item.ProcessName || item.OwningProcess?.toString() || '-',
                            processPath: item.ProcessPath || '-'
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('listen_ports', lines, 'Windows 监听端口命令已执行，但没有发现监听连接。请确认目标主机当前是否存在监听服务，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('listen_ports', output, 'Windows 监听端口输出不是有效 JSON。请检查 Get-NetTCPConnection 输出。');
                    }
                } else {
                    const data = lines
                        .filter(line => !readSectionName(line) && !/^(State|Netid)\s+/i.test(line.trim()))
                        .map((line, i) => parseLinuxSocketLine(line, i))
                        .filter(Boolean);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('listen_ports', lines, '监听端口命令已执行，但没有解析出监听连接。请确认 ss/netstat 是否可用，或目标系统当前是否存在监听服务。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'ssh_keys': {
                let currentDir = '/root/.ssh';
                const data = lines.map((line, i) => {
                    const section = readSectionName(line);
                    if (section) {
                        const dirMatch = section.match(/^SSH_DIR:(.+)$/);
                        if (dirMatch) currentDir = dirMatch[1] === '~/.ssh' ? '/root/.ssh' : dirMatch[1];
                        return null;
                    }

                    if (line.trim().startsWith('total')) return null;
                    const parts = line.split(/\s+/);
                    const filename = parts[8];
                    if (!filename || filename === '.' || filename === '..') return null;
                    const owner = parts[2] || 'root';
                    const sshDir = currentDir === '/root/.ssh' && owner !== 'root' ? `/home/${owner}/.ssh` : currentDir;
                    const fullPath = `${sshDir.replace(/\/$/, '')}/${filename}`;
                    const type = detectSshKeyType(filename);
                    return {
                        key: i,
                        permissions: parts[0],
                        owner,
                        size: parts[4],
                        filename,
                        file: filename,
                        type,
                        fullPath,
                        danger: filename === 'authorized_keys' || type === 'private key',
                    };
                }).filter(Boolean);
                if (data.length === 0) {
                    setNoRecordsDiagnostic('ssh_keys', lines, 'SSH 密钥目录可访问，但没有发现 authorized_keys、公钥或私钥文件。可切换 root/sudo 后重新采集，或确认目标用户家目录。');
                } else {
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('user_list', lines, '用户列表命令已执行，但没有解析出 /etc/passwd 用户记录。请确认文件权限或命令输出格式。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'service_list': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            unit: item.Name || '-',
                            load: 'loaded',
                            active: item.Status === 'Running' ? 'active' : 'inactive',
                            sub: item.StartType?.toString() || '-',
                            description: item.DisplayName || '-'
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('service_list', lines, 'Windows 服务命令已执行，但没有返回服务记录。请确认服务管理器可用，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('service_list', output, 'Windows 服务列表输出不是有效 JSON。请检查 Get-Service 输出。');
                    }
                } else {
                    let currentSection = '';
                    const data = lines.map((line, i) => {
                        const section = readSectionName(line);
                        if (section) {
                            currentSection = section;
                            return null;
                        }

                        const trimmed = line.trim();
                        if (!trimmed || /^UNIT\s+LOAD\s+ACTIVE\s+SUB/i.test(trimmed)) return null;

                        const sysvMatch = trimmed.match(/^\[\s*([+\-?])\s*\]\s+(.+)$/);
                        if (sysvMatch) {
                            const stateMap: Record<string, string> = { '+': 'running', '-': 'stopped', '?': 'unknown' };
                            return {
                                key: i,
                                unit: sysvMatch[2].trim(),
                                load: 'sysv',
                                active: stateMap[sysvMatch[1]] || 'unknown',
                                sub: '-',
                                description: currentSection || 'SYSV_SERVICES',
                                source: 'sysv',
                            };
                        }

                        const chkconfigMatch = trimmed.match(/^(\S+)\s+(.+:\S+.*)$/);
                        if (chkconfigMatch && chkconfigMatch[2].includes(':')) {
                            const active = /(?:^|\s)[2-5]:on\b/.test(chkconfigMatch[2]) ? 'enabled' : 'disabled';
                            return {
                                key: i,
                                unit: chkconfigMatch[1],
                                load: 'sysv',
                                active,
                                sub: '-',
                                description: chkconfigMatch[2],
                                source: 'chkconfig',
                            };
                        }

                        const parts = trimmed.split(/\s+/);
                        if (parts.length < 4) return null;
                        return {
                            key: i,
                            unit: parts[0],
                            load: parts[1],
                            active: parts[2],
                            sub: parts[3],
                            description: parts.slice(4).join(' ') || '-',
                            source: currentSection === 'SYSV_SERVICES' ? 'sysv' : 'systemd',
                        };
                    }).filter(Boolean);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('service_list', lines, '服务列表命令已执行，但没有解析出 systemd、SysV 或 chkconfig 服务记录。请确认 systemctl/service 命令可用，或切换权限重新采集。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'startup': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            unit: item.Name || item.Command || '-',
                            state: 'enabled',
                            preset: item.User || '-',
                            command: item.Command || '-',
                            location: item.Location || '-',
                            user: item.User || '-'
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('startup', lines, 'Windows 启动项命令已执行，但没有返回启动项记录。请确认启动项来源，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('startup', output, 'Windows 启动项输出不是有效 JSON。请检查 Win32_StartupCommand 输出。');
                    }
                } else {
                    let currentSection = '';
                    const data = lines.map((line, i) => {
                        const section = readSectionName(line);
                        if (section) {
                            currentSection = section;
                            return null;
                        }

                        const trimmed = line.trim();
                        if (!trimmed || /^UNIT\s+FILE\s+STATE/i.test(trimmed) || trimmed.includes('unit files listed')) return null;

                        if (currentSection === 'INIT_D' || (!currentSection && !trimmed.includes('.service') && !/\s+(enabled|disabled|static|masked)\b/.test(trimmed))) {
                            const unit = trimmed.split(/\s+/)[0];
                            if (!unit || unit === '.' || unit === '..') return null;
                            return {
                                key: i,
                                unit,
                                state: 'enabled',
                                preset: '-',
                                source: 'init.d',
                                command: `/etc/init.d/${unit}`,
                                description: '-',
                            };
                        }

                        const parts = trimmed.split(/\s+/);
                        if (parts.length < 2) return null;
                        return {
                            key: i,
                            unit: parts[0],
                            state: parts[1],
                            preset: parts[2] || '-',
                            source: 'systemd',
                            command: '-',
                            description: parts.slice(3).join(' ') || '-',
                        };
                    }).filter(Boolean);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('startup', lines, '启动项命令已执行，但没有解析出 systemd enabled 单元或 init.d 脚本。请确认 systemctl 输出，或检查 /etc/init.d 权限。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'cron': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const normalizeTaskValue = (value: any): string => {
                            if (value === null || value === undefined || value === '') return '-';
                            if (Array.isArray(value)) return value.map(normalizeTaskValue).filter(v => v !== '-').join('; ') || '-';
                            if (typeof value === 'object') return JSON.stringify(value);
                            return String(value);
                        };
                        const errorItem = jsonData.find((item: any) =>
                            item && typeof item === 'object' && (item.error || item.Error)
                        );
                        if (errorItem) {
                            const errorMessage = normalizeTaskValue(errorItem.error ?? errorItem.Error);
                            setCollectionDiagnostic({
                                reason: '采集失败',
                                severity: 'error',
                                suggestion: '计划任务采集失败。请以管理员身份运行本地程序，或检查 Windows 计划任务服务和 PowerShell 执行权限。',
                                evidence: [errorMessage],
                            });
                            setTableData([]);
                            break;
                        }

                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            taskPath: normalizeTaskValue(item.TaskPath ?? item.taskPath),
                            taskName: normalizeTaskValue(item.TaskName ?? item.taskName ?? item.command),
                            state: normalizeTaskValue(item.State ?? item.state ?? item.schedule),
                            actions: normalizeTaskValue(item.Actions ?? item.actions ?? item.Action),
                            triggers: normalizeTaskValue(item.Triggers ?? item.triggers ?? item.Trigger),
                            lastRunTime: normalizeTaskValue(item.LastRunTime ?? item.lastRunTime),
                            nextRunTime: normalizeTaskValue(item.NextRunTime ?? item.nextRunTime),
                            lastResult: normalizeTaskValue(item.LastTaskResult ?? item.lastTaskResult ?? item.lastResult),
                            author: normalizeTaskValue(item.Author ?? item.author),
                            description: normalizeTaskValue(item.Description ?? item.description),
                        }));
                        if (data.length === 0) {
                            setCollectionDiagnostic({
                                reason: '未发现记录',
                                severity: 'info',
                                suggestion: '计划任务命令已执行，但 Windows 没有返回计划任务记录。可尝试以管理员身份运行，或确认 Task Scheduler 服务状态。',
                                evidence: ['Get-ScheduledTask returned 0 records.'],
                            });
                            setTableData([]);
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionDiagnostic({
                            reason: '解析失败',
                            severity: 'warning',
                            suggestion: '计划任务命令已执行，但输出不是可解析的 JSON。请检查 PowerShell 输出或复制原始输出进一步分析。',
                            evidence: output ? output.split('\n').slice(0, 8) : ['无输出'],
                        });
                        setTableData([]);
                    }
                } else {
                    let currentSource = 'crontab';
                    let currentUser = '-';
                    let currentType = 'crontab';
                    const data = lines.map((line, i) => {
                        const section = readSectionName(line);
                        if (section) {
                            const userCrontab = section.match(/^USER_CRONTAB:(.+)$/);
                            const cronD = section.match(/^CRON_D:(.+)$/);
                            const cronDir = section.match(/^CRON_DIR:(.+)$/);
                            const spoolCron = section.match(/^SPOOL_CRON:(.+)$/);
                            if (userCrontab) {
                                currentSource = 'user crontab';
                                currentUser = userCrontab[1] || '-';
                                currentType = 'crontab';
                            } else if (section === 'ETC_CRONTAB') {
                                currentSource = '/etc/crontab';
                                currentUser = '-';
                                currentType = 'system crontab';
                            } else if (cronD) {
                                currentSource = cronD[1] || '/etc/cron.d';
                                currentUser = '-';
                                currentType = 'cron.d';
                            } else if (cronDir) {
                                currentSource = cronDir[1] || '/etc/cron.*';
                                currentUser = 'root';
                                currentType = 'cron directory';
                            } else if (spoolCron) {
                                currentSource = 'spool cron';
                                currentUser = spoolCron[1] || '-';
                                currentType = 'spool crontab';
                            } else if (section === 'SYSTEMD_TIMERS') {
                                currentSource = 'systemd timer';
                                currentUser = 'systemd';
                                currentType = 'systemd timer';
                            } else {
                                currentSource = section;
                                currentUser = '-';
                                currentType = 'cron';
                            }
                            return null;
                        }

                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('#') || /^SHELL=|^PATH=|^MAILTO=|^HOME=/i.test(trimmed)) return null;

                        if (currentType === 'systemd timer') {
                            if (/^NEXT\s+LEFT\s+LAST\s+PASSED\s+UNIT\s+ACTIVATES/i.test(trimmed) || /\btimers?\s+listed\.?$/i.test(trimmed)) return null;
                            const parts = trimmed.split(/\s+/);
                            const timerIndex = parts.findIndex(part => part.endsWith('.timer'));
                            const timerUnit = timerIndex >= 0 ? parts[timerIndex] : '-';
                            const activates = timerIndex >= 0
                                ? (parts.slice(timerIndex + 1).find(part => /\.(service|target|path|socket|mount)$/i.test(part)) || '-')
                                : '-';
                            return {
                                key: i,
                                source: currentSource,
                                type: currentType,
                                user: currentUser,
                                schedule: timerIndex > 0 ? parts.slice(0, timerIndex).join(' ') : '-',
                                unit: timerUnit,
                                activates,
                                command: activates !== '-' ? activates : trimmed,
                            };
                        }

                        if (currentType === 'cron directory') {
                            const fileName = trimmed.split(/\s+/).pop() || trimmed;
                            const fullPath = fileName.startsWith('/') ? fileName : `${currentSource}/${fileName}`;
                            return {
                                key: i,
                                source: currentSource,
                                type: currentType,
                                user: currentUser,
                                schedule: currentSource.replace('/etc/cron.', '@'),
                                unit: fileName,
                                activates: '-',
                                command: fullPath,
                            };
                        }

                        const parts = trimmed.split(/\s+/);
                        if (parts.length < 6) {
                            return {
                                key: i,
                                source: currentSource,
                                type: currentType,
                                user: currentUser,
                                schedule: '-',
                                unit: '-',
                                activates: '-',
                                command: trimmed,
                            };
                        }

                        const hasUserField = currentSource === '/etc/crontab' || (currentSource !== 'user crontab' && currentUser === '-');
                        return {
                            key: i,
                            source: currentSource,
                            type: currentType,
                            user: hasUserField ? (parts[5] || '-') : currentUser,
                            schedule: parts.slice(0, 5).join(' '),
                            unit: '-',
                            activates: '-',
                            command: hasUserField ? parts.slice(6).join(' ') : parts.slice(5).join(' '),
                        };
                    }).filter(Boolean);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('cron', lines, '计划任务命令已执行，但没有解析出 crontab、cron 目录或 systemd timer 记录。请确认 cron/systemd timer 是否启用，或切换权限重新采集。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'installed_software': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData
                            .filter((item: any) => item.DisplayName)
                            .map((item: any, i: number) => {
                                const estimatedSize = Number(item.EstimatedSize);
                                return {
                                    key: i,
                                    status: 'Installed',
                                    name: item.DisplayName || '-',
                                    version: item.DisplayVersion || '-',
                                    arch: '-',
                                    publisher: item.Publisher || '-',
                                    date: item.InstallDate || '-',
                                    size: Number.isFinite(estimatedSize) && estimatedSize > 0 ? `${(estimatedSize / 1024).toFixed(1)} MB` : '-',
                                    installLocation: item.InstallLocation || '-',
                                    uninstallCommand: item.QuietUninstallString || item.UninstallString || '-',
                                    infoUrl: item.URLInfoAbout || item.HelpLink || '-',
                                    description: [item.Publisher, item.InstallDate, item.InstallLocation].filter(Boolean).join(' / ') || '-',
                                };
                            });
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('installed_software', lines, 'Windows 软件清单命令已执行，但没有返回可展示的软件记录。请确认注册表读取权限，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('installed_software', output, 'Windows 软件清单输出不是有效 JSON。请检查注册表读取权限和 PowerShell 输出。');
                    }
                } else {
                    let currentSection = '';
                    const data = lines.map((line, i) => {
                        const section = readSectionName(line);
                        if (section) {
                            currentSection = section;
                            return null;
                        }
                        return parseLinuxPackageLine(line, i, currentSection);
                    }).filter(Boolean).slice(0, 200);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('installed_software', lines, '软件清单命令已执行，但没有解析出包记录。请确认目标系统包管理器可用，或以更高权限重新采集。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'docker': {
                if (osType === 'Windows' && output.includes('DOCKER_INSTALL')) {
                    const sections = output.split(/===([A-Z_]+)===/);
                    const rows: any[] = [];
                    const parseJsonRows = (content: string): any[] => {
                        const trimmed = content.trim();
                        if (!trimmed || trimmed === '[]') return [];
                        try {
                            const parsed = JSON.parse(trimmed);
                            return Array.isArray(parsed) ? parsed : [parsed];
                        } catch {
                            return [];
                        }
                    };

                    for (let i = 1; i < sections.length; i += 2) {
                        if (sections[i] === 'DOCKER_INSTALL') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                const dockerPath = item.CommandPath || item.DesktopPath || '-';
                                rows.push({
                                    key: rows.length,
                                    container_id: 'installed',
                                    image: item.Version || 'Docker installed',
                                    status: 'Installed',
                                    names: item.DesktopPath ? 'Docker Desktop' : 'Docker CLI',
                                    ports: dockerPath,
                                    isContainerRecord: false,
                                });
                            });
                        } else if (sections[i] === 'DOCKER_SERVICE') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                rows.push({
                                    key: rows.length,
                                    container_id: item.Name || 'service',
                                    image: item.DisplayName || item.Name || 'Docker service',
                                    status: item.State || 'Unknown',
                                    names: item.Name || '-',
                                    ports: item.PathName || '-',
                                    isContainerRecord: false,
                                });
                            });
                        } else if (sections[i] === 'DOCKER_CONTAINERS') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                rows.push({
                                    key: rows.length,
                                    container_id: String(item.ID || '').substring(0, 12),
                                    image: item.Image,
                                    status: item.Status,
                                    names: item.Names,
                                    ports: item.Ports || '-',
                                    isContainerRecord: true,
                                });
                            });
                        }
                    }

                    if (rows.length === 0) {
                        setNoRecordsDiagnostic('docker', lines, 'Docker 容器命令已执行，但没有发现 Docker 安装、服务或容器记录。');
                    } else {
                        setTableData(rows);
                    }
                    break;
                }

                // 解析 docker ps -a --format 输出 (ID|Image|Status|Names|Ports)
                const data = lines.filter(l => l.includes('|')).map((line, i) => {
                    const parts = line.split('|');
                    return {
                        key: i,
                        container_id: parts[0]?.substring(0, 12),
                        image: parts[1],
                        status: parts[2],
                        names: parts[3],
                        ports: parts[4] || '-',
                        isContainerRecord: true,
                    };
                });
                if (data.length === 0) {
                    setNoRecordsDiagnostic('docker', lines, 'Docker 容器命令已执行，但没有解析出容器记录。请确认 Docker 是否安装/运行，或当前用户是否有 docker 权限。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'docker_images': {
                if (osType === 'Windows' && output.includes('DOCKER_INSTALL')) {
                    const sections = output.split(/===([A-Z_]+)===/);
                    const rows: any[] = [];
                    const parseJsonRows = (content: string): any[] => {
                        const trimmed = content.trim();
                        if (!trimmed || trimmed === '[]') return [];
                        try {
                            const parsed = JSON.parse(trimmed);
                            return Array.isArray(parsed) ? parsed : [parsed];
                        } catch {
                            return [];
                        }
                    };

                    for (let i = 1; i < sections.length; i += 2) {
                        if (sections[i] === 'DOCKER_IMAGES') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                rows.push({
                                    key: rows.length,
                                    repository: item.Repository || '<none>',
                                    tag: item.Tag || 'latest',
                                    image_id: String(item.ID || '').substring(0, 12),
                                    size: item.Size || '-',
                                    created: item.CreatedAt || '-',
                                });
                            });
                        }
                    }

                    if (rows.length === 0) {
                        setNoRecordsDiagnostic('docker_images', lines, 'Docker 镜像命令已执行，但未发现镜像记录。Docker 可能已安装但当前没有本地镜像。');
                    } else {
                        setTableData(rows);
                    }
                    break;
                }

                // 解析 docker images --format 输出
                const data = lines.filter(l => l.includes('|')).map((line, i) => {
                    const parts = line.split('|');
                    return {
                        key: i,
                        repository: parts[0] || '<none>',
                        tag: parts[1] || 'latest',
                        image_id: parts[2]?.substring(0, 12),
                        size: parts[3],
                        created: parts[4]
                    };
                });
                if (data.length === 0) {
                    setNoRecordsDiagnostic('docker_images', lines, 'Docker 镜像命令已执行，但没有解析出镜像记录。请确认 Docker 是否安装/运行，或当前用户是否具有 docker 权限。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'database': {
                // Windows JSON DB Support
                if (output.includes('DB_SERVICES')) {
                    const sections = output.split(/===([A-Z_]+)===/);
                    const dbs: any[] = [];

                    const parseJsonRows = (content: string): any[] => {
                        const trimmed = content.trim();
                        if (!trimmed || trimmed === '[]') return [];
                        try {
                            const parsed = JSON.parse(trimmed);
                            return Array.isArray(parsed) ? parsed : [parsed];
                        } catch {
                            return [];
                        }
                    };

                    const inferDatabaseType = (...values: unknown[]): string => {
                        const text = values.filter(Boolean).join(' ').toLowerCase();
                        if (text.includes('mssql') || text.includes('sql server') || text.includes('sqlservr')) return 'SQL Server';
                        if (text.includes('mysql') || text.includes('mariadb') || text.includes('mysqld')) return 'MySQL/MariaDB';
                        if (text.includes('postgres') || text.includes('pgsql')) return 'PostgreSQL';
                        if (text.includes('redis')) return 'Redis';
                        if (text.includes('mongo')) return 'MongoDB';
                        if (text.includes('oracle') || text.includes('tnslsnr')) return 'Oracle';
                        if (text.includes('elastic')) return 'Elasticsearch';
                        return 'Database';
                    };

                    const typeByPort: Record<string, string> = {
                        '1433': 'SQL Server',
                        '1434': 'SQL Server',
                        '3306': 'MySQL/MariaDB',
                        '5432': 'PostgreSQL',
                        '6379': 'Redis',
                        '27017': 'MongoDB',
                        '27018': 'MongoDB',
                        '1521': 'Oracle',
                        '9200': 'Elasticsearch',
                        '9300': 'Elasticsearch',
                    };

                    const isSqlServerEngineService = (item: any): boolean => {
                        const name = String(item.Name || '').trim().toLowerCase();
                        const displayName = String(item.DisplayName || '').trim();
                        const pathName = String(item.PathName || '').trim().toLowerCase();
                        return name === 'mssqlserver'
                            || name.startsWith('mssql$')
                            || /^sql server \([^)]+\)$/i.test(displayName)
                            || /\\sqlservr\.exe"?$/i.test(pathName);
                    };

                    const addUnique = (values: string[], value: unknown) => {
                        const text = String(value || '').trim();
                        if (text && !values.includes(text)) {
                            values.push(text);
                        }
                    };

                    const statusTag = (value: unknown) => {
                        const raw = String(value || '').trim();
                        const lower = raw.toLowerCase();
                        if (lower.includes('running') || lower === 'run' || lower === 'listen' || lower === 'established') {
                            return { label: '运行中', color: '#52c41a' };
                        }
                        if (lower.includes('stopped') || lower.includes('stop')) {
                            return { label: '已停止', color: '#f5222d' };
                        }
                        if (lower.includes('process')) {
                            return { label: '进程存在', color: '#1890ff' };
                        }
                        return { label: raw || '-', color: 'blue' };
                    };

                    const portRowsByIdentity = new Map<string, any>();
                    const upsertDatabasePortRow = (item: any) => {
                        const port = String(item.LocalPort || '').trim();
                        const status = statusTag(item.State);
                        const dbType = typeByPort[port] || inferDatabaseType(item.ProcessName, item.ProcessPath);
                        const processName = String(item.ProcessName || '').trim();
                        const pid = String(item.OwningProcess || '-').trim();
                        const processPath = String(item.ProcessPath || '-').trim();
                        const instanceTarget = dbType === 'SQL Server' ? 'MSSQLSERVER' : '';
                        const mergeKey = [dbType, processName, pid, processPath, instanceTarget].join('|');
                        const row = portRowsByIdentity.get(mergeKey) || {
                            key: dbs.length,
                            source: '端口',
                            name: processName || `${typeByPort[port] || 'Database'}:${port || '-'}`,
                            type: dbType,
                            instanceTarget,
                            localAddress: '',
                            host: item.LocalAddress || 'localhost',
                            credentialMode: 'detected',
                            status: status.label,
                            statusColor: status.color,
                            version: '-',
                            port: '-',
                            pid,
                            path: processPath,
                            detail: '-',
                            _ports: [] as string[],
                            _localAddresses: [] as string[],
                        };

                        addUnique(row._ports, port);
                        addUnique(row._localAddresses, item.LocalAddress);
                        row.port = row._ports.join(', ') || '-';
                        row.localAddress = row._localAddresses.join(', ');
                        row.version = row.localAddress || '-';
                        row.detail = row.localAddress ? `监听地址：${row.localAddress}` : '-';

                        if (!portRowsByIdentity.has(mergeKey)) {
                            portRowsByIdentity.set(mergeKey, row);
                            dbs.push(row);
                        }
                    };

                    for (let i = 1; i < sections.length; i += 2) {
                        if (sections[i] === 'DB_SERVICES') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                const status = statusTag(item.State || item.Status);
                                const dbType = inferDatabaseType(item.Name, item.DisplayName, item.PathName);
                                const canOpenDetails = dbType !== 'SQL Server' || isSqlServerEngineService(item);
                                dbs.push({
                                    key: dbs.length,
                                    source: '服务',
                                    name: item.DisplayName || item.Name || '-',
                                    type: dbType,
                                    rawServiceName: item.Name || '',
                                    instanceTarget: canOpenDetails ? item.Name || '' : '',
                                    host: 'localhost',
                                    credentialMode: canOpenDetails ? 'detected' : 'unavailable',
                                    status: status.label,
                                    statusColor: status.color,
                                    version: item.StartMode ? `启动类型：${item.StartMode}` : '-',
                                    port: '-',
                                    pid: item.ProcessId || '-',
                                    path: item.PathName || '-',
                                    detail: item.StartName ? `运行账户：${item.StartName}` : '-',
                                });
                            });
                        } else if (sections[i] === 'DB_PORTS') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                upsertDatabasePortRow(item);
                            });
                        } else if (sections[i] === 'DB_PROCESSES') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                const status = statusTag('process');
                                dbs.push({
                                    key: dbs.length,
                                    source: '进程',
                                    name: item.Name || '-',
                                    type: inferDatabaseType(item.Name, item.ExecutablePath, item.CommandLine),
                                    rawServiceName: item.Name || '',
                                    host: 'localhost',
                                    credentialMode: 'detected',
                                    status: status.label,
                                    statusColor: status.color,
                                    version: '-',
                                    port: '-',
                                    pid: item.ProcessId || '-',
                                    path: item.ExecutablePath || '-',
                                    detail: item.CommandLine || '-',
                                });
                            });
                        } else if (sections[i] === 'DB_INSTALLS') {
                            parseJsonRows(sections[i + 1] || '').forEach((item: any) => {
                                const dbType = inferDatabaseType(item.DisplayName, item.Publisher, item.InstallLocation);
                                dbs.push({
                                    key: dbs.length,
                                    source: '安装',
                                    name: item.DisplayName || dbType,
                                    type: dbType,
                                    host: 'localhost',
                                    credentialMode: 'unavailable',
                                    status: '已安装',
                                    statusColor: '#1890ff',
                                    version: item.DisplayVersion || '-',
                                    port: '-',
                                    pid: '-',
                                    path: item.InstallLocation || '-',
                                    detail: item.Publisher || item.Source || '-',
                                });
                            });
                        }
                    }
                    if (dbs.length === 0) {
                        setNoRecordsDiagnostic('database', lines, 'Windows 数据库检测命令已执行，但没有发现常见数据库服务、监听端口、进程或安装痕迹。');
                    } else {
                        setTableData(dbs.map(({ _ports, _localAddresses, ...row }) => row));
                    }
                    break;
                }

                // 解析数据库检测结果
                interface DbInfo {
                    key: number;
                    name: string;
                    version: string;
                    status: string;
                    statusColor: string;
                }
                const databases: DbInfo[] = [];
                const sections = output.split(/===(\w+)===/);
                for (let i = 1; i < sections.length; i += 2) {
                    const dbName = sections[i];
                    const content = sections[i + 1]?.trim() || '';
                    if (content) {
                        const lines = content.split('\n').filter(l => l.trim());
                        const version = lines[0] || '未知版本';
                        const statusLine = lines[1] || '';
                        const isActive = statusLine.includes('active') || statusLine.includes('PONG');
                        databases.push({
                            key: databases.length,
                            name: dbName,
                            version: version,
                            status: isActive ? '运行中' : '已停止',
                            statusColor: isActive ? '#52c41a' : '#f5222d'
                        });
                    }
                }
                setTableData(databases);
                break;
            }
            case 'auth_log':
            case 'syslog':
            case 'dmesg':
            case 'cron_log': {
                const logLines = lines
                    .filter(l => l.trim() && !isNoRecordOutputLine(l))
                    .map((line, i) => parseSyslogLine(line, i, key));
                if (logLines.length === 0) {
                    setNoRecordsDiagnostic(key, lines, `${moduleLabels[key] || key} 命令已执行，但当前时间范围内没有返回日志记录。可扩大时间范围，或确认目标系统是否使用 journalctl/传统日志文件记录该类事件。`);
                } else {
                    setTableData(logLines);
                }
                break;
            }
            case 'failed_logins': {
                // 登录失败日志 - 提取关键信息
                const logLines = lines.filter(l => l.trim() && !isNoRecordOutputLine(l)).map((line, i) => {
                    // 尝试提取用户名和IP
                    const userMatch = line.match(/user[=:\s]+(\w+)/i) || line.match(/for\s+(\w+)/i);
                    const ipMatch = line.match(/from\s+([0-9.]+)/);
                    return {
                        key: i,
                        time: line.substring(0, 15) || '-',
                        user: userMatch ? userMatch[1] : '-',
                        ip: ipMatch ? ipMatch[1] : '-',
                        content: line.substring(16) || line
                    };
                });
                if (logLines.length === 0) {
                    setNoRecordsDiagnostic('failed_logins', lines, '登录失败查询已执行，但没有发现 failed/failure/invalid 相关记录。可扩大时间范围，或确认 SSH/认证日志路径。');
                } else {
                    setTableData(logLines);
                }
                break;
            }
            case 'lastlog': {
                // lastlog 输出: Username Port From Latest
                const data = lines.slice(1).filter(l => l.trim() && !l.includes('Never logged in')).map((line, i) => {
                    const parts = line.split(/\s+/);
                    return {
                        key: i,
                        user: parts[0] || '-',
                        port: parts[1] || '-',
                        from: parts[2] || '-',
                        latest: parts.slice(3).join(' ') || '-'
                    };
                });
                if (data.length === 0 && lines.length > 0) {
                    setCollectionDiagnostic({
                        reason: '未发现记录',
                        severity: 'info',
                        suggestion: 'lastlog 可读取，但没有发现有效登录记录。系统账号可能从未登录，或登录记录已轮转/清理。',
                        evidence: lines.slice(0, 8),
                    });
                    setTableData([]);
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'web_access_log': {
                // Nginx/Apache access.log: IP - - [datetime] "METHOD /path HTTP/1.1" status size
                const data = lines.filter(l => l.trim() && !isNoRecordOutputLine(l)).map((line, i) => {
                    const combinedMatch = line.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+([^\s"]+)(?:\s+[^"]*)?"\s+(\d{3})\s+(\S+)(?:\s+"([^"]*)"\s+"([^"]*)")?/);
                    if (combinedMatch) {
                        return {
                            key: i,
                            ip: combinedMatch[1],
                            time: combinedMatch[2],
                            method: combinedMatch[3],
                            path: combinedMatch[4],
                            status: combinedMatch[5],
                            size: combinedMatch[6],
                            referer: combinedMatch[7] || '-',
                            user_agent: combinedMatch[8] || '-',
                            userAgent: combinedMatch[8] || '-',
                            content: line,
                        };
                    }

                    const ipMatch = line.match(/^(\d+\.\d+\.\d+\.\d+)/);
                    const dateMatch = line.match(/\[([^\]]+)\]/);
                    const methodMatch = line.match(/"([A-Z]+)\s+([^\s"]+)/);
                    const statusMatch = line.match(/"\s+(\d{3})\s+(\d+)/);
                    return {
                        key: i,
                        ip: ipMatch ? ipMatch[1] : '-',
                        time: dateMatch ? dateMatch[1] : '-',
                        method: methodMatch ? methodMatch[1] : '-',
                        path: methodMatch ? methodMatch[2] : '-',
                        status: statusMatch ? statusMatch[1] : '-',
                        size: statusMatch ? statusMatch[2] : '-',
                        referer: '-',
                        user_agent: '-',
                        userAgent: '-',
                        content: line,
                    };
                });
                if (data.length === 0) {
                    setNoRecordsDiagnostic('web_access_log', lines, 'Web 访问日志命令已执行，但没有解析出 Nginx/Apache/IIS 访问记录。请确认日志路径、时间范围和读取权限，或在设置中补充站点日志目录。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'sudo_log': {
                const data = lines.filter(l => l.trim() && l.toLowerCase().includes('sudo')).map((line, i) => {
                    const parsed = parseSyslogLine(line, i);
                    const userMatch = line.match(/sudo:\s+([^\s:]+)/);
                    const pwdMatch = line.match(/PWD=([^;]+)/);
                    const targetUserMatch = line.match(/USER=([^;]+)/);
                    const cmdMatch = line.match(/COMMAND=(.+)$/);
                    return {
                        key: i,
                        time: parsed.time,
                        host: parsed.host,
                        process: parsed.process,
                        user: userMatch ? userMatch[1] : '-',
                        cwd: pwdMatch ? pwdMatch[1].trim() : '-',
                        targetUser: targetUserMatch ? targetUserMatch[1].trim() : '-',
                        command: cmdMatch ? cmdMatch[1].trim() : parsed.message,
                        content: parsed.message,
                    };
                });
                if (data.length === 0 && lines.length > 0) {
                    setCollectionDiagnostic({
                        reason: '未发现记录',
                        severity: 'info',
                        suggestion: '日志文件可读取，但没有匹配到 sudo 提权记录。可放宽时间范围，或确认目标系统是否使用 sudo/journalctl 记录提权日志。',
                        evidence: lines.slice(0, 8),
                    });
                    setTableData([]);
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'firewall': {
                const data = parseLinuxFirewallLines(lines);
                if (data.length === 0) {
                    setNoRecordsDiagnostic('firewall', lines, '防火墙命令已执行，但没有解析出 iptables/ufw/firewalld/nft 规则。可确认防火墙服务是否启用，或切换 root 权限重新采集。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'bashrc_check':
            case 'profile_check': {
                const data = parseShellConfigLines(key, lines);
                if (data.length === 0) {
                    setNoRecordsDiagnostic(key, lines, `${moduleLabels[key] || key} 已读取，但没有发现有效配置行。可切换权限或检查目标用户的 shell 配置文件是否存在。`);
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'pam_config': {
                const data = parsePamConfigLines(lines);
                if (data.length === 0) {
                    setNoRecordsDiagnostic('pam_config', lines, 'PAM 配置命令已执行，但没有解析出有效 PAM 规则。常见原因是输出只有目录列表、文件为空，或需要更高权限读取 /etc/pam.d/*。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'sudo_config':
            case 'sudoers_config': {
                const data = parseSudoersLines(lines);
                if (data.length === 0) {
                    setNoRecordsDiagnostic(key, lines, 'Sudoers 配置命令已执行，但没有解析出有效授权规则。可切换 root 权限读取 /etc/sudoers 和 /etc/sudoers.d/*。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'selinux_status': {
                const data = parseSecurityStatusLines(lines);
                if (data.length === 0) {
                    setNoRecordsDiagnostic('selinux_status', lines, '安全状态命令已执行，但没有解析出 SELinux/AppArmor 状态记录。请确认 getenforce、sestatus 或 aa-status 是否可用。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'process_anomaly': {
                // 进程异常检测解析
                const sections = output.split(/===([A-Z_]+)===/);
                const result: any[] = [];

                for (let i = 1; i < sections.length; i += 2) {
                    const sectionName = sections[i];
                    const content = sections[i + 1]?.trim() || '';
                    const sectionLines = content.split('\n').filter(l => l.trim());

                    if (sectionName === 'HIDDEN') {
                        if (osType === 'Windows') {
                            sectionLines.forEach(pid => result.push({ type: 'HIDDEN', pid, detail: '在Get-Process中不可见但在Win32_Process中存在', severity: 'high' }));
                        } else {
                            sectionLines.forEach(pid => result.push({ type: 'HIDDEN', pid, detail: '在ps输出中不可见但在/proc中存在', severity: 'high' }));
                        }
                    } else if (sectionName === 'DELETED') {
                        sectionLines.forEach(line => {
                            const parts = line.split(/\s+/);
                            result.push({
                                type: 'DELETED',
                                pid: parts[0]?.match(/\d+/)?.[0] || '未知',
                                path: parts[0],
                                detail: `正在运行已删除的可执行文件: ${parts[0]}`,
                                severity: 'high'
                            });
                        });
                    } else if (sectionName === 'SENSITIVE_PATH') {
                        sectionLines.forEach(line => {
                            if (osType === 'Windows') {
                                const parts = line.trim().split(/\s+/);
                                result.push({
                                    type: 'SENSITIVE_PATH',
                                    pid: parts[0] || '未知',
                                    user: parts[1] || '-',
                                    path: parts[2] || '-',
                                    detail: `进程从敏感临时目录运行: ${parts[2]}`,
                                    severity: 'warning'
                                });
                            } else {
                                const parts = line.split(/\s+/);
                                result.push({
                                    type: 'SENSITIVE_PATH',
                                    pid: parts[0] || '未知',
                                    user: parts[1] || '-',
                                    path: parts[2] || '-',
                                    detail: `进程从敏感临时目录运行: ${parts[2]}`,
                                    severity: 'warning'
                                });
                            }
                        });
                    } else if (sectionName === 'HIGH_RESOURCES') {
                        if (osType === 'Windows') {
                            sectionLines.slice(1).forEach(line => {
                                const parts = line.trim().split(/\s+/);
                                result.push({
                                    type: 'HIGH_RESOURCES',
                                    user: '-',
                                    pid: parts[1],
                                    cpu: parts[2],
                                    mem: parts[3],
                                    command: parts[0],
                                    detail: `资源占用较高: CPU ${parts[2]}, MEM ${parts[3]}`,
                                    severity: 'info'
                                });
                            });
                        } else {
                            // 跳过标题行
                            sectionLines.slice(1).forEach(line => {
                                const parts = line.split(/\s+/);
                                result.push({
                                    type: 'HIGH_RESOURCES',
                                    user: parts[0],
                                    pid: parts[1],
                                    cpu: parts[2],
                                    mem: parts[3],
                                    command: parts.slice(10).join(' '),
                                    detail: `资源占用较高: CPU ${parts[2]}%, MEM ${parts[3]}%`,
                                    severity: 'info'
                                });
                            });
                        }
                    }
                }
                if (result.length === 0) {
                    setNoRecordsDiagnostic('process_anomaly', lines, '进程异常检测命令已执行，但没有发现隐藏进程、已删除可执行文件、临时目录运行进程或高资源占用进程。若仍怀疑异常，请以 root 权限重新采集，并交叉查看进程列表、网络连接和可疑文件。');
                } else {
                    setTableData(result);
                }
                break;
            }

            case 'win_firewall': {
                // Windows 防火墙解析
                {
                    const data = parseWindowsFirewallLines(lines);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('win_firewall', lines, 'Windows 防火墙命令已执行，但没有返回可解析的配置行。请确认 netsh 可用，或以管理员身份重新采集。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'registry':
            case 'persistence':
            case 'rdp': {
                // 通用分段 JSON 解析逻辑 (Windows)
                const sections = output.split(/===([A-Z_]+)===/);
                const result: any[] = [];
                let collectionError = '';
                
                for (let i = 1; i < sections.length; i += 2) {
                    const sectionName = sections[i];
                    const content = sections[i + 1]?.trim() || '';
                    if (!content) continue;
                    
                    try {
                        const firstChar = content.trim().charAt(0);
                        if (firstChar === '{' || firstChar === '[') {
                             let jsonData = JSON.parse(content);
                             if (!Array.isArray(jsonData)) jsonData = [jsonData];
                             const errorItem = jsonData.find((item: any) =>
                                 item && typeof item === 'object' && (item.error || item.Error)
                             );
                             if (errorItem) {
                                 collectionError = String(errorItem.error ?? errorItem.Error);
                                 continue;
                             }
                             
                             if (key === 'registry') {
                                 jsonData.forEach((item: any, idx: number) => {
                                     Object.keys(item).forEach((k, j) => {
                                         if (['PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider'].includes(k)) return;
                                         result.push({
                                             key: `${sectionName}-${idx}-${j}`,
                                             section: sectionName,
                                             name: k,
                                             command: String(item[k])
                                         });
                                     });
                                 });
                             } else if (key === 'persistence') {
                                 jsonData.forEach((item: any, idx: number) => {
                                     const taskName = item.TaskName || '';
                                     const taskPath = item.TaskPath || '';
                                     const fullTaskName = taskPath || taskName
                                         ? `${taskPath}${taskName}`.replace(/\\\\/g, '\\')
                                         : '';
                                     result.push({
                                         key: `${sectionName}-${idx}`,
                                         type: sectionName === 'SCHEDULED_TASKS' ? 'Scheduled Task' : (sectionName === 'SERVICES_AUTO' ? 'Service' : 'Startup'),
                                         name: fullTaskName || item.Name || item.DisplayName || '-',
                                         status: item.State || item.Status || item.StartType || '-',
                                         detail: item.Actions || item.Action || item.Command || item.PathName || item.Location || '-',
                                         trigger: item.Triggers || '-',
                                         user: item.User || '-',
                                         location: item.Location || item.TaskPath || '-'
                                     });
                                 });
                             } else if (key === 'rdp') {
                                 jsonData.forEach((item: any, idx: number) => {
                                     if (sectionName === 'CONNECTIONS' || sectionName === 'RDP_CONN') {
                                         result.push({
                                             key: `${sectionName}-${idx}`,
                                             type: 'Connection',
                                             local: `${item.LocalAddress}:${item.LocalPort}`,
                                             remote: `${item.RemoteAddress}:${item.RemotePort}`,
                                             state: item.State,
                                             pid: item.OwningProcess?.toString() || '-',
                                             process: item.ProcessName || '-',
                                             detail: [item.ProcessName, item.OwningProcess ? `PID: ${item.OwningProcess}` : ''].filter(Boolean).join(' / ') || '-'
                                         });
                                     } else if (sectionName === 'RDP_REGISTRY') {
                                         Object.keys(item).forEach((settingName, settingIdx) => {
                                             result.push({
                                                 key: `${sectionName}-${idx}-${settingIdx}`,
                                                 type: 'Registry',
                                                 name: settingName,
                                                 local: '-',
                                                 remote: '-',
                                                 state: String(item[settingName]),
                                                 detail: String(item[settingName])
                                             });
                                         });
                                     } else {
                                         result.push({
                                             key: `${sectionName}-${idx}`,
                                             type: 'Service',
                                             name: item.DisplayName || item.Name,
                                             local: item.Name || '-',
                                             remote: '-',
                                             status: item.Status,
                                             state: item.Status || '-',
                                             detail: item.StartType
                                         });
                                     }
                                 });
                             }
                        } else {
                            throw new Error("Not JSON");
                        }
                    } catch (e) {
                         if (key === 'registry') {
                             content.split('\n').filter(l => l.includes(':')).forEach((line, j) => {
                                const [name, ...value] = line.split(':');
                                result.push({
                                    key: `${sectionName}-${j}`,
                                    section: sectionName,
                                    name: name.trim(),
                                    command: value.join(':').trim()
                                });
                            });
                         }
                    }
                }
                if (collectionError) {
                    setCollectionFailureDiagnostic(key, collectionError);
                } else if (result.length === 0) {
                    setNoRecordsDiagnostic(key, lines, `${moduleLabels[key] || key} 命令已执行，但没有解析出可展示记录。该功能可能未启用、当前系统没有对应配置，或需要管理员权限。`);
                } else {
                    setTableData(result);
                }
                break;
            }
            case 'execution_trace':
            case 'powershell_deep':
            case 'defender_history':
            case 'rdp_logon_trace':
            case 'wmi_persistence':
            case 'bits_jobs':
            case 'registry_persistence_deep': {
                parseWindowsGenericDfirJson(key);
                break;
            }
            case 'win_defender': {
                 try {
                     const data = JSON.parse(output);
                     const info = Array.isArray(data) ? data[0] : data;
                     if (!info || typeof info !== 'object') {
                         setNoRecordsDiagnostic('win_defender', lines, 'Defender 状态命令已执行，但没有返回状态对象。请确认 Windows Defender 服务存在并以管理员身份重新采集。');
                         break;
                     }
                     if (info.error || info.Error) {
                         setCollectionFailureDiagnostic('win_defender', String(info.error ?? info.Error), 'Defender 状态采集失败。请确认系统支持 Get-MpComputerStatus，并以管理员身份运行。');
                         break;
                     }
                     const items = Object.keys(info).map((k, i) => ({
                         key: i,
                         element: k,
                         status: String(info[k]),
                         value: String(info[k])
                     }));
                     if (items.length === 0) {
                         setNoRecordsDiagnostic('win_defender', lines, 'Defender 状态对象为空。请确认 Windows Defender 服务是否安装或被策略禁用。');
                     } else {
                         setTableData(items);
                     }
                 } catch (e) {
                     setCollectionFailureDiagnostic('win_defender', output || String(e), 'Defender 状态输出不是有效 JSON。请检查 PowerShell 输出。');
                 }
                 break;
            }
            case 'browser': {
                const sections = output.split(/===([A-Z_]+)===/);
                const result: any[] = [];
                for (let i = 1; i < sections.length; i += 2) {
                    const browserName = sections[i];
                    const content = sections[i + 1]?.trim() || '';
                    if (content) {
                        const firstChar = content.trim().charAt(0);
                        if (firstChar === '{' || firstChar === '[') {
                            try {
                                let jsonData = JSON.parse(content);
                                if (!Array.isArray(jsonData)) jsonData = [jsonData];
                                jsonData.forEach((item: any, idx: number) => {
                                    result.push({
                                        key: `${browserName}-${idx}`,
                                        name: item.Browser || browserName,
                                        profile: item.Profile || item.Name || '-',
                                        value: item.Path || item.FullName || '-',
                                        status: 'Detected',
                                        lastWriteTime: item.LastWriteTime || '-',
                                        historyPath: item.HistoryPath || '-',
                                        historyLastWriteTime: item.HistoryLastWriteTime || '-'
                                    });
                                });
                            } catch {
                                result.push({
                                    key: `${browserName}-raw`,
                                    name: browserName,
                                    profile: '-',
                                    value: content,
                                    status: 'Detected',
                                    lastWriteTime: '-',
                                    historyPath: '-',
                                    historyLastWriteTime: '-'
                                });
                            }
                        } else {
                            const browserLines = content.split('\n').filter(l => l.trim().length > 0 && !l.includes('---') && !l.includes('FullName') && !l.includes('LastWriteTime'));
                            browserLines.forEach((l, idx) => {
                                result.push({
                                    key: `${browserName}-${idx}`,
                                    name: browserName,
                                    profile: '-',
                                    value: l.trim(),
                                    status: 'Detected',
                                    lastWriteTime: '-',
                                    historyPath: '-',
                                    historyLastWriteTime: '-'
                                });
                            });
                            if (browserLines.length === 0 && content.length > 5) {
                                result.push({
                                    key: `${browserName}-exist`,
                                    name: browserName,
                                    profile: '-',
                                    value: 'Profile Exists',
                                    status: 'Detected',
                                    lastWriteTime: '-',
                                    historyPath: '-',
                                    historyLastWriteTime: '-'
                                });
                            }
                        }
                    } else {
                        result.push({
                             key: `${browserName}-none`,
                             name: browserName,
                             profile: '-',
                             value: '-',
                             status: 'Not Found',
                             lastWriteTime: '-',
                             historyPath: '-',
                             historyLastWriteTime: '-'
                        });
                    }
                }
                const detected = result.filter(item => item.status !== 'Not Found');
                if (detected.length === 0) {
                    setNoRecordsDiagnostic('browser', lines, '浏览器目录采集已执行，但没有发现 Chrome、Edge 或 Firefox 配置/历史记录目录。请确认当前用户配置目录，或以目标用户身份重新采集。');
                } else {
                    setTableData(result);
                }
                break;
            }
            case 'env_vars': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => {
                            const name = String(item.Name ?? item.name ?? '-');
                            const value = String(item.Value ?? item.value ?? '-');
                            const upperName = name.toUpperCase();
                            const lowerValue = value.toLowerCase();
                            const pathEntries = value.split(';').map(part => part.trim().toLowerCase()).filter(Boolean);
                            const hasUserWritablePath = pathEntries.some(entry =>
                                /\\users\\public(\\|$)/.test(entry) ||
                                /\\appdata(\\|$)/.test(entry) ||
                                /\\downloads(\\|$)/.test(entry) ||
                                /\\temp(\\|$)/.test(entry) ||
                                /%temp%|%tmp%/.test(entry)
                            );
                            let category = 'general';
                            let risk = 'info';
                            let note = 'review';

                            if (/(PASSWORD|PASSWD|TOKEN|SECRET|KEY|CREDENTIAL|AUTH)/.test(upperName)) {
                                category = 'credential';
                                risk = 'high';
                                note = 'sensitive-value';
                            } else if (upperName.includes('PATH') && hasUserWritablePath) {
                                category = 'path-risk';
                                risk = 'warning';
                                note = 'user-writable-directory-in-path';
                            } else if (upperName.includes('PATH')) {
                                category = 'path';
                            } else if (/^(USERNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/.test(upperName)) {
                                category = 'user';
                            } else if (/^(TEMP|TMP)$/.test(upperName)) {
                                category = 'temporary';
                            }

                            return {
                                key: i,
                                name,
                                value,
                                category,
                                risk,
                                note
                            };
                        });
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('env_vars', lines, 'Windows 环境变量命令已执行，但没有返回变量记录。请确认环境变量提供程序可用，或以目标用户身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('env_vars', output, 'Windows 环境变量输出不是有效 JSON。请检查 Get-ChildItem Env: 输出。');
                    }
                } else {
                    // 环境变量解析 Linux
                    const data = lines.filter(l => l.includes('=')).map((line, i) => {
                        const [name, ...valueParts] = line.split('=');
                        const value = valueParts.join('=') || '-';
                        const upperName = (name || '').toUpperCase();
                        const lowerValue = value.toLowerCase();
                        let category = 'general';
                        let risk = 'info';
                        let note = 'review';

                        if (/(PASSWORD|PASSWD|TOKEN|SECRET|KEY|CREDENTIAL|AUTH)/.test(upperName)) {
                            category = 'credential';
                            risk = 'high';
                            note = 'sensitive-value';
                        } else if (/^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|PYTHONPATH|PERL5LIB|RUBYLIB)$/.test(upperName)) {
                            category = 'dynamic-loader';
                            risk = 'high';
                            note = 'runtime-injection';
                        } else if (upperName.includes('PATH') && /(^|:)(\/tmp|\/var\/tmp|\/dev\/shm)(:|$)/.test(lowerValue)) {
                            category = 'path-risk';
                            risk = 'warning';
                            note = 'writable-directory-in-path';
                        } else if (upperName.includes('PATH')) {
                            category = 'path';
                        } else if (/^(HOME|USER|LOGNAME|SHELL|SUDO_USER)$/.test(upperName)) {
                            category = 'user';
                        } else if (/^(LANG|LC_)/.test(upperName)) {
                            category = 'locale';
                        }

                        return {
                            key: i,
                            name: name || '-',
                            value,
                            category,
                            risk,
                            note,
                            raw: line
                        };
                    });
                    setTableData(data);
                }
                break;
            }
            case 'ulimit_config': {
                // ulimit解析
                let currentSource = 'ulimit';
                const data = lines.map((line, i) => {
                    const section = readSectionName(line);
                    if (section) {
                        currentSource = section === 'LIMITS_CONF' ? 'limits.conf' : section.toLowerCase();
                        return null;
                    }

                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return null;

                    if (currentSource === 'limits.conf') {
                        const parts = trimmed.split(/\s+/);
                        if (parts.length >= 4) {
                            return {
                                key: i,
                                source: currentSource,
                                domain: parts[0],
                                type: parts[1],
                                name: parts[2],
                                value: parts.slice(3).join(' '),
                                raw: trimmed,
                            };
                        }
                    }

                    const match = line.match(/^(.+?)\s+\((.+?)\)\s+(.+)$/);
                    if (match) {
                        return {
                            key: i,
                            source: currentSource,
                            domain: '-',
                            name: match[1].trim(),
                            type: match[2],
                            value: match[3].trim(),
                            raw: trimmed,
                        };
                    }
                    return { key: i, source: currentSource, domain: '-', name: trimmed, type: '-', value: '-', raw: trimmed };
                }).filter(Boolean);
                if (data.length === 0) {
                    setNoRecordsDiagnostic('ulimit_config', lines, '系统限制命令已执行，但没有解析出 ulimit 或 limits.conf 规则。请确认 shell 支持 ulimit，或检查 /etc/security/limits.conf。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'network_conn': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => ({
                            key: i,
                            protocol: 'TCP',
                            local: (item.LocalAddress || '-') + ':' + (item.LocalPort || '-'),
                            remote: (item.RemoteAddress || '-') + ':' + (item.RemotePort || '-'),
                            peer: (item.RemoteAddress || '-') + ':' + (item.RemotePort || '-'),
                            state: item.State || '-',
                            recv: '-',
                            send: '-',
                            pid: item.OwningProcess?.toString() || '-',
                            process: item.ProcessName || '-',
                            processPath: item.ProcessPath || '-',
                            pid_program: [item.OwningProcess, item.ProcessName].filter(Boolean).join(' / ') || '-'
                        }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('network_conn', lines, 'Windows 网络连接命令已执行，但没有返回活动连接。请确认目标主机当前是否存在网络会话，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('network_conn', output, 'Windows 网络连接输出不是有效 JSON。请检查 Get-NetTCPConnection 输出。');
                    }
                } else {
                    const data = lines
                        .filter(line => !readSectionName(line) && !/^(State|Netid|Proto)\s+/i.test(line.trim()))
                        .map((line, i) => parseLinuxSocketLine(line, i))
                        .filter(Boolean);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('network_conn', lines, '网络连接命令已执行，但没有解析出活动连接。请确认 ss/netstat 输出格式，或目标主机当前是否存在网络会话。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'login_history': {
                // 解析 last -F 输出 - 使用倒序解析法
                // 格式示例:
                // root  pts/0  192.168.10.1  Tue Jul 6 18:29:47 2021 - Tue Jul 6 18:31:05 2021  (02:18)
                // root  tty1   -             Jul 6 15:11:30 2021   still logged in
                // root  tty1   -             Jul 6 15:05:51 2021 - crash   (00:05)
                const data = lines.filter(l => {
                    const trimmed = l.trim();
                    return trimmed &&
                        !trimmed.startsWith('wtmp') &&
                        !trimmed.startsWith('reboot') &&
                        !trimmed.startsWith('shutdown') &&
                        trimmed.length > 10;
                }).map((line, i) => {
                    const parts = line.split(/\s+/);
                    const user = parts[0] || '-';
                    const terminal = parts[1] || '-';

                    // 检测IP地址（第3项如果是IP格式）
                    let ip = '-';
                    let timeStartIndex = 2;
                    if (parts[2] && /^\d+\.\d+/.test(parts[2])) {
                        ip = parts[2];
                        timeStartIndex = 3;
                    }

                    let remaining = parts.slice(timeStartIndex).join(' ');
                    let time = '-';
                    let logout_time = '-';
                    let duration = '-';
                    let state = 'completed';

                    // 倒序解析法：先从末尾提取状态/时长

                    // 1. 检查 still logged in
                    if (remaining.includes('still logged in')) {
                        state = 'active';
                        duration = 'still logged in';
                        remaining = remaining.replace(/\s*still logged in\s*$/, '').trim();
                    }
                    // 2. 提取末尾括号内的时长 (xx:xx) 或 (days+xx:xx)
                    else {
                        const durationMatch = remaining.match(/\s*\(([^)]+)\)\s*$/);
                        if (durationMatch) {
                            duration = durationMatch[1];
                            remaining = remaining.replace(/\s*\([^)]+\)\s*$/, '').trim();
                        }

                        // 检查 crash
                        if (remaining.endsWith('crash') || remaining.includes(' - crash')) {
                            state = 'crash';
                            logout_time = 'crash';
                            if (duration !== '-') {
                                duration = `crash (${duration})`;
                            } else {
                                duration = 'crash';
                            }
                            remaining = remaining.replace(/\s*-?\s*crash\s*$/, '').trim();
                        }
                    }

                    // 3. 剩余部分处理：可能有 "开始时间 - 结束时间" 格式，只取开始时间
                    // 找到第一个年份后的 " - " 作为分隔
                    const dashWithYearMatch = remaining.match(/^(.+?\d{4})\s+-\s+/);
                    if (dashWithYearMatch) {
                        time = dashWithYearMatch[1].trim();
                        logout_time = remaining.slice(dashWithYearMatch[0].length).trim() || logout_time;
                    } else if (remaining.includes(' - ')) {
                        // 没有年份的情况，简单分割
                        const [loginPart, logoutPart] = remaining.split(' - ');
                        time = loginPart.trim();
                        logout_time = logoutPart?.trim() || logout_time;
                    } else {
                        time = remaining.trim();
                    }

                    return {
                        key: i,
                        user,
                        terminal,
                        ip,
                        time,
                        login_time: time,
                        logout_time,
                        duration,
                        state,
                        raw: line
                    };
                });
                setTableData(data);
                break;
            }
            case 'panel': {
                // 解析宝塔面板(BaoTa)输出 - 全面增强版（支持Windows和Linux面板）
                interface PanelData {
                    config: { key: string; label: string; value: string }[];
                    users: any[];
                    sites: any[];
                    databases: any[];
                    ftps: any[];
                    tasks: any[];
                    crontabs: any[];
                    firewall: any[];
                    logs: any[];
                    panelLogs: string[];
                }

                const panelData: PanelData = {
                    config: [],
                    users: [],
                    sites: [],
                    databases: [],
                    ftps: [],
                    tasks: [],
                    crontabs: [],
                    firewall: [],
                    logs: [],
                    panelLogs: []
                };

                // 检测是 Linux 宝塔面板还是 Windows 面板
                const isWindowsPanel = output.includes('===PHPSTUDY===') ||
                                      output.includes('===XAMPP===') ||
                                      output.includes('===WAMPSERVER===') ||
                                      output.includes('===BAOTA_WIN===') ||
                                      output.includes('===IIS===') ||
                                      output.includes('===PANELS===') ||
                                      output.includes('===IIS_SITES===') ||
                                      output.includes('===SERVICES===') ||
                                      output.includes('===LOGS===') ||
                                      output.includes('===DIAGNOSTICS===');

                if (isWindowsPanel && isWindowsLocalMode) {
                    const windowsPanelData = parseWindowsPanelSections(output);
                    setRawOutput(JSON.stringify(windowsPanelData));
                    setTableData([
                        ...windowsPanelData.detectedInstalls,
                        ...windowsPanelData.sites,
                        ...windowsPanelData.iisSites,
                        ...windowsPanelData.services,
                        ...windowsPanelData.logs,
                    ]);
                    break;
                }

                if (isWindowsPanel) {
                    // Windows 面板检测逻辑
                    const sections = output.split(/===(\w+)===/);
                    const parseJsonRecords = (content: string): any[] => {
                        const jsonMatch = content.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
                        if (!jsonMatch) return [];
                        try {
                            const parsed = JSON.parse(jsonMatch[0]);
                            return Array.isArray(parsed) ? parsed : [parsed];
                        } catch (e) {
                            console.error('Windows panel JSON parse failed', e);
                            return [];
                        }
                    };

                    const appendWindowsPanelFiles = (content: string, rootPath: string, note: string) => {
                        parseJsonRecords(content).forEach((f: any) => {
                            const name = f.Name || f.name || '-';
                            if (!name || name === '-') return;
                            const length = Number(f.Length ?? f.length);
                            panelData.sites.push({
                                key: panelData.sites.length,
                                name,
                                path: `${rootPath}\\${name}`,
                                size: Number.isFinite(length) && length > 0 ? `${Math.round(length / 1024)} KB` : '-',
                                lastModified: String(f.LastWriteTime || f.lastWriteTime || '-').split('T')[0],
                                ps: note
                            });
                        });
                    };
                    
                    for (let i = 1; i < sections.length; i += 2) {
                        const sectionName = sections[i];
                        const content = sections[i + 1]?.trim() || '';

                        if (!content) continue;

                        switch (sectionName) {
                            case 'PHPSTUDY':
                                if (content.includes('PhpStudy Pro检测到')) {
                                    panelData.config.push({ 
                                        key: 'phpstudy_detected', 
                                        label: '面板类型', 
                                        value: 'PhpStudy Pro' 
                                    });
                                    panelData.config.push({ 
                                        key: 'phpstudy_path', 
                                        label: '安装路径', 
                                        value: 'C:\\phpstudy_pro' 
                                    });
                                    panelData.config.push({ 
                                        key: 'phpstudy_wwwroot', 
                                        label: '网站根目录', 
                                        value: 'C:\\phpstudy_pro\\WWW' 
                                    });
                                    appendWindowsPanelFiles(content, 'C:\\phpstudy_pro\\WWW', 'PhpStudy网站');
                                } else {
                                    panelData.panelLogs.push('PhpStudy: 未检测到');
                                }
                                break;

                            case 'XAMPP':
                                if (content.includes('XAMPP检测到')) {
                                    panelData.config.push({ 
                                        key: 'xampp_detected', 
                                        label: '面板类型', 
                                        value: 'XAMPP' 
                                    });
                                    panelData.config.push({ 
                                        key: 'xampp_path', 
                                        label: '安装路径', 
                                        value: 'C:\\xampp' 
                                    });
                                    panelData.config.push({ 
                                        key: 'xampp_wwwroot', 
                                        label: '网站根目录', 
                                        value: 'C:\\xampp\\htdocs' 
                                    });
                                    appendWindowsPanelFiles(content, 'C:\\xampp\\htdocs', 'XAMPP网站');
                                } else {
                                    panelData.panelLogs.push('XAMPP: 未检测到');
                                }
                                break;

                            case 'WAMPSERVER':
                                if (content.includes('WampServer检测到')) {
                                    panelData.config.push({ 
                                        key: 'wamp_detected', 
                                        label: '面板类型', 
                                        value: 'WampServer' 
                                    });
                                    panelData.config.push({ 
                                        key: 'wamp_path', 
                                        label: '安装路径', 
                                        value: 'C:\\wamp64' 
                                    });
                                    panelData.config.push({ 
                                        key: 'wamp_wwwroot', 
                                        label: '网站根目录', 
                                        value: 'C:\\wamp64\\www' 
                                    });
                                    appendWindowsPanelFiles(content, 'C:\\wamp64\\www', 'WampServer网站');
                                } else {
                                    panelData.panelLogs.push('WampServer: 未检测到');
                                }
                                break;

                            case 'BAOTA_WIN':
                                if (content.includes('宝塔Windows版检测到')) {
                                    panelData.config.push({ 
                                        key: 'baota_win_detected', 
                                        label: '面板类型', 
                                        value: '宝塔Windows版' 
                                    });
                                    panelData.config.push({ 
                                        key: 'baota_path', 
                                        label: '安装路径', 
                                        value: 'C:\\BtSoft' 
                                    });
                                    panelData.config.push({ 
                                        key: 'baota_wwwroot', 
                                        label: '网站根目录', 
                                        value: 'C:\\BtSoft\\WebSites' 
                                    });
                                    appendWindowsPanelFiles(content, 'C:\\BtSoft\\WebSites', '宝塔Windows版网站');
                                } else {
                                    panelData.panelLogs.push('宝塔Windows版: 未检测到');
                                }
                                break;

                            case 'IIS':
                                if (content && !content.includes('Get-WebSite')) {
                                    panelData.config.push({ 
                                        key: 'iis_detected', 
                                        label: '面板类型', 
                                        value: 'IIS (Internet Information Services)' 
                                    });
                                    parseJsonRecords(content).forEach((site: any) => {
                                        panelData.sites.push({
                                            key: panelData.sites.length,
                                            name: site.Name || '-',
                                            path: site.PhysicalPath || '-',
                                            status: site.State || '-',
                                            bindings: typeof site.Bindings === 'string' ? site.Bindings : JSON.stringify(site.Bindings),
                                            ps: 'IIS网站'
                                        });
                                    });
                                } else {
                                    panelData.panelLogs.push('IIS: 未检测到或未安装IIS管理工具');
                                }
                                break;
                        }
                    }

                    // 如果没有检测到任何面板
                    if (panelData.config.length === 0) {
                        panelData.config.push({ 
                            key: 'no_panel', 
                            label: '检测结果', 
                            value: '未检测到常见的Windows Web面板' 
                        });
                    }
                } else {
                    // Linux 宝塔面板解析逻辑（原有逻辑）
                    const sections = output.split(/===BT_(\w+)===/);

                    // 解析CSV格式数据的辅助函数
                    const parseCSV = (content: string) => {
                        const csvLines = content.trim().split('\n').filter(l => l.trim());
                        if (csvLines.length < 2) return [];

                        const headers = csvLines[0].split(',').map(h => h.replace(/"/g, '').trim());
                        return csvLines.slice(1).map((line, idx) => {
                            // 更智能的CSV解析，处理带逗号的字段
                            const values: string[] = [];
                            let current = '';
                            let inQuotes = false;
                            for (const char of line) {
                                if (char === '"') {
                                    inQuotes = !inQuotes;
                                } else if (char === ',' && !inQuotes) {
                                    values.push(current.replace(/"/g, '').trim());
                                    current = '';
                                } else {
                                    current += char;
                                }
                            }
                            values.push(current.replace(/"/g, '').trim());

                            const obj: any = { key: idx };
                            headers.forEach((h, i) => {
                                obj[h] = values[i] || '-';
                            });
                            return obj;
                        });
                    };

                    for (let i = 1; i < sections.length; i += 2) {
                        const sectionName = sections[i];
                        const content = sections[i + 1]?.trim() || '';

                        switch (sectionName) {
                            case 'DETECT':
                            // Panel 目录列表 - 确认面板存在
                            if (content.includes('BT-Panel') || content.includes('data')) {
                                panelData.config.push({ key: 'panel_detected', label: '面板状态', value: '已检测到宝塔面板' });
                            }
                            break;
                        case 'CONFIG':
                            if (content) {
                                panelData.config.push({ key: 'default_password', label: '默认面板密码', value: content });
                            }
                            break;
                        case 'USERNAME':
                            if (content) {
                                panelData.config.push({ key: 'admin_path', label: '安全入口', value: '/' + content });
                            }
                            break;
                        case 'PORT':
                            if (content) {
                                panelData.config.push({ key: 'port', label: '面板端口', value: content });
                            }
                            break;
                        case 'BIND':
                            if (content) {
                                panelData.config.push({ key: 'bind_account', label: '绑定宝塔账号', value: content });
                            }
                            break;
                        case 'DB_ROOT':
                            if (content) {
                                panelData.config.push({ key: 'db_root_password', label: 'MySQL root密码', value: content });
                            }
                            break;
                        case 'BASICAUTH':
                            if (content) {
                                try {
                                    const auth = JSON.parse(content);
                                    panelData.config.push({ key: 'basicauth', label: 'BasicAuth认证', value: auth.open ? '已启用' : '已关闭' });
                                    if (auth.basic_user) {
                                        panelData.config.push({ key: 'basicauth_user', label: 'BasicAuth用户', value: auth.basic_user });
                                    }
                                } catch {
                                    panelData.config.push({ key: 'basicauth', label: 'BasicAuth认证', value: '已关闭' });
                                }
                            }
                            break;
                        case 'USERINFO':
                            // userInfo.json - 包含用户信息
                            if (content) {
                                try {
                                    const userInfo = JSON.parse(content);
                                    if (userInfo.username) {
                                        panelData.config.unshift({ key: 'username', label: '面板用户名', value: userInfo.username });
                                    }
                                    if (userInfo.password) {
                                        panelData.config.push({ key: 'password_hash', label: '密码MD5', value: userInfo.password });
                                    }
                                } catch {
                                    // 不是JSON格式
                                }
                            }
                            break;
                        case 'DB_STRINGS':
                            // 从数据库strings中提取用户名等关键信息
                            if (content) {
                                const lines = content.split('\n');
                                // 尝试提取用户名（通常在特定模式附近）
                                for (let j = 0; j < lines.length; j++) {
                                    const line = lines[j];
                                    // 检测可能的用户名（字母数字组合，长度合理）
                                    if (/^[a-zA-Z][a-zA-Z0-9]{4,15}$/.test(line) && !panelData.config.find((c: any) => c.key === 'username')) {
                                        // 可能是用户名，但需要更多上下文确认
                                    }
                                    // 检测可能的MD5哈希
                                    if (/^[a-f0-9]{32}$/i.test(line) && !panelData.config.find((c: any) => c.key === 'password_hash')) {
                                        panelData.config.push({ key: 'password_hash', label: '密码MD5(推测)', value: line });
                                    }
                                }
                                // 保存原始strings用于调试
                                panelData.panelLogs.unshift('--- 数据库strings摘录 ---', ...lines.slice(0, 50));
                            }
                            break;
                        case 'USERS':
                            panelData.users = parseCSV(content);
                            if (panelData.users.length > 0) {
                                const user = panelData.users[0];
                                panelData.config.unshift({ key: 'username', label: '面板用户名', value: user.username || '-' });
                                panelData.config.push({ key: 'password_hash', label: '密码加盐后的MD5', value: user.password || '-' });
                                panelData.config.push({ key: 'salt', label: '盐值', value: user.salt || '-' });
                            }
                            break;
                        case 'SITES':
                            // 解析 ls -la /www/wwwroot 输出
                            panelData.sites = content.split('\n')
                                .filter(l => {
                                    const trimmed = l.trim();
                                    // 过滤掉 total/总用量 行和空行
                                    return trimmed && !trimmed.startsWith('total') && !trimmed.startsWith('总用量');
                                })
                                .map((line, idx) => {
                                    const parts = line.trim().split(/\s+/);
                                    // ls -la 输出格式: 权限 链接数 用户 组 大小 月 日 时间/年 文件名
                                    // 文件名可能在位置8或更后（取决于时间格式）
                                    if (parts.length >= 9 && parts[0].match(/^[dl-]/)) {
                                        // 找到文件名 - 通常是最后一个元素
                                        const fileName = parts.slice(8).join(' ');
                                        if (fileName && fileName !== '.' && fileName !== '..') {
                                            return {
                                                key: idx,
                                                name: fileName,
                                                path: '/www/wwwroot/' + fileName,
                                                status: '1',
                                                ps: `${parts[0]} | ${parts[4]} | ${parts[5]} ${parts[6]} ${parts[7]}`
                                            };
                                        }
                                    }
                                    return null;
                                })
                                .filter(Boolean);
                            break;
                        case 'VHOST':
                            // Nginx vhost 配置 - 提取域名
                            if (content) {
                                const serverBlocks = content.match(/server_name\s+[^;]+/g) || [];
                                serverBlocks.forEach((block, idx) => {
                                    // 提取所有域名（可能有多个用空格分隔）
                                    const domains = block.replace('server_name', '').trim().replace(';', '').split(/\s+/);
                                    domains.forEach(domain => {
                                        // 过滤无效域名
                                        if (domain &&
                                            domain !== '_' &&
                                            domain !== 'localhost' &&
                                            !domain.startsWith('127.') &&
                                            !domain.match(/^\d+\.\d+\.\d+\.\d+$/) && // 过滤IP地址
                                            !panelData.sites.find((s: any) => s.name === domain)) {
                                            panelData.sites.push({
                                                key: panelData.sites.length + idx,
                                                name: domain,
                                                path: '-',
                                                status: '1',
                                                ps: '从Nginx配置获取'
                                            });
                                        }
                                    });
                                });
                            }
                            break;
                        case 'DATABASES':
                            // ls -la /www/server/data - 过滤系统数据库
                            const systemDbs = ['.', '..', 'mysql', 'performance_schema', 'sys', 'information_schema', 'test'];
                            panelData.databases = content.split('\n')
                                .filter(l => {
                                    const trimmed = l.trim();
                                    return trimmed && !trimmed.startsWith('total') && !trimmed.startsWith('总用量');
                                })
                                .map((line, idx) => {
                                    const parts = line.trim().split(/\s+/);
                                    if (parts.length >= 9 && parts[0].startsWith('d')) {
                                        const dbName = parts.slice(8).join(' ');
                                        // 过滤 . .. 和系统数据库
                                        if (dbName && !systemDbs.includes(dbName)) {
                                            return { key: idx, name: dbName, username: '-', password: '-', accept: '-', ps: '从目录获取' };
                                        }
                                    }
                                    return null;
                                })
                                .filter(Boolean);
                            break;
                        case 'FTPS':
                            panelData.ftps = parseCSV(content);
                            break;
                        case 'TASKS':
                            panelData.tasks = parseCSV(content);
                            break;
                        case 'CRONTAB':
                            // 解析 crontab 内容
                            panelData.crontabs = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).map((line, idx) => ({
                                key: idx,
                                name: line.substring(0, 50),
                                type: 'shell',
                                status: '1',
                                sBody: line
                            }));
                            break;
                        case 'FIREWALL':
                            // firewall.json 格式
                            if (content.startsWith('{') || content.startsWith('[')) {
                                try {
                                    const fw = JSON.parse(content);
                                    if (Array.isArray(fw)) {
                                        panelData.firewall = fw.map((r: any, idx: number) => ({ key: idx, ...r }));
                                    }
                                } catch {
                                    // 不是JSON
                                }
                            }
                            break;
                        case 'PANEL_LOGS':
                        case 'REQUEST_LOG':
                            panelData.panelLogs = panelData.panelLogs.concat(content.split('\n').filter(l => l.trim()).slice(-50));
                            break;
                        case 'TASK':
                        case 'PANEL_INFO':
                            // BT-Task 和 BT-Panel 的 strings 输出
                            if (content) {
                                panelData.panelLogs.push('--- ' + sectionName + ' ---', ...content.split('\n').slice(0, 20));
                            }
                            break;
                        case 'PY_QUERY':
                            // Python sqlite3 查询结果
                            if (content) {
                                const pyLines = content.split('\n');
                                let currentSection = '';
                                for (const line of pyLines) {
                                    if (line.startsWith('USERS:')) {
                                        currentSection = 'users';
                                    } else if (line.startsWith('SITES:')) {
                                        currentSection = 'sites';
                                    } else if (line.startsWith('DATABASES:')) {
                                        currentSection = 'databases';
                                    } else if (line.startsWith('LOGS:')) {
                                        currentSection = 'logs';
                                    } else if (line.startsWith('(') && line.endsWith(')')) {
                                        // Python tuple 格式: (1, 'username', 'password', 'salt')
                                        // 使用更智能的分割，处理引号内的逗号
                                        const tupleContent = line.slice(1, -1); // 移除括号
                                        const values: string[] = [];
                                        let current = '';
                                        let inQuotes = false;
                                        for (let c = 0; c < tupleContent.length; c++) {
                                            const char = tupleContent[c];
                                            if (char === "'" && tupleContent[c - 1] !== '\\') {
                                                inQuotes = !inQuotes;
                                            } else if (char === ',' && !inQuotes) {
                                                values.push(current.trim().replace(/^'|'$/g, ''));
                                                current = '';
                                            } else {
                                                current += char;
                                            }
                                        }
                                        values.push(current.trim().replace(/^'|'$/g, ''));

                                        if (values.length > 0) {
                                            if (currentSection === 'users' && values.length >= 4) {
                                                // 从数据库获取的用户名优先级更高，更新已有值
                                                const existingUsername = panelData.config.find((c: any) => c.key === 'username');
                                                if (existingUsername) {
                                                    existingUsername.value = values[1]; // 更新为数据库中的用户名
                                                } else {
                                                    panelData.config.unshift({ key: 'username', label: '面板用户名', value: values[1] });
                                                }
                                                // 密码和盐值也用更新逻辑
                                                const existingPwdHash = panelData.config.find((c: any) => c.key === 'password_hash');
                                                if (existingPwdHash) {
                                                    existingPwdHash.value = values[2];
                                                } else {
                                                    panelData.config.push({ key: 'password_hash', label: '面板密码加盐后的MD5', value: values[2] });
                                                }
                                                const existingSalt = panelData.config.find((c: any) => c.key === 'salt');
                                                if (existingSalt) {
                                                    existingSalt.value = values[3];
                                                } else {
                                                    panelData.config.push({ key: 'salt', label: '盐值', value: values[3] });
                                                }
                                            } else if (currentSection === 'sites' && values.length >= 4) {
                                                // 检查是否已存在，如果存在则更新，否则添加
                                                const existingSite = panelData.sites.find((s: any) => s.name === values[1] || s.path === values[2]);
                                                if (existingSite) {
                                                    existingSite.id = values[0];
                                                    existingSite.ps = values[4] || existingSite.ps;
                                                } else {
                                                    panelData.sites.push({ key: panelData.sites.length, id: values[0], name: values[1], path: values[2], status: values[3], ps: values[4] || '-' });
                                                }
                                            } else if (currentSection === 'databases' && values.length >= 4) {
                                                // 检查是否已存在同名数据库，如果存在则更新密码等信息
                                                const existingDb = panelData.databases.find((d: any) => d.name === values[1]);
                                                if (existingDb) {
                                                    existingDb.id = values[0];
                                                    existingDb.username = values[2];
                                                    existingDb.password = values[3];
                                                    existingDb.accept = values[4] || existingDb.accept;
                                                    existingDb.ps = values[5] || '填写备注';
                                                } else {
                                                    panelData.databases.push({ key: panelData.databases.length, id: values[0], name: values[1], username: values[2], password: values[3], accept: values[4] || '-', ps: values[5] || '填写备注' });
                                                }
                                            } else if (currentSection === 'logs' && values.length >= 4) {
                                                panelData.logs.push({ key: panelData.logs.length, id: values[0], type: values[1], log: values[2], addtime: values[3] });
                                            }
                                        }
                                    }
                                }
                            }
                            break;
                        case 'LOGS':
                            panelData.logs = parseCSV(content);
                            break;
                    }
                }
            }

            // 将panel数据设置到rawOutput用于渲染，同时保留原始输出用于调试
            setRawOutput(JSON.stringify({ ...panelData, _rawOutput: output }));

            // 设置tableData用于默认渲染
            if (panelData.sites.length > 0) {
                setTableData(panelData.sites);
            } else if (panelData.config.length > 0) {
                setTableData(panelData.config);
            }
            break;
        }

        case 'file_scan': {
                const sections = splitCommandSections(output);
                const sectionMeta: Record<string, { category: string; risk: string; note: string }> = {
                    RECENT_TEMP: { category: 'Recent temp file', risk: 'warning', note: 'Modified in temp directory within 24h' },
                    USER_WRITABLE_EXECUTABLES: { category: 'User-writable executable', risk: 'high', note: 'Executable or script under user-writable path' },
                    RECENT_WEBROOT: { category: 'Recent webroot file', risk: 'warning', note: 'Recently modified web-facing file' },
                };
                const result: any[] = [];
                Object.entries(sections).forEach(([sectionName, content]) => {
                    const meta = sectionMeta[sectionName] || { category: sectionName, risk: 'info', note: 'File scan item' };
                    if (!content.trim()) return;
                    try {
                        const parsed = JSON.parse(content.trim());
                        const records = Array.isArray(parsed) ? parsed : [parsed];
                        records.forEach((item: any, index: number) => {
                            const path = String(item.FullName || item.fullName || item.Path || item.path || '-');
                            const name = String(item.Name || item.name || getPathBaseName(path));
                            result.push({
                                key: `${sectionName}-${index}`,
                                category: meta.category,
                                risk: meta.risk,
                                name,
                                path,
                                directory: getPathDirectory(path),
                                size: formatFileSize(item.Length ?? item.length ?? item.Size ?? item.size),
                                lastModified: String(item.LastWriteTime || item.lastWriteTime || item.Modified || item.modified || '-'),
                                extension: String(item.Extension || item.extension || ''),
                                note: meta.note,
                            });
                        });
                    } catch {
                        content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach((path, index) => {
                            result.push({
                                key: `${sectionName}-${index}`,
                                category: meta.category,
                                risk: meta.risk,
                                name: getPathBaseName(path),
                                path,
                                directory: getPathDirectory(path),
                                size: '-',
                                lastModified: '-',
                                extension: '',
                                note: meta.note,
                            });
                        });
                    }
                });
                if (result.length === 0) {
                    setNoRecordsDiagnostic('file_scan', lines, '文件扫描命令已执行，但最近临时文件、用户可写可执行文件和 Web 目录中没有发现命中项。可扩大扫描路径或时间范围后重新采集。');
                } else {
                    setTableData(result);
                }
                break;
            }
        case 'security_events': {
                const jsonData = tryParseJsonArray(output);
                if (jsonData) {
                    const parsedValue = JSON.parse(output.trim());
                    const { rows, artifact, previewLimit, pageInfo } = readArtifactPreview(parsedValue);
                    setCollectionArtifact(artifact);
                    setCollectionPreviewLimit(previewLimit);
                    setWindowsLogPageInfo(pageInfo);
                    const errorItem = rows.find((item: any) =>
                        item && typeof item === 'object' && (item.error || item.Error || item.EventId === 'error')
                    );
                    if (errorItem) {
                        setCollectionFailureDiagnostic(
                            'security_events',
                            String(errorItem.error ?? errorItem.Error ?? errorItem.Description ?? errorItem.description ?? 'Security event collection failed.'),
                            'Windows 安全事件采集失败。请以管理员身份运行，或确认 Security 日志访问权限。'
                        );
                        break;
                    }
                    const data = rows.map((item: any, i: number) => ({
                        key: i,
                        eventId: String(item.EventId ?? item.event_id ?? item.eventId ?? item.Id ?? item.id ?? '-'),
                        timeCreated: String(item.TimeCreated ?? item.time_created ?? item.timeCreated ?? item.time ?? '-'),
                        eventType: String(item.EventType ?? item.event_type ?? item.eventType ?? item.type ?? '-'),
                        description: String(item.Description ?? item.description ?? item.Message ?? item.message ?? '-'),
                        username: String(item.Username ?? item.username ?? item.User ?? item.user ?? '-'),
                        sourceIp: String(item.SourceIp ?? item.source_ip ?? item.sourceIp ?? item.IpAddress ?? '-'),
                        logonType: String(item.LogonType ?? item.logon_type ?? item.logonType ?? '-'),
                        status: String(item.Status ?? item.status ?? '-'),
                        suspicious: Boolean(item.Suspicious ?? item.is_suspicious ?? item.suspicious),
                    }));
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('security_events', lines, 'Windows 安全事件查询已执行，但没有返回高价值事件记录。可扩大事件范围，或确认 Security 日志中是否存在登录/账号变更事件。');
                    } else {
                        setTableData(data);
                    }
                } else {
                    setParseFailureDiagnostic('security_events', output, 'Windows 安全事件输出不是有效 JSON。请检查 Get-WinEvent 是否被权限或策略拦截，或以管理员身份重新采集。');
                }
                break;
            }
        case 'win_security_log':
            case 'win_system_log':
            case 'win_app_log':
            case 'win_powershell_log': {
                // 解析 Windows 事件日志 (JSON 格式)
                try {
                    const jsonStr = output.trim();
                    if (!jsonStr) {
                        setNoRecordsDiagnostic(key, lines, 'Windows 事件日志查询已执行，但没有返回事件记录。可扩大时间范围，或确认该日志通道存在事件。');
                        break;
                    }
                    // 检查是否是错误消息
                    if (jsonStr.startsWith('[需要') || jsonStr.startsWith('[错误')) {
                        setCollectionFailureDiagnostic(key, jsonStr, 'Windows 事件日志采集失败。请以管理员身份运行，或确认对应事件日志通道可访问。');
                        break;
                    }
                    // 解析 JSON
                    const parsed = JSON.parse(jsonStr);
                    const { rows: arr, artifact, previewLimit, pageInfo } = readArtifactPreview(parsed);
                    setCollectionArtifact(artifact);
                    setCollectionPreviewLimit(previewLimit);
                    setWindowsLogPageInfo(pageInfo);
                    const errorItem = arr.find((item: any) => item && typeof item === 'object' && (item.error || item.Error));
                    if (errorItem) {
                        setCollectionFailureDiagnostic(
                            key,
                            String(errorItem.error ?? errorItem.Error),
                            'Windows 事件日志采集失败。请以管理员身份运行，或确认对应事件日志通道可访问。'
                        );
                        break;
                    }
                    const data = arr.map((item: any, i: number) => ({
                        key: i,
                        time: item.time ?? item.TimeCreated ?? item.timeCreated ?? '-',
                        id: String(item.id ?? item.Id ?? item.EventId ?? '-'),
                        content: item.message ?? item.Message ?? item.content ?? item.Description ?? '-'
                    }));
                    if (data.length === 0) {
                        setNoRecordsDiagnostic(key, lines, 'Windows 事件日志查询已执行，但没有返回事件记录。可扩大时间范围，或确认该日志通道存在事件。');
                    } else {
                        setTableData(data);
                    }
                } catch (e) {
                    setParseFailureDiagnostic(key, output, 'Windows 事件日志输出不是有效 JSON。请检查 PowerShell 是否被策略/权限拦截，或复制原始输出进一步分析。');
                }
                break;
            }
            case 'recent_files': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData.map((item: any, i: number) => {
                            // 处理LastAccessTime - PowerShell JSON日期格式
                            let lastAccess = '-';
                            if (item.LastAccessTime) {
                                if (typeof item.LastAccessTime === 'string' && item.LastAccessTime.includes('/Date(')) {
                                    const timestamp = parseInt(item.LastAccessTime.replace(/\/Date\((\d+)\)\//, '$1'));
                                    if (!isNaN(timestamp)) {
                                        lastAccess = new Date(timestamp).toLocaleString('zh-CN');
                                    }
                                } else {
                                    lastAccess = String(item.LastAccessTime);
                                }
                            }
                            return {
                                key: i,
                                name: item.Name || '-',
                                lastAccess: lastAccess,
                                path: item.FullName || item.Path || '-',
                                targetPath: item.TargetPath || item.LinkTarget || '-'
                            };
                        });
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('recent_files', lines, 'Windows 最近文件命令已执行，但没有返回最近访问记录。请确认 Recent 目录存在，或以目标用户身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('recent_files', output, 'Windows 最近文件输出不是有效 JSON。请检查 PowerShell 输出。');
                    }
                } else {
                    const data = parseLinuxRecentFileLines(lines);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('recent_files', lines, '最近文件命令已执行，但没有解析出文件记录。可扩大时间范围或检查目标目录权限。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            case 'hosts_file': {
                // hosts 文件解析为表格
                const data = lines
                    .filter(l => l.trim() && !l.trim().startsWith('#'))
                    .map((line, i) => {
                        const parts = line.trim().split(/\s+/);
                        const ip = parts[0] || '-';
                        const hostname = parts.slice(1).join(' ') || '-';
                        const hostLower = hostname.toLowerCase();
                        const isLocalMapping = /^(127\.|0\.0\.0\.0$|::1$|localhost$)/i.test(ip);
                        const redirectsSensitiveDomain = /\b(login\.microsoftonline\.com|update\.microsoft\.com|windowsupdate\.com|microsoft\.com|github\.com|githubusercontent\.com|virustotal\.com|kaspersky\.com|eset\.com|symantec\.com|defender\.microsoft\.com)\b/.test(hostLower);
                        let risk = 'info';
                        let note = isLocalMapping ? 'local-mapping' : 'static-mapping';

                        if (!isLocalMapping && redirectsSensitiveDomain) {
                            risk = 'high';
                            note = 'sensitive-domain-redirect';
                        } else if (!isLocalMapping) {
                            risk = 'warning';
                        }

                        return {
                            key: i,
                            ip,
                            hostname,
                            risk,
                            note
                        };
                    });
                if (data.length === 0) {
                    setNoRecordsDiagnostic('hosts_file', lines, 'Hosts 文件已读取，但没有发现有效主机映射行。文件可能只有注释，或当前系统未使用静态 hosts 映射。');
                } else {
                    setTableData(data);
                }
                break;
            }
            case 'dns_config': {
                if (osType === 'Windows') {
                    const jsonData = tryParseJsonArray(output);
                    if (jsonData) {
                        const data = jsonData
                            .filter((item: any) => item.ServerAddresses && item.ServerAddresses.length > 0)
                            .map((item: any, i: number) => ({
                                key: i,
                                interface: item.InterfaceAlias || '-',
                                dns: Array.isArray(item.ServerAddresses) ? item.ServerAddresses.join(', ') : (item.ServerAddresses || '-')
                            }));
                        if (data.length === 0) {
                            setNoRecordsDiagnostic('dns_config', lines, 'Windows DNS 配置命令已执行，但没有返回 DNS 服务器地址。请确认网卡配置，或以管理员身份重新采集。');
                        } else {
                            setTableData(data);
                        }
                    } else {
                        setCollectionFailureDiagnostic('dns_config', output, 'Windows DNS 配置输出不是有效 JSON。请检查 Get-DnsClientServerAddress 输出。');
                    }
                } else {
                    const data = parseLinuxDnsConfigLines(lines);
                    if (data.length === 0) {
                        setNoRecordsDiagnostic('dns_config', lines, 'DNS 配置文件已读取，但没有发现 nameserver/search/domain/options 等有效配置。可确认 /etc/resolv.conf 是否由 systemd-resolved 或 NetworkManager 动态管理。');
                    } else {
                        setTableData(data);
                    }
                }
                break;
            }
            default:
                setParseFailureDiagnostic(key, output, '该模块已有采集输出，但当前没有结构化解析器。请补充 parseAndSetData 分支和表格列配置后再启用此模块。');
        }
    };

    const handleTerminalCommand = async () => {
        if (!terminalInput.trim()) return;
        setExecuting(true);

        // 构建完整的Kali风格提示符
        const prompt = terminalUser === 'root' ? '#' : '$';
        const promptLine = `(${terminalUser}@${terminalHost})-[${terminalPath}]${prompt} ${terminalInput}`;
        setTerminalOutput(prev => [...prev, promptLine]);

        const cmd = terminalInput.trim();

        // 处理cd命令 - 需要更新当前路径（cd是shell内建命令）
        if (cmd.startsWith('cd ') || cmd === 'cd') {
            const targetDir = cmd === 'cd' ? '~' : cmd.substring(3).trim();
            try {
                // cd需要使用executeTerminalCommand以便在sudo模式下正确执行
                const cdCmd = targetDir.startsWith('/')
                    ? `cd ${targetDir} && pwd`
                    : `cd ${targetDir} && pwd`;
                const output = await executeTerminalCommand(cdCmd, terminalPath);
                const lines = output.trim().split('\n');
                const lastLine = lines[lines.length - 1]?.trim();

                // 检查输出是否包含错误信息
                const hasError = output.toLowerCase().includes('error') ||
                    output.toLowerCase().includes('no such') ||
                    output.toLowerCase().includes('can\'t cd') ||
                    output.toLowerCase().includes('cannot cd') ||
                    output.toLowerCase().includes('permission denied') ||
                    output.includes('unmatched') ||
                    output.includes('not a directory');

                // 只有当没有错误且最后一行是有效路径（以/开头或是~）时才更新路径
                if (!hasError && lastLine && (lastLine.startsWith('/') || lastLine === '~')) {
                    setTerminalPath(lastLine);
                } else {
                    // 有错误，显示错误信息
                    setTerminalOutput(prev => [...prev, output || 'cd: 目录不存在或无权限']);
                }
            } catch (e) {
                setTerminalOutput(prev => [...prev, `错误: ${e}`]);
            }
        } else {
            // 普通命令使用executeTerminalCommand在当前目录执行
            const output = await executeTerminalCommand(cmd, terminalPath);
            // 始终显示输出（包括错误信息）
            if (output) {
                setTerminalOutput(prev => [...prev, output]);
            }
        }

        setTerminalInput('');
        setExecuting(false);
    };

    // ===== 文件管理功能 =====
    const loadDirectory = async (path: string) => {
        setLoading(true);
        setFileContent(null);
        setViewingFile(null);
        try {
            // 先检查路径是否存在
            const checkCmd = `test -d "${path}" && echo "EXISTS" || echo "NOT_EXISTS"`;
            const checkResult = await executeRemoteCommand(checkCmd);

            if (checkResult.trim() === 'NOT_EXISTS') {
                message.error(`路径不存在: ${path}`);
                setLoading(false);
                return;
            }

            const cmd = `ls -la --time-style=long-iso "${path}" 2>/dev/null`;
            const output = await executeRemoteCommand(cmd);

            if (!output || output.trim() === '') {
                message.warning(`目录为空或无法访问: ${path}`);
            }

            const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));

            const files = lines.map((line, i) => {
                const parts = line.split(/\s+/);
                if (parts.length < 8) return null;

                const permissions = parts[0];
                const isDir = permissions.startsWith('d');
                const isLink = permissions.startsWith('l');
                const size = parts[4];
                const date = `${parts[5]} ${parts[6]}`;
                const name = parts.slice(7).join(' ').split(' -> ')[0]; // 处理符号链接

                if (name === '.' || name === '..') return null;

                return {
                    key: i,
                    name,
                    isDir,
                    isLink,
                    permissions,
                    size: isDir ? '-' : formatFileSize(parseInt(size) || 0),
                    rawSize: parseInt(size) || 0,
                    date,
                    fullPath: path === '/' ? `/${name}` : `${path}/${name}`,
                };
            }).filter(Boolean);

            // 排序：文件夹在前，然后按名称排序
            files.sort((a: any, b: any) => {
                if (a.isDir && !b.isDir) return -1;
                if (!a.isDir && b.isDir) return 1;
                return a.name.localeCompare(b.name);
            });

            setFileList(files);
            setFilePath(path);
        } catch (e) {
            message.error(`加载目录失败: ${e}`);
            console.error('加载目录失败:', e);
        }
        setLoading(false);
    };

    const loadFileContent = async (path: string) => {
        setLoading(true);
        try {
            // 先检查文件类型和大小
            const statCmd = `stat --format="%s" "${path}" 2>/dev/null && file -b "${path}" 2>/dev/null`;
            const statOutput = await executeRemoteCommand(statCmd);
            const [sizeStr, fileType] = statOutput.split('\n');
            const size = parseInt(sizeStr) || 0;

            if (size > 1024 * 1024) { // 大于1MB
                setFileContent(`[文件过大: ${formatFileSize(size)}，仅显示前100KB]\n\n` +
                    await executeRemoteCommand(`head -c 102400 "${path}" 2>/dev/null`));
            } else if (fileType?.toLowerCase().includes('binary') || fileType?.toLowerCase().includes('executable')) {
                setFileContent(`[二进制文件: ${fileType}]\n\n` +
                    await executeRemoteCommand(`xxd "${path}" 2>/dev/null | head -100`));
            } else {
                setFileContent(await executeRemoteCommand(`cat "${path}" 2>/dev/null`));
            }
            setViewingFile(path);
        } catch (e) {
            setFileContent(`加载文件失败: ${e}`);
        }
        setLoading(false);
    };

    // 智能文件预览 - 在模态窗口中预览
    const openFilePreview = async (file: any) => {
        if (file.isDir) return;

        setLoading(true);
        setPreviewFileName(file.name);
        setPreviewModalOpen(true);

        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const textExts = ['txt', 'log', 'conf', 'cfg', 'ini', 'json', 'xml', 'yml', 'yaml', 'md', 'sh', 'bash', 'py', 'js', 'ts', 'html', 'css', 'sql', 'php', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'pl'];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'svg'];
        const tableExts = ['csv', 'tsv'];

        try {
            if (imageExts.includes(ext)) {
                // 图片预览
                setPreviewType('image');
                const base64Cmd = isWindowsLocalMode
                    ? buildWindowsPreviewBase64Command(file.fullPath)
                    : `base64 "${file.fullPath}" 2>/dev/null`;
                const base64 = await executeRemoteCommand(base64Cmd);
                setImageBase64(`data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${base64.trim()}`);
                setFileContent(null);
                setHexData([]);
            } else if (textExts.includes(ext)) {
                // 文本预览
                setPreviewType('text');
                const command = isWindowsLocalMode
                    ? buildWindowsPreviewTextCommand(file.fullPath)
                    : `cat "${file.fullPath}" 2>/dev/null`;
                const content = await executeRemoteCommand(command);
                setFileContent(content);
                setImageBase64(null);
                setHexData([]);
            } else if (tableExts.includes(ext)) {
                // 表格预览 (CSV/TSV)
                setPreviewType('table');
                const command = isWindowsLocalMode
                    ? buildWindowsPreviewTextCommand(file.fullPath)
                    : `cat "${file.fullPath}" 2>/dev/null`;
                const content = await executeRemoteCommand(command);
                setFileContent(content);
                setImageBase64(null);
                setHexData([]);
            } else {
                // 二进制/其他文件用 HexView
                setPreviewType('hex');
                // 获取文件前64KB的十六进制数据 (xxd 或 od 或 hexdump)
                const hexCmd = isWindowsLocalMode
                    ? buildWindowsPreviewHexCommand(file.fullPath)
                    : `xxd -p "${file.fullPath}" 2>/dev/null | head -c 131072 || od -A n -t x1 "${file.fullPath}" 2>/dev/null | head -c 200000 | tr -d ' \\n' || hexdump -C "${file.fullPath}" 2>/dev/null | head -500 | awk '{for(i=2;i<=17;i++)printf $i}' | tr -d ' '`;
                const hexStr = await executeRemoteCommand(hexCmd);
                // 转换为字节数组
                const bytes: number[] = [];
                const cleanHex = hexStr.replace(/[^0-9a-fA-F]/g, '');
                for (let i = 0; i < cleanHex.length && bytes.length < 65536; i += 2) {
                    const byte = parseInt(cleanHex.substr(i, 2), 16);
                    if (!isNaN(byte)) bytes.push(byte);
                }
                setHexData(bytes);
                setFileContent(null);
                setImageBase64(null);
            }
            setViewingFile(file.fullPath);
        } catch (e) {
            setFileContent(`加载文件失败: ${e}`);
            setPreviewType('text');
        }
        setLoading(false);
    };

    // Docker容器文件预览 - 使用 docker exec
    const openDockerFilePreview = async (containerId: string, file: any) => {
        if (file.isDir) return;

        setLoading(true);
        setPreviewFileName(`[容器] ${file.name}`);
        setFileContent('正在加载...');
        setPreviewType('text');
        setPreviewModalOpen(true);

        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const textExts = ['txt', 'log', 'conf', 'cfg', 'ini', 'json', 'xml', 'yml', 'yaml', 'md', 'sh', 'bash', 'py', 'js', 'ts', 'html', 'css', 'sql', 'php', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'pl', 'env', 'profile', 'bashrc', 'zshrc'];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico', 'svg'];
        const tableExts = ['csv', 'tsv'];
        const binaryExts = ['bin', 'exe', 'so', 'dll', 'o', 'a', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'];

        try {
            // 直接尝试读取文件，如果容器未运行会自动失败
            if (imageExts.includes(ext)) {
                // 图片预览
                const base64Cmd = `docker exec ${containerId} base64 "${file.fullPath}" 2>/dev/null`;
                const base64 = await executeRemoteCommand(base64Cmd);
                if (base64.trim()) {
                    setPreviewType('image');
                    setImageBase64(`data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${base64.trim()}`);
                    setFileContent(null);
                } else {
                    setFileContent('无法读取图片文件（容器可能未运行）');
                }
                setHexData([]);
            } else if (binaryExts.includes(ext)) {
                // 二进制文件用 HexView
                const hexCmd = `docker exec ${containerId} sh -c 'xxd -p "${file.fullPath}" 2>/dev/null | head -c 131072 || od -A n -t x1 "${file.fullPath}" 2>/dev/null | head -c 200000 | tr -d " \\n"'`;
                const hexStr = await executeRemoteCommand(hexCmd);
                if (hexStr.trim()) {
                    setPreviewType('hex');
                    const bytes: number[] = [];
                    const cleanHex = hexStr.replace(/[^0-9a-fA-F]/g, '');
                    for (let i = 0; i < cleanHex.length && bytes.length < 65536; i += 2) {
                        const byte = parseInt(cleanHex.substr(i, 2), 16);
                        if (!isNaN(byte)) bytes.push(byte);
                    }
                    setHexData(bytes);
                    setFileContent(null);
                } else {
                    setFileContent('无法读取文件（容器可能未运行）');
                }
                setImageBase64(null);
            } else if (tableExts.includes(ext)) {
                // 表格预览 (CSV/TSV)
                const content = await executeRemoteCommand(`docker exec ${containerId} cat "${file.fullPath}" 2>/dev/null`);
                if (content) {
                    setPreviewType('table');
                    setFileContent(content);
                } else {
                    setFileContent('文件为空或容器未运行');
                }
                setImageBase64(null);
                setHexData([]);
            } else {
                // 默认使用文本预览
                const content = await executeRemoteCommand(`docker exec ${containerId} cat "${file.fullPath}" 2>/dev/null`);
                setFileContent(content || '文件为空或容器未运行');
                setImageBase64(null);
                setHexData([]);
            }
            setViewingFile(file.fullPath);
            setDockerFileBrowserOpen(false); // 成功后关闭文件浏览器
        } catch (e) {
            setFileContent(`加载文件失败: ${e}`);
        }
        setLoading(false);
    };

    // HexView 搜索
    const searchHex = (query: string) => {
        setHexSearch(query);
        if (!query) {
            setHexSearchResults([]);
            setHexMatchLength(0);
            setCurrentMatchIndex(0);
            return;
        }

        const results: number[] = [];

        if (hexSearchMode === 'hex') {
            // 十六进制搜索模式
            const searchBytes = query.split(/\s+/).filter(Boolean).map(b => parseInt(b, 16));
            if (searchBytes.some(isNaN)) {
                setHexSearchResults([]);
                setHexMatchLength(0);
                setCurrentMatchIndex(0);
                return;
            }
            setHexMatchLength(searchBytes.length);

            for (let i = 0; i <= hexData.length - searchBytes.length; i++) {
                let match = true;
                for (let j = 0; j < searchBytes.length; j++) {
                    if (hexData[i + j] !== searchBytes[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) results.push(i);
            }
        } else {
            // 文本搜索模式
            const searchText = query;
            setHexMatchLength(searchText.length);

            for (let i = 0; i <= hexData.length - searchText.length; i++) {
                let match = true;
                for (let j = 0; j < searchText.length; j++) {
                    // 大小写不敏感匹配
                    if (String.fromCharCode(hexData[i + j]).toLowerCase() !== searchText[j].toLowerCase()) {
                        match = false;
                        break;
                    }
                }
                if (match) results.push(i);
            }
        }
        setHexSearchResults(results);
        setCurrentMatchIndex(0);
        // 自动滚动到第一个匹配
        if (results.length > 0) {
            setTimeout(() => scrollToMatch(0, results), 50);
        }
    };

    // 滚动到指定匹配位置
    const scrollToMatch = (index: number, results?: number[]) => {
        const matchResults = results || hexSearchResults;
        if (matchResults.length === 0 || index < 0 || index >= matchResults.length) return;

        const matchOffset = matchResults[index];
        const bytesPerRow = 16;
        const rowHeight = 20; // 每行大约 20px
        const targetRow = Math.floor(matchOffset / bytesPerRow);

        if (hexViewRef.current) {
            hexViewRef.current.scrollTop = Math.max(0, targetRow * rowHeight - 100);
        }
        setCurrentMatchIndex(index);
    };

    // 下一个匹配
    const nextMatch = () => {
        if (hexSearchResults.length === 0) return;
        const nextIndex = (currentMatchIndex + 1) % hexSearchResults.length;
        scrollToMatch(nextIndex);
    };

    // 上一个匹配
    const prevMatch = () => {
        if (hexSearchResults.length === 0) return;
        const prevIndex = (currentMatchIndex - 1 + hexSearchResults.length) % hexSearchResults.length;
        scrollToMatch(prevIndex);
    };

    // 渲染 HexView 组件
    const renderHexView = () => {
        const bytesPerRow = 16;
        const rows = [];

        // 检查地址是否在高亮范围内
        const isAddrHighlighted = (addr: number) => {
            for (const startAddr of hexSearchResults) {
                if (addr >= startAddr && addr < startAddr + hexMatchLength) {
                    return true;
                }
            }
            return false;
        };

        for (let offset = 0; offset < hexData.length; offset += bytesPerRow) {
            const rowBytes = hexData.slice(offset, offset + bytesPerRow);
            const hexParts = rowBytes.map((b, i) => {
                const addr = offset + i;
                const isHighlighted = isAddrHighlighted(addr);
                return (
                    <span
                        key={i}
                        style={{
                            background: isHighlighted ? '#ffeb3b' : 'transparent',
                            padding: '0 1px',
                        }}
                    >
                        {b.toString(16).padStart(2, '0').toUpperCase()}
                    </span>
                );
            });

            const asciiParts = rowBytes.map((b, i) => {
                const addr = offset + i;
                const isHighlighted = isAddrHighlighted(addr);
                const char = b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
                return (
                    <span
                        key={i}
                        style={{
                            background: isHighlighted ? '#ffeb3b' : 'transparent',
                        }}
                    >
                        {char}
                    </span>
                );
            });

            rows.push(
                <div key={offset} style={{ display: 'flex', fontFamily: 'Consolas, monospace', fontSize: 12 }}>
                    <div style={{ width: 80, color: '#666', userSelect: 'none' }}>
                        {offset.toString(16).padStart(8, '0').toUpperCase()}
                    </div>
                    <div style={{ width: 400, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {hexParts.map((p, i) => (
                            <span key={i}>
                                {p}
                                {i === 7 && <span style={{ width: 8, display: 'inline-block' }}></span>}
                            </span>
                        ))}
                    </div>
                    <div style={{ width: 20 }}></div>
                    <div style={{ color: '#4ec9b0' }}>{asciiParts}</div>
                </div>
            );
        }

        return (
            <div>
                {/* 搜索框 */}
                <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Select
                        value={hexSearchMode}
                        onChange={(v) => { setHexSearchMode(v); setHexSearchResults([]); setHexSearch(''); }}
                        style={{ width: 100 }}
                        options={[
                            { value: 'text', label: '文本' },
                            { value: 'hex', label: '十六进制' },
                        ]}
                    />
                    <Input.Search
                        placeholder={hexSearchMode === 'text' ? '输入文本搜索...' : '输入十六进制值 (如: 4D 5A 90)'}
                        value={hexSearch}
                        onChange={(e) => searchHex(e.target.value)}
                        onPressEnter={nextMatch}
                        style={{ width: 300 }}
                    />
                    {hexSearchResults.length > 0 && (
                        <Space>
                            <Button size="small" onClick={prevMatch}>↑</Button>
                            <Text type="secondary">
                                {currentMatchIndex + 1} / {hexSearchResults.length}
                            </Text>
                            <Button size="small" onClick={nextMatch}>↓</Button>
                        </Space>
                    )}
                </div>
                {/* HexView 表格 */}
                <div
                    ref={hexViewRef}
                    style={{
                        maxHeight: 450,
                        overflow: 'auto',
                        background: '#1e1e1e',
                        color: '#d4d4d4',
                        padding: 12,
                        borderRadius: 4,
                        userSelect: 'text',
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        const selection = window.getSelection()?.toString();
                        if (selection) {
                            navigator.clipboard.writeText(selection);
                            message.success('已复制到剪贴板');
                        }
                    }}
                >
                    {/* 表头 */}
                    <div style={{ display: 'flex', fontFamily: 'Consolas, monospace', fontSize: 12, color: '#808080', marginBottom: 8, borderBottom: '1px solid #333', paddingBottom: 4 }}>
                        <div style={{ width: 80 }}>Offset</div>
                        <div style={{ width: 400 }}>00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F</div>
                        <div style={{ width: 20 }}></div>
                        <div>ASCII</div>
                    </div>
                    {rows}
                    {hexData.length === 0 && (
                        <div style={{ textAlign: 'center', padding: 40, color: '#666' }}>
                            <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
                            <div>无法读取文件数据或文件为空</div>
                            <div style={{ fontSize: 12, marginTop: 8 }}>请确保远程主机已安装 xxd 命令</div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // 渲染CSV表格
    const renderCsvTable = () => {
        if (!fileContent) return null;
        const lines = fileContent.split('\n').filter(l => l.trim());
        if (lines.length === 0) return <Text type="secondary">空文件</Text>;

        const headers = lines[0].split(',').map(h => h.trim());
        const data = lines.slice(1).map((line, i) => {
            const values = line.split(',');
            const row: any = { key: i };
            headers.forEach((h, j) => row[h] = values[j]?.trim() || '');
            return row;
        });

        const columns = headers.map(h => ({ title: h, dataIndex: h, key: h, ellipsis: true }));

        return <Table dataSource={data} columns={columns} size="small" scroll={{ x: true }} pagination={{ pageSize: 20 }} />;
    };

    // 文件名查找
    const findFiles = async (pattern: string) => {
        if (!pattern.trim()) return;
        setFinding(true);
        setFindResults([]);
        try {
            // 使用 find 命令查找文件
            const cmd = `find "${filePath}" -maxdepth 5 -name "*${pattern}*" 2>/dev/null | head -100`;
            const output = await executeRemoteCommand(cmd);
            const files = output.split('\n').filter(f => f.trim()).map((path, i) => ({
                key: i,
                path,
                name: path.split('/').pop(),
                isDir: false,
            }));
            setFindResults(files);
        } catch (e) {
            message.error(`查找失败: ${e}`);
        }
        setFinding(false);
    };

    // 内容查找 (grep)
    const findContent = async (pattern: string) => {
        if (!pattern.trim()) return;
        setFinding(true);
        setFindResults([]);
        try {
            // 使用 grep 递归查找内容
            const cmd = `grep -rl "${pattern}" "${filePath}" --include="*" 2>/dev/null | head -50`;
            const output = await executeRemoteCommand(cmd);
            const files = output.split('\n').filter(f => f.trim()).map((path, i) => ({
                key: i,
                path,
                name: path.split('/').pop(),
                matchContent: pattern,
            }));
            setFindResults(files);
        } catch (e) {
            message.error(`查找失败: ${e}`);
        }
        setFinding(false);
    };

    // 执行查找
    const executeFind = () => {
        if (findType === 'file') {
            findFiles(findQuery);
        } else {
            findContent(findQuery);
        }
    };

    // Docker Inspect - 获取容器详细信息
    const loadDockerInspect = async (containerId: string) => {
        setLoading(true);
        setDockerContainerId(containerId);
        try {
            const cmd = `docker inspect ${containerId} 2>/dev/null`;
            const output = await executeRemoteCommand(cmd);
            try {
                const data = JSON.parse(output);
                setDockerInspectData(data[0] || data);
            } catch {
                setDockerInspectData({ raw: output });
            }
            setDockerInspectOpen(true);
        } catch (e) {
            message.error(`获取容器详情失败: ${e}`);
        }
        setLoading(false);
    };

    // Docker 容器内文件浏览
    const loadDockerDirectory = async (containerId: string, path: string) => {
        setLoading(true);
        try {
            const cmd = `docker exec ${containerId} ls -la "${path}" 2>/dev/null`;
            const output = await executeRemoteCommand(cmd);

            if (!output || output.includes('Error')) {
                message.error('无法访问容器文件系统');
                setLoading(false);
                return;
            }

            const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
            const files = lines.map((line, i) => {
                const parts = line.split(/\s+/);
                if (parts.length < 8) return null;

                const permissions = parts[0];
                const isDir = permissions.startsWith('d');
                const size = parts[4];
                const name = parts.slice(8).join(' ').split(' -> ')[0];

                if (name === '.' || name === '..') return null;

                return {
                    key: i,
                    name,
                    isDir,
                    permissions,
                    size: isDir ? '-' : formatFileSize(parseInt(size) || 0),
                    fullPath: path === '/' ? `/${name}` : `${path}/${name}`,
                };
            }).filter(Boolean);

            files.sort((a: any, b: any) => {
                if (a.isDir && !b.isDir) return -1;
                if (!a.isDir && b.isDir) return 1;
                return a.name.localeCompare(b.name);
            });

            setDockerFileList(files);
            setDockerFilePath(path);
            setDockerFileBrowserOpen(true);
        } catch (e) {
            message.error(`浏览容器文件失败: ${e}`);
        }
        setLoading(false);
    };

    // Docker 容器右键菜单
    const getDockerContextMenu = (record: any): MenuProps['items'] => [
        {
            key: 'inspect',
            icon: <EyeOutlined />,
            label: '查看详情',
            onClick: () => loadDockerInspect(record.container_id),
        },
        {
            key: 'files',
            icon: <DesktopOutlined />,
            label: '浏览文件',
            disabled: !record.status?.includes('Up'),
            onClick: () => {
                setDockerContainerId(record.container_id);
                loadDockerDirectory(record.container_id, '/');
            },
        },
        { type: 'divider' },
        {
            key: 'logs',
            icon: <FileSearchOutlined />,
            label: '查看日志',
            onClick: async () => {
                const cmd = `docker logs --tail 100 ${record.container_id} 2>&1`;
                const output = await executeRemoteCommand(cmd);
                setFileContent(output);
                setPreviewFileName(`${record.container_id} 日志`);
                setPreviewType('text');
                setPreviewModalOpen(true);
            },
        },
        { type: 'divider' },
        {
            key: 'start',
            label: '▶️ 启动',
            disabled: record.status?.includes('Up'),
            onClick: async () => {
                message.loading({ content: '正在启动...', key: 'docker' });
                await executeRemoteCommand(`docker start ${record.container_id}`);
                message.success({ content: '已启动', key: 'docker' });
            },
        },
        {
            key: 'stop',
            label: '⏹️ 停止',
            disabled: !record.status?.includes('Up'),
            onClick: async () => {
                message.loading({ content: '正在停止...', key: 'docker' });
                await executeRemoteCommand(`docker stop ${record.container_id}`);
                message.success({ content: '已停止', key: 'docker' });
            },
        },
        {
            key: 'restart',
            label: '🔄 重启',
            onClick: async () => {
                message.loading({ content: '正在重启...', key: 'docker' });
                await executeRemoteCommand(`docker restart ${record.container_id}`);
                message.success({ content: '已重启', key: 'docker' });
            },
        },
    ];

    const formatFileSize = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    // 计算文件哈希
    const calculateHash = async () => {
        if (!hashTarget) return;
        setCalculating(true);
        try {
            const hashCmd = hashType === 'md5'
                ? `md5sum "${hashTarget.fullPath}" 2>/dev/null | awk '{print $1}'`
                : hashType === 'sha1'
                    ? `sha1sum "${hashTarget.fullPath}" 2>/dev/null | awk '{print $1}'`
                    : `sha256sum "${hashTarget.fullPath}" 2>/dev/null | awk '{print $1}'`;

            const hash = await executeRemoteCommand(hashCmd);

            // 更新文件列表中的哈希值
            setFileList(prev => prev.map(f =>
                f.fullPath === hashTarget.fullPath
                    ? { ...f, [`${hashType}Hash`]: hash.trim() }
                    : f
            ));

            message.success(`${hashType.toUpperCase()} 计算完成`);
            setHashModalOpen(false);
        } catch (e) {
            message.error(`计算失败: ${e}`);
        }
        setCalculating(false);
    };

    // 下载文件 - 使用 Tauri FS API
    const downloadFile = async (file: any) => {
        if (file.isDir) {
            message.warning('暂不支持下载文件夹');
            return;
        }
        message.loading({ content: '正在准备下载...', key: 'download' });
        try {
            const base64Cmd = `base64 "${file.fullPath}" 2>/dev/null`;
            const base64Content = await executeRemoteCommand(base64Cmd);

            if (!base64Content || base64Content.includes('错误')) {
                throw new Error('无法读取文件');
            }

            // 解码
            const binaryString = atob(base64Content.trim());
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // 确定保存路径
            let savePath = '';
            let useDefault = false;

            if (defaultDownloadPath) {
                try {
                    // 检查路径是否存在
                    const isExist = await exists(defaultDownloadPath);
                    if (isExist) {
                        savePath = await join(defaultDownloadPath, file.name);
                        useDefault = true;
                    }
                } catch (e) {
                    console.error('检查默认下载路径失败:', e);
                }
            }

            if (!useDefault) {
                // 否则询问
                const selected = await save({
                    defaultPath: file.name,
                });
                if (!selected) {
                    message.info('已取消下载');
                    return;
                }
                savePath = selected;
            }

            // 写入文件
            await writeFile(savePath, bytes);

            message.success({ content: '下载完成', key: 'download' });

            // 打开所在的文件夹并选中文件
            try {
                await revealItemInDir(savePath);
            } catch (err) {
                console.error('无法打开文件夹', err);
            }
        } catch (e) {
            message.error({ content: `下载失败: ${e}`, key: 'download' });
        }
    };

    // 上传文件
    const handleUpload = async (file: File) => {
        message.loading({ content: '正在上传...', key: 'upload' });
        try {
            // 读取文件为base64
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64 = (e.target?.result as string).split(',')[1];
                const destPath = `${filePath}/${file.name}`;

                // 通过SSH写入文件
                const uploadCmd = `echo "${base64}" | base64 -d > "${destPath}"`;
                await executeRemoteCommand(uploadCmd);

                message.success({ content: '上传完成', key: 'upload' });
                loadDirectory(filePath); // 刷新目录
            };
            reader.readAsDataURL(file);
        } catch (e) {
            message.error({ content: `上传失败: ${e}`, key: 'upload' });
        }
        return false; // 阻止默认上传行为
    };

    // 文件右键菜单
    const getFileContextMenu = (record: any): MenuProps['items'] => [
        {
            key: 'preview',
            icon: <EyeOutlined />,
            label: '预览',
            disabled: record.isDir,
            onClick: () => openFilePreview(record),
        },
        {
            key: 'download',
            icon: <DownloadOutlined />,
            label: '下载',
            disabled: record.isDir,
            onClick: () => downloadFile(record),
        },
        { type: 'divider' },
        {
            key: 'hash',
            icon: <NumberOutlined />,
            label: '计算哈希',
            disabled: record.isDir,
            onClick: () => {
                setHashTarget(record);
                setHashModalOpen(true);
            },
        },
    ];

    // 文件管理初始化
    useEffect(() => {
        if (moduleKey === 'file_manager' && mode === 'remote' && fileList.length === 0) {
            loadDirectory('/');
        }
    }, [moduleKey, mode]);

    const renderFileManager = () => {
        // 面包屑导航
        const pathParts = filePath.split('/').filter(Boolean);
        const breadcrumbs = [
            { path: '/', name: '/' },
            ...pathParts.map((part, i) => ({
                path: '/' + pathParts.slice(0, i + 1).join('/'),
                name: part,
            })),
        ];

        const fileColumns = [
            {
                title: '名称',
                dataIndex: 'name',
                key: 'name',
                render: (name: string, record: any) => (
                    <Dropdown menu={{ items: getFileContextMenu(record) }} trigger={['contextMenu']}>
                        <span
                            style={{
                                cursor: 'pointer',
                                color: record.isDir ? '#1890ff' : 'inherit',
                                fontWeight: record.isDir ? 500 : 400,
                            }}
                            onClick={() => record.isDir ? loadDirectory(record.fullPath) : openFilePreview(record)}
                        >
                            {record.isDir ? '📁 ' : record.isLink ? '🔗 ' : '📄 '}{name}
                        </span>
                    </Dropdown>
                ),
            },
            { title: '大小', dataIndex: 'size', key: 'size', width: 100 },
            { title: '权限', dataIndex: 'permissions', key: 'permissions', width: 120 },
            { title: '修改时间', dataIndex: 'date', key: 'date', width: 160 },
            {
                title: 'MD5',
                dataIndex: 'md5Hash',
                key: 'md5Hash',
                width: 280,
                ellipsis: true,
                render: (hash: string) => hash ? <Text copyable style={{ fontSize: 11 }}>{hash}</Text> : '-',
            },
            {
                title: 'SHA256',
                dataIndex: 'sha256Hash',
                key: 'sha256Hash',
                width: 280,
                ellipsis: true,
                render: (hash: string) => hash ? <Text copyable style={{ fontSize: 11 }}>{hash}</Text> : '-',
            },
            {
                title: '操作',
                key: 'actions',
                width: 80,
                render: (_: any, record: any) => (
                    <Dropdown menu={{ items: getFileContextMenu(record) }} trigger={['click']}>
                        <Button type="text" size="small" icon={<MoreOutlined />} />
                    </Dropdown>
                ),
            },
        ];

        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* 标题栏 */}
                <div 
                    className={glassEnabled ? 'glass-header-container' : ''}
                    style={{ flexShrink: 0, marginBottom: 16 }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                        <Title level={4} style={{ margin: 0 }}>文件管理</Title>
                        <Tag color="green">远程</Tag>
                        {privilegeMode !== 'none' && <Tag color="orange">{privilegeMode}</Tag>}
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                            <Button
                                icon={<FileSearchOutlined />}
                                onClick={() => { setFindType('file'); setFindModalOpen(true); setFindQuery(''); setFindResults([]); }}
                            >
                                文件查找
                            </Button>
                            <Button
                                icon={<SearchOutlined />}
                                onClick={() => { setFindType('content'); setFindModalOpen(true); setFindQuery(''); setFindResults([]); }}
                            >
                                内容查找
                            </Button>
                            <Upload
                                showUploadList={false}
                                beforeUpload={handleUpload}
                            >
                                <Button icon={<UploadOutlined />}>上传</Button>
                            </Upload>
                            <Button
                                icon={<ReloadOutlined spin={loading} />}
                                onClick={() => loadDirectory(filePath)}
                            >
                                刷新
                            </Button>
                        </div>
                    </div>
                    {/* 可编辑路径栏 */}
                    {editingPath ? (
                        <Input
                            value={pathInput}
                            onChange={(e) => setPathInput(e.target.value)}
                            onPressEnter={() => {
                                loadDirectory(pathInput || '/');
                                setEditingPath(false);
                            }}
                            onBlur={() => setEditingPath(false)}
                            autoFocus
                            style={{ maxWidth: 600 }}
                            prefix={<span style={{ color: '#666' }}>路径:</span>}
                        />
                    ) : (
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                flexWrap: 'wrap',
                                background: '#f5f5f5',
                                padding: '6px 12px',
                                borderRadius: 4,
                                cursor: 'pointer',
                            }}
                            onClick={() => { setEditingPath(true); setPathInput(filePath); }}
                            title="点击编辑路径"
                        >
                            {breadcrumbs.map((item, i) => (
                                <span key={item.path}>
                                    <span
                                        style={{ cursor: 'pointer', color: '#1890ff' }}
                                        onClick={(e) => { e.stopPropagation(); loadDirectory(item.path); }}
                                    >
                                        {item.name}
                                    </span>
                                    {i < breadcrumbs.length - 1 && <span style={{ margin: '0 4px', color: '#999' }}>/</span>}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* 文件列表 */}
                <div style={{ flex: 1, overflow: 'auto' }}>
                    {/* 返回上级 */}
                    {filePath !== '/' && (
                        <div
                            style={{
                                padding: '8px 16px',
                                cursor: 'pointer',
                                background: '#fafafa',
                                marginBottom: 8,
                                borderRadius: 4,
                            }}
                            onClick={() => {
                                const parent = filePath.split('/').slice(0, -1).join('/') || '/';
                                loadDirectory(parent);
                            }}
                        >
                            📁 <span style={{ color: '#1890ff' }}>..</span> (返回上级目录)
                        </div>
                    )}
                    <Table
                        dataSource={fileList}
                        columns={fileColumns}
                        size="small"
                        loading={loading}
                        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 项` }}
                        scroll={{ x: 1200 }}
                    />
                </div>

                {/* 哈希计算弹窗 */}
                <Modal
                    title={`计算哈希 - ${hashTarget?.name || ''}`}
                    open={hashModalOpen}
                    onCancel={() => setHashModalOpen(false)}
                    onOk={calculateHash}
                    confirmLoading={calculating}
                    okText="计算"
                >
                    <div style={{ marginBottom: 16 }}>
                        <Text>选择哈希算法:</Text>
                    </div>
                    <Select
                        value={hashType}
                        onChange={setHashType}
                        style={{ width: '100%' }}
                        options={[
                            { value: 'md5', label: 'MD5' },
                            { value: 'sha1', label: 'SHA1' },
                            { value: 'sha256', label: 'SHA256' },
                        ]}
                    />
                </Modal>

                {/* 文件预览模态窗口 */}
                <Modal
                    title={`📄 ${previewFileName}`}
                    open={previewModalOpen}
                    onCancel={() => {
                        setPreviewModalOpen(false);
                        setFileContent(null);
                        setHexData([]);
                        setImageBase64(null);
                        setHexSearch('');
                        setHexSearchResults([]);
                    }}
                    footer={null}
                    width={previewType === 'hex' ? 900 : 800}
                    styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
                >
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
                    ) : previewType === 'image' ? (
                        <div style={{ textAlign: 'center' }}>
                            {imageBase64 && <img src={imageBase64} alt={previewFileName} style={{ maxWidth: '100%', maxHeight: 500 }} />}
                        </div>
                    ) : previewType === 'table' ? (
                        renderCsvTable()
                    ) : previewType === 'hex' ? (
                        renderHexView()
                    ) : (() => {
                        // 根据文件扩展名判断语言类型
                        const ext = previewFileName.split('.').pop()?.toLowerCase() || '';
                        const isCode = ['py', 'js', 'ts', 'jsx', 'tsx', 'sh', 'bash', 'php', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'css', 'html', 'xml', 'json', 'yaml', 'yml', 'sql', 'lua', 'pl', 'ps1'].includes(ext);

                        if (!isCode) {
                            return (
                                <pre style={{
                                    margin: 0,
                                    fontSize: 12,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    maxHeight: 500,
                                    overflow: 'auto',
                                    background: '#f5f5f5',
                                    padding: 12,
                                    borderRadius: 4,
                                }}>
                                    {fileContent || '无内容'}
                                </pre>
                            );
                        }

                        // 代码语法高亮
                        const lines = (fileContent || '').split('\n');
                        const highlightLine = (line: string, lang: string) => {
                            let color = '#e0e0e0';
                            // 注释
                            if (line.trim().startsWith('#') || line.trim().startsWith('//') || line.trim().startsWith('--')) {
                                color = '#6a9955'; // 绿色注释
                            }
                            // 字符串
                            else if (line.match(/["'`].*["'`]/)) {
                                color = '#ce9178'; // 橙色字符串
                            }
                            // 关键字 (Python)
                            else if (['py'].includes(lang) && line.match(/\b(def|class|import|from|if|else|elif|for|while|try|except|finally|return|yield|with|as|lambda|pass|break|continue|raise|assert|global|nonlocal|True|False|None|and|or|not|in|is)\b/)) {
                                color = '#c586c0'; // 紫色关键字
                            }
                            // 关键字 (JS/TS)
                            else if (['js', 'ts', 'jsx', 'tsx'].includes(lang) && line.match(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|null|undefined|true|false)\b/)) {
                                color = '#c586c0';
                            }
                            // 关键字 (Shell)
                            else if (['sh', 'bash', 'ps1'].includes(lang) && line.match(/\b(if|then|else|fi|for|do|done|while|case|esac|function|echo|exit|export|source|alias|cd|pwd|ls|cat|grep|sed|awk)\b/)) {
                                color = '#c586c0';
                            }
                            // 函数定义
                            else if (line.match(/\b(def|function|func|fn)\s+\w+/)) {
                                color = '#dcdcaa'; // 黄色函数
                            }
                            // 变量赋值
                            else if (line.includes('=') && !line.includes('==')) {
                                color = '#9cdcfe'; // 蓝色变量
                            }
                            return color;
                        };

                        return (
                            <pre style={{
                                margin: 0,
                                padding: 16,
                                background: '#1e1e2e',
                                borderRadius: 8,
                                maxHeight: 500,
                                overflow: 'auto',
                                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                                fontSize: 13,
                                lineHeight: 1.5,
                            }}>
                                {lines.map((line, i) => (
                                    <div key={i} style={{ display: 'flex' }}>
                                        <span style={{
                                            color: '#6e7681',
                                            minWidth: 45,
                                            textAlign: 'right',
                                            paddingRight: 16,
                                            userSelect: 'none',
                                            borderRight: '1px solid #333'
                                        }}>
                                            {i + 1}
                                        </span>
                                        <span style={{ color: highlightLine(line, ext), paddingLeft: 16 }}>
                                            {line || ' '}
                                        </span>
                                    </div>
                                ))}
                            </pre>
                        );
                    })()}
                </Modal>

                {/* 文件/内容查找弹窗 */}
                <Modal
                    title={findType === 'file' ? '🔍 文件名查找' : '🔍 内容查找 (grep)'}
                    open={findModalOpen}
                    onCancel={() => setFindModalOpen(false)}
                    footer={null}
                    width={700}
                >
                    <div style={{ marginBottom: 16 }}>
                        <Input.Search
                            placeholder={findType === 'file' ? '输入文件名关键词...' : '输入要搜索的内容...'}
                            value={findQuery}
                            onChange={(e) => setFindQuery(e.target.value)}
                            onSearch={executeFind}
                            enterButton="查找"
                            loading={finding}
                        />
                        <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                            在 <code>{filePath}</code> 目录下{findType === 'file' ? '查找文件' : '搜索文件内容'}
                        </Text>
                    </div>

                    {findResults.length > 0 && (
                        <div style={{ maxHeight: 400, overflow: 'auto' }}>
                            <List
                                size="small"
                                dataSource={findResults}
                                renderItem={(item: any) => (
                                    <List.Item
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => {
                                            const parentPath = item.path.split('/').slice(0, -1).join('/') || '/';
                                            loadDirectory(parentPath);
                                            setFindModalOpen(false);
                                        }}
                                    >
                                        <div>
                                            <div style={{ fontWeight: 500 }}>📄 {item.name}</div>
                                            <Text type="secondary" style={{ fontSize: 12 }}>{item.path}</Text>
                                        </div>
                                    </List.Item>
                                )}
                            />
                            <Text type="secondary">共找到 {findResults.length} 个结果</Text>
                        </div>
                    )}

                    {!finding && findResults.length === 0 && findQuery && (
                        <Text type="secondary">未找到匹配结果</Text>
                    )}
                </Modal>
            </div>
        );
    };

    // 远程系统信息页面 - 详细表格样式（类似参考图）
    const renderRemoteSystemInfo = () => {
        if (!remoteSystemInfo) return null;
        const { hostname, os_type, os_version, ip_address, uptime, load_avg, kernel, cpu_cores, mem_total, mem_used, mem_percent, disks,
            os_name, id_like, version_id, pretty_name, home_url, bug_report_url, architecture, cpu_model, issue_info, redhat_release } = remoteSystemInfo;

        // 系统详细信息表格数据 - 只显示有值的行
        const sysInfoData = [
            { key: 1, label: '主机名', field: 'hostname', value: hostname },
            { key: 2, label: '操作系统类型', field: 'OS_TYPE', value: os_type },
            { key: 3, label: '操作系统版本', field: 'OS_NAME', value: os_name || os_version },
            { key: 4, label: '发行版名称', field: 'PRETTY_NAME', value: pretty_name || os_type },
            { key: 5, label: 'RedHat/CentOS版本', field: 'REDHAT_RELEASE', value: redhat_release },
            { key: 6, label: '系统Issue', field: 'ISSUE', value: issue_info },
            { key: 7, label: '父发行版本', field: 'ID_LIKE', value: id_like },
            { key: 8, label: '系统版本号', field: 'VERSION_ID', value: version_id },
            { key: 9, label: '主页', field: 'HOME_URL', value: home_url },
            { key: 10, label: 'Bug反馈地址', field: 'BUG_REPORT_URL', value: bug_report_url },
            { key: 11, label: '内核版本', field: 'Kernel', value: kernel },
            { key: 12, label: '系统架构', field: 'Architecture', value: architecture },
            { key: 13, label: 'CPU型号', field: 'CPU_MODEL', value: cpu_model },
            { key: 14, label: 'CPU核心数', field: 'CPU_CORES', value: cpu_cores ? String(cpu_cores) : undefined },
            { key: 15, label: 'IP地址', field: 'IP_ADDRESS', value: ip_address },
            { key: 16, label: '运行时间', field: 'UPTIME', value: uptime },
            { key: 17, label: '系统负载', field: 'LOAD_AVG', value: load_avg },
            { key: 18, label: '内存总量', field: 'MEM_TOTAL', value: mem_total },
            { key: 19, label: '已用内存', field: 'MEM_USED', value: mem_used },
        ].filter(item => item.value && item.value !== '-' && item.value !== '0'); // 过滤掉没有值的行

        const sysInfoColumns = [
            { title: '#', dataIndex: 'key', key: 'key', width: 50 },
            { title: '名称', dataIndex: 'label', key: 'label', width: 150 },
            { title: '字段', dataIndex: 'field', key: 'field', width: 180 },
            { title: '值', dataIndex: 'value', key: 'value', ellipsis: true },
        ];

        const diskColumns = [
            { title: '挂载点', dataIndex: 'mount', key: 'mount' },
            { title: '大小', dataIndex: 'size', key: 'size', width: 80 },
            { title: '已用', dataIndex: 'used', key: 'used', width: 80 },
            { title: '可用', dataIndex: 'avail', key: 'avail', width: 80 },
            { title: '使用率', dataIndex: 'percent', key: 'percent', width: 150, render: (v: number) => <Progress percent={v} size="small" status={v > 90 ? 'exception' : 'normal'} /> },
        ];

        const loadOneMinute = Number.parseFloat((load_avg || '').split(',')[0] || '0');
        const loadPressure = cpu_cores > 0 && Number.isFinite(loadOneMinute)
            ? Math.round((loadOneMinute / cpu_cores) * 100)
            : 0;
        const hottestDisk = disks.reduce(
            (max, disk) => disk.percent > max.percent ? disk : max,
            { mount: '-', size: '-', used: '-', avail: '-', percent: 0 }
        );
        const pressureColor = (value: number) => value >= 90 ? '#f5222d' : value >= 70 ? '#fa8c16' : '#52c41a';
        const loadStatus = loadPressure >= 100 ? '高负载' : loadPressure >= 70 ? '偏高' : '正常';
        const memoryStatus = mem_percent >= 90 ? '内存紧张' : mem_percent >= 75 ? '偏高' : '正常';
        const diskStatus = hottestDisk.percent >= 90 ? '磁盘紧张' : hottestDisk.percent >= 80 ? '偏高' : '正常';
        const nextChecks = [
            { label: '进程异常检测', target: 'process_anomaly', reason: loadPressure >= 70 ? '定位高负载/隐藏进程' : '确认进程基线' },
            { label: '网络连接', target: 'network_conn', reason: '排查外联和监听异常' },
            { label: '计划任务(Cron)', target: 'cron', reason: '检查定时持久化' },
            { label: '可疑文件', target: 'suspicious_files', reason: '排查临时目录和提权文件' },
        ];

        return (
            <div className="fade-in">
                <Card
                    style={{
                        marginBottom: 16,
                        borderRadius: 16,
                        background: 'linear-gradient(135deg, rgba(18, 32, 51, 0.96), rgba(12, 82, 91, 0.88))',
                        color: '#fff',
                        overflow: 'hidden',
                    }}
                    styles={{ body: { padding: 18 } }}
                >
                    <Row gutter={[16, 16]} align="middle">
                        <Col xs={24} lg={8}>
                            <Text style={{ color: 'rgba(255,255,255,0.72)', letterSpacing: 1 }}>REMOTE SSH LINUX</Text>
                            <Title level={4} style={{ color: '#fff', margin: '6px 0 4px' }}>远程健康摘要</Title>
                            <Space wrap size={8}>
                                <Tag color="cyan">{hostname || '-'}</Tag>
                                <Tag color={loadPressure >= 100 || mem_percent >= 90 || hottestDisk.percent >= 90 ? 'red' : 'green'}>
                                    {loadPressure >= 100 || mem_percent >= 90 || hottestDisk.percent >= 90 ? '需要关注' : '状态稳定'}
                                </Tag>
                            </Space>
                        </Col>
                        <Col xs={24} lg={10}>
                            <Row gutter={[12, 12]}>
                                {[
                                    { title: '负载压力', value: loadPressure, status: loadStatus },
                                    { title: '内存压力', value: mem_percent, status: memoryStatus },
                                    { title: '磁盘最高使用率', value: hottestDisk.percent, status: diskStatus },
                                ].map(item => (
                                    <Col xs={24} sm={8} key={item.title}>
                                        <div style={{ border: '1px solid rgba(255,255,255,0.18)', borderRadius: 14, padding: 12, background: 'rgba(255,255,255,0.08)' }}>
                                            <Text style={{ color: 'rgba(255,255,255,0.72)' }}>{item.title}</Text>
                                            <div style={{ color: pressureColor(item.value), fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{item.value}%</div>
                                            <Text style={{ color: 'rgba(255,255,255,0.72)' }}>{item.status}</Text>
                                        </div>
                                    </Col>
                                ))}
                            </Row>
                        </Col>
                        <Col xs={24} lg={6}>
                            <Text style={{ color: 'rgba(255,255,255,0.72)' }}>建议优先检查</Text>
                            <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
                                {nextChecks.map(item => (
                                    <Button
                                        key={item.target}
                                        size="small"
                                        block
                                        onClick={() => onNavigate?.(item.target)}
                                        style={{ textAlign: 'left' }}
                                    >
                                        {item.label} · {item.reason}
                                    </Button>
                                ))}
                            </Space>
                        </Col>
                    </Row>
                </Card>

                {/* 顶部摘要 */}
                <Card style={{ marginBottom: 16 }}>
                    <Row gutter={24}>
                        <Col span={12}>
                            <Descriptions column={1} size="small">
                                <Descriptions.Item label="系统类型">{pretty_name || os_type}</Descriptions.Item>
                                <Descriptions.Item label="系统版本">{os_version || version_id || '-'}</Descriptions.Item>
                                <Descriptions.Item label="IP地址">{ip_address}</Descriptions.Item>
                            </Descriptions>
                        </Col>
                        <Col span={12}>
                            <Descriptions column={1} size="small">
                                <Descriptions.Item label="运行时间">{uptime}</Descriptions.Item>
                                <Descriptions.Item label="负载">{load_avg}</Descriptions.Item>
                            </Descriptions>
                        </Col>
                    </Row>
                </Card>

                {/* 详细系统信息表格 */}
                <Card style={{ marginBottom: 16 }}>
                    <Title level={5} style={{ marginBottom: 16 }}>详细系统信息</Title>
                    <Table
                        dataSource={sysInfoData}
                        columns={sysInfoColumns}
                        size="small"
                        pagination={false}
                        rowKey="key"
                    />
                </Card>

                {/* 服务器状态 & 概览 */}
                <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={12}>
                        <Card>
                            <Title level={5}>服务器状态</Title>
                            <Row gutter={24} style={{ marginTop: 16 }}>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={0} format={() => load_avg.split(',')[0] || '-'} strokeColor="#1890ff" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>负载状态</div>
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={0} format={() => `${cpu_cores}核心`} strokeColor="#faad14" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>CPU核心</div>
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={mem_percent} strokeColor="#52c41a" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>{mem_used}/{mem_total}</div>
                                    </div>
                                </Col>
                            </Row>
                        </Card>
                    </Col>
                    <Col span={12}>
                        <Card>
                            <Title level={5}>概览</Title>
                            <Row gutter={16} style={{ marginTop: 16 }}>
                                <Col span={12}>
                                    <Statistic title="外部连接" value={disks.length} prefix={<ApiOutlined />} />
                                </Col>
                                <Col span={12}>
                                    <Statistic title="用户" value="-" prefix={<UserOutlined />} />
                                </Col>
                                <Col span={12}>
                                    <Statistic title="磁盘" value={disks.length} prefix={<DatabaseOutlined />} />
                                </Col>
                            </Row>
                        </Card>
                    </Col>
                </Row>

                {/* 磁盘信息 */}
                <Card>
                    <Title level={5}>磁盘信息</Title>
                    <Table dataSource={disks} columns={diskColumns} rowKey="mount" size="small" pagination={false} />
                </Card>
            </div>
        );
    };

    const renderLocalSystemInfo = () => {
        if (!systemInfo) return null;
        const memoryPercent = (systemInfo.used_memory_gb / systemInfo.total_memory_gb) * 100;

        return (
            <div className="fade-in">
                <Card style={{ marginBottom: 16 }}>
                    <Title level={5}>服务器信息</Title>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
                        <DesktopOutlined style={{ fontSize: 24, color: '#1890ff', marginRight: 12 }} />
                        <Title level={4} style={{ margin: 0 }}>{systemInfo.hostname}</Title>
                    </div>
                    <Row gutter={24}>
                        <Col span={12}>
                            <Descriptions column={1} size="small">
                                <Descriptions.Item label="系统类型">{systemInfo.os_name} ({systemInfo.architecture})</Descriptions.Item>
                                <Descriptions.Item label="系统版本">{systemInfo.os_version}</Descriptions.Item>
                                <Descriptions.Item label="IP地址">{systemInfo.ip_addresses.join(', ') || '-'}</Descriptions.Item>
                                <Descriptions.Item label="内核版本">{systemInfo.kernel_version}</Descriptions.Item>
                            </Descriptions>
                        </Col>
                        <Col span={12}>
                            <Descriptions column={1} size="small">
                                <Descriptions.Item label="运行时间">{formatUptime(systemInfo.uptime_seconds)}</Descriptions.Item>
                                <Descriptions.Item label="开机时间">{systemInfo.boot_time_str}</Descriptions.Item>
                                <Descriptions.Item label="时区">{systemInfo.timezone}</Descriptions.Item>
                                <Descriptions.Item label="当前时间">{systemInfo.current_time}</Descriptions.Item>
                            </Descriptions>
                        </Col>
                    </Row>
                </Card>

                <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={16}>
                        <Card>
                            <Title level={5}>服务器状态</Title>
                            <Row gutter={24} style={{ marginTop: 16 }}>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={Math.round(systemInfo.cpu_usage)} strokeColor="#1890ff" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>CPU使用率</div>
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={0} format={() => `${systemInfo.cpu_cores}核心`} strokeColor="#faad14" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>CPU核心</div>
                                    </div>
                                </Col>
                                <Col span={8}>
                                    <div style={{ textAlign: 'center' }}>
                                        <Progress type="circle" size={70} percent={Math.round(memoryPercent)} strokeColor="#52c41a" />
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>{systemInfo.used_memory_gb.toFixed(1)}/{systemInfo.total_memory_gb.toFixed(1)}GB</div>
                                    </div>
                                </Col>
                            </Row>
                        </Card>
                    </Col>
                    <Col span={8}>
                        <Card>
                            <Title level={5}>概览</Title>
                            <Descriptions column={1} size="small">
                                <Descriptions.Item label="CPU型号">{systemInfo.cpu_model}</Descriptions.Item>
                                <Descriptions.Item label="磁盘数">{systemInfo.disks.length}</Descriptions.Item>
                            </Descriptions>
                        </Card>
                    </Col>
                </Row>
            </div>
        );
    };

    const loadWindowsArtifactPage = async (page: number, pageSize: number) => {
        if (!collectionArtifact?.path) {
            await loadData({ windowsLogPage: page, windowsLogPageSize: pageSize });
            return;
        }

        setLoading(true);
        setCollectionDiagnostic(null);
        try {
            const command = getWindowsArtifactPageCommand(
                collectionArtifact.path,
                page,
                pageSize,
                collectionArtifact.totalCount,
            );
            const output = await executeRemoteCommand(command);
            setRawOutput(output);
            parseAndSetData(moduleKey, output);
        } finally {
            setLoading(false);
        }
    };

    const renderTable = () => {
        if (tableData.length === 0) return null;
        const columnConfigs: Record<string, any[]> = {
            process_list: [
                { title: '用户', dataIndex: 'user', width: 80 },
                { title: 'PID', dataIndex: 'pid', width: 70 },
                { title: 'CPU%', dataIndex: 'cpu', width: 70 },
                { title: 'MEM%', dataIndex: 'mem', width: 70 },
                { title: '命令', dataIndex: 'command', ellipsis: true },
            ],
            user_list: [
                { title: '用户名', dataIndex: 'username', width: 120 },
                {
                    title: '类型', dataIndex: 'userType', width: 100, render: (v: string, r: any) => (
                        <Tag color={r.userTypeColor}>{v}</Tag>
                    )
                },
                { title: 'UID', dataIndex: 'uid', width: 70 },
                { title: 'GID', dataIndex: 'gid', width: 70 },
                { title: '描述', dataIndex: 'comment', ellipsis: true },
                { title: '主目录', dataIndex: 'home', ellipsis: true },
                {
                    title: 'Shell', dataIndex: 'shell', width: 150, render: (v: string, r: any) => (
                        <span style={{ color: r.canLogin ? '#52c41a' : '#8c8c8c' }}>{v}</span>
                    )
                },
                {
                    title: '可登录', dataIndex: 'canLogin', width: 80, render: (v: boolean) => (
                        v ? <Tag color="green">是</Tag> : <Tag color="default">否</Tag>
                    )
                },
            ],
            logged_users: [
                { title: '用户', dataIndex: 'user', width: 100 },
                { title: '会话', dataIndex: 'terminal', width: 120 },
                { title: 'ID', dataIndex: 'sessionId', width: 70 },
                { title: '状态', dataIndex: 'state', width: 90 },
                { title: '空闲', dataIndex: 'idleTime', width: 90 },
                { title: '登录时间', dataIndex: 'time', width: 180 },
                { title: '时长', dataIndex: 'duration', width: 120 },
                { title: 'IP', dataIndex: 'ip', width: 150 },
                {
                    title: '来源', dataIndex: 'source', width: 80, render: (v: string) => (
                        <Tag color={v === 'Local' ? 'green' : 'blue'}>{v}</Tag>
                    )
                },
            ],
            disk_info: [
                { title: '文件系统', dataIndex: 'filesystem' },
                { title: '大小', dataIndex: 'size', width: 80 },
                { title: '已用', dataIndex: 'used', width: 80 },
                { title: '可用', dataIndex: 'avail', width: 80 },
                { title: '使用率', dataIndex: 'percent', width: 120, render: (v: number) => <Progress percent={v} size="small" status={v > 90 ? 'exception' : 'normal'} /> },
                { title: '挂载点', dataIndex: 'mount' },
            ],
            process_anomaly: [
                {
                    title: '异常类型',
                    dataIndex: 'type',
                    width: 120,
                    render: (v: string) => {
                        const types: any = {
                            HIDDEN: { label: '隐藏进程', color: 'volcano' },
                            DELETED: { label: '文件已删除', color: 'red' },
                            SENSITIVE_PATH: { label: '敏感路径', color: 'orange' },
                            HIGH_RESOURCES: { label: '高负载', color: 'blue' }
                        };
                        return <Tag color={types[v]?.color || 'default'}>{types[v]?.label || v}</Tag>;
                    }
                },
                { title: 'PID', dataIndex: 'pid', width: 80 },
                { title: '用户', dataIndex: 'user', width: 80 },
                { title: '路径/链接', dataIndex: 'path', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v || '-'}</Text> },
                { title: '详细信息', dataIndex: 'detail', ellipsis: true },
                {
                    title: '等级',
                    dataIndex: 'severity',
                    width: 80,
                    render: (v: string) => {
                        const colors: any = { high: '#f5222d', warning: '#fa8c16', info: '#1890ff' };
                        return <Tag color={colors[v] || 'default'}>{v?.toUpperCase()}</Tag>;
                    }
                },
            ],
            listen_ports: [
                { title: '状态', dataIndex: 'state', width: 80 },
                { title: '本地地址', dataIndex: 'local' },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '进程', dataIndex: 'process', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'processPath', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: '远程地址', dataIndex: 'peer' },
            ],
            ssh_keys: [
                { title: '权限', dataIndex: 'permissions', width: 100 },
                { title: '所有者', dataIndex: 'owner', width: 80 },
                { title: '大小', dataIndex: 'size', width: 80 },
                { title: '文件名', dataIndex: 'filename', render: (v: string, r: any) => r.danger ? <Text type="danger" strong>{v}</Text> : v },
                { title: '类型', dataIndex: 'type', width: 120 },
                { title: '完整路径', dataIndex: 'fullPath', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                {
                    title: '操作',
                    key: 'action',
                    width: 80,
                    render: (_: any, record: any) => (
                        <Button
                            type="link"
                            size="small"
                            icon={<FileSearchOutlined />}
                            onClick={() => {
                                if (onNavigate) {
                                    // 设置文件路径并跳转到文件管理器
                                    setFilePath(record.fullPath || '/root/.ssh');
                                    onNavigate('file_manager');
                                }
                            }}
                        >
                            跳转
                        </Button>
                    )
                },
            ],
            service_list: [
                { title: '服务名', dataIndex: 'unit', ellipsis: true },
                { title: '来源', dataIndex: 'source', width: 90 },
                { title: '加载', dataIndex: 'load', width: 70, render: (v: string) => <Tag color={v === 'loaded' ? 'green' : 'orange'}>{v}</Tag> },
                { title: '状态', dataIndex: 'active', width: 70, render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v}</Tag> },
                { title: '子状态', dataIndex: 'sub', width: 80 },
                { title: '描述', dataIndex: 'description', ellipsis: true },
            ],
            win_security_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: 'ID', dataIndex: 'id', width: 80 },
                { title: '具体消息', dataIndex: 'content', ellipsis: true },
            ],
            win_system_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: 'ID', dataIndex: 'id', width: 80 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            win_app_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: 'ID', dataIndex: 'id', width: 80 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            win_powershell_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: 'ID', dataIndex: 'id', width: 80 },
                { title: '消息内容', dataIndex: 'content', ellipsis: true },
            ],
            registry: [
                { title: '区域', dataIndex: 'section', width: 120, render: (v: string) => <Tag color="blue">{v}</Tag> },
                { title: '名称', dataIndex: 'name', width: 150 },
                { title: '命令', dataIndex: 'command', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            ],
            win_defender: [
                { title: 'Item', dataIndex: 'element', width: 260, ellipsis: true },
                {
                    title: 'Status',
                    dataIndex: 'status',
                    width: 140,
                    render: (v: string) => v === 'true' || v === 'True'
                        ? <Tag color="green">Enabled</Tag>
                        : (v === 'false' || v === 'False' ? <Tag color="red">Disabled</Tag> : '-')
                },
                { title: 'Value', dataIndex: 'value', ellipsis: true },
            ],
            persistence: [
                { title: 'Type', dataIndex: 'type', width: 130, filters: [{ text: 'Task', value: 'Task' }, { text: 'Service', value: 'Service' }, { text: 'Startup', value: 'Startup' }], onFilter: (v: any, r: any) => r.type?.includes(v) },
                { title: 'Name', dataIndex: 'name', width: 260, ellipsis: true },
                { title: 'Status', dataIndex: 'status', width: 110 },
                { title: 'Action / Path', dataIndex: 'detail', width: 320, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: 'Trigger', dataIndex: 'trigger', width: 220, ellipsis: true },
                { title: 'User', dataIndex: 'user', width: 160, ellipsis: true },
                { title: 'Location', dataIndex: 'location', width: 220, ellipsis: true },
            ],
            rdp: [
                { title: 'Type', dataIndex: 'type', width: 110 },
                { title: 'Local', dataIndex: 'local', width: 180, ellipsis: true },
                { title: 'Remote', dataIndex: 'remote', width: 180, ellipsis: true },
                { title: 'State', dataIndex: 'state', width: 120, render: (v: string) => <Tag color={v === 'Established' || v === 'Running' ? 'red' : 'blue'}>{v}</Tag> },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: 'Process', dataIndex: 'process', width: 150, ellipsis: true },
                { title: 'Name', dataIndex: 'name', width: 220, ellipsis: true },
                { title: 'Detail', dataIndex: 'detail', ellipsis: true },
            ],
            browser: [
                { title: 'Browser', dataIndex: 'name', width: 120 },
                { title: 'Profile', dataIndex: 'profile', width: 140, ellipsis: true },
                { title: 'Profile Path', dataIndex: 'value', width: 360, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: 'Profile Updated', dataIndex: 'lastWriteTime', width: 170 },
                { title: 'History Path', dataIndex: 'historyPath', width: 360, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: 'History Updated', dataIndex: 'historyLastWriteTime', width: 170 },
                { title: 'Status', dataIndex: 'status', width: 110 },
            ],
            startup: [
                { title: '服务名', dataIndex: 'unit', ellipsis: true },
                { title: '来源', dataIndex: 'source', width: 90 },
                { title: '状态', dataIndex: 'state', width: 100, render: (v: string) => <Tag color={v === 'enabled' ? 'green' : v === 'disabled' ? 'red' : 'orange'}>{v}</Tag> },
                { title: '预设', dataIndex: 'preset', width: 80 },
                { title: '命令/路径', dataIndex: 'command', width: 260, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v || '-'}</Text> },
                { title: '描述', dataIndex: 'description', ellipsis: true },
            ],
            cron: osType === 'Windows' ? [
                { title: '任务路径', dataIndex: 'taskPath', width: 220, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: '任务名称', dataIndex: 'taskName', width: 180, ellipsis: true },
                { title: '状态', dataIndex: 'state', width: 90, render: (v: string) => <Tag color={v === 'Ready' || v === 'Running' ? 'green' : v === 'Disabled' ? 'default' : 'orange'}>{v}</Tag> },
                { title: '动作', dataIndex: 'actions', width: 260, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: '触发器', dataIndex: 'triggers', width: 260, ellipsis: true },
                { title: '上次运行', dataIndex: 'lastRunTime', width: 160 },
                { title: '下次运行', dataIndex: 'nextRunTime', width: 160 },
                { title: '结果', dataIndex: 'lastResult', width: 90 },
                { title: '作者', dataIndex: 'author', width: 180, ellipsis: true },
            ] : [
                { title: '来源', dataIndex: 'source', width: 130, ellipsis: true },
                { title: '类型', dataIndex: 'type', width: 120 },
                { title: '用户', dataIndex: 'user', width: 100 },
                { title: '执行周期', dataIndex: 'schedule', width: 150 },
                { title: '任务', dataIndex: 'unit', width: 170, ellipsis: true },
                { title: '激活目标', dataIndex: 'activates', width: 170, ellipsis: true },
                { title: '命令', dataIndex: 'command', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v || '-'}</Text> },
            ],
            history_cmd: [
                { title: '#', dataIndex: 'index', width: 60 },
                { title: '命令', dataIndex: 'command' },
            ],
            installed_software: [
                { title: '状态', dataIndex: 'status', width: 90 },
                { title: '软件名', dataIndex: 'name', width: 220, ellipsis: true },
                { title: '版本', dataIndex: 'version', width: 120, ellipsis: true },
                { title: '发布者', dataIndex: 'publisher', width: 180, ellipsis: true },
                { title: '大小', dataIndex: 'size', width: 100 },
                { title: '安装日期', dataIndex: 'date', width: 120 },
                { title: '安装路径', dataIndex: 'installLocation', width: 260, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
                { title: '卸载命令', dataIndex: 'uninstallCommand', width: 260, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            ],
            docker: [
                {
                    title: 'ID', dataIndex: 'container_id', width: 90,
                    render: (v: string) => <Text code style={{ fontSize: 11 }}>{v || '-'}</Text>
                },
                { title: '镜像', dataIndex: 'image', width: 150, ellipsis: true },
                {
                    title: '状态', dataIndex: 'status', width: 80,
                    render: (v: string) => (
                        <Tag
                            color={
                                v?.includes('Up') ? 'green'
                                    : /installed/i.test(v || '') ? 'blue'
                                        : /running/i.test(v || '') ? 'green'
                                            : /stopped/i.test(v || '') ? 'orange'
                                                : 'red'
                            }
                            style={{ fontSize: 11, margin: 0 }}
                        >
                            {/installed/i.test(v || '')
                                ? '已安装'
                                : /running/i.test(v || '') || v?.includes('Up')
                                    ? '运行中'
                                    : /stopped/i.test(v || '')
                                        ? '已停止'
                                        : '需处理'}
                        </Tag>
                    )
                },
                {
                    title: '名称', dataIndex: 'names', width: 120,
                    render: (v: string) => <Text style={{ fontSize: 12 }}>{v}</Text>
                },
                { title: '端口', dataIndex: 'ports', ellipsis: true },
                {
                    title: '操作', key: 'action', width: 70, fixed: 'right' as const,
                    render: (_: any, record: any) => record.isContainerRecord ? (
                        <Dropdown menu={{ items: getDockerContextMenu(record) }} trigger={['click']}>
                            <Button size="small" type="text" icon={<MoreOutlined />} />
                        </Dropdown>
                    ) : null
                },
            ],
            docker_images: [
                { title: '仓库', dataIndex: 'repository', ellipsis: true },
                { title: '标签', dataIndex: 'tag', width: 100 },
                { title: '镜像ID', dataIndex: 'image_id', width: 100 },
                { title: '大小', dataIndex: 'size', width: 100 },
                { title: '创建时间', dataIndex: 'created', width: 180 },
            ],
            database: [
                { title: '来源', dataIndex: 'source', width: 80 },
                { title: '类型', dataIndex: 'type', width: 130 },
                {
                    title: '名称', dataIndex: 'name', width: 180, ellipsis: true, render: (v: string) => (
                        <Tag color="blue">{v}</Tag>
                    )
                },
                {
                    title: '状态', dataIndex: 'status', width: 100, render: (v: string, r: any) => (
                        <Tag color={r.statusColor}>{v}</Tag>
                    )
                },
                { title: '端口', dataIndex: 'port', width: 90 },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '说明', dataIndex: 'version', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'path', width: 260, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v || '-'}</Text> },
                { title: '详情', dataIndex: 'detail', width: 260, ellipsis: true },
            ],
            auth_log: [
                { title: '时间', dataIndex: 'time', width: 150 },
                { title: '主机', dataIndex: 'host', width: 120 },
                { title: '进程', dataIndex: 'process', width: 140 },
                {
                    title: '内容', dataIndex: 'message', ellipsis: true,
                    render: (v: string) => {
                        const lower = v?.toLowerCase() || '';
                        let color = 'inherit';
                        if (lower.includes('error') || lower.includes('failed') || lower.includes('failure')) color = '#ff4d4f';
                        else if (lower.includes('warning') || lower.includes('warn')) color = '#faad14';
                        else if (lower.includes('accepted') || lower.includes('success')) color = '#52c41a';
                        return <span style={{ color }}>{v}</span>;
                    }
                },
            ],
            syslog: [
                { title: '时间', dataIndex: 'time', width: 150 },
                {
                    title: '内容', dataIndex: 'content', ellipsis: true,
                    render: (v: string) => {
                        const lower = v?.toLowerCase() || '';
                        let color = 'inherit';
                        if (lower.includes('error') || lower.includes('failed') || lower.includes('critical')) color = '#ff4d4f';
                        else if (lower.includes('warning') || lower.includes('warn')) color = '#faad14';
                        return <span style={{ color }}>{v}</span>;
                    }
                },
            ],
            dmesg: [
                { title: '时间', dataIndex: 'time', width: 150 },
                {
                    title: '内容', dataIndex: 'content', ellipsis: true,
                    render: (v: string) => {
                        const lower = v?.toLowerCase() || '';
                        let color = 'inherit';
                        if (lower.includes('error') || lower.includes('fail')) color = '#ff4d4f';
                        else if (lower.includes('warning') || lower.includes('warn')) color = '#faad14';
                        return <span style={{ color }}>{v}</span>;
                    }
                },
            ],
            cron_log: [
                { title: '时间', dataIndex: 'time', width: 150 },
                {
                    title: '内容', dataIndex: 'content', ellipsis: true,
                    render: (v: string) => {
                        const lower = v?.toLowerCase() || '';
                        let color = 'inherit';
                        if (lower.includes('error') || lower.includes('failed')) color = '#ff4d4f';
                        return <span style={{ color }}>{v}</span>;
                    }
                },
            ],
            failed_logins: [
                { title: '时间', dataIndex: 'time', width: 150 },
                {
                    title: '用户', dataIndex: 'user', width: 100, render: (v: string) => (
                        <Text type="danger">{v}</Text>
                    )
                },
                { title: 'IP', dataIndex: 'ip', width: 150 },
                { title: '详情', dataIndex: 'content', ellipsis: true },
            ],
            login_history: [
                {
                    title: '用户', dataIndex: 'user', width: 100, render: (v: string) => (
                        <Tag color="blue">{v}</Tag>
                    )
                },
                { title: '终端', dataIndex: 'terminal', width: 80 },
                { title: 'IP地址', dataIndex: 'ip', width: 130 },
                { title: '登录时间', dataIndex: 'time', width: 180 },
                { title: '时长/状态', dataIndex: 'duration', ellipsis: true },
            ],
            lastlog: [
                {
                    title: '用户', dataIndex: 'user', width: 120, render: (v: string) => (
                        <Tag color="blue">{v}</Tag>
                    )
                },
                { title: '终端', dataIndex: 'port', width: 80 },
                { title: '来源', dataIndex: 'from', width: 150 },
                { title: '最后登录时间', dataIndex: 'latest', ellipsis: true },
            ],
            web_access_log: [
                { title: 'IP', dataIndex: 'ip', width: 130 },
                { title: '时间', dataIndex: 'time', width: 180 },
                {
                    title: '方法', dataIndex: 'method', width: 70, render: (v: string) => (
                        <Tag color={v === 'GET' ? 'green' : v === 'POST' ? 'blue' : 'orange'}>{v}</Tag>
                    )
                },
                { title: '路径', dataIndex: 'path', ellipsis: true },
                {
                    title: '状态', dataIndex: 'status', width: 70, render: (v: string) => (
                        <Tag color={v?.startsWith('2') ? 'green' : v?.startsWith('3') ? 'blue' : v?.startsWith('4') ? 'orange' : 'red'}>{v}</Tag>
                    )
                },
                { title: '大小', dataIndex: 'size', width: 80 },
                { title: 'Referer', dataIndex: 'referer', width: 180, ellipsis: true },
                { title: 'UA', dataIndex: 'user_agent', width: 260, ellipsis: true },
            ],
            sudo_log: [
                { title: '时间', dataIndex: 'time', width: 150 },
                {
                    title: '用户', dataIndex: 'user', width: 100, render: (v: string) => (
                        <Tag color="orange">{v}</Tag>
                    )
                },
                { title: '工作目录', dataIndex: 'cwd', width: 180, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
                { title: '目标用户', dataIndex: 'targetUser', width: 100 },
                {
                    title: '命令', dataIndex: 'command', ellipsis: true, render: (v: string) => (
                        <Text code style={{ fontSize: 12 }}>{v}</Text>
                    )
                },
            ],
            recent_files: [
                { title: '文件名', dataIndex: 'name', ellipsis: true },
                { title: '最后访问时间', dataIndex: 'lastAccess', width: 180 },
            ],
            hosts_file: [
                { title: 'IP地址', dataIndex: 'ip', width: 180 },
                { title: '主机名', dataIndex: 'hostname', ellipsis: true },
            ],
            dns_config: [
                { title: '网络接口', dataIndex: 'interface', width: 200 },
                { title: 'DNS服务器', dataIndex: 'dns', ellipsis: true },
            ],
            env_vars: [
                { title: '变量名', dataIndex: 'name', width: 200 },
                { title: '值', dataIndex: 'value', ellipsis: true },
            ],
            ulimit_config: [
                { title: '限制项', dataIndex: 'name', width: 250 },
                { title: '类型', dataIndex: 'type', width: 100 },
                { title: '值', dataIndex: 'value', width: 120 },
            ],
            network_conn: osType === 'Windows' ? [
                {
                    title: '协议', dataIndex: 'protocol', width: 70, render: (v: string) => (
                        <Tag color={v === 'TCP' ? 'blue' : 'green'}>{v}</Tag>
                    )
                },
                {
                    title: '状态', dataIndex: 'state', width: 110, render: (v: string) => (
                        <Tag color={v === 'Established' ? 'green' : v === 'Listen' ? 'blue' : 'orange'}>{v}</Tag>
                    )
                },
                { title: '本地地址', dataIndex: 'local', ellipsis: true },
                { title: '远程地址', dataIndex: 'peer', ellipsis: true },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '进程', dataIndex: 'process', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'processPath', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            ] : [
                {
                    title: '协议', dataIndex: 'protocol', width: 60, render: (v: string) => (
                        <Tag color={v === 'tcp' ? 'blue' : 'green'}>{v}</Tag>
                    )
                },
                {
                    title: '状态', dataIndex: 'state', width: 100, render: (v: string) => (
                        <Tag color={v === 'ESTAB' ? 'green' : v === 'LISTEN' ? 'blue' : 'orange'}>{v}</Tag>
                    )
                },
                { title: '接收', dataIndex: 'recv', width: 60 },
                { title: '发送', dataIndex: 'send', width: 60 },
                { title: '本地地址', dataIndex: 'local', ellipsis: true },
                { title: '远程地址', dataIndex: 'peer', ellipsis: true },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '进程', dataIndex: 'process', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'processPath', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            ],
        };

        // 自动为所有列添加排序功能
        columnConfigs.security_events = [
            { title: 'Event ID', dataIndex: 'eventId', width: 90 },
            { title: 'Time', dataIndex: 'timeCreated', width: 170 },
            { title: 'Type', dataIndex: 'eventType', width: 180, ellipsis: true },
            { title: 'User', dataIndex: 'username', width: 130, ellipsis: true },
            { title: 'Source IP', dataIndex: 'sourceIp', width: 150 },
            { title: 'Logon Type', dataIndex: 'logonType', width: 100 },
            { title: 'Status', dataIndex: 'status', width: 120 },
            {
                title: 'Risk',
                dataIndex: 'suspicious',
                width: 90,
                render: (v: boolean) => <Tag color={v ? 'red' : 'green'}>{v ? 'Suspicious' : 'Normal'}</Tag>,
            },
            { title: 'Description', dataIndex: 'description', ellipsis: true },
        ];

        columnConfigs.file_scan = [
            { title: 'Category', dataIndex: 'category', width: 190 },
            {
                title: 'Risk',
                dataIndex: 'risk',
                width: 90,
                render: (v: string) => <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>,
            },
            { title: 'File', dataIndex: 'name', width: 180, ellipsis: true },
            { title: 'Directory', dataIndex: 'directory', width: 260, ellipsis: true },
            { title: 'Size', dataIndex: 'size', width: 100 },
            { title: 'Modified', dataIndex: 'lastModified', width: 170 },
            { title: 'Path', dataIndex: 'path', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Note', dataIndex: 'note', width: 220, ellipsis: true },
        ];

        const windowsDfirColumns: any[] = [
            { title: 'Category', dataIndex: 'category', width: 150, ellipsis: true },
            { title: 'Source', dataIndex: 'source', width: 170, ellipsis: true },
            {
                title: 'Risk',
                dataIndex: 'risk',
                width: 90,
                render: (v: string) => <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v || 'info'}</Tag>,
            },
            { title: 'Status', dataIndex: 'status', width: 110, ellipsis: true },
            { title: 'Time', dataIndex: 'time', width: 170 },
            { title: 'Event ID', dataIndex: 'eventId', width: 90 },
            { title: 'Name', dataIndex: 'name', width: 220, ellipsis: true },
            { title: 'User', dataIndex: 'user', width: 130, ellipsis: true },
            { title: 'IP', dataIndex: 'ip', width: 140 },
            { title: 'Path', dataIndex: 'path', width: 320, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];
        ['execution_trace', 'powershell_deep', 'defender_history', 'rdp_logon_trace', 'wmi_persistence', 'bits_jobs', 'registry_persistence_deep']
            .forEach((dfirKey) => { columnConfigs[dfirKey] = windowsDfirColumns; });

        const addSorter = (columns: any[]) => columns.map(col => ({
            ...col,
            sorter: (a: any, b: any) => {
                const valA = a[col.dataIndex];
                const valB = b[col.dataIndex];
                // 数字排序
                if (typeof valA === 'number' && typeof valB === 'number') {
                    return valA - valB;
                }
                // 布尔值排序
                if (typeof valA === 'boolean') {
                    return valA === valB ? 0 : valA ? -1 : 1;
                }
                // 字符串排序（处理数字字符串如UID）
                const numA = parseFloat(valA);
                const numB = parseFloat(valB);
                if (!isNaN(numA) && !isNaN(numB)) {
                    return numA - numB;
                }
                // 普通字符串排序
                return String(valA || '').localeCompare(String(valB || ''));
            },
        }));

        columnConfigs.firewall = [
            { title: 'Source', dataIndex: 'source', width: 110 },
            { title: 'Chain', dataIndex: 'chain', width: 120 },
            {
                title: 'Action', dataIndex: 'action', width: 100, render: (v: string) => (
                    <Tag color={v === 'DROP' || v === 'REJECT' ? 'red' : v === 'ACCEPT' || v === 'ALLOW' ? 'green' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Protocol', dataIndex: 'protocol', width: 90 },
            { title: 'From', dataIndex: 'from', width: 160, ellipsis: true },
            { title: 'To', dataIndex: 'to', width: 160, ellipsis: true },
            { title: 'Port', dataIndex: 'port', width: 100 },
            { title: 'Options', dataIndex: 'options', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];

        const shellConfigColumns = [
            { title: 'Source', dataIndex: 'source', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 130 },
            {
                title: 'Risk', dataIndex: 'risk', width: 100, render: (v: string) => (
                    <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Note', dataIndex: 'note', width: 150 },
            { title: 'Target', dataIndex: 'target', width: 220, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Command', dataIndex: 'command', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];
        columnConfigs.bashrc_check = shellConfigColumns;
        columnConfigs.profile_check = shellConfigColumns;
        columnConfigs.selinux_status = [
            { title: 'Source', dataIndex: 'source', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 150 },
            { title: 'Value', dataIndex: 'target', width: 220, ellipsis: true },
            { title: 'Risk', dataIndex: 'risk', width: 100, render: (v: string) => <Tag color={v === 'warning' ? 'orange' : 'blue'}>{v}</Tag> },
            { title: 'Note', dataIndex: 'note', width: 150 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];
        columnConfigs.pam_config = [
            { title: 'Service', dataIndex: 'service', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 90 },
            { title: 'Control', dataIndex: 'control', width: 110 },
            { title: 'Module', dataIndex: 'module', width: 220, ellipsis: true },
            { title: 'Options', dataIndex: 'options', ellipsis: true },
            {
                title: 'Risk', dataIndex: 'risk', width: 100, render: (v: string) => (
                    <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Note', dataIndex: 'note', width: 150 },
        ];
        columnConfigs.sudoers_config = [
            { title: 'Source', dataIndex: 'source', width: 120 },
            { title: 'Principal', dataIndex: 'principal', width: 150 },
            { title: 'Host', dataIndex: 'host', width: 100 },
            { title: 'Run As', dataIndex: 'runAs', width: 130 },
            { title: 'Tag', dataIndex: 'tag', width: 120 },
            { title: 'Risk', dataIndex: 'risk', width: 130, render: (v: string) => <Tag color={v === 'nopasswd' || v === 'all-commands' ? 'orange' : 'blue'}>{v}</Tag> },
            { title: 'Command', dataIndex: 'command', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];
        columnConfigs.sudo_config = columnConfigs.sudoers_config;
        columnConfigs.win_firewall = [
            { title: 'Profile', dataIndex: 'profile', width: 140 },
            { title: 'Setting', dataIndex: 'setting', width: 220, ellipsis: true },
            { title: 'Value', dataIndex: 'value', ellipsis: true },
            {
                title: 'Raw',
                dataIndex: 'raw',
                ellipsis: true,
                render: (v: string) => (
                    <Text code className="windows-table-code" style={{ fontSize: 11 }}>
                        {v}
                    </Text>
                ),
            },
        ];

        columnConfigs.recent_files = osType === 'Windows' ? [
            { title: 'File', dataIndex: 'name', ellipsis: true },
            { title: 'Last Access', dataIndex: 'lastAccess', width: 180 },
            { title: 'Path', dataIndex: 'path', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Target Path', dataIndex: 'targetPath', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ] : [
            { title: 'File', dataIndex: 'name', width: 180, ellipsis: true },
            { title: 'Path', dataIndex: 'path', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Directory', dataIndex: 'directory', width: 220, ellipsis: true },
            {
                title: 'Category', dataIndex: 'category', width: 120, render: (v: string) => (
                    <Tag color={v === 'sensitive' ? 'red' : v === 'temporary' ? 'orange' : v === 'webroot' ? 'gold' : 'blue'}>{v}</Tag>
                )
            },
            {
                title: 'Risk', dataIndex: 'risk', width: 90, render: (v: string) => (
                    <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Note', dataIndex: 'note', width: 180, ellipsis: true },
        ];
        columnConfigs.dns_config = osType === 'Windows' ? [
            { title: 'Interface', dataIndex: 'interface', width: 200 },
            { title: 'DNS Servers', dataIndex: 'dns', ellipsis: true },
        ] : [
            { title: 'Source', dataIndex: 'source', width: 160 },
            {
                title: 'Type', dataIndex: 'type', width: 140, render: (v: string) => (
                    <Tag color={v === 'resolver' ? 'green' : v === 'resolver-option' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Value', dataIndex: 'value', width: 240, ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.hosts_file = [
            { title: 'IP Address', dataIndex: 'ip', width: 180 },
            { title: 'Hostname', dataIndex: 'hostname', ellipsis: true },
            {
                title: 'Risk', dataIndex: 'risk', width: 90, render: (v: string) => (
                    <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Note', dataIndex: 'note', width: 220, ellipsis: true },
        ];
        columnConfigs.ulimit_config = [
            { title: 'Source', dataIndex: 'source', width: 120 },
            { title: 'Domain', dataIndex: 'domain', width: 120 },
            { title: 'Limit', dataIndex: 'name', width: 180 },
            { title: 'Type', dataIndex: 'type', width: 100 },
            { title: 'Value', dataIndex: 'value', width: 140 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];

        const logColumns = [
            { title: 'Time', dataIndex: 'time', width: 190 },
            { title: 'Source', dataIndex: 'source', width: 100 },
            {
                title: 'Severity', dataIndex: 'severity', width: 100, render: (v: string) => (
                    <Tag color={v === 'error' ? 'red' : v === 'warning' ? 'orange' : v === 'success' ? 'green' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Host', dataIndex: 'host', width: 120 },
            { title: 'Process', dataIndex: 'process', width: 140 },
            { title: 'Message', dataIndex: 'message', ellipsis: true },
        ];
        columnConfigs.auth_log = logColumns;
        columnConfigs.syslog = logColumns;
        columnConfigs.dmesg = logColumns;
        columnConfigs.cron_log = logColumns;
        columnConfigs.login_history = [
            { title: 'User', dataIndex: 'user', width: 120 },
            { title: 'Terminal', dataIndex: 'terminal', width: 110 },
            { title: 'IP', dataIndex: 'ip', width: 150 },
            { title: 'Login', dataIndex: 'login_time', width: 190 },
            { title: 'Logout', dataIndex: 'logout_time', width: 190 },
            {
                title: 'State', dataIndex: 'state', width: 100, render: (v: string) => (
                    <Tag color={v === 'active' ? 'green' : v === 'crash' ? 'red' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Duration', dataIndex: 'duration', width: 130 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.env_vars = [
            { title: 'Name', dataIndex: 'name', width: 220 },
            {
                title: 'Risk', dataIndex: 'risk', width: 100, render: (v: string) => (
                    <Tag color={v === 'high' ? 'red' : v === 'warning' ? 'orange' : 'blue'}>{v}</Tag>
                )
            },
            { title: 'Category', dataIndex: 'category', width: 150 },
            { title: 'Note', dataIndex: 'note', width: 190 },
            { title: 'Value', dataIndex: 'value', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
        ];

        const tableColumnKey = moduleKey === 'software' ? 'installed_software' : moduleKey;
        const baseColumns = columnConfigs[tableColumnKey] || [{ title: '内容', dataIndex: 'content' }];
        const windowsTitleMap = isWindowsLocalMode ? windowsLocalColumnTitles[moduleKey] || windowsLocalColumnTitles[tableColumnKey] : undefined;
        const baseColumnsWithActions = tableColumnKey === 'database' && isWindowsLocalMode
            ? [
                ...baseColumns,
                {
                    title: '\u64cd\u4f5c',
                    key: 'windowsDatabaseAction',
                    width: 110,
                    fixed: 'right' as const,
                    render: (_: unknown, record: unknown) => {
                        const instance = buildWindowsDatabaseInstance(record);
                        return instance && instance.credentialMode !== 'unavailable' ? (
                            <Button
                                size="small"
                                icon={<EyeOutlined />}
                                aria-label={WINDOWS_DATABASE_DETAIL_LABEL}
                                title={WINDOWS_DATABASE_DETAIL_LABEL}
                                onClick={() => handleOpenWindowsDatabaseWorkbench(record)}
                            >
                                {WINDOWS_DATABASE_DETAIL_LABEL}
                            </Button>
                        ) : null;
                    },
                },
            ]
            : baseColumns;
        const displayColumns = windowsTitleMap
            ? baseColumnsWithActions.map((col: any) => ({
                ...col,
                title: typeof col.dataIndex === 'string' ? (windowsTitleMap[col.dataIndex] || col.title) : col.title,
            }))
            : baseColumnsWithActions;
        const allCols = addSorter(displayColumns);
        const visibleColumns = allCols.filter((col: any) => !hiddenColumns.includes(col.dataIndex as string));

        // 根据搜索关键字过滤数据
        const filteredData = getFilteredTableData(tableData);
        const isWindowsPagedLogTable = isWindowsLocalMode
            && (Boolean(windowsEventLogModuleNames[tableColumnKey]) || tableColumnKey === 'security_events')
            && Boolean(windowsLogPageInfo);
        const tablePagination = isWindowsPagedLogTable
            ? {
                current: windowsLogPageInfo?.page ?? 1,
                pageSize: windowsLogPageInfo?.pageSize ?? WINDOWS_EVENT_LOG_DEFAULT_PAGE_SIZE,
                total: windowsLogPageInfo?.totalCount ?? filteredData.length,
                showSizeChanger: true,
                pageSizeOptions: ['20', '50', '100', '200', '500'],
                showTotal: (total: number) => `共 ${total} 条日志`,
                showQuickJumper: true,
                size: isModuleWorkbenchMode ? 'small' as const : 'default' as const,
                onChange: (page: number, pageSize: number) => {
                    if (collectionArtifact?.path) {
                        void loadWindowsArtifactPage(page, pageSize);
                    } else {
                        void loadData({ windowsLogPage: page, windowsLogPageSize: pageSize });
                    }
                },
            }
            : {
                defaultPageSize: 50,
                showSizeChanger: true,
                pageSizeOptions: ['20', '50', '100', '200', '500'],
                showTotal: (total: number) => `共 ${total} 条`,
                showQuickJumper: true,
                size: isModuleWorkbenchMode ? 'small' as const : 'default' as const,
            };

        return (
            <Table
                className={isModuleWorkbenchMode ? 'windows-module-table' : undefined}
                dataSource={filteredData}
                columns={visibleColumns}
                size="small"
                scroll={isModuleWorkbenchMode ? { x: 1200, y: 520 } : { y: 500 }}
                pagination={tablePagination}
                virtual
            />
        );
    };

    // 获取当前模块的所有列配置（用于列设置弹窗）
    const getAllColumns = () => {
        const columnConfigs: Record<string, any[]> = {
            process_list: [
                { title: '用户', dataIndex: 'user' },
                { title: 'PID', dataIndex: 'pid' },
                { title: 'CPU%', dataIndex: 'cpu' },
                { title: 'MEM%', dataIndex: 'mem' },
                { title: '命令', dataIndex: 'command' },
            ],
            user_list: [
                { title: '用户名', dataIndex: 'username', width: 150 },
                { title: '类型', dataIndex: 'userType', width: 100, filters: [{text:'root', value:'root'}, {text:'普通用户', value:'普通用户'}, {text:'系统用户', value:'系统用户'}, {text:'服务账户', value:'服务账户'}], onFilter: (v:any, r:any) => r.userType === v, render: (t:string, r:any) => <Tag color={r.userTypeColor || 'default'}>{t}</Tag> },
                { title: 'UID', dataIndex: 'uid', width: 80 },
                { title: 'GID', dataIndex: 'gid', width: 80 },
                { title: '主目录', dataIndex: 'home', ellipsis: true },
                { title: 'Shell', dataIndex: 'shell', width: 150 },
            ],
            logged_users: [
                { title: '用户', dataIndex: 'user', width: 120 },
                { title: '会话', dataIndex: 'terminal', width: 120 },
                { title: '会话ID', dataIndex: 'sessionId', width: 90 },
                { title: '状态', dataIndex: 'state', width: 100 },
                { title: '空闲时间', dataIndex: 'idleTime', width: 100 },
                { title: '登录IP', dataIndex: 'ip', width: 150 },
                { title: '登录时间', dataIndex: 'login_time', width: 180 },
                { title: '时长', dataIndex: 'duration', width: 120 },
                { title: '来源', dataIndex: 'source', width: 100 },
            ],
            service_list: [
                { title: '服务名', dataIndex: 'unit', width: 200, ellipsis: true },
                { title: '来源', dataIndex: 'source', width: 90 },
                { title: '加载', dataIndex: 'load', width: 100 },
                { title: '状态', dataIndex: 'active', width: 100, filters: [{text:'active', value:'active'}, {text:'inactive', value:'inactive'}, {text:'failed', value:'failed'}], onFilter: (v:any, r:any) => r.active === v },
                { title: '子状态', dataIndex: 'sub', width: 100 },
                { title: '描述', dataIndex: 'description', ellipsis: true },
            ],
            startup: [
                { title: '服务名', dataIndex: 'unit', width: 250, ellipsis: true },
                { title: '来源', dataIndex: 'source', width: 90 },
                { title: '状态', dataIndex: 'state', width: 100, filters: [{text:'enabled', value:'enabled'}, {text:'disabled', value:'disabled'}], onFilter: (v:any, r:any) => r.state === v },
                { title: '预设', dataIndex: 'preset', width: 100 },
                { title: '命令/路径', dataIndex: 'command', width: 260, ellipsis: true },
                { title: '描述', dataIndex: 'description', width: 260, ellipsis: true },
            ],
            cron: osType === 'Windows' ? [
                { title: '任务路径', dataIndex: 'taskPath', width: 220, ellipsis: true },
                { title: '任务名称', dataIndex: 'taskName', width: 180, ellipsis: true },
                { title: '状态', dataIndex: 'state', width: 90 },
                { title: '动作', dataIndex: 'actions', width: 260, ellipsis: true },
                { title: '触发器', dataIndex: 'triggers', width: 260, ellipsis: true },
                { title: '上次运行', dataIndex: 'lastRunTime', width: 160 },
                { title: '下次运行', dataIndex: 'nextRunTime', width: 160 },
                { title: '结果', dataIndex: 'lastResult', width: 90 },
                { title: '作者', dataIndex: 'author', width: 180, ellipsis: true },
                { title: '描述', dataIndex: 'description', width: 260, ellipsis: true },
            ] : [
                { title: '来源', dataIndex: 'source', width: 130, ellipsis: true },
                { title: '类型', dataIndex: 'type', width: 120 },
                { title: '用户', dataIndex: 'user', width: 100 },
                { title: '定时表达式', dataIndex: 'schedule', width: 150 },
                { title: '任务', dataIndex: 'unit', width: 170, ellipsis: true },
                { title: '激活目标', dataIndex: 'activates', width: 170, ellipsis: true },
                { title: '命令', dataIndex: 'command', ellipsis: true },
            ],
            disk_info: [
                { title: '分区', dataIndex: 'partition', width: 150 },
                { title: '总容量', dataIndex: 'total', width: 120, sorter: (a:any, b:any) => parseFloat(a.total) - parseFloat(b.total) },
                { title: '已用', dataIndex: 'used', width: 120, sorter: (a:any, b:any) => parseFloat(a.used) - parseFloat(b.used) },
                { title: '可用', dataIndex: 'available', width: 120, sorter: (a:any, b:any) => parseFloat(a.available) - parseFloat(b.available) },
                { title: '使用率', dataIndex: 'percent', width: 100, sorter: (a:any, b:any) => parseInt(a.percent) - parseInt(b.percent) },
                { title: '挂载点', dataIndex: 'mount', ellipsis: true },
            ],
            installed_software: [
                { title: '软件名称', dataIndex: 'name', width: 250, ellipsis: true },
                { title: '版本', dataIndex: 'version', width: 150, ellipsis: true },
                { title: '发行商', dataIndex: 'publisher', width: 200, ellipsis: true },
                { title: '安装日期', dataIndex: 'date', width: 120 },
                { title: '大小', dataIndex: 'size', width: 100 },
                { title: '安装路径', dataIndex: 'installLocation', width: 260, ellipsis: true },
                { title: '卸载命令', dataIndex: 'uninstallCommand', width: 260, ellipsis: true },
                { title: '信息链接', dataIndex: 'infoUrl', width: 220, ellipsis: true },
            ],
            docker: [
                { title: '容器ID', dataIndex: 'container_id', width: 120 },
                { title: '镜像', dataIndex: 'image', width: 200, ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 150, filters: [{text:'运行中', value:'Up'}, {text:'已停止', value:'Exited'}], onFilter: (v:any, r:any) => r.status?.includes(v) },
                { title: '端口', dataIndex: 'ports', width: 150, ellipsis: true },
                { title: '名称', dataIndex: 'names', width: 150 },
            ],
            docker_images: [
                { title: '仓库', dataIndex: 'repository', width: 200, ellipsis: true },
                { title: '标签', dataIndex: 'tag', width: 120 },
                { title: '镜像ID', dataIndex: 'image_id', width: 120 },
                { title: '创建时间', dataIndex: 'created', width: 150 },
                { title: '大小', dataIndex: 'size', width: 100, sorter: (a:any, b:any) => parseFloat(a.size) - parseFloat(b.size) },
            ],
            network_conn: [
                { title: '协议', dataIndex: 'protocol', width: 80, filters: [{text:'TCP', value:'TCP'}, {text:'UDP', value:'UDP'}], onFilter: (v:any, r:any) => r.protocol === v },
                { title: '本地地址', dataIndex: 'local', width: 180 },
                { title: '远程地址', dataIndex: 'peer', width: 180 },
                { title: '状态', dataIndex: 'state', width: 120, filters: [{text:'Established', value:'Established'}, {text:'Listen', value:'Listen'}, {text:'TimeWait', value:'TimeWait'}], onFilter: (v:any, r:any) => r.state === v },
                { title: 'PID', dataIndex: 'pid', width: 100 },
                { title: '进程', dataIndex: 'process', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'processPath', ellipsis: true },
            ],
            listen_ports: [
                { title: '端口', dataIndex: 'port', width: 100, sorter: (a:any, b:any) => parseInt(a.port) - parseInt(b.port) },
                { title: '协议', dataIndex: 'protocol', width: 80, filters: [{text:'TCP', value:'TCP'}, {text:'UDP', value:'UDP'}], onFilter: (v:any, r:any) => r.protocol === v },
                { title: '绑定地址', dataIndex: 'address', width: 150 },
                { title: 'PID', dataIndex: 'pid', width: 100 },
                { title: '进程', dataIndex: 'process', ellipsis: true },
                { title: '路径', dataIndex: 'processPath', ellipsis: true },
            ],
            recent_files: [
                { title: '文件名', dataIndex: 'name', width: 250, ellipsis: true },
                { title: '最后访问时间', dataIndex: 'lastAccess', width: 180 },
            ],
            hosts_file: [
                { title: 'IP地址', dataIndex: 'ip', width: 180 },
                { title: '主机名', dataIndex: 'hostname', ellipsis: true },
            ],
            dns_config: [
                { title: '网络接口', dataIndex: 'interface', width: 200 },
                { title: 'DNS服务器', dataIndex: 'dns', ellipsis: true },
            ],
            env_vars: [
                { title: '变量名', dataIndex: 'name', width: 200 },
                { title: '值', dataIndex: 'value', ellipsis: true },
            ],
            ssh_keys: [
                { title: '密钥文件', dataIndex: 'file', width: 200 },
                { title: '类型', dataIndex: 'type', width: 100 },
                { title: '权限', dataIndex: 'permissions', width: 100 },
                { title: '大小', dataIndex: 'size', width: 100 },
            ],
            history_cmd: [
                { title: '#', dataIndex: 'index', width: 80 },
                { title: '命令', dataIndex: 'command', ellipsis: true },
            ],
            registry: [
                { title: '注册表项', dataIndex: 'name', width: 200, sorter: (a:any, b:any) => a.name.localeCompare(b.name) },
                { title: '值 / 路径', dataIndex: 'command', ellipsis: true },
                { title: '位置', dataIndex: 'section', width: 100, filters: [{text:'HKLM', value:'HKLM'}, {text:'HKCU', value:'HKCU'}], onFilter: (val:any, record:any) => record.section?.includes(val) },
            ],
            win_defender: [
                { title: '检测项', dataIndex: 'element', width: 250 },
                { title: '状态', dataIndex: 'status', width: 120, render: (t:string) => t === 'True' ? <Tag color="green">开启</Tag> : (t === 'False' ? <Tag color="red">关闭</Tag> : t) },
            ],
            persistence: [
                { title: '类型', dataIndex: 'type', width: 120, filters: [{text:'Task', value:'Task'}, {text:'Service', value:'Service'}, {text:'Startup', value:'Startup'}], onFilter: (v:any, r:any) => r.type?.includes(v) },
                { title: '名称', dataIndex: 'name', width: 200, ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 100 },
                { title: '执行内容 / 路径', dataIndex: 'detail', ellipsis: true, render: (t:string) => <Text code>{t}</Text> },
            ],
            rdp: [
                { title: '类型', dataIndex: 'type', width: 100 },
                { title: '详情', dataIndex: 'local', render: (t:string, r:any) => r.type === 'Connection' ? `${r.local} -> ${r.remote}` : r.name },
                { title: '状态', dataIndex: 'state', width: 120, render: (t:string) => <Tag color={t==='Established'?'red':'blue'}>{t}</Tag> },
                { title: 'PID / 描述', dataIndex: 'detail', ellipsis: true },
            ],
            browser: [
                { title: '浏览器', dataIndex: 'name', width: 100 },
                { title: '状态', dataIndex: 'status', width: 100 },
                { title: '数据文件路径', dataIndex: 'value', ellipsis: true },
            ],
            process_anomaly: [
                { title: '异常类型', dataIndex: 'anomaly_type', width: 120, filters: [{text:'高CPU', value:'高CPU'}, {text:'异常端口', value:'异常端口'}, {text:'可疑路径', value:'可疑路径'}, {text:'异常用户', value:'异常用户'}], onFilter: (v:any, r:any) => r.anomaly_type === v },
                { title: 'PID', dataIndex: 'pid', width: 100 },
                { title: '用户', dataIndex: 'user', width: 120 },
                { title: 'CPU%', dataIndex: 'cpu', width: 80 },
                { title: 'MEM%', dataIndex: 'mem', width: 80 },
                { title: '命令', dataIndex: 'command', ellipsis: true },
                { title: '原因', dataIndex: 'reason', width: 200, ellipsis: true },
            ],
            auth_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '主机', dataIndex: 'host', width: 120 },
                { title: '进程', dataIndex: 'process', width: 120 },
                { title: '内容', dataIndex: 'message', ellipsis: true },
            ],
            failed_logins: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '用户', dataIndex: 'user', width: 120 },
                { title: 'IP地址', dataIndex: 'ip', width: 150 },
                { title: '原因', dataIndex: 'reason', ellipsis: true },
            ],
            login_history: [
                { title: '用户', dataIndex: 'user', width: 120 },
                { title: '终端', dataIndex: 'terminal', width: 100 },
                { title: '登录IP', dataIndex: 'ip', width: 150 },
                { title: '登录时间', dataIndex: 'login_time', width: 180 },
                { title: '登出时间', dataIndex: 'logout_time', width: 180 },
                { title: '会话时长', dataIndex: 'duration', width: 120 },
            ],
            web_access_log: [
                { title: 'IP地址', dataIndex: 'ip', width: 150 },
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '方法', dataIndex: 'method', width: 80, filters: [{text:'GET', value:'GET'}, {text:'POST', value:'POST'}, {text:'PUT', value:'PUT'}, {text:'DELETE', value:'DELETE'}], onFilter: (v:any, r:any) => r.method === v },
                { title: '路径', dataIndex: 'path', width: 250, ellipsis: true },
                { title: '状态码', dataIndex: 'status', width: 100, filters: [{text:'2xx', value:'2'}, {text:'3xx', value:'3'}, {text:'4xx', value:'4'}, {text:'5xx', value:'5'}], onFilter: (v:any, r:any) => r.status?.startsWith(v) },
                { title: '大小', dataIndex: 'size', width: 100 },
                { title: 'UA', dataIndex: 'user_agent', ellipsis: true },
            ],
            win_security_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '事件ID', dataIndex: 'id', width: 100 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            win_system_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '事件ID', dataIndex: 'id', width: 100 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            win_app_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '事件ID', dataIndex: 'id', width: 100 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            win_powershell_log: [
                { title: '时间', dataIndex: 'time', width: 180 },
                { title: '事件ID', dataIndex: 'id', width: 100 },
                { title: '消息', dataIndex: 'content', ellipsis: true },
            ],
            panel: [
                { title: '网站名称', dataIndex: 'name', width: 200, ellipsis: true },
                { title: '网站路径', dataIndex: 'path', width: 250, ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 100 },
                { title: '大小', dataIndex: 'size', width: 100 },
                { title: '最后修改', dataIndex: 'lastModified', width: 120 },
                { title: '绑定地址', dataIndex: 'bindings', width: 150, ellipsis: true },
                { title: '备注', dataIndex: 'ps', width: 150, ellipsis: true },
            ],
            database: [
                { title: '来源', dataIndex: 'source', width: 90 },
                { title: '名称', dataIndex: 'name', width: 180, ellipsis: true },
                { title: '类型', dataIndex: 'type', width: 130, filters: [{ text: 'SQL Server', value: 'SQL Server' }, { text: 'MySQL/MariaDB', value: 'MySQL/MariaDB' }, { text: 'PostgreSQL', value: 'PostgreSQL' }, { text: 'Redis', value: 'Redis' }, { text: 'MongoDB', value: 'MongoDB' }], onFilter: (v:any, r:any) => r.type === v },
                { title: '状态', dataIndex: 'status', width: 100 },
                { title: '端口', dataIndex: 'port', width: 90 },
                { title: 'PID', dataIndex: 'pid', width: 90 },
                { title: '说明', dataIndex: 'version', width: 160, ellipsis: true },
                { title: '路径', dataIndex: 'path', width: 260, ellipsis: true },
                { title: '详情', dataIndex: 'detail', width: 260, ellipsis: true },
            ],
        };
        // Aliases
        columnConfigs['software'] = columnConfigs['installed_software'];
        columnConfigs['syslog'] = columnConfigs['auth_log'];
        columnConfigs['dmesg'] = columnConfigs['auth_log'];
        columnConfigs['cron_log'] = columnConfigs['auth_log'];
        columnConfigs['sudo_log'] = columnConfigs['auth_log'];
        columnConfigs['lastlog'] = columnConfigs['login_history'];

        const structuredLogColumns = [
            { title: 'Time', dataIndex: 'time', width: 190 },
            { title: 'Source', dataIndex: 'source', width: 100 },
            { title: 'Severity', dataIndex: 'severity', width: 100 },
            { title: 'Host', dataIndex: 'host', width: 120 },
            { title: 'Process', dataIndex: 'process', width: 140 },
            { title: 'Message', dataIndex: 'message', ellipsis: true },
        ];
        columnConfigs['auth_log'] = structuredLogColumns;
        columnConfigs['syslog'] = structuredLogColumns;
        columnConfigs['dmesg'] = structuredLogColumns;
        columnConfigs['cron_log'] = structuredLogColumns;
        columnConfigs['sudo_log'] = [
            { title: 'Time', dataIndex: 'time', width: 190 },
            { title: 'Host', dataIndex: 'host', width: 120 },
            { title: 'Process', dataIndex: 'process', width: 140 },
            { title: 'User', dataIndex: 'user', width: 120 },
            { title: 'CWD', dataIndex: 'cwd', width: 180 },
            { title: 'Target User', dataIndex: 'targetUser', width: 120 },
            { title: 'Command', dataIndex: 'command', ellipsis: true },
        ];

        columnConfigs['process_anomaly'] = [
            { title: 'Type', dataIndex: 'type', width: 130 },
            { title: 'PID', dataIndex: 'pid', width: 90 },
            { title: 'User', dataIndex: 'user', width: 120 },
            { title: 'Path', dataIndex: 'path', width: 260, ellipsis: true },
            { title: 'CPU%', dataIndex: 'cpu', width: 80 },
            { title: 'MEM%', dataIndex: 'mem', width: 80 },
            { title: 'Command', dataIndex: 'command', width: 240, ellipsis: true },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
            { title: 'Severity', dataIndex: 'severity', width: 100 },
        ];
        columnConfigs['lastlog'] = [
            { title: 'User', dataIndex: 'user', width: 120 },
            { title: 'Port', dataIndex: 'port', width: 100 },
            { title: 'From', dataIndex: 'from', width: 160 },
            { title: 'Latest', dataIndex: 'latest', ellipsis: true },
        ];

        columnConfigs['win_defender'] = [
            { title: 'Item', dataIndex: 'element', width: 250 },
            { title: 'Status', dataIndex: 'status', width: 120 },
            { title: 'Value', dataIndex: 'value', ellipsis: true },
        ];
        columnConfigs['persistence'] = [
            { title: 'Type', dataIndex: 'type', width: 120 },
            { title: 'Name', dataIndex: 'name', width: 240, ellipsis: true },
            { title: 'Status', dataIndex: 'status', width: 100 },
            { title: 'Action / Path', dataIndex: 'detail', ellipsis: true },
            { title: 'Trigger', dataIndex: 'trigger', width: 220, ellipsis: true },
            { title: 'User', dataIndex: 'user', width: 160 },
            { title: 'Location', dataIndex: 'location', width: 220, ellipsis: true },
        ];
        columnConfigs['rdp'] = [
            { title: 'Type', dataIndex: 'type', width: 100 },
            { title: 'Local', dataIndex: 'local', width: 180 },
            { title: 'Remote', dataIndex: 'remote', width: 180 },
            { title: 'State', dataIndex: 'state', width: 120 },
            { title: 'PID', dataIndex: 'pid', width: 90 },
            { title: 'Process', dataIndex: 'process', width: 150 },
            { title: 'Name', dataIndex: 'name', width: 220 },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
        ];
        columnConfigs['browser'] = [
            { title: 'Browser', dataIndex: 'name', width: 100 },
            { title: 'Profile', dataIndex: 'profile', width: 140 },
            { title: 'Status', dataIndex: 'status', width: 100 },
            { title: 'Profile Path', dataIndex: 'value', ellipsis: true },
            { title: 'Profile Updated', dataIndex: 'lastWriteTime', width: 170 },
            { title: 'History Path', dataIndex: 'historyPath', ellipsis: true },
            { title: 'History Updated', dataIndex: 'historyLastWriteTime', width: 170 },
        ];
        
        const shellConfigColumns = [
            { title: 'Source', dataIndex: 'source', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 130 },
            { title: 'Risk', dataIndex: 'risk', width: 100 },
            { title: 'Note', dataIndex: 'note', width: 150 },
            { title: 'Target', dataIndex: 'target', width: 220 },
            { title: 'Command', dataIndex: 'command', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.firewall = [
            { title: 'Source', dataIndex: 'source', width: 110 },
            { title: 'Chain', dataIndex: 'chain', width: 120 },
            { title: 'Action', dataIndex: 'action', width: 100 },
            { title: 'Protocol', dataIndex: 'protocol', width: 90 },
            { title: 'From', dataIndex: 'from', width: 160 },
            { title: 'To', dataIndex: 'to', width: 160 },
            { title: 'Port', dataIndex: 'port', width: 100 },
            { title: 'Options', dataIndex: 'options', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.bashrc_check = shellConfigColumns;
        columnConfigs.profile_check = shellConfigColumns;
        columnConfigs.selinux_status = [
            { title: 'Source', dataIndex: 'source', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 150 },
            { title: 'Value', dataIndex: 'target', width: 220 },
            { title: 'Risk', dataIndex: 'risk', width: 100 },
            { title: 'Note', dataIndex: 'note', width: 150 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.pam_config = [
            { title: 'Service', dataIndex: 'service', width: 130 },
            { title: 'Type', dataIndex: 'type', width: 90 },
            { title: 'Control', dataIndex: 'control', width: 110 },
            { title: 'Module', dataIndex: 'module', width: 220 },
            { title: 'Options', dataIndex: 'options', ellipsis: true },
            { title: 'Risk', dataIndex: 'risk', width: 100 },
            { title: 'Note', dataIndex: 'note', width: 150 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.sudoers_config = [
            { title: 'Source', dataIndex: 'source', width: 120 },
            { title: 'Principal', dataIndex: 'principal', width: 150 },
            { title: 'Host', dataIndex: 'host', width: 100 },
            { title: 'Run As', dataIndex: 'runAs', width: 130 },
            { title: 'Tag', dataIndex: 'tag', width: 120 },
            { title: 'Risk', dataIndex: 'risk', width: 130 },
            { title: 'Command', dataIndex: 'command', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.sudo_config = columnConfigs.sudoers_config;
        columnConfigs.win_firewall = [
            { title: 'Profile', dataIndex: 'profile', width: 140 },
            { title: 'Setting', dataIndex: 'setting', width: 220 },
            { title: 'Value', dataIndex: 'value', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];

        columnConfigs.recent_files = osType === 'Windows' ? [
            { title: 'File', dataIndex: 'name', width: 250, ellipsis: true },
            { title: 'Last Access', dataIndex: 'lastAccess', width: 180 },
            { title: 'Path', dataIndex: 'path', ellipsis: true },
            { title: 'Target Path', dataIndex: 'targetPath', ellipsis: true },
        ] : [
            { title: 'File', dataIndex: 'name', width: 180, ellipsis: true },
            { title: 'Path', dataIndex: 'path', ellipsis: true },
            { title: 'Directory', dataIndex: 'directory', width: 220, ellipsis: true },
            { title: 'Category', dataIndex: 'category', width: 120 },
            { title: 'Risk', dataIndex: 'risk', width: 90 },
            { title: 'Note', dataIndex: 'note', width: 180 },
        ];
        columnConfigs.dns_config = osType === 'Windows' ? [
            { title: 'Interface', dataIndex: 'interface', width: 200 },
            { title: 'DNS Servers', dataIndex: 'dns', ellipsis: true },
        ] : [
            { title: 'Source', dataIndex: 'source', width: 160 },
            { title: 'Type', dataIndex: 'type', width: 140 },
            { title: 'Value', dataIndex: 'value', width: 240, ellipsis: true },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.hosts_file = [
            { title: 'IP Address', dataIndex: 'ip', width: 180 },
            { title: 'Hostname', dataIndex: 'hostname', ellipsis: true },
            { title: 'Risk', dataIndex: 'risk', width: 90 },
            { title: 'Note', dataIndex: 'note', width: 220, ellipsis: true },
        ];
        columnConfigs.ulimit_config = [
            { title: 'Source', dataIndex: 'source', width: 120 },
            { title: 'Domain', dataIndex: 'domain', width: 120 },
            { title: 'Limit', dataIndex: 'name', width: 180 },
            { title: 'Type', dataIndex: 'type', width: 100 },
            { title: 'Value', dataIndex: 'value', width: 140 },
            { title: 'Raw', dataIndex: 'raw', ellipsis: true },
        ];
        columnConfigs.security_events = [
            { title: 'Event ID', dataIndex: 'eventId', width: 90 },
            { title: 'Time', dataIndex: 'timeCreated', width: 170 },
            { title: 'Type', dataIndex: 'eventType', width: 180 },
            { title: 'User', dataIndex: 'username', width: 130 },
            { title: 'Source IP', dataIndex: 'sourceIp', width: 150 },
            { title: 'Logon Type', dataIndex: 'logonType', width: 100 },
            { title: 'Status', dataIndex: 'status', width: 120 },
            { title: 'Risk', dataIndex: 'suspicious', width: 90 },
            { title: 'Description', dataIndex: 'description', ellipsis: true },
        ];
        columnConfigs.file_scan = [
            { title: 'Category', dataIndex: 'category', width: 190 },
            { title: 'Risk', dataIndex: 'risk', width: 90 },
            { title: 'File', dataIndex: 'name', width: 180 },
            { title: 'Directory', dataIndex: 'directory', width: 260 },
            { title: 'Size', dataIndex: 'size', width: 100 },
            { title: 'Modified', dataIndex: 'lastModified', width: 170 },
            { title: 'Path', dataIndex: 'path', ellipsis: true },
            { title: 'Note', dataIndex: 'note', width: 220 },
        ];

        const windowsDfirColumns = [
            { title: 'Category', dataIndex: 'category', width: 150 },
            { title: 'Source', dataIndex: 'source', width: 170 },
            { title: 'Risk', dataIndex: 'risk', width: 90 },
            { title: 'Status', dataIndex: 'status', width: 110 },
            { title: 'Time', dataIndex: 'time', width: 170 },
            { title: 'Event ID', dataIndex: 'eventId', width: 90 },
            { title: 'Name', dataIndex: 'name', width: 220 },
            { title: 'User', dataIndex: 'user', width: 130 },
            { title: 'IP', dataIndex: 'ip', width: 140 },
            { title: 'Path', dataIndex: 'path', width: 320 },
            { title: 'Detail', dataIndex: 'detail', ellipsis: true },
        ];
        ['execution_trace', 'powershell_deep', 'defender_history', 'rdp_logon_trace', 'wmi_persistence', 'bits_jobs', 'registry_persistence_deep']
            .forEach((dfirKey) => { columnConfigs[dfirKey] = windowsDfirColumns; });

        return columnConfigs[moduleKey] || [];
    };
    const allColumns = getAllColumns();

    const renderList = () => {
        if (listData.length === 0) return null;

        // 命令历史 - 代码风格
        if (moduleKey === 'history_cmd') {
            return (
                <List
                    size="small"
                    dataSource={listData}
                    renderItem={(cmd) => (
                        <List.Item style={{ padding: '4px 8px', background: '#fafafa', marginBottom: 2, borderRadius: 4 }}>
                            <Text code style={{ fontSize: 12 }}>{cmd}</Text>
                        </List.Item>
                    )}
                    style={{ maxHeight: 500, overflow: 'auto' }}
                />
            );
        }

        // Hosts文件 - 表格样式
        if (moduleKey === 'hosts_file') {
            const hostsData = listData
                .filter(line => line.trim() && !line.trim().startsWith('#'))
                .map((line, i) => {
                    const parts = line.trim().split(/\s+/);
                    return { key: i, ip: parts[0] || '', hostname: parts.slice(1).join('  ') };
                });
            const comments = listData.filter(line => line.trim().startsWith('#'));

            return (
                <div>
                    <Table
                        dataSource={hostsData}
                        columns={[
                            {
                                title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 180,
                                render: (ip: string) => <Tag color="blue">{ip}</Tag>
                            },
                            {
                                title: '主机名', dataIndex: 'hostname', key: 'hostname',
                                render: (h: string) => <Text code>{h}</Text>
                            },
                        ]}
                        size="small"
                        pagination={false}
                        style={{ marginBottom: 16 }}
                    />
                    {comments.length > 0 && (
                        <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                {comments.map((c, i) => <div key={i}>{c}</div>)}
                            </Text>
                        </div>
                    )}
                </div>
            );
        }

        // DNS配置 - 卡片样式
        if (moduleKey === 'dns_config') {
            const nameservers = listData.filter(line => line.includes('nameserver'));
            const searchDomains = listData.filter(line => line.includes('search') || line.includes('domain'));
            const options = listData.filter(line => line.includes('options'));

            return (
                <Row gutter={16}>
                    <Col span={12}>
                        <Card size="small" title="🌐 DNS 服务器" style={{ marginBottom: 16 }}>
                            {nameservers.length > 0 ? nameservers.map((ns, i) => {
                                const ip = ns.replace('nameserver', '').trim();
                                return (
                                    <div key={i} style={{ marginBottom: 8 }}>
                                        <Tag color="green" style={{ fontSize: 14, padding: '4px 12px' }}>
                                            {ip}
                                        </Tag>
                                    </div>
                                );
                            }) : <Text type="secondary">无配置</Text>}
                        </Card>
                    </Col>
                    <Col span={12}>
                        <Card size="small" title="🔍 搜索域" style={{ marginBottom: 16 }}>
                            {searchDomains.length > 0 ? searchDomains.map((sd, i) => (
                                <div key={i}><Text code>{sd}</Text></div>
                            )) : <Text type="secondary">无配置</Text>}
                        </Card>
                        {options.length > 0 && (
                            <Card size="small" title="⚙️ 选项">
                                {options.map((opt, i) => (
                                    <div key={i}><Text code style={{ fontSize: 12 }}>{opt}</Text></div>
                                ))}
                            </Card>
                        )}
                    </Col>
                </Row>
            );
        }

        // 防火墙规则 - 表格样式
        if (moduleKey === 'iptables') {
            return (
                <div style={{ background: '#1e1e1e', padding: 16, borderRadius: 8, maxHeight: 500, overflow: 'auto' }}>
                    <pre style={{ margin: 0, color: '#d4d4d4', fontSize: 12, fontFamily: 'Consolas, monospace' }}>
                        {listData.map((line, i) => {
                            // 高亮规则
                            let color = '#d4d4d4';
                            if (line.includes('Chain')) color = '#569cd6';
                            else if (line.includes('ACCEPT')) color = '#4ec9b0';
                            else if (line.includes('DROP') || line.includes('REJECT')) color = '#f14c4c';
                            else if (line.includes('--')) color = '#ce9178';

                            return <div key={i} style={{ color }}>{line || ' '}</div>;
                        })}
                    </pre>
                </div>
            );
        }

        // 默认列表样式
        return (
            <List
                size="small"
                dataSource={listData}
                renderItem={(item) => (
                    <List.Item style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
                        <Text style={{ fontSize: 13 }}>{item}</Text>
                    </List.Item>
                )}
                style={{ maxHeight: 500, overflow: 'auto', background: '#fff', borderRadius: 8 }}
            />
        );
    };

    const renderTerminal = () => {
        // 点击终端区域时聚焦输入框
        const handleTerminalClick = () => {
            inputRef.current?.focus();
        };

        // 渲染终端输出行 - 支持完整提示符格式
        const renderLine = (line: string, i: number) => {
            // 匹配类似 (root@sevedy)-[/path]# cmd 或 (root@sevedy)-[/path]$ cmd
            // 使用\s*允许#/$后面没有空格的情况
            const promptMatch = line.match(/^\(([^)]+)\)-\[([^\]]+)\](#|\$)\s*(.*)$/);
            if (promptMatch) {
                const userHost = promptMatch[1];  // root@sevedy
                const path = promptMatch[2];      // /home/sevedy
                const symbol = promptMatch[3];    // # 或 $
                const command = promptMatch[4] || '';   // ls（可能为空）
                return (
                    <div key={i} style={{ marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ color: '#4ec9b0' }}>┌──</span>
                            <span style={{ color: '#f14c4c' }}>({userHost})</span>
                            <span style={{ color: '#4ec9b0' }}>-[</span>
                            <span style={{ color: '#dcdcaa' }}>{path}</span>
                            <span style={{ color: '#4ec9b0' }}>]</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ color: '#4ec9b0' }}>└──</span>
                            <span style={{ color: '#f14c4c' }}>{symbol}&nbsp;</span>
                            <span style={{ color: '#4ec9b0' }}>{command}</span>
                        </div>
                    </div>
                );
            }
            // 简单的 $ 或 # 开头
            if (line.startsWith('$') || line.startsWith('#')) {
                const prompt = line.substring(0, 1);
                const cmd = line.substring(2);
                return (
                    <div key={i} style={{ marginBottom: 2 }}>
                        <span style={{ color: '#f14c4c' }}>{prompt}</span>
                        <span style={{ color: '#4ec9b0' }}> {cmd}</span>
                    </div>
                );
            }
            return <div key={i} style={{ color: '#d4d4d4', marginBottom: 2, whiteSpace: 'pre-wrap' }}>{line}</div>;
        };

        return (
            <div
                ref={terminalRef}
                onClick={handleTerminalClick}
                style={{
                    height: 'calc(100vh - 150px)',
                    background: '#0c0c0c',
                    borderRadius: 8,
                    padding: 16,
                    overflow: 'auto',
                    fontFamily: 'Consolas, "Courier New", monospace',
                    fontSize: 14,
                    lineHeight: 1.6,
                    cursor: 'text',
                }}
            >
                {/* 历史输出 */}
                {terminalOutput.map(renderLine)}

                {/* 当前输入行 - 使用完整提示符格式 */}
                {!executing && (
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ color: '#4ec9b0' }}>┌──</span>
                            <span style={{ color: '#f14c4c' }}>({terminalUser}@{terminalHost})</span>
                            <span style={{ color: '#4ec9b0' }}>-[</span>
                            <span style={{ color: '#dcdcaa' }}>{terminalPath}</span>
                            <span style={{ color: '#4ec9b0' }}>]</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <span style={{ color: '#4ec9b0' }}>└──</span>
                            <span style={{ color: '#f14c4c' }}>{terminalUser === 'root' ? '#' : '$'}</span>
                            <input
                                ref={inputRef}
                                value={terminalInput}
                                onChange={(e) => setTerminalInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        handleTerminalCommand();
                                    }
                                }}
                                autoFocus
                                style={{
                                    flex: 1,
                                    background: 'transparent',
                                    border: 'none',
                                    outline: 'none',
                                    color: '#4ec9b0',
                                    fontFamily: 'Consolas, monospace',
                                    fontSize: 14,
                                    marginLeft: 4,
                                    caretColor: '#fff',
                                }}
                            />
                        </div>
                    </div>
                )}

                {/* 执行中状态 */}
                {executing && (
                    <div style={{ color: '#888' }}>执行中...</div>
                )}
            </div>
        );
    };

    // 登录失败统计渲染
    const renderFailedLoginsStats = () => {
        if (tableData.length === 0) return null;

        // 统计IP出现次数
        const ipStats: Record<string, number> = {};
        const userStats: Record<string, number> = {};
        tableData.forEach((item: any) => {
            if (item.ip && item.ip !== '-') {
                ipStats[item.ip] = (ipStats[item.ip] || 0) + 1;
            }
            if (item.user && item.user !== '-') {
                userStats[item.user] = (userStats[item.user] || 0) + 1;
            }
        });

        // 排序取前10
        const topIps = Object.entries(ipStats).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const topUsers = Object.entries(userStats).sort((a, b) => b[1] - a[1]).slice(0, 10);

        return (
            <Card
                size="small"
                className={cardClass}
                style={{
                    marginBottom: 16,
                    background: isDarkMode ? (glassEnabled ? 'rgba(255, 77, 79, 0.1)' : '#432a2a') : '#fff1f0',
                    border: `1px solid ${isDarkMode ? '#823c3c' : '#ffa39e'}`,
                    borderRadius: 8
                }}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 15, color: '#cf1322' }}>📊 登录失败统计</Text>
                    <Tag color="red" style={{ marginLeft: 12 }}>共 {tableData.length} 次失败</Tag>
                </div>
                <Row gutter={24}>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>🔥 高频IP (Top 10)</Text>
                        <div style={{ marginTop: 8, maxHeight: 150, overflow: 'auto' }}>
                            {topIps.map(([ip, count], i) => (
                                <div key={ip} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                                    <Text code style={{ fontSize: 12 }}>{i + 1}. {ip}</Text>
                                    <Tag color={count > 50 ? 'red' : count > 10 ? 'orange' : 'default'}>{count} 次</Tag>
                                </div>
                            ))}
                            {topIps.length === 0 && <Text type="secondary">无IP信息</Text>}
                        </div>
                    </Col>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>👤 高频用户 (Top 10)</Text>
                        <div style={{ marginTop: 8, maxHeight: 150, overflow: 'auto' }}>
                            {topUsers.map(([user, count], i) => (
                                <div key={user} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
                                    <Text type="danger" style={{ fontSize: 12 }}>{i + 1}. {user}</Text>
                                    <Tag color={count > 50 ? 'red' : count > 10 ? 'orange' : 'default'}>{count} 次</Tag>
                                </div>
                            ))}
                            {topUsers.length === 0 && <Text type="secondary">无用户信息</Text>}
                        </div>
                    </Col>
                </Row>
            </Card>
        );
    };

    // 登录历史统计渲染
    const renderLoginHistoryStats = () => {
        if (tableData.length === 0) return null;

        // 统计用户登录次数
        const userStats: Record<string, number> = {};
        const ipStats: Record<string, number> = {};
        let stillLoggedIn = 0;

        tableData.forEach((item: any) => {
            if (item.user && item.user !== '-') {
                userStats[item.user] = (userStats[item.user] || 0) + 1;
            }
            if (item.ip && item.ip !== '-') {
                ipStats[item.ip] = (ipStats[item.ip] || 0) + 1;
            }
            if (item.duration?.includes('still')) {
                stillLoggedIn++;
            }
        });

        const topUsers = Object.entries(userStats).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const topIps = Object.entries(ipStats).sort((a, b) => b[1] - a[1]).slice(0, 8);

        return (
            <Card
                size="small"
                className={cardClass}
                style={{
                    marginBottom: 16,
                    background: isDarkMode ? (glassEnabled ? 'rgba(82, 196, 26, 0.1)' : '#1c2b1a') : '#f6ffed',
                    border: `1px solid ${isDarkMode ? '#4b633c' : '#b7eb8f'}`,
                    borderRadius: 8
                }}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 15, color: '#52c41a' }}>📊 登录历史统计</Text>
                    <Tag color="green" style={{ marginLeft: 12 }}>共 {tableData.length} 条记录</Tag>
                    {stillLoggedIn > 0 && <Tag color="blue">{stillLoggedIn} 人在线</Tag>}
                </div>
                <Row gutter={24}>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>👤 用户登录次数 (Top 8)</Text>
                        <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto' }}>
                            {topUsers.map(([user, count], i) => (
                                <div key={user} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                                    <Tag color="blue">{i + 1}. {user}</Tag>
                                    <span>{count} 次</span>
                                </div>
                            ))}
                        </div>
                    </Col>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>🌐 登录来源IP (Top 8)</Text>
                        <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto' }}>
                            {topIps.map(([ip, count], i) => (
                                <div key={ip} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                                    <Text code style={{ fontSize: 11 }}>{i + 1}. {ip}</Text>
                                    <span>{count} 次</span>
                                </div>
                            ))}
                        </div>
                    </Col>
                </Row>
            </Card>
        );
    };

    // Web访问日志统计渲染
    const renderWebAccessStats = () => {
        if (tableData.length === 0) return null;

        // 统计
        const ipStats: Record<string, number> = {};
        const pathStats: Record<string, number> = {};
        const statusStats: Record<string, number> = {};
        tableData.forEach((item: any) => {
            if (item.ip && item.ip !== '-') {
                ipStats[item.ip] = (ipStats[item.ip] || 0) + 1;
            }
            if (item.path && item.path !== '-') {
                pathStats[item.path] = (pathStats[item.path] || 0) + 1;
            }
            if (item.status && item.status !== '-') {
                statusStats[item.status] = (statusStats[item.status] || 0) + 1;
            }
        });

        const topIps = Object.entries(ipStats).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const topPaths = Object.entries(pathStats).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const statusList = Object.entries(statusStats).sort((a, b) => b[1] - a[1]);

        return (
            <Card
                size="small"
                className={cardClass}
                style={{
                    marginBottom: 16,
                    background: isDarkMode ? (glassEnabled ? 'rgba(24, 144, 255, 0.1)' : '#111d2c') : '#e6f7ff',
                    border: `1px solid ${isDarkMode ? '#153450' : '#91d5ff'}`,
                    borderRadius: 8
                }}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 15, color: '#096dd9' }}>📊 Web访问统计</Text>
                    <Tag color="blue" style={{ marginLeft: 12 }}>共 {tableData.length} 条记录</Tag>
                </div>
                <Row gutter={16}>
                    <Col span={8}>
                        <Text strong style={{ fontSize: 13 }}>🔢 状态码分布</Text>
                        <div style={{ marginTop: 8 }}>
                            {statusList.map(([status, count]) => (
                                <Tag
                                    key={status}
                                    color={status.startsWith('2') ? 'green' : status.startsWith('3') ? 'blue' : status.startsWith('4') ? 'orange' : 'red'}
                                    style={{ margin: '2px' }}
                                >
                                    {status}: {count}
                                </Tag>
                            ))}
                        </div>
                    </Col>
                    <Col span={8}>
                        <Text strong style={{ fontSize: 13 }}>🔥 高频IP (Top 8)</Text>
                        <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto' }}>
                            {topIps.map(([ip, count], i) => (
                                <div key={ip} style={{ fontSize: 11, padding: '2px 0' }}>
                                    <Text code>{i + 1}. {ip}</Text>
                                    <Tag style={{ marginLeft: 4 }}>{count}</Tag>
                                </div>
                            ))}
                        </div>
                    </Col>
                    <Col span={8}>
                        <Text strong style={{ fontSize: 13 }}>📁 热门路径 (Top 8)</Text>
                        <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto' }}>
                            {topPaths.map(([path, count], i) => (
                                <div key={path} style={{ fontSize: 11, padding: '2px 0' }}>
                                    <Text style={{ color: '#1890ff' }}>{i + 1}. {path.length > 30 ? path.substring(0, 30) + '...' : path}</Text>
                                    <Tag style={{ marginLeft: 4 }}>{count}</Tag>
                                </div>
                            ))}
                        </div>
                    </Col>
                </Row>
            </Card>
        );
    };

    // Sudo日志统计渲染
    const renderSudoLogStats = () => {
        if (tableData.length === 0) return null;

        const userStats: Record<string, number> = {};
        const cmdStats: Record<string, number> = {};
        tableData.forEach((item: any) => {
            if (item.user && item.user !== '-') {
                userStats[item.user] = (userStats[item.user] || 0) + 1;
            }
            if (item.command) {
                const cmd = item.command.split(' ')[0] || item.command;
                cmdStats[cmd] = (cmdStats[cmd] || 0) + 1;
            }
        });

        const topUsers = Object.entries(userStats).sort((a, b) => b[1] - a[1]).slice(0, 6);
        const topCmds = Object.entries(cmdStats).sort((a, b) => b[1] - a[1]).slice(0, 6);

        return (
            <Card
                size="small"
                className={cardClass}
                style={{
                    marginBottom: 16,
                    background: isDarkMode ? (glassEnabled ? 'rgba(250, 173, 20, 0.1)' : '#2b2111') : '#fff7e6',
                    border: `1px solid ${isDarkMode ? '#594214' : '#ffd591'}`,
                    borderRadius: 8
                }}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 15, color: '#d46b08' }}>🔐 Sudo提权统计</Text>
                    <Tag color="orange" style={{ marginLeft: 12 }}>共 {tableData.length} 次提权</Tag>
                </div>
                <Row gutter={24}>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>👤 提权用户</Text>
                        <div style={{ marginTop: 8 }}>
                            {topUsers.map(([user, count]) => (
                                <Tag key={user} color="orange" style={{ margin: '2px' }}>{user}: {count}次</Tag>
                            ))}
                        </div>
                    </Col>
                    <Col span={12}>
                        <Text strong style={{ fontSize: 13 }}>⚡ 常用命令</Text>
                        <div style={{ marginTop: 8 }}>
                            {topCmds.map(([cmd, count]) => (
                                <Tag key={cmd} color="blue" style={{ margin: '2px' }}>{cmd.split('/').pop()}: {count}次</Tag>
                            ))}
                        </div>
                    </Col>
                </Row>
            </Card>
        );
    };

    // 进程异常检测统计面板渲染
    const renderProcessAnomalyStats = () => {
        if (tableData.length === 0) return null;

        const counts = {
            HIDDEN: tableData.filter(i => i.type === 'HIDDEN').length,
            DELETED: tableData.filter(i => i.type === 'DELETED').length,
            SENSITIVE: tableData.filter(i => i.type === 'SENSITIVE_PATH').length,
            HIGH: tableData.filter(i => i.type === 'HIGH_RESOURCES').length
        };

        return (
            <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}>
                    <Card
                        size="small"
                        className={cardClass}
                        style={{
                            background: isDarkMode ? (glassEnabled ? 'rgba(255, 77, 79, 0.1)' : '#432a2a') : '#fff1f0',
                            border: `1px solid ${isDarkMode ? '#823c3c' : '#ffa39e'}`,
                            borderRadius: 8
                        }}
                    >
                        <Statistic
                            title={<span style={{ color: '#cf1322', fontSize: 13 }}>👻 隐藏进程</span>}
                            value={counts.HIDDEN}
                            valueStyle={{ color: '#cf1322', fontWeight: 'bold' }}
                            suffix={<span style={{ fontSize: 12, color: '#cf1322' }}>个</span>}
                        />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card
                        size="small"
                        className={cardClass}
                        style={{
                            background: isDarkMode ? (glassEnabled ? 'rgba(245, 34, 45, 0.1)' : '#432a2a') : '#fff2f0',
                            border: `1px solid ${isDarkMode ? '#823c3c' : '#ffccc7'}`,
                            borderRadius: 8
                        }}
                    >
                        <Statistic
                            title={<span style={{ color: '#f5222d', fontSize: 13 }}>🗑️ 文件已删除</span>}
                            value={counts.DELETED}
                            valueStyle={{ color: '#f5222d', fontWeight: 'bold' }}
                            suffix={<span style={{ fontSize: 12, color: '#f5222d' }}>个</span>}
                        />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card
                        size="small"
                        className={cardClass}
                        style={{
                            background: isDarkMode ? (glassEnabled ? 'rgba(250, 173, 20, 0.1)' : '#2b2111') : '#fff7e6',
                            border: `1px solid ${isDarkMode ? '#594214' : '#ffd591'}`,
                            borderRadius: 8
                        }}
                    >
                        <Statistic
                            title={<span style={{ color: '#d46b08', fontSize: 13 }}>📂 敏感路径</span>}
                            value={counts.SENSITIVE}
                            valueStyle={{ color: '#fa8c16' }}
                            suffix={<span style={{ fontSize: 12, color: '#d46b08' }}>个</span>}
                        />
                    </Card>
                </Col>
                <Col span={6}>
                    <Card
                        size="small"
                        className={cardClass}
                        style={{
                            background: isDarkMode ? (glassEnabled ? 'rgba(24, 144, 255, 0.1)' : '#111d2c') : '#e6f7ff',
                            border: `1px solid ${isDarkMode ? '#153450' : '#91d5ff'}`,
                            borderRadius: 8
                        }}
                    >
                        <Statistic
                            title={<span style={{ color: '#096dd9', fontSize: 13 }}>⚡ 高负载进程</span>}
                            value={counts.HIGH}
                            valueStyle={{ color: '#1890ff' }}
                            suffix={<span style={{ fontSize: 12, color: '#096dd9' }}>个</span>}
                        />
                    </Card>
                </Col>
            </Row>
        );
    };

    // 配置文件美化渲染 (bashrc/profile/pam/sudoers/selinux)
    const renderConfigFile = () => {
        if (listData.length === 0) return <Text type="secondary">暂无数据</Text>;

        // 根据模块类型设置不同的样式
        const configStyles: Record<string, { bg: string; border: string; icon: string; title: string; color: string }> = {
            bashrc_check: { bg: '#f6ffed', border: '#b7eb8f', icon: '📜', title: 'Bashrc配置检查', color: '#52c41a' },
            profile_check: { bg: '#e6f7ff', border: '#91d5ff', icon: '📋', title: 'Profile配置检查', color: '#1890ff' },
            pam_config: { bg: '#fff1f0', border: '#ffa39e', icon: '🔒', title: 'PAM认证模块', color: '#f5222d' },
            sudo_config: { bg: '#fff7e6', border: '#ffd591', icon: '🔑', title: 'Sudo权限配置', color: '#fa8c16' },
            sudoers_config: { bg: '#fff7e6', border: '#ffd591', icon: '🔑', title: 'Sudoers权限配置', color: '#fa8c16' },
            selinux_status: { bg: '#f9f0ff', border: '#d3adf7', icon: '🛡️', title: 'SELinux/AppArmor状态', color: '#722ed1' },
            win_firewall: { bg: '#e6fffb', border: '#87e8de', icon: '🧱', title: 'Windows 防火墙配置', color: '#13c2c2' },
        };
        const style = configStyles[moduleKey] || { bg: '#fafafa', border: '#d9d9d9', icon: '📄', title: '配置文件', color: '#8c8c8c' };

        // 分段处理
        const sections: { title: string; lines: string[] }[] = [];
        let currentSection = { title: '默认', lines: [] as string[] };

        listData.forEach((line: string) => {
            if (line.startsWith('===') && line.endsWith('===')) {
                if (currentSection.lines.length > 0) {
                    sections.push(currentSection);
                }
                currentSection = { title: line.replace(/===/g, '').trim(), lines: [] };
            } else {
                currentSection.lines.push(line);
            }
        });
        if (currentSection.lines.length > 0) {
            sections.push(currentSection);
        }

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Card
                    size="small"
                    className={cardClass}
                    style={{
                        background: isDarkMode ? (glassEnabled ? 'rgba(255, 255, 255, 0.05)' : '#1f1f1f') : style.bg,
                        border: `1px solid ${isDarkMode ? borderColor : style.border}`
                    }}
                >
                    <Text strong style={{ fontSize: 15, color: isDarkMode ? style.color : 'inherit' }}>{style.icon} {style.title}</Text>
                    <Tag style={{ marginLeft: 12 }}>{listData.length} 行</Tag>
                </Card>
                {sections.map((section, idx) => (
                    <Card
                        key={idx}
                        size="small"
                        className={cardClass}
                        title={<span style={{ fontSize: 13, color: isDarkMode ? '#e0e0e0' : 'inherit' }}>📁 {section.title}</span>}
                        style={{ borderRadius: 8 }}
                    >
                        <pre style={{
                            margin: 0,
                            padding: 12,
                            background: '#1a1a2e',
                            color: '#e0e0e0',
                            borderRadius: 6,
                            fontSize: 12,
                            maxHeight: 300,
                            overflow: 'auto',
                            fontFamily: 'Consolas, Monaco, monospace'
                        }}>
                            {section.lines.map((line, i) => {
                                // 语法高亮
                                let color = '#e0e0e0';
                                if (line.startsWith('#')) color = '#6a9955';
                                else if (line.includes('=')) color = '#9cdcfe';
                                else if (line.match(/^(export|alias|if|then|fi|else|for|do|done)/)) color = '#c586c0';
                                else if (line.match(/sudo|root|ALL/)) color = '#ce9178';
                                return <div key={i} style={{ color }}>{line}</div>;
                            })}
                        </pre>
                    </Card>
                ))}
            </div>
        );
    };

    // 环境变量统计渲染
    const renderEnvVarsStats = () => {
        if (tableData.length === 0) return null;

        // 分类统计
        const pathVars = tableData.filter((v: any) => v.name?.includes('PATH'));
        const homeVars = tableData.filter((v: any) => v.name?.includes('HOME') || v.name?.includes('USER'));
        const langVars = tableData.filter((v: any) => v.name?.includes('LANG') || v.name?.includes('LC_'));

        return (
            <Card
                size="small"
                className={cardClass}
                style={{
                    marginBottom: 16,
                    background: isDarkMode ? (glassEnabled ? 'rgba(47, 84, 235, 0.1)' : '#101426') : '#f0f5ff',
                    border: `1px solid ${isDarkMode ? '#1d39c4' : '#adc6ff'}`
                }}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ fontSize: 15, color: '#2f54eb' }}>🌐 环境变量统计</Text>
                    <Tag color="blue" style={{ marginLeft: 12 }}>共 {tableData.length} 个变量</Tag>
                </div>
                <Space size="large">
                    <Statistic title="PATH相关" value={pathVars.length} valueStyle={{ fontSize: 20 }} />
                    <Statistic title="用户相关" value={homeVars.length} valueStyle={{ fontSize: 20 }} />
                    <Statistic title="语言相关" value={langVars.length} valueStyle={{ fontSize: 20 }} />
                </Space>
            </Card>
        );
    };

    // 可疑文件扫描结果渲染
    const renderIocFileSearch = () => {
        const hasSearchCriteria = Boolean(buildIocFileSearchRequest());
        const searchSurfaceBackground = isDarkMode ? '#101827' : '#ffffff';
        const rowBorder = isDarkMode ? '#263244' : '#dde5ef';
        const virtualTotal = iocSearchTotalCount
            ?? ((Math.max(1, iocSearchPage) - 1) * EVERYTHING_LIVE_MAX_RESULTS
                + iocSearchResults.length
                + (iocSearchHasMore ? EVERYTHING_LIVE_MAX_RESULTS : 0));
        const shouldShowPagination = hasSearchCriteria && virtualTotal > EVERYTHING_LIVE_MAX_RESULTS;
        const advancedFilters = (
            <div style={{ width: 340, display: 'grid', gap: 10 }}>
                <Input
                    aria-label="指定后缀"
                    placeholder="php, aspx, ps1"
                    value={iocSearchExtension}
                    onChange={(event) => setIocSearchExtension(event.target.value)}
                    allowClear
                />
                <Input
                    aria-label="指定目录"
                    placeholder="C:\\inetpub\\wwwroot"
                    value={iocSearchPath}
                    onChange={(event) => setIocSearchPath(event.target.value)}
                    allowClear
                />
                <Space.Compact style={{ width: '100%' }}>
                    <Select
                        aria-label="哈希算法"
                        value={iocHashAlgorithm}
                        options={EVERYTHING_HASH_ALGORITHMS}
                        onChange={(value: EverythingHashAlgorithm) => setIocHashAlgorithm(value)}
                        style={{ width: 112 }}
                    />
                    <Input
                        aria-label="哈希值"
                        placeholder="hash equals"
                        value={iocHashValue}
                        onChange={(event) => setIocHashValue(event.target.value)}
                        allowClear
                    />
                </Space.Compact>
                <Input
                    aria-label="文件内容"
                    placeholder="content contains"
                    value={iocContentQuery}
                    onChange={(event) => setIocContentQuery(event.target.value)}
                    allowClear
                />
            </div>
        );

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Space.Compact style={{ width: '100%' }}>
                    <Input
                        aria-label="Everything 实时搜索"
                        type="search"
                        size="large"
                        prefix={<SearchOutlined />}
                        placeholder="shell.php / *.ps1 / ext:aspx / dm:today"
                        value={iocSearchQuery}
                        onChange={(event) => setIocSearchQuery(event.target.value)}
                        suffix={iocSearchLoading ? <Spin size="small" /> : null}
                        allowClear
                    />
                    <Popover content={advancedFilters} trigger="click" placement="bottomRight">
                        <Button size="large" aria-label="高级设置">
                            ⚙️ 高级
                        </Button>
                    </Popover>
                </Space.Compact>

                {iocSearchError && (
                    <Alert
                        type="warning"
                        showIcon
                        title="Everything 搜索失败"
                        description={iocSearchError}
                    />
                )}

                {(hasSearchCriteria || iocSearchResults.length > 0 || iocSearchLoading) && (
                    <div
                        role="list"
                        style={{
                            overflow: 'hidden',
                            border: `1px solid ${rowBorder}`,
                            borderRadius: 8,
                            background: searchSurfaceBackground,
                        }}
                    >
                        {iocSearchResults.map((record) => {
                            const name = record.name || getPathBaseName(record.fullPath);
                            const extension = normalizeEverythingExtension(record);
                            return (
                                <div
                                    role="listitem"
                                    key={record.fullPath || name}
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                                        gap: 8,
                                        alignItems: 'center',
                                        padding: '8px 10px',
                                        borderBottom: `1px solid ${rowBorder}`,
                                    }}
                                >
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                            <Text strong ellipsis style={{ maxWidth: '42%' }}>{name}</Text>
                                            {extension && <Tag style={{ marginInlineEnd: 0 }}>{extension}</Tag>}
                                            <Text type="secondary" style={{ fontSize: 12 }}>
                                                {typeof record.size === 'number' ? formatFileSize(record.size) : '-'}
                                            </Text>
                                            <Text type="secondary" style={{ fontSize: 12 }}>{formatEverythingDate(record.dateModified)}</Text>
                                        </div>
                                        <Text
                                            copyable
                                            type="secondary"
                                            style={{ display: 'block', fontSize: 12, marginTop: 3 }}
                                            ellipsis
                                        >
                                            {record.fullPath}
                                        </Text>
                                    </div>
                                    <Button
                                        type="text"
                                        size="small"
                                        aria-label={`查看 ${name}`}
                                        icon={<EyeOutlined />}
                                        onClick={() => openFilePreview({
                                            name,
                                            fullPath: record.fullPath,
                                            isDir: false,
                                        })}
                                    />
                                </div>
                            );
                        })}
                        {hasSearchCriteria && !iocSearchLoading && iocSearchResults.length === 0 && (
                            <div style={{ padding: 24 }}>
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未搜索到文件" />
                            </div>
                        )}
                        {shouldShowPagination && (
                            <div
                                role="navigation"
                                aria-label="Everything search pagination"
                                style={{
                                    display: 'flex',
                                    justifyContent: 'flex-end',
                                    padding: '8px 10px',
                                    borderTop: `1px solid ${rowBorder}`,
                                }}
                            >
                                <Pagination
                                    size="small"
                                    current={iocSearchPage}
                                    pageSize={EVERYTHING_LIVE_MAX_RESULTS}
                                    total={virtualTotal}
                                    showSizeChanger={false}
                                    showQuickJumper
                                    disabled={iocSearchLoading}
                                    showTotal={(total) => iocSearchTotalCount === null ? `Page ${iocSearchPage}` : `${total} items`}
                                    onChange={(page) => setIocSearchPage(page)}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const renderSuspiciousFiles = () => {
        if (!rawOutput) return <Text type="secondary">暂无数据</Text>;

        const sections: { title: string; files: string[]; color: string; icon: string }[] = [];
        const findings: {
            key: string;
            category: string;
            risk: string;
            riskColor: string;
            file: string;
            directory: string;
            path: string;
            reason: string;
        }[] = [];
        const lines = rawOutput.split('\n');
        let currentSection = '';
        let currentFiles: string[] = [];

        const sectionConfig: Record<string, { title: string; color: string; icon: string; risk: string; riskColor: string; reason: string }> = {
            '===SUID===': { title: 'SUID/SGID提权风险', color: '#ff4d4f', icon: '⚠️', risk: '高危', riskColor: 'red', reason: 'SUID binary can execute with owner privileges' },
            '===SGID===': { title: 'SUID/SGID提权风险', color: '#fa8c16', icon: '⚡', risk: '中危', riskColor: 'orange', reason: 'SGID binary can execute with group privileges' },
            '===WORLD_WRITABLE===': { title: '全局可写文件', color: '#faad14', icon: '✏️', risk: '中危', riskColor: 'orange', reason: 'Writable by untrusted users' },
            '===HIDDEN_EXE===': { title: '隐藏可执行文件', color: '#ff4d4f', icon: '🕵️', risk: '高危', riskColor: 'red', reason: 'Hidden executable under writable location' },
            '===RECENT_TEMP===': { title: '最近临时文件', color: '#faad14', icon: '📄', risk: '中危', riskColor: 'orange', reason: 'Recently modified file under temp directory' },
            '===TEMP_EXE===': { title: '临时目录可执行文件', color: '#fa8c16', icon: '📁', risk: '高危', riskColor: 'red', reason: 'Executable under temporary writable location' },
            '===RECENT_MODIFIED===': { title: '最近修改的系统文件', color: '#faad14', icon: '📝', risk: '中危', riskColor: 'orange', reason: 'Recently modified system binary' },
        };

        const pushFinding = (sectionName: string, path: string) => {
            const cfg = sectionConfig[sectionName];
            if (!cfg || !path.trim()) return;
            const normalizedPath = path.trim();
            const lastSlash = Math.max(normalizedPath.lastIndexOf('/'), normalizedPath.lastIndexOf('\\'));
            const file = lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
            const directory = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : '-';

            findings.push({
                key: `${sectionName}-${findings.length}`,
                category: cfg.title,
                risk: cfg.risk,
                riskColor: cfg.riskColor,
                file: file || normalizedPath,
                directory,
                path: normalizedPath,
                reason: cfg.reason,
            });
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (sectionConfig[trimmed]) {
                if (currentSection && currentFiles.length > 0) {
                    const cfg = sectionConfig[currentSection];
                    sections.push({ ...cfg, files: [...currentFiles] });
                }
                currentSection = trimmed;
                currentFiles = [];
            } else if (trimmed && currentSection) {
                currentFiles.push(trimmed);
                pushFinding(currentSection, trimmed);
            }
        }
        if (currentSection && currentFiles.length > 0) {
            const cfg = sectionConfig[currentSection];
            sections.push({ ...cfg, files: [...currentFiles] });
        }

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* 扫描配置区域 */}
                <Card
                    className={cardClass}
                    style={{
                        background: isDarkMode ? (glassEnabled ? 'rgba(24, 144, 255, 0.1)' : '#111d2c') : '#f0f5ff',
                        border: `1px solid ${isDarkMode ? '#153450' : '#d6e4ff'}`,
                        borderRadius: 12
                    }}
                    bodyStyle={{ padding: 20 }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <Text strong style={{ fontSize: 16, color: '#1890ff' }}>⚙️ 扫描目录配置</Text>
                        <Button
                            type="primary"
                            loading={scanning}
                            onClick={() => loadRemoteData()}
                        >
                            {scanning ? '扫描中...' : '🔍 开始扫描'}
                        </Button>
                    </div>
                    <Row gutter={16}>
                        <Col span={8}>
                            <div style={{ marginBottom: 8 }}>
                                <Text style={{ fontSize: 13 }}>SUID/SGID 目录</Text>
                            </div>
                            <Input
                                value={scanDirs.suid}
                                onChange={(e) => setScanDirs({ ...scanDirs, suid: e.target.value })}
                                placeholder="/usr /bin /sbin"
                            />
                        </Col>
                        <Col span={8}>
                            <div style={{ marginBottom: 8 }}>
                                <Text style={{ fontSize: 13 }}>Web目录</Text>
                            </div>
                            <Input
                                value={scanDirs.webroot}
                                onChange={(e) => setScanDirs({ ...scanDirs, webroot: e.target.value })}
                                placeholder="/var/www /www"
                            />
                        </Col>
                        <Col span={8}>
                            <div style={{ marginBottom: 8 }}>
                                <Text style={{ fontSize: 13 }}>临时目录</Text>
                            </div>
                            <Input
                                value={scanDirs.temp}
                                onChange={(e) => setScanDirs({ ...scanDirs, temp: e.target.value })}
                                placeholder="/tmp /var/tmp"
                            />
                        </Col>
                    </Row>
                </Card>

                {/* 扫描中状态 */}
                {scanning && (
                    <Card style={{ textAlign: 'center', padding: 40 }}>
                        <Spin size="large" />
                        <div style={{ marginTop: 16 }}>
                            <Text style={{ fontSize: 16 }}>正在扫描文件系统...</Text>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <Text type="secondary">这可能需要几秒钟时间</Text>
                        </div>
                    </Card>
                )}

                {/* 结构化发现列表 */}
                {!scanning && findings.length > 0 && (
                    <Card
                        className={cardClass}
                        title="可疑文件明细"
                        extra={<Tag color="red">{findings.length} 个发现</Tag>}
                    >
                        <Table
                            dataSource={findings}
                            columns={[
                                { title: '分类', dataIndex: 'category', width: 160 },
                                {
                                    title: '风险',
                                    dataIndex: 'risk',
                                    width: 90,
                                    render: (value: string, record: any) => <Tag color={record.riskColor}>{value}</Tag>,
                                },
                                { title: '文件名', dataIndex: 'file', width: 180, ellipsis: true },
                                { title: '目录', dataIndex: 'directory', width: 240, ellipsis: true, render: (value: string) => <Text code>{value}</Text> },
                                { title: '原因', dataIndex: 'reason', width: 260, ellipsis: true },
                                { title: '完整路径', dataIndex: 'path', ellipsis: true, render: (value: string) => <Text code>{value}</Text> },
                                {
                                    title: '操作',
                                    key: 'action',
                                    width: 90,
                                    render: (_: any, record: any) => (
                                        <Button
                                            type="link"
                                            size="small"
                                            icon={<EyeOutlined />}
                                            onClick={() => openFilePreview({ name: record.file, fullPath: record.path, isDir: false })}
                                        >
                                            查看
                                        </Button>
                                    ),
                                },
                            ]}
                            pagination={{ pageSize: 10 }}
                            size="small"
                            scroll={{ x: 1100 }}
                        />
                    </Card>
                )}

                {/* 结果列表 */}
                {!scanning && sections.map((section, idx) => (
                    <Card
                        key={idx}
                        className={cardClass}
                        title={<span style={{ color: section.color, fontSize: 15 }}>{section.title}</span>}
                        extra={<Tag color={section.files.length > 0 ? 'red' : 'green'}>{section.files.length} 个</Tag>}
                        style={{ borderRadius: 8 }}
                    >
                        {section.files.length > 0 ? (
                            <List
                                dataSource={section.files}
                                renderItem={(file) => (
                                    <List.Item
                                        style={{ padding: '12px 0' }}
                                        actions={[
                                            <Button
                                                type="link"
                                                icon={<EyeOutlined />}
                                                onClick={() => openFilePreview({ name: file.split('/').pop() || file, fullPath: file, isDir: false })}
                                            >
                                                查看
                                            </Button>
                                        ]}
                                    >
                                        <Text
                                            code
                                            style={{ fontSize: 15, cursor: 'pointer', color: '#1890ff' }}
                                            onClick={() => openFilePreview({ name: file.split('/').pop() || file, fullPath: file, isDir: false })}
                                        >
                                            {section.icon} {file}
                                        </Text>
                                    </List.Item>
                                )}
                            />
                        ) : (
                            <Text type="secondary" style={{ fontSize: 14 }}>✅ 未发现可疑文件</Text>
                        )}
                    </Card>
                ))}
                {!scanning && sections.length === 0 && !rawOutput && (
                    <Card style={{ textAlign: 'center', padding: 40 }}>
                        <Text type="secondary" style={{ fontSize: 15 }}>点击上方"开始扫描"按钮进行扫描</Text>
                    </Card>
                )}
            </div>
        );
    };

    // Webshell扫描结果渲染
    const renderWebshellScan = () => {
        if (!rawOutput) return <Text type="secondary">暂无数据</Text>;

        const sections: { title: string; matches: { file: string; line: string; content: string }[]; color: string }[] = [];
        const findings: {
            key: string;
            language: string;
            risk: string;
            rule: string;
            fileName: string;
            file: string;
            line: string;
            evidence: string;
        }[] = [];
        const lines = rawOutput.split('\n');
        let currentSection = '';
        let currentMatches: { file: string; line: string; content: string }[] = [];

        const sectionConfig: Record<string, { title: string; language: string; color: string }> = {
            '===PHP===': { title: '🐘 PHP Webshell', language: 'PHP', color: '#8b5cf6' },
            '===JSP===': { title: '☕ JSP Webshell', language: 'JSP', color: '#f97316' },
            '===ASP===': { title: '🔷 ASP Webshell', language: 'ASP', color: '#3b82f6' },
        };

        const detectWebshellRule = (content: string) => {
            const lower = content.toLowerCase();
            if (lower.includes('processbuilder')) return 'ProcessBuilder';
            if (lower.includes('runtime.getruntime')) return 'Runtime.getRuntime';
            if (lower.includes('base64_decode')) return 'base64_decode';
            if (lower.includes('shell_exec')) return 'shell_exec';
            if (lower.includes('system(')) return 'system';
            if (lower.includes('exec(')) return 'exec';
            if (lower.includes('eval')) return 'eval';
            if (lower.includes('wscript')) return 'WScript';
            if (lower.includes('execute')) return 'execute';
            return 'suspicious-pattern';
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (sectionConfig[trimmed]) {
                if (currentSection && currentMatches.length > 0) {
                    const cfg = sectionConfig[currentSection];
                    sections.push({ ...cfg, matches: [...currentMatches] });
                }
                currentSection = trimmed;
                currentMatches = [];
            } else if (trimmed && currentSection) {
                // 格式: file:line:content
                const match = trimmed.match(/^(.+?):(\d+):(.*)$/);
                if (match) {
                    currentMatches.push({ file: match[1], line: match[2], content: match[3] });
                    const cfg = sectionConfig[currentSection];
                    const fileName = getPathBaseName(match[1]);
                    findings.push({
                        key: `${currentSection}-${findings.length}`,
                        language: cfg.language,
                        risk: '高危',
                        rule: detectWebshellRule(match[3]),
                        fileName,
                        file: match[1],
                        line: match[2],
                        evidence: match[3],
                    });
                }
            }
        }
        if (currentSection && currentMatches.length > 0) {
            const cfg = sectionConfig[currentSection];
            sections.push({ ...cfg, matches: [...currentMatches] });
        }

        const totalMatches = sections.reduce((sum, s) => sum + s.matches.length, 0);

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* 扫描配置区域 */}
                <Card
                    className={cardClass}
                    style={{
                        background: isDarkMode ? (glassEnabled ? 'rgba(250, 173, 20, 0.1)' : '#2b2111') : '#fff7e6',
                        border: `1px solid ${isDarkMode ? '#594214' : '#ffd591'}`,
                        borderRadius: 12
                    }}
                    bodyStyle={{ padding: 20 }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <Text strong style={{ fontSize: 16, color: '#fa8c16' }}>🛡️ Webshell扫描配置</Text>
                        <Button
                            type="primary"
                            loading={scanning}
                            onClick={() => loadRemoteData()}
                            style={{ background: '#fa8c16', borderColor: '#fa8c16' }}
                        >
                            {scanning ? '扫描中...' : '🔍 开始扫描'}
                        </Button>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                        <Text style={{ fontSize: 13 }}>Web目录 (多个目录用空格分隔)</Text>
                    </div>
                    <Input
                        value={scanDirs.webroot}
                        onChange={(e) => setScanDirs({ ...scanDirs, webroot: e.target.value })}
                        placeholder="/var/www /www /home/wwwroot"
                        style={{ fontSize: 14 }}
                    />
                    <div style={{ marginTop: 12 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            💡 常见目录: /var/www, /www, /home/wwwroot, /opt/lampp/htdocs
                        </Text>
                    </div>
                </Card>

                {/* 扫描中状态 */}
                {scanning && (
                    <Card style={{ textAlign: 'center', padding: 40 }}>
                        <Spin size="large" />
                        <div style={{ marginTop: 16 }}>
                            <Text style={{ fontSize: 16 }}>正在扫描Webshell特征...</Text>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <Text type="secondary">这可能需要几秒钟时间</Text>
                        </div>
                    </Card>
                )}

                {/* 结果统计 */}
                {!scanning && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Tag color={totalMatches > 0 ? 'red' : 'green'} style={{ fontSize: 15, padding: '6px 16px' }}>
                            {totalMatches > 0 ? `⚠️ 发现 ${totalMatches} 处可疑代码` : '✅ 未发现Webshell'}
                        </Tag>
                    </div>
                )}

                {!scanning && findings.length > 0 && (
                    <Card
                        className={cardClass}
                        title="Webshell命中明细"
                        extra={<Tag color="red">{findings.length} 个命中</Tag>}
                    >
                        <Table
                            dataSource={findings}
                            columns={[
                                { title: '语言', dataIndex: 'language', width: 90, render: (value: string) => <Tag color="purple">{value}</Tag> },
                                { title: '风险', dataIndex: 'risk', width: 90, render: (value: string) => <Tag color="red">{value}</Tag> },
                                { title: '规则', dataIndex: 'rule', width: 150 },
                                { title: '文件名', dataIndex: 'fileName', width: 180, ellipsis: true },
                                { title: '行号', dataIndex: 'line', width: 90 },
                                { title: '文件路径', dataIndex: 'file', width: 280, ellipsis: true, render: (value: string) => <Text code>{value}</Text> },
                                { title: '证据片段', dataIndex: 'evidence', ellipsis: true, render: (value: string) => <Text code>{value}</Text> },
                                {
                                    title: '操作',
                                    key: 'action',
                                    width: 100,
                                    render: (_: any, record: any) => (
                                        <Button
                                            type="link"
                                            size="small"
                                            icon={<EyeOutlined />}
                                            onClick={() => openFilePreview({ name: record.fileName, fullPath: record.file, isDir: false })}
                                        >
                                            查看文件
                                        </Button>
                                    ),
                                },
                            ]}
                            pagination={{ pageSize: 10 }}
                            size="small"
                            scroll={{ x: 1250 }}
                        />
                    </Card>
                )}

                {/* 结果列表 */}
                {!scanning && sections.map((section, idx) => (
                    <Card key={idx} size="small" title={<span style={{ color: section.color }}>{section.title} ({section.matches.length})</span>}>
                        {section.matches.length > 0 ? (
                            <List
                                size="small"
                                dataSource={section.matches}
                                renderItem={(m) => (
                                    <List.Item
                                        style={{ display: 'block', padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}
                                        actions={[
                                            <Button
                                                type="link"
                                                icon={<EyeOutlined />}
                                                onClick={() => openFilePreview({ name: getPathBaseName(m.file), fullPath: m.file, isDir: false })}
                                            >
                                                查看文件
                                            </Button>
                                        ]}
                                    >
                                        <div style={{ marginBottom: 8 }}>
                                            <Text
                                                strong
                                                style={{ color: '#1890ff', fontSize: 15, cursor: 'pointer' }}
                                                onClick={() => openFilePreview({ name: getPathBaseName(m.file), fullPath: m.file, isDir: false })}
                                            >
                                                {m.file}
                                            </Text>
                                            <Tag color="orange" style={{ marginLeft: 12 }}>行 {m.line}</Tag>
                                        </div>
                                        <pre style={{
                                            margin: '8px 0 0 0',
                                            fontSize: 12,
                                            background: '#1a1a1a',
                                            color: '#ff6b6b',
                                            padding: 12,
                                            borderRadius: 6,
                                            overflow: 'auto',
                                            maxHeight: 200
                                        }}>
                                            {m.content}
                                        </pre>
                                    </List.Item>
                                )}
                            />
                        ) : (
                            <Text type="secondary">未发现</Text>
                        )}
                    </Card>
                ))}
            </div>
        );
    };

    // 宝塔面板(BaoTa Panel)渲染 - 全面增强版
    const renderBaoTaPanel = () => {
        let panelData: any = null;
        let parseError = false;

        try {
            panelData = JSON.parse(rawOutput || '{}');
        } catch {
            parseError = true;
        }

        const { config = [], users = [], sites = [], databases = [], ftps = [], tasks = [], crontabs = [], firewall = [], logs = [], panelLogs = [] } = panelData || {};

        // 检查是否有宝塔面板 - 增加更多条件
        const hasPanel = config.length > 0 || sites.length > 0 || users.length > 0 || databases.length > 0 ||
            tasks.length > 0 || logs.length > 0 || crontabs.length > 0 || firewall.length > 0 ||
            ftps.length > 0 || panelLogs.length > 0;

        // 如果解析失败或无数据，尝试检查原始输出是否包含宝塔相关内容
        // 注意：不能仅检查 'BT_' 标记，因为脚本总会输出这些标记，即使宝塔未安装
        // 需要检查标记后是否有实际数据，或者检查路径是否实际存在
        const rawHasPanel = rawOutput && (
            rawOutput.includes('/www/server/panel') ||
            rawOutput.includes('宝塔') ||
            // 检查是否有非空的宝塔数据（标记后跟着实际内容，而不是直接跟着下一个标记）
            (rawOutput.includes('BT_PORT=') && !rawOutput.includes('BT_PORT=---'))
        );

        if (!hasPanel && !rawHasPanel) {
            return (
                <Card>
                    <Empty
                        description={
                            <span>
                                未检测到宝塔面板<br />
                                <Text type="secondary" style={{ fontSize: 12 }}>请确保目标服务器安装了宝塔面板 (/www/server/panel)</Text>
                            </span>
                        }
                    />
                </Card>
            );
        }

        // 如果解析失败但有原始数据，显示原始输出用于调试
        if (!hasPanel && rawHasPanel) {
            return (
                <Card className={cardClass} title="宝塔面板 - 原始数据">
                    <Text type="warning" style={{ display: 'block', marginBottom: 12 }}>
                        检测到宝塔面板但解析失败，可能是 sqlite3 未安装或数据库格式不兼容。以下是原始输出：
                    </Text>
                    <pre style={{
                        background: '#1a1a2e',
                        color: '#e0e0e0',
                        padding: 16,
                        borderRadius: 8,
                        maxHeight: 500,
                        overflow: 'auto',
                        fontSize: 11,
                        fontFamily: 'Consolas, monospace',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all'
                    }}>
                        {rawOutput}
                    </pre>
                </Card>
            );
        }

        // 站点表格列
        const siteColumns = [
            { title: 'ID', dataIndex: 'id', key: 'id', width: 50 },
            { title: '站点名称', dataIndex: 'name', key: 'name', render: (v: string) => <Text strong style={{ color: '#1890ff' }}>{v}</Text> },
            { title: '路径', dataIndex: 'path', key: 'path', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
            { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (v: string) => <Tag color={v === '1' ? 'green' : 'red'}>{v === '1' ? '运行中' : '已停止'}</Tag> },
            { title: '大小', dataIndex: 'size', key: 'size', width: 100 },
            { title: '最后修改', dataIndex: 'lastModified', key: 'lastModified', width: 130 },
            { title: '备注', dataIndex: 'ps', key: 'ps', ellipsis: true },
            { title: '创建时间', dataIndex: 'addtime', key: 'addtime', width: 120 },
        ];

        // 数据库表格列
        const dbColumns = [
            { title: 'ID', dataIndex: 'id', key: 'id', width: 50 },
            { title: '数据库名', dataIndex: 'name', key: 'name', render: (v: string) => <Tag color="blue">{v}</Tag> },
            { title: '用户名', dataIndex: 'username', key: 'username' },
            { title: '密码', dataIndex: 'password', key: 'password', render: (v: string) => <Text copyable code style={{ fontSize: 11 }}>{v || '-'}</Text> },
            { title: '访问控制', dataIndex: 'accept', key: 'accept', width: 100, render: (v: string) => <Tag color={v === '127.0.0.1' ? 'orange' : 'green'}>{v}</Tag> },
            { title: '备注', dataIndex: 'ps', key: 'ps', ellipsis: true },
        ];

        // FTP表格列
        const ftpColumns = [
            { title: 'ID', dataIndex: 'id', key: 'id', width: 50 },
            { title: 'FTP账号', dataIndex: 'name', key: 'name', render: (v: string) => <Tag color="purple">{v}</Tag> },
            { title: '路径', dataIndex: 'path', key: 'path', ellipsis: true },
            { title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (v: string) => <Tag color={v === '1' ? 'green' : 'red'}>{v === '1' ? '启用' : '禁用'}</Tag> },
            { title: '备注', dataIndex: 'ps', key: 'ps', ellipsis: true },
        ];

        // 任务表格列
        const taskColumns = [
            { title: '序号', dataIndex: 'id', key: 'id', width: 60 },
            { title: '任务名', dataIndex: 'name', key: 'name', width: 200, render: (v: string) => <Text ellipsis style={{ maxWidth: 180 }} title={v}>{v}</Text> },
            { title: '任务类型', dataIndex: 'type', key: 'type', width: 100, render: (v: string) => <Tag color="geekblue">{v || 'execshell'}</Tag> },
            {
                title: '状态', dataIndex: 'status', key: 'status', width: 80, render: (v: string) => {
                    const statusMap: any = { '1': { text: '已完成', color: 'green' }, '0': { text: '执行中', color: 'blue' }, '-1': { text: '失败', color: 'red' } };
                    const s = statusMap[v] || { text: v || '-', color: 'default' };
                    return <Tag color={s.color}>{s.text}</Tag>;
                }
            },
            { title: '开始时间', dataIndex: 'start', key: 'start', width: 150 },
            { title: '结束时间', dataIndex: 'end', key: 'end', width: 150 },
            { title: 'Shell命令', dataIndex: 'execstr', key: 'execstr', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 10, wordBreak: 'break-all' }}>{v || '-'}</Text> },
        ];

        // 计划任务表格列
        const cronColumns = [
            { title: 'ID', dataIndex: 'id', key: 'id', width: 50 },
            { title: '任务名称', dataIndex: 'name', key: 'name', ellipsis: true },
            { title: '类型', dataIndex: 'type', key: 'type', width: 100, render: (v: string) => <Tag color="cyan">{v}</Tag> },
            { title: '状态', dataIndex: 'status', key: 'status', width: 70, render: (v: string) => <Tag color={v === '1' ? 'green' : 'orange'}>{v === '1' ? '启用' : '禁用'}</Tag> },
            { title: '执行周期', key: 'period', width: 120, render: (_: any, r: any) => <Text type="secondary">{r.where1 || '*'} {r.hour || '*'}:{r.minute || '*'}</Text> },
            { title: '脚本名', dataIndex: 'sName', key: 'sName', width: 100 },
            { title: '执行脚本', dataIndex: 'sBody', key: 'sBody', ellipsis: true, render: (v: string) => <Text code style={{ fontSize: 10 }}>{v || '-'}</Text> },
        ];

        // 防火墙表格列
        const firewallColumns = [
            { title: 'ID', dataIndex: 'id', key: 'id', width: 50 },
            { title: '端口', dataIndex: 'port', key: 'port', width: 100, render: (v: string) => <Tag color="volcano">{v}</Tag> },
            { title: '类型', dataIndex: 'type', key: 'type', width: 80, render: (v: string) => <Tag color={v === 'tcp' ? 'blue' : 'green'}>{v || 'tcp'}</Tag> },
            { title: '备注', dataIndex: 'ps', key: 'ps', ellipsis: true },
            { title: '添加时间', dataIndex: 'addtime', key: 'addtime', width: 150 },
        ];

        // 操作日志表格列
        const logColumns = [
            { title: '序号', dataIndex: 'id', key: 'id', width: 60 },
            {
                title: '日志类型', dataIndex: 'type', key: 'type', width: 120, render: (v: string) => {
                    const typeMap: any = { 'SSH管理': 'purple', '网站管理': 'blue', '数据库管理': 'cyan', '防火墙管理': 'volcano', '用户登录': 'green', '安装器': 'geekblue', '计划任务': 'orange' };
                    return <Tag color={typeMap[v] || 'default'}>{v}</Tag>;
                }
            },
            { title: '日志描述', dataIndex: 'log', key: 'log', ellipsis: true },
            { title: '时间', dataIndex: 'addtime', key: 'addtime', width: 180 },
        ];

        const tabItems = [
            {
                key: 'config',
                label: <span>⚙️ 面板配置</span>,
                children: config.length > 0 ? (
                    <Table
                        dataSource={config.map((c: any, i: number) => ({ ...c, key: i }))}
                        columns={[
                            { title: '序号', key: 'idx', width: 60, render: (_: any, __: any, idx: number) => idx + 1 },
                            { title: '配置项', dataIndex: 'label', key: 'label', width: 180 },
                            {
                                title: '值', dataIndex: 'value', key: 'value', render: (v: string, r: any) => {
                                    if (r.key === 'password_hash' || r.key === 'salt') {
                                        return <Text copyable code style={{ fontSize: 11, wordBreak: 'break-all' }}>{v}</Text>;
                                    }
                                    if (r.key === 'basicauth') {
                                        return <Tag color={v === '已启用' ? 'green' : 'orange'}>{v}</Tag>;
                                    }
                                    return <Text strong>{v}</Text>;
                                }
                            },
                        ]}
                        size="small"
                        pagination={false}
                    />
                ) : <Empty description="无配置信息" />,
            },
            {
                key: 'sites',
                label: <span>🌐 站点 ({sites.length})</span>,
                children: sites.length > 0 ? (
                    <Table dataSource={sites} columns={siteColumns} size="small" pagination={{ pageSize: 10 }} rowKey="key" />
                ) : <Empty description="无站点数据" />,
            },
            {
                key: 'databases',
                label: <span>🗄️ 数据库 ({databases.length})</span>,
                children: databases.length > 0 ? (
                    <Table dataSource={databases} columns={dbColumns} size="small" pagination={{ pageSize: 10 }} rowKey="key" />
                ) : <Empty description="无数据库数据" />,
            },
            {
                key: 'ftps',
                label: <span>📁 FTP ({ftps.length})</span>,
                children: ftps.length > 0 ? (
                    <Table dataSource={ftps} columns={ftpColumns} size="small" pagination={{ pageSize: 10 }} rowKey="key" />
                ) : <Empty description="无FTP账号" />,
            },
            {
                key: 'tasks',
                label: <span>📋 任务状态 ({tasks.length})</span>,
                children: tasks.length > 0 ? (
                    <Table dataSource={tasks} columns={taskColumns} size="small" pagination={{ pageSize: 15 }} rowKey="key" scroll={{ x: 900 }} />
                ) : <Empty description="无任务记录" />,
            },
            {
                key: 'crontabs',
                label: <span>⏰ 计划任务 ({crontabs.length})</span>,
                children: crontabs.length > 0 ? (
                    <Table dataSource={crontabs} columns={cronColumns} size="small" pagination={{ pageSize: 10 }} rowKey="key" scroll={{ x: 800 }} />
                ) : <Empty description="无计划任务" />,
            },
            {
                key: 'firewall',
                label: <span>🔥 防火墙 ({firewall.length})</span>,
                children: firewall.length > 0 ? (
                    <Table dataSource={firewall} columns={firewallColumns} size="small" pagination={{ pageSize: 10 }} rowKey="key" />
                ) : <Empty description="无防火墙规则" />,
            },
            {
                key: 'logs',
                label: <span>📝 面板日志 ({logs.length})</span>,
                children: logs.length > 0 ? (
                    <Table dataSource={logs} columns={logColumns} size="small" pagination={{ pageSize: 15 }} rowKey="key" />
                ) : <Empty description="无操作日志" />,
            },
            {
                key: 'panel_logs',
                label: <span>🐛 错误日志</span>,
                children: panelLogs.length > 0 ? (
                    <pre style={{
                        background: '#0d1117',
                        color: '#c9d1d9',
                        padding: 16,
                        borderRadius: 8,
                        maxHeight: 400,
                        overflow: 'auto',
                        fontSize: 11,
                        fontFamily: 'JetBrains Mono, Consolas, monospace',
                        lineHeight: 1.6
                    }}>
                        {panelLogs.map((line: string, i: number) => {
                            let color = '#c9d1d9';
                            const lower = line.toLowerCase();
                            if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception')) color = '#f85149';
                            else if (lower.includes('warning') || lower.includes('warn')) color = '#d29922';
                            else if (lower.includes('info')) color = '#58a6ff';
                            else if (lower.includes('debug')) color = '#8b949e';
                            return <div key={i} style={{ color }}>{line}</div>;
                        })}
                    </pre>
                ) : <Empty description="无错误日志" />,
            },
        ];

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* 概览统计卡片 - 浅色简洁风格 */}
                <Card size="small" style={{ background: '#fafafa', border: '1px solid #f0f0f0' }}>
                    <Row gutter={16}>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>配置项</span>} value={config.length} valueStyle={{ color: '#333', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>站点</span>} value={sites.length} valueStyle={{ color: '#52c41a', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>数据库</span>} value={databases.length} valueStyle={{ color: '#1890ff', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>FTP</span>} value={ftps.length} valueStyle={{ color: '#722ed1', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>任务</span>} value={tasks.length} valueStyle={{ color: '#faad14', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>计划任务</span>} value={crontabs.length} valueStyle={{ color: '#13c2c2', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>防火墙</span>} value={firewall.length} valueStyle={{ color: '#eb2f96', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                        <Col span={3}>
                            <Statistic title={<span style={{ color: '#666' }}>操作日志</span>} value={logs.length} valueStyle={{ color: '#fa8c16', fontWeight: '500', fontSize: 20 }} />
                        </Col>
                    </Row>
                </Card>

                {/* 详细信息标签页 */}
                <Card bodyStyle={{ padding: '12px 16px' }}>
                    <Tabs items={tabItems} size="small" defaultActiveKey={sites.length > 0 ? 'sites' : 'config'} />
                </Card>
            </div>
        );
    };

    // 探索数据库下的表
    const exploreDatabase = async (dbName: string) => {
        setDbSelectedDb(dbName);
        setDbSelectedTable('');
        setDbTablesList([]);
        setDbExplorerLoading(true);
        try {
            // 获取数据库下的所有表名
            // 从rawOutput获取密码和数据目录
            const sections = splitCommandSections(rawOutput);
            const pwd = sections['MYSQL_ROOT_PWD'] || '';
            // 改进 datadir 解析，匹配多种格式
            const datadir = parseMysqlDatadir(sections['MYSQL_DATADIR'] || '') || '/www/server/data';

            let cmd = `MYSQL_PWD='${pwd}' mysql -u root -e "SHOW TABLES FROM \\\`${dbName}\\\`;" 2>/dev/null`;
            if (!pwd) cmd = `mysql -u root -e "SHOW TABLES FROM \\\`${dbName}\\\`;" 2>/dev/null`;

            const output = await executeCommand(cmd);
            let tables = output.split('\n')
                .filter(l => l.trim() && !l.toLowerCase().includes('tables_in_') && !l.includes('+--'))
                .map(l => l.replace(/\|/g, '').trim())
                .filter(Boolean);

            // 如果 SQL 方式获取失败，尝试列目录 fallback
            if (tables.length === 0) {
                // MySQL 8.0 不再有 .frm，主要扫描 .ibd 和 .myi
                const fallbackCmd = `ls -p "${datadir}/${dbName}" 2>/dev/null | grep -v / | grep -E "\\.(frm|ibd|myi)$" | sed 's/\\.[^.]*$//' | sort -u`;
                const fallbackOutput = await executeCommand(fallbackCmd);
                tables = fallbackOutput.split('\n').map(l => l.trim()).filter(Boolean);
            }

            setDbTablesList(tables);
        } catch (e) {
            message.error('获取表格列表失败');
        } finally {
            setDbExplorerLoading(false);
        }
    };

    // 探索表下的字段和数据预览
    const exploreTable = async (dbName: string, tableName: string) => {
        setDbSelectedTable(tableName);
        setDbColumnsList([]);
        setDbTableData([]);
        setDbExplorerLoading(true);
        try {
            // 从rawOutput获取密码
            const parts = rawOutput.split(/===([\w_]+)===/);
            const sections: { [key: string]: string } = {};
            for (let i = 1; i < parts.length; i += 2) {
                sections[parts[i]] = parts[i + 1]?.trim() || '';
            }
            const pwd = sections['MYSQL_ROOT_PWD'] || '';

            // 获取字段信息
            let colCmd = `MYSQL_PWD='${pwd}' mysql -u root -e "SHOW COLUMNS FROM \\\`${dbName}\\\`.\\\`${tableName}\\\`;" 2>/dev/null`;
            if (!pwd) colCmd = `mysql -u root -e "SHOW COLUMNS FROM \\\`${dbName}\\\`.\\\`${tableName}\\\`;" 2>/dev/null`;

            const colOutput = await executeCommand(colCmd);
            const columns = colOutput.split('\n')
                .filter(l => l.trim() && !l.toLowerCase().includes('field') && !l.includes('+--'))
                .map(line => {
                    const row = line.replace(/\|/g, '').trim();
                    const p = row.split(/\s+/).filter(Boolean);
                    return {
                        name: p[0],
                        type: p[1],
                        null: p[2],
                        key: p[3],
                        default: p[4],
                        extra: p[5]
                    };
                }).filter(c => c.name);
            setDbColumnsList(columns);

            // 获取前10条数据预览
            let dataCmd = `MYSQL_PWD='${pwd}' mysql -u root -e "SELECT * FROM \\\`${dbName}\\\`.\\\`${tableName}\\\` LIMIT 10;" 2>/dev/null`;
            if (!pwd) dataCmd = `mysql -u root -e "SELECT * FROM \\\`${dbName}\\\`.\\\`${tableName}\\\` LIMIT 10;" 2>/dev/null`;

            const dataOutput = await executeCommand(dataCmd);
            const dataLines = dataOutput.split('\n').filter(l => l.trim() && !l.includes('+--'));
            if (dataLines.length > 0) {
                // MySQL 默认可能是用 | 分隔的，或者是 tab
                const isTab = dataLines[0].includes('\t');
                const header = isTab
                    ? dataLines[0].split('\t').map(h => h.trim())
                    : dataLines[0].split('|').map(h => h.trim()).filter(Boolean);

                const rows = dataLines.slice(1).map((line, idx) => {
                    const p = isTab
                        ? line.split('\t').map(v => v.trim())
                        : line.split('|').map(v => v.trim()).filter(Boolean);
                    const row: any = { key: idx };
                    header.forEach((h, i) => {
                        row[h] = p[i] || '';
                    });
                    return row;
                }).filter(r => Object.keys(r).length > 1);
                setDbTableData(rows);
            }
        } catch (e) {
            message.error('获取表数据失败');
        } finally {
            setDbExplorerLoading(false);
        }
    };

    // 数据库模块渲染
    const renderDatabase = () => {
        // 如果还在加载中
        if (loading) {
            return <Card><Spin tip="正在检测数据库..." /></Card>;
        }

        // 如果没有原始输出
        if (!rawOutput) {
            return <Card className={cardClass}><Empty description="未获取到数据库信息，请刷新重试" /></Card>;
        }

        // 直接从原始输出解析
        const sections = splitCommandSections(rawOutput);

        // 解析各数据库信息
        const mysql = {
            version: sections['MYSQL_VERSION']?.split('\n')[0] || '',
            status: sections['MYSQL_STATUS']?.includes('active (running)') ? '运行中' :
                sections['MYSQL_STATUS']?.includes('inactive') ? '已停止' :
                    sections['MYSQL_STATUS'] ? '未知' : '',
            statusRaw: sections['MYSQL_STATUS'] || '',
            rootPwd: sections['MYSQL_ROOT_PWD']?.trim() || '',
            databases: parseMysqlDatabases(sections['MYSQL_DATABASES'] || ''),
            users: parseMysqlUsers(sections['MYSQL_USERS'] || ''),
            datadir: parseMysqlDatadir(sections['MYSQL_DATADIR'] || '')
        };

        const mariadb = {
            version: sections['MARIADB_VERSION']?.split('\n')[0] || '',
            status: sections['MARIADB_STATUS']?.includes('active (running)') ? '运行中' :
                sections['MARIADB_STATUS']?.includes('inactive') ? '已停止' : ''
        };
        const postgresql = {
            version: sections['POSTGRESQL_VERSION']?.split('\n')[0] || '',
            status: sections['POSTGRESQL_STATUS']?.includes('active (running)') ? '运行中' :
                sections['POSTGRESQL_STATUS']?.includes('inactive') ? '已停止' : '',
            databases: (sections['POSTGRESQL_DATABASES'] || '').split('\n').filter(l => l.trim() && !l.includes('datname') && !l.includes('---')).map(l => l.trim()).filter(Boolean)
        };
        const redis = {
            version: sections['REDIS_VERSION']?.split('\n')[0] || '',
            status: sections['REDIS_STATUS']?.includes('active (running)') ? '运行中' :
                sections['REDIS_STATUS']?.includes('inactive') ? '已停止' : '',
            info: sections['REDIS_INFO'] || ''
        };
        const mongodb = {
            version: sections['MONGODB_VERSION']?.split('\n')[0] || '',
            status: sections['MONGODB_STATUS']?.includes('active (running)') ? '运行中' :
                sections['MONGODB_STATUS']?.includes('inactive') ? '已停止' : '',
            databases: sections['MONGODB_DATABASES'] ? (() => {
                try {
                    // 尝试匹配 JSON 部分
                    const jsonMatch = sections['MONGODB_DATABASES'].match(/\{.*\}/s);
                    if (jsonMatch) {
                        const data = JSON.parse(jsonMatch[0]);
                        return data.databases?.map((d: any) => d.name) || [];
                    }
                } catch (e) { console.error('Parse MongoDB databases failed', e); }
                return [];
            })() : []
        };

        const detectedDbs = [];
        if (mysql.version || mysql.status) detectedDbs.push({ name: 'MySQL', icon: '🐬', color: '#4479A1', data: mysql, type: 'mysql' });
        if (mariadb.version) detectedDbs.push({ name: 'MariaDB', icon: '🐬', color: '#003545', data: mariadb, type: 'mariadb' });
        if (postgresql.version || postgresql.status) detectedDbs.push({ name: 'PostgreSQL', icon: '🐘', color: '#336791', data: postgresql, type: 'postgresql' });
        if (redis.version || redis.status) detectedDbs.push({ name: 'Redis', icon: '🔴', color: '#DC382D', data: redis, type: 'redis' });
        if (mongodb.version || mongodb.status) detectedDbs.push({ name: 'MongoDB', icon: '🍃', color: '#47A248', data: mongodb, type: 'mongodb' });

        if (detectedDbs.length === 0) {
            return (
                <Card className={cardClass}><Empty description="未检测到数据库服务" /></Card>
            );
        }

        const tabItems = detectedDbs.map(db => ({
            key: db.type,
            label: (
                <span>
                    <span style={{ marginRight: 6 }}>{db.icon}</span>
                    {db.name}
                    {db.data.status && (
                        <Tag color={db.data.status === '运行中' ? 'green' : 'orange'} style={{ marginLeft: 8 }}>
                            {db.data.status}
                        </Tag>
                    )}
                </span>
            ),
            children: (
                <div style={{ padding: '16px 0' }}>
                    <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
                        <Descriptions.Item label="版本">{db.data.version || '-'}</Descriptions.Item>
                        <Descriptions.Item label="状态">
                            <Tag color={db.data.status === '运行中' ? 'green' : db.data.status === '已停止' ? 'red' : 'default'}>
                                {db.data.status || '未知'}
                            </Tag>
                        </Descriptions.Item>
                        {db.type === 'mysql' && mysql.rootPwd && (
                            <Descriptions.Item label="Root密码">
                                <Text code copyable>{mysql.rootPwd}</Text>
                            </Descriptions.Item>
                        )}
                        {db.type === 'mysql' && mysql.datadir && (
                            <Descriptions.Item label="数据目录">{mysql.datadir}</Descriptions.Item>
                        )}
                    </Descriptions>

                    {db.type === 'mysql' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <Row gutter={16}>
                                <Col span={8}>
                                    <Card className={cardClass} title="数据库列表" size="small" bodyStyle={{ padding: 0 }}>
                                        <Table
                                            dataSource={mysql.databases.map((name: string) => ({ key: name, name }))}
                                            columns={[{ title: '名称', dataIndex: 'name', key: 'name' }]}
                                            size="small"
                                            pagination={false}
                                            onRow={(record) => ({
                                                onClick: () => exploreDatabase(record.name),
                                                style: { cursor: 'pointer', background: dbSelectedDb === record.name ? '#e6f7ff' : 'inherit' }
                                            })}
                                            scroll={{ y: 300 }}
                                        />
                                    </Card>
                                </Col>
                                <Col span={16}>
                                    <Card
                                        className={cardClass}
                                        title={dbSelectedDb ? `表列表 - ${dbSelectedDb}` : '表列表'}
                                        size="small"
                                        bodyStyle={{ padding: 0 }}
                                        extra={<Spin spinning={dbExplorerLoading} size="small" />}
                                    >
                                        {!dbSelectedDb ? (
                                            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>请先选择数据库</div>
                                        ) : (
                                            <Table
                                                dataSource={dbTablesList.map((name: string) => ({ key: name, name }))}
                                                columns={[{ title: '表名', dataIndex: 'name', key: 'name' }]}
                                                size="small"
                                                pagination={false}
                                                onRow={(record) => ({
                                                    onClick: () => exploreTable(dbSelectedDb, record.name),
                                                    style: { cursor: 'pointer', background: dbSelectedTable === record.name ? '#f6ffed' : 'inherit' }
                                                })}
                                                scroll={{ y: 300 }}
                                            />
                                        )}
                                    </Card>
                                </Col>
                            </Row>

                            {dbSelectedTable && (
                                <Card
                                    className={cardClass}
                                    title={
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                            <span>数据浏览: {dbSelectedTable}</span>
                                            <Tag color="cyan">前10条数据</Tag>
                                        </div>
                                    }
                                    size="small"
                                    extra={<Spin spinning={dbExplorerLoading} size="small" />}
                                >
                                    {dbTableData.length === 0 && dbColumnsList.length === 0 ? (
                                        <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
                                            <p>无法获取表内容</p>
                                            <Text type="secondary">可能原因：权限不足、数据库为空或需要Root密码</Text>
                                        </div>
                                    ) : (
                                        <Tabs size="small" items={[
                                            {
                                                key: 'data',
                                                label: '数据预览',
                                                children: (
                                                    <Table
                                                        dataSource={dbTableData}
                                                        columns={dbTableData.length > 0 ? Object.keys(dbTableData[0]).filter(k => k !== 'key').map(k => ({
                                                            title: k,
                                                            dataIndex: k,
                                                            key: k,
                                                            ellipsis: true
                                                        })) : []}
                                                        size="small"
                                                        scroll={{ x: 'max-content' }}
                                                        locale={{ emptyText: '暂无数据或权限不足' }}
                                                    />
                                                )
                                            },
                                            {
                                                key: 'columns',
                                                label: '结构',
                                                children: (
                                                    <Table
                                                        dataSource={dbColumnsList}
                                                        columns={[
                                                            { title: '字段', dataIndex: 'name', key: 'name' },
                                                            { title: '类型', dataIndex: 'type', key: 'type' },
                                                            { title: '为空', dataIndex: 'null', key: 'null' },
                                                            { title: '键', dataIndex: 'key', key: 'key' },
                                                            { title: '默认值', dataIndex: 'default', key: 'default' },
                                                            { title: '额外', dataIndex: 'extra', key: 'extra' },
                                                        ]}
                                                        size="small"
                                                        pagination={false}
                                                        locale={{ emptyText: '无法获取表结构' }}
                                                    />
                                                )
                                            }
                                        ]} />
                                    )}
                                </Card>
                            )}

                            {mysql.users.length > 0 && (
                                <Card className={cardClass} title="用户权限" size="small">
                                    <Table
                                        dataSource={mysql.users}
                                        columns={[
                                            { title: '用户', dataIndex: 'user', key: 'user' },
                                            { title: '主机', dataIndex: 'host', key: 'host' }
                                        ]}
                                        size="small"
                                        pagination={false}
                                    />
                                </Card>
                            )}
                        </div>
                    )}

                    {db.type !== 'mysql' && (
                        <div>
                            {db.type === 'postgresql' && postgresql.databases.length > 0 && (
                                <Card title="数据库列表" size="small">
                                    <List
                                        size="small"
                                        dataSource={postgresql.databases}
                                        renderItem={item => <List.Item>{item}</List.Item>}
                                    />
                                </Card>
                            )}
                            {db.type === 'redis' && redis.info && (
                                <Card className={cardClass} title="Redis Info" size="small">
                                    <pre style={{
                                        background: '#f5f5f5', padding: 12, borderRadius: 6,
                                        maxHeight: 300, overflow: 'auto', fontSize: 11, margin: 0
                                    }}>
                                        {redis.info}
                                    </pre>
                                </Card>
                            )}
                            {db.type === 'mongodb' && mongodb.databases.length > 0 && (
                                <Card title="数据库列表" size="small">
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {mongodb.databases.map((name: string, i: number) => (
                                            <Tag key={i} color="green">{name}</Tag>
                                        ))}
                                    </div>
                                </Card>
                            )}
                        </div>
                    )}
                </div>
            )
        }));

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card size="small" style={{ background: '#fafafa', border: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: detectedDbs.length > 0 ? 16 : 0 }}>
                        <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <DatabaseOutlined /> 数据库检测概览
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, color: '#666' }}>显示原始输出 (调试)</span>
                            <Switch size="small" checked={dbShowDebug} onChange={setDbShowDebug} />
                        </div>
                    </div>
                    {dbShowDebug && (
                        <Card
                            size="small"
                            className={cardClass}
                            style={{ marginBottom: 16, border: `1px dashed ${borderColor}` }}
                            bodyStyle={{ padding: 0 }}
                        >
                            <pre style={{ margin: 0, padding: 12, background: '#f8f8f8', fontSize: 11, maxHeight: 300, overflow: 'auto' }}>
                                {rawOutput}
                            </pre>
                        </Card>
                    )}
                    <Row gutter={24}>
                        {detectedDbs.map(db => (
                            <Col key={db.type} span={Math.min(6, Math.floor(24 / detectedDbs.length))}>
                                <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontSize: 28, marginBottom: 4 }}>{db.icon}</div>
                                    <div style={{ fontWeight: 500, color: db.color }}>{db.name}</div>
                                    <Tag color={db.data.status === '运行中' ? 'green' : db.data.status === '已停止' ? 'red' : 'default'} style={{ marginTop: 4 }}>
                                        {db.data.status || '已检测'}
                                    </Tag>
                                </div>
                            </Col>
                        ))}
                    </Row>
                </Card>
                <Card bodyStyle={{ padding: '12px 16px' }}>
                    <Tabs items={tabItems} />
                </Card>
            </div>
        );
    };

    const renderCollectionDiagnostic = () => {
        if (!collectionDiagnostic) return null;
        const tagColor = collectionDiagnostic.severity === 'error'
            ? 'red'
            : collectionDiagnostic.severity === 'warning'
                ? 'orange'
                : 'blue';
        const alertType = collectionDiagnostic.severity === 'error'
            ? 'error'
            : collectionDiagnostic.severity === 'warning'
                ? 'warning'
                : 'info';
        const evidenceText = compactEvidence(collectionDiagnostic.evidence.join('\n\n'), 1600);

        return (
            <Card
                className={cardClass}
                title={(
                    <Space size={8}>
                        <span>{DIAGNOSTIC_TITLE}</span>
                        <Tag color={tagColor}>{collectionDiagnostic.reason}</Tag>
                    </Space>
                )}
                style={{ marginTop: 8, borderRadius: 8 }}
                styles={{ body: { padding: 16 } }}
            >
                <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                    <Alert
                        type={alertType as any}
                        showIcon
                        title={collectionDiagnostic.suggestion}
                        style={{ borderRadius: 6 }}
                    />
                    {evidenceText && (
                        <details>
                            <summary style={{ cursor: 'pointer', color: isDarkMode ? '#9ca3af' : '#4b5563' }}>
                                {DIAGNOSTIC_EVIDENCE_SUMMARY}
                            </summary>
                            <pre style={{
                                marginTop: 10,
                                marginBottom: 0,
                                maxHeight: 240,
                                overflow: 'auto',
                                padding: 12,
                                borderRadius: 6,
                                border: `1px solid ${isDarkMode ? '#30363d' : '#e5e7eb'}`,
                                background: isDarkMode ? '#0d1117' : '#f8fafc',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                fontSize: 12,
                            }}>
                                {evidenceText}
                            </pre>
                        </details>
                    )}
                </Space>
            </Card>
        );
    };

    const renderWindowsToolbar = () => {
        if (!showSearch) return null;

        const supportsFullWindowsLogExport = isWindowsLocalMode
            && (moduleKey === 'security_events' || Boolean(windowsEventLogModuleNames[moduleKey]));

        const openCollectionArtifact = async () => {
            if (!collectionArtifact?.path) return;

            try {
                await revealItemInDir(collectionArtifact.path);
            } catch (error) {
                message.error(`打开采集文件失败: ${error}`);
            }
        };

        const exportFullWindowsCollection = async () => {
            const startTimeExpression = timeRange && timeRange !== 'all'
                ? windowsLogTimeRangeStartExpressions[timeRange]
                : undefined;
            const command = getWindowsFullCollectionCommand(moduleKey, startTimeExpression);
            if (!command) return;

            setFullCollectionLoading(true);
            setFullCollectionProgress(6);
            setFullCollectionStage('准备加载全部日志...');
            message.loading({ content: '正在加载全部日志到本地缓存...', key: 'windows-full-log-export', duration: 0 });
            const progressTimer = window.setInterval(() => {
                setFullCollectionProgress((previous) => {
                    if (previous >= 95) return previous;
                    return Math.min(95, previous + Math.max(1, Math.round((96 - previous) * 0.08)));
                });
            }, 500);
            try {
                setFullCollectionStage('正在读取事件日志并写入临时缓存...');
                const output = await executeRemoteCommand(command);
                setRawOutput(output);
                parseAndSetData(moduleKey, output);

                const parsed = JSON.parse(output);
                const { artifact } = readArtifactPreview(parsed);
                setFullCollectionProgress(100);
                setFullCollectionStage('加载完成，分页将从本地缓存读取');
                if (artifact?.path) {
                    message.success({ content: `全部日志已加载: ${artifact.path}`, key: 'windows-full-log-export', duration: 4 });
                } else {
                    message.warning({ content: '全部日志加载完成，但未返回缓存文件路径', key: 'windows-full-log-export', duration: 4 });
                }
            } catch (error) {
                setFullCollectionStage('加载全部日志失败');
                message.error({ content: `全部日志加载失败: ${error}`, key: 'windows-full-log-export', duration: 4 });
            } finally {
                window.clearInterval(progressTimer);
                setFullCollectionLoading(false);
                window.setTimeout(() => {
                    setFullCollectionProgress(0);
                    setFullCollectionStage('');
                }, 1400);
            }
        };

        return (
            <div className="windows-data-toolbar">
                <div className="windows-data-toolbar-main">
                    <Input
                        className="windows-search-input"
                        prefix={<SearchOutlined />}
                        placeholder="搜索关键字..."
                        allowClear
                        value={effectiveSearchKeyword}
                        onChange={(e) => updateSearchKeyword(e.target.value)}
                    />
                    {['auth_log', 'syslog', 'failed_logins', 'cron_log', 'sudo_log', 'web_access_log', 'dmesg', 'win_security_log', 'win_system_log', 'win_app_log', 'win_powershell_log'].includes(moduleKey) && (
                        <Select
                            value={timeRange || 'all'}
                            onChange={(value) => setTimeRange?.(value)}
                            style={{ width: 122 }}
                            options={[
                                { label: '全部时间', value: 'all' },
                                { label: '近 1 小时', value: '1h' },
                                { label: '近 6 小时', value: '6h' },
                                { label: '近 24 小时', value: '24h' },
                                { label: '近 3 天', value: '3d' },
                            ]}
                        />
                    )}
                    <Text className="windows-result-count" type="secondary">
                        {collectionArtifact
                            ? `预览 ${filteredCount} 条 / 全量 ${collectionArtifact.totalCount} 条`
                            : windowsLogPageInfo
                                ? `第 ${windowsLogPageInfo.page} 页 / 共 ${windowsLogPageInfo.totalCount ?? filteredCount} 条日志`
                            : collectionPreviewLimit
                                ? `快速预览 ${filteredCount} 条`
                            : `共 ${filteredCount} 条结果`}
                    </Text>
                </div>
                <div className="windows-data-toolbar-actions">
                    {supportsFullWindowsLogExport && (
                        <Button
                            icon={<FileSearchOutlined />}
                            loading={fullCollectionLoading}
                            onClick={exportFullWindowsCollection}
                            title="加载完整日志到临时缓存，之后分页从缓存读取"
                        >
                            {collectionArtifact ? '重新加载全部日志' : '加载全部日志'}
                        </Button>
                    )}
                    {collectionArtifact && (
                        <Button
                            icon={<FolderOpenOutlined />}
                            onClick={openCollectionArtifact}
                            title={collectionArtifact.path}
                        >
                            打开全量文件
                        </Button>
                    )}
                    {isCompactWindowsWorkspaceModule && (
                        <Button
                            icon={<ReloadOutlined spin={loading} />}
                            onClick={() => loadData()}
                            loading={loading}
                            title="刷新数据"
                        >
                            刷新
                        </Button>
                    )}
                    {isCompactWindowsWorkspaceModule && tableData.length > 0 && (
                        <Button
                            icon={<DownloadOutlined />}
                            onClick={exportToCsv}
                            title="导出CSV"
                        >
                            导出
                        </Button>
                    )}
                    <Popover
                        trigger="click"
                        placement="bottomRight"
                        content={
                            <div style={{ maxHeight: 300, overflow: 'auto' }}>
                                {allColumns.map(col => (
                                    <div key={col.dataIndex} style={{ padding: '4px 0' }}>
                                        <Checkbox
                                            checked={!hiddenColumns.includes(col.dataIndex as string)}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setHiddenColumns(prev => prev.filter(c => c !== col.dataIndex));
                                                } else {
                                                    setHiddenColumns(prev => [...prev, col.dataIndex as string]);
                                                }
                                            }}
                                        >
                                            {col.title as string}
                                        </Checkbox>
                                    </div>
                                ))}
                            </div>
                        }
                    >
                        <Button icon={<SettingOutlined />}>设置列</Button>
                    </Popover>
                </div>
            </div>
        );
    };

    const renderFullCollectionProgress = () => {
        if (!fullCollectionLoading && fullCollectionProgress <= 0) return null;

        return (
            <div
                className="windows-full-log-progress"
                style={{
                    padding: '10px 14px',
                    borderTop: `1px solid ${isDarkMode ? '#30363d' : '#edf2f7'}`,
                    background: isDarkMode ? '#111827' : '#f8fafc',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <Text style={{ fontSize: 12, color: isDarkMode ? '#d1d5db' : '#334155' }}>
                        {fullCollectionStage || '正在加载全部日志...'}
                    </Text>
                    <Text strong style={{ fontSize: 12, color: isDarkMode ? '#93c5fd' : '#2563eb' }}>
                        {fullCollectionProgress}%
                    </Text>
                </div>
                <Progress
                    percent={fullCollectionProgress}
                    status={fullCollectionProgress >= 100 ? 'success' : 'active'}
                    size="small"
                    showInfo={false}
                />
                <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    加载完成后，表格分页会从临时缓存读取，不再重复扫描 Windows 事件日志。
                </Text>
            </div>
        );
    };

    const renderWindowsDataSurface = () => (
        <div className="windows-data-workbench" style={{
            border: `1px solid ${isDarkMode ? '#30363d' : '#d9e2ec'}`,
            borderRadius: 8,
            background: isDarkMode ? '#161b22' : '#ffffff',
            overflow: 'hidden',
        }}>
            {renderWindowsToolbar()}
            {renderFullCollectionProgress()}
            {filteredCount > 0 ? (
                <div className="windows-data-table-frame">
                    {renderTable()}
                </div>
            ) : (
                <div className="windows-filter-empty">
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                            <div className="windows-filter-empty-copy">
                                <Text>没有匹配的结果</Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                    调整搜索关键字，或清除搜索后查看全部采集记录。
                                </Text>
                            </div>
                        }
                    />
                    <Button size="small" onClick={() => updateSearchKeyword('')}>
                        清除搜索
                    </Button>
                </div>
            )}
        </div>
    );

    const renderWindowsEmptyState = () => (
        <div className="windows-empty-state" style={{
            minHeight: 220,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${isDarkMode ? '#30363d' : '#d9e2ec'}`,
            borderRadius: 8,
            background: isDarkMode ? '#161b22' : '#ffffff',
        }}>
            <Empty
                description={
                    <Space orientation="vertical" size={4}>
                        <Text>{isLinuxRemoteMode ? '当前 Linux 模块没有可展示记录' : '当前模块没有可展示记录'}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            {isLinuxRemoteMode
                                ? '点击刷新重新采集；如果仍为空，通常表示目标系统没有对应痕迹或当前 SSH 权限不足。'
                                : '点击刷新重新采集；如果仍为空，通常表示目标系统没有对应痕迹或需要管理员权限。'}
                        </Text>
                    </Space>
                }
            />
        </div>
    );

    const renderTableSurface = () => (
        isModuleWorkbenchMode
            ? renderWindowsDataSurface()
            : <Card className={cardClass}>{renderTable()}</Card>
    );

    const renderEmptySurface = () => (
        isModuleWorkbenchMode
            ? renderWindowsEmptyState()
            : <Card className={cardClass}><Text type="secondary">暂无数据</Text></Card>
    );

    const renderWindowsPanelDetection = () => {
        let panelData: unknown = null;
        try {
            panelData = JSON.parse(rawOutput || '{}');
        } catch {
            panelData = null;
        }

        return <WindowsPanelDetectionView data={panelData} isDarkMode={isDarkMode} />;
    };

    const renderContent = () => {
        if (moduleKey === 'terminal') return renderTerminal();
        if (moduleKey === 'file_manager') return renderFileManager();
        if (moduleKey === 'system_info' && mode === 'local') {
            return systemInfo ? <LocalSystemInfoView systemInfo={systemInfo} isDarkMode={isDarkMode} /> : <Spin tip="正在加载系统信息..." />;
        }
        if (moduleKey === 'system_info' && mode === 'remote') {
            return remoteSystemInfo ? <RemoteSystemInfoView systemInfo={remoteSystemInfo} isDarkMode={isDarkMode} /> : <Spin tip="正在加载系统信息..." />;
        }
        if (moduleKey === 'ioc_file_search') return <>{renderIocFileSearch()}</>;
        if (collectionDiagnostic) return renderCollectionDiagnostic();
        if (moduleKey === 'suspicious_files') return <>{renderSuspiciousFiles()}</>;
        if (moduleKey === 'webshell_scan') return <>{renderWebshellScan()}</>;
        if (moduleKey === 'panel' && isWindowsLocalMode) return renderWindowsPanelDetection();
        if (moduleKey === 'panel') return <>{renderBaoTaPanel()}</>;
        if (moduleKey === 'database') {
            if (osType === 'Windows' || rawOutput.includes('DB_SERVICES')) {
                return tableData.length > 0
                    ? renderTableSurface()
                    : renderEmptySurface();
            }
            return <>{renderDatabase()}</>;
        }
        if (isWindowsLocalMode && tableData.length > 0) return renderWindowsDataSurface();
        if (isWindowsLocalMode) return renderWindowsEmptyState();
        if (moduleKey === 'failed_logins') return (
            <>
                {renderFailedLoginsStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        if (moduleKey === 'web_access_log') return (
            <>
                {renderWebAccessStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        if (moduleKey === 'login_history') return (
            <>
                {renderLoginHistoryStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        // Sudo日志
        if (moduleKey === 'sudo_log') return (
            <>
                {renderSudoLogStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        // 进程异常检测
        if (moduleKey === 'process_anomaly') return (
            <>
                {renderProcessAnomalyStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        // 配置文件类模块
        if (['bashrc_check', 'profile_check', 'pam_config', 'sudo_config', 'sudoers_config', 'selinux_status', 'win_firewall'].includes(moduleKey)) {
            if (tableData.length > 0) return renderTableSurface();
            return renderConfigFile();
        }
        // 环境变量
        if (moduleKey === 'env_vars') return (
            <>
                {renderEnvVarsStats()}
                {tableData.length > 0 ? renderTableSurface() : renderEmptySurface()}
            </>
        );
        if (isModuleWorkbenchMode && tableData.length > 0) return renderWindowsDataSurface();
        if (isModuleWorkbenchMode) return renderWindowsEmptyState();
        if (tableData.length > 0) return <Card className={cardClass}>{renderTable()}</Card>;
        if (listData.length > 0) return <Card className={cardClass}>{renderList()}</Card>;
        return <Card className={cardClass}><Text type="secondary">暂无数据</Text></Card>;
    };

    if (loading) {
        return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}><Spin size="large" /></div>;
    }

    // 文件管理模块使用专用布局
    if (moduleKey === 'file_manager') {
        return renderFileManager();
    }

    // 终端模块使用专用布局
    if (moduleKey === 'terminal') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div 
                    className={glassEnabled ? 'glass-header-container' : ''}
                    style={glassEnabled ? { flexShrink: 0 } : { flexShrink: 0, background: headerBg, paddingBottom: 8, marginBottom: 8 }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Title level={4} style={{ margin: 0 }}>{displayTitle}</Title>
                        <Tag color={mode === 'local' ? 'blue' : 'green'}>{mode === 'local' ? '本地' : '远程'}</Tag>
                        {mode === 'remote' && privilegeMode !== 'none' && <Tag color="orange">{privilegeMode}</Tag>}
                        <Button
                            type="text"
                            onClick={() => setTerminalOutput([])}
                            title="清除终端"
                            style={{ marginLeft: 'auto' }}
                        >
                            清除
                        </Button>
                    </div>
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    {renderTerminal()}
                </div>
            </div>
        );
    }

    // 判断是否显示搜索框（排除system_info和terminal）
    const showSearch = tableData.length > 0 && moduleKey !== 'system_info' && moduleKey !== 'terminal';
    const filteredCount = getFilteredTableData(tableData).length;
    const hasCollectedSystemInfo =
        moduleKey === 'system_info' &&
        ((mode === 'local' && Boolean(systemInfo)) || (mode === 'remote' && Boolean(remoteSystemInfo)));
    const moduleMetaStatus = loading
        ? { color: 'processing', label: '采集中' }
        : collectionDiagnostic
        ? { color: 'orange', label: '需处理' }
        : tableData.length > 0 || hasCollectedSystemInfo
            ? { color: 'green', label: '已采集' }
            : { color: 'default', label: '等待采集' };
    const showModuleMetaTags = loading || Boolean(collectionDiagnostic) || (!tableData.length && !hasCollectedSystemInfo);
    const showWorkbenchHeader = !isCompactWindowsWorkspaceModule || !showSearch;

    return (
        <div className={workbenchShellClassName} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div className={workbenchWorkspaceClassName} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
            {/* 固定头部 */}
            {showWorkbenchHeader && (
            <div
                className={isModuleWorkbenchMode ? workbenchHeaderClassName : (glassEnabled ? 'glass-header-container' : '')} 
                style={glassEnabled ? { flexShrink: 0 } : {
                    flexShrink: 0,
                    background: isModuleWorkbenchMode ? (isDarkMode ? '#161b22' : '#ffffff') : headerBg,
                    padding: isModuleWorkbenchMode ? '12px 14px' : '0 0 8px',
                    borderBottom: isModuleWorkbenchMode ? `1px solid ${isDarkMode ? '#30363d' : '#d9e2ec'}` : undefined,
                    boxShadow: isModuleWorkbenchMode && !isDarkMode ? '0 1px 2px rgba(15, 23, 42, 0.04)' : undefined,
                }}
            >
                {/* 标题行 */}
                <div className={isModuleWorkbenchMode ? workbenchTitlebarClassName : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isCompactWindowsWorkspaceModule && (
                        <>
                            <Title className={isModuleWorkbenchMode ? workbenchTitleClassName : undefined} level={4} style={{ margin: 0 }}>{displayTitle}</Title>
                            {moduleMeta && <Tag color={isLinuxRemoteMode ? 'green' : 'geekblue'}>{moduleMeta.group}</Tag>}
                            <Tag color={mode === 'local' ? 'blue' : 'green'}>{mode === 'local' ? '本地' : '远程'}</Tag>
                            {mode === 'remote' && privilegeMode !== 'none' && <Tag color="orange">{privilegeMode}</Tag>}
                        </>
                    )}
                    <Button
                        type="text"
                        icon={<ReloadOutlined spin={loading} />}
                        onClick={() => loadData()}
                        loading={loading}
                        title="刷新数据"
                        style={{ marginLeft: 'auto' }}
                    >
                        刷新
                    </Button>
                    {tableData.length > 0 && (
                        <Button
                            type="text"
                            icon={<DownloadOutlined />}
                            onClick={exportToCsv}
                            title="导出CSV"
                        >
                            导出
                        </Button>
                    )}
                </div>
                {/* 分隔线 */}
                {moduleMeta && !isCompactWindowsWorkspaceModule && (
                    <div className={workbenchMetaClassName} style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{moduleMeta.description}</Text>
                        {showModuleMetaTags ? (
                            <Space size={6} wrap>
                                <Tag color={moduleMetaStatus.color}>
                                    {moduleMetaStatus.label}
                                </Tag>
                            </Space>
                        ) : null}
                    </div>
                )}
                {showSearch && !isModuleWorkbenchMode && <div style={{ height: 3, background: '#1890ff', marginTop: 8 }} />}
                {/* 搜索行和列设置 */}
                {showSearch && !isModuleWorkbenchMode && (
                    <div className={isModuleWorkbenchMode ? workbenchToolbarClassName : undefined} style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: isModuleWorkbenchMode ? 12 : 10,
                        justifyContent: 'space-between',
                        padding: isModuleWorkbenchMode ? '8px 10px' : undefined,
                        border: isModuleWorkbenchMode ? `1px solid ${isDarkMode ? '#30363d' : '#e5e7eb'}` : undefined,
                        borderRadius: isModuleWorkbenchMode ? 6 : undefined,
                        background: isModuleWorkbenchMode ? (isDarkMode ? '#0d1117' : '#f8fafc') : undefined,
                    }}>
                        <div className={isModuleWorkbenchMode ? workbenchToolbarMainClassName : undefined} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Input.Search
                                placeholder="搜索关键字..."
                                allowClear
                                style={{ width: isModuleWorkbenchMode ? 260 : 180 }}
                                value={effectiveSearchKeyword}
                                onChange={(e) => updateSearchKeyword(e.target.value)}
                            />
                            {['auth_log', 'syslog', 'failed_logins', 'cron_log', 'sudo_log', 'web_access_log', 'dmesg', 'win_security_log', 'win_system_log', 'win_app_log', 'win_powershell_log'].includes(moduleKey) && (
                                <Select
                                    value={timeRange || 'all'}
                                    onChange={(value) => {
                                        setTimeRange?.(value);
                                        // loadData will be triggered by useEffect
                                    }}
                                    style={{ width: 110 }}
                                    options={[
                                        { label: '全部时间', value: 'all' },
                                        { label: '近1小时', value: '1h' },
                                        { label: '近6小时', value: '6h' },
                                        { label: '近24小时', value: '24h' },
                                        { label: '近3天', value: '3d' },
                                    ]}
                                />
                            )}
                            <Text type="secondary">
                                {collectionArtifact
                                    ? `预览 ${filteredCount} 条 / 全量 ${collectionArtifact.totalCount} 条`
                                    : windowsLogPageInfo
                                        ? `第 ${windowsLogPageInfo.page} 页 / 共 ${windowsLogPageInfo.totalCount ?? filteredCount} 条日志`
                                    : `共 ${filteredCount} 条`}
                            </Text>
                        </div>
                        {collectionArtifact && (
                            <Button
                                icon={<FolderOpenOutlined />}
                                onClick={async () => {
                                    try {
                                        await revealItemInDir(collectionArtifact.path);
                                    } catch (error) {
                                        message.error(`打开采集文件失败: ${error}`);
                                    }
                                }}
                            >
                                打开全量文件
                            </Button>
                        )}
                        <Popover
                            trigger="click"
                            placement="bottomRight"
                            content={
                                <div style={{ maxHeight: 300, overflow: 'auto' }}>
                                    {allColumns.map(col => (
                                        <div key={col.dataIndex} style={{ padding: '4px 0' }}>
                                            <Checkbox
                                                checked={!hiddenColumns.includes(col.dataIndex as string)}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        setHiddenColumns(prev => prev.filter(c => c !== col.dataIndex));
                                                    } else {
                                                        setHiddenColumns(prev => [...prev, col.dataIndex as string]);
                                                    }
                                                }}
                                            >
                                                {col.title as string}
                                            </Checkbox>
                                        </div>
                                    ))}
                                </div>
                            }
                        >
                            <Button icon={<SettingOutlined />}>设置列</Button>
                        </Popover>
                    </div>
                )}
            </div>
            )}
            {/* 滚动内容区 */}
            <div className={isModuleWorkbenchMode ? workbenchBodyClassName : undefined} style={{
                flex: 1,
                overflow: 'auto',
                background: isModuleWorkbenchMode ? (isDarkMode ? '#0d1117' : '#f3f6fa') : undefined,
                padding: isModuleWorkbenchMode ? 12 : undefined,
            }}>
                {renderContent()}
            </div>
            </div>

            {/* 全局文件预览模态窗口 - 用于Docker等模块 */}
            <Modal
                title={`📄 ${previewFileName}`}
                open={previewModalOpen}
                onCancel={() => {
                    setPreviewModalOpen(false);
                    setFileContent(null);
                    setHexData([]);
                    setImageBase64(null);
                    setHexSearch('');
                    setHexSearchResults([]);
                }}
                footer={null}
                width={previewType === 'hex' ? 900 : 800}
                styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
            >
                {loading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
                ) : previewType === 'image' ? (
                    <div style={{ textAlign: 'center' }}>
                        {imageBase64 && <img src={imageBase64} alt={previewFileName} style={{ maxWidth: '100%', maxHeight: 500 }} />}
                    </div>
                ) : previewType === 'table' ? (
                    renderCsvTable()
                ) : previewType === 'hex' ? (
                    renderHexView()
                ) : (
                    <pre style={{
                        margin: 0,
                        fontSize: 12,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 500,
                        overflow: 'auto',
                        background: '#f5f5f5',
                        padding: 12,
                        borderRadius: 4,
                    }}>
                        {fileContent || '无内容'}
                    </pre>
                )}
                {/* 返回Docker文件浏览器按钮 */}
                {dockerContainerId && (
                    <div style={{ marginTop: 16, textAlign: 'center' }}>
                        <Button
                            onClick={() => {
                                setPreviewModalOpen(false);
                                setDockerFileBrowserOpen(true);
                            }}
                        >
                            ← 返回容器文件列表
                        </Button>
                    </div>
                )}
            </Modal>

            {/* Docker Inspect 详情弹窗 - 全局 */}
            <Modal
                title={`🐳 容器详情: ${dockerContainerId}`}
                open={dockerInspectOpen}
                onCancel={() => setDockerInspectOpen(false)}
                footer={null}
                width={900}
            >
                {dockerInspectData && (
                    <div style={{ maxHeight: 600, overflow: 'auto' }}>
                        <Row gutter={16}>
                            <Col span={12}>
                                <Card size="small" title="📦 基本信息" style={{ marginBottom: 16 }}>
                                    <Descriptions column={1} size="small">
                                        <Descriptions.Item label="ID">{dockerInspectData.Id?.slice(0, 12)}</Descriptions.Item>
                                        <Descriptions.Item label="名称">{dockerInspectData.Name}</Descriptions.Item>
                                        <Descriptions.Item label="镜像">{dockerInspectData.Config?.Image}</Descriptions.Item>
                                        <Descriptions.Item label="状态">
                                            <Tag color={dockerInspectData.State?.Running ? 'green' : 'red'}>
                                                {dockerInspectData.State?.Status}
                                            </Tag>
                                        </Descriptions.Item>
                                        <Descriptions.Item label="创建时间">{dockerInspectData.Created?.split('T')[0]}</Descriptions.Item>
                                    </Descriptions>
                                </Card>
                                <Card size="small" title="🔒 网络" style={{ marginBottom: 16 }}>
                                    {dockerInspectData.NetworkSettings?.Networks &&
                                        Object.entries(dockerInspectData.NetworkSettings.Networks).map(([name, net]: [string, any]) => (
                                            <div key={name} style={{ marginBottom: 8 }}>
                                                <Tag color="blue">{name}</Tag>
                                                <Text code style={{ marginLeft: 8 }}>{net.IPAddress || '无IP'}</Text>
                                            </div>
                                        ))
                                    }
                                </Card>
                            </Col>
                            <Col span={12}>
                                <Card size="small" title="⚙️ 配置" style={{ marginBottom: 16 }}>
                                    <div style={{ marginBottom: 8 }}>
                                        <Text strong>入口点: </Text>
                                        <Text code>{dockerInspectData.Config?.Entrypoint?.join(' ') || '无'}</Text>
                                    </div>
                                    <div style={{ marginBottom: 8 }}>
                                        <Text strong>命令: </Text>
                                        <Text code>{dockerInspectData.Config?.Cmd?.join(' ') || '无'}</Text>
                                    </div>
                                    <div style={{ marginBottom: 8 }}>
                                        <Text strong>工作目录: </Text>
                                        <Text code>{dockerInspectData.Config?.WorkingDir || '/'}</Text>
                                    </div>
                                </Card>
                                <Card size="small" title="🔗 挂载卷">
                                    {dockerInspectData.Mounts?.map((m: any, i: number) => (
                                        <div key={i} style={{ marginBottom: 4 }}>
                                            <Text code style={{ fontSize: 11 }}>{m.Source} → {m.Destination}</Text>
                                        </div>
                                    )) || <Text type="secondary">无挂载</Text>}
                                </Card>
                            </Col>
                        </Row>
                        <Card size="small" title="🌍 环境变量" style={{ marginTop: 16 }}>
                            <div style={{ maxHeight: 150, overflow: 'auto' }}>
                                {dockerInspectData.Config?.Env?.map((env: string, i: number) => (
                                    <Tag key={i} style={{ marginBottom: 4 }}>{env}</Tag>
                                )) || <Text type="secondary">无环境变量</Text>}
                            </div>
                        </Card>
                    </div>
                )}
            </Modal>

            {/* Docker 容器文件浏览器弹窗 - 全局 */}
            <Modal
                title={`📁 容器文件: ${dockerContainerId}`}
                open={dockerFileBrowserOpen}
                onCancel={() => setDockerFileBrowserOpen(false)}
                footer={null}
                width={800}
            >
                <div style={{ marginBottom: 12 }}>
                    <Text strong>路径: </Text>
                    <Text code>{dockerFilePath}</Text>
                    {dockerFilePath !== '/' && (
                        <Button
                            size="small"
                            style={{ marginLeft: 12 }}
                            onClick={() => {
                                const parent = dockerFilePath.split('/').slice(0, -1).join('/') || '/';
                                loadDockerDirectory(dockerContainerId, parent);
                            }}
                        >
                            ↑ 上级目录
                        </Button>
                    )}
                </div>
                <Table
                    dataSource={dockerFileList}
                    columns={[
                        {
                            title: '名称', dataIndex: 'name', key: 'name',
                            render: (name: string, record: any) => (
                                <span
                                    style={{ cursor: 'pointer', color: record.isDir ? '#1890ff' : '#52c41a' }}
                                    onClick={() => record.isDir
                                        ? loadDockerDirectory(dockerContainerId, record.fullPath)
                                        : openDockerFilePreview(dockerContainerId, record)
                                    }
                                >
                                    {record.isDir ? '📁 ' : '📄 '}{name}
                                </span>
                            )
                        },
                        { title: '权限', dataIndex: 'permissions', key: 'permissions', width: 120 },
                        { title: '大小', dataIndex: 'size', key: 'size', width: 100 },
                    ]}
                    size="small"
                    pagination={false}
                    scroll={{ y: 400 }}
                    loading={loading}
                />
            </Modal>

            <Modal
                title={selectedWindowsDatabaseInstance
                    ? `${WINDOWS_DATABASE_DETAIL_TITLE} - ${selectedWindowsDatabaseInstance.displayName}`
                    : WINDOWS_DATABASE_DETAIL_TITLE}
                open={windowsDatabaseWorkbenchOpen}
                onCancel={() => setWindowsDatabaseWorkbenchOpen(false)}
                footer={null}
                width="min(1280px, calc(100vw - 48px))"
                className={`windows-database-modal${isDarkMode ? ' windows-database-modal-dark' : ''}`}
                destroyOnHidden
                styles={{
                    body: {
                        height: 'min(760px, calc(100vh - 140px))',
                        overflow: 'hidden',
                        padding: 0,
                    },
                }}
            >
                {selectedWindowsDatabaseInstance ? (
                    <WindowsDatabaseWorkbench
                        instance={selectedWindowsDatabaseInstance}
                        onRequest={requestWindowsDatabaseReadonly}
                        onMutation={requestWindowsDatabaseMutation}
                        isDarkMode={isDarkMode}
                    />
                ) : null}
            </Modal>
        </div>
    );
}
