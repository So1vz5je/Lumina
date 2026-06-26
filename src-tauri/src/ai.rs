use crate::workspace::{self, WorkspaceConfigView};
use chrono::Local;
use encoding_rs::{GBK, UTF_16BE, UTF_16LE};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const AI_STREAM_EVENT: &str = "ai://stream";
const AI_CANCELLED_ERROR: &str = "__AI_CANCELLED__";

static AI_CANCELLED_SESSIONS: Lazy<Mutex<BTreeSet<String>>> =
    Lazy::new(|| Mutex::new(BTreeSet::new()));
static AI_ADMIN_APPROVALS: Lazy<Mutex<BTreeMap<String, AdminApprovalHandle>>> =
    Lazy::new(|| Mutex::new(BTreeMap::new()));
static AI_ADMIN_APPROVED_SESSIONS: Lazy<Mutex<BTreeSet<String>>> =
    Lazy::new(|| Mutex::new(BTreeSet::new()));

struct AdminApprovalHandle {
    session_id: String,
    sender: mpsc::Sender<bool>,
}

fn default_max_tool_calls() -> u32 {
    12
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub show_reasoning: bool,
    pub tools_enabled: bool,
    #[serde(default = "default_max_tool_calls")]
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigRequest {
    pub provider: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub show_reasoning: bool,
    pub tools_enabled: bool,
    #[serde(default = "default_max_tool_calls")]
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub provider: String,
    pub base_url: String,
    pub api_key_preview: String,
    pub has_api_key: bool,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub show_reasoning: bool,
    pub tools_enabled: bool,
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkspaceContext {
    pub mode: String,
    pub os_type: String,
    pub current_module: String,
    pub scan_result_count: usize,
    pub scan_result_summaries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSendMessageRequest {
    pub session_id: String,
    pub messages: Vec<AiChatMessage>,
    pub context: AiWorkspaceContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub session_id: String,
    pub event_type: String,
    pub content: String,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedToolCallChunk {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTestResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct ParsedStreamChunk {
    pub content: Option<String>,
    pub reasoning: Option<String>,
    pub tool_name: Option<String>,
    pub tool_arguments: Option<String>,
    pub tool_calls: Vec<ParsedToolCallChunk>,
}

#[derive(Debug, Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct AiStreamResponse {
    content: String,
    tool_calls: Vec<AiToolCall>,
}

fn mark_ai_session_cancelled(session_id: &str) {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut sessions) = AI_CANCELLED_SESSIONS.lock() {
        sessions.insert(trimmed.to_string());
    }
}

fn clear_ai_session_cancelled(session_id: &str) {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut sessions) = AI_CANCELLED_SESSIONS.lock() {
        sessions.remove(trimmed);
    }
}

fn is_ai_session_cancelled(session_id: &str) -> bool {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return false;
    }
    AI_CANCELLED_SESSIONS
        .lock()
        .map(|sessions| sessions.contains(trimmed))
        .unwrap_or(false)
}

fn mark_admin_approved_for_session(session_id: &str) {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut sessions) = AI_ADMIN_APPROVED_SESSIONS.lock() {
        sessions.insert(trimmed.to_string());
    }
}

fn clear_admin_approved_for_session(session_id: &str) {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut sessions) = AI_ADMIN_APPROVED_SESSIONS.lock() {
        sessions.remove(trimmed);
    }
}

fn is_admin_approved_for_session(session_id: &str) -> bool {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return false;
    }
    AI_ADMIN_APPROVED_SESSIONS
        .lock()
        .map(|sessions| sessions.contains(trimmed))
        .unwrap_or(false)
}

fn ensure_ai_session_active(session_id: &str) -> Result<(), String> {
    if is_ai_session_cancelled(session_id) {
        return Err(AI_CANCELLED_ERROR.to_string());
    }
    Ok(())
}

pub fn default_ai_config() -> AiConfig {
    AiConfig {
        provider: "openai-compatible".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        api_key: String::new(),
        model: "gpt-4.1-mini".to_string(),
        temperature: 0.2,
        max_tokens: 2048,
        show_reasoning: true,
        tools_enabled: true,
        max_tool_calls: default_max_tool_calls(),
    }
}

pub fn merge_ai_config(existing: AiConfig, request: AiConfigRequest) -> AiConfig {
    let next_key = request
        .api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .unwrap_or(existing.api_key);

    AiConfig {
        provider: request.provider,
        base_url: request.base_url.trim().trim_end_matches('/').to_string(),
        api_key: next_key,
        model: request.model.trim().to_string(),
        temperature: request.temperature.clamp(0.0, 2.0),
        max_tokens: request.max_tokens.clamp(256, 32768),
        show_reasoning: request.show_reasoning,
        tools_enabled: request.tools_enabled,
        max_tool_calls: request.max_tool_calls.clamp(1, 50),
    }
}

pub fn config_to_view(config: AiConfig) -> AiConfigView {
    AiConfigView {
        provider: config.provider,
        base_url: config.base_url,
        api_key_preview: mask_api_key(&config.api_key),
        has_api_key: !config.api_key.trim().is_empty(),
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        show_reasoning: config.show_reasoning,
        tools_enabled: config.tools_enabled,
        max_tool_calls: config.max_tool_calls,
    }
}

fn mask_api_key(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "********".to_string();
    }
    let prefix: String = chars.iter().take(4).collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{}******{}", prefix, suffix)
}

fn ai_config_path() -> Result<PathBuf, String> {
    let mut dir =
        dirs::config_dir().ok_or_else(|| "Cannot locate user config directory".to_string())?;
    dir.push("Lumina Analyzer");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create AI config directory: {}", err))?;
    dir.push("ai_config.json");
    Ok(dir)
}

fn load_ai_config() -> AiConfig {
    let path = match ai_config_path() {
        Ok(path) => path,
        Err(_) => return default_ai_config(),
    };
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return default_ai_config(),
    };
    serde_json::from_str(&content).unwrap_or_else(|_| default_ai_config())
}

fn save_ai_config(config: &AiConfig) -> Result<(), String> {
    let path = ai_config_path()?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|err| format!("Failed to encode AI config: {}", err))?;
    fs::write(path, content).map_err(|err| format!("Failed to save AI config: {}", err))
}

#[tauri::command]
pub fn ai_get_config() -> Result<AiConfigView, String> {
    Ok(config_to_view(load_ai_config()))
}

#[tauri::command]
pub fn ai_save_config(request: AiConfigRequest) -> Result<AiConfigView, String> {
    let merged = merge_ai_config(load_ai_config(), request);
    save_ai_config(&merged)?;
    Ok(config_to_view(merged))
}

#[tauri::command]
pub fn ai_test_config(request: AiConfigRequest) -> Result<AiTestResult, String> {
    let config = merge_ai_config(load_ai_config(), request);
    if config.api_key.trim().is_empty() {
        return Ok(AiTestResult {
            success: false,
            message: "API Key 未配置".to_string(),
        });
    }
    if config.base_url.trim().is_empty() || config.model.trim().is_empty() {
        return Ok(AiTestResult {
            success: false,
            message: "Base URL 或 Model 未配置".to_string(),
        });
    }

    match send_test_chat_request(&config) {
        Ok(()) => Ok(AiTestResult {
            success: true,
            message: "模型连接成功，TEST 请求已返回有效响应".to_string(),
        }),
        Err(message) => Ok(AiTestResult {
            success: false,
            message,
        }),
    }
}

#[tauri::command]
pub fn ai_send_message(app: AppHandle, request: AiSendMessageRequest) -> Result<(), String> {
    clear_ai_session_cancelled(&request.session_id);
    let config = load_ai_config();
    let workspace = match workspace::current_workspace_paths() {
        Ok(workspace) => workspace,
        Err(err) => {
            emit_ai_event(
                &app,
                &request.session_id,
                "error",
                &format!("工作区初始化失败: {}", err),
                None,
            )?;
            return Ok(());
        }
    };
    if config.api_key.trim().is_empty() {
        emit_ai_event(
            &app,
            &request.session_id,
            "error",
            "请先在设置中配置 API Key",
            None,
        )?;
        return Ok(());
    }

    let session_id = request.session_id.clone();
    std::thread::spawn(move || {
        if let Err(err) = run_ai_session(&app, config, request, workspace) {
            if err == AI_CANCELLED_ERROR {
                let _ = emit_ai_event(&app, &session_id, "cancelled", "", None);
            } else {
                let _ = emit_ai_event(&app, &session_id, "error", &err, None);
            }
        }
        reject_pending_admin_approvals_for_session(&session_id);
        clear_admin_approved_for_session(&session_id);
        clear_ai_session_cancelled(&session_id);
    });

    Ok(())
}

#[tauri::command]
pub fn ai_cancel_message(app: AppHandle, session_id: String) -> Result<(), String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err("Missing AI session id".to_string());
    }
    mark_ai_session_cancelled(trimmed);
    reject_pending_admin_approvals_for_session(trimmed);
    clear_admin_approved_for_session(trimmed);
    emit_ai_event(&app, trimmed, "cancelled", "", None)
}

#[tauri::command]
pub fn ai_resolve_admin_approval(
    session_id: String,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    let mut approvals = AI_ADMIN_APPROVALS
        .lock()
        .map_err(|_| "Failed to lock AI admin approvals".to_string())?;
    let Some(handle) = approvals.remove(approval_id.trim()) else {
        return Ok(());
    };
    if handle.session_id != session_id.trim() {
        return Err("Approval session mismatch".to_string());
    }
    handle
        .sender
        .send(approved)
        .map_err(|err| format!("Failed to resolve admin approval: {}", err))?;
    if approved {
        mark_admin_approved_for_session(&handle.session_id);
    }
    Ok(())
}

fn run_ai_session(
    app: &AppHandle,
    config: AiConfig,
    request: AiSendMessageRequest,
    workspace: WorkspaceConfigView,
) -> Result<(), String> {
    ensure_ai_session_active(&request.session_id)?;
    let _ = log_ai_audit_event(
        &workspace,
        &request.session_id,
        "user_message",
        json!({
            "messages": &request.messages,
            "context": &request.context,
            "workspace": &workspace,
        }),
    );
    emit_ai_event(
        app,
        &request.session_id,
        "status",
        "AI 正在分析上下文",
        None,
    )?;

    match stream_openai_compatible_response(app, &config, &request, &workspace) {
        Ok(()) => {}
        Err(err) if err == AI_CANCELLED_ERROR => {
            emit_ai_event(app, &request.session_id, "cancelled", "", None)?;
            let _ = log_ai_audit_event(&workspace, &request.session_id, "cancelled", json!({}));
            return Ok(());
        }
        Err(err) => {
            let _ = log_ai_audit_event(
                &workspace,
                &request.session_id,
                "error",
                json!({ "message": &err }),
            );
            return Err(err);
        }
    }
    if is_ai_session_cancelled(&request.session_id) {
        emit_ai_event(app, &request.session_id, "cancelled", "", None)?;
        let _ = log_ai_audit_event(&workspace, &request.session_id, "cancelled", json!({}));
        return Ok(());
    }
    let _ = log_ai_audit_event(&workspace, &request.session_id, "done", json!({}));
    emit_ai_event(app, &request.session_id, "done", "", None)
}

fn build_workspace_state(context: &AiWorkspaceContext) -> String {
    format!(
        "mode={}, os={}, current_module={}, scan_result_count={}",
        context.mode, context.os_type, context.current_module, context.scan_result_count
    )
}

#[allow(dead_code)]
fn emit_tool_result(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    tool_name: &str,
    content: String,
) -> Result<(), String> {
    emit_ai_event(
        app,
        &request.session_id,
        "tool_call",
        "调用内置上下文工具",
        Some(tool_name),
    )?;
    emit_ai_event(
        app,
        &request.session_id,
        "tool_result",
        &content,
        Some(tool_name),
    )
}

fn emit_ai_event(
    app: &AppHandle,
    session_id: &str,
    event_type: &str,
    content: &str,
    tool_name: Option<&str>,
) -> Result<(), String> {
    app.emit(
        AI_STREAM_EVENT,
        AiStreamEvent {
            session_id: session_id.to_string(),
            event_type: event_type.to_string(),
            content: content.to_string(),
            tool_name: tool_name.map(str::to_string),
        },
    )
    .map_err(|err| format!("Failed to emit AI stream event: {}", err))
}

fn chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

fn build_ai_tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a local shell command for incident response analysis, including python commands. By default it runs in the current machine workspace without elevation. Set runAsAdmin=true only when the command genuinely requires administrator rights; the user must approve it before execution.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Command line to run in the local shell, for example: python -c \"print('ok')\""
                        },
                        "workingDirectory": {
                            "type": "string",
                            "description": "Optional working directory. Defaults to the current machine workspace root."
                        },
                        "timeoutSeconds": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 120,
                            "description": "Execution timeout. Defaults to 30 seconds."
                        },
                        "runAsAdmin": {
                            "type": "boolean",
                            "description": "Request administrator/UAC execution. Use only when non-elevated execution is insufficient; the user will see an approval prompt."
                        },
                        "reason": {
                            "type": "string",
                            "description": "Short reason shown to the user when runAsAdmin is true."
                        }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }
            }
        }
    ])
}

fn build_chat_payload_from_messages(
    config: &AiConfig,
    messages: Vec<Value>,
    include_tools: bool,
) -> Value {
    let mut payload = json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": true
    });
    if include_tools {
        payload["tools"] = build_ai_tool_definitions();
        payload["tool_choice"] = json!("auto");
    }
    payload
}

fn build_chat_payload(config: &AiConfig, request: &AiSendMessageRequest) -> Value {
    let mut messages = vec![json!({
        "role": "system",
        "content": "你是 Lumina 应急响应分析助手。基于工具结果和用户问题给出可执行、可验证的安全分析结论。输出中文，优先列出风险、证据、下一步操作。"
    })];
    messages.extend(request.messages.iter().map(|message| {
        json!({
            "role": message.role,
            "content": message.content,
        })
    }));

    build_chat_payload_from_messages(config, messages, config.tools_enabled)
}

fn build_agent_chat_messages(
    request: &AiSendMessageRequest,
    workspace: &WorkspaceConfigView,
) -> Vec<Value> {
    let mut messages = vec![
        json!({
            "role": "system",
            "content": "你是 Lumina 应急响应分析助手。基于用户问题、工作区上下文和工具结果给出可执行、可验证的安全分析结论。输出中文，优先列出风险、证据、下一步操作。需要本机信息时使用唯一工具 run_command 执行本机命令或 python 命令。默认工作目录是当前机器工作区，不要从项目目录或全盘开始无边界递归扫描；需要大范围采集时先列范围、分页或把结果保存到工作区。Windows 目录和文件检查优先使用 PowerShell Get-ChildItem -LiteralPath，并优先验证具体路径是否存在。When scanResultCount=0, clearly state that there are no loaded scan results before trying extra collection commands. Do not keep retrying the same failing command style; after two similar failures, explain the failure and switch to a smaller verification step or ask for missing context. 需要管理员权限时，在 run_command 参数中设置 runAsAdmin=true 并说明 reason，等待用户批准；不要直接包装 Start-Process -Verb RunAs、runas、sudo、gsudo。"
        }),
        json!({
            "role": "system",
            "content": format!(
                "当前分析上下文：{}。当前机器工作区 root={}，exports={}，ai_logs={}，collections={}，temp={}，admin_runs={}",
                build_workspace_state(&request.context),
                workspace.root_path,
                workspace.exports_path,
                workspace.ai_logs_path,
                workspace.collections_path,
                workspace.temp_path,
                workspace.admin_runs_path
            )
        }),
    ];
    messages.extend(request.messages.iter().map(|message| {
        json!({
            "role": message.role,
            "content": message.content,
        })
    }));
    messages
}

fn build_test_chat_payload(config: &AiConfig) -> Value {
    json!({
        "model": config.model,
        "messages": [
            {
                "role": "user",
                "content": "TEST"
            }
        ],
        "temperature": 0.0,
        "max_tokens": 8,
        "stream": false
    })
}

fn summarize_response_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "响应体为空".to_string();
    }
    let mut summary: String = trimmed.chars().take(500).collect();
    if trimmed.chars().count() > 500 {
        summary.push_str("...");
    }
    summary
}

fn send_test_chat_request(config: &AiConfig) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|err| format!("Failed to create AI client: {}", err))?;
    let response = client
        .post(chat_url(&config.base_url))
        .bearer_auth(&config.api_key)
        .json(&build_test_chat_payload(config))
        .send()
        .map_err(|err| format!("模型 TEST 请求失败: {}", err))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|err| format!("模型 TEST 响应读取失败: {}", err))?;
    if !status.is_success() {
        return Err(format!(
            "模型 TEST 请求返回 HTTP {}: {}",
            status.as_u16(),
            summarize_response_body(&body)
        ));
    }

    let value: Value = serde_json::from_str(&body).map_err(|err| {
        format!(
            "模型 TEST 响应不是有效 JSON: {}: {}",
            err,
            summarize_response_body(&body)
        )
    })?;
    let has_choice = value
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| !choices.is_empty());
    if !has_choice {
        return Err(format!(
            "模型 TEST 响应缺少 choices: {}",
            summarize_response_body(&body)
        ));
    }

    Ok(())
}

fn run_openai_compatible_agent_loop(
    app: &AppHandle,
    config: &AiConfig,
    request: &AiSendMessageRequest,
    workspace: &WorkspaceConfigView,
) -> Result<(), String> {
    let mut messages = build_agent_chat_messages(request, workspace);
    let max_tool_calls = if config.tools_enabled {
        config.max_tool_calls.max(1) as usize
    } else {
        0
    };
    let mut executed_tool_calls = 0usize;

    loop {
        ensure_ai_session_active(&request.session_id)?;
        let response = stream_chat_completion_round(app, config, request, messages.clone())?;
        ensure_ai_session_active(&request.session_id)?;
        if !response.content.trim().is_empty() {
            let _ = log_ai_audit_event(
                workspace,
                &request.session_id,
                "assistant_message",
                json!({ "content": &response.content }),
            );
        }
        if response.tool_calls.is_empty() {
            return Ok(());
        }

        let assistant_tool_calls: Vec<Value> = response
            .tool_calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments,
                    }
                })
            })
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": if response.content.is_empty() { Value::Null } else { Value::String(response.content.clone()) },
            "tool_calls": assistant_tool_calls,
        }));

        for call in response.tool_calls {
            if executed_tool_calls >= max_tool_calls {
                return Err(format!(
                    "AI tool call limit reached (maxToolCalls={}); increase it in Settings if this analysis really needs more tool steps.",
                    max_tool_calls
                ));
            }
            ensure_ai_session_active(&request.session_id)?;
            emit_ai_event(
                app,
                &request.session_id,
                "tool_call",
                &call.arguments,
                Some(&call.name),
            )?;
            let _ = log_ai_audit_event(
                workspace,
                &request.session_id,
                "tool_call",
                json!({
                    "toolName": call.name,
                    "arguments": call.arguments,
                }),
            );
            let tool_result = execute_ai_tool_for_request(app, request, &call, workspace);
            ensure_ai_session_active(&request.session_id)?;
            emit_ai_event(
                app,
                &request.session_id,
                "tool_result",
                &tool_result,
                Some(&call.name),
            )?;
            let _ = log_ai_audit_event(
                workspace,
                &request.session_id,
                "tool_result",
                json!({
                    "toolName": call.name,
                    "result": summarize_audit_content(&tool_result, 8_000),
                }),
            );
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": tool_result,
            }));
            executed_tool_calls += 1;
        }
    }
}

fn stream_chat_completion_round(
    app: &AppHandle,
    config: &AiConfig,
    request: &AiSendMessageRequest,
    messages: Vec<Value>,
) -> Result<AiStreamResponse, String> {
    ensure_ai_session_active(&request.session_id)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("Failed to create AI client: {}", err))?;
    let response = client
        .post(chat_url(&config.base_url))
        .bearer_auth(&config.api_key)
        .json(&build_chat_payload_from_messages(
            config,
            messages,
            config.tools_enabled,
        ))
        .send()
        .map_err(|err| format!("AI request failed: {}", err))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "AI request returned HTTP {}: {}",
            status.as_u16(),
            summarize_response_body(&body)
        ));
    }

    let mut collected = AiStreamResponse::default();
    let mut pending_tool_calls: BTreeMap<usize, PendingToolCall> = BTreeMap::new();
    let reader = BufReader::new(response);
    for line in reader.lines() {
        ensure_ai_session_active(&request.session_id)?;
        let line = line.map_err(|err| format!("AI stream read failed: {}", err))?;
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            break;
        }
        let parsed = parse_openai_stream_chunk(data);
        if let Some(reasoning) = parsed.reasoning {
            if config.show_reasoning {
                emit_ai_event(app, &request.session_id, "reasoning", &reasoning, None)?;
            }
        }
        if let Some(content) = parsed.content {
            collected.content.push_str(&content);
            emit_ai_event(app, &request.session_id, "token", &content, None)?;
        }
        for tool_call in parsed.tool_calls {
            let entry = pending_tool_calls.entry(tool_call.index).or_default();
            if let Some(id) = tool_call.id {
                if !id.is_empty() {
                    entry.id = id;
                }
            }
            if let Some(name) = tool_call.name {
                entry.name.push_str(&name);
            }
            if let Some(arguments) = tool_call.arguments {
                entry.arguments.push_str(&arguments);
            }
        }
    }

    collected.tool_calls = pending_tool_calls
        .into_iter()
        .filter_map(|(index, pending)| {
            if pending.name.trim().is_empty() {
                return None;
            }
            Some(AiToolCall {
                id: if pending.id.trim().is_empty() {
                    format!("call_{}", index)
                } else {
                    pending.id
                },
                name: pending.name,
                arguments: pending.arguments,
            })
        })
        .collect();
    Ok(collected)
}

fn tool_arg_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn tool_arg_u64(args: &Value, key: &str, default_value: u64, min: u64, max: u64) -> u64 {
    args.get(key)
        .and_then(Value::as_u64)
        .unwrap_or(default_value)
        .clamp(min, max)
}

fn tool_arg_bool(args: &Value, key: &str, default_value: bool) -> bool {
    args.get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default_value)
}

fn truncate_tool_output(content: String, max_chars: usize) -> String {
    let mut output: String = content.chars().take(max_chars).collect();
    if content.chars().count() > max_chars {
        output.push_str("\n...[truncated]");
    }
    output
}

fn summarize_audit_content(content: &str, max_chars: usize) -> Value {
    let summary: String = content.chars().take(max_chars).collect();
    json!({
        "content": summary,
        "truncated": content.chars().count() > max_chars,
    })
}

fn audit_log_path(workspace: &WorkspaceConfigView) -> PathBuf {
    let file_name = format!("{}.jsonl", Local::now().format("%Y-%m-%d"));
    Path::new(&workspace.ai_logs_path).join(file_name)
}

fn log_ai_audit_event(
    workspace: &WorkspaceConfigView,
    session_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<(), String> {
    fs::create_dir_all(&workspace.ai_logs_path)
        .map_err(|err| format!("Failed to create AI audit log directory: {}", err))?;
    let entry = json!({
        "ts": Local::now().to_rfc3339(),
        "sessionId": session_id,
        "eventType": event_type,
        "payload": payload,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_log_path(workspace))
        .map_err(|err| format!("Failed to open AI audit log: {}", err))?;
    writeln!(file, "{}", entry).map_err(|err| format!("Failed to write AI audit log: {}", err))
}

fn decode_tool_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (decoded, _, _) = UTF_16LE.decode(&bytes[2..]);
        return decoded.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (decoded, _, _) = UTF_16BE.decode(&bytes[2..]);
        return decoded.into_owned();
    }
    let (decoded, _, _) = GBK.decode(bytes);
    decoded.into_owned()
}

fn parse_tool_arguments(arguments: &str) -> Value {
    serde_json::from_str(arguments).unwrap_or_else(|_| json!({}))
}

#[cfg(test)]
fn execute_ai_tool(call: &AiToolCall, session_id: Option<&str>) -> String {
    let args = parse_tool_arguments(&call.arguments);
    match call.name.as_str() {
        "run_command" => execute_shell_command(&args, session_id),
        _ => format!("Unsupported tool: {}", call.name),
    }
}

fn execute_ai_tool_for_request(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    call: &AiToolCall,
    workspace: &WorkspaceConfigView,
) -> String {
    let args = parse_tool_arguments(&call.arguments);
    match call.name.as_str() {
        "run_command" => execute_shell_command_for_request(app, request, &args, workspace),
        _ => format!("Unsupported tool: {}", call.name),
    }
}

fn looks_like_elevation_request(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.contains("-verb runas")
        || lower.contains("start-process") && lower.contains("runas")
        || lower.split_whitespace().any(|part| {
            matches!(
                part.trim_matches(|ch: char| ch == '"'
                    || ch == '\''
                    || ch == ';'
                    || ch == '&'
                    || ch == '|'),
                "runas" | "runas.exe" | "sudo" | "pkexec" | "gsudo"
            )
        })
}

#[cfg(test)]
fn execute_shell_command(args: &Value, session_id: Option<&str>) -> String {
    let workspace = match workspace::current_workspace_paths() {
        Ok(workspace) => workspace,
        Err(err) => return format!("Failed to initialize workspace: {}", err),
    };
    execute_shell_command_with_workspace(args, session_id, &workspace)
}

fn execute_shell_command_for_request(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    args: &Value,
    workspace: &WorkspaceConfigView,
) -> String {
    if tool_arg_bool(args, "runAsAdmin", false) {
        return execute_admin_shell_command_with_approval(app, request, args, workspace);
    }
    execute_shell_command_with_workspace(args, Some(&request.session_id), workspace)
}

fn command_working_directory(args: &Value, workspace: &WorkspaceConfigView) -> String {
    tool_arg_string(args, "workingDirectory").unwrap_or_else(|| workspace.root_path.clone())
}

fn build_shell_command(
    command_line: &str,
    workspace: &WorkspaceConfigView,
) -> Result<(Command, Option<PathBuf>), String> {
    if cfg!(windows) {
        let run_dir = Path::new(&workspace.temp_path).join("ai_run_command");
        fs::create_dir_all(&run_dir)
            .map_err(|err| format!("Failed to create AI command temp directory: {}", err))?;
        let script_path = run_dir.join(format!(
            "run-{}-{}.cmd",
            std::process::id(),
            Local::now().timestamp_millis()
        ));
        let script = format!(
            "@echo off\r\nchcp 65001 >nul\r\n{}\r\nset __lumina_exit=%ERRORLEVEL%\r\nexit /b %__lumina_exit%\r\n",
            command_line
        );
        fs::write(&script_path, script)
            .map_err(|err| format!("Failed to write AI command script: {}", err))?;
        let mut command = Command::new("cmd");
        command.args(["/D", "/C", &script_path.to_string_lossy()]);
        Ok((command, Some(script_path)))
    } else {
        let mut command = Command::new("sh");
        command.args(["-lc", command_line]);
        Ok((command, None))
    }
}

fn cleanup_shell_script(script_path: Option<&PathBuf>) {
    if let Some(path) = script_path {
        let _ = fs::remove_file(path);
    }
}

fn execute_shell_command_with_workspace(
    args: &Value,
    session_id: Option<&str>,
    workspace: &WorkspaceConfigView,
) -> String {
    let Some(command_line) = tool_arg_string(args, "command") else {
        return "Missing required argument: command".to_string();
    };
    if looks_like_elevation_request(&command_line) {
        return "Blocked command: admin/UAC elevation is not allowed directly for AI tools. Use runAsAdmin=true so the user can approve the elevated command.".to_string();
    }

    let timeout_seconds = tool_arg_u64(args, "timeoutSeconds", 30, 1, 120);
    let working_directory = command_working_directory(args, workspace);
    if session_id.is_some_and(is_ai_session_cancelled) {
        return truncate_tool_output(
            format!(
                "command={}\nworkingDirectory={}\ntimeoutSeconds={}\ntimedOut=false\ncancelled=true\nexitCode=-1\nstdout:\n\nstderr:\nCommand cancelled before start",
                command_line,
                working_directory,
                timeout_seconds,
            ),
            24_000,
        );
    }

    let (mut command, cleanup_script_path) = match build_shell_command(&command_line, workspace) {
        Ok(command) => command,
        Err(err) => return err,
    };
    command.current_dir(&working_directory);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            cleanup_shell_script(cleanup_script_path.as_ref());
            return format!("Failed to run command: {}", err);
        }
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if session_id.is_some_and(is_ai_session_cancelled) {
                    let _ = child.kill();
                    let output = match child.wait_with_output() {
                        Ok(output) => output,
                        Err(err) => {
                            cleanup_shell_script(cleanup_script_path.as_ref());
                            return format!(
                                "Command cancelled and output collection failed: {}",
                                err
                            );
                        }
                    };
                    cleanup_shell_script(cleanup_script_path.as_ref());
                    return truncate_tool_output(
                        format!(
                            "command={}\nworkingDirectory={}\ntimeoutSeconds={}\ntimedOut=false\ncancelled=true\nexitCode={}\nstdout:\n{}\nstderr:\n{}{}",
                            command_line,
                            working_directory,
                            timeout_seconds,
                            output.status.code().unwrap_or(-1),
                            decode_tool_output(&output.stdout),
                            decode_tool_output(&output.stderr),
                            if output.stderr.is_empty() { "Command cancelled" } else { "\nCommand cancelled" },
                        ),
                        24_000,
                    );
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = match child.wait_with_output() {
                        Ok(output) => output,
                        Err(err) => {
                            cleanup_shell_script(cleanup_script_path.as_ref());
                            return format!(
                                "Command timed out and output collection failed: {}",
                                err
                            );
                        }
                    };
                    cleanup_shell_script(cleanup_script_path.as_ref());
                    return truncate_tool_output(
                        format!(
                            "command={}\nworkingDirectory={}\ntimeoutSeconds={}\ntimedOut=true\nexitCode={}\nstdout:\n{}\nstderr:\n{}",
                            command_line,
                            working_directory,
                            timeout_seconds,
                            output.status.code().unwrap_or(-1),
                            decode_tool_output(&output.stdout),
                            decode_tool_output(&output.stderr),
                        ),
                        24_000,
                    );
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(err) => {
                cleanup_shell_script(cleanup_script_path.as_ref());
                return format!("Failed while waiting for command: {}", err);
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(err) => {
            cleanup_shell_script(cleanup_script_path.as_ref());
            return format!("Failed to collect command output: {}", err);
        }
    };
    cleanup_shell_script(cleanup_script_path.as_ref());
    truncate_tool_output(
        format!(
            "command={}\nworkingDirectory={}\ntimeoutSeconds={}\ntimedOut=false\nexitCode={}\nstdout:\n{}\nstderr:\n{}",
            command_line,
            working_directory,
            timeout_seconds,
            output.status.code().unwrap_or(-1),
            decode_tool_output(&output.stdout),
            decode_tool_output(&output.stderr),
        ),
        24_000,
    )
}

fn build_admin_approval_payload(
    approval_id: &str,
    command_line: &str,
    working_directory: &str,
    reason: &str,
    timeout_seconds: u64,
) -> Value {
    json!({
        "approvalId": approval_id,
        "command": command_line,
        "workingDirectory": working_directory,
        "reason": reason,
        "timeoutSeconds": timeout_seconds,
    })
}

fn create_admin_approval_id(session_id: &str) -> String {
    let cleaned_session: String = session_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    format!(
        "admin-{}-{}-{}",
        cleaned_session,
        std::process::id(),
        Local::now().timestamp_millis()
    )
}

fn wait_for_admin_approval(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    workspace: &WorkspaceConfigView,
    approval_id: &str,
    payload: Value,
) -> Result<bool, String> {
    ensure_ai_session_active(&request.session_id)?;
    if is_admin_approved_for_session(&request.session_id) {
        let _ = log_ai_audit_event(
            workspace,
            &request.session_id,
            "admin_approval_decision",
            json!({
                "approvalId": approval_id,
                "approved": true,
                "reused": true,
            }),
        );
        return Ok(true);
    }

    let (sender, receiver) = mpsc::channel();
    {
        let mut approvals = AI_ADMIN_APPROVALS
            .lock()
            .map_err(|_| "Failed to lock AI admin approvals".to_string())?;
        approvals.insert(
            approval_id.to_string(),
            AdminApprovalHandle {
                session_id: request.session_id.clone(),
                sender,
            },
        );
    }

    let content = serde_json::to_string(&payload)
        .map_err(|err| format!("Failed to encode admin approval request: {}", err))?;
    emit_ai_event(
        app,
        &request.session_id,
        "admin_approval_request",
        &content,
        Some("run_command"),
    )?;
    let _ = log_ai_audit_event(
        workspace,
        &request.session_id,
        "admin_approval_request",
        payload,
    );

    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        ensure_ai_session_active(&request.session_id)?;
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(approved) => {
                let _ = log_ai_audit_event(
                    workspace,
                    &request.session_id,
                    "admin_approval_decision",
                    json!({
                        "approvalId": approval_id,
                        "approved": approved,
                    }),
                );
                return Ok(approved);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    if let Ok(mut approvals) = AI_ADMIN_APPROVALS.lock() {
                        approvals.remove(approval_id);
                    }
                    let _ = log_ai_audit_event(
                        workspace,
                        &request.session_id,
                        "admin_approval_decision",
                        json!({
                            "approvalId": approval_id,
                            "approved": false,
                            "reason": "timeout",
                        }),
                    );
                    return Ok(false);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(false),
        }
    }
}

fn reject_pending_admin_approvals_for_session(session_id: &str) {
    let Ok(mut approvals) = AI_ADMIN_APPROVALS.lock() else {
        return;
    };
    let ids: Vec<String> = approvals
        .iter()
        .filter_map(|(approval_id, handle)| {
            if handle.session_id == session_id {
                Some(approval_id.clone())
            } else {
                None
            }
        })
        .collect();
    for approval_id in ids {
        if let Some(handle) = approvals.remove(&approval_id) {
            let _ = handle.sender.send(false);
        }
    }
}

fn execute_admin_shell_command_with_approval(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    args: &Value,
    workspace: &WorkspaceConfigView,
) -> String {
    let Some(command_line) = tool_arg_string(args, "command") else {
        return "Missing required argument: command".to_string();
    };
    if looks_like_elevation_request(&command_line) {
        return "Blocked command: admin/UAC elevation is not allowed directly for AI tools. Send the raw command with runAsAdmin=true instead.".to_string();
    }
    let timeout_seconds = tool_arg_u64(args, "timeoutSeconds", 30, 1, 120);
    let working_directory = command_working_directory(args, workspace);
    let reason = tool_arg_string(args, "reason")
        .unwrap_or_else(|| "AI 请求管理员权限执行本机命令".to_string());
    let approval_id = create_admin_approval_id(&request.session_id);
    let payload = build_admin_approval_payload(
        &approval_id,
        &command_line,
        &working_directory,
        &reason,
        timeout_seconds,
    );

    match wait_for_admin_approval(app, request, workspace, &approval_id, payload) {
        Ok(true) => execute_approved_admin_command(
            &command_line,
            &working_directory,
            timeout_seconds,
            workspace,
            &approval_id,
            Some(&request.session_id),
        ),
        Ok(false) => truncate_tool_output(
            format!(
                "command={}\nworkingDirectory={}\ntimeoutSeconds={}\nrunAsAdmin=true\napproved=false\ntimedOut=false\nexitCode=-1\nstdout:\n\nstderr:\nUser denied or did not approve the admin command.",
                command_line, working_directory, timeout_seconds
            ),
            24_000,
        ),
        Err(err) => err,
    }
}

fn ps_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sanitize_admin_run_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect()
}

fn read_admin_output_file(
    path: &Path,
    file_name: &str,
    missing_files: &mut Vec<String>,
    diagnostics: &mut Vec<String>,
) -> String {
    match fs::read(path) {
        Ok(bytes) => decode_tool_output(&bytes),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            missing_files.push(file_name.to_string());
            String::new()
        }
        Err(err) => {
            diagnostics.push(format!(
                "Failed to read admin result file {}: {}",
                file_name, err
            ));
            String::new()
        }
    }
}

fn read_admin_exit_code(
    path: &Path,
    missing_files: &mut Vec<String>,
    diagnostics: &mut Vec<String>,
) -> i32 {
    match fs::read_to_string(path) {
        Ok(value) => match value.trim().parse::<i32>() {
            Ok(code) => code,
            Err(err) => {
                diagnostics.push(format!(
                    "Admin command exit file did not contain a valid exit code: {}",
                    err
                ));
                -1
            }
        },
        Err(err) if err.kind() == ErrorKind::NotFound => {
            missing_files.push("exit.txt".to_string());
            diagnostics.push(
                "Admin command did not write result files. UAC may have been cancelled, the elevated process may not have started, or output capture failed."
                    .to_string(),
            );
            -1
        }
        Err(err) => {
            diagnostics.push(format!(
                "Failed to read admin result file exit.txt: {}",
                err
            ));
            -1
        }
    }
}

fn format_admin_command_result(
    command_line: &str,
    working_directory: &str,
    timeout_seconds: u64,
    run_dir: &Path,
    stdout_path: &Path,
    stderr_path: &Path,
    exit_path: &Path,
    launcher_stdout: &str,
    launcher_stderr: &str,
    launcher_exit_code: i32,
) -> String {
    let mut missing_files = Vec::new();
    let mut diagnostics = Vec::new();
    let stdout = read_admin_output_file(
        stdout_path,
        "stdout.txt",
        &mut missing_files,
        &mut diagnostics,
    );
    let stderr = read_admin_output_file(
        stderr_path,
        "stderr.txt",
        &mut missing_files,
        &mut diagnostics,
    );
    let exit_code = read_admin_exit_code(exit_path, &mut missing_files, &mut diagnostics);

    if !missing_files.is_empty() {
        diagnostics.push(format!(
            "Missing admin result files: {}",
            missing_files.join(", ")
        ));
    }
    if !launcher_stdout.trim().is_empty() {
        diagnostics.push(format!("launcher stdout:\n{}", launcher_stdout.trim_end()));
    }
    if !launcher_stderr.trim().is_empty() {
        diagnostics.push(format!("launcher stderr:\n{}", launcher_stderr.trim_end()));
    }

    let combined_stderr = if stderr.trim().is_empty() {
        diagnostics.join("\n")
    } else if diagnostics.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stderr.trim_end(), diagnostics.join("\n"))
    };

    format!(
        "command={}\nworkingDirectory={}\ntimeoutSeconds={}\nrunAsAdmin=true\napproved=true\ntimedOut=false\nexitCode={}\nadminRunDirectory={}\nlauncherExitCode={}\nstdout:\n{}\nstderr:\n{}",
        command_line,
        working_directory,
        timeout_seconds,
        exit_code,
        run_dir.to_string_lossy(),
        launcher_exit_code,
        stdout,
        combined_stderr
    )
}

#[cfg(target_os = "windows")]
fn execute_approved_admin_command(
    command_line: &str,
    working_directory: &str,
    timeout_seconds: u64,
    workspace: &WorkspaceConfigView,
    approval_id: &str,
    session_id: Option<&str>,
) -> String {
    let run_dir = Path::new(&workspace.admin_runs_path).join(sanitize_admin_run_name(approval_id));
    if let Err(err) = fs::create_dir_all(&run_dir) {
        return format!("Failed to create admin run directory: {}", err);
    }
    let script_path = run_dir.join("run.ps1");
    let stdout_path = run_dir.join("stdout.txt");
    let stderr_path = run_dir.join("stderr.txt");
    let exit_path = run_dir.join("exit.txt");
    let script = format!(
        "$ErrorActionPreference = 'Continue'\n\
         $OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         Set-Location -LiteralPath {}\n\
         $commandText = {}\n\
         $stdoutPath = {}\n\
         $stderrPath = {}\n\
         $exitPath = {}\n\
         try {{\n\
           cmd.exe /D /C $commandText 1> $stdoutPath 2> $stderrPath\n\
           $code = $LASTEXITCODE\n\
           if ($null -eq $code) {{ $code = 0 }}\n\
         }} catch {{\n\
           $_ | Out-File -FilePath $stderrPath -Encoding utf8\n\
           $code = 1\n\
         }}\n\
         Set-Content -LiteralPath $exitPath -Value $code -Encoding utf8\n",
        ps_single_quoted(working_directory),
        ps_single_quoted(command_line),
        ps_single_quoted(&stdout_path.to_string_lossy()),
        ps_single_quoted(&stderr_path.to_string_lossy()),
        ps_single_quoted(&exit_path.to_string_lossy())
    );
    if let Err(err) = fs::write(&script_path, script) {
        return format!("Failed to write admin command script: {}", err);
    }

    let start_command = format!(
        "Start-Process -FilePath powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',{}) -Verb RunAs -Wait -WindowStyle Hidden",
        ps_single_quoted(&script_path.to_string_lossy())
    );
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &start_command,
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return format!("Failed to start admin command approval process: {}", err),
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if session_id.is_some_and(is_ai_session_cancelled) {
                    let _ = child.kill();
                    return truncate_tool_output(
                        format!(
                            "command={}\nworkingDirectory={}\ntimeoutSeconds={}\nrunAsAdmin=true\napproved=true\ntimedOut=false\ncancelled=true\nexitCode=-1\nstdout:\n\nstderr:\nCommand cancelled",
                            command_line, working_directory, timeout_seconds
                        ),
                        24_000,
                    );
                }
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return format!("Failed while waiting for admin command: {}", err),
        }
    }
    let parent_output = match child.wait_with_output() {
        Ok(output) => output,
        Err(err) => return format!("Failed to collect admin command launcher output: {}", err),
    };
    if timed_out {
        return truncate_tool_output(
            format!(
                "command={}\nworkingDirectory={}\ntimeoutSeconds={}\nrunAsAdmin=true\napproved=true\ntimedOut=true\nexitCode=-1\nstdout:\n{}\nstderr:\n{}\nAdmin command launcher timed out. The elevated process may still be running if UAC was approved.",
                command_line,
                working_directory,
                timeout_seconds,
                decode_tool_output(&parent_output.stdout),
                decode_tool_output(&parent_output.stderr)
            ),
            24_000,
        );
    }

    truncate_tool_output(
        format_admin_command_result(
            command_line,
            working_directory,
            timeout_seconds,
            &run_dir,
            &stdout_path,
            &stderr_path,
            &exit_path,
            &decode_tool_output(&parent_output.stdout),
            &decode_tool_output(&parent_output.stderr),
            parent_output.status.code().unwrap_or(-1),
        ),
        24_000,
    )
}

#[cfg(not(target_os = "windows"))]
fn execute_approved_admin_command(
    command_line: &str,
    working_directory: &str,
    timeout_seconds: u64,
    _workspace: &WorkspaceConfigView,
    _approval_id: &str,
    _session_id: Option<&str>,
) -> String {
    truncate_tool_output(
        format!(
            "command={}\nworkingDirectory={}\ntimeoutSeconds={}\nrunAsAdmin=true\napproved=true\ntimedOut=false\nexitCode=-1\nstdout:\n\nstderr:\nAdmin command execution is currently supported only on Windows.",
            command_line, working_directory, timeout_seconds
        ),
        24_000,
    )
}

fn stream_openai_compatible_response(
    app: &AppHandle,
    config: &AiConfig,
    request: &AiSendMessageRequest,
    workspace: &WorkspaceConfigView,
) -> Result<(), String> {
    ensure_ai_session_active(&request.session_id)?;
    let use_agent_loop = true;
    if use_agent_loop {
        return run_openai_compatible_agent_loop(app, config, request, workspace);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("Failed to create AI client: {}", err))?;
    let response = client
        .post(chat_url(&config.base_url))
        .bearer_auth(&config.api_key)
        .json(&build_chat_payload(config, request))
        .send()
        .map_err(|err| format!("AI 请求失败: {}", err))?;

    if !response.status().is_success() {
        return Err(format!("AI 请求返回 HTTP {}", response.status()));
    }

    let reader = BufReader::new(response);
    for line in reader.lines() {
        let line = line.map_err(|err| format!("AI 流读取失败: {}", err))?;
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            break;
        }
        let parsed = parse_openai_stream_chunk(data);
        if let Some(reasoning) = parsed.reasoning {
            if config.show_reasoning {
                emit_ai_event(app, &request.session_id, "reasoning", &reasoning, None)?;
            }
        }
        if let Some(content) = parsed.content {
            emit_ai_event(app, &request.session_id, "token", &content, None)?;
        }
        if let Some(tool_name) = parsed.tool_name {
            emit_ai_event(
                app,
                &request.session_id,
                "tool_call",
                parsed.tool_arguments.as_deref().unwrap_or(""),
                Some(&tool_name),
            )?;
        }
    }

    Ok(())
}

pub fn parse_openai_stream_chunk(data: &str) -> ParsedStreamChunk {
    let value: Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(_) => return ParsedStreamChunk::default(),
    };
    let delta = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .cloned()
        .unwrap_or(Value::Null);

    let tool_call = delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let tool_name = tool_call
        .and_then(|item| item.get("function"))
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_arguments = tool_call
        .and_then(|item| item.get("function"))
        .and_then(|function| function.get("arguments"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_calls = delta
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(position, item)| {
                    let function = item.get("function");
                    ParsedToolCallChunk {
                        index: item
                            .get("index")
                            .and_then(Value::as_u64)
                            .map(|value| value as usize)
                            .unwrap_or(position),
                        id: item.get("id").and_then(Value::as_str).map(str::to_string),
                        name: function
                            .and_then(|function| function.get("name"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        arguments: function
                            .and_then(|function| function.get("arguments"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    ParsedStreamChunk {
        content: delta
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string),
        reasoning: delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name,
        tool_arguments,
        tool_calls,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Duration;

    fn configured_ai(base_url: String) -> AiConfig {
        AiConfig {
            provider: "openai-compatible".to_string(),
            base_url,
            api_key: "sk-test-key".to_string(),
            model: "qwen-plus".to_string(),
            temperature: 0.7,
            max_tokens: 2048,
            show_reasoning: true,
            tools_enabled: true,
            max_tool_calls: 12,
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set read timeout");
        let mut bytes = Vec::new();

        loop {
            let mut buffer = [0_u8; 1024];
            let read = stream.read(&mut buffer).expect("read request");
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
            let request = String::from_utf8_lossy(&bytes);
            if let Some(header_end) = request.find("\r\n\r\n") {
                let headers = &request[..header_end];
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .or_else(|| line.strip_prefix("Content-Length: "))
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }

        String::from_utf8_lossy(&bytes).to_string()
    }

    fn spawn_test_server(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("local address");
        let (tx, rx) = mpsc::channel();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept connection");
            let request = read_http_request(&mut stream);
            tx.send(request).expect("send captured request");
            let response = format!(
                "{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status_line,
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });

        (format!("http://{}", address), rx)
    }

    #[test]
    fn merge_config_preserves_existing_key_when_request_key_is_blank() {
        let existing = AiConfig {
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: "saved-key".to_string(),
            model: "qwen-plus".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
            show_reasoning: true,
            tools_enabled: true,
            max_tool_calls: 12,
        };
        let request = AiConfigRequest {
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: Some("   ".to_string()),
            model: "qwen-max".to_string(),
            temperature: 0.4,
            max_tokens: 4096,
            show_reasoning: false,
            tools_enabled: true,
            max_tool_calls: 88,
        };

        let merged = merge_ai_config(existing, request);

        assert_eq!(merged.api_key, "saved-key");
        assert_eq!(merged.model, "qwen-max");
        assert_eq!(merged.temperature, 0.4);
        assert_eq!(merged.max_tool_calls, 50);
        assert!(!merged.show_reasoning);
    }

    #[test]
    fn config_view_masks_saved_key() {
        let view = config_to_view(AiConfig {
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: "sk-1234567890".to_string(),
            model: "gpt-4.1-mini".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
            show_reasoning: true,
            tools_enabled: true,
            max_tool_calls: 12,
        });

        assert!(view.has_api_key);
        assert_eq!(view.api_key_preview, "sk-1******7890");
    }

    #[test]
    fn config_view_masks_non_ascii_key_without_panicking() {
        let view = config_to_view(AiConfig {
            provider: "openai-compatible".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            api_key: "「帮我查一下今天的新闻」".to_string(),
            model: "gpt-4.1-mini".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
            show_reasoning: true,
            tools_enabled: true,
            max_tool_calls: 12,
        });

        assert!(view.has_api_key);
        assert_eq!(view.api_key_preview, "「帮我查******的新闻」");
    }

    #[test]
    fn parse_stream_chunk_reads_token_and_reasoning() {
        let parsed = parse_openai_stream_chunk(
            r#"{"choices":[{"delta":{"content":"结论","reasoning_content":"检查日志"}}]}"#,
        );

        assert_eq!(parsed.content.as_deref(), Some("结论"));
        assert_eq!(parsed.reasoning.as_deref(), Some("检查日志"));
    }

    fn sample_ai_request() -> AiSendMessageRequest {
        AiSendMessageRequest {
            session_id: "session-1".to_string(),
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: "检查当前主机".to_string(),
            }],
            context: AiWorkspaceContext {
                mode: "本地分析".to_string(),
                os_type: "windows".to_string(),
                current_module: "安全日志".to_string(),
                scan_result_count: 1,
                scan_result_summaries: vec!["安全日志: warning - 可疑登录".to_string()],
            },
        }
    }

    #[test]
    fn chat_payload_includes_agent_tools_when_enabled() {
        let payload = build_chat_payload(
            &configured_ai("https://example.test/v1".to_string()),
            &sample_ai_request(),
        );

        let tools = payload
            .get("tools")
            .and_then(Value::as_array)
            .expect("tools are included");
        assert!(tools.iter().any(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                == Some("run_command")
        }));
        let tool_names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| {
                tool.get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
            })
            .collect();
        assert_eq!(tool_names, vec!["run_command"]);
    }

    #[test]
    fn agent_prompt_guides_windows_command_usage_and_retry_handling() {
        let workspace = WorkspaceConfigView {
            root_path: "C:\\IR\\host".to_string(),
            exports_path: "C:\\IR\\host\\exports".to_string(),
            ai_logs_path: "C:\\IR\\host\\ai_logs".to_string(),
            collections_path: "C:\\IR\\host\\collections".to_string(),
            temp_path: "C:\\IR\\host\\temp".to_string(),
            admin_runs_path: "C:\\IR\\host\\admin_runs".to_string(),
        };
        let messages = build_agent_chat_messages(&sample_ai_request(), &workspace);
        let system_prompt = messages[0]
            .get("content")
            .and_then(Value::as_str)
            .expect("system prompt");

        assert!(system_prompt.contains("Get-ChildItem -LiteralPath"));
        assert!(system_prompt.contains("Do not keep retrying"));
        assert!(system_prompt.contains("scanResultCount=0"));
    }

    #[test]
    fn parse_stream_chunk_reads_tool_calls() {
        let parsed = parse_openai_stream_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_text_file","arguments":"{\"path\":\"C:\\\\Windows\\\\win.ini\"}"}}]}}]}"#,
        );

        assert_eq!(parsed.tool_name.as_deref(), Some("read_text_file"));
        assert_eq!(parsed.tool_calls.len(), 1);
        assert_eq!(parsed.tool_calls[0].index, 0);
        assert_eq!(parsed.tool_calls[0].id.as_deref(), Some("call_1"));
        assert_eq!(parsed.tool_calls[0].name.as_deref(), Some("read_text_file"));
        assert!(parsed.tool_calls[0]
            .arguments
            .as_deref()
            .unwrap_or_default()
            .contains("win.ini"));
    }

    #[test]
    fn decode_tool_output_handles_gbk_chinese() {
        let decoded = decode_tool_output(&[0xd6, 0xd0, 0xce, 0xc4]);

        assert_eq!(decoded, "中文");
    }

    #[test]
    fn run_command_tool_executes_shell_command() {
        let call = AiToolCall {
            id: "call_1".to_string(),
            name: "run_command".to_string(),
            arguments: json!({
                "command": "echo lumina-agent",
                "timeoutSeconds": 5
            })
            .to_string(),
        };

        let output = execute_ai_tool(&call, None);

        assert!(output.contains("timedOut=false"));
        assert!(output.contains("exitCode=0"));
        assert!(output.contains("lumina-agent"));
    }

    #[test]
    fn run_command_tool_uses_workspace_root_as_default_working_directory() {
        let root =
            std::env::temp_dir().join(format!("lumina-ai-workspace-test-{}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale test workspace");
        }
        let workspace = crate::workspace::ensure_workspace_paths(&root).expect("workspace paths");
        let command = if cfg!(windows) { "cd" } else { "pwd" };
        let output = execute_shell_command_with_workspace(
            &json!({
                "command": command,
                "timeoutSeconds": 5
            }),
            None,
            &workspace,
        );

        assert!(output.contains("timedOut=false"));
        assert!(output.contains(&format!("workingDirectory={}", workspace.root_path)));
        assert!(output.contains(&workspace.root_path));

        std::fs::remove_dir_all(&root).expect("cleanup test workspace");
    }

    #[cfg(windows)]
    #[test]
    fn run_command_tool_handles_quoted_windows_paths() {
        let root =
            std::env::temp_dir().join(format!("lumina ai quoted path test {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale test workspace");
        }
        std::fs::create_dir_all(&root).expect("create quoted path test root");
        std::fs::write(root.join("sentinel.txt"), "ok").expect("write sentinel");
        let workspace = crate::workspace::ensure_workspace_paths(&root).expect("workspace paths");
        let output = execute_shell_command_with_workspace(
            &json!({
                "command": format!("dir /a /b \"{}\"", root.to_string_lossy()),
                "timeoutSeconds": 5
            }),
            None,
            &workspace,
        );

        assert!(output.contains("timedOut=false"), "{output}");
        assert!(output.contains("exitCode=0"), "{output}");
        assert!(output.contains("sentinel.txt"), "{output}");

        std::fs::remove_dir_all(&root).expect("cleanup test workspace");
    }

    #[cfg(windows)]
    #[test]
    fn run_command_tool_handles_python_inline_code() {
        let root =
            std::env::temp_dir().join(format!("lumina ai python test {}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale test workspace");
        }
        let workspace = crate::workspace::ensure_workspace_paths(&root).expect("workspace paths");
        let output = execute_shell_command_with_workspace(
            &json!({
                "command": "python -c \"print('lumina-python-ok')\"",
                "timeoutSeconds": 5
            }),
            None,
            &workspace,
        );

        assert!(output.contains("timedOut=false"), "{output}");
        assert!(output.contains("exitCode=0"), "{output}");
        assert!(output.contains("lumina-python-ok"), "{output}");

        std::fs::remove_dir_all(&root).expect("cleanup test workspace");
    }

    #[test]
    fn run_command_tool_definition_exposes_admin_approval_flag_without_adding_extra_tools() {
        let tools = build_ai_tool_definitions();
        let tools = tools.as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        let function = tools[0].get("function").expect("function");
        assert_eq!(
            function.get("name").and_then(Value::as_str),
            Some("run_command")
        );
        let properties = function
            .get("parameters")
            .and_then(|parameters| parameters.get("properties"))
            .expect("properties");

        assert!(properties.get("runAsAdmin").is_some());
        assert!(properties.get("reason").is_some());
    }

    #[test]
    fn run_command_tool_blocks_elevation_requests() {
        let call = AiToolCall {
            id: "call_1".to_string(),
            name: "run_command".to_string(),
            arguments: json!({
                "command": "runas /user:Administrator cmd"
            })
            .to_string(),
        };

        let output = execute_ai_tool(&call, None);

        assert!(output.contains("admin/UAC elevation is not allowed"));
    }

    #[test]
    fn admin_approval_payload_includes_command_context() {
        let payload = build_admin_approval_payload(
            "approval-1",
            "net session",
            "C:\\IR",
            "检查管理员会话",
            15,
        );

        assert_eq!(payload["approvalId"], "approval-1");
        assert_eq!(payload["command"], "net session");
        assert_eq!(payload["workingDirectory"], "C:\\IR");
        assert_eq!(payload["reason"], "检查管理员会话");
        assert_eq!(payload["timeoutSeconds"], 15);
    }

    #[test]
    fn admin_command_result_missing_files_reports_capture_failure() {
        let root = std::env::temp_dir().join(format!(
            "lumina-admin-result-missing-{}",
            std::process::id()
        ));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale admin result test dir");
        }
        std::fs::create_dir_all(&root).expect("create admin result test dir");

        let output = format_admin_command_result(
            "wevtutil qe Security",
            "C:\\IR",
            30,
            &root,
            &root.join("stdout.txt"),
            &root.join("stderr.txt"),
            &root.join("exit.txt"),
            "",
            "",
            0,
        );

        assert!(output.contains("runAsAdmin=true"), "{output}");
        assert!(output.contains("approved=true"), "{output}");
        assert!(output.contains("timedOut=false"), "{output}");
        assert!(output.contains("exitCode=-1"), "{output}");
        assert!(
            output.contains("Admin command did not write result files"),
            "{output}"
        );
        assert!(
            output.contains("Missing admin result files: stdout.txt, stderr.txt, exit.txt"),
            "{output}"
        );
        assert!(output.contains("launcherExitCode=0"), "{output}");

        std::fs::remove_dir_all(&root).expect("cleanup admin result test dir");
    }

    #[test]
    fn admin_session_approval_is_reused_until_cleared() {
        let session_id = format!("approval-reuse-{}", std::process::id());

        clear_admin_approved_for_session(&session_id);
        assert!(!is_admin_approved_for_session(&session_id));

        mark_admin_approved_for_session(&session_id);
        assert!(is_admin_approved_for_session(&session_id));

        clear_admin_approved_for_session(&session_id);
        assert!(!is_admin_approved_for_session(&session_id));
    }

    #[test]
    fn ai_audit_log_writes_jsonl_into_workspace() {
        let root =
            std::env::temp_dir().join(format!("lumina-ai-audit-test-{}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("remove stale test workspace");
        }
        let workspace = crate::workspace::ensure_workspace_paths(&root).expect("workspace paths");

        log_ai_audit_event(
            &workspace,
            "session-1",
            "tool_call",
            json!({ "command": "echo ok" }),
        )
        .expect("write audit log");

        let entries = std::fs::read_dir(&workspace.ai_logs_path)
            .expect("read ai logs")
            .collect::<Result<Vec<_>, _>>()
            .expect("log entries");
        assert_eq!(entries.len(), 1);
        let content = std::fs::read_to_string(entries[0].path()).expect("read log file");
        assert!(content.contains(r#""eventType":"tool_call""#));
        assert!(content.contains(r#""sessionId":"session-1""#));
        assert!(content.contains("echo ok"));

        std::fs::remove_dir_all(&root).expect("cleanup test workspace");
    }

    #[test]
    fn cancelled_session_stops_tool_execution_before_start() {
        let session_id = "cancelled-tool-session";
        clear_ai_session_cancelled(session_id);
        mark_ai_session_cancelled(session_id);

        let call = AiToolCall {
            id: "call_1".to_string(),
            name: "run_command".to_string(),
            arguments: json!({
                "command": "echo should-not-run",
                "timeoutSeconds": 5
            })
            .to_string(),
        };

        let output = execute_ai_tool(&call, Some(session_id));

        assert!(is_ai_session_cancelled(session_id));
        assert!(output.contains("cancelled=true"));
        assert!(output.contains("Command cancelled"));
        clear_ai_session_cancelled(session_id);
    }

    #[test]
    fn test_connection_posts_non_streaming_test_request() {
        let (base_url, captured_request) = spawn_test_server(
            "HTTP/1.1 200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"OK"}}]}"#,
        );

        send_test_chat_request(&configured_ai(base_url)).expect("test request succeeds");

        let request = captured_request
            .recv_timeout(Duration::from_secs(2))
            .expect("captured request");
        assert!(request.starts_with("POST /chat/completions HTTP/1.1"));
        assert!(
            request.contains("authorization: Bearer sk-test-key")
                || request.contains("Authorization: Bearer sk-test-key")
        );
        assert!(request.contains(r#""model":"qwen-plus""#));
        assert!(request.contains(r#""content":"TEST""#));
        assert!(request.contains(r#""stream":false"#));
        assert!(request.contains(r#""temperature":0.0"#));
    }

    #[test]
    fn test_connection_reports_http_error_body() {
        let (base_url, _captured_request) = spawn_test_server(
            "HTTP/1.1 401 Unauthorized",
            r#"{"error":{"message":"bad api key"}}"#,
        );

        let error =
            send_test_chat_request(&configured_ai(base_url)).expect_err("test request fails");

        assert!(error.contains("HTTP 401"));
        assert!(error.contains("bad api key"));
    }
}
