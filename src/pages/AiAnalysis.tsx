import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Space, Tag, Typography, message } from 'antd';
import { BulbOutlined, SendOutlined, ToolOutlined } from '@ant-design/icons';
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

  return (
    <div className="ai-analysis-workspace">
      <aside className="ai-session-rail">
        <div>
          <Text className="ai-kicker">AI</Text>
          <Title level={4}>AI 分析工作台</Title>
        </div>
        <button className="ai-session-item active" type="button">
          <span>当前会话</span>
          <Text type="secondary">IR Agent</Text>
        </button>
        <div className="ai-context-card">
          <Text type="secondary">上下文</Text>
          <strong>{osType} / {mode}</strong>
          <span>当前模块: {currentModule}</span>
          <span>扫描结果: {scanResults.length} 条</span>
        </div>
      </aside>

      <main className="ai-chat-panel">
        <header className="ai-chat-header">
          <div>
            <Text className="ai-kicker">Agent</Text>
            <Title level={4}>应急响应分析</Title>
          </div>
          <Space>
            <Tag icon={<ToolOutlined />} color="blue">工具调用</Tag>
            <Tag icon={<BulbOutlined />} color="gold">思考流</Tag>
          </Space>
        </header>

        <div className="ai-message-list" ref={scrollRef}>
          {messages.length === 0 ? (
            <Empty
              description="询问可疑登录、日志时间线、进程风险或让 AI 汇总扫描结果"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            messages.map((item) => (
              <article className={`ai-message ${item.role}`} key={item.id}>
                <Text className="ai-message-role">{item.role === 'user' ? '你' : 'AI'}</Text>
                {item.reasoning ? (
                  <details className="ai-reasoning" open>
                    <summary>思考过程</summary>
                    <Paragraph>{item.reasoning}</Paragraph>
                  </details>
                ) : null}
                {item.content ? <Paragraph>{item.content}</Paragraph> : null}
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
          <Button icon={<SendOutlined />} type="primary" loading={running} onClick={sendMessage}>
            发送
          </Button>
        </div>
      </main>

      <aside className="ai-tool-rail">
        <Text className="ai-kicker">Tools</Text>
        <Title level={5}>工具轨迹</Title>
        <div className="ai-tool-list">
          {toolEvents.length === 0 ? (
            <Text type="secondary">暂无工具调用</Text>
          ) : (
            toolEvents.map((event) => (
              <div className="ai-tool-event" key={event.id}>
                <Tag color={event.type === 'tool_call' ? 'blue' : 'green'}>
                  {event.type === 'tool_call' ? '调用' : '结果'}
                </Tag>
                <strong>{event.name}</strong>
                <p>{event.content}</p>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
