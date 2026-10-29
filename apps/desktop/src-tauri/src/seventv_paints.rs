//! 7TV name paints. The sidecar forwards paint definitions and who wears
//! which one from the 7TV EventAPI. This keeps the current picture so a
//! webview that mounts late (first paint, reload) can ask for it, and works
//! out which users changed so the webview only hears about those. The
//! paints setting also lives here, since off means the sidecar does not
//! contact 7TV at all.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::host::build_seventv_paints_line;
use crate::sidecar_commands::SidecarCommandSender;

/// Mirrors the Go `emotes.Paint`. Colors are CSS `#rrggbbaa`; no `color`
/// means the user's own chat color.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Paint {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub function: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub angle: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(default)]
    pub repeat: bool,
    #[serde(default)]
    pub stops: Vec<PaintStop>,
    #[serde(default)]
    pub shadows: Vec<PaintShadow>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct PaintStop {
    pub at: f64,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct PaintShadow {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub color: String,
}

/// Mirrors the Go `emotes.PaintEntitlement`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PaintEntitlement {
    pub action: EntitlementAction,
    #[serde(default)]
    pub user_id: String,
    pub seventv_id: String,
    #[serde(default)]
    pub paint_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntitlementAction {
    Create,
    Delete,
    Reset,
}

/// One sidecar notification about paints.
pub enum PaintEvent {
    Paint(Box<Paint>),
    Entitlement(PaintEntitlement),
}

/// A Twitch user's paint changing; no `paint_id` means they no longer
/// wear one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UserPaint {
    pub user_id: String,
    pub paint_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PaintSnapshot {
    pub paints: Vec<Paint>,
    pub users: Vec<UserPaint>,
}

/// Painted users remembered at most. Busy channels assign a few hundred an
/// hour, so this only bites in sessions that run for days; the oldest
/// assignments go first.
const MAX_USERS: usize = 20_000;

#[derive(Default)]
pub struct PaintState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    paints: HashMap<String, Paint>,
    users: HashMap<String, Wearer>,
    // Assignment order for eviction. A user assigned again leaves a stale
    // entry behind, recognized by its old sequence number.
    order: VecDeque<(String, u64)>,
    seq: u64,
}

struct Wearer {
    paint_id: String,
    seventv_id: String,
    seq: u64,
}

impl PaintState {
    /// Stores a paint definition; false when it was already known as is.
    pub fn add_paint(&self, paint: &Paint) -> bool {
        let mut inner = self.0.lock().expect("paint state poisoned");
        if inner.paints.get(&paint.id) == Some(paint) {
            return false;
        }
        inner.paints.insert(paint.id.clone(), paint.clone());
        true
    }

    /// Applies an entitlement and returns the users whose paint changed.
    pub fn apply(&self, e: PaintEntitlement) -> Vec<UserPaint> {
        let mut inner = self.0.lock().expect("paint state poisoned");
        match e.action {
            EntitlementAction::Create => {
                if e.user_id.is_empty() || e.paint_id.is_empty() {
                    return Vec::new();
                }
                inner.seq += 1;
                let seq = inner.seq;
                let previous = inner.users.insert(
                    e.user_id.clone(),
                    Wearer {
                        paint_id: e.paint_id.clone(),
                        seventv_id: e.seventv_id,
                        seq,
                    },
                );
                inner.order.push_back((e.user_id.clone(), seq));
                inner.evict();
                if previous.is_some_and(|p| p.paint_id == e.paint_id) {
                    return Vec::new();
                }
                vec![UserPaint {
                    user_id: e.user_id,
                    paint_id: Some(e.paint_id),
                }]
            }
            EntitlementAction::Delete => {
                // A delete for a paint the user already swapped away from
                // must not strip the new one.
                if inner
                    .users
                    .get(&e.user_id)
                    .is_none_or(|w| w.paint_id != e.paint_id)
                {
                    return Vec::new();
                }
                inner.users.remove(&e.user_id);
                vec![UserPaint {
                    user_id: e.user_id,
                    paint_id: None,
                }]
            }
            EntitlementAction::Reset => {
                let gone: Vec<String> = inner
                    .users
                    .iter()
                    .filter(|(_, w)| w.seventv_id == e.seventv_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                gone.into_iter()
                    .map(|user_id| {
                        inner.users.remove(&user_id);
                        UserPaint {
                            user_id,
                            paint_id: None,
                        }
                    })
                    .collect()
            }
        }
    }

    /// The paint `user_id` wears, when its definition has arrived.
    pub fn user_paint(&self, user_id: &str) -> Option<Paint> {
        let inner = self.0.lock().expect("paint state poisoned");
        let wearer = inner.users.get(user_id)?;
        inner.paints.get(&wearer.paint_id).cloned()
    }

    pub fn snapshot(&self) -> PaintSnapshot {
        let inner = self.0.lock().expect("paint state poisoned");
        PaintSnapshot {
            paints: inner.paints.values().cloned().collect(),
            users: inner
                .users
                .iter()
                .map(|(id, w)| UserPaint {
                    user_id: id.clone(),
                    paint_id: Some(w.paint_id.clone()),
                })
                .collect(),
        }
    }
}

impl Inner {
    fn evict(&mut self) {
        while self.order.len() > MAX_USERS {
            let Some((user_id, seq)) = self.order.pop_front() else {
                break;
            };
            if self.users.get(&user_id).is_some_and(|w| w.seq == seq) {
                self.users.remove(&user_id);
            }
        }
    }
}

#[tauri::command]
pub fn current_seventv_paints(state: State<'_, PaintState>) -> PaintSnapshot {
    state.snapshot()
}

/// One user's paint, for a window that shows a single chatter.
#[tauri::command]
pub fn seventv_user_paint(state: State<'_, PaintState>, user_id: String) -> Option<Paint> {
    state.user_paint(&user_id)
}

/// Whether the sidecar may talk to 7TV at all. On by default, matching the
/// frontend setting; off keeps the EventAPI socket closed and skips the
/// account lookup and presence. Same shape as
/// [`crate::first_messages::FirstMessageSetting`]: the value is locked
/// across each write so a toggle racing a sidecar start cannot reach the
/// sidecar out of order.
#[derive(Clone)]
pub struct PaintSetting {
    enabled: Arc<Mutex<bool>>,
}

impl Default for PaintSetting {
    fn default() -> Self {
        Self {
            enabled: Arc::new(Mutex::new(true)),
        }
    }
}

impl PaintSetting {
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
    match build_seventv_paints_line(enabled) {
        // A failed write means no sidecar is up; the next one gets the
        // value at spawn.
        Ok(line) => {
            write(&line);
        }
        Err(e) => tracing::error!(error = %e, "failed to serialize seventv_paints"),
    }
}

#[tauri::command]
pub fn set_seventv_paints(
    state: State<'_, PaintSetting>,
    sender: State<'_, SidecarCommandSender>,
    enabled: bool,
) {
    state.set(enabled, |line| sender.write_raw(line));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced(setting: &PaintSetting) -> serde_json::Value {
        let mut line = Vec::new();
        setting.sync(|l| {
            line = l.to_vec();
            true
        });
        serde_json::from_slice(&line).unwrap()
    }

    #[test]
    fn setting_syncs_the_stored_value() {
        let setting = PaintSetting::default();
        let v = synced(&setting);
        assert_eq!(v["cmd"], "seventv_paints");
        assert_eq!(v["enabled"], true);

        let mut writes = 0;
        setting.set(false, |_| {
            writes += 1;
            true
        });
        assert_eq!(writes, 1);
        assert_eq!(synced(&setting)["enabled"], false);

        // no sidecar up: the value is kept for the next spawn
        setting.set(true, |_| false);
        assert_eq!(synced(&setting)["enabled"], true);
    }

    fn paint(id: &str) -> Paint {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": "Firebrand",
            "function": "RADIAL_GRADIENT",
            "angle": 0.0,
            "shape": "circle",
            "repeat": false,
            "stops": [{"at": 0.15, "color": "#fff700ff"}, {"at": 1.0, "color": "#db1d0fff"}],
            "shadows": [{"x": 0.0, "y": 0.0, "radius": 4.0, "color": "#e00f00ff"}]
        }))
        .unwrap()
    }

    fn entitlement(
        action: EntitlementAction,
        user: &str,
        stv: &str,
        paint: &str,
    ) -> PaintEntitlement {
        PaintEntitlement {
            action,
            user_id: user.into(),
            seventv_id: stv.into(),
            paint_id: paint.into(),
        }
    }

    fn wears(user: &str, paint: Option<&str>) -> Vec<UserPaint> {
        vec![UserPaint {
            user_id: user.into(),
            paint_id: paint.map(Into::into),
        }]
    }

    #[test]
    fn user_paint_needs_both_the_assignment_and_the_definition() {
        let state = PaintState::default();
        state.apply(entitlement(EntitlementAction::Create, "u1", "s1", "p1"));
        assert_eq!(state.user_paint("u1"), None);
        state.add_paint(&paint("p1"));
        assert_eq!(state.user_paint("u1"), Some(paint("p1")));
        assert_eq!(state.user_paint("u2"), None);
    }

    #[test]
    fn decodes_sidecar_payloads() {
        let p: Paint = serde_json::from_str(
            r##"{"id":"01HBXZS5680009NC1Q0NCNE82C","name":"TwitchCon 2023 Las Vegas","function":"URL","angle":0,"shape":"circle","image_url":"https://cdn.7tv.app/paint/01HBXZS5680009NC1Q0NCNE82C/layer/01JAMR2BPQYF8Y2KQZF5Q6BDXR/1x.webp","repeat":false,"stops":[],"shadows":[{"x":1,"y":1,"radius":0.1,"color":"#9d01c0ff"}]}"##,
        )
        .unwrap();
        assert_eq!(p.function, "URL");
        assert_eq!(p.color, None);
        assert_eq!(p.shadows[0].x, 1.0);

        let e: PaintEntitlement =
            serde_json::from_str(r#"{"action":"reset","seventv_id":"01HD25TP0G000506K0FGX9BTDP"}"#)
                .unwrap();
        assert_eq!(e.action, EntitlementAction::Reset);
        assert!(e.user_id.is_empty());
    }

    #[test]
    fn add_paint_reports_only_changes() {
        let state = PaintState::default();
        assert!(state.add_paint(&paint("p1")));
        assert!(!state.add_paint(&paint("p1")));
        let mut renamed = paint("p1");
        renamed.name = "Other".into();
        assert!(state.add_paint(&renamed));
        assert_eq!(state.snapshot().paints, vec![renamed]);
    }

    #[test]
    fn create_delete_and_reset() {
        use EntitlementAction::*;
        let state = PaintState::default();
        assert_eq!(
            state.apply(entitlement(Create, "1", "s1", "p1")),
            wears("1", Some("p1"))
        );
        assert!(state.apply(entitlement(Create, "1", "s1", "p1")).is_empty());
        assert_eq!(
            state.apply(entitlement(Create, "1", "s1", "p2")),
            wears("1", Some("p2"))
        );
        // stale delete for the paint they swapped away from
        assert!(state.apply(entitlement(Delete, "1", "s1", "p1")).is_empty());
        assert_eq!(
            state.apply(entitlement(Delete, "1", "s1", "p2")),
            wears("1", None)
        );
        assert!(state.apply(entitlement(Delete, "1", "s1", "p2")).is_empty());
        assert!(state.apply(entitlement(Create, "", "s1", "p2")).is_empty());

        state.apply(entitlement(Create, "1", "s1", "p1"));
        state.apply(entitlement(Create, "2", "s1", "p1"));
        state.apply(entitlement(Create, "3", "s3", "p1"));
        let mut reset = state.apply(entitlement(Reset, "", "s1", ""));
        reset.sort_by(|a, b| a.user_id.cmp(&b.user_id));
        assert_eq!(
            reset,
            vec![
                UserPaint {
                    user_id: "1".into(),
                    paint_id: None
                },
                UserPaint {
                    user_id: "2".into(),
                    paint_id: None
                },
            ]
        );
        assert_eq!(state.snapshot().users, wears("3", Some("p1")));
    }

    #[test]
    fn evicts_oldest_assignment_past_the_cap() {
        use EntitlementAction::*;
        let state = PaintState::default();
        for i in 0..MAX_USERS {
            state.apply(entitlement(Create, &i.to_string(), "s", "p"));
        }
        // re-assigning user 0 moves it to the back, so user 1 goes first
        state.apply(entitlement(Create, "0", "s", "p2"));
        state.apply(entitlement(Create, "new", "s", "p"));
        let inner = state.0.lock().unwrap();
        assert_eq!(inner.users.len(), MAX_USERS);
        assert!(inner.order.len() <= MAX_USERS);
        assert!(inner.users.contains_key("0"));
        assert!(!inner.users.contains_key("1"));
        assert!(inner.users.contains_key("new"));
    }
}
