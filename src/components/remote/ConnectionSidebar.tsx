import {
  Button,
  Empty,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { SavedConnection } from '../../modules/remote/savedConnections';

const { Paragraph, Text, Title } = Typography;

interface ConnectionSidebarProps {
  connections: SavedConnection[];
  activeConnectionId: string | null;
  onActivate: (connectionId: string) => void;
  onConnect: (connection: SavedConnection) => void;
  onCreate?: () => void;
  onEdit?: (connection: SavedConnection) => void;
  onDelete?: (connectionId: string) => void;
  title?: string;
  description?: string;
  emptyDescription?: string;
  createLabel?: string;
  connectLabel?: string;
}

export function ConnectionSidebar({
  connections,
  activeConnectionId,
  onActivate,
  onConnect,
  onCreate,
  onEdit,
  onDelete,
  title = 'Connections',
  description,
  emptyDescription = 'No saved hosts yet',
  createLabel = 'New Connection',
  connectLabel = 'Connect',
}: ConnectionSidebarProps) {
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={5} style={{ marginBottom: 4 }}>
          {title}
        </Title>
        {description ? (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {description}
          </Paragraph>
        ) : null}
      </div>

      {onCreate ? (
        <Button block icon={<PlusOutlined />} onClick={onCreate} type="primary">
          {createLabel}
        </Button>
      ) : null}

      {connections.length > 0 ? (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          {connections.map((connection) => {
            const isActive = connection.id === activeConnectionId;

            return (
              <div
                key={connection.id}
                onClick={() => onActivate(connection.id)}
                style={{
                  cursor: 'pointer',
                  padding: '14px 16px',
                  borderRadius: 12,
                  border: isActive
                    ? '1px solid rgba(24, 144, 255, 0.45)'
                    : '1px solid rgba(148, 163, 184, 0.18)',
                  background: isActive
                    ? 'rgba(24, 144, 255, 0.08)'
                    : 'rgba(148, 163, 184, 0.06)',
                }}
              >
                <Space
                  align="start"
                  size={12}
                  style={{ justifyContent: 'space-between', width: '100%' }}
                >
                  <div>
                    <Space size={8}>
                      <Text strong>{connection.name}</Text>
                      <Tag
                        color={connection.authType === 'password' ? 'gold' : 'blue'}
                      >
                        {connection.authType}
                      </Tag>
                    </Space>
                    <Paragraph
                      style={{ marginBottom: 0, marginTop: 6 }}
                      type="secondary"
                    >
                      {connection.username}@{connection.host}:{connection.port}
                    </Paragraph>
                  </div>

                  <Space size={4}>
                    <Button
                      icon={<LinkOutlined />}
                      onClick={(event) => {
                        event.stopPropagation();
                        onConnect(connection);
                      }}
                      size="small"
                      type="primary"
                    >
                      {connectLabel}
                    </Button>
                    {onEdit ? (
                      <Button
                        icon={<EditOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(connection);
                        }}
                        size="small"
                        type="text"
                      />
                    ) : null}
                    {onDelete ? (
                      <Popconfirm
                        onCancel={(event) => event?.stopPropagation()}
                        onConfirm={(event) => {
                          event?.stopPropagation();
                          onDelete(connection.id);
                        }}
                        title="Delete this connection?"
                      >
                        <Button
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(event) => event.stopPropagation()}
                          size="small"
                          type="text"
                        />
                      </Popconfirm>
                    ) : null}
                  </Space>
                </Space>
              </div>
            );
          })}
        </Space>
      ) : (
        <Empty
          description={emptyDescription}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Space>
  );
}
