use crate::analyzer::AnalysisResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiskEvidence {
    pub module_name: String,
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiskFinding {
    pub id: String,
    pub severity: String,
    pub title: String,
    pub reason: String,
    pub confidence: u8,
    pub affected: Vec<String>,
    pub evidence: Vec<RiskEvidence>,
    pub recommended_actions: Vec<String>,
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 4,
        "high" => 3,
        "medium" => 2,
        _ => 1,
    }
}

fn value_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| value_to_string(Some(item)))
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join("; "),
        Some(Value::Object(_)) => value.unwrap().to_string(),
        _ => String::new(),
    }
}

fn read_field(row: &Value, keys: &[&str]) -> String {
    for key in keys {
        let value = value_to_string(row.get(key));
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn get_array<'a>(details: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    for key in keys {
        if let Some(items) = details.get(key).and_then(Value::as_array) {
            return items.iter().collect();
        }
    }
    Vec::new()
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_path_under(path: &str, root: &str) -> bool {
    let normalized_path = normalize_path(path);
    let normalized_root = normalize_path(root);
    normalized_path == normalized_root
        || normalized_path.starts_with(&format!("{}\\", normalized_root))
}

fn make_id(prefix: &str, value: &str) -> String {
    let slug = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&ch) {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect::<String>();
    format!("{}-{}", prefix, slug)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if value.is_empty() {
        return;
    }
    if !values.iter().any(|item| item.eq_ignore_ascii_case(&value)) {
        values.push(value);
    }
}

fn push_finding(findings: &mut Vec<RiskFinding>, finding: RiskFinding) {
    if let Some(existing) = findings.iter_mut().find(|item| item.id == finding.id) {
        if severity_rank(&finding.severity) > severity_rank(&existing.severity) {
            existing.severity = finding.severity;
        }
        existing.confidence = existing.confidence.max(finding.confidence);
        for value in finding.affected {
            push_unique(&mut existing.affected, value);
        }
        existing.evidence.extend(finding.evidence);
        for action in finding.recommended_actions {
            push_unique(&mut existing.recommended_actions, action);
        }
        return;
    }

    findings.push(finding);
}

fn collect_panel_web_roots(results: &[AnalysisResult]) -> Vec<(String, String)> {
    let mut roots = Vec::new();

    for result in results
        .iter()
        .filter(|result| result.module_name == "panel")
    {
        for install in get_array(&result.details, &["detected_installs", "installs"]) {
            if install.get("detected").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let source = read_field(install, &["name", "Name", "panel_type", "panelType"]);
            let root = read_field(install, &["site_root", "siteRoot", "SiteRoot"]);
            if !root.is_empty() {
                roots.push((root, source));
            }
        }

        for site in get_array(&result.details, &["sites", "iis_sites"]) {
            let source = read_field(site, &["name", "Name", "source", "Source"]);
            let root = read_field(site, &["path", "Path", "PhysicalPath", "physical_path"]);
            if !root.is_empty() {
                roots.push((root, source));
            }
        }
    }

    roots
}

fn is_script_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".php", ".phtml", ".inc", ".asp", ".aspx", ".asa", ".ashx", ".jsp", ".jspx",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

fn build_webshell_findings(results: &[AnalysisResult], findings: &mut Vec<RiskFinding>) {
    let web_roots = collect_panel_web_roots(results);

    for result in results.iter().filter(|result| {
        matches!(
            result.module_name.as_str(),
            "file_scan" | "suspicious_files" | "webshell_scan"
        )
    }) {
        for row in get_array(
            &result.details,
            &["findings", "files", "suspicious_files", "matches"],
        ) {
            let path = read_field(
                row,
                &["path", "Path", "full_path", "fullPath", "file", "filePath"],
            );
            let name = read_field(row, &["name", "Name", "filename"]);
            let reason = read_field(
                row,
                &[
                    "reason",
                    "suspicious_reason",
                    "suspiciousReason",
                    "risk",
                    "Risk",
                    "signature",
                ],
            );
            let suspicious = row
                .get("suspicious")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || reason.to_ascii_lowercase().contains("eval")
                || reason.to_ascii_lowercase().contains("base64_decode")
                || reason.to_ascii_lowercase().contains("webshell");

            if path.is_empty() || !suspicious || !is_script_path(&path) {
                continue;
            }

            let Some((root, source)) = web_roots
                .iter()
                .find(|(root, _)| is_path_under(&path, root))
            else {
                continue;
            };

            push_finding(
                findings,
                RiskFinding {
                    id: make_id("webshell", &path),
                    severity: "critical".to_string(),
                    title: "疑似 WebShell 文件".to_string(),
                    reason: format!(
                        "Web 目录脚本命中高危执行特征：{}",
                        if reason.is_empty() {
                            "eval/base64_decode/system 等可疑代码特征"
                        } else {
                            reason.as_str()
                        }
                    ),
                    confidence: 92,
                    affected: vec![path.clone()],
                    evidence: vec![
                        RiskEvidence {
                            module_name: result.module_name.clone(),
                            label: if name.is_empty() {
                                "可疑脚本".to_string()
                            } else {
                                name
                            },
                            value: path.clone(),
                            time: Some(read_field(
                                row,
                                &["last_modified", "lastModified", "LastWriteTime", "time"],
                            ))
                            .filter(|value| !value.is_empty()),
                        },
                        RiskEvidence {
                            module_name: "panel".to_string(),
                            label: source.clone(),
                            value: root.clone(),
                            time: None,
                        },
                    ],
                    recommended_actions: vec![
                        "立即隔离该脚本文件并保留样本副本".to_string(),
                        "检查同目录近 7 天新增和修改文件".to_string(),
                        "关联 Web 访问日志、进程和外联连接确认利用时间".to_string(),
                    ],
                },
            );
        }
    }
}

fn format_endpoint(row: &Value) -> String {
    let address = read_field(
        row,
        &[
            "remote_address",
            "remoteAddress",
            "RemoteAddress",
            "address",
        ],
    );
    let port = read_field(row, &["remote_port", "remotePort", "RemotePort", "port"]);
    if address.is_empty() {
        return String::new();
    }
    if port.is_empty() || port == "0" {
        address
    } else {
        format!("{}:{}", address, port)
    }
}

fn build_process_network_findings(results: &[AnalysisResult], findings: &mut Vec<RiskFinding>) {
    let Some(process_result) = results
        .iter()
        .find(|result| result.module_name == "process")
    else {
        return;
    };
    let Some(network_result) = results
        .iter()
        .find(|result| result.module_name == "network")
    else {
        return;
    };
    let processes = get_array(
        &process_result.details,
        &["suspicious_list", "suspicious_processes", "processes"],
    );
    let connections = get_array(
        &network_result.details,
        &["external_connections", "connections"],
    );

    for process in processes {
        let reason = read_field(process, &["suspicious_reason", "suspiciousReason"]);
        let suspicious = process
            .get("suspicious")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || !reason.is_empty();
        if !suspicious {
            continue;
        }

        let pid = read_field(process, &["pid", "Pid", "Id"]);
        let process_name = read_field(process, &["name", "Name", "process_name", "processName"]);
        if pid.is_empty() {
            continue;
        }

        for connection in connections
            .iter()
            .filter(|connection| read_field(connection, &["pid", "Pid", "OwningProcess"]) == pid)
        {
            let endpoint = format_endpoint(connection);
            if endpoint.is_empty() {
                continue;
            }

            push_finding(
                findings,
                RiskFinding {
                    id: make_id(
                        "process-network",
                        &format!("{}-{}-{}", process_name, pid, endpoint),
                    ),
                    severity: "high".to_string(),
                    title: "可疑进程外联".to_string(),
                    reason: format!(
                        "{} 同时被进程分析标记可疑，并存在外联连接 {}。",
                        process_name, endpoint
                    ),
                    confidence: 86,
                    affected: vec![process_name.clone(), endpoint.clone()],
                    evidence: vec![
                        RiskEvidence {
                            module_name: "process".to_string(),
                            label: process_name.clone(),
                            value: read_field(process, &["path", "Path", "command", "CommandLine"]),
                            time: None,
                        },
                        RiskEvidence {
                            module_name: "network".to_string(),
                            label: endpoint.clone(),
                            value: read_field(connection, &["state", "State"]),
                            time: None,
                        },
                    ],
                    recommended_actions: vec![
                        "确认进程路径、签名和父进程".to_string(),
                        "阻断外联地址并抓取进程样本".to_string(),
                    ],
                },
            );
        }
    }
}

pub fn build_risk_findings(results: &[AnalysisResult]) -> Vec<RiskFinding> {
    let mut findings = Vec::new();

    build_webshell_findings(results, &mut findings);
    build_process_network_findings(results, &mut findings);

    findings.sort_by(|a, b| {
        severity_rank(&b.severity)
            .cmp(&severity_rank(&a.severity))
            .then_with(|| b.confidence.cmp(&a.confidence))
    });
    findings
}

#[cfg(test)]
mod tests {
    use super::build_risk_findings;
    use crate::analyzer::AnalysisResult;
    use serde_json::json;

    #[test]
    fn correlates_webroot_script_with_panel_context() {
        let results = vec![
            AnalysisResult {
                module_name: "panel".to_string(),
                status: "info".to_string(),
                summary: "detected phpStudy".to_string(),
                details: json!({
                    "detected_installs": [
                        {
                            "name": "PhpStudy Pro",
                            "site_root": "D:\\ctf-tools\\phpstudy_pro\\WWW",
                            "detected": true
                        }
                    ]
                }),
            },
            AnalysisResult {
                module_name: "file_scan".to_string(),
                status: "warning".to_string(),
                summary: "suspicious script".to_string(),
                details: json!({
                    "findings": [
                        {
                            "name": "shell.php",
                            "path": "D:\\ctf-tools\\phpstudy_pro\\WWW\\upload\\shell.php",
                            "suspicious": true,
                            "reason": "Suspicious script traits: eval(, base64_decode"
                        }
                    ]
                }),
            },
        ];

        let findings = build_risk_findings(&results);

        assert_eq!(findings[0].severity, "critical");
        assert_eq!(findings[0].title, "疑似 WebShell 文件");
        assert!(findings[0]
            .affected
            .iter()
            .any(|item| item.ends_with("shell.php")));
    }
}
