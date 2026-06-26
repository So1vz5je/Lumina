import { useEffect, useState } from 'react';
import { Button, Input, Select, Typography, message } from 'antd';
import type { ReactNode } from 'react';
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  MoonOutlined,
  RobotOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const { Text, Title } = Typography;

interface SettingsProps {
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
  defaultDownloadPath: string;
  setDefaultDownloadPath: (path: string) => void;
  onBackToSelect: () => void;
  wallpaper: string;
  setWallpaper: (value: string) => void;
  glassEnabled: boolean;
  setGlassEnabled: (value: boolean) => void;
  wallpaperOpacity: number;
  setWallpaperOpacity: (value: number) => void;
}

type ThemeOption = {
  key: 'light' | 'dark';
  label: string;
  dark: boolean;
  icon: ReactNode;
};

const themeOptions: ThemeOption[] = [
  { key: 'light', label: '浅色', dark: false, icon: <SunOutlined /> },
  { key: 'dark', label: '暗色', dark: true, icon: <MoonOutlined /> },
];

interface AiConfigView {
  provider: string;
  baseUrl: string;
  apiKeyPreview: string;
  hasApiKey: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  showReasoning: boolean;
  toolsEnabled: boolean;
  maxToolCalls: number;
}

interface WorkspaceConfigView {
  rootPath: string;
  exportsPath: string;
  aiLogsPath: string;
  collectionsPath: string;
  tempPath: string;
  adminRunsPath: string;
}

const defaultAiConfig: AiConfigView = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyPreview: '',
  hasApiKey: false,
  model: 'gpt-4.1-mini',
  temperature: 0.2,
  maxTokens: 2048,
  showReasoning: true,
  toolsEnabled: true,
  maxToolCalls: 12,
};

export default function Settings({
  isDarkMode,
  setIsDarkMode,
  defaultDownloadPath,
  setDefaultDownloadPath,
  wallpaper,
  setWallpaper,
}: SettingsProps) {
  const activeTheme = wallpaper === 'dark' || isDarkMode ? 'dark' : 'light';
  const [aiConfig, setAiConfig] = useState<AiConfigView>(defaultAiConfig);
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfigView | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<AiConfigView>('ai_get_config')
      .then((config) => {
        if (!cancelled && config && typeof config === 'object') {
          setAiConfig({ ...defaultAiConfig, ...config });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAiConfig(defaultAiConfig);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<WorkspaceConfigView>('workspace_get_config')
      .then((config) => {
        if (cancelled || !config || typeof config !== 'object') return;
        setWorkspaceConfig(config);
        if (config.exportsPath) {
          setDefaultDownloadPath(config.exportsPath);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceConfig(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setDefaultDownloadPath]);

  const applyTheme = (option: ThemeOption) => {
    setWallpaper(option.key);
    setIsDarkMode(option.dark);
    localStorage.setItem('wallpaper', option.key);
    localStorage.setItem('theme', option.dark ? 'dark' : 'light');
  };

  const handleChangeWorkspacePath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: workspaceConfig?.rootPath || defaultDownloadPath || undefined,
      });

      if (selected) {
        const saved = await invoke<WorkspaceConfigView>('workspace_save_config', {
          request: {
            rootPath: selected as string,
          },
        });
        setWorkspaceConfig(saved);
        setDefaultDownloadPath(saved.exportsPath);
        message.success('工作区已更新');
      }
    } catch (error) {
      message.error(`工作区更新失败: ${error}`);
    }
  };

  const handleSaveAiConfig = async () => {
    setAiSaving(true);
    try {
      const saved = await invoke<AiConfigView>('ai_save_config', {
        request: {
          provider: aiConfig.provider,
          baseUrl: aiConfig.baseUrl,
          apiKey: aiApiKey,
          model: aiConfig.model,
          temperature: aiConfig.temperature,
          maxTokens: aiConfig.maxTokens,
          showReasoning: aiConfig.showReasoning,
          toolsEnabled: aiConfig.toolsEnabled,
          maxToolCalls: aiConfig.maxToolCalls,
        },
      });
      setAiConfig({ ...defaultAiConfig, ...saved });
      setAiApiKey('');
      message.success('AI 配置已保存');
    } catch (error) {
      message.error(`保存 AI 配置失败: ${error}`);
    } finally {
      setAiSaving(false);
    }
  };

  const handleTestAiConfig = async () => {
    setAiTesting(true);
    try {
      const result = await invoke<{ success: boolean; message: string }>('ai_test_config', {
        request: {
          provider: aiConfig.provider,
          baseUrl: aiConfig.baseUrl,
          apiKey: aiApiKey,
          model: aiConfig.model,
          temperature: aiConfig.temperature,
          maxTokens: aiConfig.maxTokens,
          showReasoning: aiConfig.showReasoning,
          toolsEnabled: aiConfig.toolsEnabled,
          maxToolCalls: aiConfig.maxToolCalls,
        },
      });
      if (result.success) {
        message.success(result.message);
      } else {
        message.warning(result.message);
      }
    } catch (error) {
      message.error(`AI 配置检测失败: ${error}`);
    } finally {
      setAiTesting(false);
    }
  };

  return (
    <div className="settings-workspace">
      <header className="settings-header compact">
        <div>
          <Text className="settings-eyebrow">设置</Text>
          <Title level={3} className="settings-title">
            工作台设置
          </Title>
        </div>
      </header>

      <div className="settings-shell compact">
        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <Text className="settings-section-kicker">主题</Text>
              <Title level={5}>背景主题</Title>
            </div>
          </div>
          <div className="settings-theme-grid compact">
            {themeOptions.map((option) => (
              <button
                className={`settings-theme-option compact ${activeTheme === option.key ? 'active' : ''}`}
                key={option.key}
                onClick={() => applyTheme(option)}
                type="button"
              >
                <span className="settings-theme-icon">{option.icon}</span>
                <strong>{option.label}</strong>
                {activeTheme === option.key ? <CheckCircleOutlined /> : null}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <Text className="settings-section-kicker">输出</Text>
              <Title level={5}>工作区路径</Title>
            </div>
          </div>
          <div className="settings-output-path settings-workspace-path">
            <div>
              <Text className="settings-muted-label">根目录</Text>
              <strong>{workspaceConfig?.rootPath || '未设置'}</strong>
              <Text className="settings-muted-label">导出路径</Text>
              <strong>{workspaceConfig?.exportsPath || defaultDownloadPath || '未设置'}</strong>
            </div>
            <Button icon={<FolderOpenOutlined />} onClick={handleChangeWorkspacePath} type="primary">
              更改工作区
            </Button>
          </div>
        </section>

        <section className="settings-section settings-ai-panel">
          <div className="settings-section-head settings-ai-head">
            <div>
              <Text className="settings-section-kicker">AI</Text>
              <Title level={5}>AI 配置</Title>
            </div>
            <RobotOutlined className="settings-section-icon" />
          </div>

          <div className="settings-ai-body">
            <div className="settings-ai-form-grid">
              <label className="settings-field">
                <span>Provider</span>
                <Select
                  aria-label="Provider"
                  value={aiConfig.provider}
                  onChange={(provider) => setAiConfig((current) => ({ ...current, provider }))}
                  options={[
                    { value: 'openai-compatible', label: 'OpenAI Compatible' },
                    { value: 'openai', label: 'OpenAI' },
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'deepseek', label: 'DeepSeek / Qwen' },
                  ]}
                />
              </label>
              <label className="settings-field">
                <span>Model</span>
                <Input
                  aria-label="Model"
                  value={aiConfig.model}
                  onChange={(event) => setAiConfig((current) => ({ ...current, model: event.target.value }))}
                  placeholder="gpt-4.1-mini"
                />
              </label>
              <label className="settings-field settings-ai-wide">
                <span>Base URL</span>
                <Input
                  aria-label="Base URL"
                  value={aiConfig.baseUrl}
                  onChange={(event) => setAiConfig((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="settings-field settings-ai-key-field">
                <span>API Key</span>
                <Input.Password
                  aria-label="API Key"
                  value={aiApiKey}
                  onChange={(event) => setAiApiKey(event.target.value)}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData('text');
                    if (pasted) {
                      event.preventDefault();
                      setAiApiKey(pasted.trim());
                    }
                  }}
                  placeholder={aiConfig.hasApiKey ? `已保存 ${aiConfig.apiKeyPreview}` : 'sk-...'}
                />
              </label>
              <label className="settings-field settings-ai-limit-field">
                <span>工具调用上限</span>
                <Input
                  aria-label="工具调用上限"
                  max={50}
                  min={1}
                  type="number"
                  value={aiConfig.maxToolCalls}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10);
                    setAiConfig((current) => ({
                      ...current,
                      maxToolCalls: Number.isFinite(value) ? Math.min(50, Math.max(1, value)) : 1,
                    }));
                  }}
                />
              </label>
            </div>

            <div className="settings-ai-footer">
              <div className="settings-ai-key-state">
                <KeyOutlined />
                <span>{aiConfig.hasApiKey ? `已保存 ${aiConfig.apiKeyPreview}` : '尚未保存 API Key'}</span>
              </div>
              <div className="settings-ai-actions">
                <Button icon={<ExperimentOutlined />} onClick={handleTestAiConfig} loading={aiTesting}>
                  测试连接
                </Button>
                <Button icon={<CloudSyncOutlined />} type="primary" onClick={handleSaveAiConfig} loading={aiSaving}>
                  保存 AI 配置
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <div>
              <Text className="settings-section-kicker">应用</Text>
              <Title level={5}>应用信息</Title>
            </div>
          </div>
          <dl className="settings-info-list compact">
            <div>
              <dt>产品</dt>
              <dd>Lumina Analyzer</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>0.1.0</dd>
            </div>
            <div>
              <dt>内核</dt>
              <dd>Tauri v2</dd>
            </div>
            <div>
              <dt>前端</dt>
              <dd>React + Vite</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
