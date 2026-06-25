import { useState } from 'react';
import { Card, Form, Input, Button, Radio, Typography, Alert, Space, message } from 'antd';
import { LinkOutlined, DisconnectOutlined, SendOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface SshConnectionResult {
    success: boolean;
    message: string;
    os_type: string | null;
}

interface CommandResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exit_code: number;
}

export default function Terminal() {
    const [form] = Form.useForm();
    const [authType, setAuthType] = useState<'password' | 'key'>('password');
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [osType, setOsType] = useState<string | null>(null);
    const [command, setCommand] = useState('');
    const [output, setOutput] = useState<string[]>([]);
    const [executing, setExecuting] = useState(false);

    const handleConnect = async (values: any) => {
        setConnecting(true);
        try {
            const request = {
                host: values.host,
                port: parseInt(values.port) || 22,
                username: values.username,
                password: authType === 'password' ? values.password : null,
                private_key_path: authType === 'key' ? values.keyPath : null,
                passphrase: authType === 'key' ? values.passphrase : null,
            };

            const result = await invoke<SshConnectionResult>('ssh_connect', { request });

            if (result.success) {
                setConnected(true);
                setOsType(result.os_type);
                message.success(`连接成功！检测到系统: ${result.os_type || '未知'}`);
                setOutput([`已连接到 ${values.username}@${values.host}:${values.port}`]);
            } else {
                message.error(result.message);
            }
        } catch (error) {
            message.error(`连接失败: ${error}`);
        } finally {
            setConnecting(false);
        }
    };

    const handleDisconnect = async () => {
        await invoke('ssh_disconnect');
        setConnected(false);
        setOsType(null);
        setOutput([]);
        message.info('已断开连接');
    };

    const handleExecute = async () => {
        if (!command.trim()) return;

        setExecuting(true);
        setOutput(prev => [...prev, `$ ${command}`]);

        try {
            const result = await invoke<CommandResult>('ssh_execute', { command });

            if (result.stdout) {
                setOutput(prev => [...prev, result.stdout]);
            }
            if (result.stderr) {
                setOutput(prev => [...prev, `[stderr] ${result.stderr}`]);
            }
            if (!result.success) {
                setOutput(prev => [...prev, `[exit code: ${result.exit_code}]`]);
            }
        } catch (error) {
            setOutput(prev => [...prev, `[error] ${error}`]);
        } finally {
            setCommand('');
            setExecuting(false);
        }
    };

    if (connected) {
        return (
            <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <Title level={4} style={{ margin: 0 }}>远程终端</Title>
                    <Space>
                        <Text type="success">已连接 ({osType || '未知系统'})</Text>
                        <Button danger icon={<DisconnectOutlined />} onClick={handleDisconnect}>断开</Button>
                    </Space>
                </div>

                <Card
                    style={{
                        background: '#1e1e1e',
                        marginBottom: 16,
                        maxHeight: 400,
                        overflow: 'auto',
                    }}
                >
                    <pre style={{
                        color: '#d4d4d4',
                        margin: 0,
                        fontFamily: 'Consolas, Monaco, monospace',
                        fontSize: 13,
                        whiteSpace: 'pre-wrap',
                    }}>
                        {output.join('\n') || '等待命令...'}
                    </pre>
                </Card>

                <Space.Compact style={{ width: '100%' }}>
                    <Input
                        placeholder="输入命令..."
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        onPressEnter={handleExecute}
                        disabled={executing}
                        style={{ fontFamily: 'Consolas, Monaco, monospace' }}
                    />
                    <Button
                        type="primary"
                        icon={<SendOutlined />}
                        onClick={handleExecute}
                        loading={executing}
                    >
                        执行
                    </Button>
                </Space.Compact>
            </div>
        );
    }

    return (
        <div>
            <Title level={4}>远程终端</Title>

            <Card style={{ maxWidth: 500 }}>
                <Form form={form} layout="vertical" onFinish={handleConnect}>
                    <Form.Item label="主机地址" name="host" rules={[{ required: true }]}>
                        <Input placeholder="192.168.1.100" />
                    </Form.Item>

                    <Form.Item label="端口" name="port" initialValue="22">
                        <Input placeholder="22" />
                    </Form.Item>

                    <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
                        <Input placeholder="root" />
                    </Form.Item>

                    <Form.Item label="认证方式">
                        <Radio.Group value={authType} onChange={(e) => setAuthType(e.target.value)}>
                            <Radio value="password">密码</Radio>
                            <Radio value="key">私钥</Radio>
                        </Radio.Group>
                    </Form.Item>

                    {authType === 'password' ? (
                        <Form.Item label="密码" name="password" rules={[{ required: true }]}>
                            <Input.Password placeholder="输入密码" />
                        </Form.Item>
                    ) : (
                        <>
                            <Form.Item label="私钥路径" name="keyPath" rules={[{ required: true }]}>
                                <Input placeholder="C:\Users\xxx\.ssh\id_rsa" />
                            </Form.Item>
                            <Form.Item label="私钥密码 (可选)" name="passphrase">
                                <Input.Password placeholder="私钥密码" />
                            </Form.Item>
                        </>
                    )}

                    <Form.Item>
                        <Button
                            type="primary"
                            htmlType="submit"
                            icon={<LinkOutlined />}
                            loading={connecting}
                            block
                        >
                            连接
                        </Button>
                    </Form.Item>
                </Form>
            </Card>
        </div>
    );
}
