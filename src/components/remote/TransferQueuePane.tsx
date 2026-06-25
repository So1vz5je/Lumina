import {
  DownloadOutlined,
  ReloadOutlined,
  StopOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Card, Empty, List, Progress, Space, Tag, Typography } from 'antd';
import type { RemoteTransferTaskRecord } from '../../modules/remote/fileManagerTypes';

const { Paragraph, Text } = Typography;

export function TransferQueuePane({
  tasks,
  onCancel,
  onRetry,
}: {
  tasks: RemoteTransferTaskRecord[];
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
}) {
  if (tasks.length === 0) {
    return (
      <Empty
        description="No transfers have been started yet"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <List
      dataSource={[...tasks].reverse()}
      renderItem={(task) => {
        const progressPercent =
          task.totalBytes > 0
            ? Math.min(
                100,
                Math.round((task.bytesTransferred / task.totalBytes) * 100),
              )
            : task.totalItems > 0
              ? Math.min(
                  100,
                  Math.round((task.completedItems / task.totalItems) * 100),
                )
              : task.status === 'completed'
                ? 100
                : 0;

        return (
          <List.Item>
            <Card style={{ width: '100%' }}>
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <Space
                  align="center"
                  size={12}
                  style={{ justifyContent: 'space-between', width: '100%' }}
                >
                  <Space size={8}>
                    {task.direction === 'upload' ? (
                      <UploadOutlined />
                    ) : (
                      <DownloadOutlined />
                    )}
                    <Text strong>
                      {task.direction === 'upload' ? 'Upload' : 'Download'}
                    </Text>
                    <Tag color={statusColorMap[task.status]}>{task.status}</Tag>
                  </Space>

                  <Space size={8}>
                    <Button
                      disabled={task.status !== 'running' && task.status !== 'queued'}
                      icon={<StopOutlined />}
                      onClick={() => onCancel(task.id)}
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={task.status !== 'failed' || !task.retryRequest}
                      icon={<ReloadOutlined />}
                      onClick={() => onRetry(task.id)}
                    >
                      Retry
                    </Button>
                  </Space>
                </Space>

                <div>
                  <Text strong>Target</Text>
                  <Paragraph style={{ marginBottom: 4 }}>{task.targetPath}</Paragraph>
                  <Text type="secondary">{task.sourcePaths.join(', ')}</Text>
                </div>

                <Progress percent={progressPercent} size="small" />

                <Space size={16} wrap>
                  <Text type="secondary">
                    Items {task.completedItems}/{task.totalItems}
                  </Text>
                  <Text type="secondary">
                    Bytes {task.bytesTransferred}/{task.totalBytes}
                  </Text>
                </Space>

                {task.lastError ? (
                  <Text type="danger">{task.lastError}</Text>
                ) : null}
              </Space>
            </Card>
          </List.Item>
        );
      }}
    />
  );
}

const statusColorMap: Record<RemoteTransferTaskRecord['status'], string> = {
  queued: 'gold',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
};
