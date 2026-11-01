//! The small window that covers an update. The Tauri updater quits the app
//! the moment it starts the installer, and the installer runs hidden, so the
//! seconds until the new version opens would show nothing. Right before the
//! install the app copies its own exe out of the install folder, which the
//! installer is about to replace, and starts the copy in splash mode: one
//! small window with the update screen and nothing else. The new version
//! signals a named event once its window is up and the splash closes.

#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::Duration;

/// Starts the exe in splash mode; the palette follows it.
#[cfg(windows)]
const ARG: &str = "--update-splash";
/// The splash window, which the frontend renders as the update screen.
#[cfg(windows)]
const LABEL: &str = "update-splash";
#[cfg(windows)]
const EVENT: &str = "Local\\org.prismoid.app.update-splash";
/// A failed install never opens the new version, so the splash leaves on
/// its own after this.
#[cfg(windows)]
const GIVE_UP: Duration = Duration::from_secs(90);

/// Holds the exe copy and the splash's own WebView2 data, kept apart from
/// the app's so the new version never shares a browser process with it.
#[cfg(windows)]
fn dir() -> PathBuf {
    std::env::temp_dir().join("prismoid-update")
}

/// `light` or `dark` when the args start splash mode; anything else is dark.
#[cfg(windows)]
pub fn palette(args: impl IntoIterator<Item = String>) -> Option<&'static str> {
    let mut args = args.into_iter().skip_while(|a| a != ARG);
    args.next()?;
    Some(match args.next().as_deref() {
        Some("light") => "light",
        _ => "dark",
    })
}

#[tauri::command]
pub fn update_splash_start(palette: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        start(if palette == "light" { "light" } else { "dark" }).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = palette;
        Ok(())
    }
}

#[cfg(windows)]
fn start(palette: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

    let dir = dir();
    std::fs::create_dir_all(&dir)?;
    let exe = dir.join("prismoid-update.exe");
    std::fs::copy(std::env::current_exe()?, &exe)?;
    Command::new(&exe)
        .args([ARG, palette])
        .creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

/// Runs the splash until the new version is up.
#[cfg(windows)]
pub fn run(mut context: tauri::Context, palette: &str) {
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // The config's main window would otherwise open and boot the whole app.
    context.config_mut().app.windows.clear();
    // Created before anything else: the installer takes seconds, so the
    // event exists long before the new version looks for it.
    let done = match Event::create() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("update splash event: {e}");
            return;
        }
    };
    let url = format!("index.html?palette={palette}");
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(url.into()))
                .title("Updating prismoid")
                .inner_size(340.0, 230.0)
                .resizable(false)
                .maximizable(false)
                .decorations(false)
                .center()
                .visible(false)
                .data_directory(dir().join("webview"))
                // Shown once drawn, so it never flashes an empty frame.
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = window.show();
                    }
                })
                .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                done.wait(GIVE_UP);
                app.exit(0);
            });
            Ok(())
        })
        .run(context)
        .expect("failed to run the update splash");
}

/// Tells a waiting splash the new version is up, then clears out its files
/// once it has gone.
#[cfg(windows)]
pub fn release() {
    Event::signal();
    let dir = dir();
    if !dir.exists() {
        return;
    }
    std::thread::spawn(move || {
        // The exe and WebView2 files stay locked until the splash and its
        // browser processes have exited.
        for _ in 0..30 {
            match std::fs::remove_dir_all(&dir) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    std::thread::sleep(Duration::from_secs(1));
                }
                _ => return,
            }
        }
        tracing::warn!(dir = %dir.display(), "update splash files left behind");
    });
}

#[cfg(windows)]
struct Event(windows::Win32::Foundation::HANDLE);

// The handle is only waited on from the one thread it is moved to.
#[cfg(windows)]
unsafe impl Send for Event {}

#[cfg(windows)]
impl Event {
    fn create() -> windows::core::Result<Self> {
        use windows::core::HSTRING;
        use windows::Win32::System::Threading::CreateEventW;
        // SAFETY: a named manual-reset event with default security; the
        // handle is closed in Drop.
        unsafe { CreateEventW(None, true, false, &HSTRING::from(EVENT)) }.map(Self)
    }

    fn wait(&self, timeout: Duration) {
        use windows::Win32::System::Threading::WaitForSingleObject;
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: the handle is live for as long as `self` is.
        unsafe {
            WaitForSingleObject(self.0, ms);
        }
    }

    /// Sets the event if a splash is waiting on it; no splash, no event.
    fn signal() {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
        // SAFETY: the handle is opened and closed here.
        unsafe {
            if let Ok(event) = OpenEventW(EVENT_MODIFY_STATE, false, &HSTRING::from(EVENT)) {
                let _ = SetEvent(event);
                let _ = CloseHandle(event);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateEventW and is closed once.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn splash_mode_and_palette_come_from_the_args() {
        assert_eq!(palette(args(&["prismoid.exe"])), None);
        assert_eq!(
            palette(args(&["prismoid-update.exe", ARG, "light"])),
            Some("light")
        );
        assert_eq!(palette(args(&["x", ARG, "dark"])), Some("dark"));
        assert_eq!(palette(args(&["x", ARG, "<script>"])), Some("dark"));
        assert_eq!(palette(args(&["x", ARG])), Some("dark"));
    }

    #[test]
    fn a_waiting_splash_wakes_when_signalled() {
        let event = Event::create().unwrap();
        let waiter = std::thread::spawn(move || {
            let started = std::time::Instant::now();
            event.wait(Duration::from_secs(10));
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(50));
        Event::signal();
        assert!(waiter.join().unwrap() < Duration::from_secs(5));
    }
}
