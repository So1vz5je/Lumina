import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tag, Tooltip, Typography, message } from 'antd';
import {
  ApiOutlined,
  BranchesOutlined,
  BulbOutlined,
  MessageOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult } from '../types/analysis';

const { Text, Title, Paragraph } = Typography;

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
}

interface ToolEvent {
  id: string;
  type: string;
  name: string;
  content: string;
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

export default function AiAnalysis({ mode, osType, currentModule, scanResults }: AiAnalysisProps) {
  const [sessionId] = useState(() => makeId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
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
    let cleanup: (() => void) | undefined;
    let disposed = false;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AiStreamEvent>('ai://stream', (event) => {
          const payload = event.payload;
          if (!payload || payload.sessionId !== sessionId) return;

          if (payload.eventType === 'token') {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = { ...last, content: `${last.content}${payload.content}` };
              } else {
                next.push({ id: makeId(), role: 'assistant', content: payload.content });
              }
              return next;
            });
            return;
          }

          if (payload.eventType === 'reasoning') {
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  reasoning: `${last.reasoning || ''}${payload.content}`,
                };
              } else {
                next.push({ id: makeId(), role: 'assistant', content: '', reasoning: payload.content });
              }
              return next;
            });
            return;
          }

          if (payload.eventType === 'tool_call' || payload.eventType === 'tool_result') {
            setToolEvents((current) => [
              ...current,
              {
                id: makeId(),
                type: payload.eventType,
                name: payload.toolName || 'tool',
                content: payload.content,
              },
            ]);
            return;
          }

          if (payload.eventType === 'done' || payload.eventType === 'error') {
            setRunning(false);
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
  }, [messages, toolEvents]);

  const sendMessage = async () => {
    const prompt = input.trim();
    if (!prompt || running) return;

    const userMessage: ChatMessage = { id: makeId(), role: 'user', content: prompt };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setRunning(true);

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
      message.error(`AI 分析启动失败: ${error}`);
    }
  };

  const appendPrompt = (prompt: string) => {
    setInput((current) => (current.trim() ? `${current.trim()}\n${prompt}` : prompt));
  };

  const resetChat = () => {
    if (running) return;
    setMessages([]);
    setToolEvents([]);
    setInput('');
  };

  const assistantCount = messages.filter((item) => item.role === 'assistant').length;
  const toolResultCount = toolEvents.filter((event) => event.type === 'tool_result').length;

  return (
    <div className="ai-analysis-workspace">
      <aside className="ai-session-rail" aria-label="AI sessions">
        <div className="ai-brand-lockup">
          <div className="ai-brand-mark">
            <RobotOutlined />
          </div>
          <div>
            <Text className="ai-kicker">Lumina Agent</Text>
            <Title level={4}>AI 分析工作台</Title>
          </div>
        </div>

        <button className="ai-session-item active" type="button">
          <span className="ai-session-title">
            <MessageOutlined />
            当前会话
          </span>
          <span className="ai-session-meta">{messages.length || 0} 条消息</span>
        </button>

        <button className="ai-new-chat" disabled={running} onClick={resetChat} type="button">
          <PlusOutlined />
          新建分析
        </button>

        <div className="ai-quick-prompts">
          <Text className="ai-section-label">快捷提问</Text>
          {quickPrompts.map((item) => (
            <button key={item.label} type="button" onClick={() => appendPrompt(item.prompt)}>
              <ThunderboltOutlined />
              {item.label}
            </button>
          ))}
        </div>
      </aside>

      <main className="ai-chat-panel" aria-label="AI conversation">
        <header className="ai-command-bar">
          <div>
            <Text className="ai-kicker">Agent</Text>
            <Title level={4}>应急响应分析</Title>
          </div>
          <div className="ai-command-status">
            <Tag icon={<ApiOutlined />} className="ai-status-tag">
              OpenAI Compatible
            </Tag>
            <Tag icon={<ToolOutlined />} className="ai-status-tag">
              工具调用
            </Tag>
            <Tag icon={<BulbOutlined />} className="ai-status-tag">
              思考流
            </Tag>
          </div>
        </header>

        <header className="ai-run-strip">
          <div>
            <span>当前上下文</span>
            <strong>{osType} / {mode}</strong>
          </div>
          <div>
            <span>模块</span>
            <strong>{currentModule}</strong>
          </div>
          <div>
            <span>扫描结果</span>
            <strong>{scanResults.length}</strong>
          </div>
          <div>
            <span>工具结果</span>
            <strong>{toolResultCount}</strong>
          </div>
        </header>

        <div className="ai-message-list" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="ai-empty-state">
              <div className="ai-empty-mark">
                <BranchesOutlined />
              </div>
              <Title level={3}>等待分析线索</Title>
              <Paragraph>选择左侧问题，或直接输入要研判的日志、进程、账号、文件路径。</Paragraph>
            </div>
          ) : (
            messages.map((item) => (
              <article className={`ai-message ${item.role}`} key={item.id}>
                <div className="ai-message-avatar">{item.role === 'user' ? '你' : 'AI'}</div>
                <div className="ai-message-body">
                  <Text className="ai-message-role">{item.role === 'user' ? '你' : 'AI Agent'}</Text>
                  {item.reasoning ? (
                    <details className="ai-reasoning" open>
                      <summary>思考过程</summary>
                      <Paragraph>{item.reasoning}</Paragraph>
                    </details>
                  ) : null}
                  {item.content ? <Paragraph>{item.content}</Paragraph> : null}
                </div>
              </article>
            ))
          )}
        </div>

        <div className="ai-composer">
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

      <aside className="ai-inspector-rail" aria-label="AI context inspector">
        <section className="ai-inspector-section">
          <Text className="ai-section-label">上下文</Text>
          <div className="ai-context-grid">
            <span>系统</span>
            <strong>{osType}</strong>
            <span>模式</span>
            <strong>{mode}</strong>
            <span>模块</span>
            <strong>{currentModule}</strong>
            <span>结果</span>
            <strong>{scanResults.length} 条</strong>
          </div>
        </section>

        <section className="ai-inspector-section">
          <Text className="ai-section-label">运行状态</Text>
          <div className="ai-metric-row">
            <div>
              <strong>{assistantCount}</strong>
              <span>回复</span>
            </div>
            <div>
              <strong>{toolEvents.length}</strong>
              <span>工具事件</span>
            </div>
          </div>
        </section>

        <section className="ai-inspector-section ai-tool-section">
          <Text className="ai-section-label">工具轨迹</Text>
        <div className="ai-tool-list">
          {toolEvents.length === 0 ? (
            <div className="ai-tool-empty">
              <ToolOutlined />
              <span>暂无工具调用</span>
            </div>
          ) : (
            toolEvents.map((event) => (
              <div className="ai-tool-event" key={event.id}>
                <Tag className={event.type === 'tool_call' ? 'ai-tool-call' : 'ai-tool-result'}>
                  {event.type === 'tool_call' ? '调用' : '结果'}
                </Tag>
                <strong>{event.name}</strong>
                <p>{event.content}</p>
              </div>
            ))
          )}
        </div>
        </section>
      </aside>
    </div>
  );
}
