import { useMemo, useState } from 'react';
import { Button, Checkbox, Progress, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisResult } from '../types/analysis';
import {
  createDefaultScanModules,
  type ScanModuleOption,
} from '../modules/scan/catalog';

const { Text, Title } = Typography;

interface ScanProps {
  onComplete: (results: AnalysisResult[]) => void;
}

export default function Scan({ onComplete }: ScanProps) {
  const [modules, setModules] = useState<ScanModuleOption[]>(() => createDefaultScanModules());
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTask, setCurrentTask] = useState('准备就绪');
  const [activeGroup, setActiveGroup] = useState('all');

  const selectedModuleIds = useMemo(
    () => modules.filter((module) => module.enabled).map((module) => module.id),
    [modules],
  );
  const selectedCount = selectedModuleIds.length;
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

  const startScan = async () => {
    if (selectedModuleIds.length === 0) {
      message.warning('请至少选择一个扫描模块');
      return;
    }

    setIsScanning(true);
    setProgress(8);
    setCurrentTask(`正在执行 ${selectedModuleIds.length} 个扫描模块`);

    try {
      setProgress(35);
      const results = await invoke<AnalysisResult[]>('run_scan');
      const filteredResults = results.filter((result) =>
        selectedModuleIds.includes(result.module_name),
      );

      setProgress(100);
      setCurrentTask(`扫描完成，共 ${filteredResults.length} 项结果`);
      setIsScanning(false);
      message.success('扫描完成');
      onComplete(filteredResults);
    } catch (error) {
      console.error('Scan failed:', error);
      setIsScanning(false);
      setProgress(0);
      setCurrentTask('扫描失败');
      message.error('扫描失败');
    }
  };

  const cancelScan = () => {
    setIsScanning(false);
    setCurrentTask('扫描已停止');
    setProgress(0);
  };

  return (
    <div className="scan-workspace">
      <div className="scan-hero">
        <div className="scan-hero-copy">
          <Text className="scan-eyebrow">快速扫描</Text>
          <Title level={3} className="scan-title">
            应急响应快速扫描
          </Title>
          <Text className="scan-subtitle">
            按模块批量采集本机应急响应证据，完成后进入统一结果视图。
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
          <span>扫描状态</span>
          <strong>{scanStateLabel}</strong>
        </div>
      </div>

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
                  className={`scan-module-card ${module.enabled ? 'selected' : ''} ${isScanning ? 'disabled' : ''}`}
                >
                  <Checkbox
                    checked={module.enabled}
                    disabled={isScanning}
                    onChange={(event) => toggleModule(module.id, event.target.checked)}
                  />
                  <span className="scan-module-main">
                    <span className="scan-module-topline">
                      <Text className="scan-module-name">{module.label}</Text>
                      <Text className="scan-module-group">{module.group}</Text>
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
