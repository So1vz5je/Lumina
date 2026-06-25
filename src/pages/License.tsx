import { useState, useEffect } from 'react';
import { Card, Input, Button, Typography, Space, message, Descriptions, Tag, Alert, Divider, Row, Col } from 'antd';
import { KeyOutlined, CopyOutlined, CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface MachineInfo {
    machine_id: string;
    cpu_id: string;
    mac_address: string;
    hostname: string;
}

interface LicenseInfo {
    machine_id: string;
    expire_date: string | null;
    features: string[];
    user_name: string | null;
}

interface LicenseResult {
    valid: boolean;
    message: string;
    info: LicenseInfo | null;
}

interface LicenseProps {
    onActivated?: () => void;
    isDarkMode: boolean;
    glassEnabled: boolean;
}

export default function License({ onActivated, isDarkMode, glassEnabled }: LicenseProps) {
    const [machineInfo, setMachineInfo] = useState<MachineInfo | null>(null);
    const [licenseKey, setLicenseKey] = useState('');
    const [licenseResult, setLicenseResult] = useState<LicenseResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [checking, setChecking] = useState(true);

    const cardClass = glassEnabled ? 'glass-card' : 'scale-in';

    useEffect(() => {
        loadMachineInfo();
        checkCurrentLicense();
    }, []);

    const loadMachineInfo = async () => {
        try {
            const info = await invoke<MachineInfo>('get_machine_info');
            setMachineInfo(info);
        } catch (err) {
            message.error('获取机器信息失败: ' + err);
        }
    };

    const checkCurrentLicense = async () => {
        setChecking(true);
        try {
            const result = await invoke<LicenseResult>('check_license');
            setLicenseResult(result);
            if (result.valid && onActivated) {
                onActivated();
            }
        } catch (err) {
            console.error('检查许可证失败:', err);
        } finally {
            setChecking(false);
        }
    };

    const handleActivate = async () => {
        if (!licenseKey.trim()) {
            message.warning('请输入许可证密钥');
            return;
        }

        setLoading(true);
        try {
            const result = await invoke<LicenseResult>('activate_license', { licenseKey: licenseKey.trim() });
            setLicenseResult(result);
            if (result.valid) {
                message.success('激活成功！');
                if (onActivated) {
                    onActivated();
                }
            } else {
                message.error(result.message);
            }
        } catch (err) {
            message.error('激活失败: ' + err);
        } finally {
            setLoading(false);
        }
    };

    const handleDeactivate = async () => {
        try {
            await invoke('deactivate_license');
            setLicenseResult(null);
            setLicenseKey('');
            message.success('已取消激活');
        } catch (err) {
            message.error('取消激活失败: ' + err);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        message.success('已复制到剪贴板');
    };

    if (checking) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
                <Card className={cardClass} style={{ textAlign: 'center', padding: 40 }}>
                    <ReloadOutlined spin style={{ fontSize: 32, color: '#1890ff', marginBottom: 16 }} />
                    <div>正在检查授权状态...</div>
                </Card>
            </div>
        );
    }

    // 已激活状态
    if (licenseResult?.valid) {
        return (
            <div style={{ maxWidth: 600, margin: '40px auto', padding: 20 }}>
                <Card className={cardClass}>
                    <div style={{ textAlign: 'center', marginBottom: 24 }}>
                        <CheckCircleOutlined style={{ fontSize: 64, color: '#52c41a' }} />
                        <Title level={3} style={{ marginTop: 16, marginBottom: 8 }}>已激活</Title>
                        <Text type="secondary">许可证验证通过</Text>
                    </div>

                    <Descriptions bordered column={1} size="small">
                        {licenseResult.info?.user_name && (
                            <Descriptions.Item label="授权用户">
                                <Text strong>{licenseResult.info.user_name}</Text>
                            </Descriptions.Item>
                        )}
                        <Descriptions.Item label="机器码">
                            <Text code style={{ fontSize: 11 }}>{licenseResult.info?.machine_id}</Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="到期时间">
                            {licenseResult.info?.expire_date ? (
                                <Tag color="blue">{licenseResult.info.expire_date}</Tag>
                            ) : (
                                <Tag color="green">永久授权</Tag>
                            )}
                        </Descriptions.Item>
                        {licenseResult.info?.features && licenseResult.info.features.length > 0 && (
                            <Descriptions.Item label="授权功能">
                                <Space wrap>
                                    {licenseResult.info.features.map((f, i) => (
                                        <Tag key={i} color="purple">{f}</Tag>
                                    ))}
                                </Space>
                            </Descriptions.Item>
                        )}
                    </Descriptions>

                    <Divider />

                    <Button danger icon={<DeleteOutlined />} onClick={handleDeactivate}>
                        取消激活
                    </Button>
                </Card>
            </div>
        );
    }

    // 未激活状态
    return (
        <div style={{ maxWidth: 600, margin: '40px auto', padding: 20 }}>
            <Card className={cardClass}>
                <div style={{ textAlign: 'center', marginBottom: 24 }}>
                    <KeyOutlined style={{ fontSize: 64, color: '#1890ff' }} />
                    <Title level={3} style={{ marginTop: 16, marginBottom: 8 }}>软件激活</Title>
                    <Text type="secondary">请输入许可证密钥以激活软件</Text>
                </div>

                {licenseResult && !licenseResult.valid && (
                    <Alert
                        type="error"
                        message={licenseResult.message}
                        style={{ marginBottom: 16 }}
                        showIcon
                    />
                )}

                <div style={{ marginBottom: 24 }}>
                    <Text strong style={{ display: 'block', marginBottom: 8 }}>
                        机器码
                    </Text>
                    <Paragraph>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            请将以下机器码发送给管理员获取许可证
                        </Text>
                    </Paragraph>
                    <Row gutter={8}>
                        <Col flex="auto">
                            <Input
                                value={machineInfo?.machine_id || '加载中...'}
                                readOnly
                                style={{
                                    fontFamily: 'Consolas, monospace',
                                    fontSize: 13,
                                    background: isDarkMode ? '#1a1a1a' : '#f5f5f5'
                                }}
                            />
                        </Col>
                        <Col>
                            <Button
                                icon={<CopyOutlined />}
                                onClick={() => copyToClipboard(machineInfo?.machine_id || '')}
                            >
                                复制
                            </Button>
                        </Col>
                    </Row>
                </div>

                <Divider />

                <div style={{ marginBottom: 16 }}>
                    <Text strong style={{ display: 'block', marginBottom: 8 }}>
                        许可证密钥
                    </Text>
                    <TextArea
                        rows={4}
                        placeholder="请粘贴许可证密钥..."
                        value={licenseKey}
                        onChange={(e) => setLicenseKey(e.target.value)}
                        style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
                    />
                </div>

                <Button
                    type="primary"
                    size="large"
                    block
                    icon={<KeyOutlined />}
                    loading={loading}
                    onClick={handleActivate}
                >
                    激活
                </Button>

                {/* 机器详细信息 */}
                <Divider>机器信息</Divider>
                <Descriptions size="small" column={1}>
                    <Descriptions.Item label="主机名">{machineInfo?.hostname}</Descriptions.Item>
                    <Descriptions.Item label="MAC地址">{machineInfo?.mac_address}</Descriptions.Item>
                    <Descriptions.Item label="CPU ID">
                        <Text code style={{ fontSize: 11 }}>{machineInfo?.cpu_id?.substring(0, 32)}...</Text>
                    </Descriptions.Item>
                </Descriptions>
            </Card>
        </div>
    );
}
