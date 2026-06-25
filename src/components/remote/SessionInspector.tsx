import { CloudServerOutlined } from '@ant-design/icons';
import { Descriptions, Space, Tag, Typography } from 'antd';
import { useRemoteWorkspace } from '../../modules/remote/RemoteWorkspaceProvider';

const { Paragraph, Text, Title } = Typography;

export function SessionInspector() {
  const { state } = useRemoteWorkspace();
  const activeConnection = state.connections.find(
    (connection) => connection.id === state.activeConnectionId,
  );
  const runningTransfers = state.transferQueue.tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running',
  ).length;
  const failedTransfers = state.transferQueue.failedTaskIds.length;

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ marginBottom: 4 }}>
          Connection Snapshot
        </Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Remote host metadata will expand here as the shared workspace grows
          beyond a single command panel.
        </Paragraph>
      </div>

      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="Host">
          {activeConnection ? (
            <Space size={8}>
              <CloudServerOutlined />
              <Text>{activeConnection.host}</Text>
            </Space>
          ) : (
            <Text type="secondary">No active connection</Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="User">
          {activeConnection ? activeConnection.username : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="OS">
          {activeConnection?.osType ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Status">
          <Tag color={activeConnection ? 'blue' : 'default'}>
            {activeConnection?.status ?? 'idle'}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Active Path">
          {state.remoteFiles.activePath ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Transfers">
          <Space size={8}>
            <Tag color={runningTransfers > 0 ? 'blue' : 'default'}>
              running {runningTransfers}
            </Tag>
            <Tag color={failedTransfers > 0 ? 'red' : 'default'}>
              failed {failedTransfers}
            </Tag>
          </Space>
        </Descriptions.Item>
      </Descriptions>
    </Space>
  );
}
