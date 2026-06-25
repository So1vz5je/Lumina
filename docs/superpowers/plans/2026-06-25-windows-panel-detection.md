# Windows Panel Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a richer local Windows "面板检测" feature with structured backend evidence and a refactored frontend detail page.

**Architecture:** Keep `panel` as the existing scan/module key. The Rust analyzer and the Windows local module command both emit compatible panel evidence sections, then frontend normalization converts them into one `WindowsPanelDetectionData` model consumed by a dedicated Windows panel component. Existing quick-scan fields `detected_installs` and `iis_sites` remain compatible.

**Tech Stack:** Rust/Tauri, PowerShell, React 19, Ant Design 6, Vitest, Cargo tests.

---

### Task 1: Add Frontend Panel Data Normalization

**Files:**
- Create: `src/modules/windowsPanel/detection.ts`
- Create: `src/modules/windowsPanel/detection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/windowsPanel/detection.test.ts` with tests for the new contract and legacy section compatibility:

```ts
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
    });
    expect(data.statistics.detectedPanelCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/windowsPanel/detection.test.ts`

Expected: FAIL because `src/modules/windowsPanel/detection.ts` does not exist.

- [ ] **Step 3: Implement normalization**

Create `src/modules/windowsPanel/detection.ts` with exported types and helpers:

```ts
export interface WindowsPanelInstall {
  key: string;
  panelType: string;
  name: string;
  path: string;
  siteRoot: string;
  serviceState: string;
  evidence: string;
  detected: boolean;
  siteCount: number;
  notes: string;
}

export interface WindowsPanelSite {
  key: string;
  source: string;
  panelType: string;
  name: string;
  path: string;
  state: string;
  bindings: string;
  ownerPanel: string;
  sizeText: string;
  lastModified: string;
}

export interface WindowsPanelService {
  key: string;
  source: string;
  name: string;
  displayName: string;
  state: string;
  startMode: string;
  path: string;
  pid: string;
}

export interface WindowsPanelLog {
  key: string;
  source: string;
  path: string;
  sizeText: string;
  lastModified: string;
  note: string;
}

export interface WindowsPanelStatistics {
  detectedPanelCount: number;
  siteCount: number;
  iisSiteCount: number;
  serviceCount: number;
  logCount: number;
  diagnosticCount: number;
}

export interface WindowsPanelDetectionData {
  installs: WindowsPanelInstall[];
  detectedInstalls: WindowsPanelInstall[];
  sites: WindowsPanelSite[];
  iisSites: WindowsPanelSite[];
  services: WindowsPanelService[];
  logs: WindowsPanelLog[];
  diagnostics: string[];
  statistics: WindowsPanelStatistics;
}
```

Add `normalizeWindowsPanelDetection(input: unknown): WindowsPanelDetectionData`, `parseWindowsPanelSections(output: string): WindowsPanelDetectionData`, `formatByteCount`, `readString`, `readNumber`, `parseJsonRecords`, and legacy section handling for `PHPSTUDY`, `XAMPP`, `WAMPSERVER`, `BAOTA_WIN`, and `IIS`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/windowsPanel/detection.test.ts`

Expected: PASS.

### Task 2: Add Dedicated Windows Panel View

**Files:**
- Create: `src/components/windows/WindowsPanelDetectionView.tsx`
- Modify: `src/App.css`
- Modify: `src/pages/ModuleDetail.tsx`
- Test: `src/pages/moduleDetailWindowsParsers.test.tsx`

- [ ] **Step 1: Write the failing frontend render test**

Append a test to `src/pages/moduleDetailWindowsParsers.test.tsx`:

```tsx
it('renders the refactored Windows panel detection workspace with installs, sites, services, logs, and diagnostics', async () => {
  renderLocalWindowsModule(
    'panel',
    [
      '===PANELS===',
      JSON.stringify([{ PanelType: 'phpstudy', Name: 'PhpStudy Pro', Path: 'C:\\phpstudy_pro', SiteRoot: 'C:\\phpstudy_pro\\WWW', Detected: true, SiteCount: 1, ServiceState: 'Running', Evidence: 'path; service', Notes: 'installed' }]),
      '===IIS_SITES===',
      JSON.stringify([{ Name: 'Default Web Site', PhysicalPath: 'C:\\inetpub\\wwwroot', State: 'Started', Bindings: '*:80:' }]),
      '===SERVICES===',
      JSON.stringify([{ Source: 'phpstudy', Name: 'Apache2.4', DisplayName: 'Apache2.4', State: 'Running', StartMode: 'Auto', PathName: 'C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe', ProcessId: 1234 }]),
      '===LOGS===',
      JSON.stringify([{ Source: 'phpstudy', Path: 'C:\\phpstudy_pro\\COM\\log\\phpstudy.log', Length: 2048, LastWriteTime: '2026-06-25T20:00:00', Note: 'phpStudy log' }]),
      '===DIAGNOSTICS===',
      JSON.stringify(['IIS WebAdministration module is unavailable']),
    ].join('\n'),
  );

  expect(await screen.findByText('PhpStudy Pro')).toBeInTheDocument();
  expect(screen.getByText('C:\\phpstudy_pro')).toBeInTheDocument();
  expect(screen.getByText('Default Web Site')).toBeInTheDocument();
  expect(screen.getByText('Apache2.4')).toBeInTheDocument();
  expect(screen.getByText('C:\\phpstudy_pro\\COM\\log\\phpstudy.log')).toBeInTheDocument();
  expect(screen.getByText('IIS WebAdministration module is unavailable')).toBeInTheDocument();
});
```

Add a no-detection test:

```tsx
it('renders a deliberate Windows panel empty state when no panel is detected', async () => {
  renderLocalWindowsModule(
    'panel',
    [
      '===PANELS===',
      JSON.stringify([{ PanelType: 'xampp', Name: 'XAMPP', Path: 'C:\\xampp', SiteRoot: 'C:\\xampp\\htdocs', Detected: false, SiteCount: 0, Notes: 'not found' }]),
      '===IIS_SITES===',
      '[]',
      '===SERVICES===',
      '[]',
      '===LOGS===',
      '[]',
      '===DIAGNOSTICS===',
      JSON.stringify(['Checked BaoTa Windows, phpStudy, XAMPP, WampServer, and IIS']),
    ].join('\n'),
  );

  expect(await screen.findByText('未发现常见 Windows Web 面板')).toBeInTheDocument();
  expect(screen.getByText(/BaoTa Windows/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/moduleDetailWindowsParsers.test.tsx`

Expected: FAIL because the dedicated view and structured parser are not yet wired into `ModuleDetail`.

- [ ] **Step 3: Implement the component**

Create `WindowsPanelDetectionView.tsx`. It should import `normalizeWindowsPanelDetection` and render:

- `.windows-panel-detection`
- `.windows-panel-summary-strip`
- `.windows-panel-empty` when `detectedInstalls`, `sites`, `services`, and `logs` are empty
- Ant Design `Tabs` with keys `installs`, `sites`, `services`, `logs`, and `diagnostics`
- `Table` columns matching the model fields

- [ ] **Step 4: Wire ModuleDetail to the new model**

In `src/pages/ModuleDetail.tsx`:

- Import `WindowsPanelDetectionView` and `parseWindowsPanelSections`.
- In the `panel` branch of `parseAndSetData`, when the output contains Windows panel section markers, call `parseWindowsPanelSections(output)`, then `setRawOutput(JSON.stringify(data))`.
- Keep the existing Linux BaoTa parsing branch for remote/Linux panel output.
- In `renderContent`, route `moduleKey === 'panel' && isWindowsLocalMode` to `<WindowsPanelDetectionView data={rawOutput ? JSON.parse(rawOutput) : null} isDarkMode={isDarkMode} />`.

- [ ] **Step 5: Add CSS**

Add scoped styles in `src/App.css` for `.windows-panel-detection`, `.windows-panel-summary-strip`, `.windows-panel-empty`, `.windows-panel-diagnostics`, and table wrappers. Keep cards at 8px radius or less and do not introduce decorative backgrounds.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modules/windowsPanel/detection.test.ts src/pages/moduleDetailWindowsParsers.test.tsx`

Expected: PASS.

### Task 3: Expand Rust Panel Analyzer Contract

**Files:**
- Modify: `src-tauri/src/analyzer/windows/panel.rs`

- [ ] **Step 1: Write the failing Rust parser test**

Add a test to `panel.rs`:

```rust
#[test]
fn parses_services_logs_and_diagnostics() {
    let output = r#"===PANELS===
[{"PanelType":"phpstudy","Name":"PhpStudy Pro","Path":"C:\\phpstudy_pro","SiteRoot":"C:\\phpstudy_pro\\WWW","Detected":true,"SiteCount":1,"ServiceState":"Running","Evidence":"path; service","Notes":"installed"}]
===IIS_SITES===
[{"Name":"Default Web Site","State":"Started","PhysicalPath":"C:\\inetpub\\wwwroot","Bindings":"*:80:"}]
===SERVICES===
[{"Source":"phpstudy","Name":"Apache2.4","DisplayName":"Apache2.4","State":"Running","StartMode":"Auto","PathName":"C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe","ProcessId":1234}]
===LOGS===
[{"Source":"phpstudy","Path":"C:\\phpstudy_pro\\COM\\log\\phpstudy.log","Length":2048,"LastWriteTime":"2026-06-25T20:00:00","Note":"phpStudy log"}]
===DIAGNOSTICS===
["IIS WebAdministration module is unavailable"]"#;

    let parsed = PanelAnalyzer::parse_panel_output(output);

    assert_eq!(parsed.installs.len(), 1);
    assert_eq!(parsed.installs[0].site_root, "C:\\\\phpstudy_pro\\\\WWW");
    assert_eq!(parsed.iis_sites.len(), 1);
    assert_eq!(parsed.services.len(), 1);
    assert_eq!(parsed.services[0].pid, "1234");
    assert_eq!(parsed.logs.len(), 1);
    assert_eq!(parsed.diagnostics[0], "IIS WebAdministration module is unavailable");
}
```

- [ ] **Step 2: Run the Rust test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml analyzer::windows::panel::tests::parses_services_logs_and_diagnostics`

Expected: FAIL because `parse_panel_output` still returns only installs and IIS sites.

- [ ] **Step 3: Implement the expanded parser and structs**

In `panel.rs`, add:

- `PanelServiceEntry`
- `PanelLogEntry`
- `PanelParsedOutput`
- fields `site_root`, `service_state`, and `evidence` to `PanelInstallEntry`
- parser handling for `SERVICES`, `LOGS`, and `DIAGNOSTICS`

Update `run()` so `details` includes `installs`, `detected_installs`, `sites`, `iis_sites`, `services`, `logs`, `diagnostics`, `statistics`, and `raw_output`.

- [ ] **Step 4: Update PowerShell collection**

Replace the existing panel script with a collector that emits:

- `===PANELS===`
- `===IIS_SITES===`
- `===SERVICES===`
- `===LOGS===`
- `===DIAGNOSTICS===`

It should check common paths, registry uninstall entries, panel-related service names, IIS sites, web roots, and known log/config files. It must not read credential files or panel databases.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml analyzer::windows::panel`

Expected: PASS.

### Task 4: Improve Quick-Scan Panel Result Sections

**Files:**
- Modify: `src/pages/Results.tsx`
- Modify: `src/pages/Results.test.tsx`

- [ ] **Step 1: Write the failing result-rendering assertion**

Extend the existing panel result test with:

```tsx
services: [
  {
    source: 'phpstudy',
    name: 'Apache2.4',
    display_name: 'Apache2.4',
    state: 'Running',
    start_mode: 'Auto',
    path: 'C:\\phpstudy_pro\\Extensions\\Apache\\bin\\httpd.exe',
    pid: '1234',
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
```

Assert after selecting the panel result:

```tsx
expect(screen.getByText('Apache2.4')).toBeInTheDocument();
expect(screen.getByText('C:\\phpstudy_pro\\COM\\log\\phpstudy.log')).toBeInTheDocument();
expect(screen.getByText('IIS WebAdministration module is unavailable')).toBeInTheDocument();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/Results.test.tsx`

Expected: FAIL because panel services/logs/diagnostics are not rendered.

- [ ] **Step 3: Update panel result sections**

In `Results.tsx`, within `result.module_name === 'panel'`, add sections:

- `相关服务` from `details.services`
- `日志/配置文件` from `details.logs`
- `采集诊断` from `details.diagnostics`

Keep existing `面板/集成环境` and `IIS 站点` behavior.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/Results.test.tsx`

Expected: PASS.

### Task 5: Verification

**Files:**
- No new files

- [ ] **Step 1: Run focused frontend tests**

Run: `npx vitest run src/modules/windowsPanel/detection.test.ts src/pages/moduleDetailWindowsParsers.test.tsx src/pages/Results.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run frontend suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Run Rust validation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.
