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
  category: string;
  attackTactic: string;
  attackTechnique: string;
  title: string;
  reason: string;
  confidence: number;
  affected: string[];
  evidence: RiskEvidence[];
  recommendedActions: string[];
}

export type ScanAssessmentVerdict = 'compromised' | 'suspicious' | 'attention' | 'clean';

export interface ScanAssessmentSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ScanAssessmentTacticCoverage {
  tactic: string;
  count: number;
}

export interface ScanAssessment {
  verdict: ScanAssessmentVerdict;
  severityCounts: ScanAssessmentSeverityCounts;
  tacticCoverage: ScanAssessmentTacticCoverage[];
  headline: string;
}

export interface ScanRunPayload {
  moduleResults: AnalysisResult[];
  riskFindings: RiskFinding[];
  diagnostics: string[];
}
