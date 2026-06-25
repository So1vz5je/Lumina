use crate::analyzer::{AnalysisResult, Analyzer};
use serde_json::json;
use sysinfo::System;

pub struct SystemInfoAnalyzer;

impl Analyzer for SystemInfoAnalyzer {
    fn name(&self) -> &str {
        "系统信息"
    }

    fn run(&self) -> AnalysisResult {
        let mut sys = System::new_all();
        sys.refresh_all();

        let os_name = System::name().unwrap_or_default();
        let os_version = System::os_version().unwrap_or_default();
        let hostname = System::host_name().unwrap_or_default();
        let kernel_version = System::kernel_version().unwrap_or_default();

        let total_memory = sys.total_memory();
        let used_memory = sys.used_memory();
        let total_swap = sys.total_swap();
        let used_swap = sys.used_swap();

        let cpus = sys.cpus();
        let cpu_model = cpus
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_default();
        let cpu_count = cpus.len();

        let details = json!({
            "os_name": os_name,
            "os_version": os_version,
            "hostname": hostname,
            "kernel_version": kernel_version,
            "cpu_model": cpu_model,
            "cpu_count": cpu_count,
            "memory": {
                "total": total_memory,
                "used": used_memory,
            },
            "swap": {
                "total": total_swap,
                "used": used_swap,
            }
        });

        AnalysisResult {
            module_name: "system_info".to_string(),
            status: "ok".to_string(),
            summary: format!("主机: {}, 系统: {} {}", hostname, os_name, os_version),
            details,
        }
    }
}
