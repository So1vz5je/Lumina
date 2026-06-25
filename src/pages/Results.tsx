import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { AnalysisResult } from '../types/analysis';
import { getScanModuleLabel, getScanStatusMeta, scanModuleCatalog } from '../modules/scan/catalog';

const { Paragraph, Text, Title } = Typography;

const RESULT_PREVIEW_LIMIT = 50;

interface ResultsProps {
  results?: AnalysisResult[];
}

type DetailRecord = Record<string, unknown>;

interface FindingField {
  label: string;
  value: string;
}

interface FindingRow {
  key: string;
  title: string;
  subtitle?: string;
  risk?: boolean;
  reason?: string;
  fields: FindingField[];
}

interface FindingSection {
  title: string;
  rows: FindingRow[];
}

function isRecord(value: unknown): value is DetailRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getDetails(details: unknown): DetailRecord {
  return isRecord(details) ? details : {};
}

function getArray(details: DetailRecord, key: string): DetailRecord[] {
  const value = details[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function valueToText(value: unknown, fallback = '-'): string {
  if (typeof value === 'string') {
    return value.trim() || fallback;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const text = value.map((item) => valueToText(item, '')).filter(Boolean).join('; ');
    return text || fallback;
  }

  if (isRecord(value)) {
    return JSON.stringify(value);
  }

  return fallback;
}

function readField(row: DetailRecord, keys: string[], fallback = '-'): string {
  for (const key of keys) {
    const value = valueToText(row[key], '');
    if (value) return value;
  }

  return fallback;
}

function readBool(row: DetailRecord, key: string): boolean {
  return row[key] === true;
}

function getTextArray(details: DetailRecord, key: string): string[] {
  const value = details[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => valueToText(item, '')).filter(Boolean);
}

function previewRows<T>(rows: T[]): T[] {
  return rows.slice(0, RESULT_PREVIEW_LIMIT);
}

function formatByteCount(value: unknown): string {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatEndpoint(address: string, port: string): string {
  if (!address || address === '-') return port && port !== '-' ? `:${port}` : '-';
  if (!port || port === '-' || port === '0') return address;
  return `${address}:${port}`;
}

function statusColor(status: string) {
  return getScanStatusMeta(status).color;
}

function statusText(status: string) {
  return getScanStatusMeta(status).label;
}

function buildFindingSections(result: AnalysisResult): FindingSection[] {
  const details = getDetails(result.details);

  if (result.module_name === 'system_info') {
    const memory = isRecord(details.memory) ? details.memory : {};
    const osText = [valueToText(details.os_name, ''), valueToText(details.os_version, '')]
      .filter(Boolean)
      .join(' ') || '-';
    const hostname = valueToText(details.hostname, 'Unknown host');

    return [
      {
        title: '系统概览',
        rows: [
          {
            key: 'system-overview',
            title: hostname,
            subtitle: osText,
            fields: [
              { label: '内核', value: valueToText(details.kernel_version) },
              { label: 'CPU', value: valueToText(details.cpu_model) },
              { label: '核心数', value: valueToText(details.cpu_count) },
              {
                label: '内存',
                value: `${formatByteCount(memory.used)} / ${formatByteCount(memory.total)}`,
              },
            ],
          },
        ],
      },
    ];
  }

  if (result.module_name === 'user_trace') {
    const suspiciousUsers = getArray(details, 'suspicious_users');
    const sessions = getArray(details, 'sessions');
    const users = previewRows(suspiciousUsers.length > 0 ? suspiciousUsers : getArray(details, 'users'));
    const sections: FindingSection[] = [];

    if (users.length > 0) {
      sections.push({
        title: suspiciousUsers.length > 0 ? '可疑用户' : '用户账户',
        rows: users.map((user, index) => ({
          key: `user-${index}`,
          title: readField(user, ['name', 'username', 'User']),
          subtitle: readField(user, ['full_name', 'fullName', 'comment']),
          risk: suspiciousUsers.length > 0 || readBool(user, 'suspicious'),
          reason: readField(user, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: '管理员', value: valueToText(user.is_admin ?? user.isAdmin) },
            { label: '启用', value: valueToText(user.is_active ?? user.isActive) },
            { label: '最后登录', value: readField(user, ['last_logon', 'lastLogon']) },
          ],
        })),
      });
    }

    if (sessions.length > 0) {
      sections.push({
        title: '登录会话',
        rows: previewRows(sessions).map((session, index) => ({
          key: `session-${index}`,
          title: readField(session, ['username', 'User']),
          subtitle: readField(session, ['session_name', 'sessionName']),
          fields: [
            { label: '会话 ID', value: readField(session, ['session_id', 'sessionId']) },
            { label: '状态', value: readField(session, ['state', 'State']) },
            { label: '登录时间', value: readField(session, ['logon_time', 'logonTime']) },
          ],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'network') {
    const externalConnections = getArray(details, 'external_connections');
    const fallbackConnections = getArray(details, 'connections');
    const connections = previewRows(externalConnections.length > 0 ? externalConnections : fallbackConnections);
    const interfaces = previewRows(getArray(details, 'interfaces'));
    const sections: FindingSection[] = [];

    if (connections.length > 0) {
      sections.push({
        title: externalConnections.length > 0 ? '外联连接' : '网络连接',
        rows: connections.map((connection, index) => {
          const local = formatEndpoint(
            readField(connection, ['local_address', 'localAddress', 'LocalAddress']),
            readField(connection, ['local_port', 'localPort', 'LocalPort']),
          );
          const remote = formatEndpoint(
            readField(connection, ['remote_address', 'remoteAddress', 'RemoteAddress']),
            readField(connection, ['remote_port', 'remotePort', 'RemotePort']),
          );
          const risky = readBool(connection, 'is_suspicious_port') || readBool(connection, 'isSuspiciousPort');

          return {
            key: `network-${index}`,
            title: remote,
            subtitle: `${readField(connection, ['protocol', 'Protocol'])} / ${readField(connection, ['state', 'State'])}`,
            risk: risky,
            reason: risky ? 'suspicious port' : undefined,
            fields: [
              { label: '本地', value: local },
              { label: 'PID', value: readField(connection, ['pid', 'OwningProcess']) },
            ],
          };
        }),
      });
    }

    if (interfaces.length > 0) {
      sections.push({
        title: '网卡配置',
        rows: interfaces.map((networkInterface, index) => ({
          key: `interface-${index}`,
          title: readField(networkInterface, ['name', 'Name']),
          subtitle: getTextArray(networkInterface, 'ipv4').join(', ') || '-',
          fields: [
            { label: '网关', value: readField(networkInterface, ['gateway', 'Gateway']) },
            { label: 'DNS', value: getTextArray(networkInterface, 'dns').join(', ') || '-' },
            { label: 'MAC', value: readField(networkInterface, ['mac', 'Mac']) },
          ],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'process') {
    const suspiciousProcesses = getArray(details, 'suspicious_list');
    const fallbackProcesses = getArray(details, 'processes');
    const processes = previewRows(suspiciousProcesses.length > 0 ? suspiciousProcesses : fallbackProcesses);
    const services = previewRows(getTextArray(details, 'services'));
    const sections: FindingSection[] = [];

    if (processes.length > 0) {
      sections.push({
        title: suspiciousProcesses.length > 0 ? '可疑进程' : '进程',
        rows: processes.map((process, index) => ({
          key: `process-${index}`,
          title: readField(process, ['name', 'Name', 'process_name', 'processName']),
          subtitle: readField(process, ['username', 'UserName', 'user']),
          risk: suspiciousProcesses.length > 0 || readBool(process, 'suspicious'),
          reason: readField(process, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: 'PID', value: readField(process, ['pid', 'Pid', 'Id']) },
            { label: '内存', value: readField(process, ['memory_mb', 'memoryMb']) },
            { label: '状态', value: readField(process, ['status', 'State']) },
          ],
        })),
      });
    }

    if (services.length > 0) {
      sections.push({
        title: '运行服务',
        rows: services.map((service, index) => ({
          key: `service-${index}`,
          title: service,
          fields: [{ label: '来源', value: 'net start' }],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'docker') {
    const containers = previewRows(getArray(details, 'containers'));
    if (containers.length === 0) return [];

    return [
      {
        title: '容器',
        rows: containers.map((container, index) => ({
          key: `${readField(container, ['container_id', 'containerId', 'ID'])}-${index}`,
          title: readField(container, ['name', 'Names', 'Name'], readField(container, ['container_id', 'containerId', 'ID'])),
          subtitle: `${readField(container, ['image', 'Image'])} / ${readField(container, ['status', 'Status'])}`,
          risk: readBool(container, 'suspicious'),
          reason: readField(container, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: '容器 ID', value: readField(container, ['container_id', 'containerId', 'ID']) },
            { label: '端口', value: readField(container, ['ports', 'Ports']) },
          ],
        })),
      },
    ];
  }

  if (result.module_name === 'panel') {
    const detectedInstalls = getArray(details, 'detected_installs');
    const fallbackInstalls = getArray(details, 'installs').filter((item) => readBool(item, 'detected'));
    const panels = previewRows(detectedInstalls.length > 0 ? detectedInstalls : fallbackInstalls);
    const sites = previewRows(getArray(details, 'iis_sites'));
    const sections: FindingSection[] = [];

    if (panels.length > 0) {
      sections.push({
        title: '面板/集成环境',
        rows: panels.map((panel, index) => ({
          key: `panel-${index}`,
          title: readField(panel, ['name', 'Name']),
          subtitle: readField(panel, ['path', 'Path']),
          fields: [
            { label: '类型', value: readField(panel, ['panel_type', 'panelType']) },
            { label: '站点数', value: readField(panel, ['site_count', 'siteCount']) },
            { label: '备注', value: readField(panel, ['notes', 'Notes']) },
          ],
        })),
      });
    }

    if (sites.length > 0) {
      sections.push({
        title: 'IIS 站点',
        rows: sites.map((site, index) => ({
          key: `iis-${index}`,
          title: readField(site, ['name', 'Name']),
          subtitle: readField(site, ['path', 'PhysicalPath']),
          fields: [
            { label: '来源', value: readField(site, ['source', 'Source'], 'IIS') },
            { label: '状态', value: readField(site, ['state', 'State']) },
            { label: '绑定', value: readField(site, ['bindings', 'Bindings']) },
          ],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'cron') {
    const tasks = previewRows(getArray(details, 'suspicious_tasks').concat(getArray(details, 'tasks')));
    if (tasks.length === 0) return [];

    return [
      {
        title: '计划任务',
        rows: tasks.map((task, index) => ({
          key: `task-${index}`,
          title: readField(task, ['task_name', 'taskName', 'TaskName', 'name']),
          subtitle: readField(task, ['actions', 'Actions', 'command']),
          risk: readBool(task, 'suspicious'),
          reason: readField(task, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: '路径', value: readField(task, ['task_path', 'taskPath', 'TaskPath']) },
            { label: '触发器', value: readField(task, ['triggers', 'Triggers']) },
            { label: '状态', value: readField(task, ['state', 'State', 'status']) },
          ],
        })),
      },
    ];
  }

  if (result.module_name === 'persistence') {
    const entries = getArray(details, 'suspicious_entries')
      .concat(getArray(details, 'suspicious_items'))
      .concat(getArray(details, 'entries'));
    const entriesPreview = previewRows(entries);
    if (entries.length === 0) return [];

    return [
      {
        title: '持久化项',
        rows: entriesPreview.map((entry, index) => ({
          key: `persistence-${index}`,
          title: readField(entry, ['name', 'Name']),
          subtitle: readField(entry, ['detail', 'command', 'PathName']),
          risk: readBool(entry, 'suspicious'),
          reason: readField(entry, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: '类型', value: readField(entry, ['entry_type', 'entryType']) },
            { label: '触发', value: readField(entry, ['trigger', 'StartType']) },
            { label: '位置', value: readField(entry, ['location', 'Location']) },
          ],
        })),
      },
    ];
  }

  if (result.module_name === 'startup') {
    const items = previewRows(getArray(details, 'suspicious_items').concat(getArray(details, 'startup_items')));
    const tasks = previewRows(getArray(details, 'scheduled_tasks'));
    const sections: FindingSection[] = [];

    if (items.length > 0) {
      sections.push({
        title: '启动项',
        rows: items.map((item, index) => ({
          key: `startup-${index}`,
          title: readField(item, ['name', 'Name']),
          subtitle: readField(item, ['command', 'Command']),
          risk: readBool(item, 'suspicious'),
          reason: readField(item, ['suspicious_reason', 'suspiciousReason']),
          fields: [
            { label: '类型', value: readField(item, ['item_type', 'itemType', 'type']) },
            { label: '位置', value: readField(item, ['location', 'Location']) },
          ],
        })),
      });
    }

    if (tasks.length > 0) {
      sections.push({
        title: '计划任务',
        rows: tasks.map((task, index) => ({
          key: `startup-task-${index}`,
          title: readField(task, ['name', 'task_name', 'TaskName']),
          subtitle: readField(task, ['task_to_run', 'taskToRun', 'actions', 'Actions']),
          fields: [
            { label: '状态', value: readField(task, ['status', 'State']) },
            { label: '下次运行', value: readField(task, ['next_run', 'nextRun', 'NextRunTime']) },
            { label: '作者', value: readField(task, ['author', 'Author']) },
          ],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'database') {
    const detected = previewRows(getTextArray(details, 'detected_databases'));
    const services = previewRows(getArray(details, 'detected_services').concat(getArray(details, 'services')));

    if (detected.length > 0) {
      return [
        {
          title: '数据库服务',
          rows: detected.map((name, index) => ({
            key: `database-${index}`,
            title: name,
            subtitle: 'Detected running database service',
            fields: [{ label: '状态', value: 'running' }],
          })),
        },
      ];
    }

    return services.length > 0
      ? [
          {
            title: '数据库服务',
            rows: services.map((service, index) => ({
              key: `database-service-${index}`,
              title: readField(service, ['name', 'Name', 'DisplayName']),
              subtitle: readField(service, ['path', 'PathName']),
              fields: [
                { label: '状态', value: readField(service, ['status', 'Status']) },
                { label: '类型', value: readField(service, ['type', 'StartType']) },
              ],
            })),
          },
        ]
      : [];
  }

  if (result.module_name === 'security_events') {
    const events = previewRows(getArray(details, 'suspicious_events')
      .concat(getArray(details, 'failed_logins'))
      .concat(getArray(details, 'events')));
    if (events.length === 0) return [];

    return [
      {
        title: '安全事件',
        rows: events.map((event, index) => ({
          key: `security-event-${index}`,
          title: readField(event, ['event_type', 'eventType', 'EventType'], readField(event, ['event_id', 'eventId', 'EventId'])),
          subtitle: readField(event, ['description', 'Description']),
          risk: readBool(event, 'is_suspicious') || readBool(event, 'suspicious'),
          fields: [
            { label: '事件 ID', value: readField(event, ['event_id', 'eventId', 'EventId']) },
            { label: '时间', value: readField(event, ['time_created', 'timeCreated', 'TimeCreated']) },
            { label: '用户', value: readField(event, ['username', 'Username']) },
            { label: '来源 IP', value: readField(event, ['source_ip', 'sourceIp', 'SourceIp']) },
          ],
        })),
      },
    ];
  }

  if (result.module_name === 'security_posture') {
    const findings = previewRows(getArray(details, 'findings'));
    const firewallProfiles = previewRows(getArray(details, 'firewall_profiles'));
    const hostsEntries = previewRows(getArray(details, 'hosts_entries')
      .filter((entry) => readBool(entry, 'suspicious')));
    const rdp = isRecord(details.rdp) ? details.rdp : {};
    const sections: FindingSection[] = [];

    if (findings.length > 0) {
      sections.push({
        title: '安全状态关注项',
        rows: findings.map((finding, index) => ({
          key: `security-posture-finding-${index}`,
          title: readField(finding, ['name', 'Name']),
          subtitle: readField(finding, ['detail', 'Detail']),
          risk: readField(finding, ['risk', 'Risk']) !== 'info',
          reason: readField(finding, ['category', 'Category']),
          fields: [
            { label: '分类', value: readField(finding, ['category', 'Category']) },
            { label: '风险', value: readField(finding, ['risk', 'Risk']) },
          ],
        })),
      });
    }

    if (firewallProfiles.length > 0) {
      sections.push({
        title: 'Windows 防火墙',
        rows: firewallProfiles.map((profile, index) => ({
          key: `security-posture-firewall-${index}`,
          title: readField(profile, ['Name', 'name']),
          subtitle: `入站 ${readField(profile, ['DefaultInboundAction', 'default_inbound_action'])} / 出站 ${readField(profile, ['DefaultOutboundAction', 'default_outbound_action'])}`,
          risk: readBool(profile, 'Enabled') === false,
          fields: [
            { label: '启用', value: readField(profile, ['Enabled', 'enabled']) },
            { label: '默认入站', value: readField(profile, ['DefaultInboundAction', 'default_inbound_action']) },
            { label: '默认出站', value: readField(profile, ['DefaultOutboundAction', 'default_outbound_action']) },
          ],
        })),
      });
    }

    if (isRecord(rdp) && Object.keys(rdp).length > 0) {
      sections.push({
        title: '远程访问',
        rows: [
          {
            key: 'security-posture-rdp',
            title: '远程桌面',
            subtitle: readBool(rdp, 'Enabled') ? 'RDP 已开启' : 'RDP 未开启',
            risk: readBool(rdp, 'Enabled'),
            fields: [
              { label: '启用', value: readField(rdp, ['Enabled', 'enabled']) },
              { label: '服务状态', value: readField(rdp, ['ServiceStatus', 'service_status']) },
              { label: '启动类型', value: readField(rdp, ['ServiceStartType', 'service_start_type']) },
            ],
          },
        ],
      });
    }

    if (hostsEntries.length > 0) {
      sections.push({
        title: 'hosts 文件',
        rows: hostsEntries.map((entry, index) => ({
          key: `security-posture-hosts-${index}`,
          title: readField(entry, ['hostname', 'Hostname']),
          subtitle: readField(entry, ['line', 'Line']),
          risk: true,
          reason: readField(entry, ['reason', 'Reason']),
          fields: [
            { label: '地址', value: readField(entry, ['address', 'Address']) },
            { label: '原因', value: readField(entry, ['reason', 'Reason']) },
          ],
        })),
      });
    }

    return sections;
  }

  if (result.module_name === 'file_scan') {
    const files = previewRows(getTextArray(details, 'recent_temp_files'));
    const findings = previewRows(getArray(details, 'findings').concat(getArray(details, 'files')));
    const tempDir = valueToText(details.temp_dir, '-');

    if (files.length > 0) {
      return [
        {
          title: '文件扫描',
          rows: files.map((filePath, index) => ({
            key: `file-scan-${index}`,
            title: filePath.split(/[\\/]/).pop() || filePath,
            subtitle: filePath,
            fields: [{ label: '目录', value: tempDir }],
          })),
        },
      ];
    }

    return findings.length > 0
      ? [
          {
            title: '文件扫描',
            rows: findings.map((file, index) => ({
              key: `file-finding-${index}`,
              title: readField(file, ['name', 'Name', 'filename']),
              subtitle: readField(file, ['path', 'Path', 'full_path']),
              risk: readBool(file, 'suspicious'),
              reason: readField(file, ['reason', 'risk', 'Risk']),
              fields: [
                { label: '目录', value: readField(file, ['directory', 'Directory']) },
                { label: '大小', value: readField(file, ['size', 'Size']) },
                { label: '修改时间', value: readField(file, ['last_modified', 'lastModified', 'LastWriteTime']) },
              ],
            })),
          },
        ]
      : [];
  }

  return [];
}

export default function Results({ results = [] }: ResultsProps) {
  const [selectedModule, setSelectedModule] = useState<string | null>(null);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedModule(null);
      return;
    }

    const hasSelection = results.some((result) => result.module_name === selectedModule);
    if (!hasSelection) {
      setSelectedModule(results[0].module_name);
    }
  }, [results, selectedModule]);

  const selectedResult = results.find((result) => result.module_name === selectedModule);
  const selectedFindingSections = selectedResult ? buildFindingSections(selectedResult) : [];
  const selectedFindingCount = selectedFindingSections.reduce(
    (count, section) => count + section.rows.length,
    0,
  );

  const statusStats = useMemo(
    () =>
      results.reduce(
        (stats, result) => {
          stats.total += 1;
          if (result.status === 'ok') stats.ok += 1;
          if (result.status === 'info') stats.info += 1;
          if (result.status === 'warning') stats.warning += 1;
          if (result.status === 'critical') stats.critical += 1;
          return stats;
        },
        { total: 0, ok: 0, info: 0, warning: 0, critical: 0 },
      ),
    [results],
  );

  const exportResults = () => {
    const json = JSON.stringify(results, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `scan-results-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    message.success('导出成功');
  };

  if (results.length === 0) {
    return (
      <div className="scan-results-workspace scan-results-empty">
        <div className="scan-results-header">
          <div>
            <Text className="scan-eyebrow">扫描结果</Text>
            <Title level={3} className="scan-title">
              结果工作台
            </Title>
          </div>
        </div>
        <div className="scan-empty-panel">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无扫描结果，请先执行快速扫描"
          />
        </div>
      </div>
    );
  }

  const statItems = [
    { key: 'total', label: '模块总数', value: statusStats.total, tone: 'neutral', icon: <FileTextOutlined /> },
    { key: 'ok', label: '正常', value: statusStats.ok, tone: 'ok', icon: <CheckCircleOutlined /> },
    { key: 'info', label: '信息', value: statusStats.info, tone: 'info', icon: <InfoCircleOutlined /> },
    { key: 'warning', label: '告警', value: statusStats.warning, tone: 'warning', icon: <WarningOutlined /> },
    { key: 'critical', label: '危险', value: statusStats.critical, tone: 'critical', icon: <ExclamationCircleOutlined /> },
  ];
  const priorityCount = statusStats.warning + statusStats.critical;
  const selectedModulePosition = selectedResult
    ? results.findIndex((result) => result.module_name === selectedResult.module_name) + 1
    : 0;
  const scopeGroups = Array.from(new Set(scanModuleCatalog.map((module) => module.group)));
  const scopeText = scopeGroups.join(' / ');
  const priorityLabel = priorityCount > 0 ? '需优先复核' : '暂无高优先级';

  return (
    <div className="scan-results-workspace">
      <div className="scan-results-commandbar" aria-label="结果统计">
        <div className="scan-results-commandbar-title">
          <Text className="scan-eyebrow">扫描结果</Text>
          <strong>应急扫描结果</strong>
          <Text type="secondary">
            {scanModuleCatalog.length} 个本机分析模块 · {scopeText}
          </Text>
        </div>
        <div className="scan-stat-grid">
          {statItems.map((item) => (
            <div key={item.key} className={`scan-stat-tile ${item.tone}`}>
              <span className="scan-stat-icon">{item.icon}</span>
              <span>
                <Text>{item.label}</Text>
                <strong>{item.value}</strong>
              </span>
            </div>
          ))}
        </div>
        <div className={`scan-disposition-chip ${priorityCount > 0 ? 'attention' : 'steady'}`}>
          <Text>处置</Text>
          <strong>{priorityLabel}</strong>
        </div>
        <Button icon={<ExportOutlined />} onClick={exportResults}>
          导出 JSON
        </Button>
      </div>

      <div className="scan-results-soc-shell scan-results-detail-grid">
        <div className="scan-module-strip" role="tablist" aria-label="扫描模块">
          {results.map((item, index) => {
            const meta = getScanStatusMeta(item.status);
            return (
              <button
                key={item.module_name}
                aria-selected={selectedModule === item.module_name}
                className={`scan-result-nav-item ${meta.tone} ${selectedModule === item.module_name ? 'active' : ''}`}
                onClick={() => setSelectedModule(item.module_name)}
                role="tab"
                type="button"
              >
                <span className="scan-result-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="scan-result-nav-main">
                  <strong>{getScanModuleLabel(item.module_name)}</strong>
                  <code>{item.module_name}</code>
                </span>
                <Tag color={meta.color}>{meta.label}</Tag>
              </button>
            );
          })}
        </div>

        <main className="scan-result-detail scan-result-detail-panel">
          {selectedResult ? (
            <div className="scan-detail-surface">
              <div className="scan-detail-header">
                <div>
                  <Text className="scan-panel-kicker">当前模块</Text>
                  <Title level={4}>{getScanModuleLabel(selectedResult.module_name)}</Title>
                  <Text type="secondary">{selectedResult.module_name}</Text>
                </div>
                <div className="scan-detail-status-stack">
                  <Tag color={statusColor(selectedResult.status)}>{statusText(selectedResult.status)}</Tag>
                  <Text type="secondary">{selectedFindingCount} 个关键条目</Text>
                </div>
              </div>

              <section className="scan-summary-panel">
                <Text className="scan-section-title">摘要</Text>
                <Paragraph>{selectedResult.summary}</Paragraph>
              </section>

              {selectedFindingSections.length > 0 ? (
                <section className="scan-findings-panel">
                  <Text className="scan-section-title">关键明细</Text>
                  {selectedFindingSections.map((section) => (
                    <div className="scan-finding-section" key={section.title}>
                      <Text strong>{section.title}</Text>
                      <div className="scan-finding-table">
                        {section.rows.map((row) => (
                          <article className={`scan-finding-record ${row.risk ? 'risk' : ''}`} key={row.key}>
                            <div className="scan-finding-row-head">
                              <div>
                                <Text strong>{row.title}</Text>
                                {row.subtitle ? <Text type="secondary">{row.subtitle}</Text> : null}
                              </div>
                              {row.risk ? <Tag color="warning">可疑</Tag> : null}
                            </div>
                            <div className="scan-finding-fields">
                              {row.risk && row.reason && row.reason !== '-' ? (
                                <Tag className="scan-finding-reason-tag">{row.reason}</Tag>
                              ) : null}
                              {row.fields.map((field) => (
                                <Tag key={`${row.key}-${field.label}`}>
                                  {field.label}: {field.value}
                                </Tag>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ) : (
                <section className="scan-findings-panel">
                  <Text className="scan-section-title">关键明细</Text>
                  <div className="scan-finding-empty">当前模块没有结构化关键条目。</div>
                </section>
              )}

              <details className="scan-raw-data">
                <summary>
                  <span>原始数据</span>
                  <Tag color={statusColor(selectedResult.status)}>{statusText(selectedResult.status)}</Tag>
                </summary>
                <pre>{JSON.stringify(selectedResult.details, null, 2)}</pre>
              </details>
            </div>
          ) : (
            <div className="scan-empty-panel">
              <Empty description="请选择一个模块查看详情" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
