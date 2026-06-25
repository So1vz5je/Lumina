# Windows Panel Detection Design

## Scope

Build the local Windows panel detection experience shown in the Windows application services workspace. This covers the "面板检测" tab in local Windows analysis and the corresponding quick-scan result rendering. Remote Linux BaoTa detection is out of scope except where shared rendering code must avoid regressions.

## Goals

- Detect common Windows web panels and bundled web stacks with useful evidence.
- Show a clearer, denser front-end view for installs, sites, services, logs, and diagnostics.
- Use one structured data contract across the local module detail page and quick-scan results.
- Keep collection read-only and safe for incident response use.

## Detection Coverage

The Windows backend should detect:

- BaoTa Windows from `C:\BtSoft`, related services, registry install entries, site directories, and known config/log locations.
- phpStudy / phpStudy Pro / XiaoPi from common paths such as `C:\phpstudy_pro`, `C:\phpstudy`, and registry install entries.
- XAMPP from `C:\xampp`, services, Apache/MySQL traces, and `htdocs`.
- WampServer from `C:\wamp64`, `C:\wamp`, services, and `www`.
- IIS from WebAdministration when available, with fallback evidence from IIS service state and `C:\inetpub\wwwroot`.

Each detected item should include panel type, display name, evidence source, install path, site root, service state when available, detected flag, site count, and notes. IIS sites should include site name, physical path, state, bindings, and source.

## Data Contract

`PanelAnalyzer` should return `AnalysisResult` with:

- `module_name: "panel"`
- `status: "ok" | "info" | "warning"`
- `summary`: readable Chinese summary without mojibake
- `details.installs`: all known panel candidates with detection evidence
- `details.detected_installs`: detected candidates only
- `details.sites`: normalized sites from IIS and discovered web roots
- `details.iis_sites`: IIS-specific site rows for compatibility with existing quick-scan rendering
- `details.services`: panel-related Windows services
- `details.logs`: log/config files with path, source, size, last modified time, and note
- `details.statistics`: counts for panels, sites, IIS sites, services, and logs
- `details.diagnostics`: non-fatal collection errors, such as missing IIS management module

Keep existing `detected_installs` and `iis_sites` fields so current result rendering keeps working while the detail page moves to the richer shape.

## Front-End Refactor

Refactor the local Windows "面板检测" detail page into a dedicated Windows panel view instead of reusing the Linux BaoTa-oriented renderer.

The page should keep the current workspace location and tab identity, but replace the content with:

- A compact summary strip: detected panels, sites, services, logs, and diagnostics.
- A primary panel table: panel name, type, install path, site root, service state, evidence source, and notes.
- A sites table: site name, path, state, bindings, source, and owning panel.
- A services table: service name, display name, state, start mode, path, and PID when available.
- A logs/config table: source, path, size, last modified time, and note.
- A diagnostics area that only appears when collection produced warnings or errors.

When nothing is detected, show a deliberate empty state with the checked panel families and the collection diagnostics, not a single generic row.

## Integration Points

- Backend: `src-tauri/src/analyzer/windows/panel.rs`
- Scan registration: existing `panel` analyzer registration remains unchanged.
- Module detail page: `src/pages/ModuleDetail.tsx` should route local Windows `panel` data to the new Windows-specific renderer.
- Quick scan results: `src/pages/Results.tsx` should keep using `detected_installs` and `iis_sites`, with optional support for the richer `sites`, `services`, and `logs` sections.
- Tests: extend Rust parser tests and focused frontend tests for the Windows local panel page.

## Error Handling

PowerShell collection should continue when one collector fails. Failures should be captured in `diagnostics` rather than replacing all output. Missing optional tools, such as `WebAdministration`, should be reported as informational diagnostics unless IIS evidence suggests a real collection problem.

## Testing

- Rust unit tests for parsing panel candidates, IIS sites, services, logs, and diagnostics.
- Frontend tests for detected panel rows, IIS site rows, service/log rows, diagnostics, and the no-detection empty state.
- Existing quick-scan result test should still pass with `detected_installs` and `iis_sites`.
- Verification commands:
  - `npm test`
  - `npm run build`
  - `cargo check --manifest-path src-tauri/Cargo.toml`

## Non-Goals

- Mutating panel configuration.
- Reading or displaying panel credentials.
- Deep per-panel database extraction for BaoTa/phpStudy users, FTP accounts, scheduled tasks, or firewall rules.
- Remote Windows SSH collection.
