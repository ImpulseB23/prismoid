//! Moves the webview's localStorage from `http://tauri.localhost` to
//! `https://tauri.localhost`. Windows keeps storage per origin, so when the
//! windows switched to https the saved settings stayed behind on the old
//! one. On the first launch that finds them there, a hidden window opens on
//! the old origin and hands its entries over; the main window writes them
//! before it renders, and only then does the old origin clear its copy.
//! Clearing it, rather than only marking the move done, is what keeps a
//! later "reset all data" (which deletes the marker with the rest of the
//! data dir) from bringing the old settings back.

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::timeout;

pub mod commands;

/// The hidden window on the old origin.
pub const LABEL: &str = "storage-move";
/// In the app data dir once the old origin has nothing left to hand over.
const MARKER: &str = "storage-moved";
/// How long either side waits for the other before giving up until the
/// next launch.
const WAIT: Duration = Duration::from_secs(15);

type Entries = Vec<(String, String)>;

pub struct StorageMove {
    exported: watch::Sender<Option<Entries>>,
    imported: watch::Sender<bool>,
}

impl Default for StorageMove {
    fn default() -> Self {
        Self {
            exported: watch::Sender::new(None),
            imported: watch::Sender::new(false),
        }
    }
}

impl StorageMove {
    /// The old origin's entries, once its window has sent them.
    async fn take(&self, wait: Duration) -> Option<Entries> {
        let mut rx = self.exported.subscribe();
        let sent = timeout(wait, rx.wait_for(Option::is_some))
            .await
            .ok()?
            .ok()?;
        sent.clone()
    }

    /// Hands the entries to the main window; true once it has written them.
    async fn hand_over(&self, entries: Entries, wait: Duration) -> bool {
        let mut rx = self.imported.subscribe();
        self.exported.send_replace(Some(entries));
        let done = timeout(wait, rx.wait_for(|done| *done)).await;
        matches!(done, Ok(Ok(_)))
    }
}

/// What the move touches outside the webview; `commands` has the real one.
trait Host {
    fn data_dir(&self) -> Result<PathBuf, String>;
    fn dev(&self) -> bool;
    fn close_window(&self);
}

/// True when a move may still be needed. The dev server serves every window
/// from the same `http://localhost` origin, so there is nothing to move.
fn pending(host: &impl Host) -> bool {
    !host.dev() && host.data_dir().is_ok_and(|dir| !dir.join(MARKER).exists())
}

async fn import_on(host: &impl Host, state: &StorageMove) -> Result<Option<Entries>, String> {
    if !pending(host) {
        return Ok(None);
    }
    match state.take(WAIT).await {
        Some(entries) => Ok(Some(entries)),
        None => {
            host.close_window();
            Err("old storage never arrived".into())
        }
    }
}

fn finish_on(host: &impl Host, cleared: bool) -> Result<(), String> {
    let marked = if cleared {
        host.data_dir().and_then(|dir| {
            std::fs::create_dir_all(&dir)
                .and_then(|()| std::fs::write(dir.join(MARKER), b""))
                .map_err(|e| e.to_string())
        })
    } else {
        Ok(())
    };
    host.close_window();
    marked
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::Arc;

    use super::*;

    fn entries() -> Entries {
        vec![("prismoid.settings".into(), "{}".into())]
    }

    struct FakeHost {
        dir: tempfile::TempDir,
        dev: bool,
        closed: Cell<bool>,
    }

    impl FakeHost {
        fn new(dev: bool) -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
                dev,
                closed: Cell::new(false),
            }
        }
    }

    impl Host for FakeHost {
        fn data_dir(&self) -> Result<PathBuf, String> {
            Ok(self.dir.path().join("app"))
        }

        fn dev(&self) -> bool {
            self.dev
        }

        fn close_window(&self) {
            self.closed.set(true);
        }
    }

    #[tokio::test]
    async fn moves_once_and_never_in_dev() {
        let host = FakeHost::new(false);
        let moving = StorageMove::default();
        moving.exported.send_replace(Some(entries()));
        assert_eq!(import_on(&host, &moving).await, Ok(Some(entries())));

        finish_on(&host, true).unwrap();
        assert!(host.closed.get());
        assert_eq!(import_on(&host, &moving).await, Ok(None));

        assert_eq!(import_on(&FakeHost::new(true), &moving).await, Ok(None));
    }

    #[test]
    fn stays_pending_when_the_old_copy_was_kept() {
        let host = FakeHost::new(false);
        finish_on(&host, false).unwrap();
        assert!(host.closed.get());
        assert!(pending(&host));
    }

    #[tokio::test(start_paused = true)]
    async fn closes_the_hidden_window_when_nothing_arrives() {
        let host = FakeHost::new(false);
        assert!(import_on(&host, &StorageMove::default()).await.is_err());
        assert!(host.closed.get());
    }

    #[tokio::test]
    async fn hands_entries_over_whichever_side_comes_first() {
        let moving = Arc::new(StorageMove::default());
        let main = tokio::spawn({
            let moving = moving.clone();
            async move {
                let taken = moving.take(WAIT).await;
                moving.imported.send_replace(true);
                taken
            }
        });
        assert!(moving.hand_over(entries(), WAIT).await);
        assert_eq!(main.await.unwrap(), Some(entries()));

        let late = StorageMove::default();
        late.exported.send_replace(Some(entries()));
        assert_eq!(late.take(WAIT).await, Some(entries()));
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_when_the_other_side_never_answers() {
        let moving = StorageMove::default();
        assert_eq!(moving.take(WAIT).await, None);
        assert!(!moving.hand_over(entries(), WAIT).await);
    }
}
