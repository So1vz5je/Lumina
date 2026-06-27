use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc::Sender;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalSession {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub connection_id: String,
    pub session_id: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: HashMap<String, RemoteTerminalSession>,
    input_senders: HashMap<String, Sender<Vec<u8>>>,
    session_order: Vec<String>,
    next_session_index: u64,
}

impl TerminalManager {
    pub fn open_session(&mut self, connection_id: String, title: String) -> RemoteTerminalSession {
        self.next_session_index += 1;
        let session_id = format!("term-{}", self.next_session_index);
        let session = RemoteTerminalSession {
            id: session_id.clone(),
            connection_id,
            title,
            cwd: "~".to_string(),
        };

        self.session_order.push(session_id.clone());
        self.sessions.insert(session_id, session.clone());

        session
    }

    pub fn list_sessions_for_connection(&self, connection_id: &str) -> Vec<RemoteTerminalSession> {
        self.session_order
            .iter()
            .filter_map(|session_id| self.sessions.get(session_id))
            .filter(|session| session.connection_id == connection_id)
            .cloned()
            .collect()
    }

    pub fn interactive_session_for_connection(
        &self,
        connection_id: &str,
    ) -> Option<RemoteTerminalSession> {
        self.session_order
            .iter()
            .filter(|session_id| self.input_senders.contains_key(*session_id))
            .filter_map(|session_id| self.sessions.get(session_id))
            .find(|session| session.connection_id == connection_id)
            .cloned()
    }

    pub fn close_session(&mut self, session_id: &str) -> Result<(), String> {
        if self.sessions.remove(session_id).is_none() {
            return Err(format!("Terminal session not found: {}", session_id));
        }

        self.input_senders.remove(session_id);
        self.session_order.retain(|id| id != session_id);
        Ok(())
    }

    pub fn attach_input_sender(
        &mut self,
        session_id: String,
        sender: Sender<Vec<u8>>,
    ) -> Result<(), String> {
        if !self.sessions.contains_key(&session_id) {
            return Err(format!("Terminal session not found: {}", session_id));
        }

        self.input_senders.insert(session_id, sender);
        Ok(())
    }

    pub fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let sender = self
            .input_senders
            .get(session_id)
            .ok_or_else(|| format!("Interactive terminal session not found: {}", session_id))?;

        sender
            .send(data)
            .map_err(|err| format!("Failed to send terminal input: {}", err))
    }

    pub fn close_sessions_for_connection(&mut self, connection_id: &str) -> usize {
        let session_ids: Vec<String> = self
            .session_order
            .iter()
            .filter_map(|session_id| {
                let session = self.sessions.get(session_id)?;
                (session.connection_id == connection_id).then(|| session_id.clone())
            })
            .collect();

        let closed_count = session_ids.len();
        for session_id in session_ids {
            let _ = self.close_session(&session_id);
        }

        closed_count
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalManager;

    #[test]
    fn opens_and_closes_terminal_sessions_per_connection() {
        let mut manager = TerminalManager::default();

        let first = manager.open_session("conn-1".into(), "Prod shell".into());
        let second = manager.open_session("conn-1".into(), "Prod root".into());
        let third = manager.open_session("conn-2".into(), "Staging shell".into());

        let conn_1_sessions = manager.list_sessions_for_connection("conn-1");
        assert_eq!(conn_1_sessions.len(), 2);
        assert_eq!(conn_1_sessions[0].id, first.id);
        assert_eq!(conn_1_sessions[1].id, second.id);

        let conn_2_sessions = manager.list_sessions_for_connection("conn-2");
        assert_eq!(conn_2_sessions.len(), 1);
        assert_eq!(conn_2_sessions[0].id, third.id);

        manager.close_session(&first.id).unwrap();

        let conn_1_sessions_after_close = manager.list_sessions_for_connection("conn-1");
        assert_eq!(conn_1_sessions_after_close.len(), 1);
        assert_eq!(conn_1_sessions_after_close[0].id, second.id);

        let conn_2_sessions_after_close = manager.list_sessions_for_connection("conn-2");
        assert_eq!(conn_2_sessions_after_close.len(), 1);
        assert_eq!(conn_2_sessions_after_close[0].id, third.id);
    }

    #[test]
    fn closes_all_sessions_for_a_connection_without_touching_others() {
        let mut manager = TerminalManager::default();

        manager.open_session("conn-1".into(), "Prod shell".into());
        manager.open_session("conn-1".into(), "Prod root".into());
        let other_connection_session =
            manager.open_session("conn-2".into(), "Staging shell".into());

        let closed_count = manager.close_sessions_for_connection("conn-1");

        assert_eq!(closed_count, 2);
        assert!(manager.list_sessions_for_connection("conn-1").is_empty());

        let conn_2_sessions = manager.list_sessions_for_connection("conn-2");
        assert_eq!(conn_2_sessions.len(), 1);
        assert_eq!(conn_2_sessions[0].id, other_connection_session.id);
    }

    #[test]
    fn closing_sessions_for_unknown_connection_is_a_no_op() {
        let mut manager = TerminalManager::default();

        let existing_session = manager.open_session("conn-1".into(), "Prod shell".into());

        let closed_count = manager.close_sessions_for_connection("conn-missing");

        assert_eq!(closed_count, 0);
        let conn_1_sessions = manager.list_sessions_for_connection("conn-1");
        assert_eq!(conn_1_sessions.len(), 1);
        assert_eq!(conn_1_sessions[0].id, existing_session.id);
    }

    #[test]
    fn returns_existing_interactive_session_for_connection() {
        let mut manager = TerminalManager::default();

        let session = manager.open_session("conn-1".into(), "analysis-shell".into());
        let (sender, _receiver) = std::sync::mpsc::channel();

        manager
            .attach_input_sender(session.id.clone(), sender)
            .expect("session should accept input sender");

        let existing = manager
            .interactive_session_for_connection("conn-1")
            .expect("interactive session should be reused");

        assert_eq!(existing.id, session.id);
    }
}
