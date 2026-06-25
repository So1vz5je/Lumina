use crate::analyzer::{AnalysisResult, Analyzer};
use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAccount {
    pub name: String,
    pub full_name: String,
    pub comment: String,
    pub is_admin: bool,
    pub is_active: bool,
    pub last_logon: String,
    pub password_last_set: String,
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginSession {
    pub username: String,
    pub session_name: String,
    pub session_id: String,
    pub state: String,
    pub idle_time: String,
    pub logon_time: String,
}

pub struct UserTraceAnalyzer;

impl UserTraceAnalyzer {
    fn decode_command_output(bytes: &[u8]) -> String {
        match String::from_utf8(bytes.to_vec()) {
            Ok(text) => text,
            Err(_) => {
                let (text, _, had_errors) = GBK.decode(bytes);
                if had_errors {
                    String::from_utf8_lossy(bytes).to_string()
                } else {
                    text.into_owned()
                }
            }
        }
    }

    /// 解析 net user 输出
    fn parse_user_list(output: &str) -> Vec<String> {
        let mut users = Vec::new();
        let mut in_user_section = false;

        for line in output.lines() {
            let line = line.trim();

            if line.starts_with("---") {
                in_user_section = true;
                continue;
            }

            if line.starts_with("命令成功") || line.starts_with("The command") {
                break;
            }

            if in_user_section && !line.is_empty() {
                // 用户名通常用空格分隔
                for user in line.split_whitespace() {
                    if !user.is_empty() {
                        users.push(user.to_string());
                    }
                }
            }
        }

        users
    }

    /// 获取用户详细信息
    fn get_user_details(username: &str, admin_list: &[String]) -> Option<UserAccount> {
        let output = Command::new("net")
            .args(["user", username])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;

        let text = Self::decode_command_output(&output.stdout);

        let mut full_name = String::new();
        let mut comment = String::new();
        let mut is_active = true;
        let mut last_logon = String::new();
        let mut password_last_set = String::new();

        for line in text.lines() {
            let line = line.trim();

            if line.starts_with("全名") || line.starts_with("Full Name") {
                full_name = line
                    .split_whitespace()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join(" ");
            } else if line.starts_with("注释") || line.starts_with("Comment") {
                comment = line
                    .split_whitespace()
                    .skip(1)
                    .collect::<Vec<_>>()
                    .join(" ");
            } else if line.starts_with("账户活动") || line.starts_with("Account active") {
                is_active = line.contains("Yes") || line.contains("是");
            } else if line.starts_with("最后登录") || line.starts_with("Last logon") {
                last_logon = line
                    .split_whitespace()
                    .skip(2)
                    .collect::<Vec<_>>()
                    .join(" ");
            } else if line.starts_with("密码最后设置") || line.starts_with("Password last set")
            {
                password_last_set = line
                    .split_whitespace()
                    .skip(3)
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }

        let is_admin = admin_list
            .iter()
            .any(|a| a.to_lowercase() == username.to_lowercase());

        // 检测可疑用户
        let (suspicious, suspicious_reason) =
            Self::check_suspicious_user(username, &comment, is_admin);

        Some(UserAccount {
            name: username.to_string(),
            full_name,
            comment,
            is_admin,
            is_active,
            last_logon,
            password_last_set,
            suspicious,
            suspicious_reason,
        })
    }

    /// 检测可疑用户
    fn check_suspicious_user(
        username: &str,
        comment: &str,
        is_admin: bool,
    ) -> (bool, Option<String>) {
        let name_lower = username.to_lowercase();

        // 可疑用户名
        let suspicious_names = [
            "admin$",
            "support",
            "backup",
            "test",
            "guest",
            "temp",
            "user1",
            "user2",
            "scanner",
            "sqlservice",
        ];

        for s in suspicious_names {
            if name_lower == s || name_lower.contains(s) {
                if is_admin {
                    return (true, Some(format!("可疑管理员账户: {}", s)));
                }
            }
        }

        // 隐藏用户 (名称以 $ 结尾)
        if username.ends_with('$') && !username.ends_with("$") {
            return (true, Some("隐藏用户账户".to_string()));
        }

        // 空注释的管理员 (可能是后门账户)
        if is_admin && comment.is_empty() && !["Administrator", "管理员"].contains(&username) {
            return (true, Some("无注释的管理员账户".to_string()));
        }

        (false, None)
    }

    /// 解析登录会话
    fn parse_login_sessions(output: &str) -> Vec<LoginSession> {
        let mut sessions = Vec::new();

        for line in output.lines().skip(1) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            // 格式: USERNAME  SESSIONNAME  ID  STATE  IDLE TIME  LOGON TIME
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let username = parts[0].to_string();
                let session_name = if parts.len() > 4 {
                    parts[1].to_string()
                } else {
                    "".to_string()
                };
                let session_id = parts[parts.len() - 4].to_string();
                let state = parts[parts.len() - 3].to_string();
                let idle_time = parts[parts.len() - 2].to_string();
                let logon_time = parts[parts.len() - 1].to_string();

                sessions.push(LoginSession {
                    username,
                    session_name,
                    session_id,
                    state,
                    idle_time,
                    logon_time,
                });
            }
        }

        sessions
    }

    /// 解析管理员组
    fn parse_admin_group(output: &str) -> Vec<String> {
        let mut admins = Vec::new();
        let mut in_member_section = false;

        for line in output.lines() {
            let line = line.trim();

            if line.starts_with("---") {
                in_member_section = true;
                continue;
            }

            if line.starts_with("命令成功") || line.starts_with("The command") {
                break;
            }

            if in_member_section && !line.is_empty() {
                admins.push(line.to_string());
            }
        }

        admins
    }
}

impl Analyzer for UserTraceAnalyzer {
    fn name(&self) -> &str {
        "用户痕迹分析"
    }

    fn run(&self) -> AnalysisResult {
        // 获取用户列表
        let users_output = Command::new("net")
            .arg("user")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| Self::decode_command_output(&o.stdout))
            .unwrap_or_default();
        let user_names = Self::parse_user_list(&users_output);

        // 获取管理员组
        let admins_output = Command::new("net")
            .args(["localgroup", "administrators"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| Self::decode_command_output(&o.stdout))
            .unwrap_or_default();
        let admin_list = Self::parse_admin_group(&admins_output);

        // 获取每个用户的详细信息
        let mut users: Vec<UserAccount> = Vec::new();
        for name in &user_names {
            if let Some(user) = Self::get_user_details(name, &admin_list) {
                users.push(user);
            }
        }

        // 获取当前登录会话
        let sessions_output = Command::new("query")
            .arg("user")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| Self::decode_command_output(&o.stdout))
            .unwrap_or_default();
        let sessions = Self::parse_login_sessions(&sessions_output);

        // 统计
        let total_users = users.len();
        let admin_count = users.iter().filter(|u| u.is_admin).count();
        let active_count = users.iter().filter(|u| u.is_active).count();
        let suspicious_users: Vec<&UserAccount> = users.iter().filter(|u| u.suspicious).collect();
        let suspicious_count = suspicious_users.len();

        let details = json!({
            "users": users,
            "sessions": sessions,
            "admin_list": admin_list,
            "statistics": {
                "total_users": total_users,
                "admin_count": admin_count,
                "active_count": active_count,
                "login_sessions": sessions.len(),
                "suspicious_count": suspicious_count
            },
            "suspicious_users": suspicious_users,
            // 原始输出
            "users_raw": users_output,
            "admins_raw": admins_output,
            "sessions_raw": sessions_output
        });

        let status = if suspicious_count > 0 {
            "warning"
        } else {
            "ok"
        };
        let summary = if suspicious_count > 0 {
            format!(
                "发现 {} 个可疑用户, 共 {} 个账户",
                suspicious_count, total_users
            )
        } else {
            format!(
                "{} 个用户, {} 个管理员, {} 个登录会话",
                total_users,
                admin_count,
                sessions.len()
            )
        };

        AnalysisResult {
            module_name: "user_trace".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_gbk_user_names_from_net_output() {
        let gbk_bytes = [0xb9, 0xdc, 0xc0, 0xed, 0xd4, 0xb1];

        assert_eq!(
            UserTraceAnalyzer::decode_command_output(&gbk_bytes),
            "管理员"
        );
    }
}
