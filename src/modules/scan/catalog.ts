export interface ScanModuleDefinition {
  id: string;
  label: string;
  group: string;
  description: string;
  defaultEnabled: boolean;
}

export interface ScanModuleOption extends ScanModuleDefinition {
  enabled: boolean;
}

export const scanModuleCatalog: ScanModuleDefinition[] = [
  {
    id: 'system_info',
    label: '系统信息',
    group: '基线',
    description: '主机名、系统版本、CPU、内存和启动时间。',
    defaultEnabled: true,
  },
  {
    id: 'user_trace',
    label: '用户痕迹',
    group: '身份',
    description: '本地账户、登录会话和可疑管理员账户。',
    defaultEnabled: true,
  },
  {
    id: 'network',
    label: '网络分析',
    group: '网络',
    description: '活动连接、外联地址、网卡和 DNS 配置。',
    defaultEnabled: true,
  },
  {
    id: 'process',
    label: '进程分析',
    group: '进程',
    description: '运行进程、异常进程和关键服务。',
    defaultEnabled: true,
  },
  {
    id: 'file_scan',
    label: '文件扫描',
    group: '文件',
    description: '临时目录、用户可写目录和近期可执行文件。',
    defaultEnabled: true,
  },
  {
    id: 'startup',
    label: '启动项',
    group: '持久化',
    description: '注册表启动项、启动目录和计划任务入口。',
    defaultEnabled: true,
  },
  {
    id: 'cron',
    label: '计划任务',
    group: '持久化',
    description: '计划任务动作、触发器、运行状态和可疑项。',
    defaultEnabled: true,
  },
  {
    id: 'persistence',
    label: '持久化检测',
    group: '持久化',
    description: '自动服务、计划任务、启动目录等聚合检测。',
    defaultEnabled: true,
  },
  {
    id: 'database',
    label: '数据库',
    group: '应用',
    description: 'MySQL、Redis、SQL Server 等数据库服务。',
    defaultEnabled: true,
  },
  {
    id: 'security_events',
    label: '安全事件',
    group: '日志',
    description: '登录失败、账户变更和高价值安全事件。',
    defaultEnabled: true,
  },
  {
    id: 'security_posture',
    label: '安全状态',
    group: '安全',
    description: 'Defender、防火墙、RDP、hosts 文件和关键安全配置。',
    defaultEnabled: true,
  },
  {
    id: 'docker',
    label: 'Docker',
    group: '容器',
    description: '容器、镜像、端口暴露和可疑挂载。',
    defaultEnabled: true,
  },
  {
    id: 'panel',
    label: '面板检测',
    group: '应用',
    description: 'phpStudy、宝塔、IIS 站点等 Web 面板痕迹。',
    defaultEnabled: true,
  },
];

export const scanStatusMeta: Record<string, { label: string; color: string; tone: string }> = {
  ok: { label: '正常', color: 'success', tone: 'ok' },
  info: { label: '信息', color: 'processing', tone: 'info' },
  warning: { label: '告警', color: 'warning', tone: 'warning' },
  critical: { label: '危险', color: 'error', tone: 'critical' },
};

export function createDefaultScanModules(): ScanModuleOption[] {
  return scanModuleCatalog.map((module) => ({
    ...module,
    enabled: module.defaultEnabled,
  }));
}

export function getScanModuleLabel(moduleName: string): string {
  return scanModuleCatalog.find((module) => module.id === moduleName)?.label || moduleName;
}

export function getScanStatusMeta(status: string) {
  return scanStatusMeta[status] || { label: '未知', color: 'default', tone: 'unknown' };
}
