import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../../types/analysis';
import { buildRiskFindings } from './riskEngine';

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
        }),
      ]),
    );
  });
});
