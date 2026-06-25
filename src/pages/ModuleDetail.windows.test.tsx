import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ModuleDetail, { getWindowsLocalCommand, windowsLocalColumnTitles } from './ModuleDetail';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const windowsMenuModuleKeys = [
  'system_info',
  'disk_info',
  'env_vars',
  'installed_software',
  'software',
  'user_list',
  'logged_users',
  'process_list',
  'service_list',
  'process_anomaly',
  'startup',
  'cron',
  'registry',
  'persistence',
  'registry_persistence_deep',
  'wmi_persistence',
  'bits_jobs',
  'rdp',
  'network_conn',
  'listen_ports',
  'win_firewall',
  'dns_config',
  'hosts_file',
  'win_defender',
  'defender_history',
  'security_events',
  'rdp_logon_trace',
  'win_security_log',
  'win_system_log',
  'win_app_log',
  'win_powershell_log',
  'powershell_deep',
  'file_scan',
  'suspicious_files',
  'execution_trace',
  'recent_files',
  'browser',
  'docker',
  'docker_images',
  'panel',
  'database',
];

function renderWindowsModule(moduleKey: string) {
  return render(
    <ModuleDetail
      moduleKey={moduleKey}
      mode="local"
      osType="Windows"
      privilegeMode="none"
      sudoPassword=""
      isDarkMode={false}
      glassEnabled={false}
      wallpaper=""
    />,
  );
}

function mockWindowsLocalCommand(stdout: unknown) {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'execute_local_command') {
      return {
        success: true,
        stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
        stderr: '',
      };
    }

    if (command === 'get_system_info') {
      return stdout;
    }

    throw new Error(`Unexpected command: ${command}`);
  });
}

describe('Windows local analysis commands', () => {
  beforeAll(() => {
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const getComputedStyleMock = vi.fn((element: Element) => originalGetComputedStyle(element));
    Object.defineProperty(window, 'getComputedStyle', {
      writable: true,
      value: getComputedStyleMock,
    });
    vi.stubGlobal('getComputedStyle', getComputedStyleMock);

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('has a concrete local command for every Windows menu module', () => {
    for (const key of windowsMenuModuleKeys) {
      expect(getWindowsLocalCommand(key), key).toEqual(expect.any(String));
      expect(getWindowsLocalCommand(key)?.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('uses a Windows suspicious file command instead of Linux find/timeout syntax', () => {
    const command = getWindowsLocalCommand('suspicious_files');

    expect(command).toContain('Get-ChildItem');
    expect(command).toContain('RECENT_TEMP');
    expect(command).not.toContain('find ');
    expect(command).not.toContain('timeout ');
  });

  it('collects environment variables without the fragile Env provider enumeration', () => {
    const command = getWindowsLocalCommand('env_vars');

    expect(command).toContain('GetEnvironmentVariables');
    expect(command).not.toContain('Get-ChildItem Env:');
    expect(command).not.toContain('Get-ChildItem env:');
  });

  it('uses a DNS fallback when Get-DnsClientServerAddress is denied', () => {
    const command = getWindowsLocalCommand('dns_config');

    expect(command).toContain('Get-DnsClientServerAddress');
    expect(command).toContain('Win32_NetworkAdapterConfiguration');
    expect(command).toContain('ConvertTo-Json');
  });

  it('uses netstat fallbacks for Windows network connection collection', () => {
    expect(getWindowsLocalCommand('network_conn')).toContain('netstat -ano');
    expect(getWindowsLocalCommand('listen_ports')).toContain('netstat -ano');
    expect(getWindowsLocalCommand('rdp')).toContain('netstat -ano');
    expect(getWindowsLocalCommand('network_conn')).toContain('Get-NetTCPConnection');
    expect(getWindowsLocalCommand('listen_ports')).toContain('Get-NetTCPConnection');
  });

  it('has concrete high-value Windows DFIR collectors', () => {
    expect(getWindowsLocalCommand('execution_trace')).toContain('Prefetch');
    expect(getWindowsLocalCommand('execution_trace')).toContain('Amcache');
    expect(getWindowsLocalCommand('powershell_deep')).toContain('Microsoft-Windows-PowerShell/Operational');
    expect(getWindowsLocalCommand('powershell_deep')).toContain('4104');
    expect(getWindowsLocalCommand('defender_history')).toContain('Get-MpThreat');
    expect(getWindowsLocalCommand('rdp_logon_trace')).toContain('TerminalServices');
    expect(getWindowsLocalCommand('rdp_logon_trace')).toContain('4624');
    expect(getWindowsLocalCommand('wmi_persistence')).toContain('root\\subscription');
    expect(getWindowsLocalCommand('bits_jobs')).toContain('Get-BitsTransfer');
    expect(getWindowsLocalCommand('registry_persistence_deep')).toContain('Image File Execution Options');
    expect(getWindowsLocalCommand('registry_persistence_deep')).toContain('AppInit_DLLs');
  });

  it('has Windows application service collectors for Docker and databases', () => {
    expect(getWindowsLocalCommand('docker')).toContain('DOCKER_INSTALL');
    expect(getWindowsLocalCommand('docker')).toContain('DOCKER_SERVICE');
    expect(getWindowsLocalCommand('docker')).toContain('docker ps -a');
    expect(getWindowsLocalCommand('docker')).toContain('dockerServiceNames');
    expect(getWindowsLocalCommand('docker_images')).toContain('DOCKER_INSTALL');
    expect(getWindowsLocalCommand('docker_images')).toContain('docker images');

    const databaseCommand = getWindowsLocalCommand('database');
    expect(databaseCommand).toContain('DB_SERVICES');
    expect(databaseCommand).toContain('DB_INSTALLS');
    expect(databaseCommand).toContain('Get-NetTCPConnection');
    expect(databaseCommand).toContain('Win32_Service');
    expect(databaseCommand).toContain('CurrentVersion\\Uninstall');
    expect(databaseCommand).toContain('SQL Server');
    expect(databaseCommand).toContain('Redis');
  });

  it('shows a clean browser-preview diagnostic instead of invoking local commands', async () => {
    renderWindowsModule('env_vars');

    expect(await screen.findByText(/浏览器预览模式无法执行采集命令/)).toBeInTheDocument();
    expect(screen.getByText('采集诊断')).toBeInTheDocument();
    expect(screen.getByText('环境变量')).toBeInTheDocument();
    expect(screen.getByText('本地')).toBeInTheDocument();
    expect(screen.queryByText(/undefined\.invoke/)).not.toBeInTheDocument();
  });

  it('renders readable Windows module titles and actions', async () => {
    renderWindowsModule('win_defender');

    expect(await screen.findByText('Defender 状态')).toBeInTheDocument();
    expect(screen.getByText('本地')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /刷新/ })).toBeInTheDocument();
    expect(await screen.findByText(/浏览器预览模式无法执行采集命令/)).toBeInTheDocument();
  });

  it('uses dedicated compact Windows local workbench structure', async () => {
    const { container } = renderWindowsModule('win_defender');

    expect(await screen.findByRole('button', { name: /刷新/ })).toBeInTheDocument();
    expect(container.querySelector('.windows-module-shell')).toBeInTheDocument();
    expect(container.querySelector('.windows-module-header')).toBeInTheDocument();
    expect(container.querySelector('.windows-module-body')).toBeInTheDocument();
  });

  it('keeps Windows result counts in the data toolbar instead of the header area', async () => {
    mockWindowsLocalCommand([
      { name: 'WinDefend', state: '运行中', startType: '自动', displayName: 'Microsoft Defender Antivirus Service' },
      { name: 'EventLog', state: '运行中', startType: '自动', displayName: 'Windows Event Log' },
    ]);

    const { container } = renderWindowsModule('service_list');

    await waitFor(() => expect(screen.getByText('共 2 条结果')).toBeInTheDocument());

    expect(container.querySelector('.windows-module-header')?.textContent).not.toContain('2 条结果');
    expect(container.querySelector('.windows-data-toolbar')?.textContent).toContain('共 2 条结果');
  });

  it('hides success-state collection and tool tags for collected Windows modules', async () => {
    mockWindowsLocalCommand([
      { name: 'WinDefend', state: '运行中', startType: '自动', displayName: 'Microsoft Defender Antivirus Service' },
      { name: 'EventLog', state: '运行中', startType: '自动', displayName: 'Windows Event Log' },
    ]);

    const { container } = renderWindowsModule('service_list');

    await waitFor(() => expect(screen.getByText('共 2 条结果')).toBeInTheDocument());

    expect(container.querySelector('.windows-module-header')?.textContent).not.toContain('已采集');
    expect(container.querySelector('.windows-module-header')?.textContent).not.toContain('PowerShell');
  });

  it('marks Windows host overview as collected when system info is loaded', async () => {
    mockWindowsLocalCommand({
      os_name: 'Windows',
      os_version: 'Server 2022',
      hostname: 'WIN-IR',
      kernel_version: '10.0.20348',
      cpu_usage: 12,
      cpu_cores: 8,
      total_memory_gb: 32,
      used_memory_gb: 18,
      uptime_seconds: 86400,
      boot_time_str: '2026-06-22 10:00:00',
      timezone: 'Asia/Shanghai',
      current_time: '2026-06-23 10:00:00',
      cpu_model: 'Intel Xeon',
      architecture: 'x64',
      disks: [],
      ip_addresses: ['10.0.0.5'],
    });

    renderWindowsModule('system_info');

    await waitFor(() => expect(screen.getByText('WIN-IR')).toBeInTheDocument());
    expect(screen.queryByText('等待采集')).not.toBeInTheDocument();
    expect(screen.queryByText('已采集')).not.toBeInTheDocument();
  });

  it('shows Docker installation evidence even when Docker Desktop is installed but not running', async () => {
    mockWindowsLocalCommand([
      '===DOCKER_INSTALL===',
      '{"CommandPath":"C:\\\\Program Files\\\\Docker\\\\Docker\\\\resources\\\\bin\\\\docker.exe","Version":"Docker version 26.1.4, build abcdef","DesktopPath":"C:\\\\Program Files\\\\Docker\\\\Docker\\\\Docker Desktop.exe"}',
      '===DOCKER_SERVICE===',
      '[{"Name":"com.docker.service","DisplayName":"Docker Desktop Service","State":"Stopped","StartMode":"Auto","PathName":"C:\\\\Program Files\\\\Docker\\\\Docker\\\\com.docker.service","ProcessId":0}]',
      '===DOCKER_CONTAINERS===',
      '[]',
    ].join('\n'));

    renderWindowsModule('docker');

    await waitFor(() => {
      expect(screen.getByText('Docker Desktop Service')).toBeInTheDocument();
      expect(screen.getByText('installed')).toBeInTheDocument();
    });

    expect(screen.queryByText('閲囬泦璇婃柇')).not.toBeInTheDocument();
  });

  it('shows database installation traces when software is installed but no service or port is active', async () => {
    mockWindowsLocalCommand([
      '===DB_SERVICES===',
      '[]',
      '===DB_PORTS===',
      '[]',
      '===DB_PROCESSES===',
      '[]',
      '===DB_INSTALLS===',
      '[{"DisplayName":"MySQL Server 8.0","DisplayVersion":"8.0.36","InstallLocation":"C:\\\\Program Files\\\\MySQL\\\\MySQL Server 8.0\\\\","Source":"registry","Publisher":"Oracle"}]',
    ].join('\n'));

    renderWindowsModule('database');

    await waitFor(() => {
      expect(screen.getByText('MySQL Server 8.0')).toBeInTheDocument();
      expect(screen.getByText('8.0.36')).toBeInTheDocument();
    });

    expect(screen.queryByText('閲囬泦璇婃柇')).not.toBeInTheDocument();
  });

  it('opens a Windows database detail workbench from a detected database row', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===DB_SERVICES===',
            JSON.stringify([
              {
                Name: 'MSSQLSERVER',
                DisplayName: 'SQL Server (MSSQLSERVER)',
                State: 'Running',
                StartMode: 'Auto',
                PathName: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe',
                ProcessId: 1234,
              },
            ]),
            '===DB_PORTS===',
            '[]',
            '===DB_PROCESSES===',
            '[]',
            '===DB_INSTALLS===',
            '[]',
          ].join('\n'),
          stderr: '',
        };
      }

      if (command === 'windows_database_readonly') {
        return {
          success: true,
          stdout: JSON.stringify({ databases: ['master'] }),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    renderWindowsModule('database');

    await waitFor(() => expect(screen.getByText('SQL Server (MSSQLSERVER)')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /查看详情/ }));

    await waitFor(() => expect(screen.getByText('master')).toBeInTheDocument());
  });

  it('uses Windows-specific table column labels for local modules', () => {
    expect(windowsLocalColumnTitles.process_list).toMatchObject({
      pid: 'PID',
      command: '进程名',
      path: '进程路径',
    });
    expect(windowsLocalColumnTitles.win_defender).toMatchObject({
      element: '检测项',
      status: '状态',
      value: '值',
    });
    expect(windowsLocalColumnTitles.persistence).toMatchObject({
      type: '入口类型',
      detail: '动作 / 路径',
      trigger: '触发器',
    });
  });
});
