use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTaskEntry {
    pub task_path: String,
    pub task_name: String,
    pub state: String,
    pub actions: String,
    pub triggers: String,
    pub last_run_time: String,
    pub next_run_time: String,
    pub last_task_result: String,
    pub author: String,
    pub description: String,
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

pub struct CronAnalyzer;

impl CronAnalyzer {
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
                .filter(|item| !item.is_empty())
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

    fn parse_tasks(output: &str) -> Vec<ScheduledTaskEntry> {
        let trimmed = output.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }

        let parsed = match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };

        let items = match parsed {
            Value::Array(items) => items,
            Value::Object(_) => vec![parsed],
            _ => Vec::new(),
        };

        items
            .iter()
            .filter(|item| item.get("Error").is_none() && item.get("error").is_none())
            .map(|item| {
                let task_path = Self::value_to_string(item.get("TaskPath"));
                let task_name = Self::value_to_string(item.get("TaskName"));
                let actions = Self::value_to_string(item.get("Actions"));
                let triggers = Self::value_to_string(item.get("Triggers"));
                let combined = format!("{} {} {} {}", task_path, task_name, actions, triggers);
                let (suspicious, suspicious_reason) = Self::check_suspicious(&combined);

                ScheduledTaskEntry {
                    task_path,
                    task_name,
                    state: Self::value_to_string(item.get("State")),
                    actions,
                    triggers,
                    last_run_time: Self::value_to_string(item.get("LastRunTime")),
                    next_run_time: Self::value_to_string(item.get("NextRunTime")),
                    last_task_result: Self::value_to_string(item.get("LastTaskResult")),
                    author: Self::value_to_string(item.get("Author")),
                    description: Self::value_to_string(item.get("Description")),
                    suspicious,
                    suspicious_reason,
                }
            })
            .collect()
    }
}

impl Analyzer for CronAnalyzer {
    fn name(&self) -> &str {
        "Scheduled Tasks"
    }

    fn run(&self) -> AnalysisResult {
        let script = r#"try {
  @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object {
    $task = $_
    $info = $null
    try { $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop } catch {}
    $actions = @($task.Actions | ForEach-Object {
      $parts = @($_.Execute, $_.Arguments, $_.ClassId) | Where-Object { $_ }
      if ($parts.Count -gt 0) { ($parts -join ' ').Trim() } else { ($_.ToString() -replace '\s+', ' ').Trim() }
    }) -join '; '
    $triggers = @($task.Triggers | ForEach-Object {
      $parts = @($_.CimClass.CimClassName, $_.StartBoundary, $_.EndBoundary, $_.Enabled) | Where-Object { $_ -ne $null -and $_ -ne '' }
      if ($parts.Count -gt 0) { ($parts -join ' | ').Trim() } else { ($_.ToString() -replace '\s+', ' ').Trim() }
    }) -join '; '
    [pscustomobject]@{
      TaskPath=$task.TaskPath
      TaskName=$task.TaskName
      State=[string]$task.State
      Actions=$actions
      Triggers=$triggers
      LastRunTime=if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 1900) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
      NextRunTime=if ($info -and $info.NextRunTime -and $info.NextRunTime.Year -gt 1900) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
      LastTaskResult=if ($info) { $info.LastTaskResult } else { $null }
      Author=$task.Author
      Description=$task.Description
    }
  }) | ConvertTo-Json -Compress -Depth 5
} catch {
  @([pscustomobject]@{ Error=$_.Exception.Message }) | ConvertTo-Json -Compress -Depth 5
}"#;

        let raw_output = Self::run_powershell(script);
        let tasks = Self::parse_tasks(&raw_output);
        let suspicious_tasks: Vec<&ScheduledTaskEntry> =
            tasks.iter().filter(|task| task.suspicious).collect();
        let task_count = tasks.len();
        let suspicious_count = suspicious_tasks.len();

        let status = if suspicious_tasks.is_empty() {
            "ok"
        } else {
            "warning"
        };

        AnalysisResult {
            module_name: "cron".to_string(),
            status: status.to_string(),
            summary: format!(
                "{} scheduled tasks, {} suspicious",
                task_count, suspicious_count
            ),
            details: json!({
                "tasks": tasks,
                "suspicious_tasks": suspicious_tasks,
                "statistics": {
                    "task_count": task_count,
                    "suspicious_count": suspicious_count
                },
                "raw_output": raw_output
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CronAnalyzer;

    #[test]
    fn parses_and_flags_suspicious_scheduled_tasks() {
        let output = r#"[{"TaskPath":"\\Microsoft\\Windows\\Update\\","TaskName":"Updater","State":"Ready","Actions":"powershell.exe -nop -enc AAAA","Triggers":"At logon","LastRunTime":"","NextRunTime":"","LastTaskResult":0,"Author":"SYSTEM","Description":"test"}]"#;

        let tasks = CronAnalyzer::parse_tasks(output);

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_name, "Updater");
        assert!(tasks[0].suspicious);
        assert_eq!(
            tasks[0].suspicious_reason.as_deref(),
            Some("encoded PowerShell")
        );
    }
}
