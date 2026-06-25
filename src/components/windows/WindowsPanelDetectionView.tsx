import { Alert, Empty, Table, Tabs, Tag, Typography } from 'antd';
import {
  ControlOutlined,
  FileTextOutlined,
  GlobalOutlined,
  HddOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  normalizeWindowsPanelDetection,
  type WindowsPanelDetectionData,
  type WindowsPanelInstall,
  type WindowsPanelLog,
  type WindowsPanelService,
  type WindowsPanelSite,
} from '../../modules/windowsPanel/detection';

const { Text } = Typography;

interface WindowsPanelDetectionViewProps {
  data: unknown;
  isDarkMode?: boolean;
}

function statusColor(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes('running') || normalized.includes('started') || normalized.includes('present')) return 'green';
  if (normalized.includes('stopped') || normalized.includes('disabled')) return 'orange';
  if (normalized === '-' || normalized.includes('not')) return 'default';
  return 'blue';
}

function sourceLabel(value: string) {
  if (value === '-' || !value) return '-';
  if (value.toLowerCase() === 'iis') return 'IIS';
  return value;
}

function hasFindings(model: WindowsPanelDetectionData) {
  return model.detectedInstalls.length > 0
    || model.sites.length > 0
    || model.iisSites.length > 0
    || model.services.length > 0
    || model.logs.length > 0;
}

function renderPath(value: string) {
  return <Text code className="windows-panel-path">{value}</Text>;
}

export default function WindowsPanelDetectionView({ data, isDarkMode = false }: WindowsPanelDetectionViewProps) {
  const model = normalizeWindowsPanelDetection(data);
  const detected = hasFindings(model);
  const allSites = model.sites.length > 0 ? model.sites : model.iisSites;
  const checkedFamilies = 'BaoTa Windows, phpStudy, XAMPP, WampServer, and IIS';

  const installColumns = [
    {
      title: '面板',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (value: string, row: WindowsPanelInstall) => (
        <span className="windows-panel-name">
          <Text strong>{value}</Text>
          <Tag color={row.detected ? 'green' : 'default'}>{row.detected ? '已发现' : '未发现'}</Tag>
        </span>
      ),
    },
    { title: '类型', dataIndex: 'panelType', key: 'panelType', width: 140 },
    { title: '安装路径', dataIndex: 'path', key: 'path', render: renderPath },
    { title: '站点根目录', dataIndex: 'siteRoot', key: 'siteRoot', render: renderPath },
    {
      title: '服务状态',
      dataIndex: 'serviceState',
      key: 'serviceState',
      width: 110,
      render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag>,
    },
    { title: '站点数', dataIndex: 'siteCount', key: 'siteCount', width: 90 },
    { title: '证据', dataIndex: 'evidence', key: 'evidence', ellipsis: true },
    { title: '备注', dataIndex: 'notes', key: 'notes', ellipsis: true },
  ];

  const siteColumns = [
    {
      title: '站点',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (value: string, row: WindowsPanelSite) => (
        <span className="windows-panel-site-name">
          <Text strong>{value}</Text>
          {(row.sizeText !== '-' || row.lastModified !== '-') && (
            <Text type="secondary">{[row.sizeText, row.lastModified].filter((item) => item !== '-').join(' / ')}</Text>
          )}
        </span>
      ),
    },
    { title: '路径', dataIndex: 'path', key: 'path', render: renderPath },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
      render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag>,
    },
    { title: '绑定', dataIndex: 'bindings', key: 'bindings', ellipsis: true },
    { title: '来源', dataIndex: 'source', key: 'source', width: 120, render: (value: string) => sourceLabel(value) },
    { title: '所属面板', dataIndex: 'ownerPanel', key: 'ownerPanel', width: 150 },
    { title: '大小', dataIndex: 'sizeText', key: 'sizeText', width: 90 },
    { title: '最后修改', dataIndex: 'lastModified', key: 'lastModified', width: 160 },
  ];

  const serviceColumns = [
    { title: '服务名', dataIndex: 'name', key: 'name', width: 160, render: (value: string) => <Text strong>{value}</Text> },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName', width: 220 },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
      render: (value: string) => <Tag color={statusColor(value)}>{value}</Tag>,
    },
    { title: '启动模式', dataIndex: 'startMode', key: 'startMode', width: 110 },
    { title: 'PID', dataIndex: 'pid', key: 'pid', width: 90 },
    { title: '路径', dataIndex: 'path', key: 'path', render: renderPath },
  ];

  const logColumns = [
    { title: '来源', dataIndex: 'source', key: 'source', width: 120 },
    { title: '路径', dataIndex: 'path', key: 'path', render: renderPath },
    { title: '大小', dataIndex: 'sizeText', key: 'sizeText', width: 90 },
    { title: '最后修改', dataIndex: 'lastModified', key: 'lastModified', width: 170 },
    { title: '说明', dataIndex: 'note', key: 'note', ellipsis: true },
  ];

  const tabItems = [
    {
      key: 'installs',
      label: `面板配置 (${model.installs.length})`,
      forceRender: true,
      children: (
        <Table<WindowsPanelInstall>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={model.installs}
          columns={installColumns}
          scroll={{ x: 1100 }}
          locale={{ emptyText: '未返回面板候选项' }}
        />
      ),
    },
    {
      key: 'sites',
      label: `站点 (${allSites.length})`,
      forceRender: true,
      children: (
        <Table<WindowsPanelSite>
          rowKey="key"
          size="small"
          pagination={{ pageSize: 8 }}
          dataSource={allSites}
          columns={siteColumns}
          scroll={{ x: 1050 }}
          locale={{ emptyText: '未发现站点目录或 IIS 站点' }}
        />
      ),
    },
    {
      key: 'services',
      label: `服务 (${model.services.length})`,
      forceRender: true,
      children: (
        <Table<WindowsPanelService>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={model.services}
          columns={serviceColumns}
          scroll={{ x: 950 }}
          locale={{ emptyText: '未发现相关 Windows 服务' }}
        />
      ),
    },
    {
      key: 'logs',
      label: `日志/配置 (${model.logs.length})`,
      forceRender: true,
      children: (
        <Table<WindowsPanelLog>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={model.logs}
          columns={logColumns}
          scroll={{ x: 900 }}
          locale={{ emptyText: '未发现日志或配置文件线索' }}
        />
      ),
    },
    {
      key: 'diagnostics',
      label: `诊断 (${model.diagnostics.length})`,
      forceRender: true,
      children: model.diagnostics.length > 0 ? (
        <div className="windows-panel-diagnostics">
          {model.diagnostics.map((item, index) => (
            <Alert key={`${item}-${index}`} type="info" showIcon message={item} />
          ))}
        </div>
      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无采集诊断" />,
    },
  ];

  return (
    <div className={`windows-panel-detection${isDarkMode ? ' windows-panel-detection-dark' : ''}`}>
      <div className="windows-panel-summary-strip" aria-label="Windows 面板检测概览">
        <div className="windows-panel-summary-item">
          <ControlOutlined />
          <span>面板</span>
          <strong>{model.statistics.detectedPanelCount}</strong>
        </div>
        <div className="windows-panel-summary-item">
          <GlobalOutlined />
          <span>站点</span>
          <strong>{model.statistics.siteCount || allSites.length}</strong>
        </div>
        <div className="windows-panel-summary-item">
          <ToolOutlined />
          <span>服务</span>
          <strong>{model.statistics.serviceCount}</strong>
        </div>
        <div className="windows-panel-summary-item">
          <FileTextOutlined />
          <span>日志</span>
          <strong>{model.statistics.logCount}</strong>
        </div>
        <div className="windows-panel-summary-item">
          <HddOutlined />
          <span>诊断</span>
          <strong>{model.statistics.diagnosticCount}</strong>
        </div>
      </div>

      {!detected && (
        <div className="windows-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                未发现常见 Windows Web 面板
                <br />
                <Text type="secondary">已检查 {checkedFamilies}</Text>
              </span>
            }
          />
          {model.diagnostics.length > 0 && (
            <div className="windows-panel-empty-diagnostics">
              {model.diagnostics.map((item, index) => (
                <Tag key={`${item}-${index}`} color="blue">{item}</Tag>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="windows-panel-table-shell">
        <Tabs items={tabItems} defaultActiveKey={detected ? 'installs' : 'diagnostics'} size="small" />
      </div>
    </div>
  );
}
