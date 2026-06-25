use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalysisResult {
    pub module_name: String,
    pub status: String,
    pub summary: String,
    pub details: serde_json::Value,
}

pub trait Analyzer {
    fn name(&self) -> &str;
    fn run(&self) -> AnalysisResult;
}

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "windows")]
use windows::{
    CronAnalyzer, DatabaseAnalyzer, DockerAnalyzer, FileScanAnalyzer, NetworkAnalyzer,
    PanelAnalyzer, PersistenceAnalyzer, ProcessAnalyzer, SecurityEventsAnalyzer, StartupAnalyzer,
    SystemInfoAnalyzer, UserTraceAnalyzer,
};

#[cfg(target_os = "windows")]
type AnalyzerRunner = fn() -> AnalysisResult;

#[cfg(target_os = "windows")]
fn windows_analyzer_runners() -> Vec<(&'static str, AnalyzerRunner)> {
    vec![
        ("system_info", || SystemInfoAnalyzer.run()),
        ("user_trace", || UserTraceAnalyzer.run()),
        ("network", || NetworkAnalyzer.run()),
        ("process", || ProcessAnalyzer.run()),
        ("file_scan", || FileScanAnalyzer.run()),
        ("startup", || StartupAnalyzer.run()),
        ("cron", || CronAnalyzer.run()),
        ("persistence", || PersistenceAnalyzer.run()),
        ("docker", || DockerAnalyzer.run()),
        ("panel", || PanelAnalyzer.run()),
        ("database", || DatabaseAnalyzer.run()),
        ("security_events", || SecurityEventsAnalyzer.run()),
    ]
}

/// 同步版本的扫描
pub fn run_scan_sync() -> Vec<AnalysisResult> {
    let mut results = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for (_, runner) in windows_analyzer_runners() {
            results.push(runner());
        }
    }

    results
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn windows_scan_includes_selected_optional_modules() {
        let module_names: Vec<String> = super::windows_analyzer_runners()
            .into_iter()
            .map(|(module_name, _)| module_name.to_string())
            .collect();

        assert!(module_names.contains(&"cron".to_string()));
        assert!(module_names.contains(&"persistence".to_string()));
        assert!(module_names.contains(&"docker".to_string()));
        assert!(module_names.contains(&"panel".to_string()));
    }
}
