import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { Layout, Menu, ConfigProvider, theme, message, Button, Tabs } from 'antd';
import type { MenuProps } from 'antd';
import {
  DesktopOutlined,
  UserOutlined,
  GlobalOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  ControlOutlined,
  DatabaseOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  SettingOutlined,
  TeamOutlined,
  HistoryOutlined,
  KeyOutlined,
  HddOutlined,
  UnorderedListOutlined,
  SafetyOutlined,
  ApartmentOutlined,
  WifiOutlined,
  AlertOutlined,
  FileSearchOutlined,
  ContainerOutlined,
  FileTextOutlined,
  BugOutlined,
  CodeOutlined,
  DashboardOutlined,
  LockOutlined,
  FolderOutlined,
  ArrowLeftOutlined,
  MinusOutlined,
  BorderOutlined,
  CloseOutlined
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ModeSelect from './pages/ModeSelect';
import ModuleDetail from './pages/ModuleDetail';
import Settings from './pages/Settings';
import AiAnalysis from './pages/AiAnalysis';
import RemoteWorkspace from './pages/RemoteWorkspace';
import Scan from './pages/Scan';
import Results from './pages/Results';
import { RemoteWorkspaceProvider } from './modules/remote/RemoteWorkspaceProvider';
import type { AnalysisResult, RiskFinding } from './types/analysis';
import { isTauriRuntime } from './utils/runtime';

import './App.css';

const { Sider, Content } = Layout;

type AnalysisMode = 'none' | 'local' | 'remote';
type OsType = 'Windows' | 'Linux' | 'macOS' | 'Unknown';
type PrivilegeMode = 'none' | 'sudo' | 'su';

type MenuItem = Required<MenuProps>['items'][number];

interface WorkspaceConfigView {
  exportsPath?: string;
}

interface WindowsWorkspaceModule {
  key: string;
  label: string;
}

interface WindowsModuleWorkspace {
  key: string;
  icon: ReactNode;
  label: string;
  modules: WindowsWorkspaceModule[];
}

const WINDOWS_MODULE_WORKSPACES: WindowsModuleWorkspace[] = [
  {
    key: 'windows_overview_workspace',
    icon: <DesktopOutlined />,
    label: '主机总览',
    modules: [
      { key: 'system_info', label: '主机概况' },
      { key: 'env_vars', label: '环境变量' },
    ],
  },
  {
    key: 'windows_identity_workspace',
    icon: <TeamOutlined />,
    label: '账户与进程',
    modules: [
      { key: 'user_list', label: '本地账户' },
      { key: 'logged_users', label: '登录会话' },
      { key: 'process_list', label: '运行进程' },
      { key: 'service_list', label: '系统服务' },
      { key: 'process_anomaly', label: '进程异常' },
    ],
  },
  {
    key: 'windows_persistence_workspace',
    icon: <ThunderboltOutlined />,
    label: '持久化入口',
    modules: [
      { key: 'startup', label: '自启动项' },
      { key: 'cron', label: '计划任务' },
      { key: 'registry', label: '注册表关键项' },
      { key: 'persistence', label: '持久化检测' },
      { key: 'registry_persistence_deep', label: '注册表深度持久化' },
      { key: 'wmi_persistence', label: 'WMI 持久化' },
      { key: 'bits_jobs', label: 'BITS 任务' },
      { key: 'rdp', label: 'RDP 入口' },
    ],
  },
  {
    key: 'windows_network_workspace',
    icon: <GlobalOutlined />,
    label: '网络暴露',
    modules: [
      { key: 'network_conn', label: '活动连接' },
      { key: 'listen_ports', label: '监听端口' },
      { key: 'win_firewall', label: 'Windows 防火墙' },
      { key: 'dns_config', label: 'DNS 配置' },
      { key: 'hosts_file', label: 'Hosts 文件' },
    ],
  },
  {
    key: 'windows_logs_workspace',
    icon: <FileTextOutlined />,
    label: '日志中心',
    modules: [
      { key: 'security_events', label: '高价值安全事件' },
      { key: 'win_security_log', label: 'Security 日志' },
      { key: 'win_system_log', label: 'System 日志' },
      { key: 'win_app_log', label: 'Application 日志' },
      { key: 'win_powershell_log', label: 'PowerShell 日志' },
      { key: 'rdp_logon_trace', label: 'RDP 登录链路' },
      { key: 'win_defender', label: 'Defender 状态' },
      { key: 'defender_history', label: 'Defender 检测历史' },
      { key: 'powershell_deep', label: 'PowerShell 深度' },
    ],
  },
  {
    key: 'ioc_file_search',
    icon: <FileSearchOutlined />,
    label: 'IOC 文件搜索',
    modules: [
      { key: 'ioc_file_search', label: 'IOC 文件搜索' },
    ],
  },
  {
    key: 'windows_files_workspace',
    icon: <FileSearchOutlined />,
    label: '文件痕迹',
    modules: [
      { key: 'file_scan', label: '文件扫描' },
      { key: 'suspicious_files', label: '可疑文件' },
      { key: 'execution_trace', label: '执行痕迹' },
      { key: 'recent_files', label: '最近访问' },
      { key: 'browser', label: '浏览器痕迹' },
    ],
  },
  {
    key: 'windows_apps_workspace',
    icon: <CloudServerOutlined />,
    label: '应用服务',
    modules: [
      { key: 'docker', label: 'Docker 容器' },
      { key: 'docker_images', label: 'Docker 镜像' },
      { key: 'database', label: '数据库检测' },
      { key: 'panel', label: '面板检测' },
      { key: 'software', label: '软件安装分析' },
    ],
  },
];

function getWindowsWorkspace(moduleKey: string): WindowsModuleWorkspace | undefined {
  return WINDOWS_MODULE_WORKSPACES.find((workspace) =>
    workspace.key === moduleKey || workspace.modules.some((module) => module.key === moduleKey),
  );
}

function getWindowsSelectedMenuKey(moduleKey: string): string {
  return getWindowsWorkspace(moduleKey)?.key ?? moduleKey;
}

function WindowsModuleWorkspaceView({
  workspace,
  initialModuleKey,
  renderModule,
}: {
  workspace: WindowsModuleWorkspace;
  initialModuleKey: string;
  renderModule: (moduleKey: string) => ReactNode;
}) {
  const initialActiveKey = workspace.modules.some((module) => module.key === initialModuleKey)
    ? initialModuleKey
    : workspace.modules[0]?.key ?? '';
  const [activeModuleKey, setActiveModuleKey] = useState(initialActiveKey);

  useEffect(() => {
    setActiveModuleKey(initialActiveKey);
  }, [initialActiveKey, workspace.key]);

  return (
    <div className="windows-module-workspace-page">
      <Tabs
        className="windows-module-workspace-tabs"
        activeKey={activeModuleKey}
        onChange={setActiveModuleKey}
        size="small"
        items={workspace.modules.map((module) => ({
          key: module.key,
          label: module.label,
          children: module.key === activeModuleKey ? renderModule(module.key) : null,
        }))}
      />
    </div>
  );
}

// 窗口控制按钮组件
const WindowControls = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    if (!desktopRuntime) {
      return;
    }

    const checkMaximized = async () => {
      const win = getCurrentWindow();
      setIsMaximized(await win.isMaximized());
      // 监听最大化变化 (需要 backend 支持，暂时只做简单状态切换)
    };
    checkMaximized();
  }, [desktopRuntime]);

  if (!desktopRuntime) {
    return null;
  }

  return (
    <div className="window-controls">
      <button
        aria-label="后台"
        onClick={() => getCurrentWindow().minimize()}
        className="win-btn"
        title="后台"
        type="button"
      >
        <MinusOutlined />
      </button>
      <button
        aria-label={isMaximized ? '小窗' : '最大化'}
        onClick={async () => {
          const win = getCurrentWindow();
          if (await win.isMaximized()) {
            win.unmaximize();
            setIsMaximized(false);
          } else {
            win.maximize();
            setIsMaximized(true);
          }
        }}
        className="win-btn"
        title={isMaximized ? '小窗' : '最大化'}
        type="button"
      >
        <BorderOutlined />
      </button>
      <button
        aria-label="关闭"
        onClick={() => getCurrentWindow().close()}
        className="win-btn-close"
        title="关闭"
        type="button"
      >
        <CloseOutlined />
      </button>
    </div>
  );
};

const AppChrome = ({
  osType,
  mode = 'none',
  showBack,
  onBack,
}: {
  osType: OsType;
  mode?: AnalysisMode;
  showBack?: boolean;
  onBack?: () => void;
}) => {
  const modeLabel = mode === 'remote' ? '远程分析' : mode === 'local' ? '本地分析' : '选择模式';

  return (
  <div className={`app-chrome ${showBack ? 'app-chrome-workbench' : ''}`} data-tauri-drag-region>
    <div className="app-chrome-brand-zone">
      <div className="app-chrome-mark">
        <SafetyOutlined />
      </div>
      <div className="app-chrome-brand">
        <strong>Lumina</strong>
      </div>
    </div>

    <div className="app-chrome-context">
      {showBack ? (
        <Button
          aria-label="返回模式选择"
          className="app-chrome-back"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          size="small"
          title="返回"
          type="text"
        />
      ) : null}
      <span className="app-chrome-mode">{showBack ? osType : '工作台'}</span>
      <span className="app-chrome-separator" />
      <span className="app-chrome-subtitle">{modeLabel}</span>
    </div>

    <div className="app-chrome-right">
      <WindowControls />
    </div>
  </div>
  );
};

const buildLocalScanMenuItems = (): MenuItem[] => [
  {
    key: 'scan_group',
    icon: <ThunderboltOutlined />,
    label: '扫描',
    children: [
      { key: 'scan', icon: <ThunderboltOutlined />, label: '快速扫描' },
      { key: 'results', icon: <FileTextOutlined />, label: '扫描结果' },
    ],
  },
];

const buildRemoteWorkspaceMenuItems = (isLinux: boolean): MenuItem[] => {
  const items: MenuItem[] = [
    { type: 'divider' },
    {
      key: 'remote_workspace',
      icon: <CloudServerOutlined />,
      label: 'Remote Workspace',
    },
    {
      key: 'file_manager',
      icon: <FolderOutlined />,
      label: '文件管理',
    },
  ];

  if (isLinux) {
    items.push({
      key: 'terminal',
      icon: <DesktopOutlined />,
      label: '远程终端',
    });
  }

  return items;
};

const buildWindowsMenuItems = (mode: AnalysisMode): MenuItem[] => {
  if (mode === 'local') {
    return [
      ...buildLocalScanMenuItems(),
      ...WINDOWS_MODULE_WORKSPACES.map((workspace) => ({
        key: workspace.key,
        icon: workspace.icon,
        label: workspace.label,
      })),
    ];
  }

  const menuGroups: MenuItem[] = [];

  menuGroups.push(
    {
      key: 'windows_overview_group',
      icon: <DesktopOutlined />,
      label: '系统总览',
      children: [
        { key: 'system_info', icon: <DesktopOutlined />, label: '主机概况' },
        { key: 'disk_info', icon: <HddOutlined />, label: '磁盘与卷' },
        { key: 'env_vars', icon: <SettingOutlined />, label: '环境变量' },
        { key: 'installed_software', icon: <SafetyOutlined />, label: '软件清单' },
      ],
    },
    {
      key: 'windows_identity_group',
      icon: <TeamOutlined />,
      label: '身份与进程',
      children: [
        { key: 'user_list', icon: <TeamOutlined />, label: '本地账户' },
        { key: 'logged_users', icon: <UserOutlined />, label: '登录会话' },
        { key: 'process_list', icon: <AppstoreOutlined />, label: '运行进程' },
        { key: 'service_list', icon: <UnorderedListOutlined />, label: '系统服务' },
        { key: 'process_anomaly', icon: <AlertOutlined />, label: '进程异常' },
      ],
    },
    {
      key: 'windows_persistence_group',
      icon: <ThunderboltOutlined />,
      label: '入口与持久化',
      children: [
        { key: 'startup', icon: <ThunderboltOutlined />, label: '自启动项' },
        { key: 'cron', icon: <ClockCircleOutlined />, label: '计划任务' },
        { key: 'registry', icon: <SettingOutlined />, label: '注册表关键项' },
        { key: 'persistence', icon: <AlertOutlined />, label: '持久化检测' },
        { key: 'registry_persistence_deep', icon: <KeyOutlined />, label: '注册表深度持久化' },
        { key: 'wmi_persistence', icon: <CodeOutlined />, label: 'WMI 持久化' },
        { key: 'bits_jobs', icon: <ThunderboltOutlined />, label: 'BITS 任务' },
        { key: 'rdp', icon: <DesktopOutlined />, label: 'RDP 远程入口' },
      ],
    },
    {
      key: 'windows_network_group',
      icon: <GlobalOutlined />,
      label: '网络暴露',
      children: [
        { key: 'network_conn', icon: <WifiOutlined />, label: '活动连接' },
        { key: 'listen_ports', icon: <ApartmentOutlined />, label: '监听端口' },
        { key: 'win_firewall', icon: <SafetyOutlined />, label: 'Windows 防火墙' },
        { key: 'dns_config', icon: <GlobalOutlined />, label: 'DNS 配置' },
        { key: 'hosts_file', icon: <FileSearchOutlined />, label: 'Hosts 文件' },
      ],
    },
    {
      key: 'windows_security_group',
      icon: <SafetyOutlined />,
      label: '安全与日志',
      children: [
        { key: 'win_defender', icon: <SafetyOutlined />, label: 'Defender 状态' },
        { key: 'defender_history', icon: <BugOutlined />, label: 'Defender 检测历史' },
        { key: 'security_events', icon: <FileTextOutlined />, label: '高价值安全事件' },
        { key: 'rdp_logon_trace', icon: <DesktopOutlined />, label: 'RDP 登录链路' },
        { key: 'win_security_log', icon: <FileTextOutlined />, label: 'Security 日志' },
        { key: 'win_system_log', icon: <FileTextOutlined />, label: 'System 日志' },
        { key: 'win_app_log', icon: <FileTextOutlined />, label: 'Application 日志' },
        { key: 'win_powershell_log', icon: <FileTextOutlined />, label: 'PowerShell 日志' },
        { key: 'powershell_deep', icon: <CodeOutlined />, label: 'PowerShell 深度' },
      ],
    },
    {
      key: 'ioc_file_search',
      icon: <FileSearchOutlined />,
      label: 'IOC 文件搜索',
    },
    {
      key: 'windows_forensics_group',
      icon: <FileSearchOutlined />,
      label: '文件与痕迹',
      children: [
        { key: 'file_scan', icon: <FileSearchOutlined />, label: '文件扫描' },
        { key: 'suspicious_files', icon: <AlertOutlined />, label: '可疑文件' },
        { key: 'execution_trace', icon: <HistoryOutlined />, label: '执行痕迹' },
        { key: 'recent_files', icon: <ClockCircleOutlined />, label: '最近访问' },
        { key: 'browser', icon: <GlobalOutlined />, label: '浏览器痕迹' },
      ],
    },
    {
      key: 'windows_apps_group',
      icon: <CloudServerOutlined />,
      label: '应用与服务',
      children: [
        { key: 'docker', icon: <CloudServerOutlined />, label: 'Docker 容器' },
        { key: 'docker_images', icon: <ContainerOutlined />, label: 'Docker 镜像' },
        { key: 'software', icon: <AppstoreOutlined />, label: '软件安装分析' },
        { key: 'panel', icon: <ControlOutlined />, label: '面板检测' },
        { key: 'database', icon: <DatabaseOutlined />, label: '数据库检测' },
      ],
    },
  );

  if (mode === 'remote') {
    menuGroups.push(...buildRemoteWorkspaceMenuItems(false));
  }

  return menuGroups;
};

const buildLinuxMenuItems = (mode: AnalysisMode): MenuItem[] => {
  const menuGroups: MenuItem[] = [];

  if (mode === 'local') {
    menuGroups.push(...buildLocalScanMenuItems());
  }

  menuGroups.push(
    {
      key: 'linux_overview_group',
      icon: <DesktopOutlined />,
      label: '主机概览',
      children: [
        { key: 'system_info', icon: <DesktopOutlined />, label: '系统信息' },
        { key: 'disk_info', icon: <HddOutlined />, label: '磁盘信息' },
        { key: 'installed_software', icon: <SafetyOutlined />, label: '安装软件' },
        { key: 'env_vars', icon: <SettingOutlined />, label: '环境变量' },
      ],
    },
    {
      key: 'linux_identity_trace_group',
      icon: <TeamOutlined />,
      label: '身份与痕迹',
      children: [
        { key: 'user_list', icon: <TeamOutlined />, label: '用户列表' },
        { key: 'logged_users', icon: <UserOutlined />, label: '当前会话' },
        { key: 'login_history', icon: <HistoryOutlined />, label: '登录历史' },
        { key: 'lastlog', icon: <UserOutlined />, label: '最后登录' },
        { key: 'history_cmd', icon: <HistoryOutlined />, label: '历史命令' },
        { key: 'ssh_keys', icon: <KeyOutlined />, label: 'SSH 密钥' },
        { key: 'sudo_log', icon: <KeyOutlined />, label: 'Sudo 日志' },
      ],
    },
    {
      key: 'linux_process_persistence_group',
      icon: <AppstoreOutlined />,
      label: '进程与持久化',
      children: [
        { key: 'process_list', icon: <AppstoreOutlined />, label: '进程列表' },
        { key: 'process_anomaly', icon: <AlertOutlined />, label: '进程异常' },
        { key: 'service_list', icon: <UnorderedListOutlined />, label: '系统服务' },
        { key: 'startup', icon: <ThunderboltOutlined />, label: '自启动信息' },
        { key: 'cron', icon: <ClockCircleOutlined />, label: '计划任务' },
        { key: 'bashrc_check', icon: <CodeOutlined />, label: 'Bashrc 检查' },
        { key: 'profile_check', icon: <FileTextOutlined />, label: 'Profile 检查' },
      ],
    },
    {
      key: 'linux_network_group',
      icon: <GlobalOutlined />,
      label: '网络暴露',
      children: [
        { key: 'network_conn', icon: <WifiOutlined />, label: '网络连接' },
        { key: 'listen_ports', icon: <ApartmentOutlined />, label: '监听端口' },
        { key: 'hosts_file', icon: <FileSearchOutlined />, label: 'Hosts 文件' },
        { key: 'dns_config', icon: <GlobalOutlined />, label: 'DNS 配置' },
        { key: 'firewall', icon: <SafetyOutlined />, label: '防火墙规则' },
      ],
    },
    {
      key: 'linux_security_group',
      icon: <SafetyOutlined />,
      label: '安全检查',
      children: [
        { key: 'suspicious_files', icon: <AlertOutlined />, label: '可疑文件' },
        { key: 'webshell_scan', icon: <BugOutlined />, label: 'Webshell 扫描' },
        { key: 'pam_config', icon: <LockOutlined />, label: 'PAM 配置' },
        { key: 'sudo_config', icon: <KeyOutlined />, label: 'Sudo 配置' },
        { key: 'sudoers_config', icon: <KeyOutlined />, label: 'Sudoers 配置' },
        { key: 'selinux_status', icon: <SafetyOutlined />, label: 'SELinux 状态' },
        { key: 'ulimit_config', icon: <DashboardOutlined />, label: '系统限制' },
      ],
    },
    {
      key: 'linux_apps_group',
      icon: <CloudServerOutlined />,
      label: '应用与数据',
      children: [
        { key: 'docker', icon: <CloudServerOutlined />, label: 'Docker 容器' },
        { key: 'docker_images', icon: <ContainerOutlined />, label: 'Docker 镜像' },
        { key: 'panel', icon: <ControlOutlined />, label: '面板检测' },
        { key: 'database', icon: <DatabaseOutlined />, label: '数据库检测' },
        { key: 'recent_files', icon: <ClockCircleOutlined />, label: '最近文件' },
      ],
    },
    {
      key: 'linux_logs_group',
      icon: <FileTextOutlined />,
      label: '日志分析',
      children: [
        { key: 'auth_log', icon: <FileTextOutlined />, label: '认证日志' },
        { key: 'syslog', icon: <FileTextOutlined />, label: '系统日志' },
        { key: 'dmesg', icon: <BugOutlined />, label: '内核日志' },
        { key: 'failed_logins', icon: <AlertOutlined />, label: '登录失败' },
        { key: 'cron_log', icon: <ClockCircleOutlined />, label: '定时任务日志' },
        { key: 'web_access_log', icon: <GlobalOutlined />, label: 'Web 访问日志' },
      ],
    },
  );

  if (mode === 'remote') {
    menuGroups.push(...buildRemoteWorkspaceMenuItems(true));
  }

  return menuGroups;
};

const getDefaultOpenKeys = (mode: AnalysisMode, osType: OsType): string[] => {
  if (osType === 'Windows') {
    return mode === 'local' ? ['scan_group'] : ['windows_overview_group'];
  }
  return mode === 'local' ? ['scan_group', 'linux_overview_group'] : ['linux_overview_group'];
};

function App() {
  const desktopRuntime = isTauriRuntime();
  const [mode, setMode] = useState<AnalysisMode>('none');
  const [osType, setOsType] = useState<OsType>('Unknown');
  const [currentModule, setCurrentModule] = useState<string>('system_info');
  const [privilegeMode, setPrivilegeMode] = useState<PrivilegeMode>('none');
  const [sudoPassword, setSudoPassword] = useState<string>('');
  const [defaultDownloadPath, setDefaultDownloadPath] = useState<string>(() => localStorage.getItem('defaultDownloadPath') || '');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark';
  });
  const [wallpaper, setWallpaper] = useState<string>(() => localStorage.getItem('wallpaper') || '/wallpaper.mp4');
  const [glassEnabled, setGlassEnabled] = useState<boolean>(() => localStorage.getItem('glassEnabled') === 'true');
  const [wallpaperOpacity, setWallpaperOpacity] = useState<number>(() => {
    const saved = localStorage.getItem('wallpaperOpacity');
    return saved ? parseFloat(saved) : 0.3;
  });
  const [scanResults, setScanResults] = useState<AnalysisResult[]>([]);
  const [scanRiskFindings, setScanRiskFindings] = useState<RiskFinding[]>([]);
  const [remoteWorkspaceSeed, setRemoteWorkspaceSeed] = useState(0);
  const [wallpaperLoaded, setWallpaperLoaded] = useState<boolean>(false);


  // 检测壁纸是否为预设主题
  const isPresetTheme = wallpaper === 'light' || wallpaper === 'dark' || wallpaper === 'pink';

  // 检测壁纸是否为视频
  const isVideoWallpaper = wallpaper && !isPresetTheme && (
    wallpaper.endsWith('.mp4') ||
    wallpaper.endsWith('.webm') ||
    wallpaper.endsWith('.mov')
  );

  useEffect(() => {
    if (!desktopRuntime) return undefined;
    let cancelled = false;
    invoke<WorkspaceConfigView>('workspace_get_config')
      .then((config) => {
        if (!cancelled && config?.exportsPath) {
          setDefaultDownloadPath(config.exportsPath);
          localStorage.setItem('defaultDownloadPath', config.exportsPath);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desktopRuntime]);

  // 处理壁纸路径：本地文件需要转换，网络 URL 和相对路径直接使用
  const wallpaperSrc = useMemo(() => {
    if (!wallpaper || isPresetTheme) return '';
    // 网络 URL 或相对路径直接使用
    if (wallpaper.startsWith('http') || wallpaper.startsWith('/') || wallpaper.startsWith('data:')) {
      return wallpaper;
    }
    // 本地文件路径需要转换
    return convertFileSrc(wallpaper);
  }, [wallpaper]);

  const handleLocalMode = async () => {
    const os = detectLocalOs();
    setRemoteWorkspaceSeed((seed) => seed + 1);
    setOsType(os);
    setMode('local');
    setScanResults([]);
    setScanRiskFindings([]);
    setCurrentModule('scan');
    setPrivilegeMode('none');
    message.success(`本地分析模式 - 检测到系统: ${os} `);
  };

  const detectLocalOs = (): OsType => {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('win')) return 'Windows';
    if (platform.includes('mac')) return 'macOS';
    if (platform.includes('linux')) return 'Linux';
    return 'Unknown';
  };

  const handleRemoteConnected = (detectedOs: string, privilege: string, password: string) => {
    let nextOs: OsType = 'Unknown';
    if (detectedOs.toLowerCase().includes('linux')) {
      nextOs = 'Linux';
    } else if (detectedOs.toLowerCase().includes('windows')) {
      nextOs = 'Windows';
    }
    setOsType(nextOs);
    setPrivilegeMode(privilege as PrivilegeMode);
    setSudoPassword(password);
    setMode('remote');
    setScanResults([]);
    setScanRiskFindings([]);
    setCurrentModule(nextOs === 'Linux' ? 'system_info' : 'remote_workspace');
    message.success(`远程分析模式 - 系统: ${detectedOs} `);
  };

  const handleBack = async () => {
    if (mode === 'remote') {
      await invoke('ssh_disconnect');
    }
    setRemoteWorkspaceSeed((seed) => seed + 1);
    setMode('none');
    setOsType('Unknown');
    setScanResults([]);
    setScanRiskFindings([]);
    setCurrentModule('system_info');
    setPrivilegeMode('none');
  };

  const getMenuItems = (): MenuItem[] => {
    if (osType === 'Windows') {
      return buildWindowsMenuItems(mode);
    }
    return buildLinuxMenuItems(mode);
  };


  const isWindowsLocalModuleContent =
    mode === 'local' &&
    osType === 'Windows';
  const activeWindowsWorkspace = isWindowsLocalModuleContent
    ? getWindowsWorkspace(currentModule)
    : undefined;
  const selectedAnalysisMenuKey = activeWindowsWorkspace?.key ?? currentModule;
  const isLinuxRemoteModuleContent =
    mode === 'remote' &&
    osType === 'Linux' &&
    !['remote_workspace', 'file_manager', 'terminal', 'settings', 'ai_analysis'].includes(currentModule);
  const isAiAnalysisContent = currentModule === 'ai_analysis';
  const isFlushModuleContent = isWindowsLocalModuleContent || isLinuxRemoteModuleContent || isAiAnalysisContent;
  const renderModuleDetail = (moduleKey: string, compactHeader = false) => {
    if (mode === 'none') {
      return null;
    }

    return (
      <ModuleDetail
        moduleKey={moduleKey}
        mode={mode}
        osType={osType}
        privilegeMode={privilegeMode}
        sudoPassword={sudoPassword}
        defaultDownloadPath={defaultDownloadPath}
        isDarkMode={isDarkMode}
        glassEnabled={glassEnabled}
        wallpaper={wallpaper}
        compactHeader={compactHeader}
        onNavigate={(key) => {
          setCurrentModule(key);
        }}
      />
    );
  };

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: '#1890ff' } }}>
      <RemoteWorkspaceProvider key={remoteWorkspaceSeed}>
        {mode === 'none' ? (
          <div className={`app-shell ${isDarkMode ? 'dark' : 'light'}`}>
            <AppChrome osType={osType} />
            <div className="app-shell-body">
              <ModeSelect
                onLocalMode={handleLocalMode}
                onRemoteConnected={handleRemoteConnected}
                isDarkMode={isDarkMode}
                glassEnabled={glassEnabled}
                wallpaper={wallpaper}
              />
            </div>
          </div>
        ) : (
      <div className={`analysis-shell ${isDarkMode ? 'dark' : 'light'}`}>
        <AppChrome osType={osType} mode={mode} showBack onBack={handleBack} />
        <Layout className={`analysis-workbench slide-in-right ${isDarkMode ? 'dark' : 'light'}`} style={{ height: 'calc(100vh - 52px)', overflow: 'hidden', position: 'relative' }}>
        <Sider
          width={200}
          className="app-sider analysis-sider scale-in"
          style={{
            borderRight: `1px solid ${isDarkMode ? '#263241' : '#d8e0ea'}`,
            zIndex: 10,
            background: isDarkMode ? '#101820' : '#f8fafc',
          }}
        >
          <div className="sider-menu-container" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            <Menu
              mode="inline"
              selectedKeys={[selectedAnalysisMenuKey]}
              defaultOpenKeys={getDefaultOpenKeys(mode, osType)}
              items={getMenuItems()}
              onClick={({ key }) => setCurrentModule(key)}
              className="analysis-menu"
              style={{ borderRight: 0, fontSize: 13 }}
            />
          </div>

          <div style={{ borderTop: `1px solid ${isDarkMode ? '#303030' : '#f0f0f0'} `, flexShrink: 0 }}>
            <Menu
              mode="inline"
              selectedKeys={[currentModule]}
              items={[
                { key: 'ai_analysis', icon: <CodeOutlined />, label: 'AI 分析' },
                { key: 'settings', icon: <SettingOutlined />, label: '设置' },
              ]}
              onClick={({ key }) => setCurrentModule(key)}
              className="analysis-menu"
              style={{ borderRight: 0 }}
            />
          </div>
        </Sider>

        <Content
          className={`analysis-content fade-in ${isWindowsLocalModuleContent ? 'windows-local-content' : ''} ${isLinuxRemoteModuleContent ? 'linux-remote-content' : ''}`}
          style={{
            padding: isFlushModuleContent ? 0 : 24,
            background: isFlushModuleContent
              ? (isDarkMode ? '#111923' : '#ffffff')
              : (isDarkMode ? '#0d1117' : '#eef3f8'),
            overflowY: 'auto',
            overflowX: 'hidden',
            zIndex: 5,
          }}
        >
          {currentModule === 'settings' ? (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              <Settings
                isDarkMode={isDarkMode}
                setIsDarkMode={setIsDarkMode}
                defaultDownloadPath={defaultDownloadPath}
                setDefaultDownloadPath={(path) => {
                  setDefaultDownloadPath(path);
                  localStorage.setItem('defaultDownloadPath', path);
                }}
                onBackToSelect={() => {
                  setMode('none');
                  setScanResults([]);
                  setScanRiskFindings([]);
                  setCurrentModule('system_info');
                }}
                wallpaper={wallpaper}
                setWallpaper={(v: string) => { setWallpaper(v); localStorage.setItem('wallpaper', v); }}
                glassEnabled={glassEnabled}
                setGlassEnabled={(v: boolean) => { setGlassEnabled(v); localStorage.setItem('glassEnabled', String(v)); }}
                wallpaperOpacity={wallpaperOpacity}
                setWallpaperOpacity={(v: number) => { setWallpaperOpacity(v); localStorage.setItem('wallpaperOpacity', String(v)); }}
              />
            </div>
          ) : currentModule === 'ai_analysis' ? (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              <AiAnalysis
                mode={mode}
                osType={osType}
                currentModule={currentModule}
                scanResults={scanResults}
              />
            </div>
          ) : currentModule === 'remote_workspace' ? (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              <RemoteWorkspace />
            </div>
          ) : currentModule === 'scan' ? (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              <Scan
                onComplete={(payload) => {
                  setScanResults(payload.moduleResults);
                  setScanRiskFindings(payload.riskFindings);
                  setCurrentModule('results');
                }}
              />
            </div>
          ) : currentModule === 'results' ? (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              <Results results={scanResults} riskFindings={scanRiskFindings} />
            </div>
          ) : activeWindowsWorkspace ? (
            <div key={activeWindowsWorkspace.key} className="analysis-module-view analysis-module-enter" data-module-key={activeWindowsWorkspace.key}>
              <WindowsModuleWorkspaceView
                workspace={activeWindowsWorkspace}
                initialModuleKey={currentModule}
                renderModule={(moduleKey) => renderModuleDetail(moduleKey, true)}
              />
            </div>
          ) : (
            <div key={currentModule} className="analysis-module-view analysis-module-enter" data-module-key={currentModule}>
              {renderModuleDetail(currentModule)}
            </div>
          )}
        </Content>
      </Layout>
      </div>
        )}
      </RemoteWorkspaceProvider>
    </ConfigProvider>
  );
}

export default App;
