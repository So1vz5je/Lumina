mod ai;
mod analyzer;
mod everything;
mod license;
mod remote;
mod ssh;
mod windows_database;
mod workspace;

use analyzer::ScanRunPayload;
use encoding_rs::GBK;
use everything::{EverythingAvailability, EverythingSearchRequest, EverythingSearchResult};
use log::{error, info, warn};
use remote::connection_manager::ConnectionManager;
use remote::terminal_manager::{RemoteTerminalSession, TerminalManager, TerminalOutputEvent};
use remote::types::{RemoteConnectRequest, RemoteConnectionRecord, RemoteConnectionStatus};
use serde::{Deserialize, Serialize};
use ssh::{AuthMethod, CommandResult, SshClient, SshConfig, SshConnectionResult};
use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use sysinfo::{Disks, System};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    pub total_gb: f64,
    pub used_gb: f64,
    pub free_gb: f64,
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os_name: String,
    pub os_version: String,
    pub hostname: String,
    pub kernel_version: String,
    pub architecture: String,
    pub cpu_cores: usize,
    pub cpu_model: String,
    pub total_memory_gb: f64,
    pub used_memory_gb: f64,
    pub cpu_usage: f32,
    pub uptime_seconds: u64,
    pub boot_time: u64,
    pub boot_time_str: String,
    pub timezone: String,
    pub current_time: String,
    pub disks: Vec<DiskInfo>,
    pub ip_addresses: Vec<String>,
}

#[derive(Default)]
struct RemoteAppState {
    connection_manager: Mutex<ConnectionManager>,
    terminal_manager: Mutex<TerminalManager>,
    legacy_connect_lock: Mutex<()>,
}

fn close_terminal_sessions_for_connection(
    terminal_manager: &mut TerminalManager,
    connection_id: &str,
) -> usize {
    let closed_count = terminal_manager.close_sessions_for_connection(connection_id);
    if closed_count > 0 {
        info!(
            "Closed {} terminal sessions for connection {}",
            closed_count, connection_id
        );
    }

    closed_count
}

fn open_terminal_session_for_connection(
    connection_manager: &ConnectionManager,
    terminal_manager: &mut TerminalManager,
    connection_id: String,
    title: String,
) -> Result<RemoteTerminalSession, String> {
    let has_connection = connection_manager
        .list_records()
        .iter()
        .any(|record| record.id == connection_id);

    if !has_connection {
        return Err(format!("Connection not found: {}", connection_id));
    }

    if !connection_manager.is_connection_connected(&connection_id) {
        return Err(format!("Connection {} is not connected", connection_id));
    }

    Ok(terminal_manager.open_session(connection_id, title))
}

fn disconnect_active_connection_and_close_terminal_sessions(
    connection_manager: &mut ConnectionManager,
    terminal_manager: &mut TerminalManager,
) -> bool {
    let connection_id = connection_manager.active_connection_id().map(str::to_owned);
    let disconnected = connection_manager.disconnect_active();

    if disconnected {
        if let Some(connection_id) = connection_id {
            close_terminal_sessions_for_connection(terminal_manager, &connection_id);
        }
    }

    disconnected
}

fn mark_connection_error_and_close_terminal_sessions(
    connection_manager: &mut ConnectionManager,
    terminal_manager: &mut TerminalManager,
    connection_id: &str,
) {
    if connection_manager.mark_connection_status(connection_id, RemoteConnectionStatus::Error) {
        close_terminal_sessions_for_connection(terminal_manager, connection_id);
    }
}

fn establish_ssh_session(
    request: RemoteConnectRequest,
) -> Result<(RemoteConnectRequest, Arc<SshClient>, Option<String>), String> {
    let config = build_ssh_config(&request)?;
    let connect_request = request.clone();

    let client = Arc::new(SshClient::connect(&config)?);
    let os_type = client.detect_os().ok();

    Ok((connect_request, client, os_type))
}

fn build_ssh_config(request: &RemoteConnectRequest) -> Result<SshConfig, String> {
    Ok(SshConfig {
        host: request.host.clone(),
        port: request.port,
        username: request.username.clone(),
        auth_method: build_auth_method(request)?,
    })
}

fn build_auth_method(request: &RemoteConnectRequest) -> Result<AuthMethod, String> {
    if let Some(password) = request.password.clone() {
        Ok(AuthMethod::Password(password))
    } else if let Some(key_path) = request.private_key_path.clone() {
        Ok(AuthMethod::PrivateKey {
            key_path,
            passphrase: request.passphrase.clone(),
        })
    } else {
        Err("Please provide a password or private key".to_string())
    }
}

#[tauri::command]
fn get_system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_memory = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;
    let used_memory = sys.used_memory() as f64 / 1024.0 / 1024.0 / 1024.0;

    let cpu_model = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let disks_info = Disks::new_with_refreshed_list();
    let disks: Vec<DiskInfo> = disks_info
        .list()
        .iter()
        .map(|disk| {
            let total = disk.total_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            let free = disk.available_space() as f64 / 1024.0 / 1024.0 / 1024.0;
            let used = total - free;
            let usage_percent = if total > 0.0 {
                (used / total) * 100.0
            } else {
                0.0
            };

            DiskInfo {
                name: disk.name().to_string_lossy().to_string(),
                mount_point: disk.mount_point().to_string_lossy().to_string(),
                total_gb: total,
                used_gb: used,
                free_gb: free,
                usage_percent,
            }
        })
        .collect();

    let mut ip_addresses = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                ip_addresses.push(addr.ip().to_string());
            }
        }
    }

    use chrono::{Local, TimeZone};
    let boot_time_secs = System::boot_time();
    let boot_datetime = Local
        .timestamp_opt(boot_time_secs as i64, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let now = Local::now();
    let current_time = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let timezone = now.format("%Z").to_string();
    let architecture = std::env::consts::ARCH.to_string();

    SystemInfo {
        os_name: System::name().unwrap_or_else(|| "Unknown".to_string()),
        os_version: System::os_version().unwrap_or_else(|| "Unknown".to_string()),
        hostname: System::host_name().unwrap_or_else(|| "Unknown".to_string()),
        kernel_version: System::kernel_version().unwrap_or_else(|| "Unknown".to_string()),
        architecture,
        cpu_cores: sys.cpus().len(),
        cpu_model,
        total_memory_gb: total_memory,
        used_memory_gb: used_memory,
        cpu_usage: sys.global_cpu_info().cpu_usage(),
        uptime_seconds: System::uptime(),
        boot_time: boot_time_secs,
        boot_time_str: boot_datetime,
        timezone,
        current_time,
        disks,
        ip_addresses,
    }
}

#[tauri::command]
async fn run_scan(selected_modules: Option<Vec<String>>) -> ScanRunPayload {
    let selected_count = selected_modules.as_ref().map(|modules| modules.len());
    info!(
        "Starting scan with selected module count: {:?}",
        selected_count
    );
    let payload = tokio::task::spawn_blocking(move || {
        analyzer::run_scan_payload_sync(selected_modules.as_deref())
    })
    .await
    .unwrap_or_default();
    info!(
        "Scan completed with {} module results and {} risk findings",
        payload.module_results.len(),
        payload.risk_findings.len()
    );
    payload
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[tauri::command]
fn remote_connect(
    state: tauri::State<'_, RemoteAppState>,
    request: RemoteConnectRequest,
) -> Result<RemoteConnectionRecord, String> {
    info!(
        "Attempting remote connection {}@{}:{}",
        request.username, request.host, request.port
    );

    let (request, client, os_type) = establish_ssh_session(request)?;

    let mut manager = state
        .connection_manager
        .lock()
        .map_err(|_| "Failed to lock connection manager".to_string())?;

    Ok(manager.insert_connected(request, client, os_type, false))
}

#[tauri::command]
fn remote_open_terminal_session(
    state: tauri::State<'_, RemoteAppState>,
    connection_id: String,
    title: String,
) -> Result<RemoteTerminalSession, String> {
    let connection_manager = state
        .connection_manager
        .lock()
        .map_err(|_| "Failed to lock connection manager".to_string())?;

    let mut terminal_manager = state
        .terminal_manager
        .lock()
        .map_err(|_| "Failed to lock terminal manager".to_string())?;

    open_terminal_session_for_connection(
        &connection_manager,
        &mut terminal_manager,
        connection_id,
        title,
    )
}

#[tauri::command]
fn remote_run_terminal_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteAppState>,
    connection_id: String,
    session_id: String,
    command: String,
) -> Result<(), String> {
    let session_exists = {
        let terminal_manager = state
            .terminal_manager
            .lock()
            .map_err(|_| "Failed to lock terminal manager".to_string())?;

        terminal_manager
            .list_sessions_for_connection(&connection_id)
            .iter()
            .any(|session| session.id == session_id)
    };

    if !session_exists {
        return Err(format!(
            "Terminal session {} was not found for connection {}",
            session_id, connection_id
        ));
    }

    let client = {
        let manager = state
            .connection_manager
            .lock()
            .map_err(|_| "Failed to lock connection manager".to_string())?;

        manager
            .client_for_connection(&connection_id)
            .ok_or_else(|| format!("Connection {} is not connected", connection_id))?
    };

    let command_result = match client.execute(&command) {
        Ok(result) => result,
        Err(err) => {
            if let (Ok(mut connection_manager), Ok(mut terminal_manager)) = (
                state.connection_manager.lock(),
                state.terminal_manager.lock(),
            ) {
                mark_connection_error_and_close_terminal_sessions(
                    &mut connection_manager,
                    &mut terminal_manager,
                    &connection_id,
                );
            }
            return Err(err);
        }
    };

    let event_payload = TerminalOutputEvent {
        connection_id,
        session_id,
        command,
        stdout: command_result.stdout,
        stderr: command_result.stderr,
        exit_code: command_result.exit_code,
    };

    app.emit("remote://terminal-output", event_payload)
        .map_err(|err| format!("Failed to emit terminal output event: {}", err))?;

    Ok(())
}

#[tauri::command]
fn ssh_connect(
    state: tauri::State<'_, RemoteAppState>,
    request: SshConnectRequest,
) -> SshConnectionResult {
    info!(
        "Attempting SSH connection to {}:{}",
        request.host, request.port
    );
    let connection_name = format!("{}@{}", request.username, request.host);
    let remote_request = RemoteConnectRequest {
        name: connection_name,
        host: request.host,
        port: request.port,
        username: request.username,
        password: request.password,
        private_key_path: request.private_key_path,
        passphrase: request.passphrase,
    };

    let remote_request_for_connect = remote_request.clone();
    let _legacy_connect_guard = match state.legacy_connect_lock.lock() {
        Ok(guard) => guard,
        Err(_) => {
            error!("Failed to lock legacy SSH connect flow");
            return SshConnectionResult {
                success: false,
                message: "Failed to lock legacy SSH connect flow".to_string(),
                os_type: None,
            };
        }
    };

    match (
        state.connection_manager.lock(),
        state.terminal_manager.lock(),
    ) {
        (Ok(mut connection_manager), Ok(mut terminal_manager)) => {
            disconnect_active_connection_and_close_terminal_sessions(
                &mut connection_manager,
                &mut terminal_manager,
            );
        }
        (Err(_), _) | (_, Err(_)) => {
            error!("Failed to lock remote state");
            return SshConnectionResult {
                success: false,
                message: "Failed to lock remote state".to_string(),
                os_type: None,
            };
        }
    }

    match establish_ssh_session(remote_request_for_connect) {
        Ok((request, client, os_type)) => {
            let mut manager = match state.connection_manager.lock() {
                Ok(manager) => manager,
                Err(_) => {
                    error!("Failed to lock connection manager");
                    return SshConnectionResult {
                        success: false,
                        message: "Failed to lock connection manager".to_string(),
                        os_type: None,
                    };
                }
            };

            let record = manager.insert_connected(request, client, os_type, false);
            info!(
                "SSH connection succeeded, detected remote OS: {:?}",
                record.os_type
            );
            SshConnectionResult {
                success: true,
                message: "Connection successful".to_string(),
                os_type: record.os_type,
            }
        }
        Err(err) => {
            warn!("SSH connection failed: {}", err);
            SshConnectionResult {
                success: false,
                message: err,
                os_type: None,
            }
        }
    }
}

#[tauri::command]
fn ssh_execute(state: tauri::State<'_, RemoteAppState>, command: String) -> CommandResult {
    info!("Executing remote command: {}", command);
    let (connection_id, client) = match state.connection_manager.lock() {
        Ok(manager) => match manager.active_client() {
            Some(active_connection) => active_connection,
            None => {
                let err = "No active SSH connection".to_string();
                error!("Remote command execution failed: {}", err);
                return CommandResult {
                    success: false,
                    stdout: String::new(),
                    stderr: err,
                    exit_code: -1,
                };
            }
        },
        Err(_) => {
            error!("Failed to lock connection manager");
            return CommandResult {
                success: false,
                stdout: String::new(),
                stderr: "Failed to lock connection manager".to_string(),
                exit_code: -1,
            };
        }
    };

    match client.execute(&command) {
        Ok(result) => {
            if !result.success {
                warn!(
                    "Remote command completed with non-zero exit code: {}",
                    result.exit_code
                );
            }
            result
        }
        Err(err) => {
            if let (Ok(mut connection_manager), Ok(mut terminal_manager)) = (
                state.connection_manager.lock(),
                state.terminal_manager.lock(),
            ) {
                mark_connection_error_and_close_terminal_sessions(
                    &mut connection_manager,
                    &mut terminal_manager,
                    &connection_id,
                );
            }
            error!("Remote command execution failed: {}", err);
            CommandResult {
                success: false,
                stdout: String::new(),
                stderr: err,
                exit_code: -1,
            }
        }
    }
}

#[tauri::command]
fn ssh_disconnect(state: tauri::State<'_, RemoteAppState>) -> bool {
    match (
        state.connection_manager.lock(),
        state.terminal_manager.lock(),
    ) {
        (Ok(mut connection_manager), Ok(mut terminal_manager)) => {
            disconnect_active_connection_and_close_terminal_sessions(
                &mut connection_manager,
                &mut terminal_manager,
            )
        }
        (Err(_), _) | (_, Err(_)) => false,
    }
}

#[tauri::command]
async fn execute_local_command(command: String) -> CommandResult {
    info!("Executing local command: {}", command);
    run_local_command(&command)
}

#[tauri::command]
fn everything_available(app: tauri::AppHandle) -> EverythingAvailability {
    everything::check_available(&app)
}

#[tauri::command]
async fn everything_search(
    app: tauri::AppHandle,
    request: EverythingSearchRequest,
) -> Result<Vec<EverythingSearchResult>, String> {
    everything::search(app, request).await
}

#[tauri::command]
async fn everything_search_page(
    app: tauri::AppHandle,
    request: EverythingSearchRequest,
) -> Result<everything::EverythingSearchPageResponse, String> {
    everything::search_page(app, request).await
}

fn build_local_command_plan(command: &str, target_is_windows: bool) -> (String, Vec<String>) {
    if !target_is_windows {
        return (
            "sh".to_string(),
            vec!["-c".to_string(), command.to_string()],
        );
    }

    if let Some(script) = extract_powershell_command_script(command) {
        return build_windows_powershell_script_plan(&script);
    }

    if is_windows_shell_invocation(command) {
        return (
            "cmd".to_string(),
            vec!["/C".to_string(), format!("chcp 65001 >NUL && {}", command)],
        );
    }

    build_windows_powershell_script_plan(command)
}

fn build_windows_powershell_script_plan(script: &str) -> (String, Vec<String>) {
    (
        "powershell".to_string(),
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            format!(
                "$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
                script
            ),
        ],
    )
}

fn is_windows_shell_invocation(command: &str) -> bool {
    let normalized = command.trim_start().to_ascii_lowercase();
    normalized.starts_with("cmd ") || normalized.starts_with("cmd.exe ")
}

fn extract_powershell_command_script(command: &str) -> Option<String> {
    let trimmed = command.trim_start();
    let normalized = trimmed.to_ascii_lowercase();
    let starts_with_powershell = normalized.starts_with("powershell ")
        || normalized.starts_with("powershell.exe ")
        || normalized.starts_with("pwsh ")
        || normalized.starts_with("pwsh.exe ");
    if !starts_with_powershell {
        return None;
    }

    let command_arg_index = normalized.find("-command")?;
    let script_start = command_arg_index + "-command".len();
    let script = trimmed.get(script_start..)?.trim_start();
    if script.is_empty() {
        return None;
    }

    Some(strip_command_script_quotes(script))
}

fn strip_command_script_quotes(script: &str) -> String {
    let trimmed = script.trim();
    let unquoted = if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[trimmed.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            &trimmed[1..trimmed.len() - 1]
        } else {
            trimmed
        }
    } else {
        trimmed
    };

    unquoted.replace("\\\"", "\"")
}

fn run_local_command(command: &str) -> CommandResult {
    let (program, args) = build_local_command_plan(command, cfg!(target_os = "windows"));
    run_local_process(&program, &args)
}

fn run_local_process(program: &str, args: &[String]) -> CommandResult {
    run_local_process_with_env(program, args, &[])
}

fn run_local_process_with_env(
    program: &str,
    args: &[String],
    env: &[(String, String)],
) -> CommandResult {
    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = std::process::Command::new(program);
        command
            .args(args)
            .envs(env.iter().map(|(key, value)| (key, value)));
        command.creation_flags(CREATE_NO_WINDOW).output()
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        let mut command = std::process::Command::new(program);
        command
            .args(args)
            .envs(env.iter().map(|(key, value)| (key, value)));
        command.output()
    };

    match output {
        Ok(out) => CommandResult {
            success: out.status.success(),
            stdout: decode_process_output(&out.stdout),
            stderr: decode_process_output(&out.stderr),
            exit_code: out.status.code().unwrap_or(0),
        },
        Err(e) => CommandResult {
            success: false,
            stdout: String::new(),
            stderr: e.to_string(),
            exit_code: -1,
        },
    }
}

pub(crate) fn decode_process_output(bytes: &[u8]) -> String {
    if let Some(text) = decode_utf16_process_output(bytes) {
        return text;
    }

    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text,
        Err(_) => {
            let (text, _, had_errors) = GBK.decode(bytes);
            if had_errors {
                String::from_utf8_lossy(bytes).to_string()
            } else {
                text.into_owned()
            }
        }
    }
}

fn decode_utf16_process_output(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 {
        return None;
    }

    if bytes.starts_with(&[0xff, 0xfe]) {
        return Some(decode_utf16_units(&bytes[2..], true));
    }

    if bytes.starts_with(&[0xfe, 0xff]) {
        return Some(decode_utf16_units(&bytes[2..], false));
    }

    let pairs = bytes.len() / 2;
    if pairs < 2 {
        return None;
    }

    let odd_zeroes = bytes
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    let even_zeroes = bytes.iter().step_by(2).filter(|byte| **byte == 0).count();

    if odd_zeroes * 2 >= pairs {
        Some(decode_utf16_units(bytes, true))
    } else if even_zeroes * 2 >= pairs {
        Some(decode_utf16_units(bytes, false))
    } else {
        None
    }
}

fn decode_utf16_units(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect();

    String::from_utf16_lossy(&units)
}

#[tauri::command]
fn ssh_is_connected(state: tauri::State<'_, RemoteAppState>) -> bool {
    state
        .connection_manager
        .lock()
        .map(|manager| manager.is_connected())
        .unwrap_or(false)
}

#[tauri::command]
fn get_machine_info() -> license::MachineInfo {
    license::get_machine_info()
}

#[tauri::command]
fn verify_license(license_key: String) -> license::LicenseResult {
    license::verify_license(&license_key)
}

#[tauri::command]
fn activate_license(license_key: String) -> license::LicenseResult {
    let result = license::verify_license(&license_key);
    if result.valid {
        if let Err(e) = license::save_license(&license_key) {
            return license::LicenseResult {
                valid: false,
                message: e,
                info: result.info,
            };
        }
    }
    result
}

#[tauri::command]
fn check_license() -> license::LicenseResult {
    if let Some(license_key) = license::load_license() {
        license::verify_license(&license_key)
    } else {
        license::LicenseResult {
            valid: false,
            message: "License not found".to_string(),
            info: None,
        }
    }
}

#[tauri::command]
fn deactivate_license() -> Result<(), String> {
    license::remove_license()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RemoteAppState::default())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            run_scan,
            remote_connect,
            remote_open_terminal_session,
            remote_run_terminal_command,
            ssh_connect,
            ssh_execute,
            ssh_disconnect,
            ssh_is_connected,
            execute_local_command,
            everything_available,
            everything_search,
            everything_search_page,
            windows_database::windows_database_readonly,
            windows_database::windows_database_mutation,
            ai::ai_get_config,
            ai::ai_save_config,
            ai::ai_test_config,
            ai::ai_send_message,
            ai::ai_cancel_message,
            ai::ai_resolve_admin_approval,
            workspace::workspace_get_config,
            workspace::workspace_save_config,
            get_machine_info,
            verify_license,
            activate_license,
            check_license,
            deactivate_license
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_command_plan, disconnect_active_connection_and_close_terminal_sessions,
        mark_connection_error_and_close_terminal_sessions, open_terminal_session_for_connection,
    };
    use crate::remote::connection_manager::ConnectionManager;
    use crate::remote::terminal_manager::TerminalManager;
    use crate::remote::types::{RemoteConnectionRecord, RemoteConnectionStatus};

    fn build_test_record(
        connection_id: &str,
        status: RemoteConnectionStatus,
    ) -> RemoteConnectionRecord {
        RemoteConnectionRecord {
            id: connection_id.to_string(),
            name: format!("{}-name", connection_id),
            host: format!("{}.example", connection_id),
            port: 22,
            username: "root".to_string(),
            os_type: Some("Linux".to_string()),
            status,
        }
    }

    #[test]
    fn windows_local_command_plan_extracts_full_powershell_command_scripts() {
        let (program, args) = build_local_command_plan(
            "powershell.exe -NoProfile -Command \"$rows = @(); $rows | ConvertTo-Json\"",
            true,
        );

        assert_eq!(program, "powershell");
        assert_eq!(args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        assert!(args[3].contains("$OutputEncoding"));
        assert!(args[3].contains("$rows = @(); $rows | ConvertTo-Json"));
        assert!(!args[3].contains("powershell.exe -NoProfile -Command"));
    }

    #[test]
    fn windows_local_command_plan_wraps_bare_powershell_scripts() {
        let (program, args) = build_local_command_plan("Get-Process | ConvertTo-Json", true);

        assert_eq!(program, "powershell");
        assert_eq!(args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        assert!(args[3].contains("$OutputEncoding"));
        assert!(args[3].contains("Get-Process | ConvertTo-Json"));
    }

    #[test]
    fn local_process_output_decoder_falls_back_to_gbk_for_chinese_clients() {
        let decoded = super::decode_process_output(&[0xD5, 0xC5, 0xC8, 0xFD]);

        assert_eq!(decoded, "张三");
    }

    #[test]
    fn open_terminal_session_for_connection_rejects_disconnected_connections() {
        let mut connection_manager = ConnectionManager::default();
        let mut terminal_manager = TerminalManager::default();

        connection_manager.register_test_record(
            build_test_record("conn-1", RemoteConnectionStatus::Disconnected),
            false,
        );

        let result = open_terminal_session_for_connection(
            &connection_manager,
            &mut terminal_manager,
            "conn-1".to_string(),
            "Prod shell".to_string(),
        );

        assert_eq!(result.unwrap_err(), "Connection conn-1 is not connected");
        assert!(terminal_manager
            .list_sessions_for_connection("conn-1")
            .is_empty());
    }

    #[test]
    fn disconnect_active_connection_and_close_terminal_sessions_prunes_sessions() {
        let mut connection_manager = ConnectionManager::default();
        let mut terminal_manager = TerminalManager::default();

        connection_manager.register_test_record(
            build_test_record("conn-1", RemoteConnectionStatus::Connected),
            true,
        );
        terminal_manager.open_session("conn-1".to_string(), "Prod shell".to_string());
        terminal_manager.open_session("conn-1".to_string(), "Prod root".to_string());

        assert!(disconnect_active_connection_and_close_terminal_sessions(
            &mut connection_manager,
            &mut terminal_manager,
        ));
        assert!(terminal_manager
            .list_sessions_for_connection("conn-1")
            .is_empty());
        assert!(!connection_manager.is_connection_connected("conn-1"));
    }

    #[test]
    fn marking_connection_error_and_close_terminal_sessions_prunes_sessions() {
        let mut connection_manager = ConnectionManager::default();
        let mut terminal_manager = TerminalManager::default();

        connection_manager.register_test_record(
            build_test_record("conn-1", RemoteConnectionStatus::Connected),
            true,
        );
        terminal_manager.open_session("conn-1".to_string(), "Prod shell".to_string());

        mark_connection_error_and_close_terminal_sessions(
            &mut connection_manager,
            &mut terminal_manager,
            "conn-1",
        );

        assert!(terminal_manager
            .list_sessions_for_connection("conn-1")
            .is_empty());
        assert_eq!(connection_manager.active_connection_id(), None);
    }
}
