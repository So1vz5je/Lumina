use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConnection {
    pub protocol: String,
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: String,
    pub remote_port: u16,
    pub state: String,
    pub pid: u32,
    pub is_external: bool,
    pub is_suspicious_port: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInterface {
    pub name: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub mac: String,
    pub gateway: String,
    pub dns: Vec<String>,
}

pub struct NetworkAnalyzer;

impl NetworkAnalyzer {
    /// 解析 netstat -ano 输出
    fn parse_netstat(output: &str) -> Vec<NetworkConnection> {
        let mut connections = Vec::new();

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty()
                || line.starts_with("协议")
                || line.starts_with("Proto")
                || line.starts_with("Active")
            {
                continue;
            }

            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 4 {
                continue;
            }

            let protocol = parts[0].to_uppercase();

            // 解析本地地址
            let (local_address, local_port) = Self::parse_address(parts[1]);

            // 解析远程地址和状态
            let (remote_address, remote_port, state, pid) = if protocol == "UDP" {
                // UDP: Proto  Local Address  Foreign Address  PID
                let (ra, rp) = Self::parse_address(parts[2]);
                let p = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                (ra, rp, "".to_string(), p)
            } else {
                // TCP: Proto  Local Address  Foreign Address  State  PID
                let (ra, rp) = Self::parse_address(parts[2]);
                let s = parts.get(3).map(|s| s.to_string()).unwrap_or_default();
                let p = parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
                (ra, rp, s, p)
            };

            // 判断是否外联
            let is_external = !remote_address.is_empty()
                && remote_address != "0.0.0.0"
                && remote_address != "*"
                && !remote_address.starts_with("127.")
                && !remote_address.starts_with("192.168.")
                && !remote_address.starts_with("10.")
                && !remote_address.starts_with("172.");

            // 可疑端口
            let suspicious_ports = [4444, 5555, 6666, 7777, 8888, 1234, 31337, 12345, 54321];
            let is_suspicious_port =
                suspicious_ports.contains(&local_port) || suspicious_ports.contains(&remote_port);

            connections.push(NetworkConnection {
                protocol,
                local_address,
                local_port,
                remote_address,
                remote_port,
                state,
                pid,
                is_external,
                is_suspicious_port,
            });
        }

        connections
    }

    /// 解析地址和端口
    fn parse_address(addr: &str) -> (String, u16) {
        // 格式: 192.168.1.1:80 或 [::1]:80 或 0.0.0.0:*
        if let Some(last_colon) = addr.rfind(':') {
            let address = addr[..last_colon]
                .trim_matches(|c| c == '[' || c == ']')
                .to_string();
            let port_str = &addr[last_colon + 1..];
            let port = if port_str == "*" {
                0
            } else {
                port_str.parse().unwrap_or(0)
            };
            (address, port)
        } else {
            (addr.to_string(), 0)
        }
    }

    /// 解析 ipconfig 输出
    fn parse_ipconfig(output: &str) -> Vec<NetworkInterface> {
        let mut interfaces = Vec::new();
        let mut current: Option<NetworkInterface> = None;

        for line in output.lines() {
            let line_trimmed = line.trim();

            // 新适配器开始
            if line.starts_with("以太网适配器")
                || line.starts_with("无线局域网适配器")
                || line.starts_with("Ethernet adapter")
                || line.starts_with("Wireless LAN adapter")
            {
                if let Some(iface) = current.take() {
                    interfaces.push(iface);
                }
                let name = line.split(':').next().unwrap_or("").trim().to_string();
                current = Some(NetworkInterface {
                    name,
                    ipv4: Vec::new(),
                    ipv6: Vec::new(),
                    mac: String::new(),
                    gateway: String::new(),
                    dns: Vec::new(),
                });
            }

            if let Some(ref mut iface) = current {
                if line_trimmed.starts_with("IPv4") || line_trimmed.contains("IPv4 Address") {
                    if let Some(ip) = line_trimmed.split(':').nth(1) {
                        iface.ipv4.push(
                            ip.trim()
                                .trim_start_matches("(首选) ")
                                .trim_start_matches("(Preferred) ")
                                .to_string(),
                        );
                    }
                } else if line_trimmed.starts_with("IPv6") || line_trimmed.contains("IPv6 Address")
                {
                    if let Some(ip) = line_trimmed.split(':').nth(1) {
                        iface.ipv6.push(ip.trim().to_string());
                    }
                } else if line_trimmed.starts_with("物理地址")
                    || line_trimmed.starts_with("Physical Address")
                {
                    if let Some(mac) = line_trimmed.split(':').nth(1) {
                        iface.mac = mac.trim().to_string();
                    }
                } else if line_trimmed.starts_with("默认网关")
                    || line_trimmed.starts_with("Default Gateway")
                {
                    if let Some(gw) = line_trimmed.split(':').nth(1) {
                        let gw = gw.trim();
                        if !gw.is_empty() {
                            iface.gateway = gw.to_string();
                        }
                    }
                } else if line_trimmed.starts_with("DNS 服务器")
                    || line_trimmed.starts_with("DNS Servers")
                {
                    if let Some(dns) = line_trimmed.split(':').nth(1) {
                        let dns = dns.trim();
                        if !dns.is_empty() {
                            iface.dns.push(dns.to_string());
                        }
                    }
                }
            }
        }

        if let Some(iface) = current {
            interfaces.push(iface);
        }

        interfaces
    }
}

impl Analyzer for NetworkAnalyzer {
    fn name(&self) -> &str {
        "网络分析"
    }

    fn run(&self) -> AnalysisResult {
        // 网络连接 (netstat -ano)
        let netstat_output = Command::new("netstat")
            .args(["-ano"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // IP配置 (ipconfig /all)
        let ipconfig_output = Command::new("ipconfig")
            .arg("/all")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // 路由表 (route print)
        let routes_output = Command::new("route")
            .arg("print")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        // 解析数据
        let connections = Self::parse_netstat(&netstat_output);
        let interfaces = Self::parse_ipconfig(&ipconfig_output);

        // 统计
        let tcp_count = connections.iter().filter(|c| c.protocol == "TCP").count();
        let udp_count = connections.iter().filter(|c| c.protocol == "UDP").count();
        let established_count = connections
            .iter()
            .filter(|c| c.state == "ESTABLISHED")
            .count();
        let listening_count = connections
            .iter()
            .filter(|c| c.state == "LISTENING" || c.state == "LISTEN")
            .count();
        let external_count = connections.iter().filter(|c| c.is_external).count();
        let suspicious_count = connections.iter().filter(|c| c.is_suspicious_port).count();

        // 获取监听端口列表
        let listening_ports: Vec<u16> = connections
            .iter()
            .filter(|c| c.state == "LISTENING" || c.state == "LISTEN")
            .map(|c| c.local_port)
            .collect();

        // 外联连接详情
        let external_connections: Vec<&NetworkConnection> = connections
            .iter()
            .filter(|c| c.is_external && c.state == "ESTABLISHED")
            .collect();

        let details = json!({
            "connections": connections,
            "interfaces": interfaces,
            "statistics": {
                "tcp_count": tcp_count,
                "udp_count": udp_count,
                "established_count": established_count,
                "listening_count": listening_count,
                "external_count": external_count,
                "suspicious_count": suspicious_count
            },
            "listening_ports": listening_ports,
            "external_connections": external_connections,
            // 原始输出用于调试
            "netstat_raw": netstat_output,
            "ipconfig_raw": ipconfig_output,
            "routes_raw": routes_output
        });

        let status = if suspicious_count > 0 {
            "warning"
        } else {
            "ok"
        };
        let summary = if suspicious_count > 0 {
            format!(
                "发现 {} 个可疑端口, {} 个外联连接",
                suspicious_count, external_count
            )
        } else {
            format!(
                "监听 {} 个端口, {} 个外联连接",
                listening_count, external_count
            )
        };

        AnalysisResult {
            module_name: "network".to_string(),
            status: status.to_string(),
            summary,
            details,
        }
    }
}
