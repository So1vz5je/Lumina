import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { normalizeMutationValue, validateWindowsDatabaseRowValues } from '../../modules/windowsDatabase/mutation';
import type { WindowsDatabaseEditableColumn } from '../../modules/windowsDatabase/types';

const { Text } = Typography;

interface WindowsDatabaseRowEditorProps {
  open: boolean;
  mode: 'insert' | 'update';
  columns: WindowsDatabaseEditableColumn[];
  initialValues: Record<string, unknown>;
  onCancel: () => void;
  onSubmit: (values: Record<string, string | number | boolean | null>) => void;
}

export function WindowsDatabaseRowEditor({
  open,
  mode,
  columns,
  initialValues,
  onCancel,
  onSubmit,
}: WindowsDatabaseRowEditorProps) {
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(initialValues);
      setError(null);
    }
  }, [initialValues, open]);

  const handleSubmit = () => {
    const validationError = validateWindowsDatabaseRowValues(columns, values);
    if (validationError) {
      setError(validationError);
      return;
    }

    onSubmit(
      Object.fromEntries(
        columns
          .filter((column) => !column.identity)
          .map((column) => [
            column.name,
            values[column.name] === '' && column.nullable ? null : normalizeMutationValue(values[column.name]),
          ]),
      ),
    );
  };

  return (
    <Modal
      open={open}
      title={mode === 'insert' ? '新增行' : '编辑行'}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" aria-label="取消" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" aria-label="保存" onClick={handleSubmit}>
          保存
        </Button>,
      ]}
      width={520}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {error ? <Alert type="error" title={error} showIcon /> : null}
        <Form layout="vertical">
          {columns.map((column) => (
            <Form.Item
              key={column.name}
              label={column.name}
              required={column.required}
              extra={
                <Text type="secondary">
                  {column.dataType}
                  {column.nullable ? ' nullable' : ' not null'}
                </Text>
              }
            >
              <Input
                aria-label={column.name}
                value={values[column.name] == null ? '' : String(values[column.name])}
                disabled={mode === 'update' && column.identity}
                onChange={(event) => {
                  setError(null);
                  setValues((current) => ({ ...current, [column.name]: event.target.value }));
                }}
              />
            </Form.Item>
          ))}
        </Form>
      </Space>
    </Modal>
  );
}

export default WindowsDatabaseRowEditor;
