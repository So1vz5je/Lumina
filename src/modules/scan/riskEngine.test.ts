import { describe, expect, it } from 'vitest';

import type { AnalysisResult, RiskFinding } from '../../types/analysis';
import { buildMarkdownReport, buildRiskFindings, computeAssessment } from './riskEngine';

function makeFinding(overrides: Partial<RiskFinding>): RiskFinding {
  return {
    id: 'finding-1',
    severity: 'low',
    category: 'test',
    attackTactic: '测试战术',
    attackTechnique: 'T0000 测试技术',
    title: '测试发现',
    reason: '测试原因',
    confidence: 50,
    affected: [],
    evidence: [],
    recommendedActions: [],
    ...overrides,
  };
}

describe('buildRiskFindings', () => {
  it('does not mark a detected panel as high risk by itself', () => {
    const results: AnalysisResult[] = [
      {
        module_name: 'panel',
        status: 'info',
        summary: '检测到 1 个面板/集成环境',
        details: {
          detected_installs: [
            {
              panel_type: 'phpstudy',
              name: 'PhpStudy Pro',
              path: 'D:\\ctf-tools\\phpstudy_pro\\COM',
              detected: true,
              site_root: 'D:\\ctf-tools\\phpstudy_pro\\WWW',
            },
          ],
        },
      },
    ];

    const findings = buildRiskFindings(results);

    expect(findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')).toBe(false);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'medium',
          title: expect.stringContaining('Web 面板'),
          category: 'panel-context',
          attackTactic: '初始访问面 (上下文)',
          attackTechnique: 'T1190 利用面向公众的应用',
        }),
      ]),
    );
  });

  it('raises a critical finding when a web root script matches webshell traits', () => {
    const results: AnalysisResult[] = [
      {
        module_name: 'panel',
        status: 'info',
        summary: '检测到 phpStudy',
        details: {
          detected_installs: [
            {
              panel_type: 'phpstudy',
              name: 'PhpStudy Pro',
              path: 'D:\\ctf-tools\\phpstudy_pro\\COM',
              site_root: 'D:\\ctf-tools\\phpstudy_pro\\WWW',
              detected: true,
            },
          ],
          sites: [
            {
              name: 'default',
              path: 'D:\\ctf-tools\\phpstudy_pro\\WWW',
            },
          ],
        },
      },
      {
        module_name: 'file_scan',
        status: 'warning',
        summary: '发现可疑脚本',
        details: {
          findings: [
            {
              name: 'shell.php',
              path: 'D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell.php',
              suspicious: true,
              reason: 'PHP code contains eval and base64_decode',
              last_modified: '2026-06-26 14:12:03',
            },
          ],
        },
      },
    ];

    const findings = buildRiskFindings(results);

    expect(findings[0]).toEqual(
      expect.objectContaining({
        severity: 'critical',
        title: expect.stringContaining('WebShell'),
        confidence: expect.any(Number),
        category: 'webshell',
        attackTactic: '持久化 (Persistence)',
        attackTechnique: 'T1505.003 Web Shell',
      }),
    );
    expect(findings[0].affected).toContain('D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell.php');
    expect(findings[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleName: 'file_scan',
          value: 'D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell.php',
        }),
        expect.objectContaining({
          moduleName: 'panel',
          value: expect.stringContaining('D:\\ctf-tools\\phpstudy_pro\\WWW'),
        }),
      ]),
    );
  });

  it('correlates a suspicious process with an external connection on the same pid', () => {
    const results: AnalysisResult[] = [
      {
        module_name: 'process',
        status: 'warning',
        summary: '发现可疑进程',
        details: {
          suspicious_list: [
            {
              pid: 4321,
              name: 'ncat.exe',
              path: 'C:\\Users\\Public\\ncat.exe',
              suspicious_reason: 'dual-use remote shell tool',
            },
          ],
        },
      },
      {
        module_name: 'network',
        status: 'warning',
        summary: '发现外联',
        details: {
          external_connections: [
            {
              protocol: 'TCP',
              pid: 4321,
              remote_address: '198.51.100.22',
              remote_port: 4444,
              state: 'ESTABLISHED',
              is_suspicious_port: true,
            },
          ],
        },
      },
    ];

    const findings = buildRiskFindings(results);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'high',
          title: expect.stringContaining('可疑进程外联'),
          affected: expect.arrayContaining(['ncat.exe', '198.51.100.22:4444']),
          category: 'process-network',
          attackTactic: '命令与控制 (C2)',
          attackTechnique: 'T1071 应用层协议',
        }),
      ]),
    );
  });
});

describe('computeAssessment', () => {
  it('returns compromised when a critical finding exists and groups tactic coverage', () => {
    const assessment = computeAssessment([
      makeFinding({ severity: 'critical', attackTactic: '持久化 (Persistence)' }),
      makeFinding({ severity: 'high', attackTactic: '命令与控制 (C2)' }),
      makeFinding({ severity: 'medium', attackTactic: '持久化 (Persistence)' }),
      makeFinding({ severity: 'low', attackTactic: '命令与控制 (C2)' }),
    ]);

    expect(assessment.verdict).toBe('compromised');
    expect(assessment.severityCounts).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
    });
    expect(assessment.tacticCoverage).toEqual(
      expect.arrayContaining([
        { tactic: '命令与控制 (C2)', count: 2 },
        { tactic: '持久化 (Persistence)', count: 2 },
      ]),
    );
    expect(assessment.tacticCoverage.every((item) => item.count === 2)).toBe(true);
    expect(assessment.headline).toContain('严重风险');
  });

  it('returns suspicious when only high findings exist', () => {
    const assessment = computeAssessment([
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'high', attackTactic: '防御规避 (Defense Evasion)' }),
    ]);

    expect(assessment.verdict).toBe('suspicious');
    expect(assessment.severityCounts.high).toBe(2);
    expect(assessment.headline).toContain('高危风险');
  });

  it('returns attention when only medium findings exist', () => {
    const assessment = computeAssessment([
      makeFinding({ severity: 'medium' }),
      makeFinding({ severity: 'medium', attackTactic: '命令与控制 (C2)' }),
    ]);

    expect(assessment.verdict).toBe('attention');
    expect(assessment.severityCounts.medium).toBe(2);
    expect(assessment.headline).toContain('中风险');
  });

  it('returns clean when no meaningful findings exist', () => {
    const assessment = computeAssessment([]);

    expect(assessment.verdict).toBe('clean');
    expect(assessment.severityCounts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    });
    expect(assessment.headline).toBe('未发现明显风险项');
    expect(assessment.tacticCoverage).toEqual([]);
  });
});

describe('buildMarkdownReport', () => {
  it('produces a markdown summary with verdict, tactics, and findings', () => {
    const findings = [
      makeFinding({
        id: 'webshell-1',
        severity: 'critical',
        category: 'webshell',
        attackTactic: '持久化 (Persistence)',
        attackTechnique: 'T1505.003 Web Shell',
        title: '疑似 WebShell 文件',
        reason: '命中脚本特征',
        confidence: 92,
        affected: ['D:\\www\\shell.php'],
        evidence: [
          {
            moduleName: 'file_scan',
            label: 'shell.php',
            value: 'D:\\www\\shell.php',
            time: '2026-06-26 14:12:03',
          },
        ],
        recommendedActions: ['立即隔离样本'],
      }),
    ];
    const assessment = computeAssessment(findings);

    const report = buildMarkdownReport(findings, assessment, '2026-06-27');

    expect(report).toContain('# Lumina 研判报告');
    expect(report).toContain('研判结论：疑似入侵');
    expect(report).toContain('结论摘要：');
    expect(report).toContain('## ATT&CK 战术覆盖');
    expect(report).toContain('### 1. 疑似 WebShell 文件');
    expect(report).toContain('ATT&CK 技术：T1505.003 Web Shell');
    expect(report).toContain('处置建议');
    expect(report).toContain('立即隔离样本');
  });
});
