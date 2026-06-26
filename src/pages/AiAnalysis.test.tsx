import { act, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
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
    module_name: 'Windows security log',
    status: 'warning',
    summary: 'Suspicious login event',
    details: {},
  },
];

const props = {
  mode: 'local',
  osType: 'windows',
  currentModule: 'security',
  scanResults,
};

describe('AiAnalysis workspace', () => {
  beforeEach(() => {
    eventMock.streamHandler = undefined;
    eventMock.listenMock.mockReset();
    eventMock.listenMock.mockImplementation(async (_eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventMock.streamHandler = handler;
      return vi.fn();
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    window.sessionStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('uses a minimal single-column conversation layout', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    expect(await screen.findByLabelText('AI conversation')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-workspace')).toBeInTheDocument();
    expect(container.querySelector('.ai-transcript')).toBeInTheDocument();
    expect(container.querySelector('.ai-composer-line')).toBeInTheDocument();
    expect(container.querySelector('.ai-empty-prompts')).toBeInTheDocument();
    expect(container.querySelector('.ai-empty-mark')).toBeInTheDocument();
    expect(container.querySelector('.ai-terminal-title')).not.toBeInTheDocument();
    expect(screen.getByLabelText('刷新对话')).toBeInTheDocument();
    expect(screen.queryByLabelText('新建分析')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-prompt-row')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-side-panel')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-context-line')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-command-bar')).not.toBeInTheDocument();
    expect(container.querySelector('.ai-message-avatar')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Analysis')).not.toBeInTheDocument();
    expect(screen.queryByText('Lumina Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('windows')).not.toBeInTheDocument();
  });

  it('sends an empty-state prompt immediately when clicked', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    const promptButton = container.querySelector('.ai-empty-prompts button');
    expect(promptButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(promptButton as HTMLButtonElement);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ai_send_message', expect.any(Object));
    expect(container.querySelector('textarea')).toHaveValue('');
    expect(container.querySelector('.ai-thinking-loading')).toBeInTheDocument();
  });

  it('renders assistant markdown instead of plain text', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: '# Conclusion\n\n- **High**: found `cmd.exe`\n\n```powershell\nGet-Process\n```',
        },
      });
    });

    expect(screen.getByRole('heading', { name: 'Conclusion' })).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('cmd.exe')).toBeInTheDocument();
    expect(container.querySelector('.ai-markdown li')).toHaveTextContent('High: found cmd.exe');
    expect(container.querySelector('.ai-markdown pre code')).toHaveTextContent('Get-Process');
  });

  it('renders markdown tables, dividers, and fenced code blocks', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content:
            '| Tool | Purpose |\n| --- | --- |\n| `run_command` | Run commands |\n| python | Analyze data |\n\n---\n\n```powershell\nGet-Process\n```',
        },
      });
    });

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tool' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'run_command' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Analyze data' })).toBeInTheDocument();
    expect(container.querySelector('.ai-markdown hr')).toBeInTheDocument();
    expect(container.querySelector('.ai-markdown pre code')).toHaveTextContent('Get-Process');
  });

  it('shows pending dots and a timed reasoning header while streaming', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    const input = container.querySelector('textarea');
    const sendButton = container.querySelector('.ai-send-button');
    expect(input).toBeInTheDocument();
    expect(sendButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input as HTMLTextAreaElement, { target: { value: 'What model are you?' } });
      fireEvent.click(sendButton as HTMLButtonElement);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ai_send_message', expect.any(Object));
    expect(container.querySelector('.ai-thinking-loading')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-typing-dots span')).toHaveLength(3);

    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: '1. **Parse request**\n',
        },
      });
    });

    expect(container.querySelector('.ai-reasoning')).toHaveClass('running');
    expect(container.querySelector('.ai-reasoning-label')).toHaveTextContent('思考中');

    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'I am DeepSeek.',
        },
      });
    });

    expect(container.querySelector('.ai-reasoning')).toHaveClass('done');
    expect(container.querySelector('.ai-reasoning-label')).toHaveTextContent('已思考');
    expect(screen.getByText('I am DeepSeek.')).toBeInTheDocument();
  });

  it('turns the send button into a stop control while the assistant is running', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    const input = container.querySelector('textarea');
    const sendButton = container.querySelector('.ai-send-button');
    expect(input).toBeInTheDocument();
    expect(sendButton).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input as HTMLTextAreaElement, { target: { value: 'stop this run' } });
      fireEvent.click(sendButton as HTMLButtonElement);
    });

    const stopButton = screen.getByLabelText('停止生成');
    expect(stopButton).toBeInTheDocument();
    expect(stopButton).not.toHaveClass('ant-btn-loading');

    await act(async () => {
      fireEvent.click(stopButton);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ai_cancel_message', { sessionId: '1700000000000-8' });
    expect(screen.getByLabelText('发送')).toBeInTheDocument();
    expect(container.querySelector('.ai-thinking-loading')).not.toBeInTheDocument();
    expect(screen.getByText('已停止生成。')).toBeInTheDocument();
  });

  it('keeps the current conversation after the workspace unmounts and remounts', async () => {
    const first = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    const input = first.container.querySelector('textarea');
    const sendButton = first.container.querySelector('.ai-send-button');
    await act(async () => {
      fireEvent.change(input as HTMLTextAreaElement, { target: { value: 'keep this conversation' } });
      fireEvent.click(sendButton as HTMLButtonElement);
    });
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'this answer should remain',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'done',
          content: '',
        },
      });
    });

    expect(screen.getByText('keep this conversation')).toBeInTheDocument();
    expect(screen.getByText('this answer should remain')).toBeInTheDocument();

    first.unmount();
    render(<AiAnalysis {...props} />);

    expect(await screen.findByText('keep this conversation')).toBeInTheDocument();
    expect(screen.getByText('this answer should remain')).toBeInTheDocument();
  });

  it('keeps a late AI error visible after partial assistant content', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'partial answer',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'error',
          content: 'AI request returned HTTP 401: API key required for remote API access',
        },
      });
    });

    expect(screen.getByText('partial answer')).toBeInTheDocument();
    expect(container.querySelector('.ai-message-body')).toHaveTextContent(
      'API key required for remote API access',
    );
  });

  it('keeps a collapsed reasoning block collapsed after remounting', async () => {
    const first = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: '1. **Parse request**\n',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'body text',
        },
      });
    });

    const details = first.container.querySelector('.ai-reasoning') as HTMLDetailsElement;
    const summary = first.container.querySelector('.ai-reasoning summary');
    expect(details.open).toBe(true);

    await act(async () => {
      fireEvent.click(summary as HTMLElement);
    });
    expect(details.open).toBe(false);

    first.unmount();
    const second = render(<AiAnalysis {...props} />);
    const restoredDetails = await screen.findByText(/已思考/);
    expect(restoredDetails.closest('details')).not.toHaveAttribute('open');
    second.unmount();
  });

  it('renders tool calls and tool results in the assistant message', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'tool_call',
          toolName: 'run_command',
          content: '{"command":"type C:\\\\Windows\\\\win.ini"}',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'tool_result',
          toolName: 'run_command',
          content: 'for 16-bit app support',
        },
      });
    });

    expect(container.querySelectorAll('.ai-tool-event')).toHaveLength(1);
    expect(container.querySelector('.ai-tool-event')).not.toHaveAttribute('open');
    expect(screen.getByText('调用')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getAllByText('run_command')).toHaveLength(1);
    expect(screen.getByText('{"command":"type C:\\\\Windows\\\\win.ini"}')).toBeInTheDocument();
    expect(screen.getByText('for 16-bit app support')).toBeInTheDocument();
  });

  it('asks for approval before resolving an admin command request', async () => {
    render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'admin_approval_request',
          toolName: 'run_command',
          content: JSON.stringify({
            approvalId: 'approval-1',
            command: 'net session',
            workingDirectory: 'C:\\IR\\host-a',
            reason: '检查管理员会话',
            timeoutSeconds: 15,
          }),
        },
      });
    });

    expect(screen.getByText('批准管理员命令')).toBeInTheDocument();
    expect(screen.getByText(/Windows UAC/)).toBeInTheDocument();
    expect(screen.getByText('net session')).toBeInTheDocument();
    expect(screen.getByText('C:\\IR\\host-a')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '批准执行' }));
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('ai_resolve_admin_approval', {
      sessionId: '1700000000000-8',
      approvalId: 'approval-1',
      approved: true,
    });
  });

  it('keeps streamed reasoning, tool events, and answer content in arrival order', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'first reasoning',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'tool_call',
          toolName: 'run_command',
          content: '{"command":"whoami"}',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'first answer',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'second reasoning',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'tool_result',
          toolName: 'run_command',
          content: 'exitCode=0',
        },
      });
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'second answer',
        },
      });
    });

    const streamParts = Array.from(container.querySelectorAll('.ai-stream-part'));
    expect(streamParts.map((node) => node.getAttribute('data-stream-type'))).toEqual([
      'reasoning',
      'tool',
      'content',
      'reasoning',
      'content',
    ]);
    expect(streamParts.map((node) => node.textContent)).toEqual([
      expect.stringContaining('first reasoning'),
      expect.stringContaining('run_command'),
      expect.stringContaining('first answer'),
      expect.stringContaining('second reasoning'),
      expect.stringContaining('second answer'),
    ]);
    expect(streamParts[1]).toHaveTextContent('exitCode=0');
  });

  it('times each streamed reasoning segment from its own start', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'first reasoning',
        },
      });
    });
    vi.mocked(Date.now).mockReturnValue(1_700_000_002_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'tool_call',
          toolName: 'run_command',
          content: '{"command":"whoami"}',
        },
      });
    });
    vi.mocked(Date.now).mockReturnValue(1_700_000_006_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'second reasoning',
        },
      });
    });
    vi.mocked(Date.now).mockReturnValue(1_700_000_008_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'answer',
        },
      });
    });

    const labels = Array.from(container.querySelectorAll('.ai-reasoning-label'))
      .map((node) => node.textContent || '');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('2 秒');
    expect(labels[1]).toContain('2 秒');
  });

  it('does not mark a later reasoning segment done from an earlier answer token', async () => {
    const { container } = render(<AiAnalysis {...props} />);

    await screen.findByLabelText('AI conversation');
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'first reasoning',
        },
      });
    });
    vi.mocked(Date.now).mockReturnValue(1_700_000_002_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'first answer',
        },
      });
    });
    vi.mocked(Date.now).mockReturnValue(1_700_000_006_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'reasoning',
          content: 'second reasoning',
        },
      });
    });

    let reasoningBlocks = Array.from(container.querySelectorAll('.ai-reasoning'));
    expect(reasoningBlocks).toHaveLength(2);
    expect(reasoningBlocks[0]).toHaveClass('done');
    expect(reasoningBlocks[1]).toHaveClass('running');

    vi.mocked(Date.now).mockReturnValue(1_700_000_008_000);
    await act(async () => {
      eventMock.streamHandler?.({
        payload: {
          sessionId: '1700000000000-8',
          eventType: 'token',
          content: 'second answer',
        },
      });
    });

    reasoningBlocks = Array.from(container.querySelectorAll('.ai-reasoning'));
    const labels = Array.from(container.querySelectorAll('.ai-reasoning-label'))
      .map((node) => node.textContent || '');
    expect(reasoningBlocks[1]).toHaveClass('done');
    expect(labels[1]).toContain('2 秒');
  });
});
