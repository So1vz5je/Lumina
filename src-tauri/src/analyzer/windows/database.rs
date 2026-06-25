use crate::analyzer::{AnalysisResult, Analyzer};
use serde_json::json;
use std::process::Command;

pub struct DatabaseAnalyzer;

impl Analyzer for DatabaseAnalyzer {
    fn name(&self) -> &str {
        "数据库"
    }

    fn run(&self) -> AnalysisResult {
        // 检查常见数据库服务
        let services_output = Command::new("net")
            .arg("start")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
            .unwrap_or_default();

        let mut found_dbs = Vec::new();

        if services_output.contains("mysql") {
            found_dbs.push("MySQL");
        }
        if services_output.contains("redis") {
            found_dbs.push("Redis");
        }
        if services_output.contains("postgresql") {
            found_dbs.push("PostgreSQL");
        }
        if services_output.contains("mssql") || services_output.contains("sql server") {
            found_dbs.push("SQL Server");
        }

        AnalysisResult {
            module_name: "database".to_string(),
            status: if found_dbs.is_empty() {
                "ok".to_string()
            } else {
                "info".to_string()
            },
            summary: if found_dbs.is_empty() {
                "未检测到运行中的数据库服务".to_string()
            } else {
                format!("检测到运行中的数据库: {}", found_dbs.join(", "))
            },
            details: json!({
                "running_services_raw": services_output,
                "detected_databases": found_dbs
            }),
        }
    }
}
