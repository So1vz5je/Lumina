import type { AnalysisResult, RiskEvidence, RiskFinding, RiskSeverity, ScanRunPayload } from '../../types/analysis';
import { buildRiskFindings, mergeRiskFindings } from './riskEngine';

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asAnalysisResults(value: unknown): AnalysisResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AnalysisResult => (
    isRecord(item)
    && typeof item.module_name === 'string'
    && typeof item.status === 'string'
    && typeof item.summary === 'string'
  ));
}

function normalizeEvidence(value: unknown): RiskEvidence[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((item) => ({
    moduleName: asString(item.moduleName ?? item.module_name),
    label: asString(item.label),
    value: asString(item.value),
    time: asString(item.time) || undefined,
  }));
}

function normalizeRiskSeverity(value: unknown): RiskSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'low';
}

export function normalizeRiskFindings(value: unknown): RiskFinding[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((item, index) => ({
    id: asString(item.id, `backend-risk-${index}`),
    severity: normalizeRiskSeverity(item.severity),
    title: asString(item.title, '未命名风险'),
    reason: asString(item.reason),
    confidence: Math.max(0, Math.min(100, asNumber(item.confidence, 50))),
    affected: asStringArray(item.affected),
    evidence: normalizeEvidence(item.evidence),
    recommendedActions: asStringArray(item.recommendedActions ?? item.recommended_actions),
  }));
}

export function normalizeScanRunPayload(raw: unknown, selectedModuleIds?: string[]): ScanRunPayload {
  const moduleResults = Array.isArray(raw)
    ? asAnalysisResults(raw)
    : asAnalysisResults(isRecord(raw) ? raw.moduleResults ?? raw.module_results : []);
  const selected = new Set(selectedModuleIds || []);
  const filteredModuleResults = selected.size > 0
    ? moduleResults.filter((result) => selected.has(result.module_name))
    : moduleResults;
  const backendRiskFindings = isRecord(raw)
    ? normalizeRiskFindings(raw.riskFindings ?? raw.risk_findings)
    : [];
  const diagnostics = isRecord(raw) ? asStringArray(raw.diagnostics) : [];
  const fallbackRiskFindings = buildRiskFindings(filteredModuleResults);

  return {
    moduleResults: filteredModuleResults,
    riskFindings: mergeRiskFindings([backendRiskFindings, fallbackRiskFindings]),
    diagnostics,
  };
}
