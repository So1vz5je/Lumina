import { useState, useEffect } from 'react';
import { Card, Table, Typography, Spin, Tabs, Tag, Empty, List, Alert } from 'antd';
import { UserOutlined, HistoryOutlined, KeyOutlined, TeamOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

const { Title, Text } = Typography;

interface UserTraceProps {
    mode: 'local' | 'remote';
    privilegeMode: 'none' | 'sudo' | 'su';
    sudoPassword: string;
    osType: string;
}

interface LoginRecord {
    user: string;
    terminal: string;
    ip: string;
    time: string;
    duration: string;
}

interface CurrentUser {
    user: string;
    terminal: string;
    loginTime: string;
    ip: string;
}

interface SshKey {
    type: string;
    path: string;
    permissions: string;
    status: 'ok' | 'warning' | 'danger';
}

export default function UserTrace({ mode, privilegeMode, sudoPassword, osType }: UserTraceProps) {
    const [loading, setLoading] = useState(true);
    const [loginRecords, setLoginRecords] = useState<LoginRecord[]>([]);
    const [currentUsers, setCurrentUsers] = useState<CurrentUser[]>([]);
    const [historyCommands, setHistoryCommands] = useState<string[]>([]);
    const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
    const [activeTab, setActiveTab] = useState('login');

    useEffect(() => {
        loadData();
    }, [mode, osType]);

    const wrapCommand = (cmd: string): string => {
        if (mode !== 'remote') return cmd;
        switch (privilegeMode) {
            case 'sudo':
                return sudoPassword ? `echo '${sudoPassword}' | sudo -S ${cmd}` : `sudo ${cmd}`;
            case 'su':
                return sudoPassword ? `echo '${sudoPassword}' | su -c '${cmd}'` : `su -c '${cmd}'`;
            default:
                return cmd;
        }
    };

    const executeCommand = async (cmd: string): Promise<string> => {
        if (mode === 'local') {
            // 本地模式暂时返回提示信息
            return '';
        }
        try {
            const result = await invoke<{ stdout: string; stderr: string }>('ssh_execute', { command: wrapCommand(cmd) });
            return result.stdout || result.stderr || '';
        } catch (error) {
            console.error('命令执行失败:', error);
            return '';
        }
    };

    const loadData = async () => {
        setLoading(true);
        try {
            if (mode === 'local') {
                await loadLocalData();
            } else {
                await Promise.all([
                    loadLoginRecords(),
                    loadCurrentUsers(),
                    loadHistoryCommands(),
                    loadSshKeys(),
                ]);
            }
        } finally {
            setLoading(false);
        }
    };

    const loadLocalData = async () => {
        // 本地模式 - 根据操作系统加载不同数据
        if (osType === 'Windows') {
            // Windows: 使用 Rust 后端获取本地数据
            try {
                const info = await invoke<any>('get_local_user_trace');
                if (info) {
                    setLoginRecords(info.login_records || []);
                    setCurrentUsers(info.current_users || []);
                    setHistoryCommands(info.history_commands || []);
                }
            } catch (error) {
                // 如果后端还没实现，显示示例数据
                setLoginRecords([
                    { user: '(需要后端实现)', terminal: '-', ip: '-', time: '-', duration: '-' }
                ]);
                setHistoryCommands(['本地Windows用户痕迹分析功能开发中...']);
            }
        } else {
            // Linux 本地模式
            setHistoryCommands(['本地Linux分析功能开发中...']);
        }
    };

    const loadLoginRecords = async () => {
        const output = await executeCommand('last -n 30 2>/dev/null | head -25');
        const records: LoginRecord[] = [];

        const lines = output.split('\n').filter(line => line.trim() && !line.startsWith('wtmp'));
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                records.push({
                    user: parts[0],
                    terminal: parts[1],
                    ip: parts[2]?.match(/^\d/) ? parts[2] : '-',
                    time: parts.slice(3, 7).join(' '),
                    duration: parts.find(p => p.includes(':') && p.includes('-')) || parts[parts.length - 1] || '-',
                });
            }
        }
        setLoginRecords(records.slice(0, 20));
    };

    const loadCurrentUsers = async () => {
        const output = await executeCommand('who 2>/dev/null');
        const users: CurrentUser[] = [];

        const lines = output.split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 3) {
                users.push({
                    user: parts[0],
                    terminal: parts[1],
                    loginTime: parts.slice(2, 4).join(' '),
                    ip: parts[4]?.replace(/[()]/g, '') || '-',
                });
            }
        }
        setCurrentUsers(users);
    };

    const loadHistoryCommands = async () => {
        // 尝试多种方式获取历史命令，支持 bash 和 zsh
        const output = await executeCommand(
            'cat $HOME/.bash_history $HOME/.zsh_history /root/.bash_history /root/.zsh_history 2>/dev/null | tail -100'
        );
        const commands = output.split('\n').filter(cmd => cmd.trim() && !cmd.startsWith(':')).reverse();
        setHistoryCommands(commands.slice(0, 50));
    };

    const loadSshKeys = async () => {
        const output = await executeCommand('ls -la ~/.ssh/ 2>/dev/null');
        const keys: SshKey[] = [];

        const lines = output.split('\n').filter(line => line.trim() && !line.startsWith('total'));
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 9) {
                const filename = parts[8];
                if (filename === '.' || filename === '..') continue;

                const permissions = parts[0];
                let status: 'ok' | 'warning' | 'danger' = 'ok';

                if (permissions.includes('r') && (permissions[7] !== '-' || permissions[8] !== '-')) {
                    status = 'warning';
                }
                if (filename === 'authorized_keys') {
                    status = 'danger';
                }

                keys.push({
                    type: filename.includes('pub') ? '公钥' : filename === 'authorized_keys' ? '授权密钥' : '私钥',
                    path: `~/.ssh/${filename}`,
                    permissions,
                    status,
                });
            }
        }
        setSshKeys(keys);
    };

    const loginColumns = [
        { title: '用户', dataIndex: 'user', key: 'user', width: 100 },
        { title: '终端', dataIndex: 'terminal', key: 'terminal', width: 80 },
        { title: 'IP地址', dataIndex: 'ip', key: 'ip', width: 120 },
        { title: '登录时间', dataIndex: 'time', key: 'time' },
        { title: '时长', dataIndex: 'duration', key: 'duration', width: 100 },
    ];

    const currentUserColumns = [
        { title: '用户', dataIndex: 'user', key: 'user' },
        { title: '终端', dataIndex: 'terminal', key: 'terminal' },
        { title: '登录时间', dataIndex: 'loginTime', key: 'loginTime' },
        { title: 'IP地址', dataIndex: 'ip', key: 'ip' },
    ];

    const sshKeyColumns = [
        { title: '类型', dataIndex: 'type', key: 'type', width: 100 },
        { title: '路径', dataIndex: 'path', key: 'path' },
        { title: '权限', dataIndex: 'permissions', key: 'permissions', width: 120 },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 80,
            render: (status: string) => (
                <Tag color={status === 'ok' ? 'green' : status === 'warning' ? 'orange' : 'red'}>
                    {status === 'ok' ? '正常' : status === 'warning' ? '注意' : '检查'}
                </Tag>
            )
        },
    ];

    if (loading) {
        return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}><Spin size="large" /></div>;
    }

    // 本地Windows模式的特殊提示
    if (mode === 'local' && osType === 'Windows') {
        return (
            <div className="fade-in">
                <Alert
                    message="Windows 本地分析"
                    description="Windows 用户痕迹分析功能正在开发中，将支持：事件日志查看、登录记录、PowerShell历史命令等。"
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                />
                <Card>
                    <Empty description="Windows 本地用户痕迹分析功能开发中..." />
                </Card>
            </div>
        );
    }

    const tabItems = [
        {
            key: 'login',
            label: <span><HistoryOutlined /> 登录记录</span>,
            children: (
                <Card>
                    {loginRecords.length > 0 ? (
                        <Table
                            dataSource={loginRecords}
                            columns={loginColumns}
                            rowKey={(_, i) => `login-${i}`}
                            size="small"
                            pagination={{ pageSize: 10 }}
                        />
                    ) : (
                        <Empty description="无登录记录" />
                    )}
                </Card>
            ),
        },
        {
            key: 'current',
            label: <span><TeamOutlined /> 当前在线</span>,
            children: (
                <Card>
                    {currentUsers.length > 0 ? (
                        <Table
                            dataSource={currentUsers}
                            columns={currentUserColumns}
                            rowKey={(_, i) => `current-${i}`}
                            size="small"
                            pagination={false}
                        />
                    ) : (
                        <Empty description="无在线用户" />
                    )}
                </Card>
            ),
        },
        {
            key: 'history',
            label: <span><UserOutlined /> 历史命令</span>,
            children: (
                <Card>
                    {historyCommands.length > 0 ? (
                        <List
                            size="small"
                            dataSource={historyCommands}
                            renderItem={(cmd) => (
                                <List.Item style={{ padding: '4px 0' }}>
                                    <Text code style={{ fontSize: 12 }}>{cmd}</Text>
                                </List.Item>
                            )}
                            style={{ maxHeight: 400, overflow: 'auto' }}
                        />
                    ) : (
                        <Empty description="无历史命令记录" />
                    )}
                </Card>
            ),
        },
        {
            key: 'ssh',
            label: <span><KeyOutlined /> SSH密钥</span>,
            children: (
                <Card>
                    {sshKeys.some(k => k.status === 'danger') && (
                        <Alert
                            message="发现 authorized_keys 文件"
                            description="该文件包含授权的SSH公钥，可能存在后门风险，请检查。"
                            type="warning"
                            showIcon
                            style={{ marginBottom: 16 }}
                        />
                    )}
                    {sshKeys.length > 0 ? (
                        <Table
                            dataSource={sshKeys}
                            columns={sshKeyColumns}
                            rowKey="path"
                            size="small"
                            pagination={false}
                        />
                    ) : (
                        <Empty description="无SSH密钥文件" />
                    )}
                </Card>
            ),
        },
    ];

    return (
        <div className="fade-in">
            <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
        </div>
    );
}
