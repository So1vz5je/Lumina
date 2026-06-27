use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

#[cfg(test)]
mod tests {
    use super::is_transient_terminal_read_error;
    use std::io::{Error, ErrorKind};

    #[test]
    fn treats_nonblocking_transport_read_as_transient_terminal_read() {
        let error = Error::new(ErrorKind::Other, "transport read");

        assert!(is_transient_terminal_read_error(&error));
    }

    #[test]
    fn treats_would_block_terminal_read_as_transient() {
        let error = Error::new(ErrorKind::WouldBlock, "operation would block");

        assert!(is_transient_terminal_read_error(&error));
    }
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
    config: SshConfig,
}

fn is_transient_terminal_read_error(error: &std::io::Error) -> bool {
    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) {
        return true;
    }

    let message = error.to_string().to_ascii_lowercase();
    message.contains("transport read") || message.contains("would block")
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

        Ok(SshClient {
            session,
            config: config.clone(),
        })
    }

    pub fn execute(&self, command: &str) -> Result<CommandResult, String> {
        self.session.set_blocking(true);
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

    pub fn spawn_interactive_shell(
        self: Arc<Self>,
        app: AppHandle,
        connection_id: String,
        session_id: String,
        cols: u32,
        rows: u32,
    ) -> Result<mpsc::Sender<Vec<u8>>, String> {
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let terminal_config = self.config.clone();
        let thread_session_id = session_id.clone();
        let thread_connection_id = connection_id.clone();

        thread::Builder::new()
            .name(format!("ssh-terminal-{}", session_id))
            .spawn(move || {
                let run_result = (|| -> Result<(), String> {
                    let terminal_client = SshClient::connect(&terminal_config)?;
                    let mut channel = terminal_client
                        .session
                        .channel_session()
                        .map_err(|e| format!("创建交互式终端通道失败: {}", e))?;
                    channel
                        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
                        .map_err(|e| format!("请求远程 PTY 失败: {}", e))?;
                    channel
                        .shell()
                        .map_err(|e| format!("启动远程 shell 失败: {}", e))?;
                    terminal_client.session.set_blocking(false);
                    let _ = ready_tx.send(Ok(()));

                    let mut buffer = [0_u8; 8192];
                    loop {
                        loop {
                            match channel.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(read_len) => {
                                    let data =
                                        String::from_utf8_lossy(&buffer[..read_len]).to_string();
                                    let _ = app.emit(
                                        "remote://terminal-stream",
                                        serde_json::json!({
                                            "connectionId": thread_connection_id,
                                            "sessionId": thread_session_id,
                                            "data": data,
                                        }),
                                    );
                                }
                                Err(error) if is_transient_terminal_read_error(&error) => break,
                                Err(error) => {
                                    let _ = app.emit(
                                        "remote://terminal-error",
                                        serde_json::json!({
                                            "connectionId": thread_connection_id,
                                            "sessionId": thread_session_id,
                                            "error": error.to_string(),
                                        }),
                                    );
                                    return Err(format!("读取远程终端输出失败: {}", error));
                                }
                            }
                        }

                        match input_rx.recv_timeout(Duration::from_millis(12)) {
                            Ok(data) => {
                                let mut written = 0;
                                while written < data.len() {
                                    match channel.write(&data[written..]) {
                                        Ok(0) => thread::sleep(Duration::from_millis(2)),
                                        Ok(count) => written += count,
                                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                                            thread::sleep(Duration::from_millis(2));
                                        }
                                        Err(error) => {
                                            let _ = app.emit(
                                                "remote://terminal-error",
                                                serde_json::json!({
                                                    "connectionId": thread_connection_id,
                                                    "sessionId": thread_session_id,
                                                    "error": error.to_string(),
                                                }),
                                            );
                                            return Err(format!("写入远程终端失败: {}", error));
                                        }
                                    }
                                }
                                let _ = channel.flush();
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }

                        if channel.eof() {
                            break;
                        }
                    }

                    let _ = channel.close();
                    let _ = app.emit(
                        "remote://terminal-closed",
                        serde_json::json!({
                            "connectionId": thread_connection_id,
                            "sessionId": thread_session_id,
                        }),
                    );
                    Ok(())
                })();

                if let Err(error) = run_result {
                    let _ = ready_tx.send(Err(error));
                }
            })
            .map_err(|e| format!("启动远程终端线程失败: {}", e))?;

        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "等待远程终端启动超时".to_string())??;

        Ok(input_tx)
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
