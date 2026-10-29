//! Switch for 7TV emotes. While it is off the sidecar fetches no 7TV sets,
//! and flipping it refetches every open channel's bundle so the emotes
//! come and go without a rejoin.

use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;

use crate::host::build_seventv_emotes_line;
use crate::sidecar_commands::SidecarCommandSender;

/// On by default, matching the frontend setting. Locked across each write
/// so a toggle racing a sidecar start cannot reach it out of order.
#[derive(Clone)]
pub struct SevenTvEmoteSetting {
    enabled: Arc<Mutex<bool>>,
}

impl Default for SevenTvEmoteSetting {
    fn default() -> Self {
        Self {
            enabled: Arc::new(Mutex::new(true)),
        }
    }
}

impl SevenTvEmoteSetting {
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
    match build_seventv_emotes_line(enabled) {
        // A failed write means no sidecar is up; the next one gets the
        // value at spawn.
        Ok(line) => {
            write(&line);
        }
        Err(e) => tracing::error!(error = %e, "failed to serialize seventv_emotes"),
    }
}

#[tauri::command]
pub fn set_seventv_emotes(
    state: State<'_, SevenTvEmoteSetting>,
    sender: State<'_, SidecarCommandSender>,
    enabled: bool,
) {
    state.set(enabled, |line| sender.write_raw(line));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced(setting: &SevenTvEmoteSetting) -> serde_json::Value {
        let mut line = Vec::new();
        setting.sync(|l| {
            line = l.to_vec();
            true
        });
        serde_json::from_slice(&line).unwrap()
    }

    #[test]
    fn sync_sends_the_stored_value() {
        let setting = SevenTvEmoteSetting::default();
        let v = synced(&setting);
        assert_eq!(v["cmd"], "seventv_emotes");
        assert_eq!(v["enabled"], true);
        setting.set(false, |_| false);
        assert_eq!(synced(&setting)["enabled"], false);
    }
}
