use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

struct PanelDefinition {
    panel_type: &'static str,
    name: &'static str,
    markers: &'static [&'static str],
    site_dirs: &'static [&'static str],
}

const PANEL_DEFINITIONS: &[PanelDefinition] = &[
    PanelDefinition {
        panel_type: "baota_windows",
        name: "BaoTa Windows",
        markers: &["btsoft", "btpanel"],
        site_dirs: &["wwwroot", "websites"],
    },
    PanelDefinition {
        panel_type: "phpstudy",
        name: "PhpStudy Pro",
        markers: &["phpstudy_pro", "phpstudy", "xp.cn"],
        site_dirs: &["www"],
    },
    PanelDefinition {
        panel_type: "xampp",
        name: "XAMPP",
        markers: &["xampp"],
        site_dirs: &["htdocs"],
    },
    PanelDefinition {
        panel_type: "wampserver",
        name: "WampServer",
        markers: &["wamp64", "wamp", "wampserver"],
        site_dirs: &["www"],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelInstallEntry {
    pub panel_type: String,
    pub name: String,
    pub path: String,
    pub site_root: String,
    pub service_state: String,
    pub evidence: String,
    pub detected: bool,
    pub site_count: usize,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSiteEntry {
    pub source: String,
    pub panel_type: String,
    pub name: String,
    pub path: String,
    pub state: String,
    pub bindings: String,
    pub owner_panel: String,
    pub size: String,
    pub last_modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelServiceEntry {
    pub source: String,
    pub name: String,
    pub display_name: String,
    pub state: String,
    pub start_mode: String,
    pub path: String,
    pub pid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelLogEntry {
    pub source: String,
    pub path: String,
    pub size: String,
    pub last_modified: String,
    pub note: String,
}

#[derive(Debug, Clone, Default)]
pub struct PanelParsedOutput {
    pub installs: Vec<PanelInstallEntry>,
    pub sites: Vec<PanelSiteEntry>,
    pub iis_sites: Vec<PanelSiteEntry>,
    pub services: Vec<PanelServiceEntry>,
    pub logs: Vec<PanelLogEntry>,
    pub diagnostics: Vec<String>,
}

pub struct PanelAnalyzer;

impl PanelAnalyzer {
    fn run_powershell(script: &str) -> String {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                if stdout.trim().is_empty() {
                    String::from_utf8_lossy(&output.stderr).to_string()
                } else {
                    stdout
                }
            })
            .unwrap_or_default()
    }

    fn value_to_string(value: Option<&Value>) -> String {
        match value {
            Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| Self::value_to_string(Some(item)))
                .filter(|item| !item.is_empty() && item != "-")
                .collect::<Vec<_>>()
                .join("; "),
            Some(Value::Object(_)) => value.unwrap().to_string(),
            _ => "-".to_string(),
        }
    }

    fn parse_json_items(content: &str) -> Vec<Value> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Array(items)) => items,
            Ok(Value::Object(item)) => vec![Value::Object(item)],
            _ => Vec::new(),
        }
    }

    fn normalize_windows_path(path: &str) -> String {
        path.trim()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string()
    }

    fn definition_for_indexed_path(path: &str) -> Option<&'static PanelDefinition> {
        let normalized = Self::normalize_windows_path(path);
        let segments: Vec<String> = normalized
            .split('\\')
            .map(|segment| segment.to_ascii_lowercase())
            .collect();

        PANEL_DEFINITIONS.iter().find(|definition| {
            definition.markers.iter().any(|marker| {
                let marker = marker.to_ascii_lowercase();
                segments.iter().any(|segment| segment == &marker)
            })
        })
    }

    fn derive_root_for_definition(path: &str, definition: &PanelDefinition) -> Option<String> {
        let normalized = Self::normalize_windows_path(path);
        let segments: Vec<&str> = normalized.split('\\').collect();

        for (index, segment) in segments.iter().enumerate() {
            if definition
                .markers
                .iter()
                .any(|marker| segment.eq_ignore_ascii_case(marker))
            {
                return Some(segments[..=index].join("\\"));
            }
        }

        None
    }

    fn derive_site_root(path: &str, install_path: &str, definition: &PanelDefinition) -> String {
        let normalized = Self::normalize_windows_path(path);
        let segments: Vec<&str> = normalized.split('\\').collect();

        for (index, segment) in segments.iter().enumerate() {
            if definition
                .site_dirs
                .iter()
                .any(|site_dir| segment.eq_ignore_ascii_case(site_dir))
            {
                return segments[..=index].join("\\");
            }
        }

        definition
            .site_dirs
            .first()
            .map(|site_dir| format!("{}\\{}", install_path, site_dir))
            .unwrap_or_else(|| install_path.to_string())
    }

    fn append_evidence(existing: &str, token: &str) -> String {
        if existing.trim().is_empty() || existing == "-" {
            return token.to_string();
        }

        if existing
            .split(';')
            .any(|part| part.trim().eq_ignore_ascii_case(token))
        {
            existing.to_string()
        } else {
            format!("{}; {}", existing, token)
        }
    }

    fn upsert_indexed_install(
        parsed: &mut PanelParsedOutput,
        definition: &PanelDefinition,
        install_path: &str,
        site_root: &str,
    ) {
        let existing_index = parsed.installs.iter().position(|install| {
            install.panel_type == definition.panel_type
                && install.path.eq_ignore_ascii_case(install_path)
        });
        let fallback_index = parsed
            .installs
            .iter()
            .position(|install| install.panel_type == definition.panel_type && !install.detected);
        let index = existing_index.or(fallback_index).unwrap_or_else(|| {
            parsed.installs.push(PanelInstallEntry {
                panel_type: definition.panel_type.to_string(),
                name: definition.name.to_string(),
                path: install_path.to_string(),
                site_root: site_root.to_string(),
                service_state: "-".to_string(),
                evidence: "everything_index".to_string(),
                detected: true,
                site_count: 0,
                notes: "indexed by Everything".to_string(),
            });
            parsed.installs.len() - 1
        });

        let install = &mut parsed.installs[index];
        install.name = definition.name.to_string();
        install.path = install_path.to_string();
        install.site_root = site_root.to_string();
        install.detected = true;
        install.evidence = Self::append_evidence(&install.evidence, "everything_index");
        if install.notes == "-" || install.notes == "not found" {
            install.notes = "indexed by Everything".to_string();
        }
    }

    fn derive_site_from_indexed_path(path: &str, site_root: &str) -> Option<(String, String)> {
        let normalized_path = Self::normalize_windows_path(path);
        let normalized_root = Self::normalize_windows_path(site_root);

        if !normalized_path
            .to_ascii_lowercase()
            .starts_with(&normalized_root.to_ascii_lowercase())
        {
            return None;
        }

        let relative = normalized_path[normalized_root.len()..].trim_start_matches('\\');
        let site_name = relative.split('\\').next().unwrap_or_default().trim();
        if site_name.is_empty() {
            return None;
        }

        Some((
            site_name.to_string(),
            format!("{}\\{}", normalized_root, site_name),
        ))
    }

    fn upsert_indexed_site(
        parsed: &mut PanelParsedOutput,
        definition: &PanelDefinition,
        site_name: &str,
        site_path: &str,
        last_modified: &str,
    ) {
        if parsed
            .sites
            .iter()
            .any(|site| site.path.eq_ignore_ascii_case(site_path))
        {
            return;
        }

        parsed.sites.push(PanelSiteEntry {
            source: "everything".to_string(),
            panel_type: definition.panel_type.to_string(),
            name: site_name.to_string(),
            path: site_path.to_string(),
            state: "Indexed".to_string(),
            bindings: "-".to_string(),
            owner_panel: definition.name.to_string(),
            size: "-".to_string(),
            last_modified: if last_modified == "-" {
                "-".to_string()
            } else {
                last_modified.to_string()
            },
        });
    }

    fn is_indexed_log_or_config(path: &str, extension: &str, name: &str) -> bool {
        let lower_path = path.to_ascii_lowercase();
        let lower_name = name.to_ascii_lowercase();
        let lower_extension = extension.trim_start_matches('.').to_ascii_lowercase();

        matches!(
            lower_extension.as_str(),
            "log" | "conf" | "config" | "ini" | "json"
        ) || lower_name.contains("log")
            || lower_name.contains("conf")
            || lower_path.contains("\\logs\\")
            || lower_path.contains("\\log\\")
    }

    fn is_indexed_shortcut_noise(path: &str, extension: &str) -> bool {
        let lower_path = Self::normalize_windows_path(path).to_ascii_lowercase();
        let lower_extension = extension.trim_start_matches('.').to_ascii_lowercase();

        matches!(lower_extension.as_str(), "lnk" | "url")
            || lower_path.contains("\\microsoft\\windows\\start menu\\")
            || lower_path.contains("\\programdata\\microsoft\\windows\\start menu\\")
    }

    fn upsert_indexed_log(
        parsed: &mut PanelParsedOutput,
        definition: &PanelDefinition,
        path: &str,
        size: &str,
        last_modified: &str,
    ) {
        if parsed
            .logs
            .iter()
            .any(|log| log.path.eq_ignore_ascii_case(path))
        {
            return;
        }

        parsed.logs.push(PanelLogEntry {
            source: definition.panel_type.to_string(),
            path: path.to_string(),
            size: size.to_string(),
            last_modified: last_modified.to_string(),
            note: "Everything indexed log/config metadata".to_string(),
        });
    }

    fn parse_everything_matches(parsed: &mut PanelParsedOutput, content: &str) {
        for item in Self::parse_json_items(content) {
            let path = Self::value_to_string(item.get("FullPath").or_else(|| item.get("Path")));
            if path == "-" {
                continue;
            }

            let Some(definition) = Self::definition_for_indexed_path(&path) else {
                continue;
            };
            let Some(install_path) = Self::derive_root_for_definition(&path, definition) else {
                continue;
            };

            let site_root = Self::derive_site_root(&path, &install_path, definition);
            let name = Self::value_to_string(item.get("Name"));
            let extension = Self::value_to_string(item.get("Extension"));
            if Self::is_indexed_shortcut_noise(&path, &extension) {
                continue;
            }
            let size = Self::value_to_string(item.get("Length").or_else(|| item.get("Size")));
            let last_modified = Self::value_to_string(
                item.get("LastWriteTime")
                    .or_else(|| item.get("LastModified"))
                    .or_else(|| item.get("DateModified")),
            );

            Self::upsert_indexed_install(parsed, definition, &install_path, &site_root);

            if let Some((site_name, site_path)) =
                Self::derive_site_from_indexed_path(&path, &site_root)
            {
                Self::upsert_indexed_site(
                    parsed,
                    definition,
                    &site_name,
                    &site_path,
                    &last_modified,
                );
            }

            if Self::is_indexed_log_or_config(&path, &extension, &name) {
                Self::upsert_indexed_log(parsed, definition, &path, &size, &last_modified);
            }
        }
    }

    fn recalculate_install_site_counts(parsed: &mut PanelParsedOutput) {
        for install in &mut parsed.installs {
            let site_root = install.site_root.to_ascii_lowercase();
            let panel_type = install.panel_type.clone();
            let site_count = parsed
                .sites
                .iter()
                .filter(|site| {
                    site.panel_type == panel_type
                        && (site_root == "-"
                            || site.path.to_ascii_lowercase().starts_with(&site_root))
                })
                .count();
            if site_count > install.site_count {
                install.site_count = site_count;
            }
        }
    }

    fn parse_panel_output(output: &str) -> PanelParsedOutput {
        let mut parsed = PanelParsedOutput::default();
        let parts: Vec<&str> = output.split("===").collect();
        let mut i = 1;

        while i + 1 < parts.len() {
            let section = parts[i].trim();
            let content = parts[i + 1].trim();

            match section {
                "PANELS" => {
                    for item in Self::parse_json_items(content) {
                        let panel_type = Self::value_to_string(item.get("PanelType"));
                        let name = Self::value_to_string(item.get("Name"));
                        let path = Self::value_to_string(item.get("Path"));
                        let site_root = Self::value_to_string(item.get("SiteRoot"));
                        let service_state = Self::value_to_string(item.get("ServiceState"));
                        let evidence = Self::value_to_string(item.get("Evidence"));
                        let detected = matches!(item.get("Detected"), Some(Value::Bool(true)));
                        let site_count = item
                            .get("SiteCount")
                            .and_then(Value::as_u64)
                            .unwrap_or_default() as usize;
                        let notes = Self::value_to_string(item.get("Notes"));

                        parsed.installs.push(PanelInstallEntry {
                            panel_type,
                            name,
                            path,
                            site_root,
                            service_state,
                            evidence,
                            detected,
                            site_count,
                            notes,
                        });
                    }
                }
                "SITES" => {
                    for item in Self::parse_json_items(content) {
                        parsed.sites.push(PanelSiteEntry {
                            source: Self::value_to_string(item.get("Source")),
                            panel_type: Self::value_to_string(item.get("PanelType")),
                            name: Self::value_to_string(item.get("Name")),
                            path: Self::value_to_string(item.get("Path")),
                            state: Self::value_to_string(item.get("State")),
                            bindings: Self::value_to_string(item.get("Bindings")),
                            owner_panel: Self::value_to_string(item.get("OwnerPanel")),
                            size: Self::value_to_string(
                                item.get("Length").or_else(|| item.get("Size")),
                            ),
                            last_modified: Self::value_to_string(
                                item.get("LastWriteTime")
                                    .or_else(|| item.get("LastModified")),
                            ),
                        });
                    }
                }
                "IIS_SITES" => {
                    for item in Self::parse_json_items(content) {
                        parsed.iis_sites.push(PanelSiteEntry {
                            source: "IIS".to_string(),
                            panel_type: "iis".to_string(),
                            name: Self::value_to_string(item.get("Name")),
                            path: Self::value_to_string(item.get("PhysicalPath")),
                            state: Self::value_to_string(item.get("State")),
                            bindings: Self::value_to_string(item.get("Bindings")),
                            owner_panel: "IIS".to_string(),
                            size: Self::value_to_string(
                                item.get("Length").or_else(|| item.get("Size")),
                            ),
                            last_modified: Self::value_to_string(
                                item.get("LastWriteTime")
                                    .or_else(|| item.get("LastModified")),
                            ),
                        });
                    }
                }
                "SERVICES" => {
                    for item in Self::parse_json_items(content) {
                        parsed.services.push(PanelServiceEntry {
                            source: Self::value_to_string(item.get("Source")),
                            name: Self::value_to_string(item.get("Name")),
                            display_name: Self::value_to_string(item.get("DisplayName")),
                            state: Self::value_to_string(item.get("State")),
                            start_mode: Self::value_to_string(
                                item.get("StartMode").or_else(|| item.get("StartType")),
                            ),
                            path: Self::value_to_string(
                                item.get("PathName").or_else(|| item.get("Path")),
                            ),
                            pid: Self::value_to_string(
                                item.get("ProcessId").or_else(|| item.get("Pid")),
                            ),
                        });
                    }
                }
                "LOGS" => {
                    for item in Self::parse_json_items(content) {
                        parsed.logs.push(PanelLogEntry {
                            source: Self::value_to_string(item.get("Source")),
                            path: Self::value_to_string(item.get("Path")),
                            size: Self::value_to_string(
                                item.get("Length").or_else(|| item.get("Size")),
                            ),
                            last_modified: Self::value_to_string(
                                item.get("LastWriteTime")
                                    .or_else(|| item.get("LastModified")),
                            ),
                            note: Self::value_to_string(item.get("Note")),
                        });
                    }
                }
                "DIAGNOSTICS" => {
                    for item in Self::parse_json_items(content) {
                        let message = Self::value_to_string(Some(&item));
                        if !message.is_empty() && message != "-" {
                            parsed.diagnostics.push(message);
                        }
                    }
                }
                "ES_MATCHES" => {
                    Self::parse_everything_matches(&mut parsed, content);
                }
                _ => {}
            }

            i += 2;
        }

        Self::recalculate_install_site_counts(&mut parsed);
        parsed
    }
}

impl Analyzer for PanelAnalyzer {
    fn name(&self) -> &str {
        "Panel Detection"
    }

    fn run(&self) -> AnalysisResult {
        let script = r#"$ErrorActionPreference = 'SilentlyContinue'
$diagnostics = New-Object System.Collections.Generic.List[string]

function Convert-ToJsonArray([object[]]$items, [int]$depth = 6) {
  $array = @($items)
  ConvertTo-Json -Compress -Depth $depth -InputObject $array
}

function Test-ExistingPath($path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  return Test-Path -LiteralPath $path
}

function Get-FirstExistingPath($paths) {
  foreach ($path in @($paths)) {
    if (Test-ExistingPath $path) { return $path }
  }
  return ''
}

function Get-SiteCount($path) {
  if (-not (Test-ExistingPath $path)) { return 0 }
  return @((Get-ChildItem -LiteralPath $path -Directory -ErrorAction SilentlyContinue)).Count
}

function Get-PathMetadata($source, $path, $note) {
  if (-not (Test-ExistingPath $path)) { return $null }
  $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $length = if ($item.PSIsContainer) { 0 } else { [int64]$item.Length }
  [pscustomobject]@{
    Source=$source
    Path=$item.FullName
    Length=$length
    LastWriteTime=$item.LastWriteTime.ToString('s')
    Note=$note
  }
}

function Get-PanelSites($panelType, $panelName, $siteRoot) {
  if (-not (Test-ExistingPath $siteRoot)) { return @() }
  @((Get-ChildItem -LiteralPath $siteRoot -Directory -ErrorAction SilentlyContinue) | ForEach-Object {
    [pscustomobject]@{
      Source=$panelType
      PanelType=$panelType
      Name=$_.Name
      Path=$_.FullName
      State='Present'
      Bindings='-'
      OwnerPanel=$panelName
      Length=0
      LastWriteTime=$_.LastWriteTime.ToString('s')
    }
  })
}

function Test-TextMatch($text, $patterns) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  foreach ($pattern in @($patterns)) {
    if (-not [string]::IsNullOrWhiteSpace($pattern) -and $text -like "*$pattern*") {
      return $true
    }
  }
  return $false
}

function Get-RelatedServices($source, $patterns, $pathHints) {
  $services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue)
  @($services | Where-Object {
    (Test-TextMatch $_.Name $patterns) -or
    (Test-TextMatch $_.DisplayName $patterns) -or
    (Test-TextMatch $_.PathName $patterns) -or
    (Test-TextMatch $_.PathName $pathHints)
  } | ForEach-Object {
    [pscustomobject]@{
      Source=$source
      Name=$_.Name
      DisplayName=$_.DisplayName
      State=$_.State
      StartMode=$_.StartMode
      PathName=$_.PathName
      ProcessId=$_.ProcessId
    }
  })
}

function Get-UninstallEvidence($patterns) {
  $keys = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $keys) {
    foreach ($entry in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) {
      if ((Test-TextMatch $entry.DisplayName $patterns) -or (Test-TextMatch $entry.InstallLocation $patterns)) {
        return $entry.DisplayName
      }
    }
  }
  return ''
}

$manifestEsPath = '__CARGO_MANIFEST_DIR__\bin\everything\es.exe'

function Get-EsPath {
  $processPath = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
  $processDir = if ([string]::IsNullOrWhiteSpace($processPath)) { '' } else { Split-Path -Parent $processPath }
  $cwd = (Get-Location).Path
  $candidates = @(
    $env:LUMINA_ES_PATH,
    $manifestEsPath,
    (Join-Path $cwd 'src-tauri\bin\everything\es.exe'),
    (Join-Path $cwd 'bin\everything\es.exe'),
    (Join-Path $processDir 'bin\everything\es.exe'),
    (Join-Path $processDir 'resources\bin\everything\es.exe'),
    'C:\Program Files\Everything\es.exe',
    'C:\Program Files (x86)\Everything\es.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-ExistingPath $candidate) { return $candidate }
  }
  return ''
}

function Convert-EsLine($line, $query) {
  if ([string]::IsNullOrWhiteSpace($line)) { return $null }
  $columns = $line.TrimEnd("`r").Split("`t")
  if ($columns.Count -lt 6) { return $null }
  $length = 0
  [void][Int64]::TryParse(($columns[4] -replace ',', '').Trim(), [ref]$length)
  [pscustomobject]@{
    Source='everything'
    Query=$query
    FullPath=$columns[0].TrimStart([char]0xfeff)
    Name=$columns[1]
    ParentPath=$columns[2]
    Extension=$columns[3]
    Length=$length
    LastWriteTime=$columns[5]
  }
}

function Invoke-EsQuery($esPath, $query, $limit) {
  if ([string]::IsNullOrWhiteSpace($esPath)) { return @() }
  $args = @(
    '-tsv',
    '-no-header',
    '-full-path-and-name',
    '-name',
    '-path-column',
    '-extension',
    '-size',
    '-date-modified',
    '-date-format',
    '1',
    '-size-format',
    '1',
    '-no-digit-grouping',
    '-timeout',
    '3000',
    '-n',
    [string]$limit,
    $query
  )
  $lines = @(& $esPath @args 2>$null)
  @($lines | ForEach-Object { Convert-EsLine $_ $query } | Where-Object { $null -ne $_ })
}

function Add-UniqueEsMatch($rows, $seen, $match) {
  if ($null -eq $match -or [string]::IsNullOrWhiteSpace($match.FullPath)) { return }
  $key = $match.FullPath.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { return }
  $seen[$key] = $true
  $rows.Add($match) | Out-Null
}

$panelDefinitions = @(
  @{
    PanelType='baota_windows'
    Name='BaoTa Windows'
    Paths=@('C:\BtSoft')
    SiteRoots=@('C:\wwwroot', 'C:\BtSoft\wwwroot')
    ServicePatterns=@('bt', 'baota', 'BtWeb', 'BtTask', 'nginx', 'mysql')
    RegistryPatterns=@('bt.cn', 'baota', 'BaoTa')
    LogPaths=@('C:\BtSoft\panel\logs\error.log', 'C:\BtSoft\logs\error.log', 'C:\BtSoft\wwwlogs')
  },
  @{
    PanelType='phpstudy'
    Name='PhpStudy Pro'
    Paths=@('C:\phpstudy_pro', 'C:\phpstudy', 'C:\xp.cn')
    SiteRoots=@('C:\phpstudy_pro\WWW', 'C:\phpstudy\WWW', 'C:\xp.cn\WWW')
    ServicePatterns=@('phpstudy', 'Apache', 'Apache2.4', 'mysql', 'nginx')
    RegistryPatterns=@('phpStudy', 'xp.cn')
    LogPaths=@('C:\phpstudy_pro\COM\log\phpstudy.log', 'C:\phpstudy_pro\Extensions\Apache2.4.39\logs\access.log', 'C:\phpstudy_pro\Extensions\Nginx1.15.11\logs\access.log')
  },
  @{
    PanelType='xampp'
    Name='XAMPP'
    Paths=@('C:\xampp')
    SiteRoots=@('C:\xampp\htdocs')
    ServicePatterns=@('xampp', 'Apache', 'Apache2.4', 'mysql', 'mariadb')
    RegistryPatterns=@('XAMPP')
    LogPaths=@('C:\xampp\apache\logs\access.log', 'C:\xampp\apache\logs\error.log', 'C:\xampp\mysql\data\mysql_error.log')
  },
  @{
    PanelType='wampserver'
    Name='WampServer'
    Paths=@('C:\wamp64', 'C:\wamp')
    SiteRoots=@('C:\wamp64\www', 'C:\wamp\www')
    ServicePatterns=@('wamp', 'wampapache', 'wampmysqld', 'Apache', 'mysql')
    RegistryPatterns=@('WampServer', 'WAMP')
    LogPaths=@('C:\wamp64\logs\apache_error.log', 'C:\wamp64\logs\apache_access.log', 'C:\wamp\logs\apache_error.log')
  }
)

$panelRows = New-Object System.Collections.Generic.List[object]
$siteRows = New-Object System.Collections.Generic.List[object]
$serviceRows = New-Object System.Collections.Generic.List[object]
$logRows = New-Object System.Collections.Generic.List[object]
$esMatches = New-Object System.Collections.Generic.List[object]

$esPath = Get-EsPath
if ([string]::IsNullOrWhiteSpace($esPath)) {
  $diagnostics.Add('Everything ES.exe is unavailable; using path/service/registry fallback') | Out-Null
} else {
  $diagnostics.Add("Everything ES.exe: $esPath") | Out-Null
  $esSeen = @{}
  $esQueries = @(
    'phpstudy_pro',
    'phpstudy',
    'xp.cn',
    'BtSoft',
    'btpanel',
    'xampp',
    'wamp64',
    'wampserver',
    'httpd.conf',
    'nginx.conf',
    'phpstudy.log',
    'access.log',
    'error.log'
  )
  foreach ($query in $esQueries) {
    foreach ($match in @(Invoke-EsQuery $esPath $query 80)) {
      Add-UniqueEsMatch $esMatches $esSeen $match
    }
  }
  $diagnostics.Add("Everything index matches: $($esMatches.Count)") | Out-Null
}

foreach ($panel in $panelDefinitions) {
  $installPath = Get-FirstExistingPath $panel.Paths
  $siteRoot = Get-FirstExistingPath $panel.SiteRoots
  $registryName = Get-UninstallEvidence $panel.RegistryPatterns
  $services = @(Get-RelatedServices $panel.PanelType $panel.ServicePatterns $panel.Paths)
  $detected = (-not [string]::IsNullOrWhiteSpace($installPath)) -or (-not [string]::IsNullOrWhiteSpace($registryName)) -or ($services.Count -gt 0)
  $siteCount = Get-SiteCount $siteRoot
  $evidenceParts = @()
  if (-not [string]::IsNullOrWhiteSpace($installPath)) { $evidenceParts += 'path' }
  if (-not [string]::IsNullOrWhiteSpace($registryName)) { $evidenceParts += 'registry' }
  if ($services.Count -gt 0) { $evidenceParts += 'service' }
  if ($siteCount -gt 0) { $evidenceParts += 'site_root' }
  $serviceState = if ($services.Count -gt 0) { (@($services | Select-Object -ExpandProperty State -Unique) -join '; ') } else { '-' }

  $panelRows.Add([pscustomobject]@{
    PanelType=$panel.PanelType
    Name=$panel.Name
    Path=if ([string]::IsNullOrWhiteSpace($installPath)) { $panel.Paths[0] } else { $installPath }
    SiteRoot=if ([string]::IsNullOrWhiteSpace($siteRoot)) { $panel.SiteRoots[0] } else { $siteRoot }
    Detected=$detected
    SiteCount=$siteCount
    ServiceState=$serviceState
    Evidence=if ($evidenceParts.Count -gt 0) { $evidenceParts -join '; ' } else { '-' }
    Notes=if ($detected) { 'detected' } else { 'not found' }
  }) | Out-Null

  foreach ($site in @(Get-PanelSites $panel.PanelType $panel.Name $siteRoot)) {
    $siteRows.Add($site) | Out-Null
  }
  foreach ($service in $services) {
    $serviceRows.Add($service) | Out-Null
  }
  foreach ($logPath in @($panel.LogPaths)) {
    $meta = Get-PathMetadata $panel.PanelType $logPath 'panel log/config metadata'
    if ($null -ne $meta) { $logRows.Add($meta) | Out-Null }
  }
}

$iisSites = @()
try {
  Import-Module WebAdministration -ErrorAction Stop
  $iisSites = @(Get-Website -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      Name=$_.Name
      State=[string]$_.State
      PhysicalPath=$_.PhysicalPath
      Bindings=(@($_.Bindings.Collection | ForEach-Object { $_.bindingInformation }) -join '; ')
    }
  })
} catch {
  $diagnostics.Add('IIS WebAdministration module is unavailable') | Out-Null
  if (Test-ExistingPath 'C:\inetpub\wwwroot') {
    $iisSites = @([pscustomobject]@{
      Name='Default Web Root'
      State='Present'
      PhysicalPath='C:\inetpub\wwwroot'
      Bindings='-'
    })
  }
}

foreach ($iisService in @(Get-RelatedServices 'iis' @('W3SVC', 'WAS', 'IISADMIN') @('inetsrv'))) {
  $serviceRows.Add($iisService) | Out-Null
}
foreach ($iisLogPath in @('C:\inetpub\logs\LogFiles', 'C:\Windows\System32\LogFiles\HTTPERR')) {
  $meta = Get-PathMetadata 'iis' $iisLogPath 'IIS log directory metadata'
  if ($null -ne $meta) { $logRows.Add($meta) | Out-Null }
}

echo ===PANELS===
Convert-ToJsonArray -items $panelRows.ToArray() -depth 6
echo ===ES_MATCHES===
Convert-ToJsonArray -items $esMatches.ToArray() -depth 6
echo ===SITES===
Convert-ToJsonArray -items $siteRows.ToArray() -depth 6
echo ===IIS_SITES===
Convert-ToJsonArray -items $iisSites -depth 6
echo ===SERVICES===
Convert-ToJsonArray -items $serviceRows.ToArray() -depth 6
echo ===LOGS===
Convert-ToJsonArray -items $logRows.ToArray() -depth 6
echo ===DIAGNOSTICS===
Convert-ToJsonArray -items $diagnostics.ToArray() -depth 4"#
            .replace("__CARGO_MANIFEST_DIR__", env!("CARGO_MANIFEST_DIR"));

        let raw_output = Self::run_powershell(&script);
        let parsed = Self::parse_panel_output(&raw_output);
        let detected_installs: Vec<&PanelInstallEntry> = parsed
            .installs
            .iter()
            .filter(|item| item.detected)
            .collect();

        let status = if detected_installs.is_empty() && parsed.iis_sites.is_empty() {
            "ok"
        } else {
            "info"
        };

        let site_count = parsed.sites.len() + parsed.iis_sites.len();
        let service_count = parsed.services.len();

        let summary = if detected_installs.is_empty() && parsed.iis_sites.is_empty() {
            "未检测到常见 Windows Web 面板或 IIS 站点".to_string()
        } else {
            format!(
                "检测到 {} 个面板/集成环境, {} 个站点, {} 个相关服务",
                detected_installs.len(),
                site_count,
                service_count
            )
        };

        AnalysisResult {
            module_name: "panel".to_string(),
            status: status.to_string(),
            summary,
            details: json!({
                "installs": parsed.installs,
                "detected_installs": detected_installs,
                "sites": parsed.sites,
                "iis_sites": parsed.iis_sites,
                "services": parsed.services,
                "logs": parsed.logs,
                "diagnostics": parsed.diagnostics,
                "statistics": {
                    "detected_panel_count": detected_installs.len(),
                    "site_count": parsed.sites.len(),
                    "iis_site_count": parsed.iis_sites.len(),
                    "service_count": service_count,
                    "log_count": parsed.logs.len(),
                    "diagnostic_count": parsed.diagnostics.len()
                },
                "raw_output": raw_output
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PanelAnalyzer;

    #[test]
    fn parses_panel_installs_and_iis_sites() {
        let output = r#"===PANELS===
[{"PanelType":"phpstudy","Name":"PhpStudy Pro","Path":"C:\\phpstudy_pro","Detected":true,"SiteCount":2,"Notes":"installed"},{"PanelType":"xampp","Name":"XAMPP","Path":"C:\\xampp","Detected":false,"SiteCount":0,"Notes":"not found"}]
===IIS_SITES===
[{"Name":"Default Web Site","State":"Started","PhysicalPath":"C:\\inetpub\\wwwroot","Bindings":"*:80:"}]"#;

        let parsed = PanelAnalyzer::parse_panel_output(output);

        assert_eq!(parsed.installs.len(), 2);
        assert!(parsed.installs[0].detected);
        assert_eq!(parsed.installs[0].site_count, 2);
        assert_eq!(parsed.iis_sites.len(), 1);
        assert_eq!(parsed.iis_sites[0].source, "IIS");
        assert_eq!(parsed.iis_sites[0].name, "Default Web Site");
    }

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
        assert_eq!(parsed.installs[0].site_root, "C:\\phpstudy_pro\\WWW");
        assert_eq!(parsed.iis_sites.len(), 1);
        assert_eq!(parsed.services.len(), 1);
        assert_eq!(parsed.services[0].pid, "1234");
        assert_eq!(parsed.logs.len(), 1);
        assert_eq!(
            parsed.diagnostics[0],
            "IIS WebAdministration module is unavailable"
        );
    }

    #[test]
    fn derives_panel_evidence_from_everything_matches() {
        let output = r#"===PANELS===
[]
===ES_MATCHES===
[{"Source":"everything","Query":"phpstudy_pro","FullPath":"D:\\webstack\\phpstudy_pro\\WWW\\demo.local\\index.php","Name":"index.php","ParentPath":"D:\\webstack\\phpstudy_pro\\WWW\\demo.local","Extension":"php","Length":512,"LastWriteTime":"2026-06-25T20:00:00"},{"Source":"everything","Query":"xampp","FullPath":"E:\\portable\\xampp\\apache\\logs\\access.log","Name":"access.log","ParentPath":"E:\\portable\\xampp\\apache\\logs","Extension":"log","Length":4096,"LastWriteTime":"2026-06-25T21:00:00"}]"#;

        let parsed = PanelAnalyzer::parse_panel_output(output);

        let phpstudy = parsed
            .installs
            .iter()
            .find(|install| install.panel_type == "phpstudy")
            .expect("phpStudy should be derived from Everything matches");
        assert!(phpstudy.detected);
        assert_eq!(phpstudy.path, "D:\\webstack\\phpstudy_pro");
        assert_eq!(phpstudy.site_root, "D:\\webstack\\phpstudy_pro\\WWW");
        assert!(phpstudy.evidence.contains("everything_index"));
        assert_eq!(phpstudy.site_count, 1);
        assert!(parsed.sites.iter().any(|site| {
            site.panel_type == "phpstudy"
                && site.name == "demo.local"
                && site.path == "D:\\webstack\\phpstudy_pro\\WWW\\demo.local"
        }));
        assert!(parsed.logs.iter().any(|log| {
            log.source == "xampp" && log.path == "E:\\portable\\xampp\\apache\\logs\\access.log"
        }));
    }

    #[test]
    fn derives_phpstudy_install_from_everything_com_directory_match() {
        let output = r#"===PANELS===
[]
===ES_MATCHES===
[{"Source":"everything","Query":"phpstudy_pro","FullPath":"C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\phpstudy_pro\\phpstudy_pro.lnk","Name":"phpstudy_pro.lnk","ParentPath":"C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\phpstudy_pro","Extension":"lnk","Length":705,"LastWriteTime":"2023-11-17T19:37:55"},{"Source":"everything","Query":"phpstudy_pro","FullPath":"D:\\ctf-tools\\phpstudy_pro\\COM\\phpstudy_pro.exe","Name":"phpstudy_pro.exe","ParentPath":"D:\\ctf-tools\\phpstudy_pro\\COM","Extension":"exe","Length":2094592,"LastWriteTime":"2021-03-29T14:49:06"}]"#;

        let parsed = PanelAnalyzer::parse_panel_output(output);

        assert_eq!(parsed.installs.len(), 1);
        let phpstudy = parsed
            .installs
            .iter()
            .find(|install| install.panel_type == "phpstudy")
            .expect("phpStudy should be derived from indexed COM executable");
        assert!(phpstudy.detected);
        assert_eq!(phpstudy.path, "D:\\ctf-tools\\phpstudy_pro");
        assert!(phpstudy.evidence.contains("everything_index"));
    }
}
