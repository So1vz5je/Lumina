import { Alert, List, Modal, Radio, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type {
  RemoteConflictPolicy,
  RemoteTransferPreparation,
} from '../../modules/remote/fileManagerTypes';

const { Text } = Typography;

export function FileConflictDialog({
  open,
  preparation,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  preparation: RemoteTransferPreparation | null;
  onCancel: () => void;
  onConfirm: (policy: RemoteConflictPolicy) => void;
}) {
  const [policy, setPolicy] = useState<RemoteConflictPolicy>('merge');

  useEffect(() => {
    if (open) {
      setPolicy('merge');
    }
  }, [open]);

  return (
    <Modal
      okText="Start Transfer"
      onCancel={onCancel}
      onOk={() => onConfirm(policy)}
      open={open}
      title="Resolve Existing Paths"
    >
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          message="The remote operation found existing destination paths."
          showIcon
          type="warning"
        />

        <Radio.Group
          onChange={(event) => setPolicy(event.target.value)}
          value={policy}
        >
          <Space orientation="vertical">
            <Radio value="merge">Merge directories and overwrite matching files</Radio>
            <Radio value="overwrite">Replace conflicting targets</Radio>
            <Radio value="skip">Skip conflicting targets</Radio>
          </Space>
        </Radio.Group>

        <List
          bordered
          dataSource={preparation?.conflicts ?? []}
          renderItem={(conflict) => (
            <List.Item>
              <Space orientation="vertical" size={2}>
                <Text strong>{conflict.path}</Text>
                <Text type="secondary">{conflict.reason}</Text>
              </Space>
            </List.Item>
          )}
          size="small"
        />
      </Space>
    </Modal>
  );
}
