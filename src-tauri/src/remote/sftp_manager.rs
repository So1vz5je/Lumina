use crate::remote::file_types::{
    RemoteTransferDirection, RemoteTransferStatus, RemoteTransferTask,
};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct SftpManager {
    tasks: HashMap<String, RemoteTransferTask>,
    task_order: Vec<String>,
    cancelled_tasks: HashSet<String>,
    next_task_index: u64,
}

pub fn join_remote_path(base: &str, child: &str, _os_type: Option<&str>) -> String {
    let normalized_base = normalize_remote_path(base);
    let normalized_child = normalize_remote_path(child);

    if normalized_child.is_empty() {
        return normalized_base;
    }

    if normalized_child.starts_with('/') || has_windows_drive_prefix(&normalized_child) {
        return normalized_child;
    }

    if normalized_base.is_empty() {
        return normalized_child;
    }

    if normalized_base == "/" {
        return format!("/{}", normalized_child.trim_start_matches('/'));
    }

    format!(
        "{}/{}",
        normalized_base.trim_end_matches('/'),
        normalized_child.trim_start_matches('/')
    )
}

pub fn parent_remote_path(path: &str) -> Option<String> {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim_end_matches('/').to_string();

    if trimmed.is_empty() || trimmed == "/" || is_windows_drive_root(&normalized) {
        return None;
    }

    let path = if trimmed.is_empty() {
        normalized
    } else {
        trimmed
    };

    if let Some(index) = path.rfind('/') {
        if index == 0 {
            return Some("/".to_string());
        }

        if index == 2 && has_windows_drive_prefix(&path) {
            return Some(format!("{}/", &path[..2]));
        }

        return Some(path[..index].to_string());
    }

    None
}

impl SftpManager {
    pub fn register_task(
        &mut self,
        connection_id: String,
        direction: RemoteTransferDirection,
        source_paths: Vec<String>,
        target_path: String,
    ) -> RemoteTransferTask {
        self.next_task_index += 1;
        let id = format!("transfer-{}", self.next_task_index);
        let total_items = source_paths.len() as u64;
        let task = RemoteTransferTask {
            id: id.clone(),
            connection_id,
            direction,
            source_paths,
            target_path,
            status: RemoteTransferStatus::Queued,
            total_items,
            completed_items: 0,
            total_bytes: 0,
            bytes_transferred: 0,
            conflict_policy: None,
            last_error: None,
        };

        self.task_order.push(id.clone());
        self.tasks.insert(id, task.clone());
        task
    }

    pub fn list_tasks_for_connection(&self, connection_id: &str) -> Vec<RemoteTransferTask> {
        self.task_order
            .iter()
            .filter_map(|task_id| self.tasks.get(task_id))
            .filter(|task| task.connection_id == connection_id)
            .cloned()
            .collect()
    }

    pub fn update_task_status(
        &mut self,
        task_id: &str,
        status: RemoteTransferStatus,
        error: Option<String>,
    ) -> Option<RemoteTransferTask> {
        let task = self.tasks.get_mut(task_id)?;
        task.status = status;
        task.last_error = error;
        Some(task.clone())
    }

    pub fn request_cancel(&mut self, task_id: &str) -> bool {
        if !self.tasks.contains_key(task_id) {
            return false;
        }

        self.cancelled_tasks.insert(task_id.to_string());
        true
    }

    pub fn is_cancel_requested(&self, task_id: &str) -> bool {
        self.cancelled_tasks.contains(task_id)
    }
}

fn normalize_remote_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_windows_drive_root(path: &str) -> bool {
    let normalized = path.trim_end_matches('/');
    has_windows_drive_prefix(path) && normalized.len() == 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::file_types::{RemoteTransferDirection, RemoteTransferStatus};

    #[test]
    fn joins_linux_paths_without_losing_root() {
        assert_eq!(
            join_remote_path("/", "var/log", Some("Linux")),
            "/var/log".to_string()
        );
        assert_eq!(
            join_remote_path("/opt/tools", "bin", Some("Linux")),
            "/opt/tools/bin".to_string()
        );
    }

    #[test]
    fn joins_windows_paths_with_drive_prefixes() {
        assert_eq!(
            join_remote_path("C:/Users/admin", "Desktop", Some("Windows")),
            "C:/Users/admin/Desktop".to_string()
        );
        assert_eq!(
            join_remote_path("D:/", "logs", Some("Windows")),
            "D:/logs".to_string()
        );
    }

    #[test]
    fn derives_parent_paths_for_linux_and_windows_roots() {
        assert_eq!(parent_remote_path("/"), None);
        assert_eq!(parent_remote_path("/var/www"), Some("/var".to_string()));
        assert_eq!(parent_remote_path("C:/"), None);
        assert_eq!(
            parent_remote_path("C:/Users/admin"),
            Some("C:/Users".to_string())
        );
    }

    #[test]
    fn tracks_task_status_and_cancellation_flags() {
        let mut manager = SftpManager::default();

        let task = manager.register_task(
            "conn-1".to_string(),
            RemoteTransferDirection::Upload,
            vec!["C:/logs".to_string()],
            "/tmp".to_string(),
        );

        assert_eq!(task.status, RemoteTransferStatus::Queued);
        assert_eq!(manager.list_tasks_for_connection("conn-1").len(), 1);

        let running = manager
            .update_task_status(&task.id, RemoteTransferStatus::Running, None)
            .expect("task should be present");
        assert_eq!(running.status, RemoteTransferStatus::Running);

        assert!(manager.request_cancel(&task.id));
        assert!(manager.is_cancel_requested(&task.id));
    }
}
