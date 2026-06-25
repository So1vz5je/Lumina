use crate::analyzer::{AnalysisResult, Analyzer};
use serde_json::json;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct FileScanAnalyzer;

impl Analyzer for FileScanAnalyzer {
    fn name(&self) -> &str {
        "文件扫描"
    }

    fn run(&self) -> AnalysisResult {
        // 扫描临时目录
        let temp_dir = std::env::temp_dir();
        let mut recent_files = Vec::new();

        if let Ok(entries) = fs::read_dir(&temp_dir) {
            for entry in entries.flatten() {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        let duration = SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default();
                        // 24小时内修改的文件
                        if duration.as_secs() < 86400 {
                            recent_files.push(entry.path().display().to_string());
                        }
                    }
                }
            }
        }

        let details = json!({
            "temp_dir": temp_dir.display().to_string(),
            "recent_temp_files": recent_files
        });

        AnalysisResult {
            module_name: "file_scan".to_string(),
            status: "ok".to_string(),
            summary: format!("扫描临时目录，发现{}个最近修改文件", recent_files.len()),
            details,
        }
    }
}
