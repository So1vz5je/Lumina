use crate::analyzer::{AnalysisResult, Analyzer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerContainerEntry {
    pub container_id: String,
    pub image: String,
    pub status: String,
    pub name: String,
    pub ports: String,
    pub suspicious: bool,
    pub suspicious_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerImageEntry {
    pub repository: String,
    pub tag: String,
    pub image_id: String,
    pub size: String,
    pub created_at: String,
}

pub struct DockerAnalyzer;

impl DockerAnalyzer {
    fn run_docker(args: &[&str]) -> (String, String) {
        match Command::new("docker")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => (
                String::from_utf8_lossy(&output.stdout).to_string(),
                String::from_utf8_lossy(&output.stderr).to_string(),
            ),
            Err(error) => (String::new(), error.to_string()),
        }
    }

    fn value_to_string(value: Option<&Value>) -> String {
        match value {
            Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::Bool(b)) => b.to_string(),
            _ => "-".to_string(),
        }
    }

    fn read_field(item: &Value, keys: &[&str]) -> String {
        keys.iter()
            .find_map(|key| {
                let value = Self::value_to_string(item.get(*key));
                if value == "-" {
                    None
                } else {
                    Some(value)
                }
            })
            .unwrap_or_else(|| "-".to_string())
    }

    fn parse_json_lines(output: &str) -> Vec<Value> {
        output
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return None;
                }

                serde_json::from_str::<Value>(trimmed).ok()
            })
            .collect()
    }

    fn check_suspicious(text: &str) -> (bool, Option<String>) {
        let lower = text.to_lowercase();
        let markers = [
            ("xmrig", "miner-related container"),
            ("kinsing", "known container malware marker"),
            ("kdevtmpfsi", "known crypto-miner marker"),
            ("watchdog", "suspicious watchdog name"),
            ("masscan", "network scanning tool"),
            ("metasploit", "offensive security image"),
        ];

        for (marker, reason) in markers {
            if lower.contains(marker) {
                return (true, Some(reason.to_string()));
            }
        }

        let exposed_sensitive_ports = [
            ("0.0.0.0:2375", "Docker API exposed"),
            ("0.0.0.0:2376", "Docker TLS API exposed"),
            ("0.0.0.0:6379", "Redis exposed"),
            ("0.0.0.0:3306", "MySQL exposed"),
            ("0.0.0.0:5432", "PostgreSQL exposed"),
            ("0.0.0.0:27017", "MongoDB exposed"),
        ];

        for (marker, reason) in exposed_sensitive_ports {
            if lower.contains(marker) {
                return (true, Some(reason.to_string()));
            }
        }

        (false, None)
    }

    fn parse_containers(output: &str) -> Vec<DockerContainerEntry> {
        Self::parse_json_lines(output)
            .into_iter()
            .map(|item| {
                let container_id = Self::read_field(&item, &["ID", "ContainerID", "id"]);
                let image = Self::read_field(&item, &["Image", "image"]);
                let status = Self::read_field(&item, &["Status", "State", "status"]);
                let name = Self::read_field(&item, &["Names", "Name", "names"]);
                let ports = Self::read_field(&item, &["Ports", "ports"]);
                let combined = format!("{} {} {} {}", container_id, image, name, ports);
                let (suspicious, suspicious_reason) = Self::check_suspicious(&combined);

                DockerContainerEntry {
                    container_id,
                    image,
                    status,
                    name,
                    ports,
                    suspicious,
                    suspicious_reason,
                }
            })
            .collect()
    }

    fn parse_images(output: &str) -> Vec<DockerImageEntry> {
        Self::parse_json_lines(output)
            .into_iter()
            .map(|item| DockerImageEntry {
                repository: Self::read_field(&item, &["Repository", "repository"]),
                tag: Self::read_field(&item, &["Tag", "tag"]),
                image_id: Self::read_field(&item, &["ID", "ImageID", "image_id"]),
                size: Self::read_field(&item, &["Size", "size"]),
                created_at: Self::read_field(&item, &["CreatedAt", "CreatedSince", "created_at"]),
            })
            .collect()
    }
}

impl Analyzer for DockerAnalyzer {
    fn name(&self) -> &str {
        "Docker"
    }

    fn run(&self) -> AnalysisResult {
        let (containers_output, containers_error) =
            Self::run_docker(&["ps", "-a", "--format", "{{json .}}"]);
        let (images_output, images_error) = Self::run_docker(&["images", "--format", "{{json .}}"]);

        let containers = Self::parse_containers(&containers_output);
        let images = Self::parse_images(&images_output);
        let suspicious_containers: Vec<&DockerContainerEntry> =
            containers.iter().filter(|item| item.suspicious).collect();

        let docker_available = !containers_output.trim().is_empty()
            || !images_output.trim().is_empty()
            || containers_error.trim().is_empty()
            || images_error.trim().is_empty();

        let status = if !suspicious_containers.is_empty() {
            "warning"
        } else {
            "ok"
        };

        let summary = if !docker_available && containers.is_empty() && images.is_empty() {
            "未检测到可用 Docker CLI 或 Docker 服务".to_string()
        } else {
            format!(
                "{} 个容器, {} 个镜像, {} 个可疑容器",
                containers.len(),
                images.len(),
                suspicious_containers.len()
            )
        };

        AnalysisResult {
            module_name: "docker".to_string(),
            status: status.to_string(),
            summary,
            details: json!({
                "containers": containers,
                "images": images,
                "suspicious_containers": suspicious_containers,
                "statistics": {
                    "container_count": containers.len(),
                    "image_count": images.len(),
                    "suspicious_count": suspicious_containers.len(),
                    "docker_available": docker_available
                },
                "raw": {
                    "containers_stdout": containers_output,
                    "containers_stderr": containers_error,
                    "images_stdout": images_output,
                    "images_stderr": images_error
                }
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DockerAnalyzer;

    #[test]
    fn parses_docker_json_lines_and_flags_exposed_sensitive_ports() {
        let output = r#"{"ID":"abc123","Image":"redis:latest","Status":"Up 2 hours","Names":"cache","Ports":"0.0.0.0:6379->6379/tcp"}
{"ID":"def456","Image":"nginx:stable","Status":"Exited","Names":"web","Ports":"80/tcp"}"#;

        let containers = DockerAnalyzer::parse_containers(output);

        assert_eq!(containers.len(), 2);
        assert_eq!(containers[0].container_id, "abc123");
        assert!(containers[0].suspicious);
        assert_eq!(
            containers[0].suspicious_reason.as_deref(),
            Some("Redis exposed")
        );
        assert!(!containers[1].suspicious);
    }

    #[test]
    fn parses_docker_image_json_lines() {
        let output = r#"{"Repository":"nginx","Tag":"stable","ID":"sha256:abc","Size":"188MB","CreatedAt":"2026-05-20"}"#;

        let images = DockerAnalyzer::parse_images(output);

        assert_eq!(images.len(), 1);
        assert_eq!(images[0].repository, "nginx");
        assert_eq!(images[0].tag, "stable");
    }
}
