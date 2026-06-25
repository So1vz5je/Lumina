// 临时密钥生成脚本 - 在 src-tauri 目录运行
// cargo run --example keygen

use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

fn main() {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();

    println!("私钥 (管理员保密):");
    println!("{}", hex::encode(signing_key.to_bytes()));
    println!();
    println!("公钥 (嵌入应用):");
    println!("{}", hex::encode(verifying_key.to_bytes()));
}
