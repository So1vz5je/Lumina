import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: (path: string) => path,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    maximize: vi.fn(),
    minimize: vi.fn(),
    unmaximize: vi.fn(),
  }),
}));

describe('App authorization gate', () => {
  const tauriInternals = '__TAURI_INTERNALS__' as const;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })[tauriInternals];
    invokeMock.mockReset();
    localStorage.clear();
  });

  it('starts in a Tauri runtime without checking license status', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown })[tauriInternals] = {};
    invokeMock.mockResolvedValue({ valid: false });

    render(<App />);

    await waitFor(() => {
      expect(invokeMock).not.toHaveBeenCalledWith('check_license');
    });
  });

  it('renders compact app chrome without decorative tab controls on the mode screen', () => {
    const { container } = render(<App />);

    const chrome = container.querySelector('.app-chrome');

    expect(chrome).toBeInTheDocument();
    expect(chrome?.querySelector('.app-chrome-brand-zone')).toBeInTheDocument();
    expect(chrome?.querySelector('.app-chrome-add')).not.toBeInTheDocument();
  });

  it('uses a readable Windows-oriented local analysis sidebar', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({
      architecture: 'x64',
      boot_time: 0,
      boot_time_str: '',
      cpu_cores: 8,
      cpu_model: 'Test CPU',
      cpu_usage: 0,
      current_time: '',
      disks: [],
      hostname: 'test-host',
      ip_addresses: [],
      kernel_version: '',
      os_name: 'Windows',
      os_version: '11',
      timezone: '',
      total_memory_gb: 16,
      uptime_seconds: 0,
      used_memory_gb: 8,
    });

    render(<App />);
    fireEvent.click(screen.getByText('本地分析'));

    expect(await screen.findByText('系统总览')).toBeInTheDocument();
    expect(screen.getByText('身份与进程')).toBeInTheDocument();
    expect(screen.getByText('入口与持久化')).toBeInTheDocument();
    expect(screen.getByText('网络暴露')).toBeInTheDocument();
    expect(screen.getByText('安全与日志')).toBeInTheDocument();
    expect(screen.getByText('文件与痕迹')).toBeInTheDocument();
    expect(screen.getByText('应用与服务')).toBeInTheDocument();
    expect(screen.queryByText('深度分析')).not.toBeInTheDocument();
    expect(screen.queryByText('PowerShell 用户配置')).not.toBeInTheDocument();
    expect(screen.queryByText('SSH 密钥')).not.toBeInTheDocument();
  });

  it('shows Windows Docker and database entries under application services', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({
      architecture: 'x64',
      boot_time: 0,
      boot_time_str: '',
      cpu_cores: 8,
      cpu_model: 'Test CPU',
      cpu_usage: 0,
      current_time: '',
      disks: [],
      hostname: 'test-host',
      ip_addresses: [],
      kernel_version: '',
      os_name: 'Windows',
      os_version: '11',
      timezone: '',
      total_memory_gb: 16,
      uptime_seconds: 0,
      used_memory_gb: 8,
    });

    render(<App />);
    fireEvent.click(screen.getByText('本地分析'));
    fireEvent.click(await screen.findByText('应用与服务'));

    expect(await screen.findByText('Docker 容器')).toBeInTheDocument();
    expect(screen.getByText('Docker 镜像')).toBeInTheDocument();
    expect(screen.getByText('数据库检测')).toBeInTheDocument();
  });

  it('does not show the Windows webshell scan entry in the local analysis sidebar', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({
      architecture: 'x64',
      boot_time: 0,
      boot_time_str: '',
      cpu_cores: 8,
      cpu_model: 'Test CPU',
      cpu_usage: 0,
      current_time: '',
      disks: [],
      hostname: 'test-host',
      ip_addresses: [],
      kernel_version: '',
      os_name: 'Windows',
      os_version: '11',
      timezone: '',
      total_memory_gb: 16,
      uptime_seconds: 0,
      used_memory_gb: 8,
    });

    render(<App />);
    fireEvent.click(screen.getByText('本地分析'));
    fireEvent.click(await screen.findByText('文件与痕迹'));

    expect(await screen.findByText('执行痕迹')).toBeInTheDocument();
    expect(screen.queryByText('Webshell 扫描')).not.toBeInTheDocument();
  });

  it('uses a fixed analysis workbench shell instead of wallpaper styling', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    localStorage.setItem('wallpaper', 'pink');
    localStorage.setItem('glassEnabled', 'true');
    invokeMock.mockResolvedValue({
      architecture: 'x64',
      boot_time: 0,
      boot_time_str: '',
      cpu_cores: 8,
      cpu_model: 'Test CPU',
      cpu_usage: 0,
      current_time: '',
      disks: [],
      hostname: 'test-host',
      ip_addresses: [],
      kernel_version: '',
      os_name: 'Windows',
      os_version: '11',
      timezone: '',
      total_memory_gb: 16,
      uptime_seconds: 0,
      used_memory_gb: 8,
    });

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('本地分析'));

    await waitFor(() => {
      expect(container.querySelector('.analysis-workbench')).toBeInTheDocument();
    });
    expect(container.querySelector('.analysis-workbench')).not.toHaveClass('has-wallpaper');
    expect(container.querySelector('.analysis-workbench')).not.toHaveClass('glass-mode');
    expect(container.querySelector('.app-wallpaper-container')).not.toBeInTheDocument();
    expect(container.querySelector('.analysis-sider')).toBeInTheDocument();
    expect(container.querySelector('.analysis-content')).toBeInTheDocument();
  });

  it('uses a flush content layer for Windows local module pages', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({});

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('本地分析'));
    fireEvent.click(await screen.findByText('软件清单'));

    expect(container.querySelector('.analysis-content')).toHaveClass('windows-local-content');
  });

  it('lands Linux remote connections on the analysis overview', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown })[tauriInternals] = {};
    localStorage.setItem(
      'emergency_ssh_connections',
      JSON.stringify([
        {
          id: 'demo-linux',
          name: 'Demo Linux',
          host: '10.0.0.5',
          port: 22,
          username: 'root',
          authType: 'password',
          password: 'demo',
        },
      ]),
    );

    const remoteOutputs: Record<string, string> = {
      hostname: 'demo-linux',
      'cat /etc/os-release 2>/dev/null': [
        'NAME="Ubuntu"',
        'VERSION="22.04.4 LTS"',
        'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
      ].join('\n'),
      uptime: ' 20:00:00 up 10 days,  2 users,  load average: 0.42, 0.37, 0.31',
      'free -h | grep Mem': 'Mem: 15Gi 5.1Gi 8.9Gi 210Mi 1.7Gi 9.8Gi',
      'df -h | grep -E "^/dev"': '/dev/sda1 80G 34G 42G 45% /',
      nproc: '8',
      'hostname -I 2>/dev/null | awk \'{print $1}\' || ip addr show | grep "inet " | head -1 | awk \'{print $2}\'': '10.0.0.5',
      'uname -r': '5.15.0-106-generic',
      'uname -m': 'x86_64',
      'cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2': ' Intel Xeon',
      'cat /etc/issue 2>/dev/null | head -1': 'Ubuntu 22.04.4 LTS',
      'cat /etc/redhat-release 2>/dev/null || cat /etc/centos-release 2>/dev/null || cat /etc/system-release 2>/dev/null': '',
    };

    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'remote_connect') {
        return {
          id: 'conn-1',
          name: 'Demo Linux',
          host: '10.0.0.5',
          port: 22,
          username: 'root',
          osType: 'Linux',
          status: 'connected',
        };
      }

      if (command === 'ssh_execute') {
        return {
          success: true,
          stdout: remoteOutputs[args?.command || ''] ?? '',
          stderr: '',
        };
      }

      return [];
    });

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('远程分析'));
    fireEvent.click(await screen.findByRole('button', { name: /连接/ }));

    await waitFor(() => {
      expect(
        container.querySelector('.analysis-module-view[data-module-key="system_info"]'),
      ).toBeInTheDocument();
    });

    expect(container.querySelector('.analysis-content')).toHaveClass('linux-remote-content');
    // 新版 UI 不再显示"远程健康摘要"，而是显示"运行时间"等关键指标
    expect(await screen.findByText('运行时间')).toBeInTheDocument();
  });

  it('uses the flush content layer for Windows local scan and results pages', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue([]);

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('本地分析'));
    fireEvent.click((await screen.findAllByText('快速扫描'))[0]);

    expect(container.querySelector('.analysis-content')).toHaveClass('windows-local-content');

    fireEvent.click((await screen.findAllByText('扫描结果'))[0]);

    expect(container.querySelector('.analysis-content')).toHaveClass('windows-local-content');
  });

  it('wraps settings in a keyed animated module view when switching pages', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({});

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('本地分析'));

    await waitFor(() => {
      expect(container.querySelector('.analysis-content')).toBeInTheDocument();
    });

    const menuItems = await screen.findAllByRole('menuitem');
    fireEvent.click(menuItems[menuItems.length - 1]);

    await waitFor(() => {
      const view = container.querySelector('.analysis-module-view[data-module-key="settings"]');
      expect(view).toBeInTheDocument();
      expect(view).toHaveClass('analysis-module-enter');
    });
  });

  it('keeps the workbench back button clickable outside the titlebar drag layer', async () => {
    Object.defineProperty(window.navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    invokeMock.mockResolvedValue({});

    const { container } = render(<App />);
    fireEvent.click(screen.getByText('本地分析'));

    const chrome = await waitFor(() => {
      const layer = container.querySelector('.app-chrome');
      if (!(layer instanceof HTMLElement)) {
        throw new Error('App chrome was not rendered');
      }
      return layer;
    });
    expect(chrome).toHaveClass('app-chrome-workbench');
    expect(chrome.querySelector('.app-chrome-context')).toBeInTheDocument();
    expect(chrome.querySelector('.app-chrome-back')).toBeInTheDocument();
    expect(chrome.querySelector('.app-chrome-add')).not.toBeInTheDocument();
    expect(container.querySelector('.analysis-sider-header')).not.toBeInTheDocument();
    expect(container.querySelector('.titlebar-drag-region')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回模式选择' }));

    await waitFor(() => {
      expect(screen.getByText('Lumina 应急响应分析工具')).toBeInTheDocument();
    });
  });
});
