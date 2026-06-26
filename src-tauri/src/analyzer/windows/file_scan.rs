use crate::analyzer::{AnalysisResult, Analyzer};
use chrono::{DateTime, Local};
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub struct FileScanAnalyzer;

#[derive(Debug, Clone, Serialize)]
struct FileFinding {
    name: String,
    path: String,
    category: String,
    size: u64,
    last_modified: String,
    suspicious: bool,
    reason: String,
}

const RECENT_TEMP_WINDOW: Duration = Duration::from_secs(86_400);
const RECENT_WEBROOT_WINDOW: Duration = Duration::from_secs(7 * 86_400);
const MAX_WEBROOT_DEPTH: usize = 10;
const MAX_WEBROOT_FILES: usize = 8_000;
const MAX_WEBROOT_FINDINGS: usize = 300;
const MAX_SCRIPT_READ_BYTES: u64 = 1024 * 1024;

impl FileScanAnalyzer {
    pub fn run_with_web_roots(web_roots: &[String]) -> AnalysisResult {
        let temp_dir = std::env::temp_dir();
        let recent_files = Self::collect_recent_temp_files(&temp_dir);
        let normalized_roots = Self::normalize_web_roots(web_roots);
        let findings = Self::collect_web_root_findings(&normalized_roots);
        let suspicious_count = findings.iter().filter(|finding| finding.suspicious).count();
        let recent_temp_file_count = recent_files.len();
        let web_root_count = normalized_roots.len();
        let finding_count = findings.len();
        let status = if suspicious_count > 0 {
            "warning"
        } else {
            "ok"
        };

        let details = json!({
            "temp_dir": temp_dir.display().to_string(),
            "recent_temp_files": recent_files,
            "web_roots": normalized_roots,
            "findings": findings,
            "statistics": {
                "recent_temp_file_count": recent_temp_file_count,
                "web_root_count": web_root_count,
                "finding_count": finding_count,
                "suspicious_count": suspicious_count
            }
        });

        let summary = if suspicious_count > 0 {
            format!(
                "文件扫描完成，发现 {} 个可疑 Web 脚本，{} 个最近临时文件",
                suspicious_count, recent_temp_file_count
            )
        } else {
            format!(
                "文件扫描完成，发现 {} 个最近临时文件，{} 个 Web 目录关注项",
                recent_temp_file_count, finding_count
            )
        };

        AnalysisResult {
            module_name: "file_scan".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }

    fn collect_recent_temp_files(temp_dir: &Path) -> Vec<String> {
        let mut recent_files = Vec::new();

        if let Ok(entries) = fs::read_dir(temp_dir) {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        let duration = SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default();
                        if duration < RECENT_TEMP_WINDOW {
                            recent_files.push(entry.path().display().to_string());
                        }
                    }
                }
            }
        }

        recent_files
    }

    fn normalize_web_roots(web_roots: &[String]) -> Vec<String> {
        let mut roots = Vec::new();

        for root in web_roots {
            let path = root.trim();
            if path.is_empty() || path == "-" {
                continue;
            }
            let normalized = path.replace('/', "\\");
            if roots
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&normalized))
            {
                continue;
            }
            if Path::new(&normalized).is_dir() {
                roots.push(normalized);
            }
        }

        roots
    }

    fn collect_web_root_findings(web_roots: &[String]) -> Vec<FileFinding> {
        let mut findings = Vec::new();

        for root in web_roots {
            Self::scan_web_root(Path::new(root), &mut findings);
            if findings.len() >= MAX_WEBROOT_FINDINGS {
                break;
            }
        }

        findings
    }

    fn scan_web_root(root: &Path, findings: &mut Vec<FileFinding>) {
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        let mut inspected_files = 0usize;

        while let Some((directory, depth)) = stack.pop() {
            if depth > MAX_WEBROOT_DEPTH
                || inspected_files >= MAX_WEBROOT_FILES
                || findings.len() >= MAX_WEBROOT_FINDINGS
            {
                continue;
            }

            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };

            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };

                if metadata.is_dir() {
                    if !Self::is_noise_directory(&path) {
                        stack.push((path, depth + 1));
                    }
                    continue;
                }

                if !metadata.is_file() {
                    continue;
                }

                inspected_files += 1;
                if let Some(finding) = Self::build_web_root_finding(&path, &metadata) {
                    findings.push(finding);
                    if findings.len() >= MAX_WEBROOT_FINDINGS {
                        break;
                    }
                }
            }
        }
    }

    fn is_noise_directory(path: &Path) -> bool {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        matches!(
            name.as_str(),
            ".git" | "node_modules" | "vendor" | "cache" | "runtime" | "logs" | "log"
        )
    }

    fn build_web_root_finding(path: &Path, metadata: &fs::Metadata) -> Option<FileFinding> {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_script = Self::is_web_script_extension(&extension);
        let is_recent = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|duration| duration < RECENT_WEBROOT_WINDOW);

        if !is_script && !is_recent {
            return None;
        }

        let content_reason = if is_script && metadata.len() <= MAX_SCRIPT_READ_BYTES {
            fs::read_to_string(path)
                .ok()
                .and_then(|content| Self::classify_script_content(path, &content))
        } else {
            None
        };
        let suspicious = content_reason.is_some();

        if !suspicious && !is_recent {
            return None;
        }

        Some(FileFinding {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.display().to_string(),
            category: "webroot".to_string(),
            size: metadata.len(),
            last_modified: metadata
                .modified()
                .ok()
                .map(Self::format_system_time)
                .unwrap_or_else(|| "-".to_string()),
            suspicious,
            reason: content_reason
                .unwrap_or_else(|| "Recent web-facing file modified within 7 days".to_string()),
        })
    }

    fn is_web_script_extension(extension: &str) -> bool {
        matches!(
            extension,
            "php" | "phtml" | "inc" | "asp" | "aspx" | "asa" | "ashx" | "jsp" | "jspx"
        )
    }

    fn classify_script_content(path: &Path, content: &str) -> Option<String> {
        let lower = content.to_ascii_lowercase();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let matched = if matches!(extension.as_str(), "php" | "phtml" | "inc") {
            [
                "eval(",
                "assert(",
                "base64_decode",
                "gzinflate",
                "shell_exec",
                "passthru",
                "system(",
            ]
            .iter()
            .filter(|pattern| lower.contains(**pattern))
            .copied()
            .collect::<Vec<_>>()
        } else if matches!(extension.as_str(), "jsp" | "jspx") {
            ["runtime.getruntime", "processbuilder"]
                .iter()
                .filter(|pattern| lower.contains(**pattern))
                .copied()
                .collect::<Vec<_>>()
        } else {
            [
                "execute(",
                "eval(",
                "wscript.shell",
                "cmd.exe",
                "powershell",
            ]
            .iter()
            .filter(|pattern| lower.contains(**pattern))
            .copied()
            .collect::<Vec<_>>()
        };

        if matched.is_empty() {
            None
        } else {
            Some(format!("Suspicious script traits: {}", matched.join(", ")))
        }
    }

    fn format_system_time(time: SystemTime) -> String {
        let datetime: DateTime<Local> = time.into();
        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

impl Analyzer for FileScanAnalyzer {
    fn name(&self) -> &str {
        "文件扫描"
    }

    fn run(&self) -> AnalysisResult {
        Self::run_with_web_roots(&[])
    }
}

#[cfg(test)]
mod tests {
    use super::FileScanAnalyzer;
    use std::fs;

    #[test]
    fn scans_web_roots_and_marks_suspicious_scripts() {
        let root = std::env::temp_dir().join(format!(
            "emergency-file-scan-webroot-{}",
            std::process::id()
        ));
        let upload_dir = root.join("upload");
        fs::create_dir_all(&upload_dir).expect("create test web root");
        let shell_path = upload_dir.join("shell.php");
        fs::write(&shell_path, "<?php eval(base64_decode($_POST['x'])); ?>")
            .expect("write suspicious script");

        let result = FileScanAnalyzer::run_with_web_roots(&[root.display().to_string()]);
        let findings = result
            .details
            .get("findings")
            .and_then(|value| value.as_array())
            .expect("file scan should emit structured findings");

        assert!(findings.iter().any(|finding| {
            finding
                .get("path")
                .and_then(|value| value.as_str())
                .is_some_and(|path| path.ends_with("shell.php"))
                && finding
                    .get("suspicious")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
        }));

        let _ = fs::remove_dir_all(root);
    }
}
