//! Optional scope sets, one per stream manager section. Twitch warns that
//! apps asking for more scopes than they use may lose access, so a
//! section's scopes are only requested once the user turns it on. The
//! choice is kept in the app data dir and survives restarts.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::Serialize;
use twitch_oauth2::Scope;

use super::errors::AuthError;

pub const FILE_NAME: &str = "twitch_scope_groups.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeGroup {
    Stream,
    Ads,
    LiveActions,
}

const STREAM: &[Scope] = &[
    Scope::ChannelManageBroadcast,
    Scope::ChannelManagePolls,
    Scope::ChannelManagePredictions,
];

const ADS: &[Scope] = &[
    Scope::ChannelReadAds,
    Scope::ChannelManageAds,
    Scope::ChannelEditCommercial,
];

const LIVE_ACTIONS: &[Scope] = &[
    Scope::ModeratorManageShoutouts,
    Scope::ModeratorManageAnnouncements,
    Scope::ModeratorManageShieldMode,
    Scope::ClipsEdit,
];

impl ScopeGroup {
    pub fn scopes(self) -> &'static [Scope] {
        match self {
            Self::Stream => STREAM,
            Self::Ads => ADS,
            Self::LiveActions => LIVE_ACTIONS,
        }
    }
}

impl FromStr for ScopeGroup {
    type Err = AuthError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "stream" => Ok(Self::Stream),
            "ads" => Ok(Self::Ads),
            "live_actions" => Ok(Self::LiveActions),
            _ => Err(AuthError::UnknownScopeGroup(s.to_owned())),
        }
    }
}

/// Base scopes followed by those of each enabled group, without repeats.
pub fn requested_scopes(base: &[Scope], enabled: &BTreeSet<ScopeGroup>) -> Vec<Scope> {
    let mut scopes = base.to_vec();
    for scope in enabled.iter().flat_map(|g| g.scopes()) {
        if !scopes.contains(scope) {
            scopes.push(scope.clone());
        }
    }
    scopes
}

/// Enabled groups and the file they are saved to. Without a file (no app
/// data dir at startup) the choice lasts until the app closes.
#[derive(Debug, Default)]
pub struct ScopeGroups {
    path: Option<PathBuf>,
    enabled: BTreeSet<ScopeGroup>,
}

impl ScopeGroups {
    /// Reads the saved choice from `dir`. A missing or unreadable file
    /// starts with every group off; the next change rewrites it.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);
        let enabled = match read(&path) {
            Ok(enabled) => enabled,
            Err(AuthError::Io(e)) if e.kind() == io::ErrorKind::NotFound => BTreeSet::new(),
            Err(e) => {
                tracing::warn!(error = %e, "scope groups file unreadable, starting with none");
                BTreeSet::new()
            }
        };
        Self {
            path: Some(path),
            enabled,
        }
    }

    pub fn enabled(&self) -> &BTreeSet<ScopeGroup> {
        &self.enabled
    }

    /// Saves first so a failed write leaves the in-memory choice matching
    /// the file.
    pub fn set(&mut self, group: ScopeGroup, on: bool) -> Result<(), AuthError> {
        let mut next = self.enabled.clone();
        if on {
            next.insert(group);
        } else {
            next.remove(&group);
        }
        if let Some(path) = &self.path {
            write(path, &next)?;
        }
        self.enabled = next;
        Ok(())
    }
}

fn read(path: &Path) -> Result<BTreeSet<ScopeGroup>, AuthError> {
    let names: Vec<String> = serde_json::from_str(&fs::read_to_string(path)?)?;
    // Names a later version dropped are left behind rather than failing
    // the whole file.
    Ok(names.iter().filter_map(|n| n.parse().ok()).collect())
}

// Written to a sibling file and renamed over the old one, so a crash
// mid-write never leaves a truncated file behind.
fn write(path: &Path, enabled: &BTreeSet<ScopeGroup>) -> Result<(), AuthError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(&serde_json::to_vec(enabled)?)?;
    file.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_through_serde() {
        for group in [ScopeGroup::Stream, ScopeGroup::Ads, ScopeGroup::LiveActions] {
            let name = serde_json::to_value(group).unwrap();
            assert_eq!(name.as_str().unwrap().parse::<ScopeGroup>().unwrap(), group);
        }
    }

    #[test]
    fn unknown_name_is_an_error() {
        match "channel_points".parse::<ScopeGroup>() {
            Err(AuthError::UnknownScopeGroup(name)) => assert_eq!(name, "channel_points"),
            other => panic!("expected UnknownScopeGroup, got {other:?}"),
        }
    }

    #[test]
    fn groups_hold_their_scopes() {
        let names = |g: ScopeGroup| g.scopes().iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            names(ScopeGroup::Stream),
            [
                "channel:manage:broadcast",
                "channel:manage:polls",
                "channel:manage:predictions"
            ]
        );
        assert_eq!(
            names(ScopeGroup::Ads),
            [
                "channel:read:ads",
                "channel:manage:ads",
                "channel:edit:commercial"
            ]
        );
        assert_eq!(
            names(ScopeGroup::LiveActions),
            [
                "moderator:manage:shoutouts",
                "moderator:manage:announcements",
                "moderator:manage:shield_mode",
                "clips:edit"
            ]
        );
    }

    #[test]
    fn requested_scopes_appends_enabled_groups_without_repeats() {
        let base = [Scope::UserReadChat, Scope::ClipsEdit];
        assert_eq!(requested_scopes(&base, &BTreeSet::new()), base);

        let enabled = BTreeSet::from([ScopeGroup::LiveActions, ScopeGroup::Ads]);
        let mut expected = base.to_vec();
        expected.extend_from_slice(ADS);
        expected.extend_from_slice(&LIVE_ACTIONS[..3]);
        assert_eq!(requested_scopes(&base, &enabled), expected);
    }

    #[test]
    fn choice_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let mut groups = ScopeGroups::open(dir.path());
        assert!(groups.enabled().is_empty());

        groups.set(ScopeGroup::LiveActions, true).unwrap();
        groups.set(ScopeGroup::Ads, true).unwrap();
        groups.set(ScopeGroup::Ads, false).unwrap();

        let reopened = ScopeGroups::open(dir.path());
        assert_eq!(
            reopened.enabled(),
            &BTreeSet::from([ScopeGroup::LiveActions])
        );
        assert!(!dir.path().join("twitch_scope_groups.json.tmp").exists());
    }

    #[test]
    fn open_creates_nothing_until_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("app");
        let mut groups = ScopeGroups::open(&nested);
        assert!(!nested.exists());
        groups.set(ScopeGroup::Ads, true).unwrap();
        assert_eq!(
            fs::read_to_string(nested.join(FILE_NAME)).unwrap(),
            r#"["ads"]"#
        );
    }

    #[test]
    fn unreadable_file_starts_with_none() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "not json").unwrap();
        assert!(ScopeGroups::open(dir.path()).enabled().is_empty());
    }

    #[test]
    fn dropped_group_names_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), r#"["gone", "ads"]"#).unwrap();
        assert_eq!(
            ScopeGroups::open(dir.path()).enabled(),
            &BTreeSet::from([ScopeGroup::Ads])
        );
    }

    #[test]
    fn failed_write_keeps_the_old_choice() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be makes the rename fail.
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        let mut groups = ScopeGroups::open(dir.path());
        assert!(matches!(
            groups.set(ScopeGroup::Ads, true),
            Err(AuthError::Io(_))
        ));
        assert!(groups.enabled().is_empty());
    }

    #[test]
    fn without_a_file_the_choice_stays_in_memory() {
        let mut groups = ScopeGroups::default();
        groups.set(ScopeGroup::Ads, true).unwrap();
        assert_eq!(groups.enabled(), &BTreeSet::from([ScopeGroup::Ads]));
    }
}
