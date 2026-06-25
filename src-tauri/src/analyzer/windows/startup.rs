use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupItem {
    pub name: String,
    pub command: String,
    pub location: String,
    pub item_type: String, // registry, task, service
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub name: String,
    pub status: String,
    pub next_run: String,
    pub last_run: String,
    pub author: String,
    pub task_to_run: String,
}

pub struct StartupAnalyzer;

impl StartupAnalyzer {
    /// 解析注册表查询输出
    fn parse_registry_output(output: &str, location: &str) -> Vec<StartupItem> {
        let mut items = Vec::new();

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("HKEY")
                || line.starts_with("错误")
                || line.starts_with("ERROR")
            {
                continue;
            }

            // 格式: Name    REG_SZ    Value
            let parts: Vec<&str> = line.splitn(3, "    ").collect();
            if parts.len() >= 3 {
                let name = parts[0].trim().to_string();
                let command = parts[2].trim().to_string();

                let (suspicious, suspicious_reason) = Self::check_suspicious(&name, &command);

                items.push(StartupItem {
                    name,
                    command,
                    location: location.to_string(),
                    item_type: "registry".to_string(),
                    suspicious,
                    suspicious_reason,
                });
            }
        }

        items
    }

    /// 检测可疑启动项
    fn check_suspicious(name: &str, command: &str) -> (bool, Option<String>) {
        let name_lower = name.to_lowercase();
        let cmd_lower = command.to_lowercase();

        // 可疑命令特征
        let suspicious_patterns = [
            ("powershell", "-enc", "编码的PowerShell命令"),
            ("powershell", "-w hidden", "隐藏窗口的PowerShell"),
            ("powershell", "-nop", "无配置文件的PowerShell"),
            ("cmd", "/c", "CMD执行"),
            ("mshta", "", "MSHTA执行"),
            ("wscript", "", "WScript执行"),
            ("cscript", "", "CScript执行"),
            ("regsvr32", "/s", "静默注册DLL"),
            ("rundll32", "", "Rundll32执行"),
            ("certutil", "", "Certutil使用"),
        ];

        for (prog, pattern, reason) in suspicious_patterns {
            if cmd_lower.contains(prog) && (pattern.is_empty() || cmd_lower.contains(pattern)) {
                return (true, Some(reason.to_string()));
            }
        }

        // 可疑路径
        let suspicious_paths = [
            "\\temp\\",
            "\\tmp\\",
            "\\appdata\\local\\temp",
            "\\public\\",
            "\\downloads\\",
            "%temp%",
            "%tmp%",
        ];

        for path in suspicious_paths {
            if cmd_lower.contains(path) {
                return (true, Some(format!("可疑路径: {}", path)));
            }
        }

        // 名称伪装
        if name_lower.contains("micorsoft")
            || name_lower.contains("mircosoft")
            || name_lower.contains("gooogle")
            || name_lower.contains("wlndows")
        {
            return (true, Some("名称伪装".to_string()));
        }

        (false, None)
    }

    /// 解析计划任务输出
    fn parse_scheduled_tasks(output: &str) -> Vec<ScheduledTask> {
        let mut tasks = Vec::new();
        let lines: Vec<&str> = output.lines().collect();

        // CSV 格式解析
        for line in lines.iter().skip(1) {
            let fields: Vec<&str> = line
                .split(',')
                .map(|s| s.trim_matches('"').trim())
                .collect();

            if fields.len() >= 6 {
                tasks.push(ScheduledTask {
                    name: fields[0].to_string(),
                    next_run: fields.get(1).unwrap_or(&"").to_string(),
                    status: fields.get(2).unwrap_or(&"").to_string(),
                    last_run: fields.get(3).unwrap_or(&"").to_string(),
                    author: fields.get(4).unwrap_or(&"").to_string(),
                    task_to_run: fields.get(5).unwrap_or(&"").to_string(),
                });
            }
        }

        tasks
    }
}

impl Analyzer for StartupAnalyzer {
    fn name(&self) -> &str {
        "启动项检查"
    }

    fn run(&self) -> AnalysisResult {
        let mut all_items = Vec::new();

        // 注册表启动项 - HKLM Run
        let hklm_run = Command::new("reg")
            .args([
                "query",
                r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        all_items.extend(Self::parse_registry_output(&hklm_run, "HKLM\\...\\Run"));

        // 注册表启动项 - HKCU Run
        let hkcu_run = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        all_items.extend(Self::parse_registry_output(&hkcu_run, "HKCU\\...\\Run"));

        // 注册表启动项 - RunOnce
        let hklm_runonce = Command::new("reg")
            .args([
                "query",
                r"HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        all_items.extend(Self::parse_registry_output(
            &hklm_runonce,
            "HKLM\\...\\RunOnce",
        ));

        let hkcu_runonce = Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        all_items.extend(Self::parse_registry_output(
            &hkcu_runonce,
            "HKCU\\...\\RunOnce",
        ));

        // 计划任务 (schtasks /query)
        let tasks_output = Command::new("schtasks")
            .args(["/query", "/fo", "csv", "/v"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let scheduled_tasks = Self::parse_scheduled_tasks(&tasks_output);

        // 统计
        let total_count = all_items.len();
        let suspicious_items: Vec<&StartupItem> =
            all_items.iter().filter(|i| i.suspicious).collect();
        let suspicious_count = suspicious_items.len();

        let details = json!({
            "startup_items": all_items,
            "scheduled_tasks": scheduled_tasks,
            "statistics": {
                "registry_items": total_count,
                "scheduled_tasks_count": scheduled_tasks.len(),
                "suspicious_count": suspicious_count
            },
            "suspicious_items": suspicious_items,
            // 原始输出
            "hklm_run_raw": hklm_run,
            "hkcu_run_raw": hkcu_run,
            "tasks_raw": tasks_output
        });

        let status = if suspicious_count > 0 {
            "warning"
        } else {
            "ok"
        };
        let summary = if suspicious_count > 0 {
            format!(
                "发现 {} 个可疑启动项, 共 {} 个注册表项",
                suspicious_count, total_count
            )
        } else {
            format!(
                "{} 个启动项, {} 个计划任务",
                total_count,
                scheduled_tasks.len()
            )
        };

        AnalysisResult {
            module_name: "startup".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}
