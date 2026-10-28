//! The stream manager as its own window, so a streamer can keep it on a
//! second monitor next to OBS. There is at most one: opening it again
//! brings the existing window forward. It starts hidden and shows once its
//! page has painted (`stream_manager_ready`), and the window-state plugin
//! puts it back where it was last time.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "stream-manager";
const WIDTH: f64 = 1040.0;
const HEIGHT: f64 = 700.0;
const MIN_WIDTH: f64 = 760.0;
const MIN_HEIGHT: f64 = 520.0;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StreamManagerWindowError {
    /// `not_stream_manager` when another window calls a stream-manager-only
    /// command, `window` when the OS refused a window operation.
    pub kind: &'static str,
    pub message: String,
}

impl StreamManagerWindowError {
    fn not_stream_manager(label: &str) -> Self {
        Self {
            kind: "not_stream_manager",
            message: format!("{label} is not the stream manager"),
        }
    }

    fn window(err: impl std::fmt::Display) -> Self {
        Self {
            kind: "window",
            message: err.to_string(),
        }
    }
}

/// The window operations `open_on` needs, so the logic runs against a fake
/// in tests.
trait Host {
    fn exists(&self) -> bool;
    fn bring_forward(&self) -> Result<(), String>;
    fn create(&self) -> Result<(), String>;
}

struct Tauri<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> Host for Tauri<'_, R> {
    fn exists(&self) -> bool {
        self.0.get_webview_window(LABEL).is_some()
    }

    fn bring_forward(&self) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window(LABEL)
            .ok_or_else(|| format!("no window {LABEL}"))?;
        bring_forward(&window).map_err(|e| e.to_string())
    }

    fn create(&self) -> Result<(), String> {
        let builder =
            WebviewWindowBuilder::new(self.0, LABEL, WebviewUrl::App("index.html".into()))
                .title("Stream manager")
                .inner_size(WIDTH, HEIGHT)
                .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
                .visible(false);
        // Same chrome as the main window: the page draws its own title bar
        // on Windows.
        #[cfg(windows)]
        let builder = builder.decorations(false);
        builder.build().map(|_| ()).map_err(|e| e.to_string())
    }
}

fn open_on(host: &impl Host) -> Result<(), StreamManagerWindowError> {
    if host.exists() {
        host.bring_forward()
    } else {
        host.create()
    }
    .map_err(StreamManagerWindowError::window)
}

fn bring_forward<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

/// Opens the stream manager, or brings it forward when it is already open.
/// Async on purpose: building a webview from a sync command deadlocks on
/// Windows (see `WebviewWindowBuilder::new`).
#[tauri::command]
pub async fn stream_manager_open<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), StreamManagerWindowError> {
    open_on(&Tauri(&app))
}

/// Called by the stream manager page once it has painted, so the window
/// never shows blank.
#[tauri::command]
pub fn stream_manager_ready<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<(), StreamManagerWindowError> {
    if window.label() != LABEL {
        return Err(StreamManagerWindowError::not_stream_manager(window.label()));
    }
    bring_forward(&window).map_err(StreamManagerWindowError::window)
}

/// Closes the stream manager with the main window, like the user cards.
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        open: bool,
        fails: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Host for Fake {
        fn exists(&self) -> bool {
            self.open
        }

        fn bring_forward(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("forward");
            if self.fails {
                Err("show failed".into())
            } else {
                Ok(())
            }
        }

        fn create(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("create");
            if self.fails {
                Err("build failed".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn reuses_the_open_window() {
        let host = Fake {
            open: true,
            ..Fake::default()
        };
        open_on(&host).unwrap();
        assert_eq!(*host.calls.borrow(), ["forward"]);
    }

    #[test]
    fn creates_when_closed() {
        let host = Fake::default();
        open_on(&host).unwrap();
        assert_eq!(*host.calls.borrow(), ["create"]);
    }

    #[test]
    fn failures_surface_as_window_errors() {
        let host = Fake {
            fails: true,
            ..Fake::default()
        };
        assert_eq!(
            open_on(&host).unwrap_err(),
            StreamManagerWindowError::window("build failed")
        );
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        let err = StreamManagerWindowError::not_stream_manager("main");
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            serde_json::json!({
                "kind": "not_stream_manager",
                "message": "main is not the stream manager"
            })
        );
    }
}
