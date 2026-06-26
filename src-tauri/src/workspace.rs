use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfigView {
    pub root_path: String,
    pub exports_path: String,
    pub ai_logs_path: String,
    pub collections_path: String,
    pub temp_path: String,
    pub admin_runs_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSaveRequest {
    pub root_path: String,
}

fn sanitize_machine_name(machine_name: &str) -> String {
    let sanitized: String = machine_name
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    let sanitized = sanitized.trim_matches([' ', '.']).to_string();
    if sanitized.is_empty() {
        "local".to_string()
    } else {
        sanitized
    }
}

fn default_workspace_root_from_base(base: &Path, machine_name: &str) -> PathBuf {
    base.join("Lumina Analyzer")
        .join("workspaces")
        .join(sanitize_machine_name(machine_name))
}

fn workspace_paths_from_root(root: &Path) -> WorkspaceConfigView {
    WorkspaceConfigView {
        root_path: root.to_string_lossy().to_string(),
        exports_path: root.join("exports").to_string_lossy().to_string(),
        ai_logs_path: root.join("ai_logs").to_string_lossy().to_string(),
        collections_path: root.join("collections").to_string_lossy().to_string(),
        temp_path: root.join("temp").to_string_lossy().to_string(),
        admin_runs_path: root.join("admin_runs").to_string_lossy().to_string(),
    }
}

pub fn ensure_workspace_paths(root: &Path) -> Result<WorkspaceConfigView, String> {
    let view = workspace_paths_from_root(root);
    for path in [
        &view.root_path,
        &view.exports_path,
        &view.ai_logs_path,
        &view.collections_path,
        &view.temp_path,
        &view.admin_runs_path,
    ] {
        fs::create_dir_all(path)
            .map_err(|err| format!("Failed to create workspace directory {}: {}", path, err))?;
    }
    Ok(view)
}

fn workspace_config_path() -> Result<PathBuf, String> {
    let mut dir =
        dirs::config_dir().ok_or_else(|| "Cannot locate user config directory".to_string())?;
    dir.push("Lumina Analyzer");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create workspace config directory: {}", err))?;
    dir.push("workspace_config.json");
    Ok(dir)
}

fn default_workspace_root() -> Result<PathBuf, String> {
    let base =
        dirs::data_local_dir().ok_or_else(|| "Cannot locate local data directory".to_string())?;
    let machine = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "local".to_string());
    Ok(default_workspace_root_from_base(&base, &machine))
}

fn load_workspace_root() -> Result<PathBuf, String> {
    let path = workspace_config_path()?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_workspace_root(),
    };
    let config: WorkspaceSaveRequest = serde_json::from_str(&content)
        .map_err(|err| format!("Invalid workspace config: {}", err))?;
    let trimmed = config.root_path.trim();
    if trimmed.is_empty() {
        default_workspace_root()
    } else {
        Ok(PathBuf::from(trimmed))
    }
}

fn save_workspace_root(root: &Path) -> Result<(), String> {
    let path = workspace_config_path()?;
    let content = serde_json::to_string_pretty(&WorkspaceSaveRequest {
        root_path: root.to_string_lossy().to_string(),
    })
    .map_err(|err| format!("Failed to encode workspace config: {}", err))?;
    fs::write(path, content).map_err(|err| format!("Failed to save workspace config: {}", err))
}

pub fn current_workspace_paths() -> Result<WorkspaceConfigView, String> {
    ensure_workspace_paths(&load_workspace_root()?)
}

#[tauri::command]
pub fn workspace_get_config() -> Result<WorkspaceConfigView, String> {
    current_workspace_paths()
}

#[tauri::command]
pub fn workspace_save_config(request: WorkspaceSaveRequest) -> Result<WorkspaceConfigView, String> {
    let root_path = request.root_path.trim();
    if root_path.is_empty() {
        return Err("Workspace path cannot be empty".to_string());
    }
    let root = PathBuf::from(root_path);
    let view = ensure_workspace_paths(&root)?;
    save_workspace_root(&root)?;
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_machine_names_for_workspace_paths() {
        assert_eq!(sanitize_machine_name("DESKTOP/IR:BOX"), "DESKTOP_IR_BOX");
        assert_eq!(sanitize_machine_name("   "), "local");
    }

    #[test]
    fn default_root_is_scoped_by_machine_name() {
        let root =
            default_workspace_root_from_base(Path::new(r"C:\Users\me\AppData\Local"), "IR-BOX");

        assert_eq!(
            root,
            Path::new(r"C:\Users\me\AppData\Local")
                .join("Lumina Analyzer")
                .join("workspaces")
                .join("IR-BOX")
        );
    }

    #[test]
    fn workspace_paths_use_standard_subdirectories() {
        let root = Path::new(r"C:\LuminaWorkspace");
        let view = workspace_paths_from_root(root);

        assert_eq!(view.root_path, root.to_string_lossy());
        assert_eq!(view.exports_path, root.join("exports").to_string_lossy());
        assert_eq!(view.ai_logs_path, root.join("ai_logs").to_string_lossy());
        assert_eq!(
            view.collections_path,
            root.join("collections").to_string_lossy()
        );
        assert_eq!(view.temp_path, root.join("temp").to_string_lossy());
        assert_eq!(
            view.admin_runs_path,
            root.join("admin_runs").to_string_lossy()
        );
    }

    #[test]
    fn ensure_workspace_paths_creates_standard_subdirectories() {
        let root =
            std::env::temp_dir().join(format!("lumina-workspace-test-{}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale test workspace");
        }

        let view = ensure_workspace_paths(&root).expect("workspace paths");

        for path in [
            &view.root_path,
            &view.exports_path,
            &view.ai_logs_path,
            &view.collections_path,
            &view.temp_path,
            &view.admin_runs_path,
        ] {
            assert!(Path::new(path).is_dir(), "{} should exist", path);
        }

        std::fs::remove_dir_all(&root).expect("cleanup test workspace");
    }
}
