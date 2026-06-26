use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{path::BaseDirectory, Manager};

const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;
const ES_TIMEOUT_MS: &str = "3000";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EverythingSearchRequest {
    pub query: String,
    pub max_results: Option<usize>,
    pub offset: Option<usize>,
    pub path: Option<String>,
    pub files_only: Option<bool>,
    pub sort: Option<String>,
    pub sort_descending: Option<bool>,
    pub include_total_count: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EverythingSearchResult {
    pub full_path: String,
    pub name: String,
    pub parent_path: String,
    pub extension: String,
    pub size: Option<u64>,
    pub date_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EverythingSearchPageResponse {
    pub results: Vec<EverythingSearchResult>,
    pub total_count: Option<usize>,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EverythingAvailability {
    pub available: bool,
    pub es_path: Option<String>,
    pub es_version: Option<String>,
    pub everything_version: Option<String>,
    pub message: String,
}

pub fn check_available(app: &tauri::AppHandle) -> EverythingAvailability {
    let es_path = match resolve_es_path(app) {
        Ok(path) => path,
        Err(message) => {
            return EverythingAvailability {
                available: false,
                es_path: None,
                es_version: None,
                everything_version: None,
                message,
            };
        }
    };

    let es_version = run_es_command(&es_path, &["-version".to_string()])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let everything_version = run_es_command(&es_path, &["-get-everything-version".to_string()])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let available = es_version.is_some() && everything_version.is_some();
    let message = if available {
        "Everything command-line search is available".to_string()
    } else {
        "ES.exe was found, but Everything is not reachable. Start Everything and try again."
            .to_string()
    };

    EverythingAvailability {
        available,
        es_path: Some(es_path.display().to_string()),
        es_version,
        everything_version,
        message,
    }
}

pub async fn search(
    app: tauri::AppHandle,
    request: EverythingSearchRequest,
) -> Result<Vec<EverythingSearchResult>, String> {
    if request.query.trim().is_empty() {
        return Err("Everything search query cannot be empty".to_string());
    }

    let es_path = resolve_es_path(&app)?;
    tokio::task::spawn_blocking(move || search_with_es_path(&es_path, &request))
        .await
        .map_err(|err| format!("Everything search task failed: {}", err))?
}

pub async fn search_page(
    app: tauri::AppHandle,
    request: EverythingSearchRequest,
) -> Result<EverythingSearchPageResponse, String> {
    if request.query.trim().is_empty() {
        return Err("Everything search query cannot be empty".to_string());
    }

    let es_path = resolve_es_path(&app)?;
    tokio::task::spawn_blocking(move || search_page_with_es_path(&es_path, &request))
        .await
        .map_err(|err| format!("Everything paged search task failed: {}", err))?
}

fn search_with_es_path(
    es_path: &Path,
    request: &EverythingSearchRequest,
) -> Result<Vec<EverythingSearchResult>, String> {
    let stdout = run_es_command(es_path, &build_search_args(request))?;
    Ok(parse_tsv_output(&stdout))
}

fn search_page_with_es_path(
    es_path: &Path,
    request: &EverythingSearchRequest,
) -> Result<EverythingSearchPageResponse, String> {
    let limit = effective_limit(request);
    let offset = request.offset.unwrap_or(0);
    let results = search_with_es_path(es_path, request)?;
    let total_count = if request.include_total_count.unwrap_or(false) {
        run_result_count(es_path, request).ok()
    } else {
        None
    };
    let has_more = total_count
        .map(|count| offset.saturating_add(results.len()) < count)
        .unwrap_or(results.len() >= limit);

    Ok(EverythingSearchPageResponse {
        results,
        total_count,
        offset,
        limit,
        has_more,
    })
}

fn resolve_es_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    find_existing_es_path(&candidate_es_paths(app)).ok_or_else(|| {
        "ES.exe was not found. Expected src-tauri/bin/everything/es.exe or a bundled resource."
            .to_string()
    })
}

fn candidate_es_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(path) = std::env::var("LUMINA_ES_PATH") {
        if !path.trim().is_empty() {
            paths.push(PathBuf::from(path));
        }
    }

    if let Ok(path) = app
        .path()
        .resolve("bin/everything/es.exe", BaseDirectory::Resource)
    {
        paths.push(path);
    }

    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("everything")
            .join("es.exe"),
    );

    #[cfg(target_os = "windows")]
    {
        paths.push(PathBuf::from(r"C:\Program Files\Everything\es.exe"));
        paths.push(PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"));
    }

    paths
}

fn find_existing_es_path(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|path| path.is_file())
        .map(PathBuf::from)
}

fn effective_limit(request: &EverythingSearchRequest) -> usize {
    request
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS)
}

fn build_search_args(request: &EverythingSearchRequest) -> Vec<String> {
    let max_results = effective_limit(request);
    let mut args = vec![
        "-tsv".to_string(),
        "-no-header".to_string(),
        "-full-path-and-name".to_string(),
        "-name".to_string(),
        "-path-column".to_string(),
        "-extension".to_string(),
        "-size".to_string(),
        "-date-modified".to_string(),
        "-date-format".to_string(),
        "1".to_string(),
        "-size-format".to_string(),
        "1".to_string(),
        "-no-digit-grouping".to_string(),
        "-timeout".to_string(),
        ES_TIMEOUT_MS.to_string(),
    ];

    if let Some(sort) = normalized_sort_name(request.sort.as_deref()) {
        let direction = if request.sort_descending.unwrap_or(false) {
            "descending"
        } else {
            "ascending"
        };
        args.push("-sort".to_string());
        args.push(format!("{}-{}", sort, direction));
    }

    if let Some(offset) = request.offset.filter(|offset| *offset > 0) {
        args.push("-offset".to_string());
        args.push(offset.to_string());
    }

    args.push("-n".to_string());
    args.push(max_results.to_string());

    if let Some(path) = request
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        args.push("-path".to_string());
        args.push(path.to_string());
    }

    if request.files_only.unwrap_or(true) {
        args.push("/a-d".to_string());
    }

    args.push(request.query.trim().to_string());
    args
}

fn build_count_args(request: &EverythingSearchRequest) -> Vec<String> {
    let mut args = vec!["-timeout".to_string(), ES_TIMEOUT_MS.to_string()];

    if let Some(path) = request
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        args.push("-path".to_string());
        args.push(path.to_string());
    }

    if request.files_only.unwrap_or(true) {
        args.push("/a-d".to_string());
    }

    args.push("-get-result-count".to_string());
    args.push(request.query.trim().to_string());
    args
}

fn normalized_sort_name(sort: Option<&str>) -> Option<&'static str> {
    match sort?.trim().to_ascii_lowercase().as_str() {
        "name" => Some("name"),
        "path" => Some("path"),
        "size" => Some("size"),
        "extension" => Some("extension"),
        "date-created" => Some("date-created"),
        "date-modified" => Some("date-modified"),
        "date-accessed" => Some("date-accessed"),
        "date-recently-changed" => Some("date-recently-changed"),
        _ => None,
    }
}

fn run_result_count(es_path: &Path, request: &EverythingSearchRequest) -> Result<usize, String> {
    let stdout = run_es_command(es_path, &build_count_args(request))?;
    parse_result_count(&stdout)
}

fn parse_result_count(stdout: &str) -> Result<usize, String> {
    stdout
        .split_whitespace()
        .next()
        .map(|value| value.replace(',', ""))
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| format!("Unable to parse Everything result count: {}", stdout.trim()))
}

fn parse_tsv_output(stdout: &str) -> Vec<EverythingSearchResult> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.trim().is_empty() {
                return None;
            }

            let columns: Vec<&str> = line.split('\t').collect();
            if columns.len() < 6 {
                return None;
            }

            Some(EverythingSearchResult {
                full_path: columns[0].trim_start_matches('\u{feff}').to_string(),
                name: columns[1].to_string(),
                parent_path: columns[2].to_string(),
                extension: columns[3].to_string(),
                size: parse_size(columns[4]),
                date_modified: non_empty_string(columns[5]),
            })
        })
        .collect()
}

fn decode_es_output(bytes: &[u8]) -> String {
    crate::decode_process_output(bytes)
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn parse_size(value: &str) -> Option<u64> {
    let normalized = value.replace(',', "").trim().to_string();
    if normalized.is_empty() {
        return None;
    }

    normalized.parse().ok()
}

fn non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn run_es_command(es_path: &Path, args: &[String]) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new(es_path);
        command.args(args);
        command.creation_flags(CREATE_NO_WINDOW).output()
    };

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(es_path).args(args).output();

    let output = output.map_err(|err| format!("Failed to launch ES.exe: {}", err))?;
    let stdout = decode_es_output(&output.stdout);
    let stderr = decode_es_output(&output.stderr);

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "ES.exe failed with exit code {}. stdout: {} stderr: {}",
            output.status.code().unwrap_or(-1),
            stdout.trim(),
            stderr.trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_count_args, build_search_args, decode_es_output, find_existing_es_path,
        parse_result_count, parse_tsv_output, EverythingSearchRequest, EverythingSearchResult,
    };
    use std::path::PathBuf;

    #[test]
    fn build_search_args_uses_stable_tsv_layout_and_limits_results() {
        let args = build_search_args(&EverythingSearchRequest {
            query: "ext:exe;dll".to_string(),
            max_results: Some(25),
            offset: None,
            path: Some("C:\\Temp".to_string()),
            files_only: Some(true),
            sort: Some("date-modified".to_string()),
            sort_descending: Some(true),
            include_total_count: None,
        });

        assert_eq!(
            args,
            vec![
                "-tsv",
                "-no-header",
                "-full-path-and-name",
                "-name",
                "-path-column",
                "-extension",
                "-size",
                "-date-modified",
                "-date-format",
                "1",
                "-size-format",
                "1",
                "-no-digit-grouping",
                "-timeout",
                "3000",
                "-sort",
                "date-modified-descending",
                "-n",
                "25",
                "-path",
                "C:\\Temp",
                "/a-d",
                "ext:exe;dll",
            ]
        );
    }

    #[test]
    fn build_search_args_applies_offset_without_increasing_limit() {
        let args = build_search_args(&EverythingSearchRequest {
            query: "shell".to_string(),
            max_results: Some(50),
            offset: Some(100),
            path: None,
            files_only: Some(true),
            sort: None,
            sort_descending: None,
            include_total_count: Some(true),
        });

        assert!(args.windows(2).any(|pair| pair == ["-offset", "100"]));
        assert!(args.windows(2).any(|pair| pair == ["-n", "50"]));
    }

    #[test]
    fn build_count_args_uses_same_filters_without_result_columns() {
        let args = build_count_args(&EverythingSearchRequest {
            query: "shell".to_string(),
            max_results: Some(50),
            offset: Some(100),
            path: Some("C:\\inetpub\\wwwroot".to_string()),
            files_only: Some(true),
            sort: None,
            sort_descending: None,
            include_total_count: Some(true),
        });

        assert_eq!(
            args,
            vec![
                "-timeout",
                "3000",
                "-path",
                "C:\\inetpub\\wwwroot",
                "/a-d",
                "-get-result-count",
                "shell",
            ]
        );
    }

    #[test]
    fn parse_tsv_output_maps_es_columns_to_search_results() {
        let stdout = concat!(
            "C:\\Temp\\dropper.exe\tdropper.exe\tC:\\Temp\texe\t1234\t2026-06-25T12:00:00\r\n",
            "C:\\Temp\\empty.dll\tempty.dll\tC:\\Temp\tdll\t\t2026-06-25T12:05:00\r\n",
            "\r\n"
        );

        let results = parse_tsv_output(stdout);

        assert_eq!(
            results,
            vec![
                EverythingSearchResult {
                    full_path: "C:\\Temp\\dropper.exe".to_string(),
                    name: "dropper.exe".to_string(),
                    parent_path: "C:\\Temp".to_string(),
                    extension: "exe".to_string(),
                    size: Some(1234),
                    date_modified: Some("2026-06-25T12:00:00".to_string()),
                },
                EverythingSearchResult {
                    full_path: "C:\\Temp\\empty.dll".to_string(),
                    name: "empty.dll".to_string(),
                    parent_path: "C:\\Temp".to_string(),
                    extension: "dll".to_string(),
                    size: None,
                    date_modified: Some("2026-06-25T12:05:00".to_string()),
                },
            ]
        );
    }

    #[test]
    fn parse_result_count_accepts_plain_or_grouped_counts() {
        assert_eq!(parse_result_count("123\r\n"), Ok(123));
        assert_eq!(parse_result_count("1,234\r\n"), Ok(1234));
    }

    #[test]
    fn decode_es_output_preserves_utf16le_chinese_paths() {
        let tsv =
            "\u{feff}C:\\测试\\文件.php\t文件.php\tC:\\测试\tphp\t512\t2026-06-25T12:00:00\r\n";
        let bytes: Vec<u8> = tsv
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();

        let decoded = decode_es_output(&bytes);

        assert_eq!(
            decoded,
            "C:\\测试\\文件.php\t文件.php\tC:\\测试\tphp\t512\t2026-06-25T12:00:00\r\n"
        );
    }

    #[test]
    fn find_existing_es_path_prefers_first_available_candidate() {
        let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let candidates = vec![
            PathBuf::from("C:\\definitely\\missing\\es.exe"),
            manifest_path.clone(),
        ];

        assert_eq!(find_existing_es_path(&candidates), Some(manifest_path));
    }
}
