import { Button, Typography, message } from 'antd';
import type { ReactNode } from 'react';
import {
  CheckCircleOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  MoonOutlined,
  SafetyOutlined,
  SunOutlined,
} from '@ant-design/icons';
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

export default function Settings({
  isDarkMode,
  setIsDarkMode,
  defaultDownloadPath,
  setDefaultDownloadPath,
  wallpaper,
  setWallpaper,
}: SettingsProps) {
  const activeTheme = wallpaper === 'dark' || isDarkMode ? 'dark' : 'light';

  const applyTheme = (option: ThemeOption) => {
    setWallpaper(option.key);
    setIsDarkMode(option.dark);
    localStorage.setItem('wallpaper', option.key);
    localStorage.setItem('theme', option.dark ? 'dark' : 'light');
  };

  const handleChangeDownloadPath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: defaultDownloadPath || undefined,
      });

      if (selected) {
        setDefaultDownloadPath(selected as string);
        message.success('已更新默认下载路径');
      }
    } catch {
      message.error('无法打开目录选择器');
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
              <Title level={5}>导出路径</Title>
            </div>
          </div>
          <div className="settings-output-path">
            <strong>{defaultDownloadPath || '未设置'}</strong>
            <Button icon={<FolderOpenOutlined />} onClick={handleChangeDownloadPath} type="primary">
              更改路径
            </Button>
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
