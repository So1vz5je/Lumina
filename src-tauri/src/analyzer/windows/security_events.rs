use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityEvent {
    pub event_id: u32,
    pub time_created: String,
    pub event_type: String,
    pub description: String,
    pub username: Option<String>,
    pub source_ip: Option<String>,
    pub logon_type: Option<String>,
    pub status: Option<String>,
    pub is_suspicious: bool,
}

pub struct SecurityEventsAnalyzer;

impl SecurityEventsAnalyzer {
    /// 使用 wevtutil 查询安全日志
    fn query_security_events(filter: &str, max_events: u32) -> Vec<SecurityEvent> {
        let query = format!(r#"*[System[{}]]"#, filter);

        let output = Command::new("wevtutil")
            .args([
                "qe",
                "Security",
                "/q:*[System[{}]]".replace("{}", filter).as_str(),
                "/c:{}".replace("{}", &max_events.to_string()).as_str(),
                "/rd:true", // 逆序（最新的在前）
                "/f:text",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        Self::parse_wevtutil_output(&output)
    }

    /// 使用 PowerShell 查询事件日志（更可靠）
    fn query_events_powershell(event_ids: &[u32], max_events: u32) -> Vec<SecurityEvent> {
        let ids_str = event_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let ps_command = format!(
            r#"Get-WinEvent -FilterHashtable @{{LogName='Security';ID=@({})}} -MaxEvents {} -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,Message | ConvertTo-Json -Compress"#,
            ids_str, max_events
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_command])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        Self::parse_powershell_json(&output)
    }

    /// 解析 PowerShell JSON 输出
    fn parse_powershell_json(json_str: &str) -> Vec<SecurityEvent> {
        let mut events = Vec::new();

        if json_str.trim().is_empty() {
            return events;
        }

        // PowerShell 可能返回单个对象或数组
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json_str) {
            for item in arr {
                if let Some(event) = Self::parse_event_json(&item) {
                    events.push(event);
                }
            }
        } else if let Ok(item) = serde_json::from_str::<serde_json::Value>(json_str) {
            if let Some(event) = Self::parse_event_json(&item) {
                events.push(event);
            }
        }

        events
    }

    /// 解析单个事件 JSON
    fn parse_event_json(item: &serde_json::Value) -> Option<SecurityEvent> {
        let event_id = item.get("Id")?.as_u64()? as u32;
        let time_created = item
            .get("TimeCreated")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                // PowerShell DateTime 对象格式
                item.get("TimeCreated")
                    .and_then(|t| t.get("DateTime"))
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();

        let message = item
            .get("Message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();

        let (event_type, description, username, source_ip, logon_type, status) =
            Self::parse_event_details(event_id, &message);

        let is_suspicious = Self::is_suspicious_event(event_id, &message);

        Some(SecurityEvent {
            event_id,
            time_created,
            event_type,
            description,
            username,
            source_ip,
            logon_type,
            status,
            is_suspicious,
        })
    }

    /// 解析事件详情
    fn parse_event_details(
        event_id: u32,
        message: &str,
    ) -> (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let event_type = match event_id {
            4624 => "登录成功",
            4625 => "登录失败",
            4634 | 4647 => "注销",
            4648 => "显式凭据登录",
            4672 => "特权分配",
            4720 => "创建用户",
            4722 => "启用用户",
            4723 | 4724 => "密码更改",
            4725 => "禁用用户",
            4726 => "删除用户",
            4728 | 4732 | 4756 => "添加到组",
            4729 | 4733 | 4757 => "从组移除",
            4738 => "用户账户更改",
            4740 => "账户锁定",
            4767 => "账户解锁",
            4776 => "凭据验证",
            4778 => "会话重连",
            4779 => "会话断开",
            _ => "其他事件",
        }
        .to_string();

        let description = Self::extract_description(message);
        let username =
            Self::extract_field(message, &["帐户名:", "Account Name:", "用户名:", "User:"]);
        let source_ip = Self::extract_field(
            message,
            &[
                "源网络地址:",
                "Source Network Address:",
                "客户端地址:",
                "Client Address:",
            ],
        );
        let logon_type = Self::extract_field(message, &["登录类型:", "Logon Type:"]);
        let status = Self::extract_field(
            message,
            &["状态:", "Status:", "失败原因:", "Failure Reason:"],
        );

        (
            event_type,
            description,
            username,
            source_ip,
            logon_type,
            status,
        )
    }

    /// 提取描述
    fn extract_description(message: &str) -> String {
        message
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(100)
            .collect::<String>()
    }

    /// 从消息中提取字段
    fn extract_field(message: &str, field_names: &[&str]) -> Option<String> {
        for name in field_names {
            if let Some(pos) = message.find(name) {
                let start = pos + name.len();
                let value: String = message[start..]
                    .chars()
                    .take_while(|c| *c != '\n' && *c != '\r')
                    .collect();
                let value = value.trim();
                if !value.is_empty() && value != "-" && value != "N/A" {
                    return Some(value.to_string());
                }
            }
        }
        None
    }

    /// 判断是否可疑事件
    fn is_suspicious_event(event_id: u32, message: &str) -> bool {
        // 登录失败
        if event_id == 4625 {
            return true;
        }

        // 账户创建/删除
        if event_id == 4720 || event_id == 4726 {
            return true;
        }

        // 特权分配给非 SYSTEM 用户
        if event_id == 4672 && !message.to_lowercase().contains("system") {
            return true;
        }

        // 登录类型可疑（远程、服务等）
        let msg_lower = message.to_lowercase();
        if event_id == 4624 {
            if msg_lower.contains("logon type:\t\t\t10") || msg_lower.contains("登录类型:\t\t\t10")
            {
                // 类型10 = RemoteInteractive (RDP)
                return true;
            }
        }

        false
    }

    /// 解析 wevtutil 文本输出
    fn parse_wevtutil_output(output: &str) -> Vec<SecurityEvent> {
        let mut events = Vec::new();
        let mut current_event: Option<(u32, String, String)> = None;

        for line in output.lines() {
            if line.starts_with("Event[") {
                // 新事件开始，保存之前的
                if let Some((id, time, msg)) = current_event.take() {
                    let (event_type, desc, user, ip, logon, status) =
                        Self::parse_event_details(id, &msg);
                    let is_suspicious = Self::is_suspicious_event(id, &msg);
                    events.push(SecurityEvent {
                        event_id: id,
                        time_created: time,
                        event_type,
                        description: desc,
                        username: user,
                        source_ip: ip,
                        logon_type: logon,
                        status,
                        is_suspicious,
                    });
                }
            } else if line.contains("Event ID:") || line.contains("事件 ID:") {
                let id_str: String = line.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(id) = id_str.parse() {
                    current_event = Some((id, String::new(), String::new()));
                }
            } else if let Some((_, ref mut time, _)) = current_event {
                if (line.contains("Date:") || line.contains("日期:")) && time.is_empty() {
                    *time = line
                        .split(':')
                        .skip(1)
                        .collect::<Vec<_>>()
                        .join(":")
                        .trim()
                        .to_string();
                }
            }
        }

        events
    }
}

impl Analyzer for SecurityEventsAnalyzer {
    fn name(&self) -> &str {
        "安全事件日志"
    }

    fn run(&self) -> AnalysisResult {
        // 重要事件 ID 列表
        let important_event_ids = [
            4624, // 登录成功
            4625, // 登录失败
            4634, // 注销
            4648, // 显式凭据登录
            4672, // 特权分配
            4720, // 创建用户
            4722, // 启用用户
            4724, // 密码重置
            4725, // 禁用用户
            4726, // 删除用户
            4728, // 添加到安全组
            4732, // 添加到本地组
            4738, // 用户账户更改
            4740, // 账户锁定
            4776, // 凭据验证
        ];

        // 使用 PowerShell 查询（更可靠）
        let events = Self::query_events_powershell(&important_event_ids, 100);

        // 统计
        let total_count = events.len();
        let login_success = events.iter().filter(|e| e.event_id == 4624).count();
        let login_failed = events.iter().filter(|e| e.event_id == 4625).count();
        let account_changes = events
            .iter()
            .filter(|e| [4720, 4722, 4724, 4725, 4726, 4738].contains(&e.event_id))
            .count();
        let privilege_events = events.iter().filter(|e| e.event_id == 4672).count();
        let suspicious_events: Vec<&SecurityEvent> =
            events.iter().filter(|e| e.is_suspicious).collect();
        let suspicious_count = suspicious_events.len();

        // 登录失败详情
        let failed_logins: Vec<&SecurityEvent> =
            events.iter().filter(|e| e.event_id == 4625).collect();

        // 账户变更详情
        let account_changes_list: Vec<&SecurityEvent> = events
            .iter()
            .filter(|e| [4720, 4726].contains(&e.event_id))
            .collect();

        let details = json!({
            "events": events,
            "statistics": {
                "total_count": total_count,
                "login_success": login_success,
                "login_failed": login_failed,
                "account_changes": account_changes,
                "privilege_events": privilege_events,
                "suspicious_count": suspicious_count
            },
            "failed_logins": failed_logins,
            "account_changes": account_changes_list,
            "suspicious_events": suspicious_events
        });

        let status = if suspicious_count > 0 || login_failed > 5 {
            "warning"
        } else {
            "ok"
        };
        let summary = if login_failed > 0 {
            format!(
                "发现 {} 次登录失败, {} 个可疑事件",
                login_failed, suspicious_count
            )
        } else {
            format!(
                "共 {} 条安全事件, {} 次成功登录",
                total_count, login_success
            )
        };

        AnalysisResult {
            module_name: "security_events".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}
