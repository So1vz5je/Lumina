import { describe, expect, it } from 'vitest';
import { normalizeWindowsPanelDetection, parseWindowsPanelSections } from './detection';

describe('Windows panel detection model', () => {
  it('normalizes structured analyzer details', () => {
    const data = normalizeWindowsPanelDetection({
      detected_installs: [
        {
          panel_type: 'phpstudy',
          name: 'PhpStudy Pro',
          path: 'C:\\phpstudy_pro',
          site_root: 'C:\\phpstudy_pro\\WWW',
          service_state: 'Running',
          evidence: 'path; service',
          detected: true,
          site_count: 1,
          notes: 'installed',
        },
      ],
      sites: [
        {
          source: 'phpstudy',
          panel_type: 'phpstudy',
          name: 'demo.local',
          path: 'C:\\phpstudy_pro\\WWW\\demo.local',
          state: 'Present',
          bindings: '-',
          owner_panel: 'PhpStudy Pro',
        },
      ],
      services: [
        {
          source: 'phpstudy',
          name: 'Apache2.4',
          display_name: 'Apache2.4',
          state: 'Running',
          start_mode: 'Auto',
          path: 'C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe',
          pid: 2345,
        },
      ],
      logs: [
        {
          source: 'phpstudy',
          path: 'C:\\phpstudy_pro\\COM\\log\\phpstudy.log',
          size: 2048,
          last_modified: '2026-06-25 20:00:00',
          note: 'phpStudy log',
        },
      ],
      diagnostics: ['IIS WebAdministration module is unavailable'],
      statistics: {
        detected_panel_count: 1,
        site_count: 1,
        service_count: 1,
        log_count: 1,
        diagnostic_count: 1,
      },
    });

    expect(data.installs[0]).toMatchObject({
      panelType: 'phpstudy',
      name: 'PhpStudy Pro',
      path: 'C:\\phpstudy_pro',
      siteRoot: 'C:\\phpstudy_pro\\WWW',
      serviceState: 'Running',
      detected: true,
    });
    expect(data.sites[0].ownerPanel).toBe('PhpStudy Pro');
    expect(data.services[0].pid).toBe('2345');
    expect(data.logs[0].sizeText).toBe('2 KB');
    expect(data.diagnostics).toEqual(['IIS WebAdministration module is unavailable']);
    expect(data.statistics.detectedPanelCount).toBe(1);
  });

  it('parses structured PowerShell sections into the same model', () => {
    const output = [
      '===PANELS===',
      JSON.stringify([{ PanelType: 'xampp', Name: 'XAMPP', Path: 'C:\\xampp', SiteRoot: 'C:\\xampp\\htdocs', Detected: true, SiteCount: 2, Notes: 'path exists' }]),
      '===IIS_SITES===',
      JSON.stringify([{ Name: 'Default Web Site', PhysicalPath: 'C:\\inetpub\\wwwroot', State: 'Started', Bindings: '*:80:' }]),
      '===SERVICES===',
      JSON.stringify([{ Source: 'xampp', Name: 'Apache2.4', DisplayName: 'Apache2.4', State: 'Running', StartMode: 'Auto', PathName: 'C:\\xampp\\apache\\bin\\httpd.exe', ProcessId: 42 }]),
      '===LOGS===',
      JSON.stringify([{ Source: 'xampp', Path: 'C:\\xampp\\apache\\logs\\access.log', Length: 1024, LastWriteTime: '2026-06-25T20:00:00', Note: 'Apache log' }]),
      '===DIAGNOSTICS===',
      JSON.stringify(['IIS module missing']),
    ].join('\n');

    const data = parseWindowsPanelSections(output);

    expect(data.installs[0].name).toBe('XAMPP');
    expect(data.iisSites[0].name).toBe('Default Web Site');
    expect(data.services[0].name).toBe('Apache2.4');
    expect(data.logs[0].sizeText).toBe('1 KB');
    expect(data.diagnostics).toContain('IIS module missing');
  });

  it('keeps legacy Windows panel sections readable', () => {
    const data = parseWindowsPanelSections([
      '===PHPSTUDY===',
      'PhpStudy Pro检测到',
      JSON.stringify({ Name: 'demo.local', Length: 4096, LastWriteTime: '2026-05-26T10:30:00' }),
    ].join('\n'));

    expect(data.installs[0].name).toBe('PhpStudy Pro');
    expect(data.sites[0]).toMatchObject({
      name: 'demo.local',
      path: 'C:\\phpstudy_pro\\WWW\\demo.local',
      ownerPanel: 'PhpStudy Pro',
      sizeText: '4 KB',
      lastModified: '2026-05-26',
    });
    expect(data.statistics.detectedPanelCount).toBe(1);
  });
});
