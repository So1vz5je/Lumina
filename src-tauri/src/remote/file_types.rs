use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteEntryType {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTransferStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteConflictPolicy {
    Overwrite,
    Merge,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub path: String,
    pub name: String,
    pub entry_type: RemoteEntryType,
    pub size: u64,
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectorySnapshot {
    pub connection_id: String,
    pub path: String,
    pub parent_path: Option<String>,
    pub os_type: Option<String>,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferTask {
    pub id: String,
    pub connection_id: String,
    pub direction: RemoteTransferDirection,
    pub source_paths: Vec<String>,
    pub target_path: String,
    pub status: RemoteTransferStatus,
    pub total_items: u64,
    pub completed_items: u64,
    pub total_bytes: u64,
    pub bytes_transferred: u64,
    pub conflict_policy: Option<RemoteConflictPolicy>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferConflict {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferPreparation {
    pub task_preview: RemoteTransferTask,
    pub conflicts: Vec<RemoteTransferConflict>,
    pub warnings: Vec<String>,
    pub estimated_item_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTransferStartRequest {
    pub connection_id: String,
    pub direction: RemoteTransferDirection,
    pub source_paths: Vec<String>,
    pub target_path: String,
    pub conflict_policy: RemoteConflictPolicy,
}
