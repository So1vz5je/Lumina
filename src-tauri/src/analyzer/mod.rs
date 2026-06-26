use serde::{Deserialize, Serialize};

pub mod risk;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AnalysisResult {
    pub module_name: String,
    pub status: String,
    pub summary: String,
    pub details: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanRunPayload {
    pub module_results: Vec<AnalysisResult>,
    pub risk_findings: Vec<risk::RiskFinding>,
    pub diagnostics: Vec<String>,
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
    PanelAnalyzer, PersistenceAnalyzer, ProcessAnalyzer, SecurityEventsAnalyzer,
    SecurityPostureAnalyzer, StartupAnalyzer, SystemInfoAnalyzer, UserTraceAnalyzer,
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
        ("security_posture", || SecurityPostureAnalyzer.run()),
    ]
}

fn should_run_analyzer(name: &str, selected_modules: Option<&[String]>) -> bool {
    selected_modules
        .map(|modules| modules.iter().any(|module| module == name))
        .unwrap_or(true)
}

fn push_unique_path(paths: &mut Vec<String>, value: Option<&serde_json::Value>) {
    let Some(path) = value.and_then(serde_json::Value::as_str) else {
        return;
    };
    let path = path.trim();
    if path.is_empty() || path == "-" {
        return;
    }

    if paths
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(path))
    {
        return;
    }

    paths.push(path.to_string());
}

fn collect_web_roots_from_results(results: &[AnalysisResult]) -> Vec<String> {
    let mut roots = Vec::new();

    for result in results
        .iter()
        .filter(|result| result.module_name == "panel")
    {
        for key in ["detected_installs", "installs"] {
            if let Some(items) = result
                .details
                .get(key)
                .and_then(serde_json::Value::as_array)
            {
                for item in items {
                    push_unique_path(
                        &mut roots,
                        item.get("site_root")
                            .or_else(|| item.get("siteRoot"))
                            .or_else(|| item.get("SiteRoot")),
                    );
                }
            }
        }

        for key in ["sites", "iis_sites"] {
            if let Some(items) = result
                .details
                .get(key)
                .and_then(serde_json::Value::as_array)
            {
                for item in items {
                    push_unique_path(
                        &mut roots,
                        item.get("path")
                            .or_else(|| item.get("Path"))
                            .or_else(|| item.get("PhysicalPath")),
                    );
                }
            }
        }
    }

    roots
}

fn collect_scan_diagnostics(results: &[AnalysisResult]) -> Vec<String> {
    let mut diagnostics = Vec::new();

    for result in results {
        if let Some(items) = result
            .details
            .get("diagnostics")
            .and_then(serde_json::Value::as_array)
        {
            for item in items {
                let Some(message) = item.as_str() else {
                    continue;
                };
                if message.trim().is_empty() {
                    continue;
                }
                diagnostics.push(format!("{}: {}", result.module_name, message.trim()));
            }
        }
    }

    diagnostics
}

/// 同步版本的扫描
pub fn run_scan_sync(selected_modules: Option<&[String]>) -> Vec<AnalysisResult> {
    let mut results = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let mut run_file_scan = false;

        for (name, runner) in windows_analyzer_runners() {
            if !should_run_analyzer(name, selected_modules) {
                continue;
            }

            if name == "file_scan" {
                run_file_scan = true;
                continue;
            }

            results.push(runner());
        }

        if run_file_scan {
            let web_roots = collect_web_roots_from_results(&results);
            results.push(FileScanAnalyzer::run_with_web_roots(&web_roots));
        }
    }

    results
}

pub fn run_scan_payload_sync(selected_modules: Option<&[String]>) -> ScanRunPayload {
    let module_results = run_scan_sync(selected_modules);
    let risk_findings = risk::build_risk_findings(&module_results);
    let diagnostics = collect_scan_diagnostics(&module_results);

    ScanRunPayload {
        module_results,
        risk_findings,
        diagnostics,
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::should_run_analyzer;

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
        assert!(module_names.contains(&"security_posture".to_string()));
    }

    #[test]
    fn selected_scan_modules_filter_registered_analyzers() {
        let selected = vec!["system_info".to_string(), "network".to_string()];

        assert!(should_run_analyzer("system_info", Some(&selected)));
        assert!(should_run_analyzer("network", Some(&selected)));
        assert!(!should_run_analyzer("file_scan", Some(&selected)));
        assert!(should_run_analyzer("file_scan", None));
    }

    #[test]
    fn collects_panel_web_roots_for_file_scan_context() {
        let results = vec![super::AnalysisResult {
            module_name: "panel".to_string(),
            status: "info".to_string(),
            summary: "detected panel".to_string(),
            details: serde_json::json!({
                "detected_installs": [
                    {
                        "name": "PhpStudy Pro",
                        "site_root": "D:\\ctf-tools\\phpstudy_pro\\WWW",
                        "detected": true
                    }
                ],
                "iis_sites": [
                    {
                        "name": "Default Web Site",
                        "path": "C:\\inetpub\\wwwroot"
                    }
                ]
            }),
        }];

        let roots = super::collect_web_roots_from_results(&results);

        assert!(roots
            .iter()
            .any(|root| root == "D:\\ctf-tools\\phpstudy_pro\\WWW"));
        assert!(roots.iter().any(|root| root == "C:\\inetpub\\wwwroot"));
    }

    #[test]
    fn scan_payload_contains_backend_risk_findings_and_diagnostics() {
        let results = vec![
            super::AnalysisResult {
                module_name: "panel".to_string(),
                status: "info".to_string(),
                summary: "detected panel".to_string(),
                details: serde_json::json!({
                    "detected_installs": [
                        {
                            "name": "PhpStudy Pro",
                            "site_root": "D:\\ctf-tools\\phpstudy_pro\\WWW",
                            "detected": true
                        }
                    ],
                    "diagnostics": ["Everything ES.exe: src-tauri/bin/everything/es.exe"]
                }),
            },
            super::AnalysisResult {
                module_name: "file_scan".to_string(),
                status: "warning".to_string(),
                summary: "suspicious script".to_string(),
                details: serde_json::json!({
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

        let risk_findings = super::risk::build_risk_findings(&results);
        let diagnostics = super::collect_scan_diagnostics(&results);

        assert_eq!(risk_findings[0].severity, "critical");
        assert!(diagnostics
            .iter()
            .any(|item| item.contains("Everything ES.exe")));
    }
}
