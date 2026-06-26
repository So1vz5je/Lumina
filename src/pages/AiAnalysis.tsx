import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tooltip, Typography, message } from 'antd';
import {
  BranchesOutlined,
  MessageOutlined,
  PlusOutlined,
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
  const userCount = messages.filter((item) => item.role === 'user').length;
  const toolResultCount = toolEvents.filter((event) => event.type === 'tool_result').length;

  return (
    <div className="ai-terminal-workspace">
      <main className="ai-terminal-main" aria-label="AI conversation">
        <header className="ai-terminal-head">
          <div className="ai-terminal-title">
            <Text className="ai-kicker">Lumina Agent</Text>
            <Title level={4}>AI 分析工作台</Title>
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

        <div className="ai-context-line">
          <span>{osType}</span>
          <span>{mode}</span>
          <span>{currentModule}</span>
          <span>{scanResults.length} 条扫描结果</span>
        </div>

        <div className="ai-prompt-row" aria-label="快捷提问">
          {quickPrompts.map((item) => (
            <button key={item.label} type="button" onClick={() => appendPrompt(item.prompt)}>
              <ThunderboltOutlined />
              {item.label}
            </button>
          ))}
        </div>

        <div className="ai-transcript" ref={scrollRef}>
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
              <article className={`ai-line-message ${item.role}`} key={item.id}>
                <div className="ai-message-body">
                  <Text className="ai-message-role">
                    {item.role === 'user' ? 'You' : 'Lumina Agent'}
                  </Text>
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

      <aside className="ai-side-panel" aria-label="AI context inspector">
        <section className="ai-side-section">
          <Text className="ai-section-label">会话</Text>
          <div className="ai-side-row">
            <span><MessageOutlined /> 消息</span>
            <strong>{messages.length}</strong>
          </div>
          <div className="ai-side-row">
            <span>提问</span>
            <strong>{userCount}</strong>
          </div>
          <div className="ai-side-row">
            <span>回复</span>
            <strong>{assistantCount}</strong>
          </div>
        </section>

        <section className="ai-side-section">
          <Text className="ai-section-label">上下文</Text>
          <div className="ai-side-row">
            <span>系统</span>
            <strong>{osType}</strong>
          </div>
          <div className="ai-side-row">
            <span>模式</span>
            <strong>{mode}</strong>
          </div>
          <div className="ai-side-row">
            <span>模块</span>
            <strong>{currentModule}</strong>
          </div>
          <div className="ai-side-row">
            <span>扫描</span>
            <strong>{scanResults.length} 条</strong>
          </div>
        </section>

        <section className="ai-side-section ai-tool-section">
          <Text className="ai-section-label">工具轨迹</Text>
          <div className="ai-side-row">
            <span>结果</span>
            <strong>{toolResultCount}</strong>
          </div>
          <div className="ai-tool-list">
            {toolEvents.length === 0 ? (
              <div className="ai-tool-empty">
                <ToolOutlined />
                <span>暂无工具调用</span>
              </div>
            ) : (
              toolEvents.map((event) => (
                <div className={`ai-tool-event ${event.type}`} key={event.id}>
                  <span>{event.type === 'tool_call' ? '调用' : '结果'}</span>
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
