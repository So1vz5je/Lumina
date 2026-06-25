use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceEntry {
    pub entry_type: String,
    pub name: String,
    pub status: String,
    pub detail: String,
    pub trigger: String,
    pub user: String,
    pub location: String,
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

pub struct PersistenceAnalyzer;

impl PersistenceAnalyzer {
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

    fn check_suspicious(text: &str) -> (bool, Option<String>) {
        let lower = text.to_lowercase();
        let suspicious_markers = [
            ("powershell", "-enc", "encoded PowerShell"),
            ("powershell", "-nop", "no-profile PowerShell"),
            ("powershell", "-w hidden", "hidden PowerShell"),
            ("cmd.exe", "/c", "shell execution"),
            ("mshta", "", "mshta execution"),
            ("wscript", "", "script host execution"),
            ("cscript", "", "script host execution"),
            ("rundll32", "", "rundll32 execution"),
            ("regsvr32", "", "regsvr32 execution"),
            ("certutil", "", "certutil usage"),
            ("bitsadmin", "", "bitsadmin usage"),
            ("schtasks", "/create", "task creation command"),
        ];

        for (program, marker, reason) in suspicious_markers {
            if lower.contains(program) && (marker.is_empty() || lower.contains(marker)) {
                return (true, Some(reason.to_string()));
            }
        }

        let suspicious_paths = [
            "\\temp\\",
            "\\tmp\\",
            "\\appdata\\local\\temp",
            "\\users\\public\\",
            "\\downloads\\",
            "%temp%",
            "%tmp%",
            "http://",
            "https://",
        ];

        for marker in suspicious_paths {
            if lower.contains(marker) {
                return (true, Some(format!("suspicious location: {}", marker)));
            }
        }

        (false, None)
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

    fn parse_sectioned_output(output: &str) -> Vec<PersistenceEntry> {
        let mut entries = Vec::new();
        let parts: Vec<&str> = output.split("===").collect();
        let mut i = 1;

        while i + 1 < parts.len() {
            let section = parts[i].trim();
            let content = parts[i + 1].trim();

            if !section.is_empty() {
                for item in Self::parse_json_items(content) {
                    if item.get("Error").is_some() || item.get("error").is_some() {
                        continue;
                    }

                    let entry = match section {
                        "SCHEDULED_TASKS" => {
                            let task_path = Self::value_to_string(item.get("TaskPath"));
                            let task_name = Self::value_to_string(item.get("TaskName"));
                            let full_name = if task_path == "-" {
                                task_name.clone()
                            } else {
                                format!("{}{}", task_path, task_name).replace("\\\\", "\\")
                            };
                            let detail = Self::value_to_string(item.get("Actions"));
                            let trigger = Self::value_to_string(item.get("Triggers"));
                            let status = Self::value_to_string(item.get("State"));
                            let combined = format!("{} {} {}", full_name, detail, trigger);
                            let (suspicious, suspicious_reason) = Self::check_suspicious(&combined);

                            PersistenceEntry {
                                entry_type: "Scheduled Task".to_string(),
                                name: full_name,
                                status,
                                detail,
                                trigger,
                                user: Self::value_to_string(item.get("Author")),
                                location: task_path,
                                suspicious,
                                suspicious_reason,
                            }
                        }
                        "SERVICES_AUTO" => {
                            let name = Self::value_to_string(item.get("Name"));
                            let display_name = Self::value_to_string(item.get("DisplayName"));
                            let detail = Self::value_to_string(item.get("PathName"));
                            let combined = format!("{} {} {}", name, display_name, detail);
                            let (suspicious, suspicious_reason) = Self::check_suspicious(&combined);

                            PersistenceEntry {
                                entry_type: "Service".to_string(),
                                name,
                                status: Self::value_to_string(item.get("Status"))
                                    .replace("Auto", "Automatic"),
                                detail,
                                trigger: Self::value_to_string(item.get("StartType")),
                                user: Self::value_to_string(item.get("StartName")),
                                location: display_name,
                                suspicious,
                                suspicious_reason,
                            }
                        }
                        "STARTUP_FOLDER" => {
                            let name = Self::value_to_string(item.get("Name"));
                            let detail = Self::value_to_string(item.get("Command"));
                            let location = Self::value_to_string(item.get("Location"));
                            let combined = format!("{} {} {}", name, detail, location);
                            let (suspicious, suspicious_reason) = Self::check_suspicious(&combined);

                            PersistenceEntry {
                                entry_type: "Startup".to_string(),
                                name,
                                status: "-".to_string(),
                                detail,
                                trigger: "startup".to_string(),
                                user: Self::value_to_string(item.get("User")),
                                location,
                                suspicious,
                                suspicious_reason,
                            }
                        }
                        _ => continue,
                    };

                    entries.push(entry);
                }
            }

            i += 2;
        }

        entries
    }
}

impl Analyzer for PersistenceAnalyzer {
    fn name(&self) -> &str {
        "Persistence"
    }

    fn run(&self) -> AnalysisResult {
        let script = r#"echo ===SCHEDULED_TASKS===
try {
  @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.State -ne 'Disabled' } | Select-Object -First 200 | ForEach-Object {
    $task = $_
    $actions = @($task.Actions | ForEach-Object {
      $parts = @($_.Execute, $_.Arguments, $_.ClassId) | Where-Object { $_ }
      if ($parts.Count -gt 0) { ($parts -join ' ').Trim() } else { ($_.ToString() -replace '\s+', ' ').Trim() }
    }) -join '; '
    $triggers = @($task.Triggers | ForEach-Object {
      $parts = @($_.CimClass.CimClassName, $_.StartBoundary, $_.EndBoundary, $_.Enabled) | Where-Object { $_ -ne $null -and $_ -ne '' }
      if ($parts.Count -gt 0) { ($parts -join ' | ').Trim() } else { ($_.ToString() -replace '\s+', ' ').Trim() }
    }) -join '; '
    [pscustomobject]@{ TaskPath=$task.TaskPath; TaskName=$task.TaskName; State=[string]$task.State; Actions=$actions; Triggers=$triggers; Author=$task.Author }
  }) | ConvertTo-Json -Compress -Depth 5
} catch {
  @([pscustomobject]@{ Error=$_.Exception.Message }) | ConvertTo-Json -Compress -Depth 5
}
echo ===SERVICES_AUTO===
@(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.StartMode -eq 'Auto' } | Select-Object -First 200 | ForEach-Object {
  [pscustomobject]@{ Name=$_.Name; DisplayName=$_.DisplayName; Status=$_.State; StartType=$_.StartMode; PathName=$_.PathName; StartName=$_.StartName }
}) | ConvertTo-Json -Compress -Depth 4
echo ===STARTUP_FOLDER===
@(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name,Command,Location,User) | ConvertTo-Json -Compress -Depth 4"#;

        let raw_output = Self::run_powershell(script);
        let entries = Self::parse_sectioned_output(&raw_output);
        let suspicious_entries: Vec<&PersistenceEntry> =
            entries.iter().filter(|entry| entry.suspicious).collect();
        let entry_count = entries.len();
        let suspicious_count = suspicious_entries.len();

        let status = if suspicious_entries.is_empty() {
            "ok"
        } else {
            "warning"
        };

        AnalysisResult {
            module_name: "persistence".to_string(),
            status: status.to_string(),
            summary: format!(
                "{} persistence entries, {} suspicious",
                entry_count, suspicious_count
            ),
            details: json!({
                "entries": entries,
                "suspicious_entries": suspicious_entries,
                "statistics": {
                    "entry_count": entry_count,
                    "suspicious_count": suspicious_count
                },
                "raw_output": raw_output
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PersistenceAnalyzer;

    #[test]
    fn parses_scheduled_tasks_services_and_startup_entries() {
        let output = r#"===SCHEDULED_TASKS===
[{"TaskPath":"\\Microsoft\\Windows\\Update\\","TaskName":"Updater","State":"Ready","Actions":"powershell.exe -nop -enc AAAA","Triggers":"At logon","Author":"SYSTEM"}]
===SERVICES_AUTO===
[{"Name":"BadSvc","DisplayName":"Bad Service","Status":"Running","StartType":"Auto","PathName":"C:\\Temp\\bad.exe","StartName":"LocalSystem"}]
===STARTUP_FOLDER===
[{"Name":"RunMe","Command":"C:\\Tools\\runme.exe","Location":"HKCU Run","User":"analyst"}]"#;

        let entries = PersistenceAnalyzer::parse_sectioned_output(output);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].entry_type, "Scheduled Task");
        assert_eq!(entries[0].name, "\\Microsoft\\Windows\\Update\\Updater");
        assert!(entries[0].suspicious);
        assert_eq!(entries[1].entry_type, "Service");
        assert!(entries[1].suspicious);
        assert_eq!(entries[2].entry_type, "Startup");
    }
}
