import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiAnalysis from './AiAnalysis';
import type { AnalysisResult } from '../types/analysis';

const eventMock = vi.hoisted(() => ({
  listenMock: vi.fn(),
  streamHandler: undefined as undefined | ((event: { payload: unknown }) => void),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: eventMock.listenMock,
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
    eventMock.streamHandler = undefined;
    eventMock.listenMock.mockReset();
    eventMock.listenMock.mockImplementation(async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventMock.streamHandler = handler;
      return vi.fn();
    });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('uses a minimal single-column conversation layout', async () => {
    const { container } = render(
      <AiAnalysis
        mode="本地分析"
        osType="windows"
        currentModule="安全日志"
        scanResults={scanResults}
      />,
    );

    expect(await screen.findByText('AI 分析')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-workspace')).toBeInTheDocument();
    expect(container.querySelector('.ai-transcript')).toBeInTheDocument();
    expect(container.querySelector('.ai-composer-line')).toBeInTheDocument();
    expect(container.querySelector('.ai-empty-prompts')).toBeInTheDocument();
    expect(container.querySelector('.ai-prompt-row')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-side-panel')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-context-line')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-command-bar')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-message-avatar')).not.toBeInTheDocument();
    expect(screen.queryByText('Lumina Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('windows')).not.toBeInTheDocument();
    expect(screen.queryByText('安全日志')).not.toBeInTheDocument();
  });

  it('renders assistant markdown instead of plain text', async () => {
    const { container } = render(
      <AiAnalysis
        mode="本地分析"
        osType="windows"
        currentModule="安全日志"
        scanResults={scanResults}
      />,
    );

    await screen.findByText('AI 分析');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: '# 结论\n\n- **高危**: 发现 `cmd.exe`\n\n```powershell\nGet-Process\n```',
        },
      });
    });

    expect(screen.getByRole('heading', { name: '结论' })).toBeInTheDocument();
    expect(screen.getByText('高危')).toBeInTheDocument();
    expect(screen.getByText('cmd.exe')).toBeInTheDocument();
    expect(container.querySelector('.ai-markdown li')).toHaveTextContent('高危: 发现 cmd.exe');
    expect(container.querySelector('.ai-markdown pre code')).toHaveTextContent('Get-Process');
  });
});
