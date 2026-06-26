import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('Settings authorization UI', () => {
  const props = {
    isDarkMode: false,
    setIsDarkMode: vi.fn(),
    defaultDownloadPath: '',
    setDefaultDownloadPath: vi.fn(),
    onBackToSelect: vi.fn(),
    wallpaper: '/wallpaper.mp4',
    setWallpaper: vi.fn(),
    glassEnabled: false,
    setGlassEnabled: vi.fn(),
    wallpaperOpacity: 0.3,
    setWallpaperOpacity: vi.fn(),
  };

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'ai_get_config') {
        return {
          provider: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyPreview: '',
          hasApiKey: false,
          model: 'qwen-plus',
          temperature: 0.2,
          maxTokens: 2048,
          showReasoning: true,
          toolsEnabled: true,
          maxToolCalls: 12,
        };
      }
      if (command === 'ai_save_config') {
        return {
          provider: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKeyPreview: 'sk-t******-key',
          hasApiKey: true,
          model: 'qwen-plus',
          temperature: 0.2,
          maxTokens: 2048,
          showReasoning: true,
          toolsEnabled: true,
          maxToolCalls: 16,
        };
      }
      if (command === 'ai_test_config') {
        return {
          success: true,
          message: '模型连接成功',
        };
      }
      if (command === 'workspace_get_config') {
        return {
          rootPath: 'C:\\IR\\host-a',
          exportsPath: 'C:\\IR\\host-a\\exports',
          aiLogsPath: 'C:\\IR\\host-a\\ai_logs',
          collectionsPath: 'C:\\IR\\host-a\\collections',
          tempPath: 'C:\\IR\\host-a\\temp',
          adminRunsPath: 'C:\\IR\\host-a\\admin_runs',
        };
      }
      if (command === 'workspace_save_config') {
        return {
          rootPath: 'D:\\IR\\host-b',
          exportsPath: 'D:\\IR\\host-b\\exports',
          aiLogsPath: 'D:\\IR\\host-b\\ai_logs',
          collectionsPath: 'D:\\IR\\host-b\\collections',
          tempPath: 'D:\\IR\\host-b\\temp',
          adminRunsPath: 'D:\\IR\\host-b\\admin_runs',
        };
      }
      return {};
    });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('does not show authorization controls', () => {
    const { container } = render(<Settings {...props} />);

    expect(container.querySelector('.settings-workspace')).toBeInTheDocument();
    expect(container.querySelector('.settings-shell')).toBeInTheDocument();
    expect(container.querySelector('.ant-card')).not.toBeInTheDocument();
    expect(screen.queryByText(/授权|激活|机器码|许可证/)).not.toBeInTheDocument();
  });

  it('renders only theme, export path, and app information settings', () => {
    render(<Settings {...props} />);

    expect(screen.getByText('设置')).toBeInTheDocument();
    expect(screen.getByText('背景主题')).toBeInTheDocument();
    expect(screen.getByText('浅色')).toBeInTheDocument();
    expect(screen.getByText('暗色')).toBeInTheDocument();
    expect(screen.getByText('导出路径')).toBeInTheDocument();
    expect(screen.getByText('AI 配置')).toBeInTheDocument();
    expect(screen.getByText('应用信息')).toBeInTheDocument();
    expect(screen.queryByText('模型连接')).not.toBeInTheDocument();
    expect(screen.queryByText('显示思考过程')).not.toBeInTheDocument();
    expect(screen.queryByText('启用工具调用')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /粘贴/ })).not.toBeInTheDocument();
    expect(screen.queryByText('柔和')).not.toBeInTheDocument();
    expect(screen.queryByText('透明效果')).not.toBeInTheDocument();
    expect(screen.queryByText('背景文件')).not.toBeInTheDocument();
    expect(screen.queryByText('背景透明度')).not.toBeInTheDocument();
  });

  it('loads the machine workspace and uses its exports path for downloads', async () => {
    const setDefaultDownloadPath = vi.fn();
    render(<Settings {...props} setDefaultDownloadPath={setDefaultDownloadPath} />);

    expect(await screen.findByText('C:\\IR\\host-a')).toBeInTheDocument();
    expect(screen.getByText('C:\\IR\\host-a\\exports')).toBeInTheDocument();
    expect(setDefaultDownloadPath).toHaveBeenCalledWith('C:\\IR\\host-a\\exports');
  });

  it('saves a selected workspace root through the backend', async () => {
    vi.mocked(open).mockResolvedValue('D:\\IR\\host-b');
    const setDefaultDownloadPath = vi.fn();
    render(<Settings {...props} setDefaultDownloadPath={setDefaultDownloadPath} />);

    fireEvent.click(await screen.findByRole('button', { name: /更改工作区/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('workspace_save_config', {
        request: { rootPath: 'D:\\IR\\host-b' },
      });
    });
    expect(await screen.findByText('D:\\IR\\host-b')).toBeInTheDocument();
    expect(setDefaultDownloadPath).toHaveBeenCalledWith('D:\\IR\\host-b\\exports');
  });

  it('saves AI provider settings from the settings page', async () => {
    render(<Settings {...props} />);

    fireEvent.change(await screen.findByLabelText('Base URL'), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'sk-test-key' },
    });
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'qwen-plus' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存 AI 配置/ }));

    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', {
      request: expect.objectContaining({
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test-key',
        model: 'qwen-plus',
      }),
    });
  });

  it('saves the configured AI tool call limit', async () => {
    render(<Settings {...props} />);

    fireEvent.change(await screen.findByLabelText('工具调用上限'), {
      target: { value: '24' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存 AI 配置/ }));

    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', {
      request: expect.objectContaining({
        maxToolCalls: 24,
      }),
    });
  });

  it('runs the backend model test request from the settings page', async () => {
    render(<Settings {...props} />);

    fireEvent.change(await screen.findByLabelText('Base URL'), {
      target: { value: 'https://api.current-form.test/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'sk-current-form-key' },
    });
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'qwen-current' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /测试连接/ }));

    expect(invokeMock).toHaveBeenCalledWith('ai_test_config', {
      request: expect.objectContaining({
        provider: 'openai-compatible',
        baseUrl: 'https://api.current-form.test/v1',
        apiKey: 'sk-current-form-key',
        model: 'qwen-current',
      }),
    });
  });

  it('applies the dark preset to both wallpaper and app theme', () => {
    const setIsDarkMode = vi.fn();
    const setWallpaper = vi.fn();

    render(<Settings {...props} setIsDarkMode={setIsDarkMode} setWallpaper={setWallpaper} />);

    fireEvent.click(screen.getByText('暗色'));

    expect(setWallpaper).toHaveBeenCalledWith('dark');
    expect(setIsDarkMode).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('wallpaper')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('applies the light preset to both wallpaper and app theme', () => {
    const setIsDarkMode = vi.fn();
    const setWallpaper = vi.fn();

    render(
      <Settings
        {...props}
        isDarkMode
        setIsDarkMode={setIsDarkMode}
        setWallpaper={setWallpaper}
        wallpaper="dark"
      />,
    );

    fireEvent.click(screen.getByText('浅色'));

    expect(setWallpaper).toHaveBeenCalledWith('light');
    expect(setIsDarkMode).toHaveBeenCalledWith(false);
    expect(localStorage.getItem('wallpaper')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
