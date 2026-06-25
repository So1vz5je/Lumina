use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecurityFinding {
    name: String,
    category: String,
    risk: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostsEntry {
    address: String,
    hostname: String,
    line: String,
    suspicious: bool,
    reason: String,
}

pub struct SecurityPostureAnalyzer;

impl SecurityPostureAnalyzer {
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
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    }

    fn parse_json(output: &str) -> Value {
        let trimmed = output.trim();
        if trimmed.is_empty() {
            return Value::Null;
        }

        serde_json::from_str(trimmed).unwrap_or(Value::Null)
    }

    fn value_bool(value: &Value, key: &str) -> Option<bool> {
        value.get(key).and_then(|item| item.as_bool())
    }

    fn value_string(value: &Value, key: &str) -> String {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string()
    }

    fn collect_defender() -> Value {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$status = Get-MpComputerStatus
if ($null -ne $status) {
  [pscustomobject]@{
    AntivirusEnabled = [bool]$status.AntivirusEnabled
    RealTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
    AMServiceEnabled = [bool]$status.AMServiceEnabled
    AntispywareEnabled = [bool]$status.AntispywareEnabled
    QuickScanAge = $status.QuickScanAge
    FullScanAge = $status.FullScanAge
    SignatureLastUpdated = $(if ($status.AntivirusSignatureLastUpdated) { $status.AntivirusSignatureLastUpdated.ToString('yyyy-MM-dd HH:mm:ss') } else { '' })
  } | ConvertTo-Json -Compress
}
"#;

        Self::parse_json(&Self::run_powershell(script))
    }

    fn collect_firewall_profiles() -> Value {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-NetFirewallProfile |
  Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction |
  ConvertTo-Json -Compress
"#;

        let value = Self::parse_json(&Self::run_powershell(script));
        match value {
            Value::Array(_) => value,
            Value::Null => Value::Array(Vec::new()),
            single => Value::Array(vec![single]),
        }
    }

    fn collect_rdp() -> Value {
        let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$terminalServer = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections
$service = Get-Service TermService
[pscustomobject]@{
  Enabled = ($terminalServer.fDenyTSConnections -eq 0)
  FDenyTSConnections = $terminalServer.fDenyTSConnections
  ServiceStatus = $(if ($service) { $service.Status.ToString() } else { '' })
  ServiceStartType = $(if ($service) { $service.StartType.ToString() } else { '' })
} | ConvertTo-Json -Compress
"#;

        Self::parse_json(&Self::run_powershell(script))
    }

    fn hosts_path() -> PathBuf {
        env::var("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Windows"))
            .join(r"System32\drivers\etc\hosts")
    }

    fn is_loopback_or_empty(address: &str) -> bool {
        let lower = address.to_ascii_lowercase();
        lower == "localhost" || lower == "::1" || lower == "0.0.0.0" || lower.starts_with("127.")
    }

    fn is_security_domain(hostname: &str) -> bool {
        let lower = hostname.to_ascii_lowercase();
        [
            "microsoft",
            "windowsupdate",
            "defender",
            "symantec",
            "kaspersky",
            "eset",
            "trendmicro",
            "crowdstrike",
            "sentinelone",
            "malwarebytes",
            "virustotal",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    }

    fn parse_hosts_entries(content: &str) -> Vec<HostsEntry> {
        let mut entries = Vec::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }

            let without_comment = trimmed.split('#').next().unwrap_or("").trim();
            let parts: Vec<&str> = without_comment.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }

            let address = parts[0].to_string();
            for hostname in parts.iter().skip(1) {
                let hostname = (*hostname).to_string();
                let blocks_security_domain =
                    Self::is_loopback_or_empty(&address) && Self::is_security_domain(&hostname);
                let suspicious = blocks_security_domain;
                let reason = if blocks_security_domain {
                    "hosts 文件疑似拦截安全厂商或系统更新域名".to_string()
                } else {
                    String::new()
                };

                entries.push(HostsEntry {
                    address: address.clone(),
                    hostname,
                    line: trimmed.to_string(),
                    suspicious,
                    reason,
                });
            }
        }

        entries
    }

    fn collect_hosts_entries() -> Vec<HostsEntry> {
        fs::read_to_string(Self::hosts_path())
            .map(|content| Self::parse_hosts_entries(&content))
            .unwrap_or_default()
    }

    fn build_findings(
        defender: &Value,
        firewall_profiles: &Value,
        rdp: &Value,
        hosts_entries: &[HostsEntry],
    ) -> Vec<SecurityFinding> {
        let mut findings = Vec::new();

        if defender.is_null() {
            findings.push(SecurityFinding {
                name: "无法读取 Defender 状态".to_string(),
                category: "Defender".to_string(),
                risk: "info".to_string(),
                detail: "Get-MpComputerStatus 未返回数据，可能未安装 Defender 或权限不足。"
                    .to_string(),
            });
        } else {
            if Self::value_bool(defender, "AntivirusEnabled") == Some(false) {
                findings.push(SecurityFinding {
                    name: "Defender 防病毒未启用".to_string(),
                    category: "Defender".to_string(),
                    risk: "warning".to_string(),
                    detail: "Windows Defender 防病毒处于关闭状态，需要确认是否被攻击者或策略关闭。"
                        .to_string(),
                });
            }

            if Self::value_bool(defender, "RealTimeProtectionEnabled") == Some(false) {
                findings.push(SecurityFinding {
                    name: "Defender 实时防护关闭".to_string(),
                    category: "Defender".to_string(),
                    risk: "warning".to_string(),
                    detail: "实时防护关闭会降低木马落地和横向移动检测能力。".to_string(),
                });
            }
        }

        if let Some(profiles) = firewall_profiles.as_array() {
            for profile in profiles {
                if Self::value_bool(profile, "Enabled") == Some(false) {
                    let profile_name = Self::value_string(profile, "Name");
                    findings.push(SecurityFinding {
                        name: format!("Windows 防火墙 {} 配置关闭", profile_name),
                        category: "Windows 防火墙".to_string(),
                        risk: "warning".to_string(),
                        detail: "至少一个防火墙配置文件未启用，应确认是否为临时排障或异常关闭。"
                            .to_string(),
                    });
                }
            }
        }

        if Self::value_bool(rdp, "Enabled") == Some(true) {
            let service_status = Self::value_string(rdp, "ServiceStatus");
            findings.push(SecurityFinding {
                name: "远程桌面已开启".to_string(),
                category: "远程访问".to_string(),
                risk: "warning".to_string(),
                detail: format!("RDP 入口开启，TermService 状态：{}。", service_status),
            });
        }

        for entry in hosts_entries.iter().filter(|entry| entry.suspicious) {
            findings.push(SecurityFinding {
                name: format!("hosts 可疑映射：{}", entry.hostname),
                category: "hosts 文件".to_string(),
                risk: "warning".to_string(),
                detail: entry.reason.clone(),
            });
        }

        findings
    }
}

impl Analyzer for SecurityPostureAnalyzer {
    fn name(&self) -> &str {
        "安全状态"
    }

    fn run(&self) -> AnalysisResult {
        let defender = Self::collect_defender();
        let firewall_profiles = Self::collect_firewall_profiles();
        let rdp = Self::collect_rdp();
        let hosts_entries = Self::collect_hosts_entries();
        let findings = Self::build_findings(&defender, &firewall_profiles, &rdp, &hosts_entries);

        let defender_realtime_enabled = Self::value_bool(&defender, "RealTimeProtectionEnabled");
        let firewall_disabled_count = firewall_profiles
            .as_array()
            .map(|profiles| {
                profiles
                    .iter()
                    .filter(|profile| Self::value_bool(profile, "Enabled") == Some(false))
                    .count()
            })
            .unwrap_or(0);
        let suspicious_hosts_count = hosts_entries
            .iter()
            .filter(|entry| entry.suspicious)
            .count();
        let finding_count = findings.len();

        let status = if finding_count > 0 { "warning" } else { "ok" };
        let summary = if finding_count > 0 {
            format!(
                "发现 {} 个安全状态关注项：防火墙关闭配置 {} 个，hosts 可疑映射 {} 条",
                finding_count, firewall_disabled_count, suspicious_hosts_count
            )
        } else {
            "Defender、防火墙、RDP 与 hosts 关键安全状态未发现明显异常".to_string()
        };

        let details = json!({
            "defender": defender,
            "firewall_profiles": firewall_profiles,
            "rdp": rdp,
            "hosts_entries": hosts_entries,
            "findings": findings,
            "statistics": {
                "finding_count": finding_count,
                "firewall_disabled_count": firewall_disabled_count,
                "suspicious_hosts_count": suspicious_hosts_count,
                "defender_realtime_enabled": defender_realtime_enabled
            }
        });

        AnalysisResult {
            module_name: "security_posture".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SecurityPostureAnalyzer;

    #[test]
    fn parses_suspicious_hosts_security_domain_mapping() {
        let entries = SecurityPostureAnalyzer::parse_hosts_entries(
            "127.0.0.1 www.microsoft.com\n192.168.1.20 internal.local\n",
        );

        assert_eq!(entries.len(), 2);
        assert!(entries[0].suspicious);
        assert!(!entries[1].suspicious);
    }
}
