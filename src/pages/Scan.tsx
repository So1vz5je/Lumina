import { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Progress, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult } from '../types/analysis';
import type { ScanRunPayload } from '../types/analysis';
import {
  createDefaultScanModules,
  type ScanModuleOption,
} from '../modules/scan/catalog';
import { normalizeScanRunPayload } from '../modules/scan/payload';

const { Text, Title } = Typography;

const highRiskModuleIds = new Set([
  'panel',
  'file_scan',
  'process',
  'network',
  'startup',
  'cron',
  'persistence',
  'security_events',
  'security_posture',
]);

interface ScanProps {
  onComplete: (payload: ScanRunPayload) => void;
}

export default function Scan({ onComplete }: ScanProps) {
  const [modules, setModules] = useState<ScanModuleOption[]>(() => createDefaultScanModules());
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTask, setCurrentTask] = useState('准备就绪');
  const [activeGroup, setActiveGroup] = useState('all');
  const activeRunIdRef = useRef(0);

  const selectedModuleIds = useMemo(
    () => modules.filter((module) => module.enabled).map((module) => module.id),
    [modules],
  );
  const selectedCount = selectedModuleIds.length;
  const selectedHighRiskCount = selectedModuleIds.filter((id) => highRiskModuleIds.has(id)).length;
  const selectedNonHighRiskCount = selectedCount - selectedHighRiskCount;
  const scanStrategyLabel =
    selectedCount === 0
      ? '未选择'
      : selectedHighRiskCount === highRiskModuleIds.size && selectedNonHighRiskCount === 0
        ? '高危优先'
        : selectedCount === modules.length
          ? '完整取证'
          : '自定义';
  const groupedModules = useMemo(() => {
    const groups = new Map<string, ScanModuleOption[]>();

    modules.forEach((module) => {
      const current = groups.get(module.group) || [];
      current.push(module);
      groups.set(module.group, current);
    });

    return Array.from(groups.entries()).map(([group, items]) => ({
      group,
      items,
      selected: items.filter((item) => item.enabled).length,
    }));
  }, [modules]);
  const visibleModules = useMemo(
    () =>
      activeGroup === 'all'
        ? modules
        : modules.filter((module) => module.group === activeGroup),
    [activeGroup, modules],
  );
  const scanStateLabel = isScanning ? '扫描中' : progress === 100 ? '已完成' : '待开始';

  const toggleModule = (id: string, checked: boolean) => {
    setModules((prev) =>
      prev.map((module) =>
        module.id === id ? { ...module, enabled: checked } : module,
      ),
    );
  };

  const selectAll = () => {
    setModules((prev) => prev.map((module) => ({ ...module, enabled: true })));
  };

  const deselectAll = () => {
    setModules((prev) => prev.map((module) => ({ ...module, enabled: false })));
  };

  const selectHighRiskOnly = () => {
    setActiveGroup('all');
    setModules((prev) =>
      prev.map((module) => ({
        ...module,
        enabled: highRiskModuleIds.has(module.id),
      })),
    );
  };

  const selectCompleteInvestigation = () => {
    setActiveGroup('all');
    selectAll();
  };

  const startScan = async () => {
    if (selectedModuleIds.length === 0) {
      message.warning('请至少选择一个扫描模块');
      return;
    }

    const modulesToScan = selectedModuleIds;
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;
    setIsScanning(true);
    setProgress(8);
    setCurrentTask(`正在执行 ${modulesToScan.length} 个扫描模块`);

    try {
      setProgress(35);
      const rawPayload = await invoke<AnalysisResult[] | ScanRunPayload>('run_scan', {
        selectedModules: modulesToScan,
      });

      if (activeRunIdRef.current !== runId) {
        return;
      }

      const payload = normalizeScanRunPayload(rawPayload, modulesToScan);

      setProgress(100);
      setCurrentTask(`扫描完成，共 ${payload.moduleResults.length} 项结果`);
      setIsScanning(false);
      message.success('扫描完成');
      onComplete(payload);
    } catch (error) {
      if (activeRunIdRef.current !== runId) {
        return;
      }
      console.error('Scan failed:', error);
      setIsScanning(false);
      setProgress(0);
      setCurrentTask('扫描失败');
      message.error('扫描失败');
    }
  };

  const cancelScan = () => {
    activeRunIdRef.current += 1;
    setIsScanning(false);
    setCurrentTask('扫描已停止');
    setProgress(0);
    message.info('已停止接收本次扫描结果');
  };

  return (
    <div className="scan-workspace">
      <div className="scan-hero">
        <div className="scan-hero-copy">
          <Text className="scan-eyebrow">快速扫描</Text>
          <Title level={3} className="scan-title">
            高危优先快速扫描
          </Title>
          <Text className="scan-subtitle">
            快速定位 WebShell、外联进程、持久化和安全削弱证据。
          </Text>
        </div>
      </div>

      <div className="scan-status-strip" aria-label="扫描概览">
        <div className="scan-status-item">
          <span>模块总数</span>
          <strong>{modules.length}</strong>
        </div>
        <div className="scan-status-item">
          <span>已选择</span>
          <strong>{selectedCount}</strong>
        </div>
        <div className="scan-status-item">
          <span>功能分组</span>
          <strong>{groupedModules.length}</strong>
        </div>
        <div className="scan-status-item">
          <span>扫描策略</span>
          <strong>{scanStrategyLabel}</strong>
        </div>
        <div className="scan-status-item">
          <span>扫描状态</span>
          <strong>{scanStateLabel}</strong>
        </div>
      </div>

      <section className="scan-risk-strip" aria-label="扫描策略">
        <div>
          <Text className="scan-panel-kicker">扫描策略</Text>
          <strong>{scanStrategyLabel}</strong>
          <Text type="secondary">高危模块参与结果页高危归因。</Text>
        </div>
        <div className="scan-risk-meter">
          <Text>高危模块</Text>
          <strong>{selectedHighRiskCount}/{highRiskModuleIds.size}</strong>
        </div>
        <div className="scan-risk-strategy-actions">
          <Button
            aria-label="高危优先一键选择"
            disabled={isScanning}
            onClick={selectHighRiskOnly}
            size="small"
            type="primary"
          >
            高危优先
          </Button>
          <Button
            aria-label="完整取证全选"
            disabled={isScanning}
            onClick={selectCompleteInvestigation}
            size="small"
          >
            完整取证
          </Button>
        </div>
      </section>

      <div className="scan-layout">
        <section className="scan-module-panel">
          <div className="scan-panel-head">
            <div>
              <Text className="scan-panel-kicker">检测范围</Text>
              <Title level={5} className="scan-panel-title">
                扫描模块
              </Title>
            </div>
            <div className="scan-panel-actions">
              <Button size="small" onClick={selectAll} disabled={isScanning}>
                全选
              </Button>
              <Button size="small" onClick={deselectAll} disabled={isScanning}>
                清空
              </Button>
            </div>
          </div>

          <div className="scan-module-browser">
            <div className="scan-group-filter-bar" aria-label="模块分组筛选">
              <button
                aria-label="筛选全部模块"
                className={`scan-group-filter ${activeGroup === 'all' ? 'active' : ''}`}
                onClick={() => setActiveGroup('all')}
                type="button"
              >
                <span>全部</span>
                <strong>{selectedCount}/{modules.length}</strong>
              </button>
              {groupedModules.map((group) => (
                <button
                  aria-label={`筛选${group.group}模块`}
                  className={`scan-group-filter ${activeGroup === group.group ? 'active' : ''}`}
                  key={group.group}
                  onClick={() => setActiveGroup(group.group)}
                  type="button"
                >
                  <span>{group.group}</span>
                  <strong>{group.selected}/{group.items.length}</strong>
                </button>
              ))}
            </div>

            <div className="scan-module-grid">
              {visibleModules.map((module) => (
                <label
                  key={module.id}
                  className={`scan-module-card ${module.enabled ? 'selected' : ''} ${highRiskModuleIds.has(module.id) ? 'priority' : ''} ${isScanning ? 'disabled' : ''}`}
                >
                  <Checkbox
                    checked={module.enabled}
                    disabled={isScanning}
                    onChange={(event) => toggleModule(module.id, event.target.checked)}
                  />
                  <span className="scan-module-main">
                    <span className="scan-module-topline">
                      <Text className="scan-module-name">{module.label}</Text>
                      <span className="scan-module-badges">
                        {highRiskModuleIds.has(module.id) ? <Text className="scan-module-priority">高危</Text> : null}
                        <Text className="scan-module-group">{module.group}</Text>
                      </span>
                    </span>
                    <Text className="scan-module-description">{module.description}</Text>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <aside className="scan-run-panel">
          <div className="scan-run-head">
            <div className="scan-run-icon">
              {isScanning ? <ThunderboltOutlined /> : <CheckCircleOutlined />}
            </div>
            <div>
              <Text className="scan-panel-kicker">执行状态</Text>
              <Title level={5} className="scan-panel-title">
                {isScanning ? '正在扫描' : '等待开始'}
              </Title>
            </div>
          </div>

          <div className="scan-progress-block">
            <div className="scan-progress-meta">
              <Text>{currentTask}</Text>
              <Text>{progress}%</Text>
            </div>
            <Progress percent={progress} status={isScanning ? 'active' : 'normal'} showInfo={false} />
          </div>

          <div className="scan-run-summary">
            <div>
              <Text type="secondary">执行方式</Text>
              <strong>本地 Tauri 扫描</strong>
            </div>
            <div>
              <Text type="secondary">输出</Text>
              <strong>结构化结果</strong>
            </div>
          </div>

          {isScanning ? (
            <Button
              aria-label="停止扫描"
              block
              danger
              icon={<StopOutlined />}
              onClick={cancelScan}
              size="large"
            >
              停止扫描
            </Button>
          ) : (
            <Button
              aria-label="开始扫描"
              block
              disabled={selectedCount === 0}
              icon={<PlayCircleOutlined />}
              onClick={startScan}
              size="large"
              type="primary"
            >
              开始扫描
            </Button>
          )}
        </aside>
      </div>
    </div>
  );
}
