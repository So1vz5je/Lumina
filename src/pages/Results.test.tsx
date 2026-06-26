/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import Results from './Results';

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

describe('Results', () => {
  it('renders provided scan results instead of mock data', async () => {
    const results = [
      {
        module_name: 'security_events',
        status: 'warning',
        summary: 'Detected failed logons from 10.0.0.8',
        details: { failed_logins: 3 },
      },
    ];

    const { container } = render(<Results results={results} />);

    fireEvent.click(screen.getAllByText('security_events')[0]);

    expect(
      screen.getAllByText('Detected failed logons from 10.0.0.8').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/failed_logins/i)).toBeInTheDocument();
  });

  it('renders results in the scan workspace shell with status summary', () => {
    const results = [
      {
        module_name: 'system_info',
        status: 'ok',
        summary: 'Host baseline collected',
        details: { hostname: 'WIN-IR' },
      },
      {
        module_name: 'security_events',
        status: 'warning',
        summary: 'Detected suspicious logons',
        details: { suspicious_events: [] },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(container.querySelector('.scan-results-workspace')).toBeInTheDocument();
    expect(container.querySelector('.scan-results-commandbar')).toBeInTheDocument();
    expect(container.querySelector('.scan-results-scope-strip')).not.toBeInTheDocument();
    expect(container.querySelector('.scan-risk-panel')).toBeInTheDocument();
    expect(container.querySelector('.scan-results-soc-shell')).toBeInTheDocument();
    expect(container.querySelector('.scan-module-rail')).not.toBeInTheDocument();
    expect(container.querySelector('.scan-module-strip')).toBeInTheDocument();
    expect(container.querySelector('.scan-result-detail-panel')).toBeInTheDocument();
    expect(container.querySelector('.scan-results-overview')).not.toBeInTheDocument();
    expect(screen.getByText('应急扫描结果')).toBeInTheDocument();
    expect(screen.getByText(/本机分析模块/)).toBeInTheDocument();
    expect(screen.getAllByText('处置').length).toBeGreaterThan(0);
    expect(screen.getAllByText('系统信息').length).toBeGreaterThan(0);
    expect(screen.getAllByText('安全事件').length).toBeGreaterThan(0);
  });

  it('puts risk findings before module details after a scan', () => {
    const results = [
      {
        module_name: 'panel',
        status: 'info',
        summary: '检测到 phpStudy',
        details: {
          detected_installs: [
            {
              panel_type: 'phpstudy',
              name: 'PhpStudy Pro',
              path: 'D:\\ctf-tools\\phpstudy_pro\\COM',
              site_root: 'D:\\ctf-tools\\phpstudy_pro\\WWW',
              detected: true,
            },
          ],
        },
      },
      {
        module_name: 'file_scan',
        status: 'warning',
        summary: '发现可疑脚本',
        details: {
          findings: [
            {
              name: 'shell.php',
              path: 'D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell.php',
              suspicious: true,
              reason: 'PHP code contains eval and base64_decode',
              last_modified: '2026-06-26 14:12:03',
            },
          ],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(container.querySelector('.scan-risk-panel')).toBeInTheDocument();
    expect(screen.getByText('高危发现')).toBeInTheDocument();
    expect(screen.getByText('疑似 WebShell 文件')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getAllByText(/D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell\.php/).length).toBeGreaterThan(0);
    expect(screen.getByText(/立即隔离该脚本文件/)).toBeInTheDocument();
  });

  it('renders backend risk findings when the scan payload provides them', () => {
    const results = [
      {
        module_name: 'process',
        status: 'warning',
        summary: '发现可疑进程',
        details: {
          suspicious_list: [
            {
              pid: 4321,
              name: 'powershell.exe',
              suspicious_reason: 'EncodedCommand',
            },
          ],
        },
      },
    ];
    const riskFindings = [
      {
        id: 'backend-persistence-risk',
        severity: 'high',
        title: '后端关联高危发现',
        reason: '后端规则已关联进程、网络和持久化证据。',
        confidence: 91,
        affected: ['powershell.exe'],
        evidence: [
          {
            moduleName: 'process',
            label: 'powershell.exe',
            value: 'EncodedCommand',
          },
        ],
        recommendedActions: ['优先隔离主机并导出进程证据'],
      },
    ];

    render(<Results {...({ results, riskFindings } as any)} />);

    expect(screen.getByText('后端关联高危发现')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText(/优先隔离主机/)).toBeInTheDocument();
  });

  it('renders the refactored evidence dashboard and selected module focus', () => {
    const results = [
      {
        module_name: 'system_info',
        status: 'ok',
        summary: 'Host WIN-IR running Windows Server',
        details: {
          hostname: 'WIN-IR',
          os_name: 'Windows Server',
          os_version: '2022',
          kernel_version: '10.0.20348',
          cpu_model: 'Intel Xeon',
          cpu_count: 8,
          memory: { total: 17179869184, used: 8589934592 },
        },
      },
      {
        module_name: 'security_events',
        status: 'critical',
        summary: 'Detected suspicious administrator logons',
        details: {
          suspicious_events: [
            {
              event_id: 4625,
              event_type: 'Failed logon',
              source_ip: '203.0.113.9',
              is_suspicious: true,
            },
          ],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(container.querySelector('.scan-results-soc-shell')).toBeInTheDocument();
    expect(container.querySelector('.scan-results-detail-grid')).toBeInTheDocument();
    expect(container.querySelector('.scan-detail-surface')).toBeInTheDocument();
    expect(screen.getAllByText('处置').length).toBeGreaterThan(0);
    expect(screen.getAllByText('需优先复核').length).toBeGreaterThan(0);
    expect(screen.getByText('当前模块')).toBeInTheDocument();
    expect(screen.getByText('1 个关键条目')).toBeInTheDocument();
  });

  it('labels scheduled task and persistence scan results', async () => {
    const results = [
      {
        module_name: 'cron',
        status: 'warning',
        summary: 'Detected 2 scheduled tasks',
        details: { tasks: [{ task_name: 'Updater' }] },
      },
      {
        module_name: 'persistence',
        status: 'warning',
        summary: 'Detected suspicious persistence entries',
        details: { suspicious_items: [{ name: 'BadSvc' }] },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(screen.getAllByText('计划任务').length).toBeGreaterThan(0);
    expect(screen.getAllByText('持久化检测').length).toBeGreaterThan(0);
  });

  it('renders docker and panel scan results as readable findings', async () => {
    const results = [
      {
        module_name: 'docker',
        status: 'warning',
        summary: '2 个容器, 1 个镜像, 1 个可疑容器',
        details: {
          containers: [
            {
              container_id: 'abc123',
              image: 'redis:latest',
              status: 'Up 2 hours',
              name: 'cache',
              ports: '0.0.0.0:6379->6379/tcp',
              suspicious: true,
              suspicious_reason: 'Redis exposed',
            },
          ],
        },
      },
      {
        module_name: 'panel',
        status: 'info',
        summary: '检测到 1 个面板/集成环境, 1 个 IIS 站点',
        details: {
          detected_installs: [
            {
              panel_type: 'phpstudy',
              name: 'PhpStudy Pro',
              path: 'C:\\phpstudy_pro',
              detected: true,
              site_count: 2,
              notes: 'installed',
            },
          ],
          iis_sites: [
            {
              source: 'IIS',
              name: 'Default Web Site',
              path: 'C:\\inetpub\\wwwroot',
              state: 'Started',
              bindings: '*:80:',
            },
          ],
          services: [
            {
              source: 'phpstudy',
              name: 'Apache2.4',
              display_name: 'Apache2.4',
              state: 'Running',
              start_mode: 'Auto',
              path: 'C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe',
              pid: '1234',
            },
          ],
          logs: [
            {
              source: 'phpstudy',
              path: 'C:\\phpstudy_pro\\COM\\log\\phpstudy.log',
              size: 2048,
              last_modified: '2026-06-25 20:00:00',
              note: 'phpStudy log',
            },
          ],
          diagnostics: ['IIS WebAdministration module is unavailable'],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(screen.getAllByText('Docker').length).toBeGreaterThan(0);
    expect(screen.getAllByText('面板检测').length).toBeGreaterThan(0);
    expect(screen.getByText('关键明细')).toBeInTheDocument();
    expect(screen.getByText('cache')).toBeInTheDocument();
    expect(screen.getByText('Redis exposed')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('面板检测')[0]);

    expect(screen.getAllByText('信息').length).toBeGreaterThan(0);
    expect(screen.getByText('PhpStudy Pro')).toBeInTheDocument();
    expect(screen.getByText('Default Web Site')).toBeInTheDocument();
    expect(screen.getByText('Apache2.4')).toBeInTheDocument();
    expect(screen.getByText('C:\\phpstudy_pro\\COM\\log\\phpstudy.log')).toBeInTheDocument();
    expect(screen.getByText('IIS WebAdministration module is unavailable')).toBeInTheDocument();
  });

  it('renders startup, database, security event, and file scan results as readable findings', async () => {
    const results = [
      {
        module_name: 'startup',
        status: 'warning',
        summary: 'Detected suspicious startup item',
        details: {
          suspicious_items: [
            {
              name: 'StartupAgent',
              command: 'powershell.exe -nop -enc AAAA',
              location: 'HKCU Run',
              item_type: 'registry',
              suspicious: true,
              suspicious_reason: 'encoded PowerShell',
            },
          ],
        },
      },
      {
        module_name: 'database',
        status: 'info',
        summary: 'Detected running databases: MySQL, Redis',
        details: {
          detected_databases: ['MySQL', 'Redis'],
        },
      },
      {
        module_name: 'security_events',
        status: 'warning',
        summary: 'Detected suspicious security events',
        details: {
          suspicious_events: [
            {
              event_id: 4625,
              time_created: '2026-05-26 12:30:00',
              event_type: 'Failed logon',
              username: 'analyst',
              source_ip: '203.0.113.9',
              is_suspicious: true,
            },
          ],
        },
      },
      {
        module_name: 'file_scan',
        status: 'ok',
        summary: 'Scanned temp directory',
        details: {
          temp_dir: 'C:\\Users\\analyst\\AppData\\Local\\Temp',
          recent_temp_files: ['C:\\Users\\analyst\\AppData\\Local\\Temp\\dropper.tmp'],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    await waitFor(() => {
      expect(screen.getByText('关键明细')).toBeInTheDocument();
      expect(screen.getByText('StartupAgent')).toBeInTheDocument();
      expect(screen.getByText('encoded PowerShell')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText('database')[0]);
    expect(screen.getByText('MySQL')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('security_events')[0]);
    expect(screen.getByText('Failed logon')).toBeInTheDocument();
    expect(screen.getAllByText(/203\.0\.113\.9/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText('file_scan')[0]);
    expect(screen.getByText('dropper.tmp')).toBeInTheDocument();
    expect(screen.getAllByText(/C:\\Users\\analyst\\AppData\\Local\\Temp/).length).toBeGreaterThan(0);
  });

  it('renders security posture findings for incident response review', async () => {
    const results = [
      {
        module_name: 'security_posture',
        status: 'warning',
        summary: '发现 4 个安全状态关注项',
        details: {
          defender: {
            AntivirusEnabled: true,
            RealTimeProtectionEnabled: false,
            SignatureLastUpdated: '2026-05-26 10:00:00',
          },
          firewall_profiles: [
            {
              Name: 'Domain',
              Enabled: false,
              DefaultInboundAction: 'Block',
              DefaultOutboundAction: 'Allow',
            },
          ],
          rdp: {
            Enabled: true,
            ServiceStatus: 'Running',
            ServiceStartType: 'Manual',
          },
          hosts_entries: [
            {
              address: '127.0.0.1',
              hostname: 'www.microsoft.com',
              line: '127.0.0.1 www.microsoft.com',
              suspicious: true,
              reason: 'hosts 文件疑似拦截安全厂商或系统更新域名',
            },
          ],
          findings: [
            {
              name: 'Defender 实时防护关闭',
              category: 'Defender',
              risk: 'warning',
              detail: '实时防护关闭会降低木马落地和横向移动检测能力。',
            },
            {
              name: 'Windows 防火墙 Domain 配置关闭',
              category: 'Windows 防火墙',
              risk: 'warning',
              detail: '至少一个防火墙配置文件未启用。',
            },
            {
              name: '远程桌面已开启',
              category: '远程访问',
              risk: 'warning',
              detail: 'RDP 入口开启。',
            },
            {
              name: 'hosts 可疑映射：www.microsoft.com',
              category: 'hosts 文件',
              risk: 'warning',
              detail: 'hosts 文件疑似拦截安全厂商或系统更新域名',
            },
          ],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    expect(container.querySelector('.scan-finding-table')).toBeInTheDocument();
    expect(screen.getAllByText('安全状态').length).toBeGreaterThan(0);
    expect(screen.getByText('Defender 实时防护关闭')).toBeInTheDocument();
    expect(screen.getAllByText('Windows 防火墙').length).toBeGreaterThan(0);
    expect(screen.getByText('远程桌面')).toBeInTheDocument();
    expect(screen.getByText('www.microsoft.com')).toBeInTheDocument();
  });

  it('renders system, user trace, network, and process scan results as readable findings', async () => {
    const results = [
      {
        module_name: 'system_info',
        status: 'ok',
        summary: 'Host WIN-IR running Windows Server',
        details: {
          hostname: 'WIN-IR',
          os_name: 'Windows Server',
          os_version: '2022',
          kernel_version: '10.0.20348',
          cpu_model: 'Intel Xeon',
          cpu_count: 8,
          memory: { total: 17179869184, used: 8589934592 },
        },
      },
      {
        module_name: 'user_trace',
        status: 'warning',
        summary: 'Found suspicious admin user',
        details: {
          suspicious_users: [
            {
              name: 'support',
              is_admin: true,
              is_active: true,
              last_logon: '2026-05-26 08:00',
              suspicious_reason: 'suspicious administrator account',
            },
          ],
          sessions: [
            {
              username: 'analyst',
              session_name: 'console',
              session_id: '1',
              state: 'Active',
              logon_time: '2026-05-26 09:00',
            },
          ],
        },
      },
      {
        module_name: 'network',
        status: 'warning',
        summary: 'Found external connection',
        details: {
          external_connections: [
            {
              protocol: 'TCP',
              local_address: '192.168.1.10',
              local_port: 49712,
              remote_address: '198.51.100.22',
              remote_port: 4444,
              state: 'ESTABLISHED',
              pid: 4321,
              is_suspicious_port: true,
            },
          ],
          interfaces: [
            {
              name: 'Ethernet0',
              ipv4: ['192.168.1.10'],
              gateway: '192.168.1.1',
              dns: ['8.8.8.8'],
            },
          ],
        },
      },
      {
        module_name: 'process',
        status: 'warning',
        summary: 'Found suspicious process',
        details: {
          suspicious_list: [
            {
              pid: 4321,
              name: 'ncat.exe',
              username: 'analyst',
              memory_mb: 18.5,
              suspicious_reason: 'suspicious security tool',
            },
          ],
          services: ['Remote Desktop Services'],
        },
      },
    ];

    const { container } = render(<Results results={results} />);

    await waitFor(() => {
      expect(screen.getByText('WIN-IR')).toBeInTheDocument();
      expect(screen.getByText('Windows Server 2022')).toBeInTheDocument();
      expect(screen.getAllByText(/Intel Xeon/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('user_trace')[0]);
    expect(screen.getByText('support')).toBeInTheDocument();
    expect(screen.getByText('suspicious administrator account')).toBeInTheDocument();
    expect(screen.getByText('analyst')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('network')[0]);
    expect(container.querySelector('.scan-finding-table')).toBeInTheDocument();
    expect(container.querySelector('.scan-finding-record')).toBeInTheDocument();
    expect(container.querySelector('.scan-finding-row')).not.toBeInTheDocument();
    expect(screen.getByText('198.51.100.22:4444')).toBeInTheDocument();
    expect(screen.getByText('Ethernet0')).toBeInTheDocument();
    expect(screen.getAllByText(/8\.8\.8\.8/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText('process')[0]);
    expect(screen.getByText('ncat.exe')).toBeInTheDocument();
    expect(screen.getByText('suspicious security tool')).toBeInTheDocument();
    expect(screen.getByText('Remote Desktop Services')).toBeInTheDocument();
  });
});
