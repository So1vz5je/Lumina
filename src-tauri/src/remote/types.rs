use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub os_type: Option<String>,
    pub status: RemoteConnectionStatus,
}

#[cfg(test)]
mod tests {
    use super::RemoteConnectionStatus;

    #[test]
    fn serializes_status_in_lowercase() {
        let serialized = serde_json::to_string(&RemoteConnectionStatus::Connected).unwrap();

        assert_eq!(serialized, "\"connected\"");
    }
}
