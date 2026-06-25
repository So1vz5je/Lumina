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
  it('passes the real run_scan results to onComplete', async () => {
    const results = [
      {
        module_name: 'system_info',
        status: 'ok',
        summary: 'Windows host is healthy',
        details: { hostname: 'ws-01' },
      },
    ];

    invokeMock.mockResolvedValue(results);

    const onComplete = vi.fn();

    render(<Scan onComplete={onComplete as () => void} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('run_scan'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(results));
  });

  it('renders the scan workspace shell and module catalog', () => {
    const onComplete = vi.fn();
    const { container } = render(<Scan onComplete={onComplete as () => void} />);

    expect(container.querySelector('.scan-workspace')).toBeInTheDocument();
    expect(container.querySelector('.scan-status-strip')).toBeInTheDocument();
    expect(container.querySelector('.scan-group-filter-bar')).toBeInTheDocument();
    expect(container.querySelector('.scan-module-grid')).toBeInTheDocument();
    expect(container.querySelector('.scan-module-group-section')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.scan-module-card').length).toBe(12);
    expect(screen.getByText('快速扫描')).toBeInTheDocument();
    expect(screen.getByText('扫描状态')).toBeInTheDocument();
    expect(screen.getByText('系统信息')).toBeInTheDocument();
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

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(results));
  });
});
