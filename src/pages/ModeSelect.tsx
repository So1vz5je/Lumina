import {
  CheckCircleOutlined,
  CloudOutlined,
  LaptopOutlined,
  LoadingOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  Progress,
  Radio,
  Row,
  Space,
  Steps,
  Typography,
  message,
} from 'antd';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ConnectionSidebar } from '../components/remote/ConnectionSidebar';
import { useRemoteWorkspace } from '../modules/remote/RemoteWorkspaceProvider';
import {
  loadSavedConnections,
  saveSavedConnections,
  type SavedConnection,
} from '../modules/remote/savedConnections';
import type { RemoteConnectionRecord } from '../modules/remote/types';

const { Paragraph, Text, Title } = Typography;

interface ModeSelectProps {
  onLocalMode: () => void;
  onRemoteConnected: (
    osType: string,
    privilegeMode: string,
    sudoPassword: string,
  ) => void;
  isDarkMode: boolean;
  glassEnabled: boolean;
  wallpaper: string;
}

type StepState =
  | 'select'
  | 'connections'
  | 'edit'
  | 'privilege'
  | 'connecting';
type PrivilegeMode = 'none' | 'sudo' | 'su';

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isPresetTheme(wallpaper: string) {
  return wallpaper === 'light' || wallpaper === 'dark' || wallpaper === 'pink';
}

function isVideoWallpaper(wallpaper: string) {
  return (
    wallpaper.endsWith('.mp4') ||
    wallpaper.endsWith('.webm') ||
    wallpaper.endsWith('.mov')
  );
}

function buildBackground(
  wallpaper: string,
  isDarkMode: boolean,
): CSSProperties {
  if (!wallpaper) {
    return {
      background: isDarkMode
        ? 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)'
        : 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #6B8DD6 100%)',
    };
  }

  if (wallpaper === 'light') {
    return {
      background: 'linear-gradient(135deg, #e6f7ff 0%, #f0f5ff 50%, #bae7ff 100%)',
    };
  }

  if (wallpaper === 'dark') {
    return {
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    };
  }

  if (wallpaper === 'pink') {
    return {
      background: 'linear-gradient(135deg, #ffc0e3 0%, #ffe0f0 50%, #ffd6e7 100%)',
    };
  }

  return {
    backgroundImage: `url(${wallpaper})`,
    backgroundPosition: 'center',
    backgroundSize: 'cover',
  };
}

function BackgroundLayer({
  wallpaper,
  isDarkMode,
}: {
  wallpaper: string;
  isDarkMode: boolean;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {wallpaper && !isPresetTheme(wallpaper) && isVideoWallpaper(wallpaper) ? (
        <video
          autoPlay
          loop
          muted
          playsInline
          src={wallpaper}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            ...buildBackground(wallpaper, isDarkMode),
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          background: isDarkMode
            ? 'rgba(0, 0, 0, 0.32)'
            : 'rgba(255, 255, 255, 0.12)',
        }}
      />
    </div>
  );
}

function Screen({
  children,
  wallpaper,
  isDarkMode,
}: {
  children: ReactNode;
  wallpaper: string;
  isDarkMode: boolean;
}) {
  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        position: 'relative',
      }}
    >
      <BackgroundLayer isDarkMode={isDarkMode} wallpaper={wallpaper} />
      {children}
    </div>
  );
}

function panelStyle(
  isDarkMode: boolean,
  glassEnabled: boolean,
  width: number,
  maxHeight?: string,
): CSSProperties {
  return {
    width,
    maxHeight,
    overflow: maxHeight ? 'auto' : undefined,
    borderRadius: 16,
    position: 'relative',
    zIndex: 1,
    background: glassEnabled
      ? isDarkMode
        ? 'rgba(31, 31, 31, 0.62)'
        : 'rgba(255, 255, 255, 0.68)'
      : isDarkMode
        ? '#1f1f1f'
        : '#ffffff',
    boxShadow: isDarkMode
      ? '0 18px 48px rgba(0, 0, 0, 0.28)'
      : '0 18px 48px rgba(15, 23, 42, 0.12)',
  };
}

export default function ModeSelect({
  onLocalMode,
  onRemoteConnected,
  isDarkMode,
  glassEnabled,
  wallpaper,
}: ModeSelectProps) {
  const { dispatch } = useRemoteWorkspace();
  const [step, setStep] = useState<StepState>('select');
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(
    null,
  );
  const [editingConnection, setEditingConnection] =
    useState<SavedConnection | null>(null);
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [detectedOs, setDetectedOs] = useState('Unknown');
  const [username, setUsername] = useState('');
  const [privilegeMode, setPrivilegeMode] = useState<PrivilegeMode>('none');
  const [sudoPassword, setSudoPassword] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [connectingStep, setConnectingStep] = useState(0);
  const [connectingHost, setConnectingHost] = useState('');
  const [form] = Form.useForm();

  useEffect(() => {
    setSavedConnections(loadSavedConnections());
  }, []);

  const persistConnections = (connections: SavedConnection[]) => {
    saveSavedConnections(connections);
    setSavedConnections(connections);
  };

  const handleAddConnection = () => {
    setEditingConnection(null);
    setAuthType('password');
    form.resetFields();
    form.setFieldsValue({ port: '22' });
    setStep('edit');
  };

  const handleEditConnection = (connection: SavedConnection) => {
    setEditingConnection(connection);
    setAuthType(connection.authType);
    form.setFieldsValue({
      name: connection.name,
      host: connection.host,
      port: connection.port.toString(),
      username: connection.username,
      password: connection.password,
      keyPath: connection.keyPath,
      passphrase: connection.passphrase,
    });
    setStep('edit');
  };

  const handleDeleteConnection = (connectionId: string) => {
    const nextConnections = savedConnections.filter(
      (connection) => connection.id !== connectionId,
    );

    persistConnections(nextConnections);
    setSelectedConnectionId((currentId) =>
      currentId === connectionId ? null : currentId,
    );
    message.success('连接已删除');
  };

  const handleSaveConnection = (values: {
    host: string;
    keyPath?: string;
    name?: string;
    passphrase?: string;
    password?: string;
    port?: string;
    username: string;
  }) => {
    const nextConnection: SavedConnection = {
      id: editingConnection?.id ?? Date.now().toString(),
      name: values.name?.trim() || `${values.host}:${values.port || '22'}`,
      host: values.host.trim(),
      port: Number.parseInt(values.port || '22', 10) || 22,
      username: values.username.trim(),
      authType,
      password: authType === 'password' ? values.password : undefined,
      keyPath: authType === 'key' ? values.keyPath : undefined,
      passphrase: authType === 'key' ? values.passphrase : undefined,
    };

    const nextConnections = editingConnection
      ? savedConnections.map((connection) =>
          connection.id === nextConnection.id ? nextConnection : connection,
        )
      : [...savedConnections, nextConnection];

    persistConnections(nextConnections);
    setSelectedConnectionId(nextConnection.id);
    message.success(editingConnection ? '连接已更新' : '连接已保存');
    setStep('connections');
  };

  const handleQuickConnect = async (connection: SavedConnection) => {
    setConnectingHost(connection.host);
    setConnectingStep(0);
    setSelectedConnectionId(connection.id);
    setUsername(connection.username);
    setSshPassword(connection.password ?? '');
    setStep('connecting');

    try {
      setConnectingStep(1);
      await delay(250);

      setConnectingStep(2);
      const record = await invoke<RemoteConnectionRecord>('remote_connect', {
        request: {
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          password: connection.password ?? null,
          privateKeyPath: connection.keyPath ?? null,
          passphrase: connection.passphrase ?? null,
        },
      });

      dispatch({ type: 'connection/connected', payload: record });

      setConnectingStep(3);
      await delay(180);

      const osType = record.osType ?? 'Unknown';
      setDetectedOs(osType);
      setConnectingStep(4);
      await delay(320);

      if (osType.toLowerCase().includes('linux') && connection.username !== 'root') {
        setPrivilegeMode('none');
        setSudoPassword('');
        setStep('privilege');
        return;
      }

      onRemoteConnected(osType, 'none', '');
    } catch (error) {
      message.error(`连接失败: ${String(error)}`);
      setStep('connections');
    }
  };

  const handlePrivilegeConfirm = () => {
    const password =
      privilegeMode === 'sudo'
        ? sshPassword
        : privilegeMode === 'su'
          ? sudoPassword
          : '';

    onRemoteConnected(detectedOs, privilegeMode, password);
  };

  if (step === 'connecting') {
    const steps = [
      { title: '准备连接', description: '初始化远程会话' },
      { title: '建立连接', description: `连接 ${connectingHost}` },
      { title: '验证凭据', description: '向远端提交认证信息' },
      { title: '识别系统', description: '同步主机元数据' },
      { title: '进入工作区', description: '准备加载远程工作台' },
    ];

    return (
      <Screen isDarkMode={isDarkMode} wallpaper={wallpaper}>
        <Card
          className={glassEnabled ? 'glass-card' : 'scale-in'}
          style={panelStyle(isDarkMode, glassEnabled, 520)}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #1890ff, #52c41a)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}
          >
            {connectingStep < 4 ? (
              <LoadingOutlined spin style={{ color: '#fff', fontSize: 34 }} />
            ) : (
              <CheckCircleOutlined style={{ color: '#fff', fontSize: 34 }} />
            )}
          </div>

          <Title level={4} style={{ textAlign: 'center', marginBottom: 8 }}>
            {connectingStep < 4 ? '正在连接远程主机' : '连接成功'}
          </Title>
          <Text
            style={{ display: 'block', textAlign: 'center', marginBottom: 24 }}
            type="secondary"
          >
            {connectingHost}
          </Text>

          <Progress
            percent={(connectingStep / 4) * 100}
            showInfo={false}
            status={connectingStep < 4 ? 'active' : 'success'}
            strokeColor={{ '0%': '#1890ff', '100%': '#52c41a' }}
            style={{ marginBottom: 24 }}
          />

          <Steps
            current={connectingStep}
            direction="vertical"
            items={steps.map((item, index) => ({
              ...item,
              status:
                index < connectingStep
                  ? 'finish'
                  : index === connectingStep
                    ? 'process'
                    : 'wait',
            }))}
            size="small"
          />

          {connectingStep < 4 ? (
            <Button
              block
              onClick={() => setStep('connections')}
              style={{ marginTop: 20 }}
              type="text"
            >
              取消并返回连接列表
            </Button>
          ) : null}
        </Card>
      </Screen>
    );
  }

  if (step === 'connections') {
    return (
      <Screen isDarkMode={isDarkMode} wallpaper={wallpaper}>
        <Card
          className={glassEnabled ? 'glass-card' : 'scale-in'}
          style={panelStyle(isDarkMode, glassEnabled, 580, '82vh')}
        >
          <Title level={4} style={{ marginTop: 0, marginBottom: 8 }}>
            远程连接管理
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 20 }}>
            复用保存的 SSH 定义，直接接入新的 Remote Workspace。
          </Paragraph>

          <ConnectionSidebar
            activeConnectionId={selectedConnectionId}
            connections={savedConnections}
            connectLabel="连接"
            description="可直接连接、编辑凭据或删除历史定义。"
            emptyDescription="暂无已保存连接"
            onActivate={setSelectedConnectionId}
            onConnect={handleQuickConnect}
            onCreate={handleAddConnection}
            onDelete={handleDeleteConnection}
            onEdit={handleEditConnection}
            title="Saved Connections"
          />

          <Button
            block
            onClick={() => setStep('select')}
            style={{ marginTop: 20 }}
            type="text"
          >
            返回模式选择
          </Button>
        </Card>
      </Screen>
    );
  }

  if (step === 'edit') {
    return (
      <Screen isDarkMode={isDarkMode} wallpaper={wallpaper}>
        <Card
          className={glassEnabled ? 'glass-card' : 'scale-in'}
          style={panelStyle(isDarkMode, glassEnabled, 460)}
        >
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <CloudOutlined style={{ color: '#1890ff', fontSize: 48 }} />
            <Title level={4} style={{ marginBottom: 4, marginTop: 12 }}>
              {editingConnection ? '编辑连接' : '新建连接'}
            </Title>
            <Text type="secondary">保存后可在工作区和入口页复用</Text>
          </div>

          <Form form={form} layout="vertical" onFinish={handleSaveConnection}>
            <Form.Item label="连接名称" name="name">
              <Input placeholder="例如：生产 Linux 主机" />
            </Form.Item>

            <Form.Item
              label="主机地址"
              name="host"
              rules={[{ required: true, message: '请输入主机地址' }]}
            >
              <Input placeholder="192.168.1.100 或 example.com" />
            </Form.Item>

            <Form.Item label="端口" name="port" initialValue="22">
              <Input placeholder="22" />
            </Form.Item>

            <Form.Item
              label="用户名"
              name="username"
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input placeholder="root" />
            </Form.Item>

            <Form.Item label="认证方式">
              <Radio.Group
                onChange={(event) => setAuthType(event.target.value)}
                value={authType}
              >
                <Radio value="password">密码</Radio>
                <Radio value="key">私钥</Radio>
              </Radio.Group>
            </Form.Item>

            {authType === 'password' ? (
              <Form.Item
                label="密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password placeholder="请输入 SSH 密码" />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  label="私钥路径"
                  name="keyPath"
                  rules={[{ required: true, message: '请输入私钥路径' }]}
                >
                  <Input placeholder="C:\\Users\\you\\.ssh\\id_rsa" />
                </Form.Item>
                <Form.Item label="私钥口令" name="passphrase">
                  <Input.Password placeholder="可选" />
                </Form.Item>
              </>
            )}

            <Form.Item style={{ marginBottom: 0 }}>
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <Button block htmlType="submit" size="large" type="primary">
                  保存连接
                </Button>
                <Button block onClick={() => setStep('connections')} type="text">
                  取消
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>
      </Screen>
    );
  }

  if (step === 'privilege') {
    return (
      <Screen isDarkMode={isDarkMode} wallpaper={wallpaper}>
        <Card
          className={glassEnabled ? 'glass-card' : 'scale-in'}
          style={panelStyle(isDarkMode, glassEnabled, 460)}
        >
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 48 }} />
            <Title level={4} style={{ marginBottom: 4, marginTop: 12 }}>
              连接成功
            </Title>
            <Text type="secondary">检测到系统: {detectedOs}</Text>
          </div>

          <div
            style={{
              background: isDarkMode ? 'rgba(255, 197, 61, 0.1)' : '#fffbe6',
              border: `1px solid ${isDarkMode ? 'rgba(255, 197, 61, 0.3)' : '#ffe58f'}`,
              borderRadius: 10,
              padding: 16,
              marginBottom: 24,
            }}
          >
            <Text>
              当前用户 <Text strong>{username}</Text> 不是 root。选择提权方式后再进入分析流程。
            </Text>
          </div>

          <Form layout="vertical">
            <Form.Item label="提权方式">
              <Radio.Group
                onChange={(event) => setPrivilegeMode(event.target.value)}
                value={privilegeMode}
              >
                <Space orientation="vertical" size={10}>
                  <Radio value="none">不提权，直接进入</Radio>
                  <Radio value="sudo">使用 sudo（复用当前登录密码）</Radio>
                  <Radio value="su">切换 root（单独输入 root 密码）</Radio>
                </Space>
              </Radio.Group>
            </Form.Item>

            {privilegeMode === 'su' ? (
              <Form.Item label="root 密码">
                <Input.Password
                  onChange={(event) => setSudoPassword(event.target.value)}
                  placeholder="请输入 root 密码"
                  value={sudoPassword}
                />
              </Form.Item>
            ) : null}

            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Button block onClick={handlePrivilegeConfirm} size="large" type="primary">
                进入分析工作区
              </Button>
              <Button block onClick={() => setStep('connections')} type="text">
                返回连接列表
              </Button>
            </Space>
          </Form>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen isDarkMode={isDarkMode} wallpaper={wallpaper}>
      <div className="scale-in" style={{ maxWidth: 860, textAlign: 'center', zIndex: 1 }}>
        <SafetyOutlined style={{ color: '#fff', fontSize: 64, marginBottom: 16 }} />
        <Title level={2} style={{ color: '#fff', marginBottom: 8 }}>
          Lumina 应急响应分析工具
        </Title>
        <Paragraph
          style={{
            color: 'rgba(255,255,255,0.82)',
            fontSize: 16,
            marginBottom: 40,
          }}
        >
          选择分析模式，然后进入本地检查或新的远程工作区。
        </Paragraph>

        <Row gutter={24} justify="center">
          <Col>
            <Card
              className={glassEnabled ? 'glass-card' : 'hover-card'}
              onClick={onLocalMode}
              style={{
                ...panelStyle(isDarkMode, glassEnabled, 280),
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              <LaptopOutlined style={{ color: '#1890ff', fontSize: 48, marginBottom: 16 }} />
              <Title level={4}>本地分析</Title>
              <Text type="secondary">直接分析当前运行中的主机环境</Text>
            </Card>
          </Col>

          <Col>
            <Card
              className={glassEnabled ? 'glass-card' : 'hover-card'}
              onClick={() => setStep('connections')}
              style={{
                ...panelStyle(isDarkMode, glassEnabled, 280),
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              <CloudOutlined style={{ color: '#52c41a', fontSize: 48, marginBottom: 16 }} />
              <Title level={4}>远程分析</Title>
              <Text type="secondary">通过保存的 SSH 定义进入新的 Remote Workspace</Text>
            </Card>
          </Col>
        </Row>
      </div>
    </Screen>
  );
}
