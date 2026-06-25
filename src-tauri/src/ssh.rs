use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthMethod {
    Password(String),
    PrivateKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectionResult {
    pub success: bool,
    pub message: String,
    pub os_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub struct SshClient {
    session: Session,
}

impl SshClient {
    pub fn connect(config: &SshConfig) -> Result<Self, String> {
        let addr = format!("{}:{}", config.host, config.port);
        let tcp = TcpStream::connect(&addr).map_err(|e| format!("杩炴帴澶辫触: {}", e))?;

        let mut session = Session::new().map_err(|e| format!("鍒涘缓SSH浼氳瘽澶辫触: {}", e))?;

        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH鎻℃墜澶辫触: {}", e))?;

        match &config.auth_method {
            AuthMethod::Password(password) => {
                session
                    .userauth_password(&config.username, password)
                    .map_err(|e| format!("瀵嗙爜璁よ瘉澶辫触: {}", e))?;
            }
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let key_path = std::path::Path::new(key_path);
                session
                    .userauth_pubkey_file(&config.username, None, key_path, passphrase.as_deref())
                    .map_err(|e| format!("瀵嗛挜璁よ瘉澶辫触: {}", e))?;
            }
        }

        if !session.authenticated() {
            return Err("璁よ瘉澶辫触".to_string());
        }

        Ok(SshClient { session })
    }

    pub fn execute(&self, command: &str) -> Result<CommandResult, String> {
        let mut channel = self
            .session
            .channel_session()
            .map_err(|e| format!("鍒涘缓閫氶亾澶辫触: {}", e))?;

        channel
            .exec(command)
            .map_err(|e| format!("鎵ц鍛戒护澶辫触: {}", e))?;

        let mut stdout_bytes = Vec::new();
        channel
            .read_to_end(&mut stdout_bytes)
            .map_err(|e| format!("璇诲彇杈撳嚭澶辫触: {}", e))?;
        let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();

        let mut stderr_bytes = Vec::new();
        channel
            .stderr()
            .read_to_end(&mut stderr_bytes)
            .map_err(|e| format!("璇诲彇閿欒杈撳嚭澶辫触: {}", e))?;
        let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

        channel
            .wait_close()
            .map_err(|e| format!("鍏抽棴閫氶亾澶辫触: {}", e))?;

        let exit_code = channel
            .exit_status()
            .map_err(|e| format!("鑾峰彇閫€鍑虹爜澶辫触: {}", e))?;

        Ok(CommandResult {
            success: exit_code == 0,
            stdout,
            stderr,
            exit_code,
        })
    }

    pub fn detect_os(&self) -> Result<String, String> {
        let result = self.execute("uname -s")?;
        if result.success {
            let os = result.stdout.trim().to_lowercase();
            if os.contains("linux") {
                Ok("Linux".to_string())
            } else if os.contains("darwin") {
                Ok("macOS".to_string())
            } else {
                Ok(os)
            }
        } else {
            let result = self.execute("ver")?;
            if result.stdout.to_lowercase().contains("windows") {
                Ok("Windows".to_string())
            } else {
                Err("Failed to detect remote operating system".to_string())
            }
        }
    }
}
