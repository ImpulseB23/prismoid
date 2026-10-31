//! Switch for first-time chatter highlights. EventSub has no first-message
//! flag, so the sidecar spots them on an anonymous Twitch IRC connection
//! of its own; while the setting is off it does not report them.

use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;

use crate::host::build_first_messages_line;
use crate::sidecar_commands::SidecarCommandSender;

/// On by default, matching the frontend setting. The value is locked
/// across each write so a toggle racing a sidecar start cannot reach the
/// sidecar out of order.
#[derive(Clone)]
pub struct FirstMessageSetting {
    enabled: Arc<Mutex<bool>>,
}

impl Default for FirstMessageSetting {
    fn default() -> Self {
        Self {
            enabled: Arc::new(Mutex::new(true)),
        }
    }
}

impl FirstMessageSetting {
    /// Sends the current value; the supervisor calls this after each spawn.
    pub fn sync(&self, write: impl FnOnce(&[u8]) -> bool) {
        let enabled = self.enabled.lock().unwrap_or_else(PoisonError::into_inner);
        send(*enabled, write);
    }

    fn set(&self, value: bool, write: impl FnOnce(&[u8]) -> bool) {
        let mut enabled = self.enabled.lock().unwrap_or_else(PoisonError::into_inner);
        *enabled = value;
        send(value, write);
    }
}

fn send(enabled: bool, write: impl FnOnce(&[u8]) -> bool) {
    match build_first_messages_line(enabled) {
        // A failed write means no sidecar is up; the next one gets the
        // value at spawn.
        Ok(line) => {
            write(&line);
        }
        Err(e) => tracing::error!(error = %e, "failed to serialize first_messages"),
    }
}

#[tauri::command]
pub fn set_first_messages(
    state: State<'_, FirstMessageSetting>,
    sender: State<'_, SidecarCommandSender>,
    enabled: bool,
) {
    state.set(enabled, |line| sender.write_raw(line));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced(setting: &FirstMessageSetting) -> serde_json::Value {
        let mut line = Vec::new();
        setting.sync(|l| {
            line = l.to_vec();
            true
        });
        serde_json::from_slice(&line).unwrap()
    }

    #[test]
    fn sync_sends_the_stored_value() {
        let setting = FirstMessageSetting::default();
        let v = synced(&setting);
        assert_eq!(v["cmd"], "first_messages");
        assert_eq!(v["enabled"], true);

        let mut writes = 0;
        setting.set(false, |_| {
            writes += 1;
            true
        });
        assert_eq!(writes, 1);
        assert_eq!(synced(&setting)["enabled"], false);
    }

    #[test]
    fn set_keeps_the_value_when_no_sidecar_runs() {
        let setting = FirstMessageSetting::default();
        setting.set(false, |_| false);
        assert_eq!(synced(&setting)["enabled"], false);
    }
}
