use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

const AI_STREAM_EVENT: &str = "ai://stream";

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
    }
}

fn mask_api_key(api_key: &str) -> String {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 8 {
        return "********".to_string();
    }
    format!("{}******{}", &trimmed[..4], &trimmed[trimmed.len() - 4..])
}

fn ai_config_path() -> Result<PathBuf, String> {
    let mut dir = dirs::config_dir().ok_or_else(|| "Cannot locate user config directory".to_string())?;
    dir.push("Lumina Analyzer");
    fs::create_dir_all(&dir).map_err(|err| format!("Failed to create AI config directory: {}", err))?;
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
pub fn ai_test_config() -> Result<AiTestResult, String> {
    let config = load_ai_config();
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

    Ok(AiTestResult {
        success: true,
        message: "配置格式有效".to_string(),
    })
}

#[tauri::command]
pub fn ai_send_message(app: AppHandle, request: AiSendMessageRequest) -> Result<(), String> {
    let config = load_ai_config();
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

    std::thread::spawn(move || {
        if let Err(err) = run_ai_session(&app, config, request) {
            let _ = emit_ai_event(&app, "", "error", &err, None);
        }
    });

    Ok(())
}

fn run_ai_session(app: &AppHandle, config: AiConfig, request: AiSendMessageRequest) -> Result<(), String> {
    emit_ai_event(app, &request.session_id, "status", "AI 正在分析上下文", None)?;

    if config.tools_enabled {
        emit_tool_result(app, &request, "get_workspace_state", build_workspace_state(&request.context))?;
        if !request.context.scan_result_summaries.is_empty() {
            emit_tool_result(
                app,
                &request,
                "get_scan_results_summary",
                request.context.scan_result_summaries.join("\n"),
            )?;
        }
    }

    stream_openai_compatible_response(app, &config, &request)?;
    emit_ai_event(app, &request.session_id, "done", "", None)
}

fn build_workspace_state(context: &AiWorkspaceContext) -> String {
    format!(
        "mode={}, os={}, current_module={}, scan_result_count={}",
        context.mode, context.os_type, context.current_module, context.scan_result_count
    )
}

fn emit_tool_result(
    app: &AppHandle,
    request: &AiSendMessageRequest,
    tool_name: &str,
    content: String,
) -> Result<(), String> {
    emit_ai_event(app, &request.session_id, "tool_call", "调用内置上下文工具", Some(tool_name))?;
    emit_ai_event(app, &request.session_id, "tool_result", &content, Some(tool_name))
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

    json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": true
    })
}

fn stream_openai_compatible_response(
    app: &AppHandle,
    config: &AiConfig,
    request: &AiSendMessageRequest,
) -> Result<(), String> {
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

    ParsedStreamChunk {
        content: delta.get("content").and_then(Value::as_str).map(str::to_string),
        reasoning: delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_name,
        tool_arguments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };

        let merged = merge_ai_config(existing, request);

        assert_eq!(merged.api_key, "saved-key");
        assert_eq!(merged.model, "qwen-max");
        assert_eq!(merged.temperature, 0.4);
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
        });

        assert!(view.has_api_key);
        assert_eq!(view.api_key_preview, "sk-1******7890");
    }

    #[test]
    fn parse_stream_chunk_reads_token_and_reasoning() {
        let parsed = parse_openai_stream_chunk(
            r#"{"choices":[{"delta":{"content":"结论","reasoning_content":"检查日志"}}]}"#,
        );

        assert_eq!(parsed.content.as_deref(), Some("结论"));
        assert_eq!(parsed.reasoning.as_deref(), Some("检查日志"));
    }
}
