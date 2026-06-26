import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiAnalysis from './AiAnalysis';
import type { AnalysisResult } from '../types/analysis';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const scanResults: AnalysisResult[] = [
  {
    module_name: 'Windows 安全日志',
    status: 'warning',
    summary: '发现可疑登录事件',
    details: {},
  },
];

describe('AiAnalysis workspace', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('uses a compact command-workbench layout instead of nested cards', async () => {
    const { container } = render(
      <AiAnalysis
        mode="本地分析"
        osType="windows"
        currentModule="安全日志"
        scanResults={scanResults}
      />,
    );

    expect(await screen.findByText('AI 分析工作台')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-workspace')).toBeInTheDocument();
    expect(container.querySelector('.ai-transcript')).toBeInTheDocument();
    expect(container.querySelector('.ai-composer-line')).toBeInTheDocument();
    expect(container.querySelector('.ai-side-panel')).toBeInTheDocument();
    expect(container.querySelector('.ai-command-bar')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-message-avatar')).not.toBeInTheDocument();
  });
});
