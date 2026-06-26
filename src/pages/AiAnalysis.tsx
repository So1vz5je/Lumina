import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, Tooltip, message } from 'antd';
import {
  PlusOutlined,
  SendOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult } from '../types/analysis';

type ChatRole = 'user' | 'assistant';
type ChatPhase = 'pending' | 'reasoning' | 'answering' | 'done' | 'error';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  phase?: ChatPhase;
  startedAt?: number;
  thinkingCompletedAt?: number;
  completedAt?: number;
}

interface AiStreamEvent {
  sessionId: string;
  eventType: string;
  content: string;
  toolName?: string;
}

interface AiAnalysisProps {
  mode: string;
  osType: string;
  currentModule: string;
  scanResults: AnalysisResult[];
}

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createAssistantMessage = (phase: ChatPhase = 'pending'): ChatMessage => ({
  id: `${makeId()}-assistant`,
  role: 'assistant',
  content: '',
  phase,
  startedAt: Date.now(),
});

const updateLatestAssistantMessage = (
  current: ChatMessage[],
  updater: (message: ChatMessage) => ChatMessage,
): ChatMessage[] => {
  const next = [...current];
  const last = next[next.length - 1];
  if (last?.role === 'assistant') {
    next[next.length - 1] = updater(last);
  } else {
    next.push(updater(createAssistantMessage()));
  }
  return next;
};

const formatElapsedSeconds = (startedAt?: number, endedAt?: number): string => {
  if (!startedAt || !endedAt) return '0 秒';
  const elapsed = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return `${elapsed} 秒`;
};

const summarizeScanResult = (result: AnalysisResult): string =>
  `${result.module_name}: ${result.status} - ${result.summary}`;

const quickPrompts = [
  {
    label: '汇总风险',
    prompt: '请基于当前扫描结果，按高危、中危、低危汇总关键风险，并给出处置优先级。',
  },
  {
    label: '排查登录',
    prompt: '请帮我从登录、会话和安全日志角度梳理可疑访问线索。',
  },
  {
    label: '处置建议',
    prompt: '请给出当前主机的应急响应处置步骤，区分立即处置和后续加固。',
  },
];

const isMarkdownBlockStart = (line: string) =>
  /^#{1,6}\s+/.test(line)
  || /^[-*]\s+/.test(line)
  || /^\d+\.\s+/.test(line)
  || /^>\s?/.test(line)
  || /^```/.test(line);

const renderInlineMarkdown = (text: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*]+?\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
};

function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\S*)\s*$/);
    if (fence) {
      const language = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="ai-markdown-codeblock" key={`code-${index}`}>
          <code data-language={language || undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const headingContent = renderInlineMarkdown(heading[2], `heading-${index}`);
      if (level <= 3) {
        blocks.push(<h3 className="ai-markdown-heading" key={`heading-${index}`}>{headingContent}</h3>);
      } else if (level === 4) {
        blocks.push(<h4 className="ai-markdown-heading" key={`heading-${index}`}>{headingContent}</h4>);
      } else if (level === 5) {
        blocks.push(<h5 className="ai-markdown-heading" key={`heading-${index}`}>{headingContent}</h5>);
      } else {
        blocks.push(<h6 className="ai-markdown-heading" key={`heading-${index}`}>{headingContent}</h6>);
      }
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInlineMarkdown(item, `ul-${index}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+\.\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInlineMarkdown(item, `ol-${index}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quote = lines[index].trim().match(/^>\s?(.*)$/);
        if (!quote) break;
        quoteLines.push(quote[1]);
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {renderInlineMarkdown(quoteLines.join('\n'), `quote-${index}`)}
        </blockquote>,
      );
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index].trim())) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`}>{renderInlineMarkdown(paragraphLines.join(' '), `p-${index}`)}</p>,
    );
  }

  return <div className="ai-markdown">{blocks}</div>;
}

function ThinkingDots() {
  return (
    <span className="ai-typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export default function AiAnalysis({ mode, osType, currentModule, scanResults }: AiAnalysisProps) {
  const [sessionId] = useState(() => makeId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const contextSummary = useMemo(
    () => ({
      mode,
      osType,
      currentModule,
      scanResultCount: scanResults.length,
      scanResultSummaries: scanResults.slice(0, 30).map(summarizeScanResult),
    }),
    [currentModule, mode, osType, scanResults],
  );

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AiStreamEvent>('ai://stream', (event) => {
          const payload = event.payload;
          if (!payload || payload.sessionId !== sessionId) return;

          if (payload.eventType === 'token') {
            setMessages((current) => {
              return updateLatestAssistantMessage(current, (messageItem) => ({
                ...messageItem,
                content: `${messageItem.content}${payload.content}`,
                phase: 'answering',
                startedAt: messageItem.startedAt || Date.now(),
                thinkingCompletedAt:
                  messageItem.reasoning && !messageItem.thinkingCompletedAt
                    ? Date.now()
                    : messageItem.thinkingCompletedAt,
              }));
            });
            return;
          }

          if (payload.eventType === 'reasoning') {
            setMessages((current) => {
              return updateLatestAssistantMessage(current, (messageItem) => ({
                ...messageItem,
                reasoning: `${messageItem.reasoning || ''}${payload.content}`,
                phase: 'reasoning',
                startedAt: messageItem.startedAt || Date.now(),
              }));
            });
            return;
          }

          if (payload.eventType === 'tool_call' || payload.eventType === 'tool_result') {
            return;
          }

          if (payload.eventType === 'done' || payload.eventType === 'error') {
            setRunning(false);
            setMessages((current) => {
              return updateLatestAssistantMessage(current, (messageItem) => ({
                ...messageItem,
                content:
                  payload.eventType === 'error' && payload.content && !messageItem.content
                    ? payload.content
                    : messageItem.content,
                phase: payload.eventType === 'error' ? 'error' : 'done',
                completedAt: Date.now(),
                startedAt: messageItem.startedAt || Date.now(),
                thinkingCompletedAt:
                  messageItem.reasoning && !messageItem.thinkingCompletedAt
                    ? Date.now()
                    : messageItem.thinkingCompletedAt,
              }));
            });
            if (payload.eventType === 'error' && payload.content) {
              message.error(payload.content);
            }
          }
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          cleanup = unlisten;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [sessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async () => {
    const prompt = input.trim();
    if (!prompt || running) return;

    const startedAt = Date.now();
    const userMessage: ChatMessage = { id: `${makeId()}-user`, role: 'user', content: prompt };
    const assistantMessage: ChatMessage = {
      ...createAssistantMessage('pending'),
      startedAt,
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput('');
    setRunning(true);
    setClockTick(startedAt);

    try {
      await invoke('ai_send_message', {
        request: {
          sessionId,
          messages: [...messages, userMessage].map((item) => ({
            role: item.role,
            content: item.content,
          })),
          context: contextSummary,
        },
      });
    } catch (error) {
      setRunning(false);
      setMessages((current) =>
        updateLatestAssistantMessage(current, (messageItem) => ({
          ...messageItem,
          content: `AI 分析启动失败: ${error}`,
          phase: 'error',
          completedAt: Date.now(),
          startedAt: messageItem.startedAt || startedAt,
        })),
      );
      message.error(`AI 分析启动失败: ${error}`);
    }
  };

  const appendPrompt = (prompt: string) => {
    setInput((current) => (current.trim() ? `${current.trim()}\n${prompt}` : prompt));
  };

  const resetChat = () => {
    if (running) return;
    setMessages([]);
    setInput('');
  };

  return (
    <div className="ai-terminal-workspace">
      <main className="ai-terminal-main" aria-label="AI conversation">
        <header className="ai-terminal-head">
          <div className="ai-terminal-title">
            <span>AI 分析</span>
          </div>
          <div className="ai-terminal-actions">
            <span className={`ai-run-state ${running ? 'running' : ''}`}>{running ? '分析中' : '就绪'}</span>
            <Tooltip title="新建分析">
              <Button
                aria-label="新建分析"
                disabled={running}
                icon={<PlusOutlined />}
                onClick={resetChat}
              />
            </Tooltip>
          </div>
        </header>

        <div className="ai-transcript" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="ai-empty-state">
              <div className="ai-empty-copy">等待输入</div>
              <div className="ai-empty-prompts" aria-label="建议问题">
                {quickPrompts.map((item) => (
                  <button key={item.label} type="button" onClick={() => appendPrompt(item.prompt)}>
                    <ThunderboltOutlined />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((item) => {
              const isAssistant = item.role === 'assistant';
              const isWaiting = isAssistant && item.phase === 'pending' && !item.reasoning && !item.content;
              const reasoningDone =
                Boolean(item.thinkingCompletedAt)
                || item.phase === 'answering'
                || item.phase === 'done'
                || item.phase === 'error';
              const reasoningEnd = item.thinkingCompletedAt || item.completedAt || clockTick;
              const reasoningElapsed = formatElapsedSeconds(item.startedAt, reasoningEnd);
              const reasoningLabel = reasoningDone
                ? `已思考（用时 ${reasoningElapsed}）`
                : `思考中（${reasoningElapsed}）`;

              return (
                <article className={`ai-line-message ${item.role}`} key={item.id}>
                  <div className="ai-message-body">
                    {isWaiting ? (
                      <div className="ai-thinking-loading" role="status" aria-live="polite">
                        <span>正在思考</span>
                        <ThinkingDots />
                      </div>
                    ) : null}
                    {item.reasoning ? (
                      <details className={`ai-reasoning ${reasoningDone ? 'done' : 'running'}`} open>
                        <summary>
                          <span className="ai-reasoning-mark" aria-hidden="true" />
                          <span className="ai-reasoning-label">{reasoningLabel}</span>
                          <span className="ai-reasoning-caret" aria-hidden="true" />
                        </summary>
                        <MarkdownContent content={item.reasoning} />
                      </details>
                    ) : null}
                    {item.content ? <MarkdownContent content={item.content} /> : null}
                  </div>
                </article>
              );
            })
          )}
        </div>

        <div className="ai-composer-line">
          <span className="ai-composer-prompt">&gt;</span>
          <Input.TextArea
            rows={3}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="让 AI 分析当前主机、扫描结果或日志线索..."
          />
          <Tooltip title="发送">
            <Button
              aria-label="发送"
              className="ai-send-button"
              icon={<SendOutlined />}
              type="primary"
              loading={running}
              onClick={sendMessage}
            />
          </Tooltip>
        </div>
      </main>
    </div>
  );
}
