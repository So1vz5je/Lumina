/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import Scan from './Scan';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
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
  invokeMock.mockReset();
});

describe('Scan', () => {
  it('passes the normalized run_scan payload to onComplete', async () => {
    const results = [
      {
        module_name: 'system_info',
        status: 'ok',
        summary: 'Windows host is healthy',
        details: { hostname: 'ws-01' },
      },
    ];
    const riskFindings = [
      {
        id: 'backend-risk-1',
        severity: 'high',
        category: 'unknown',
        attackTactic: '未分类战术',
        attackTechnique: '未分类技术',
        title: '后端高危发现',
        reason: 'backend risk correlation',
        confidence: 88,
        affected: ['ws-01'],
        evidence: [],
        recommendedActions: ['复核证据'],
      },
    ];
    const payload = {
      moduleResults: results,
      riskFindings,
      diagnostics: ['backend scan completed'],
    };

    invokeMock.mockResolvedValue(payload);

    const onComplete = vi.fn();

    render(<Scan onComplete={onComplete as any} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'run_scan',
        expect.objectContaining({
          selectedModules: expect.arrayContaining(['system_info']),
        }),
      ),
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(payload));
  });

  it('does not complete with stale results after stopping an in-flight scan', async () => {
    let resolveScan: (value: unknown) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve;
      }),
    );
    const onComplete = vi.fn();

    render(<Scan onComplete={onComplete as any} />);

    const startButtons = screen.getAllByRole('button');
    fireEvent.click(startButtons[startButtons.length - 1]);
    await waitFor(() => expect(screen.getByText('停止扫描')).toBeInTheDocument());

    fireEvent.click(screen.getByText('停止扫描'));
    expect(screen.getByText('扫描已停止')).toBeInTheDocument();

    resolveScan({
      moduleResults: [
        {
          module_name: 'system_info',
          status: 'ok',
          summary: 'late result',
          details: {},
        },
      ],
      riskFindings: [],
      diagnostics: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText('扫描已停止')).toBeInTheDocument();
  });

  it('renders the scan workspace shell and module catalog', () => {
    const onComplete = vi.fn();
    const { container } = render(<Scan onComplete={onComplete as () => void} />);

    expect(container.querySelector('.scan-workspace')).toBeInTheDocument();
    expect(container.querySelector('.scan-risk-strip')).toBeInTheDocument();
    expect(container.querySelector('.scan-status-strip')).toBeInTheDocument();
    expect(container.querySelector('.scan-scope-note')).not.toBeInTheDocument();
    expect(container.querySelector('.scan-group-filter-bar')).toBeInTheDocument();
    expect(container.querySelector('.scan-module-grid')).toBeInTheDocument();
    expect(container.querySelector('.scan-risk-focus-grid')).not.toBeInTheDocument();
    expect(container.querySelector('.scan-module-group-section')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.scan-module-card').length).toBe(13);
    expect(screen.getByText('快速扫描')).toBeInTheDocument();
    expect(screen.getByText('高危优先快速扫描')).toBeInTheDocument();
    expect(screen.queryByText('WebShell 落点')).not.toBeInTheDocument();
    expect(screen.queryByText('进程外联')).not.toBeInTheDocument();
    expect(screen.queryByText('持久化入口')).not.toBeInTheDocument();
    expect(screen.queryByText('安全削弱')).not.toBeInTheDocument();
    expect(screen.getAllByText('高危优先').length).toBeGreaterThan(0);
    expect(screen.getByText('快速定位 WebShell、外联进程、持久化和安全削弱证据。')).toBeInTheDocument();
    expect(screen.getAllByText(/高危归因/).length).toBeGreaterThan(0);
    expect(screen.getByText('扫描状态')).toBeInTheDocument();
    expect(screen.getByText('系统信息')).toBeInTheDocument();
    expect(screen.getByText('安全状态')).toBeInTheDocument();
    expect(screen.getByText('持久化检测')).toBeInTheDocument();
  });

  it('filters the module matrix by group without rendering long vertical sections', () => {
    const onComplete = vi.fn();
    const { container } = render(<Scan onComplete={onComplete as () => void} />);

    fireEvent.click(screen.getByRole('button', { name: '筛选持久化模块' }));

    expect(container.querySelectorAll('.scan-module-card').length).toBe(3);
    expect(screen.getByText('启动项')).toBeInTheDocument();
    expect(screen.getByText('计划任务')).toBeInTheDocument();
    expect(screen.getByText('持久化检测')).toBeInTheDocument();
    expect(screen.queryByText('系统信息')).not.toBeInTheDocument();
  });

  it('can switch the scan strategy to high-risk evidence only before starting', async () => {
    invokeMock.mockResolvedValue({
      moduleResults: [],
      riskFindings: [],
      diagnostics: [],
    });
    const onComplete = vi.fn();

    render(<Scan onComplete={onComplete as () => void} />);

    fireEvent.click(screen.getByRole('button', { name: '高危优先一键选择' }));
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'run_scan',
        expect.objectContaining({
          selectedModules: expect.arrayContaining([
            'panel',
            'file_scan',
            'process',
            'network',
            'startup',
            'cron',
            'persistence',
            'security_events',
            'security_posture',
          ]),
        }),
      ),
    );

    const selectedModules = invokeMock.mock.calls[0][1].selectedModules;
    expect(selectedModules).toHaveLength(9);
    expect(selectedModules).not.toContain('database');
    expect(selectedModules).not.toContain('docker');
    expect(selectedModules).not.toContain('system_info');
    expect(selectedModules).not.toContain('user_trace');
    expect(onComplete).toHaveBeenCalled();
  });

  it('keeps implemented optional analyzers selected by default', async () => {
    const results = [
      {
        module_name: 'cron',
        status: 'warning',
        summary: 'Scheduled tasks found',
        details: { tasks: [] },
      },
      {
        module_name: 'persistence',
        status: 'warning',
        summary: 'Persistence entries found',
        details: { entries: [] },
      },
      {
        module_name: 'docker',
        status: 'ok',
        summary: 'Docker inventory complete',
        details: { containers: [] },
      },
      {
        module_name: 'panel',
        status: 'ok',
        summary: 'Panel inventory complete',
        details: { installs: [] },
      },
    ];

    invokeMock.mockResolvedValue(results);
    const onComplete = vi.fn();

    render(<Scan onComplete={onComplete as () => void} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        moduleResults: results,
        diagnostics: [],
      })),
    );
  });
});
