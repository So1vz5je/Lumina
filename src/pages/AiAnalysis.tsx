import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Input, Modal, Tooltip, message } from 'antd';
import {
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult } from '../types/analysis';

type ChatRole = 'user' | 'assistant';
type ChatPhase = 'pending' | 'reasoning' | 'answering' | 'done' | 'error' | 'cancelled';
type ChatToolEventType = 'tool_call' | 'tool_result';
type ChatStreamSegmentType = 'reasoning' | 'content' | 'tool';
type ChatToolSegmentStatus = 'running' | 'done';

interface ChatToolEvent {
  id: string;
  type: ChatToolEventType;
  toolName?: string;
  content: string;
}

interface ChatStreamSegment {
  id: string;
  type: ChatStreamSegmentType;
  toolName?: string;
  content: string;
  result?: string;
  status?: ChatToolSegmentStatus;
  open?: boolean;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  reasoningOpen?: boolean;
  toolEvents?: ChatToolEvent[];
  segments?: ChatStreamSegment[];
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

interface AdminApprovalRequest {
  approvalId: string;
  command: string;
  workingDirectory: string;
  reason: string;
  timeoutSeconds: number;
}

interface AiAnalysisProps {
  mode: string;
  osType: string;
  currentModule: string;
  scanResults: AnalysisResult[];
}

interface AiConversationSnapshot {
  sessionId: string;
  messages: ChatMessage[];
  input: string;
}

const makeId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const aiConversationStorageKey = 'emergency-analyzer.ai-analysis.conversation.v1';

const normalizeRestoredMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((item) => {
    if (item.role !== 'assistant') return item;
    if (item.phase !== 'pending' && item.phase !== 'reasoning' && item.phase !== 'answering') {
      return migrateMessageSegments(item);
    }
    if (item.content || item.reasoning) {
      return migrateMessageSegments({ ...item, phase: 'done', completedAt: item.completedAt || Date.now() });
    }
    return migrateMessageSegments({
      ...item,
      phase: 'error',
      content: '上次分析未完成，请重新发送。',
      completedAt: item.completedAt || Date.now(),
    });
  });

const loadAiConversationSnapshot = (): AiConversationSnapshot | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.sessionStorage.getItem(aiConversationStorageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<AiConversationSnapshot>;
    if (!parsed.sessionId || !Array.isArray(parsed.messages)) return undefined;
    return {
      sessionId: parsed.sessionId,
      messages: normalizeRestoredMessages(parsed.messages),
      input: typeof parsed.input === 'string' ? parsed.input : '',
    };
  } catch {
    return undefined;
  }
};

const saveAiConversationSnapshot = (snapshot: AiConversationSnapshot) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(aiConversationStorageKey, JSON.stringify(snapshot));
  } catch {
    // Session storage is best-effort; the in-memory React state remains authoritative.
  }
};

const parseAdminApprovalRequest = (content: string): AdminApprovalRequest | null => {
  try {
    const parsed = JSON.parse(content) as Partial<AdminApprovalRequest>;
    if (!parsed.approvalId || !parsed.command) return null;
    return {
      approvalId: parsed.approvalId,
      command: parsed.command,
      workingDirectory: parsed.workingDirectory || '',
      reason: parsed.reason || 'AI 请求管理员权限执行命令',
      timeoutSeconds:
        typeof parsed.timeoutSeconds === 'number' && Number.isFinite(parsed.timeoutSeconds)
          ? parsed.timeoutSeconds
          : 30,
    };
  } catch {
    return null;
  }
};

const createAssistantMessage = (phase: ChatPhase = 'pending'): ChatMessage => ({
  id: `${makeId()}-assistant`,
  role: 'assistant',
  content: '',
  phase,
  startedAt: Date.now(),
});

const createStreamSegment = (
  type: ChatStreamSegmentType,
  content: string,
  toolName?: string,
  open?: boolean,
  sequence = 0,
): ChatStreamSegment => ({
  id: `${makeId()}-${type}-${sequence}`,
  type,
  toolName,
  content,
  open,
});

const migrateMessageSegments = (message: ChatMessage): ChatMessage => {
  if (message.segments?.length) return message;
  if (message.role !== 'assistant') return message;

  const segments: ChatStreamSegment[] = [];
  if (message.reasoning) {
    segments.push(createStreamSegment('reasoning', message.reasoning, undefined, message.reasoningOpen, segments.length));
  }
  message.toolEvents?.forEach((event) => {
    if (event.type === 'tool_call') {
      segments.push({
        ...createStreamSegment('tool', event.content, event.toolName, false, segments.length),
        status: 'running',
      });
      return;
    }
    const pendingToolIndex = [...segments]
      .reverse()
      .findIndex((segment) => segment.type === 'tool' && segment.toolName === event.toolName && !segment.result);
    if (pendingToolIndex >= 0) {
      const segmentIndex = segments.length - 1 - pendingToolIndex;
      segments[segmentIndex] = { ...segments[segmentIndex], result: event.content, status: 'done' };
    } else {
      segments.push({
        ...createStreamSegment('tool', '', event.toolName, false, segments.length),
        result: event.content,
        status: 'done',
      });
    }
  });
  if (message.content) {
    segments.push(createStreamSegment('content', message.content, undefined, undefined, segments.length));
  }

  return segments.length ? { ...message, segments } : message;
};

const appendStreamSegment = (
  message: ChatMessage,
  type: ChatStreamSegmentType,
  content: string,
  toolName?: string,
): ChatMessage => {
  const segments = [...(message.segments || [])];
  const last = segments[segments.length - 1];
  if ((type === 'reasoning' || type === 'content') && last?.type === type) {
    segments[segments.length - 1] = { ...last, content: `${last.content}${content}` };
  } else {
    segments.push(createStreamSegment(type, content, toolName, type === 'reasoning' ? message.reasoningOpen ?? true : undefined, segments.length));
  }
  return { ...message, segments };
};

const appendToolCallSegment = (message: ChatMessage, toolName: string | undefined, content: string): ChatMessage => {
  const segments = [...(message.segments || [])];
  segments.push({
    ...createStreamSegment('tool', content, toolName, false, segments.length),
    status: 'running',
  });
  return { ...message, segments };
};

const completeToolSegment = (message: ChatMessage, toolName: string | undefined, result: string): ChatMessage => {
  const segments = [...(message.segments || [])];
  const pendingIndex = [...segments]
    .reverse()
    .findIndex((segment) => segment.type === 'tool' && segment.toolName === toolName && segment.status !== 'done');
  if (pendingIndex >= 0) {
    const segmentIndex = segments.length - 1 - pendingIndex;
    segments[segmentIndex] = { ...segments[segmentIndex], result, status: 'done' };
    return { ...message, segments };
  }
  segments.push({
    ...createStreamSegment('tool', '', toolName, false, segments.length),
    result,
    status: 'done',
  });
  return { ...message, segments };
};

const getMessageSegments = (message: ChatMessage): ChatStreamSegment[] => {
  if (message.segments?.length) return message.segments;
  return migrateMessageSegments(message).segments || [];
};

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

const markAssistantMessageCancelled = (messageItem: ChatMessage): ChatMessage => {
  const hasVisibleContent = Boolean(
    messageItem.content
    || messageItem.reasoning
    || messageItem.toolEvents?.length
    || messageItem.segments?.length,
  );

  return {
    ...messageItem,
    content: hasVisibleContent ? messageItem.content : '已停止生成。',
    phase: 'cancelled',
    completedAt: Date.now(),
    startedAt: messageItem.startedAt || Date.now(),
    thinkingCompletedAt:
      messageItem.reasoning && !messageItem.thinkingCompletedAt
        ? Date.now()
        : messageItem.thinkingCompletedAt,
  };
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

type MarkdownTableAlignment = 'left' | 'center' | 'right';

const splitMarkdownTableRow = (line: string): string[] => {
  let source = line.trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|')) source = source.slice(0, -1);
  return source.split('|').map((cell) => cell.trim());
};

const getMarkdownTableAlignments = (line: string): (MarkdownTableAlignment | undefined)[] | undefined => {
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2) return undefined;
  if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) return undefined;
  return cells.map((cell) => {
    const compact = cell.replace(/\s+/g, '');
    if (compact.startsWith(':') && compact.endsWith(':')) return 'center';
    if (compact.endsWith(':')) return 'right';
    if (compact.startsWith(':')) return 'left';
    return undefined;
  });
};

const isMarkdownTableStart = (lines: string[], index: number): boolean => {
  const current = lines[index]?.trim();
  const next = lines[index + 1]?.trim();
  if (!current || !next || !current.includes('|')) return false;
  const headerCells = splitMarkdownTableRow(current);
  const alignments = getMarkdownTableAlignments(next);
  return Boolean(alignments && headerCells.length >= 2 && alignments.length === headerCells.length);
};

const isMarkdownHorizontalRule = (line: string): boolean =>
  /^([-*_])(?:\s*\1){2,}\s*$/.test(line.trim());

const isMarkdownBlockStart = (lines: string[], index: number): boolean => {
  const line = lines[index]?.trim() || '';
  return /^#{1,6}\s+/.test(line)
    || /^[-*]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^>\s?/.test(line)
    || /^```/.test(line)
    || isMarkdownHorizontalRule(line)
    || isMarkdownTableStart(lines, index);
};

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

    if (isMarkdownTableStart(lines, index)) {
      const headerCells = splitMarkdownTableRow(trimmed);
      const alignments = getMarkdownTableAlignments(lines[index + 1].trim()) || [];
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      const columnCount = Math.max(
        headerCells.length,
        alignments.length,
        ...rows.map((row) => row.length),
      );
      const columns = Array.from({ length: columnCount });
      blocks.push(
        <div className="ai-markdown-table-wrap" key={`table-${index}`}>
          <table className="ai-markdown-table">
            <thead>
              <tr>
                {columns.map((_, cellIndex) => (
                  <th
                    key={`head-${cellIndex}`}
                    style={alignments[cellIndex] ? { textAlign: alignments[cellIndex] } : undefined}
                  >
                    {renderInlineMarkdown(headerCells[cellIndex] || '', `table-${index}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {columns.map((_, cellIndex) => (
                    <td
                      key={`cell-${rowIndex}-${cellIndex}`}
                      style={alignments[cellIndex] ? { textAlign: alignments[cellIndex] } : undefined}
                    >
                      {renderInlineMarkdown(row[cellIndex] || '', `table-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (isMarkdownHorizontalRule(trimmed)) {
      blocks.push(<hr key={`hr-${index}`} />);
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
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
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

function ToolEvent({ event }: { event: ChatStreamSegment }) {
  const completed = event.status === 'done' || Boolean(event.result);
  return (
    <details className={`ai-stream-part ai-tool-event ${completed ? 'done' : 'running'}`} data-stream-type="tool">
      <summary>
        <span className="ai-tool-dot" aria-hidden="true" />
        <span className="ai-tool-label">调用</span>
        <strong>{event.toolName || 'tool'}</strong>
        <span className="ai-tool-status">{completed ? '已完成' : '调用中'}</span>
        <span className="ai-tool-caret" aria-hidden="true" />
      </summary>
      <div className="ai-tool-detail">
        {event.content ? (
          <div>
            <span>参数</span>
            <code>{event.content}</code>
          </div>
        ) : null}
        {event.result ? (
          <div>
            <span>结果</span>
            <code>{event.result}</code>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default function AiAnalysis({ mode, osType, currentModule, scanResults }: AiAnalysisProps) {
  const [initialSnapshot] = useState<AiConversationSnapshot>(
    () => loadAiConversationSnapshot() || { sessionId: makeId(), messages: [], input: '' },
  );
  const [sessionId] = useState(() => initialSnapshot.sessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialSnapshot.messages);
  const [input, setInput] = useState(() => initialSnapshot.input);
  const [running, setRunning] = useState(false);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [pendingAdminApproval, setPendingAdminApproval] = useState<AdminApprovalRequest | null>(null);
  const [adminApprovalResolving, setAdminApprovalResolving] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stoppedRef = useRef(false);

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
    saveAiConversationSnapshot({ sessionId, messages, input });
  }, [input, messages, sessionId]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AiStreamEvent>('ai://stream', (event) => {
          const payload = event.payload;
          if (!payload || payload.sessionId !== sessionId) return;

          if (stoppedRef.current && payload.eventType !== 'cancelled' && payload.eventType !== 'error') {
            return;
          }

          if (payload.eventType === 'token') {
            setMessages((current) => {
              return updateLatestAssistantMessage(current, (messageItem) =>
                appendStreamSegment(
                  {
                    ...messageItem,
                    content: `${messageItem.content}${payload.content}`,
                    phase: 'answering',
                    startedAt: messageItem.startedAt || Date.now(),
                    thinkingCompletedAt:
                      messageItem.reasoning && !messageItem.thinkingCompletedAt
                        ? Date.now()
                        : messageItem.thinkingCompletedAt,
                  },
                  'content',
                  payload.content,
                ),
              );
            });
            return;
          }

          if (payload.eventType === 'reasoning') {
            setMessages((current) => {
              return updateLatestAssistantMessage(current, (messageItem) =>
                appendStreamSegment(
                  {
                    ...messageItem,
                    reasoning: `${messageItem.reasoning || ''}${payload.content}`,
                    reasoningOpen: messageItem.reasoningOpen ?? true,
                    phase: 'reasoning',
                    startedAt: messageItem.startedAt || Date.now(),
                  },
                  'reasoning',
                  payload.content,
                ),
              );
            });
            return;
          }

          if (payload.eventType === 'admin_approval_request') {
            const approvalRequest = parseAdminApprovalRequest(payload.content);
            if (approvalRequest) {
              setPendingAdminApproval(approvalRequest);
            }
            return;
          }

          if (payload.eventType === 'tool_call' || payload.eventType === 'tool_result') {
            setMessages((current) => {
              const eventItem: ChatToolEvent = {
                id: `${makeId()}-${payload.eventType}`,
                type: payload.eventType as ChatToolEventType,
                toolName: payload.toolName,
                content: payload.content,
              };
              return updateLatestAssistantMessage(current, (messageItem) =>
                (eventItem.type === 'tool_call' ? appendToolCallSegment : completeToolSegment)(
                  {
                    ...messageItem,
                    phase: messageItem.phase === 'pending' ? 'reasoning' : messageItem.phase,
                    startedAt: messageItem.startedAt || Date.now(),
                    toolEvents: [...(messageItem.toolEvents || []), eventItem],
                  },
                  eventItem.toolName,
                  eventItem.content,
                ),
              );
            });
            return;
          }

          if (payload.eventType === 'cancelled') {
            stoppedRef.current = true;
            setRunning(false);
            setPendingAdminApproval(null);
            setMessages((current) =>
              updateLatestAssistantMessage(current, markAssistantMessageCancelled),
            );
            return;
          }

          if (payload.eventType === 'done' || payload.eventType === 'error') {
            stoppedRef.current = false;
            setRunning(false);
            setPendingAdminApproval(null);
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

  const sendMessage = async (promptOverride?: string) => {
    const prompt = (promptOverride ?? input).trim();
    if (!prompt || running) return;

    const startedAt = Date.now();
    const userMessage: ChatMessage = { id: `${makeId()}-user`, role: 'user', content: prompt };
    const assistantMessage: ChatMessage = {
      ...createAssistantMessage('pending'),
      startedAt,
    };
    stoppedRef.current = false;
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

  const stopMessage = async () => {
    if (!running) return;

    stoppedRef.current = true;
    setRunning(false);
    setMessages((current) =>
      updateLatestAssistantMessage(current, markAssistantMessageCancelled),
    );

    try {
      await invoke('ai_cancel_message', { sessionId });
    } catch {
      // The UI should still stop locally if the backend cancellation request races with shutdown.
    }
  };

  const resetChat = () => {
    if (running) return;
    setMessages([]);
    setInput('');
  };

  const updateReasoningOpen = (messageId: string, open: boolean, segmentId?: string) => {
    setMessages((current) =>
      current.map((item) => (
        item.id === messageId
          ? {
            ...item,
            reasoningOpen: open,
            segments: item.segments?.map((segment) => (
              segmentId && segment.id === segmentId ? { ...segment, open } : segment
            )),
          }
          : item
      )),
    );
  };

  const resolveAdminApproval = async (approved: boolean) => {
    if (!pendingAdminApproval) return;
    const request = pendingAdminApproval;
    setAdminApprovalResolving(true);
    try {
      await invoke('ai_resolve_admin_approval', {
        sessionId,
        approvalId: request.approvalId,
        approved,
      });
      setPendingAdminApproval(null);
    } catch (error) {
      message.error(`管理员命令审批失败: ${error}`);
    } finally {
      setAdminApprovalResolving(false);
    }
  };

  return (
    <div className="ai-terminal-workspace">
      <main className="ai-terminal-main" aria-label="AI conversation">
        <header className="ai-terminal-head">
          <div className="ai-terminal-actions">
            <span className={`ai-run-state ${running ? 'running' : ''}`}>{running ? '分析中' : '就绪'}</span>
            <Tooltip title="刷新对话">
              <Button
                aria-label="刷新对话"
                disabled={running}
                icon={<ReloadOutlined />}
                onClick={resetChat}
              />
            </Tooltip>
          </div>
        </header>

        <div className="ai-transcript" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="ai-empty-state">
              <div className="ai-empty-mark" aria-hidden="true" />
              <div className="ai-empty-copy">等待输入</div>
              <div className="ai-empty-prompts" aria-label="建议问题">
                {quickPrompts.map((item) => (
                  <button key={item.label} type="button" onClick={() => void sendMessage(item.prompt)}>
                    <ThunderboltOutlined />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((item) => {
              const isAssistant = item.role === 'assistant';
              const isWaiting = isAssistant
                && item.phase === 'pending'
                && !item.reasoning
                && !item.content
                && !item.toolEvents?.length
                && !item.segments?.length;
              const reasoningDone =
                Boolean(item.thinkingCompletedAt)
                || item.phase === 'answering'
                || item.phase === 'done'
                || item.phase === 'error'
                || item.phase === 'cancelled';
              const reasoningEnd = item.thinkingCompletedAt || item.completedAt || clockTick;
              const reasoningElapsed = formatElapsedSeconds(item.startedAt, reasoningEnd);
              const reasoningLabel = reasoningDone
                ? `已思考（用时 ${reasoningElapsed}）`
                : `思考中（${reasoningElapsed}）`;
              const reasoningOpen = item.reasoningOpen !== false;
              const streamSegments = isAssistant ? getMessageSegments(item) : [];

              return (
                <article className={`ai-line-message ${item.role}`} key={item.id}>
                  <div className="ai-message-body">
                    {isWaiting ? (
                      <div className="ai-thinking-loading" role="status" aria-live="polite">
                        <span>正在思考</span>
                        <ThinkingDots />
                      </div>
                    ) : null}
                    {isAssistant ? streamSegments.map((segment, segmentIndex) => {
                      if (segment.type === 'content') {
                        return (
                          <div
                            className="ai-stream-part ai-answer-part"
                            data-stream-type="content"
                            key={segment.id}
                          >
                            <MarkdownContent content={segment.content} />
                          </div>
                        );
                      }

                      if (segment.type === 'tool') {
                        return <ToolEvent event={segment} key={segment.id} />;
                      }

                      const hasLaterVisibleSegment = streamSegments
                        .slice(segmentIndex + 1)
                        .some((nextSegment) => nextSegment.type !== 'reasoning');
                      const segmentDone = reasoningDone || hasLaterVisibleSegment;
                      const segmentOpen = segment.open ?? reasoningOpen;

                      return (
                        <details
                          className={`ai-stream-part ai-reasoning ${segmentDone ? 'done' : 'running'}`}
                          data-stream-type="reasoning"
                          key={segment.id}
                          open={segmentOpen}
                          onToggle={(event) => {
                            const nextOpen = event.currentTarget.open;
                            if (nextOpen !== segmentOpen) {
                              updateReasoningOpen(item.id, nextOpen, segment.id);
                            }
                          }}
                        >
                          <summary>
                            <span className="ai-reasoning-mark" aria-hidden="true" />
                            <span className="ai-reasoning-label">{reasoningLabel}</span>
                            <span className="ai-reasoning-caret" aria-hidden="true" />
                          </summary>
                          <MarkdownContent content={segment.content} />
                        </details>
                      );
                    }) : item.content ? <MarkdownContent content={item.content} /> : null}
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
          <Tooltip title={running ? '停止生成' : '发送'}>
            <Button
              aria-label={running ? '停止生成' : '发送'}
              className={`ai-send-button ${running ? 'running' : ''}`}
              icon={running ? <StopOutlined /> : <SendOutlined />}
              type={running ? 'default' : 'primary'}
              onClick={() => {
                if (running) {
                  void stopMessage();
                } else {
                  void sendMessage();
                }
              }}
            />
          </Tooltip>
        </div>
        <Modal
          className="ai-admin-approval-modal"
          open={Boolean(pendingAdminApproval)}
          title="批准管理员命令"
          okText="批准执行"
          cancelText="拒绝"
          confirmLoading={adminApprovalResolving}
          onOk={() => void resolveAdminApproval(true)}
          onCancel={() => void resolveAdminApproval(false)}
          maskClosable={!adminApprovalResolving}
        >
          {pendingAdminApproval ? (
            <div className="ai-admin-approval">
              <div>
                <span>原因</span>
                <strong>{pendingAdminApproval.reason}</strong>
              </div>
              <div>
                <span>命令</span>
                <code>{pendingAdminApproval.command}</code>
              </div>
              <div>
                <span>工作目录</span>
                <code>{pendingAdminApproval.workingDirectory || '默认工作区'}</code>
              </div>
              <div>
                <span>超时</span>
                <strong>{pendingAdminApproval.timeoutSeconds} 秒</strong>
              </div>
            </div>
          ) : null}
        </Modal>
      </main>
    </div>
  );
}
