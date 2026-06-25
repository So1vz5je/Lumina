use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelInstallEntry {
    pub panel_type: String,
    pub name: String,
    pub path: String,
    pub detected: bool,
    pub site_count: usize,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSiteEntry {
    pub source: String,
    pub name: String,
    pub path: String,
    pub state: String,
    pub bindings: String,
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

    fn parse_panel_output(output: &str) -> (Vec<PanelInstallEntry>, Vec<PanelSiteEntry>) {
        let mut installs = Vec::new();
        let mut sites = Vec::new();
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
                        let detected = matches!(item.get("Detected"), Some(Value::Bool(true)));
                        let site_count = item
                            .get("SiteCount")
                            .and_then(Value::as_u64)
                            .unwrap_or_default() as usize;
                        let notes = Self::value_to_string(item.get("Notes"));

                        installs.push(PanelInstallEntry {
                            panel_type,
                            name,
                            path,
                            detected,
                            site_count,
                            notes,
                        });
                    }
                }
                "IIS_SITES" => {
                    for item in Self::parse_json_items(content) {
                        sites.push(PanelSiteEntry {
                            source: "IIS".to_string(),
                            name: Self::value_to_string(item.get("Name")),
                            path: Self::value_to_string(item.get("PhysicalPath")),
                            state: Self::value_to_string(item.get("State")),
                            bindings: Self::value_to_string(item.get("Bindings")),
                        });
                    }
                }
                _ => {}
            }

            i += 2;
        }

        (installs, sites)
    }
}

impl Analyzer for PanelAnalyzer {
    fn name(&self) -> &str {
        "Panel Detection"
    }

    fn run(&self) -> AnalysisResult {
        let script = r#"$panels = @(
  @{ PanelType='baota_windows'; Name='宝塔 Windows'; Path='C:\BtSoft'; SitePath='C:\BtSoft\wwwroot' },
  @{ PanelType='phpstudy'; Name='PhpStudy Pro'; Path='C:\phpstudy_pro'; SitePath='C:\phpstudy_pro\WWW' },
  @{ PanelType='xampp'; Name='XAMPP'; Path='C:\xampp'; SitePath='C:\xampp\htdocs' },
  @{ PanelType='wampserver'; Name='WampServer'; Path='C:\wamp64'; SitePath='C:\wamp64\www' }
)
echo ===PANELS===
@($panels | ForEach-Object {
  $detected = Test-Path $_.Path
  $siteCount = 0
  if ($detected -and (Test-Path $_.SitePath)) {
    $siteCount = @(Get-ChildItem $_.SitePath -Directory -ErrorAction SilentlyContinue).Count
  }
  [pscustomobject]@{
    PanelType=$_.PanelType
    Name=$_.Name
    Path=$_.Path
    Detected=$detected
    SiteCount=$siteCount
    Notes=if ($detected) { 'installed' } else { 'not found' }
  }
}) | ConvertTo-Json -Compress -Depth 4
echo ===IIS_SITES===
try {
  Import-Module WebAdministration -ErrorAction Stop
  @(Get-Website -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      Name=$_.Name
      State=[string]$_.State
      PhysicalPath=$_.PhysicalPath
      Bindings=(@($_.Bindings.Collection | ForEach-Object { $_.bindingInformation }) -join '; ')
    }
  }) | ConvertTo-Json -Compress -Depth 5
} catch {
  @() | ConvertTo-Json -Compress
}"#;

        let raw_output = Self::run_powershell(script);
        let (installs, iis_sites) = Self::parse_panel_output(&raw_output);
        let detected_installs: Vec<&PanelInstallEntry> =
            installs.iter().filter(|item| item.detected).collect();

        let status = if detected_installs.is_empty() && iis_sites.is_empty() {
            "ok"
        } else {
            "info"
        };

        let summary = if detected_installs.is_empty() && iis_sites.is_empty() {
            "未检测到常见 Windows Web 面板或 IIS 站点".to_string()
        } else {
            format!(
                "检测到 {} 个面板/集成环境, {} 个 IIS 站点",
                detected_installs.len(),
                iis_sites.len()
            )
        };

        AnalysisResult {
            module_name: "panel".to_string(),
            status: status.to_string(),
            summary,
            details: json!({
                "installs": installs,
                "detected_installs": detected_installs,
                "iis_sites": iis_sites,
                "statistics": {
                    "detected_panel_count": detected_installs.len(),
                    "iis_site_count": iis_sites.len()
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

        let (installs, sites) = PanelAnalyzer::parse_panel_output(output);

        assert_eq!(installs.len(), 2);
        assert!(installs[0].detected);
        assert_eq!(installs[0].site_count, 2);
        assert_eq!(sites.len(), 1);
        assert_eq!(sites[0].source, "IIS");
        assert_eq!(sites[0].name, "Default Web Site");
    }
}
