// 离线授权验证模块
// 基于机器码 + Ed25519 签名验证 + XOR 混淆

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

// ========== 内置公钥 ==========
// 这是验证用的公钥，私钥由管理员持有用于生成许可证
// 生成时间: 2024-12-19
const PUBLIC_KEY_HEX: &str = "767428e28e3eae21d4f5a1f4f806c6967a046770d4fbccf1a79cdfa85a478756";

// ========== 混淆密钥 ==========
// 用于加密许可证数据，防止被轻易读取
const OBFUSCATE_KEY: &[u8] = b"Lumina_Emergency_Analyzer_2024_SecretKey!@#$%^&*";

// ========== 数据结构 ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseInfo {
    pub machine_id: String,
    pub expire_date: Option<String>, // 格式: YYYY-MM-DD, None 表示永久
    pub features: Vec<String>,       // 授权功能列表
    pub user_name: Option<String>,   // 授权用户名
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicenseResult {
    pub valid: bool,
    pub message: String,
    pub info: Option<LicenseInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineInfo {
    pub machine_id: String,
    pub cpu_id: String,
    pub mac_address: String,
    pub hostname: String,
}

// ========== 机器码生成 ==========

/// 获取机器唯一标识信息
pub fn get_machine_info() -> MachineInfo {
    let cpu_id = get_cpu_id();
    let mac = get_mac_address();
    let hostname = get_hostname();

    // 组合生成机器码 (SHA256 哈希)
    let combined = format!("{}:{}:{}", cpu_id, mac, hostname);
    let mut hasher = Sha256::new();
    hasher.update(combined.as_bytes());
    let hash = hasher.finalize();
    let machine_id = hex::encode(&hash[..16]); // 取前16字节，32位十六进制

    MachineInfo {
        machine_id,
        cpu_id,
        mac_address: mac,
        hostname,
    }
}

/// 获取 CPU ID
fn get_cpu_id() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = Command::new("wmic")
            .args(["cpu", "get", "ProcessorId"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() && trimmed != "ProcessorId" {
                    return trimmed.to_string();
                }
            }
        }
        "UNKNOWN_CPU".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = fs::read_to_string("/proc/cpuinfo") {
            for line in content.lines() {
                if line.starts_with("Serial") || line.contains("model name") {
                    if let Some(value) = line.split(':').nth(1) {
                        return value.trim().to_string();
                    }
                }
            }
        }
        // 备用方案：读取 machine-id
        if let Ok(content) = fs::read_to_string("/etc/machine-id") {
            return content.trim().to_string();
        }
        "UNKNOWN_CPU".to_string()
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output();

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if line.contains("IOPlatformSerialNumber") {
                    if let Some(value) = line.split('"').nth(3) {
                        return value.to_string();
                    }
                }
            }
        }
        "UNKNOWN_CPU".to_string()
    }
}

/// 获取 MAC 地址
fn get_mac_address() -> String {
    if let Ok(Some(ma)) = mac_address::get_mac_address() {
        return ma.to_string();
    }
    "00:00:00:00:00:00".to_string()
}

/// 获取主机名
fn get_hostname() -> String {
    if let Ok(name) = hostname::get() {
        return name.to_string_lossy().to_string();
    }
    "UNKNOWN_HOST".to_string()
}

// ========== 数据混淆 ==========

/// XOR 解密/加密 (对称操作)
fn xor_obfuscate(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &byte)| byte ^ OBFUSCATE_KEY[i % OBFUSCATE_KEY.len()])
        .collect()
}

// ========== 联网时间获取 ==========

/// 从网络获取当前日期 (YYYY-MM-DD 格式)
/// 使用多个时间源确保可靠性，设置较短超时避免阻塞
fn get_network_date() -> Option<String> {
    // 尝试从 timeapi.io 获取时间 (更快)
    if let Some(date) = fetch_time_from_timeapi() {
        return Some(date);
    }

    // 备用方案：从 worldtimeapi.org 获取
    if let Some(date) = fetch_time_from_worldtimeapi() {
        return Some(date);
    }

    // 都失败了，返回 None (调用者会使用本地时间)
    None
}

/// 从 timeapi.io 获取时间 (更快的 API)
fn fetch_time_from_timeapi() -> Option<String> {
    #[derive(serde::Deserialize)]
    struct TimeResponse {
        date: String,
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;

    let resp = client
        .get("https://timeapi.io/api/time/current/zone?timeZone=UTC")
        .send()
        .ok()?;

    let time_resp: TimeResponse = resp.json().ok()?;
    Some(time_resp.date)
}

/// 从 worldtimeapi.org 获取时间
fn fetch_time_from_worldtimeapi() -> Option<String> {
    #[derive(serde::Deserialize)]
    struct TimeResponse {
        datetime: String,
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;

    let resp = client
        .get("http://worldtimeapi.org/api/timezone/Etc/UTC")
        .send()
        .ok()?;

    let time_resp: TimeResponse = resp.json().ok()?;

    // datetime 格式: "2024-12-19T12:34:56.123456+00:00"
    // 取前10个字符作为日期
    if time_resp.datetime.len() >= 10 {
        Some(time_resp.datetime[..10].to_string())
    } else {
        None
    }
}

// ========== 许可证验证 ==========

/// 验证许可证
pub fn verify_license(license_key: &str) -> LicenseResult {
    let machine_info = get_machine_info();
    verify_license_with_machine_id(license_key, &machine_info.machine_id)
}

/// 使用指定机器码验证许可证
pub fn verify_license_with_machine_id(license_key: &str, machine_id: &str) -> LicenseResult {
    // 1. 解码许可证
    let license_bytes = match BASE64.decode(license_key.trim()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "许可证格式无效".to_string(),
                info: None,
            };
        }
    };

    // 许可证格式: [64字节签名][加密的JSON数据]
    if license_bytes.len() < 65 {
        return LicenseResult {
            valid: false,
            message: "许可证数据不完整".to_string(),
            info: None,
        };
    }

    let signature_bytes = &license_bytes[..64];
    let encrypted_data = &license_bytes[64..];

    // 2. 解密数据
    let data_bytes = xor_obfuscate(encrypted_data);

    // 3. 解析许可证信息
    let license_info: LicenseInfo = match serde_json::from_slice(&data_bytes) {
        Ok(info) => info,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "许可证数据解析失败".to_string(),
                info: None,
            };
        }
    };

    // 3. 验证机器码
    if license_info.machine_id != machine_id {
        return LicenseResult {
            valid: false,
            message: "许可证与当前机器不匹配".to_string(),
            info: Some(license_info),
        };
    }

    // 4. 验证签名
    let public_key_bytes = match hex::decode(PUBLIC_KEY_HEX) {
        Ok(bytes) => bytes,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "公钥配置错误".to_string(),
                info: None,
            };
        }
    };

    let public_key_array: [u8; 32] = match public_key_bytes.try_into() {
        Ok(arr) => arr,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "公钥长度错误".to_string(),
                info: None,
            };
        }
    };

    let verifying_key = match VerifyingKey::from_bytes(&public_key_array) {
        Ok(key) => key,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "公钥格式错误".to_string(),
                info: None,
            };
        }
    };

    let signature_array: [u8; 64] = match signature_bytes.try_into() {
        Ok(arr) => arr,
        Err(_) => {
            return LicenseResult {
                valid: false,
                message: "签名长度错误".to_string(),
                info: None,
            };
        }
    };

    let signature = Signature::from_bytes(&signature_array);

    // 验证签名 (签名是对加密数据进行的)
    if verifying_key.verify(encrypted_data, &signature).is_err() {
        return LicenseResult {
            valid: false,
            message: "许可证签名验证失败".to_string(),
            info: Some(license_info),
        };
    }

    // 5. 检查过期时间 (使用联网时间，防止用户修改本地时间绕过)
    if let Some(ref expire_date) = license_info.expire_date {
        let today = get_network_date().unwrap_or_else(|| {
            // 如果联网失败，使用本地时间但记录警告
            chrono::Local::now().format("%Y-%m-%d").to_string()
        });

        if today > *expire_date {
            return LicenseResult {
                valid: false,
                message: format!("许可证已过期 ({})", expire_date),
                info: Some(license_info),
            };
        }
    }

    // 验证通过
    LicenseResult {
        valid: true,
        message: "许可证验证通过".to_string(),
        info: Some(license_info),
    }
}

// ========== 许可证存储 ==========

/// 获取许可证文件路径
fn get_license_path() -> PathBuf {
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("emergency-analyzer");
    fs::create_dir_all(&path).ok();
    path.push("license.key");
    path
}

/// 保存许可证到本地
pub fn save_license(license_key: &str) -> Result<(), String> {
    let path = get_license_path();
    fs::write(&path, license_key).map_err(|e| format!("保存许可证失败: {}", e))
}

/// 从本地加载许可证
pub fn load_license() -> Option<String> {
    let path = get_license_path();
    fs::read_to_string(&path).ok().map(|s| s.trim().to_string())
}

/// 删除本地许可证
pub fn remove_license() -> Result<(), String> {
    let path = get_license_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除许可证失败: {}", e))
    } else {
        Ok(())
    }
}

/// 检查是否已激活
pub fn is_activated() -> bool {
    if let Some(license_key) = load_license() {
        let result = verify_license(&license_key);
        result.valid
    } else {
        false
    }
}
