// 许可证生成工具 - 管理员专用
// 用于生成与特定机器绑定的许可证密钥

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseInfo {
    machine_id: String,
    expire_date: Option<String>,  // 格式: YYYY-MM-DD, None 表示永久
    features: Vec<String>,        // 授权功能列表
    user_name: Option<String>,    // 授权用户名
}

fn main() {
    let args: Vec<String> = env::args().collect();
    
    if args.len() < 2 {
        print_usage();
        return;
    }

    match args[1].as_str() {
        "generate" => {
            if args.len() < 3 {
                println!("错误: 请提供机器码");
                println!("用法: license-gen generate <machine_id> [options]");
                return;
            }
            generate_license(&args[2..]);
        }
        "keygen" => {
            generate_keypair();
        }
        _ => {
            print_usage();
        }
    }
}

fn print_usage() {
    println!("许可证生成工具 v1.0");
    println!();
    println!("用法:");
    println!("  license-gen keygen                    - 生成新的密钥对");
    println!("  license-gen generate <machine_id> [options]");
    println!();
    println!("选项:");
    println!("  --expire YYYY-MM-DD    设置过期时间 (默认: 永久)");
    println!("  --user <name>          设置授权用户名");
    println!("  --features <f1,f2,...> 设置授权功能列表");
    println!("  --key <path>           指定私钥文件路径 (默认: private.key)");
    println!();
    println!("示例:");
    println!("  license-gen keygen");
    println!("  license-gen generate abc123def456 --user \"张三\" --expire 2025-12-31");
}

fn generate_keypair() {
    println!("正在生成 Ed25519 密钥对...");
    
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();
    
    // 保存私钥
    let private_key_hex = hex::encode(signing_key.to_bytes());
    fs::write("private.key", &private_key_hex).expect("无法写入私钥文件");
    println!("私钥已保存到: private.key");
    println!("⚠️  请妥善保管私钥，不要分享给任何人！");
    
    // 显示公钥
    let public_key_hex = hex::encode(verifying_key.to_bytes());
    println!();
    println!("公钥 (需要嵌入到应用中):");
    println!("const PUBLIC_KEY_HEX: &str = \"{}\";", public_key_hex);
    
    // 同时保存公钥到文件
    fs::write("public.key", &public_key_hex).expect("无法写入公钥文件");
    println!();
    println!("公钥已保存到: public.key");
}

fn generate_license(args: &[String]) {
    let machine_id = &args[0];
    
    // 解析命令行参数
    let mut expire_date: Option<String> = None;
    let mut user_name: Option<String> = None;
    let mut features: Vec<String> = vec!["all".to_string()];
    let mut key_path = "private.key".to_string();
    
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--expire" => {
                if i + 1 < args.len() {
                    expire_date = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--user" => {
                if i + 1 < args.len() {
                    user_name = Some(args[i + 1].clone());
                    i += 1;
                }
            }
            "--features" => {
                if i + 1 < args.len() {
                    features = args[i + 1].split(',').map(|s| s.trim().to_string()).collect();
                    i += 1;
                }
            }
            "--key" => {
                if i + 1 < args.len() {
                    key_path = args[i + 1].clone();
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    
    // 读取私钥
    let private_key_hex = match fs::read_to_string(&key_path) {
        Ok(content) => content.trim().to_string(),
        Err(_) => {
            println!("错误: 无法读取私钥文件 '{}'", key_path);
            println!("请先运行 'license-gen keygen' 生成密钥对");
            return;
        }
    };
    
    let private_key_bytes = match hex::decode(&private_key_hex) {
        Ok(bytes) => bytes,
        Err(_) => {
            println!("错误: 私钥格式无效");
            return;
        }
    };
    
    let private_key_array: [u8; 32] = match private_key_bytes.try_into() {
        Ok(arr) => arr,
        Err(_) => {
            println!("错误: 私钥长度错误");
            return;
        }
    };
    
    let signing_key = SigningKey::from_bytes(&private_key_array);
    
    // 创建许可证信息
    let license_info = LicenseInfo {
        machine_id: machine_id.clone(),
        expire_date: expire_date.clone(),
        features: features.clone(),
        user_name: user_name.clone(),
    };
    
    // 序列化许可证信息
    let license_json = serde_json::to_vec(&license_info).expect("序列化失败");
    
    // 签名
    let signature = signing_key.sign(&license_json);
    
    // 组合: 签名 + 数据
    let mut license_bytes = Vec::new();
    license_bytes.extend_from_slice(&signature.to_bytes());
    license_bytes.extend_from_slice(&license_json);
    
    // Base64 编码
    let license_key = BASE64.encode(&license_bytes);
    
    println!();
    println!("========== 许可证信息 ==========");
    println!("机器码: {}", machine_id);
    println!("用户名: {}", user_name.as_deref().unwrap_or("未设置"));
    println!("过期时间: {}", expire_date.as_deref().unwrap_or("永久"));
    println!("授权功能: {:?}", features);
    println!();
    println!("========== 许可证密钥 ==========");
    println!("{}", license_key);
    println!();
    
    // 保存到文件
    let filename = format!("license_{}.txt", &machine_id[..8.min(machine_id.len())]);
    fs::write(&filename, &license_key).expect("无法写入许可证文件");
    println!("许可证已保存到: {}", filename);
}
