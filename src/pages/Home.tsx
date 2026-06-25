import { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Progress, Button, Typography, Descriptions } from 'antd';
import { DesktopOutlined, DashboardOutlined, HddOutlined, RocketOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';

const { Title } = Typography;

interface SystemInfo {
    os_name: string;
    os_version: string;
    hostname: string;
    kernel_version: string;
    cpu_cores: number;
    total_memory_gb: number;
    used_memory_gb: number;
    cpu_usage: number;
}

interface HomeProps {
    onStartScan: () => void;
}

export default function Home({ onStartScan }: HomeProps) {
    const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSystemInfo();
    }, []);

    const loadSystemInfo = async () => {
        try {
            setLoading(true);
            const info = await invoke<SystemInfo>('get_system_info');
            setSystemInfo(info);
        } catch (error) {
            console.error('Failed to load system info:', error);
        } finally {
            setLoading(false);
        }
    };

    const memoryPercent = systemInfo
        ? (systemInfo.used_memory_gb / systemInfo.total_memory_gb) * 100
        : 0;

    return (
        <div>
            <Title level={4}>服务器信息</Title>

            <Card loading={loading} style={{ marginBottom: 24 }}>
                <Descriptions column={2}>
                    <Descriptions.Item label="系统类型">{systemInfo?.os_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="系统版本">{systemInfo?.os_version || '-'}</Descriptions.Item>
                    <Descriptions.Item label="主机名称">{systemInfo?.hostname || '-'}</Descriptions.Item>
                    <Descriptions.Item label="内核版本">{systemInfo?.kernel_version || '-'}</Descriptions.Item>
                    <Descriptions.Item label="CPU核心">{systemInfo?.cpu_cores || 0} 核</Descriptions.Item>
                    <Descriptions.Item label="总内存">{systemInfo?.total_memory_gb?.toFixed(1) || 0} GB</Descriptions.Item>
                </Descriptions>
            </Card>

            <Title level={5}>系统状态</Title>

            <Row gutter={24} style={{ marginBottom: 24 }}>
                <Col span={8}>
                    <Card>
                        <div style={{ textAlign: 'center' }}>
                            <Progress
                                type="circle"
                                percent={Math.round(systemInfo?.cpu_usage || 0)}
                                strokeColor="#1890ff"
                                format={(percent) => `${percent}%`}
                            />
                            <div style={{ marginTop: 12, color: '#666' }}>CPU 使用率</div>
                        </div>
                    </Card>
                </Col>
                <Col span={8}>
                    <Card>
                        <div style={{ textAlign: 'center' }}>
                            <Progress
                                type="circle"
                                percent={Math.round(memoryPercent)}
                                strokeColor="#fa8c16"
                                format={(percent) => `${percent}%`}
                            />
                            <div style={{ marginTop: 12, color: '#666' }}>内存使用率</div>
                        </div>
                    </Card>
                </Col>
                <Col span={8}>
                    <Card>
                        <div style={{ textAlign: 'center' }}>
                            <Progress
                                type="circle"
                                percent={45}
                                strokeColor="#52c41a"
                                format={(percent) => `${percent}%`}
                            />
                            <div style={{ marginTop: 12, color: '#666' }}>磁盘使用率</div>
                        </div>
                    </Card>
                </Col>
            </Row>

            <Button
                type="primary"
                size="large"
                icon={<RocketOutlined />}
                onClick={onStartScan}
            >
                快速扫描
            </Button>
        </div>
    );
}
