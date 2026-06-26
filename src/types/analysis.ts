export interface AnalysisResult {
  module_name: string;
  status: string;
  summary: string;
  details: unknown;
}

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RiskEvidence {
  moduleName: string;
  label: string;
  value: string;
  time?: string;
}

export interface RiskFinding {
  id: string;
  severity: RiskSeverity;
  title: string;
  reason: string;
  confidence: number;
  affected: string[];
  evidence: RiskEvidence[];
  recommendedActions: string[];
}

export interface ScanRunPayload {
  moduleResults: AnalysisResult[];
  riskFindings: RiskFinding[];
  diagnostics: string[];
}
