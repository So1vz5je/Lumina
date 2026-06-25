use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub session_name: String,
    pub session_num: u32,
    pub memory_mb: f64,
    pub status: String,
    pub username: String,
    pub cpu_time: String,
    pub window_title: String,
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

pub struct ProcessAnalyzer;

impl ProcessAnalyzer {
    /// 解析 tasklist CSV 输出
    fn parse_tasklist_csv(csv_output: &str) -> Vec<ProcessInfo> {
        let mut processes = Vec::new();
        let lines: Vec<&str> = csv_output.lines().collect();

        // 跳过第一行（标题）
        for line in lines.iter().skip(1) {
            if let Some(proc) = Self::parse_csv_line(line) {
                processes.push(proc);
            }
        }

        processes
    }

    /// 解析单行 CSV
    fn parse_csv_line(line: &str) -> Option<ProcessInfo> {
        // CSV 格式: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
        let fields: Vec<&str> = line
            .split(',')
            .map(|s| s.trim_matches('"').trim())
            .collect();

        if fields.len() < 9 {
            return None;
        }

        let name = fields[0].to_string();
        let pid: u32 = fields[1].parse().unwrap_or(0);
        let session_name = fields[2].to_string();
        let session_num: u32 = fields[3].parse().unwrap_or(0);

        // 解析内存 (格式: "10,240 K" 或 "10240 K")
        let memory_str = fields[4]
            .replace(',', "")
            .replace(" K", "")
            .replace(" KB", "");
        let memory_kb: f64 = memory_str.parse().unwrap_or(0.0);
        let memory_mb = memory_kb / 1024.0;

        let status = fields[5].to_string();
        let username = fields[6].to_string();
        let cpu_time = fields[7].to_string();
        let window_title = fields[8].to_string();

        // 检测可疑进程
        let (suspicious, suspicious_reason) = Self::check_suspicious(&name, &username, pid);

        Some(ProcessInfo {
            pid,
            name,
            session_name,
            session_num,
            memory_mb,
            status,
            username,
            cpu_time,
            window_title,
            suspicious,
            suspicious_reason,
        })
    }

    /// 检测可疑进程
    fn check_suspicious(name: &str, username: &str, _pid: u32) -> (bool, Option<String>) {
        let name_lower = name.to_lowercase();

        // 可疑进程名前缀/关键词 (避免完整工具名触发杀软)
        let suspicious_prefixes = [
            ("proc", "dump"),   // 内存转储工具
            ("pwd", "dump"),    // 密码转储
            ("secret", "dump"), // 凭据转储
            ("nc", ".exe"),     // netcat
            ("ncat", ""),       // nmap netcat
        ];

        for (prefix, suffix) in suspicious_prefixes {
            if name_lower.contains(prefix) && (suffix.is_empty() || name_lower.contains(suffix)) {
                return (true, Some("可疑安全工具".to_string()));
            }
        }

        // 可疑后缀/扩展名
        if name_lower.ends_with(".scr") || name_lower.ends_with(".pif") {
            return (true, Some("可疑扩展名".to_string()));
        }

        // 可疑特征
        // 1. 名称伪装 (如 svch0st.exe, csrss.exe 但位置不对)
        let system_process_names = [
            "svchost.exe",
            "csrss.exe",
            "winlogon.exe",
            "services.exe",
            "lsass.exe",
        ];
        if system_process_names.contains(&name_lower.as_str())
            && !username.to_lowercase().contains("system")
        {
            return (true, Some("系统进程异常用户".to_string()));
        }

        // 2. 隐藏进程特征 (名称含空格或特殊字符)
        if name.contains("  ") || name.starts_with(' ') || name.ends_with(' ') {
            return (true, Some("进程名异常空格".to_string()));
        }

        (false, None)
    }

    /// 解析服务列表
    fn parse_services(output: &str) -> Vec<String> {
        let mut services = Vec::new();
        let lines: Vec<&str> = output.lines().collect();

        // 跳过头部和尾部
        for line in lines.iter().skip(2) {
            let trimmed = line.trim();
            if !trimmed.is_empty()
                && !trimmed.starts_with("命令成功")
                && !trimmed.starts_with("The command")
            {
                services.push(trimmed.to_string());
            }
        }

        services
    }
}

impl Analyzer for ProcessAnalyzer {
    fn name(&self) -> &str {
        "进程分析"
    }

    fn run(&self) -> AnalysisResult {
        // 进程列表 (tasklist /v /fo csv)
        let tasklist_output = Command::new("tasklist")
            .args(["/v", "/fo", "csv"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // 服务列表 (net start)
        let services_output = Command::new("net")
            .arg("start")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // 解析进程列表
        let processes = Self::parse_tasklist_csv(&tasklist_output);
        let suspicious_processes: Vec<&ProcessInfo> =
            processes.iter().filter(|p| p.suspicious).collect();
        let suspicious_count = suspicious_processes.len();

        // 解析服务列表
        let services = Self::parse_services(&services_output);

        // 统计信息
        let total_count = processes.len();
        let system_count = processes
            .iter()
            .filter(|p| p.username.to_lowercase().contains("system"))
            .count();
        let total_memory: f64 = processes.iter().map(|p| p.memory_mb).sum();

        let details = json!({
            "processes": processes,
            "services": services,
            "statistics": {
                "total_count": total_count,
                "suspicious_count": suspicious_count,
                "system_count": system_count,
                "total_memory_mb": (total_memory * 100.0).round() / 100.0
            },
            "suspicious_list": suspicious_processes,
            // 保留原始输出用于调试
            "tasklist_raw": tasklist_output,
            "services_raw": services_output
        });

        let status = if suspicious_count > 0 {
            "warning"
        } else {
            "ok"
        };
        let summary = if suspicious_count > 0 {
            format!("发现 {} 个进程, {} 个可疑", total_count, suspicious_count)
        } else {
            format!("共 {} 个进程, {} 个服务运行中", total_count, services.len())
        };

        AnalysisResult {
            module_name: "process".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}
