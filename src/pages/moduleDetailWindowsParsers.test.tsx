/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import ModuleDetail from './ModuleDetail';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
}));

beforeAll(() => {
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
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function renderLocalWindowsModule(moduleKey: string, stdout: string, options: { isDarkMode?: boolean } = {}) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'execute_local_command') {
      return {
        success: true,
        stdout,
        stderr: '',
      };
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  return render(
    <ModuleDetail
      moduleKey={moduleKey}
      mode="local"
      osType="Windows"
      privilegeMode="none"
      sudoPassword=""
      isDarkMode={options.isDarkMode ?? false}
      glassEnabled={false}
      wallpaper=""
    />,
  );
}

describe('ModuleDetail Windows log rendering', () => {
  it('shows the returned Windows event log message content', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              time: '2026-05-26 12:00:00',
              id: 4625,
              message: 'Failed login from 10.0.0.8',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="win_security_log"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Failed login from 10.0.0.8')).toBeInTheDocument();
    });
  });

  it('shows full event log artifact metadata while rendering preview rows', async () => {
    renderLocalWindowsModule(
      'win_security_log',
      JSON.stringify({
        artifactPath: 'C:\\Users\\analyst\\AppData\\Local\\Temp\\Lumina-IR\\Security-20260625.csv',
        totalCount: 1200,
        preview: [
          {
            time: '2026-06-25 19:30:00',
            id: 4625,
            message: 'Failed login from 10.0.0.8',
          },
        ],
        format: 'csv',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Failed login from 10.0.0.8')).toBeInTheDocument();
      expect(screen.getByText(/预览 1 条 \/ 全量 1200 条/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /打开全量文件/ })).toBeInTheDocument();
    });
  });

  it('renders quick event log previews without pretending they are full artifacts', async () => {
    renderLocalWindowsModule(
      'win_security_log',
      JSON.stringify({
        previewLimit: 500,
        isPreview: true,
        preview: [
          {
            time: '2026-06-25 19:30:00',
            id: 4625,
            message: 'Failed login from 10.0.0.8',
          },
        ],
        format: 'json',
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('Failed login from 10.0.0.8')).toBeInTheDocument();
      expect(screen.getByText(/\u5feb\u901f\u9884\u89c8 1 \u6761/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /\u52a0\u8f7d\u5168\u90e8\u65e5\u5fd7/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /\u6253\u5f00\u5168\u91cf\u6587\u4ef6/ })).not.toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows event log output is an access error', async () => {
    renderLocalWindowsModule('win_security_log', '[需要管理员权限] 请以管理员身份运行程序来查看安全日志');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('采集失败')).toBeInTheDocument();
      expect(screen.getAllByText(/管理员身份/).length).toBeGreaterThan(0);
    });
  });

  it('shows a diagnostic when Windows event log JSON cannot be parsed', async () => {
    renderLocalWindowsModule('win_system_log', 'Get-WinEvent : The data is invalid.');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('解析失败')).toBeInTheDocument();
      expect(screen.getByText(/Windows 事件日志输出不是有效 JSON/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows event log returns no records', async () => {
    renderLocalWindowsModule('win_app_log', '[]');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/Windows 事件日志查询已执行/)).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows security event rendering', () => {
  it('shows a diagnostic when Windows security events cannot be parsed', async () => {
    renderLocalWindowsModule('security_events', 'Get-WinEvent : Access is denied.');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('解析失败')).toBeInTheDocument();
      expect(screen.getByText(/Windows 安全事件输出不是有效 JSON/)).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows timeline rendering', () => {
  it('merges timeline rows from security, file, and persistence sources in newest-first order', async () => {
    const { container } = renderLocalWindowsModule(
      'windows_timeline',
      JSON.stringify([
        {
          time: '2026-06-27 09:10:00',
          category: 'File',
          source: 'Recent webroot',
          title: 'shell.aspx',
          actor: 'IIS',
          target: 'C:\\inetpub\\wwwroot\\shell.aspx',
          risk: 'warning',
          detail: 'Recently modified web file',
        },
        {
          time: '2026-06-27 09:30:00',
          category: 'Security',
          source: 'Security 4625',
          title: 'Failed logon',
          actor: 'Administrator',
          target: '10.0.0.8',
          risk: 'high',
          detail: 'Failed logon from 10.0.0.8',
        },
        {
          time: '2026-06-27 09:20:00',
          category: 'Persistence',
          source: 'Scheduled Task',
          title: 'UpdateCheck',
          actor: 'SYSTEM',
          target: 'powershell.exe -File C:\\ProgramData\\up.ps1',
          risk: 'warning',
          detail: 'Suspicious scheduled task action',
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText('Failed logon')).toBeInTheDocument();
      expect(screen.getByText('UpdateCheck')).toBeInTheDocument();
      expect(screen.getByText('shell.aspx')).toBeInTheDocument();
      expect(screen.getByText('Security 4625')).toBeInTheDocument();
      expect(screen.getByText('Scheduled Task')).toBeInTheDocument();
      expect(screen.getByText('Recent webroot')).toBeInTheDocument();
    });

    const bodyText = container.textContent ?? '';
    expect(bodyText.indexOf('Failed logon')).toBeLessThan(bodyText.indexOf('UpdateCheck'));
    expect(bodyText.indexOf('UpdateCheck')).toBeLessThan(bodyText.indexOf('shell.aspx'));
    expect(screen.getAllByText('high').length).toBeGreaterThan(0);
    expect(screen.getAllByText('warning').length).toBeGreaterThan(0);
  });

  it('shows a diagnostic when the Windows timeline returns no rows', async () => {
    renderLocalWindowsModule('windows_timeline', '[]');

    await waitFor(() => {
      expect(screen.getAllByText(/windows_timeline/).length).toBeGreaterThan(0);
      expect(screen.getByText(/Windows timeline/)).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows scheduled task rendering', () => {
  it('shows task path, action, trigger, and run status returned by Windows', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              TaskPath: '\\Microsoft\\Windows\\Defrag\\',
              TaskName: 'ScheduledDefrag',
              State: 'Ready',
              Author: 'Microsoft Corporation',
              Description: 'Scheduled disk defragmentation',
              Actions: 'defrag.exe -c -h -o',
              Triggers: 'Weekly 03:00',
              LastRunTime: '2026-05-25 03:00:00',
              NextRunTime: '2026-06-01 03:00:00',
              LastTaskResult: 0,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="cron"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('\\Microsoft\\Windows\\Defrag\\')).toBeInTheDocument();
      expect(screen.getByText('ScheduledDefrag')).toBeInTheDocument();
      expect(screen.getByText('defrag.exe -c -h -o')).toBeInTheDocument();
      expect(screen.getByText('Weekly 03:00')).toBeInTheDocument();
      expect(screen.getByText('2026-06-01 03:00:00')).toBeInTheDocument();
      expect(screen.getByText('0')).toBeInTheDocument();
    });
  });

  it('shows a diagnostic instead of placeholder dashes when Windows returns no scheduled tasks', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="cron"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/计划任务命令已执行/)).toBeInTheDocument();
    });
  });

  it('shows the Windows scheduled task collection error returned by PowerShell', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify({ error: 'Access is denied.' }),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="cron"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('采集失败')).toBeInTheDocument();
      expect(screen.getByText('Access is denied.')).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows process anomaly rendering', () => {
  it('shows Windows process parent, command line, owner, signature, and hash evidence', async () => {
    renderLocalWindowsModule(
      'process_anomaly',
      JSON.stringify([
        {
          type: 'SENSITIVE_PATH',
          pid: 4242,
          ppid: 1000,
          name: 'payload.exe',
          user: 'DESKTOP\\analyst',
          path: 'C:\\Users\\Public\\payload.exe',
          command: 'C:\\Users\\Public\\payload.exe -k',
          parent: 'explorer.exe',
          signer: 'Unsigned',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          detail: 'Process runs from user-writable path',
          severity: 'high',
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText('payload.exe')).toBeInTheDocument();
      expect(screen.getByText('4242')).toBeInTheDocument();
      expect(screen.getByText('1000')).toBeInTheDocument();
      expect(screen.getByText('explorer.exe')).toBeInTheDocument();
      expect(screen.getByText('DESKTOP\\analyst')).toBeInTheDocument();
      expect(screen.getByText('Unsigned')).toBeInTheDocument();
      expect(screen.getByText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeInTheDocument();
      expect(screen.getByText('C:\\Users\\Public\\payload.exe -k')).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows network rendering', () => {
  it('shows TCP connection process details instead of hiding them in queue columns', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              LocalAddress: '127.0.0.1',
              LocalPort: 5173,
              RemoteAddress: '127.0.0.1',
              RemotePort: 61234,
              State: 'Established',
              OwningProcess: 4321,
              ProcessName: 'chrome',
              ProcessPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="network_conn"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('127.0.0.1:5173')).toBeInTheDocument();
      expect(screen.getByText('127.0.0.1:61234')).toBeInTheDocument();
      expect(screen.getByText('4321')).toBeInTheDocument();
      expect(screen.getByText('chrome')).toBeInTheDocument();
    });
  });

  it('shows listening port process details', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              LocalAddress: '0.0.0.0',
              LocalPort: 3389,
              State: 'Listen',
              OwningProcess: 888,
              ProcessName: 'svchost',
              ProcessPath: 'C:\\Windows\\System32\\svchost.exe',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="listen_ports"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('0.0.0.0:3389')).toBeInTheDocument();
      expect(screen.getByText('888')).toBeInTheDocument();
      expect(screen.getByText('svchost')).toBeInTheDocument();
    });
  });
});

describe('ModuleDetail Windows inventory rendering', () => {
  it('renders Windows table data in a unified workbench without a separate result header', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              DisplayName: '7-Zip 24.09',
              DisplayVersion: '24.09',
              Publisher: 'Igor Pavlov',
              InstallDate: '20260520',
              InstallLocation: 'C:\\Program Files\\7-Zip',
              UninstallString: 'MsiExec.exe /I{7ZIP}',
              EstimatedSize: 61440,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { container } = render(
      <ModuleDetail
        moduleKey="installed_software"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('7-Zip 24.09')).toBeInTheDocument();
    });
    expect(container.querySelector('.windows-module-workspace')).toBeInTheDocument();
    expect(container.querySelector('.windows-data-workbench')).toBeInTheDocument();
    expect(container.querySelector('.windows-search-input')).toBeInTheDocument();
    expect(container.querySelector('.windows-data-toolbar .ant-input-search-button')).not.toBeInTheDocument();
    expect(container.querySelector('.windows-data-surface-header')).not.toBeInTheDocument();
    expect(container.querySelector('.windows-data-legacy-header')).not.toBeInTheDocument();
  });

  it('filters Windows table rows when search text is typed without parent search props', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              DisplayName: '7-Zip 24.09',
              DisplayVersion: '24.09',
              Publisher: 'Igor Pavlov',
              InstallDate: '20260520',
              InstallLocation: 'C:\\Program Files\\7-Zip',
              UninstallString: 'MsiExec.exe /I{7ZIP}',
              EstimatedSize: 61440,
            },
            {
              DisplayName: 'Chrome 126',
              DisplayVersion: '126.0',
              Publisher: 'Google LLC',
              InstallDate: '20260521',
              InstallLocation: 'C:\\Program Files\\Google\\Chrome',
              UninstallString: 'ChromeSetup.exe --uninstall',
              EstimatedSize: 307200,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { container } = render(
      <ModuleDetail
        moduleKey="installed_software"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('7-Zip 24.09')).toBeInTheDocument();
      expect(screen.getByText('Chrome 126')).toBeInTheDocument();
    });

    const input = container.querySelector<HTMLInputElement>('.windows-search-input input');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { value: 'Chrome' } });

    await waitFor(() => {
      expect(screen.getByText('Chrome 126')).toBeInTheDocument();
      expect(screen.queryByText('7-Zip 24.09')).not.toBeInTheDocument();
    });
  });

  it('shows a stable Windows empty state instead of a table shell when search has no matches', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              DisplayName: '7-Zip 24.09',
              DisplayVersion: '24.09',
              Publisher: 'Igor Pavlov',
              InstallDate: '20260520',
              InstallLocation: 'C:\\Program Files\\7-Zip',
              UninstallString: 'MsiExec.exe /I{7ZIP}',
              EstimatedSize: 61440,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    const { container } = render(
      <ModuleDetail
        moduleKey="installed_software"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('7-Zip 24.09')).toBeInTheDocument();
    });

    const input = container.querySelector<HTMLInputElement>('.windows-search-input input');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, { target: { value: 'NoSuchApp' } });

    await waitFor(() => {
      expect(container.querySelector('.windows-filter-empty')).toBeInTheDocument();
      expect(container.querySelector('.windows-data-table-frame')).not.toBeInTheDocument();
      expect(screen.queryByText('7-Zip 24.09')).not.toBeInTheDocument();
    });
  });

  it('shows Windows database services from DB_SERVICES output', async () => {
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
                Status: 'Running',
              },
              {
                Name: 'Redis',
                DisplayName: 'Redis Service',
                Status: 'Stopped',
              },
            ]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="database"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('SQL Server (MSSQLSERVER)')).toBeInTheDocument();
      expect(screen.getByText('Redis Service')).toBeInTheDocument();
    });
  });

  it('shows installed software location, uninstall command, and estimated size', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              DisplayName: '7-Zip 24.09',
              DisplayVersion: '24.09',
              Publisher: 'Igor Pavlov',
              InstallDate: '20260520',
              InstallLocation: 'C:\\Program Files\\7-Zip',
              UninstallString: 'MsiExec.exe /I{7ZIP}',
              EstimatedSize: 61440,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="installed_software"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('7-Zip 24.09')).toBeInTheDocument();
      expect(screen.getByText('Igor Pavlov')).toBeInTheDocument();
      expect(screen.getByText('60.0 MB')).toBeInTheDocument();
      expect(screen.getByText('C:\\Program Files\\7-Zip')).toBeInTheDocument();
      expect(screen.getByText('MsiExec.exe /I{7ZIP}')).toBeInTheDocument();
    });
  });

  it('renders the Windows software menu alias with the installed software columns', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              DisplayName: 'Emergency Agent',
              DisplayVersion: '1.2.3',
              Publisher: 'Sola Tools',
              InstallDate: '20260526',
              InstallLocation: 'C:\\Program Files\\Emergency Agent',
              UninstallString: 'C:\\Program Files\\Emergency Agent\\uninstall.exe',
              EstimatedSize: 20480,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="software"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('软件安装分析')).toBeInTheDocument();
      expect(screen.getByText('Emergency Agent')).toBeInTheDocument();
      expect(screen.getByText('Sola Tools')).toBeInTheDocument();
      expect(screen.getByText('20.0 MB')).toBeInTheDocument();
      expect(screen.getByText('C:\\Program Files\\Emergency Agent')).toBeInTheDocument();
    });
  });

  it('shows logged user session id, state, idle time, and logon time', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              User: 'analyst',
              SessionName: 'console',
              SessionId: 1,
              State: 'Active',
              IdleTime: 'none',
              LogonTime: '2026-05-26 09:10',
              Source: 'Local',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="logged_users"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('analyst')).toBeInTheDocument();
      expect(screen.getByText('console')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getAllByText('none').length).toBeGreaterThan(0);
      expect(screen.getByText('2026-05-26 09:10')).toBeInTheDocument();
    });

    const row = screen.getByText('analyst').closest('.ant-table-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});

describe('ModuleDetail Windows security module rendering', () => {
  it('shows Defender status fields returned by PowerShell', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify({
            AntivirusEnabled: true,
            RealTimeProtectionEnabled: false,
            AntivirusSignatureLastUpdated: '2026-05-25 10:00:00',
            AMProductVersion: '4.18.24090.11',
          }),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="win_defender"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('AntivirusEnabled')).toBeInTheDocument();
      expect(screen.getByText('RealTimeProtectionEnabled')).toBeInTheDocument();
      expect(screen.getByText('2026-05-25 10:00:00')).toBeInTheDocument();
      expect(screen.getByText('4.18.24090.11')).toBeInTheDocument();
    });
  });

  it('shows Windows firewall profiles as structured settings instead of raw lines', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            'Domain Profile Settings:',
            '----------------------------------------------------------------------',
            'State                                 ON',
            'Firewall Policy                       BlockInbound,AllowOutbound',
            'Private Profile Settings:',
            'State                                 OFF',
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="win_firewall"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Domain').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Private').length).toBeGreaterThan(0);
      expect(screen.getAllByText('State').length).toBeGreaterThan(0);
      expect(screen.getByText('BlockInbound,AllowOutbound')).toBeInTheDocument();
    });
  });

  it('uses dark-safe code styling for Windows firewall raw values', async () => {
    const { container } = renderLocalWindowsModule(
      'win_firewall',
      [
        'Domain Profile Settings:',
        '----------------------------------------------------------------------',
        'State                                 OFF',
        'Firewall Policy                       BlockInbound,AllowOutbound',
      ].join('\n'),
      { isDarkMode: true },
    );

    await waitFor(() => {
      expect(screen.getByText('BlockInbound,AllowOutbound')).toBeInTheDocument();
    });

    expect(container.querySelector('.windows-module-table')).toBeInTheDocument();
    expect(container.querySelector('.windows-table-code')).toBeInTheDocument();
  });

  it('shows persistence task paths, triggers, and service commands', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===SCHEDULED_TASKS===',
            JSON.stringify([
              {
                TaskPath: '\\Microsoft\\Windows\\Update\\',
                TaskName: 'UpdateTask',
                State: 'Ready',
                Actions: 'powershell.exe -File C:\\Temp\\u.ps1',
                Triggers: 'At logon',
              },
            ]),
            '===SERVICES_AUTO===',
            JSON.stringify([
              {
                Name: 'BadSvc',
                DisplayName: 'Bad Service',
                Status: 'Running',
                StartType: 'Automatic',
                PathName: 'C:\\Temp\\bad.exe',
              },
            ]),
            '===STARTUP_FOLDER===',
            JSON.stringify([
              {
                Name: 'RunMe',
                Command: 'C:\\Temp\\runme.exe',
                Location: 'HKCU Run',
                User: 'analyst',
              },
            ]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="persistence"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('\\Microsoft\\Windows\\Update\\UpdateTask')).toBeInTheDocument();
      expect(screen.getByText('powershell.exe -File C:\\Temp\\u.ps1')).toBeInTheDocument();
      expect(screen.getByText('At logon')).toBeInTheDocument();
      expect(screen.getByText('BadSvc')).toBeInTheDocument();
      expect(screen.getByText('C:\\Temp\\bad.exe')).toBeInTheDocument();
      expect(screen.getByText('RunMe')).toBeInTheDocument();
    });
  });

  it('shows RDP listener, service, and registry state', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===RDP_CONN===',
            JSON.stringify([
              {
                LocalAddress: '0.0.0.0',
                LocalPort: 3389,
                RemoteAddress: '10.0.0.9',
                RemotePort: 50123,
                State: 'Established',
                OwningProcess: 888,
                ProcessName: 'svchost',
              },
            ]),
            '===RDP_SERVICE===',
            JSON.stringify({
              Name: 'TermService',
              DisplayName: 'Remote Desktop Services',
              Status: 'Running',
              StartType: 'Manual',
            }),
            '===RDP_REGISTRY===',
            JSON.stringify({
              fDenyTSConnections: 0,
              UserAuthentication: 1,
            }),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="rdp"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('0.0.0.0:3389')).toBeInTheDocument();
      expect(screen.getByText('10.0.0.9:50123')).toBeInTheDocument();
      expect(screen.getByText('svchost')).toBeInTheDocument();
      expect(screen.getByText('Remote Desktop Services')).toBeInTheDocument();
      expect(screen.getByText('fDenyTSConnections')).toBeInTheDocument();
      expect(screen.getByText('UserAuthentication')).toBeInTheDocument();
    });
  });

  it('shows browser profile metadata instead of raw PowerShell formatting', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===CHROME===',
            JSON.stringify([
              {
                Browser: 'Chrome',
                Profile: 'Default',
                Path: 'C:\\Users\\analyst\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
                LastWriteTime: '2026-05-26 11:00:00',
                HistoryPath: 'C:\\Users\\analyst\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\History',
                HistoryLastWriteTime: '2026-05-26 10:30:00',
              },
            ]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="browser"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome')).toBeInTheDocument();
      expect(screen.getByText('Default')).toBeInTheDocument();
      expect(screen.getByText('C:\\Users\\analyst\\AppData\\Local\\Google\\Chrome\\User Data\\Default')).toBeInTheDocument();
      expect(screen.getByText('2026-05-26 10:30:00')).toBeInTheDocument();
    });
  });

  it('shows Windows panel sites when PowerShell returns a single JSON object', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===PHPSTUDY===',
            'PhpStudy Pro检测到',
            JSON.stringify({
              Name: 'demo.local',
              Length: 4096,
              LastWriteTime: '2026-05-26T10:30:00',
            }),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="panel"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('demo.local')).toBeInTheDocument();
      expect(screen.getByText('C:\\phpstudy_pro\\WWW\\demo.local')).toBeInTheDocument();
      expect(screen.getByText('4 KB')).toBeInTheDocument();
      expect(screen.getByText('2026-05-26')).toBeInTheDocument();
    });
  });

  it('renders the refactored Windows panel detection workspace without duplicate service or diagnostics sections', async () => {
    renderLocalWindowsModule(
      'panel',
      [
        '===PANELS===',
        JSON.stringify([{ PanelType: 'phpstudy', Name: 'PhpStudy Pro', Path: 'C:\\phpstudy_pro', SiteRoot: 'C:\\phpstudy_pro\\WWW', Detected: true, SiteCount: 1, ServiceState: 'Running', Evidence: 'path; service', Notes: 'installed' }]),
        '===IIS_SITES===',
        JSON.stringify([{ Name: 'Default Web Site', PhysicalPath: 'C:\\inetpub\\wwwroot', State: 'Started', Bindings: '*:80:' }]),
        '===SERVICES===',
        JSON.stringify([{ Source: 'phpstudy', Name: 'Apache2.4', DisplayName: 'Apache2.4', State: 'Running', StartMode: 'Auto', PathName: 'C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe', ProcessId: 1234 }]),
        '===LOGS===',
        JSON.stringify([{ Source: 'phpstudy', Path: 'C:\\phpstudy_pro\\COM\\log\\phpstudy.log', Length: 2048, LastWriteTime: '2026-06-25T20:00:00', Note: 'phpStudy log' }]),
        '===DIAGNOSTICS===',
        JSON.stringify(['Everything ES.exe: C:\\app\\bin\\everything\\es.exe', 'IIS WebAdministration module is unavailable']),
      ].join('\n'),
    );

    expect(await screen.findByText('PhpStudy Pro')).toBeInTheDocument();
    expect(screen.getByText('C:\\phpstudy_pro')).toBeInTheDocument();
    expect(screen.getByText('Default Web Site')).toBeInTheDocument();
    expect(screen.getByText('C:\\phpstudy_pro\\COM\\log\\phpstudy.log')).toBeInTheDocument();
    expect(screen.queryByText('已发现')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /服务/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /诊断/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Apache2.4')).not.toBeInTheDocument();
    expect(screen.queryByText('IIS WebAdministration module is unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Everything ES.exe: C:\\app\\bin\\everything\\es.exe')).not.toBeInTheDocument();
  });

  it('renders a deliberate Windows panel empty state when no panel is detected', async () => {
    renderLocalWindowsModule(
      'panel',
      [
        '===PANELS===',
        JSON.stringify([{ PanelType: 'xampp', Name: 'XAMPP', Path: 'C:\\xampp', SiteRoot: 'C:\\xampp\\htdocs', Detected: false, SiteCount: 0, Notes: 'not found' }]),
        '===IIS_SITES===',
        '[]',
        '===SERVICES===',
        '[]',
        '===LOGS===',
        '[]',
        '===DIAGNOSTICS===',
        JSON.stringify(['Checked BaoTa Windows, phpStudy, XAMPP, WampServer, and IIS']),
      ].join('\n'),
    );

    expect(await screen.findByText('未发现常见 Windows Web 面板')).toBeInTheDocument();
    expect(screen.getAllByText(/BaoTa Windows/).length).toBeGreaterThan(0);
  });

  it('runs Docker read-only container checks through the local command bridge', async () => {
    const executedCommands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        executedCommands.push(args?.command || '');
        if (args?.command?.includes('docker exec')) {
          return { success: true, stdout: 'PID USER COMMAND\n1 root nginx', stderr: '' };
        }

        return {
          success: true,
          stdout: [
            '===DOCKER_INSTALL===',
            JSON.stringify([{ CommandPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', Version: '26.1.0' }]),
            '===DOCKER_SERVICE===',
            '[]',
            '===DOCKER_CONTAINERS===',
            JSON.stringify([{ ID: 'abc123def456', Image: 'nginx:stable', Status: 'Up 2 hours', Names: 'web', Ports: '0.0.0.0:8080->80/tcp' }]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="docker"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    expect(await screen.findByText('nginx:stable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /分析 web/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /进程/ }));

    await waitFor(() => {
      expect(screen.getByText(/PID USER COMMAND/)).toBeInTheDocument();
    });
    expect(executedCommands.some((cmd) => (
      cmd.includes('docker exec')
        && cmd.includes('abc123def456')
        && cmd.includes('ps')
    ))).toBe(true);
  });

  it('shows compact Docker container action buttons for local investigation', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '===DOCKER_INSTALL===',
            JSON.stringify([{ CommandPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', Version: '26.1.0' }]),
            '===DOCKER_SERVICE===',
            '[]',
            '===DOCKER_CONTAINERS===',
            JSON.stringify([{ ID: 'abc123def456', Image: 'nginx:stable', Status: 'Up 2 hours', Names: 'web', Ports: '0.0.0.0:8080->80/tcp' }]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="docker"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    expect(await screen.findByText('nginx:stable')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '查看容器详情' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '浏览容器文件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看容器日志' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '运行只读检查' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '执行容器命令' })).toBeInTheDocument();
  });

  it('requires confirmation before running an advanced Docker container command', async () => {
    const executedCommands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        executedCommands.push(args?.command || '');
        if (args?.command?.includes('docker exec')) {
          return { success: true, stdout: 'uid=0(root)', stderr: '' };
        }

        return {
          success: true,
          stdout: [
            '===DOCKER_INSTALL===',
            JSON.stringify([{ CommandPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', Version: '26.1.0' }]),
            '===DOCKER_SERVICE===',
            '[]',
            '===DOCKER_CONTAINERS===',
            JSON.stringify([{ ID: 'abc123def456', Image: 'nginx:stable', Status: 'Up 2 hours', Names: 'web', Ports: '80/tcp' }]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="docker"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    expect(await screen.findByText('nginx:stable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /分析 web/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /高级执行/ }));
    fireEvent.change(await screen.findByLabelText('容器命令'), {
      target: { value: 'id' },
    });
    fireEvent.click(screen.getByRole('button', { name: /执行命令/ }));

    expect(executedCommands.filter((cmd) => cmd.includes('docker exec'))).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: /确认执行/ }));

    await waitFor(() => {
      expect(screen.getByText('uid=0(root)')).toBeInTheDocument();
    });
    expect(executedCommands.some((cmd) => cmd.includes('docker exec') && cmd.includes('id'))).toBe(true);
  });

  it('quotes advanced Docker commands safely for the Windows local PowerShell bridge', async () => {
    const executedCommands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        executedCommands.push(args?.command || '');
        if (args?.command?.includes('docker exec')) {
          return { success: true, stdout: 'ID=alpine', stderr: '' };
        }

        return {
          success: true,
          stdout: [
            '===DOCKER_INSTALL===',
            JSON.stringify([{ CommandPath: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', Version: '26.1.0' }]),
            '===DOCKER_SERVICE===',
            '[]',
            '===DOCKER_CONTAINERS===',
            JSON.stringify([{ ID: 'abc123def456', Image: 'alpine:latest', Status: 'Up 2 hours', Names: 'shell', Ports: '' }]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="docker"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    expect(await screen.findByText('alpine:latest')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '执行容器命令' }));
    fireEvent.change(await screen.findByLabelText('容器命令'), {
      target: { value: 'cat /etc/os-release | grep "ID="' },
    });
    fireEvent.click(screen.getByRole('button', { name: /执行命令/ }));
    fireEvent.click(await screen.findByRole('button', { name: /确认执行/ }));

    await waitFor(() => {
      expect(screen.getByText('ID=alpine')).toBeInTheDocument();
    });

    const dockerExec = executedCommands.find((cmd) => cmd.includes('docker exec')) || '';
    expect(dockerExec).toContain('grep "ID="');
    expect(dockerExec).not.toContain('\\"ID=\\"');
  });

  it('runs a bounded Windows webshell scan and renders Windows path hits', async () => {
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        expect(args?.command).toContain('Select-String');
        expect(args?.command).not.toContain('disabled');
        return {
          success: true,
          stdout: [
            '===PHP===',
            "C:\\inetpub\\wwwroot\\shell.php:12:<?php eval($_POST['x']); ?>",
            '===JSP===',
            'C:\\tomcat\\webapps\\ROOT\\cmd.jsp:8:new ProcessBuilder(request.getParameter("cmd")).start();',
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="webshell_scan"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('shell.php')).toBeInTheDocument();
      expect(screen.getByText('cmd.jsp')).toBeInTheDocument();
      expect(screen.getByText('eval')).toBeInTheDocument();
      expect(screen.getByText('ProcessBuilder')).toBeInTheDocument();
    });
  });

  it('shows high-value Windows security events from the dedicated scan module', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              EventId: 4625,
              TimeCreated: '2026-05-26 12:30:00',
              EventType: 'Failed logon',
              Description: 'An account failed to log on',
              Username: 'analyst',
              SourceIp: '203.0.113.9',
              LogonType: '10',
              Status: '0xC000006D',
              Suspicious: true,
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="security_events"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('4625')).toBeInTheDocument();
      expect(screen.getByText('Failed logon')).toBeInTheDocument();
      expect(screen.getByText('analyst')).toBeInTheDocument();
      expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
      expect(screen.getByText('0xC000006D')).toBeInTheDocument();
    });
  });

  it('shows Windows file scan findings with category, path, size, and risk', async () => {
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        expect(args?.command).toContain('RECENT_TEMP');
        return {
          success: true,
          stdout: [
            '===RECENT_TEMP===',
            JSON.stringify([
              {
                FullName: 'C:\\Users\\analyst\\AppData\\Local\\Temp\\payload.ps1',
                Name: 'payload.ps1',
                Length: 2048,
                LastWriteTime: '2026-05-26 12:20:00',
                Extension: '.ps1',
              },
            ]),
            '===USER_WRITABLE_EXECUTABLES===',
            JSON.stringify([
              {
                FullName: 'C:\\Users\\Public\\Downloads\\tool.exe',
                Name: 'tool.exe',
                Length: 1048576,
                LastWriteTime: '2026-05-25 08:00:00',
                Extension: '.exe',
              },
            ]),
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="file_scan"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('payload.ps1')).toBeInTheDocument();
      expect(screen.getByText('Recent temp file')).toBeInTheDocument();
      expect(screen.getByText('C:\\Users\\analyst\\AppData\\Local\\Temp')).toBeInTheDocument();
      expect(screen.getByText('2 KB')).toBeInTheDocument();
      expect(screen.getByText('tool.exe')).toBeInTheDocument();
      expect(screen.getByText('User-writable executable')).toBeInTheDocument();
      expect(screen.getByText('1 MB')).toBeInTheDocument();
    });
  });

  it('searches indexed files with Everything live while typing', async () => {
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'everything_search_page') {
        const request = args?.request;
        expect(request).toMatchObject({
          query: 'shell.php',
          offset: 0,
          path: undefined,
          maxResults: 50,
          filesOnly: true,
          includeTotalCount: true,
        });
        expect(request).not.toHaveProperty('sort');
        expect(request).not.toHaveProperty('sortDescending');
        return {
          results: [
            {
              fullPath: 'C:\\inetpub\\wwwroot\\shell.php',
              name: 'shell.php',
              parentPath: 'C:\\inetpub\\wwwroot',
              extension: 'php',
              size: 512,
              dateModified: '2026-05-26T09:00:00',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
        };
      }

      if (command === 'execute_local_command') {
        throw new Error('IOC file search should not run PowerShell recursion');
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    expect(invokeMock).not.toHaveBeenCalled();

    expect(screen.queryByText('搜索结果')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /搜\s*索/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'shell.php' },
    });

    await waitFor(() => {
      expect(screen.getByText('shell.php')).toBeInTheDocument();
      expect(screen.getByText('C:\\inetpub\\wwwroot\\shell.php')).toBeInTheDocument();
      expect(screen.getByText('512 B')).toBeInTheDocument();
      expect(screen.getByText('2026-05-26 09:00:00')).toBeInTheDocument();
    });

    expect(invokeMock).not.toHaveBeenCalledWith('execute_local_command', expect.anything());
  });

  it('previews Windows local Everything text results with PowerShell instead of Linux redirection', async () => {
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'everything_search_page') {
        return {
          results: [
            {
              fullPath: 'C:\\Users\\15823\\sdk\\go1.25.0\\src\\cmd\\go\\testdata\\script.go',
              name: 'script.go',
              parentPath: 'C:\\Users\\15823\\sdk\\go1.25.0\\src\\cmd\\go\\testdata',
              extension: 'go',
              size: 128,
              dateModified: '2026-05-26T09:00:00',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
        };
      }

      if (command === 'execute_local_command') {
        expect(args?.command).toContain('Get-Content');
        expect(args?.command).toContain('-LiteralPath');
        expect(args?.command).not.toContain('/dev/null');
        return {
          success: true,
          stdout: 'package main',
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'script.go' },
    });

    await waitFor(() => {
      expect(screen.getByText('script.go')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /script\.go/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('execute_local_command', expect.anything());
      expect(screen.getByText('package main')).toBeInTheDocument();
    });
  });

  it('does not run broad Everything searches for single-character input', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'a' },
    });

    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('builds Everything queries from advanced IOC file search filters', async () => {
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'everything_search_page') {
        return {
          results: [
            {
              fullPath: 'C:\\inetpub\\wwwroot\\shell.php',
              name: 'shell.php',
              parentPath: 'C:\\inetpub\\wwwroot',
              extension: 'php',
              size: 512,
              dateModified: '2026-05-26T09:00:00',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /高级/ }));
    fireEvent.change(screen.getByLabelText('指定后缀'), {
      target: { value: 'php, aspx' },
    });
    fireEvent.change(screen.getByLabelText('指定目录'), {
      target: { value: 'C:\\inetpub\\wwwroot' },
    });
    fireEvent.change(screen.getByLabelText('哈希值'), {
      target: { value: '0123456789abcdef0123456789abcdef' },
    });
    fireEvent.change(screen.getByLabelText('文件内容'), {
      target: { value: 'eval(' },
    });
    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'shell' },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('everything_search_page', {
        request: expect.objectContaining({
          query: 'shell ext:php;aspx md5:0123456789abcdef0123456789abcdef content:"eval("',
          path: 'C:\\inetpub\\wwwroot',
          offset: 0,
          maxResults: 50,
          filesOnly: true,
          includeTotalCount: true,
        }),
      });
    });
  });

  it('pages Everything results with offset instead of increasing the search limit', async () => {
    const requests: any[] = [];
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'everything_search_page') {
        const request = args?.request;
        requests.push(request);
        const pageName = request.offset === 50 ? 'shell-page-2.php' : 'shell-page-1.php';
        return {
          results: [
            {
              fullPath: `C:\\inetpub\\wwwroot\\${pageName}`,
              name: pageName,
              parentPath: 'C:\\inetpub\\wwwroot',
              extension: 'php',
              size: 512,
              dateModified: '2026-05-26T09:00:00',
            },
          ],
          totalCount: 75,
          offset: request.offset,
          limit: 50,
          hasMore: request.offset === 0,
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'shell' },
    });

    await waitFor(() => {
      expect(screen.getByText('shell-page-1.php')).toBeInTheDocument();
    });

    expect(requests[0]).toMatchObject({
      query: 'shell',
      offset: 0,
      maxResults: 50,
      includeTotalCount: true,
    });

    const pager = screen.getByLabelText('Everything search pagination');
    fireEvent.click(within(pager).getByText('2'));

    await waitFor(() => {
      expect(screen.getByText('shell-page-2.php')).toBeInTheDocument();
    });

    expect(requests[1]).toMatchObject({
      query: 'shell',
      offset: 50,
      maxResults: 50,
      includeTotalCount: true,
    });
  });

  it('does not run full-disk Everything content searches without a directory', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="ioc_file_search"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /高级/ }));
    fireEvent.change(screen.getByLabelText('文件内容'), {
      target: { value: 'eval(' },
    });
    fireEvent.change(screen.getByLabelText('Everything 实时搜索'), {
      target: { value: 'shell' },
    });

    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not use Everything for the generic Windows file scan', async () => {
    invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
      if (command === 'execute_local_command') {
        expect(args?.command).toContain('RECENT_TEMP');
        return {
          success: true,
          stdout: [
            '===RECENT_TEMP===',
            '[]',
            '===USER_WRITABLE_EXECUTABLES===',
            '[]',
            '===RECENT_WEBROOT===',
            '[]',
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="file_scan"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
    });

    expect(invokeMock).not.toHaveBeenCalledWith('everything_search_page', expect.anything());
  });

  it('flags sensitive and risky Windows environment variables', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            { Name: 'API_TOKEN', Value: 'secret-value' },
            { Name: 'PATH', Value: 'C:\\Users\\Public\\bin;C:\\Windows\\System32' },
            { Name: 'PSModulePath', Value: 'C:\\Users\\analyst\\Documents\\PowerShell\\Modules' },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="env_vars"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('API_TOKEN')).toBeInTheDocument();
      expect(screen.getByText('credential')).toBeInTheDocument();
      expect(screen.getByText('sensitive-value')).toBeInTheDocument();
      expect(screen.getByText('path-risk')).toBeInTheDocument();
      expect(screen.getByText('user-writable-directory-in-path')).toBeInTheDocument();
    });
  });

  it('keeps full Windows recent file paths for triage', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              Name: 'payload.lnk',
              FullName: 'C:\\Users\\analyst\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\payload.lnk',
              TargetPath: 'C:\\Users\\Public\\Downloads\\payload.exe',
              LastAccessTime: '2026-05-26 12:00:00',
            },
          ]),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="recent_files"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('payload.lnk')).toBeInTheDocument();
      expect(screen.getByText('C:\\Users\\analyst\\AppData\\Roaming\\Microsoft\\Windows\\Recent\\payload.lnk')).toBeInTheDocument();
      expect(screen.getByText('C:\\Users\\Public\\Downloads\\payload.exe')).toBeInTheDocument();
    });
  });

  it('marks suspicious Windows hosts file mappings', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'execute_local_command') {
        return {
          success: true,
          stdout: [
            '# comment',
            '127.0.0.1 localhost',
            '203.0.113.8 login.microsoftonline.com update.microsoft.com',
          ].join('\n'),
          stderr: '',
        };
      }

      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <ModuleDetail
        moduleKey="hosts_file"
        mode="local"
        osType="Windows"
        privilegeMode="none"
        sudoPassword=""
        isDarkMode={false}
        glassEnabled={false}
        wallpaper=""
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('203.0.113.8')).toBeInTheDocument();
      expect(screen.getByText('login.microsoftonline.com update.microsoft.com')).toBeInTheDocument();
      expect(screen.getByText('high')).toBeInTheDocument();
      expect(screen.getByText('sensitive-domain-redirect')).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Defender returns a PowerShell error object', async () => {
    renderLocalWindowsModule(
      'win_defender',
      JSON.stringify({ error: 'Access is denied.' }),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('采集失败')).toBeInTheDocument();
      expect(screen.getByText('Access is denied.')).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows security events return no records', async () => {
    renderLocalWindowsModule('security_events', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/security_events/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when persistence sections are all empty', async () => {
    renderLocalWindowsModule(
      'persistence',
      [
        '===SCHEDULED_TASKS===',
        '[]',
        '===SERVICES_AUTO===',
        '[]',
        '===STARTUP_FOLDER===',
        '[]',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/persistence/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when RDP collection returns no listener, service, or registry rows', async () => {
    renderLocalWindowsModule(
      'rdp',
      [
        '===RDP_CONN===',
        '[]',
        '===RDP_SERVICE===',
        '[]',
        '===RDP_REGISTRY===',
        '{}',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/rdp/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when no browser profiles are found', async () => {
    renderLocalWindowsModule(
      'browser',
      [
        '===CHROME===',
        '[]',
        '===EDGE===',
        '[]',
        '===FIREFOX===',
        '[]',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/browser/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows firewall output is empty', async () => {
    renderLocalWindowsModule('win_firewall', '');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/win_firewall/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when installed software inventory is empty', async () => {
    renderLocalWindowsModule('installed_software', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/installed_software/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows network connections are empty', async () => {
    renderLocalWindowsModule('network_conn', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/network_conn/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows listening ports are empty', async () => {
    renderLocalWindowsModule('listen_ports', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/listen_ports/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows recent files are empty', async () => {
    renderLocalWindowsModule('recent_files', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/recent_files/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows DNS servers are empty', async () => {
    renderLocalWindowsModule('dns_config', JSON.stringify([]));

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/dns_config/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when Windows file scan sections contain no findings', async () => {
    renderLocalWindowsModule(
      'file_scan',
      [
        '===RECENT_TEMP===',
        '[]',
        '===USER_WRITABLE_EXECUTABLES===',
        '[]',
        '===RECENT_WEBROOT===',
        '[]',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/file_scan/)).toBeInTheDocument();
    });
  });

  it.each([
    ['process_list', JSON.stringify([])],
    ['user_list', JSON.stringify([])],
    ['logged_users', JSON.stringify([])],
    ['env_vars', JSON.stringify([])],
  ])('shows a diagnostic when Windows %s returns no displayable records', async (moduleKey, stdout) => {
    renderLocalWindowsModule(moduleKey, stdout);

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(new RegExp(moduleKey))).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when a module has no configured collection command', async () => {
    renderLocalWindowsModule('unknown_module', '');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('模块未配置')).toBeInTheDocument();
      expect(screen.getAllByText(/unknown_module/).length).toBeGreaterThan(0);
    });
  });
});
