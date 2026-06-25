use std::collections::HashMap;
use std::sync::Arc;

use crate::remote::types::{RemoteConnectRequest, RemoteConnectionRecord, RemoteConnectionStatus};
use crate::ssh::SshClient;

struct ConnectionEntry {
    record: RemoteConnectionRecord,
    client: Option<Arc<SshClient>>,
}

#[derive(Default)]
pub struct ConnectionManager {
    entries: HashMap<String, ConnectionEntry>,
    record_order: Vec<String>,
    active_connection_id: Option<String>,
    next_connection_index: u64,
}

impl ConnectionManager {
    pub fn active_connection_id(&self) -> Option<&str> {
        self.active_connection_id.as_deref()
    }

    pub fn list_records(&self) -> Vec<RemoteConnectionRecord> {
        self.record_order
            .iter()
            .filter_map(|id| self.entries.get(id).map(|entry| entry.record.clone()))
            .collect()
    }

    pub fn insert_connected(
        &mut self,
        request: RemoteConnectRequest,
        client: Arc<SshClient>,
        os_type: Option<String>,
        replace_active: bool,
    ) -> RemoteConnectionRecord {
        if replace_active {
            self.disconnect_active();
        }

        let connection_id = self.next_connection_id();
        let record = RemoteConnectionRecord {
            id: connection_id.clone(),
            name: request.name,
            host: request.host,
            port: request.port,
            username: request.username,
            os_type,
            status: RemoteConnectionStatus::Connected,
        };

        self.store_entry(
            connection_id.clone(),
            ConnectionEntry {
                record: record.clone(),
                client: Some(client),
            },
        );
        self.active_connection_id = Some(connection_id);

        record
    }

    pub fn active_client(&self) -> Option<(String, Arc<SshClient>)> {
        let connection_id = self.active_connection_id.clone()?;
        let client = self.client_for_connection(&connection_id)?;
        Some((connection_id, client))
    }

    pub fn client_for_connection(&self, connection_id: &str) -> Option<Arc<SshClient>> {
        let entry = self.entries.get(connection_id)?;
        if entry.record.status != RemoteConnectionStatus::Connected {
            return None;
        }

        entry.client.clone()
    }

    pub fn disconnect_active(&mut self) -> bool {
        let Some(connection_id) = self.active_connection_id.take() else {
            return false;
        };

        self.mark_connection_status(&connection_id, RemoteConnectionStatus::Disconnected)
    }

    pub fn mark_connection_status(
        &mut self,
        connection_id: &str,
        status: RemoteConnectionStatus,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(connection_id) else {
            return false;
        };

        entry.record.status = status.clone();
        if status != RemoteConnectionStatus::Connected {
            entry.client = None;
            if self.active_connection_id.as_deref() == Some(connection_id) {
                self.active_connection_id = None;
            }
        }
        true
    }

    pub fn is_connection_connected(&self, connection_id: &str) -> bool {
        self.entries
            .get(connection_id)
            .map(|entry| entry.record.status == RemoteConnectionStatus::Connected)
            .unwrap_or(false)
    }

    pub fn is_connected(&self) -> bool {
        self.active_client().is_some()
    }

    fn store_entry(&mut self, connection_id: String, entry: ConnectionEntry) {
        if !self.entries.contains_key(&connection_id) {
            self.record_order.push(connection_id.clone());
        }
        self.entries.insert(connection_id, entry);
    }

    fn next_connection_id(&mut self) -> String {
        self.next_connection_index += 1;
        format!("conn-{}", self.next_connection_index)
    }
}

#[cfg(test)]
impl ConnectionManager {
    pub(crate) fn register_test_record(
        &mut self,
        record: RemoteConnectionRecord,
        make_active: bool,
    ) -> String {
        let connection_id = record.id.clone();

        if make_active {
            self.disconnect_active();
            self.active_connection_id = Some(connection_id.clone());
        }

        self.store_entry(
            connection_id.clone(),
            ConnectionEntry {
                record,
                client: None,
            },
        );

        connection_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::types::{RemoteConnectionRecord, RemoteConnectionStatus};

    #[test]
    fn stores_connection_metadata_and_tracks_active_connection() {
        let mut manager = ConnectionManager::default();

        let first_id = manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-1".into(),
                name: "prod".into(),
                host: "10.0.0.15".into(),
                port: 22,
                username: "root".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Disconnected,
            },
            true,
        );

        let records = manager.list_records();

        assert_eq!(first_id, "conn-1");
        assert_eq!(manager.active_connection_id(), Some("conn-1"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "prod");
        assert_eq!(records[0].host, "10.0.0.15");
        assert_eq!(records[0].port, 22);
        assert_eq!(records[0].username, "root");
        assert_eq!(records[0].os_type.as_deref(), Some("Linux"));
        assert_eq!(records[0].status, RemoteConnectionStatus::Disconnected);
    }

    #[test]
    fn replacing_active_record_marks_previous_record_disconnected() {
        let mut manager = ConnectionManager::default();

        manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-1".into(),
                name: "prod".into(),
                host: "10.0.0.15".into(),
                port: 22,
                username: "root".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Error,
            },
            true,
        );

        let second_id = manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-2".into(),
                name: "staging".into(),
                host: "10.0.0.20".into(),
                port: 2222,
                username: "admin".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Disconnected,
            },
            true,
        );

        let records = manager.list_records();

        assert_eq!(second_id, "conn-2");
        assert_eq!(manager.active_connection_id(), Some("conn-2"));
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].status, RemoteConnectionStatus::Disconnected);
        assert_eq!(records[1].status, RemoteConnectionStatus::Disconnected);
    }

    #[test]
    fn disconnecting_active_record_clears_active_state_and_marks_disconnected() {
        let mut manager = ConnectionManager::default();

        manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-1".into(),
                name: "prod".into(),
                host: "10.0.0.15".into(),
                port: 22,
                username: "root".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Error,
            },
            true,
        );

        assert!(manager.disconnect_active());
        assert_eq!(manager.active_connection_id(), None);
        assert_eq!(
            manager.list_records()[0].status,
            RemoteConnectionStatus::Disconnected
        );
    }

    #[test]
    fn reports_connected_state_for_a_specific_connection() {
        let mut manager = ConnectionManager::default();

        manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-1".into(),
                name: "prod".into(),
                host: "10.0.0.15".into(),
                port: 22,
                username: "root".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Connected,
            },
            false,
        );
        manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-2".into(),
                name: "staging".into(),
                host: "10.0.0.20".into(),
                port: 2222,
                username: "admin".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Disconnected,
            },
            false,
        );

        assert!(manager.is_connection_connected("conn-1"));
        assert!(!manager.is_connection_connected("conn-2"));
        assert!(!manager.is_connection_connected("conn-3"));
    }

    #[test]
    fn marking_active_connection_error_clears_active_selection() {
        let mut manager = ConnectionManager::default();

        manager.register_test_record(
            RemoteConnectionRecord {
                id: "conn-1".into(),
                name: "prod".into(),
                host: "10.0.0.15".into(),
                port: 22,
                username: "root".into(),
                os_type: Some("Linux".into()),
                status: RemoteConnectionStatus::Connected,
            },
            true,
        );

        assert!(manager.mark_connection_status("conn-1", RemoteConnectionStatus::Error));
        assert_eq!(manager.active_connection_id(), None);
        assert_eq!(
            manager.list_records()[0].status,
            RemoteConnectionStatus::Error
        );
    }
}
