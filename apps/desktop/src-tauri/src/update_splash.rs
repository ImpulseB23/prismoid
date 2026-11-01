//! The small window that covers an update. The Tauri updater quits the app
//! the moment it starts the installer, and the installer runs hidden, so the
//! seconds until the new version opens would show nothing. Right before the
//! install the app copies its own exe out of the install folder, which the
//! installer is about to replace, and starts the copy in splash mode: one
//! small window with the update screen and nothing else. The new version
//! signals a named event once its window is up and the splash closes.
//!
//! An install can also fail, quietly: the installer runs without a window
//! and gives up when a file it must replace is held. The splash then waits
//! for the installer itself to finish and, when no new version checks in,
//! says so and reopens whichever version is installed, so the app never
//! just disappears.

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
/// How long the old version gets to quit after starting the installer.
#[cfg(windows)]
const QUIT_WAIT: Duration = Duration::from_secs(30);
/// Longest an install may run before the splash stops waiting on it.
#[cfg(windows)]
const INSTALL_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long the new version gets to open once the installer is done.
#[cfg(windows)]
const START_WAIT: Duration = Duration::from_secs(30);

/// Holds the exe copy and the splash's own WebView2 data, kept apart from
/// the app's so the new version never shares a browser process with it.
#[cfg(windows)]
fn dir() -> PathBuf {
    std::env::temp_dir().join("prismoid-update")
}

/// What the old version hands the splash: the palette, its own process id
/// (the installer is its child) and its exe, to reopen after a failure.
#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
pub struct Splash {
    palette: &'static str,
    parent: u32,
    app: PathBuf,
}

/// The splash's arguments when they start splash mode.
#[cfg(windows)]
pub fn parse(args: impl IntoIterator<Item = String>) -> Option<Splash> {
    let mut args = args.into_iter().skip_while(|a| a != ARG);
    args.next()?;
    let palette = match args.next()?.as_str() {
        "light" => "light",
        _ => "dark",
    };
    let parent = args.next()?.parse().ok()?;
    let app = PathBuf::from(args.next()?);
    Some(Splash {
        palette,
        parent,
        app,
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
    let app = std::env::current_exe()?;
    std::fs::copy(&app, &exe)?;
    Command::new(&exe)
        .args([ARG, palette, &std::process::id().to_string()])
        .arg(&app)
        .creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

/// Runs the splash until the new version is up, or until it is clear the
/// install failed and the installed version has been reopened.
#[cfg(windows)]
pub fn run(mut context: tauri::Context, splash: Splash) {
    use tauri::webview::PageLoadEvent;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    // The config's main window would otherwise open and boot the whole app.
    context.config_mut().app.windows.clear();
    // Created before anything else: the installer takes seconds, so the
    // event exists long before the new version looks for it.
    let done = match Handle::event() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("update splash event: {e}");
            return;
        }
    };
    let url = format!("index.html?palette={}", splash.palette);
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
                if !installed(&done, splash.parent) {
                    if let Some(window) = app.get_webview_window(LABEL) {
                        let _ = window.eval("location.hash = 'failed'");
                    }
                    if let Err(e) = reopen(&splash.app) {
                        eprintln!("reopen {}: {e}", splash.app.display());
                    }
                    // Long enough to read before the app is back.
                    std::thread::sleep(Duration::from_secs(3));
                }
                app.exit(0);
            });
            Ok(())
        })
        .run(context)
        .expect("failed to run the update splash");
}

/// Follows the update to its end: true once the new version checks in,
/// false once the installer has finished and it still has not.
#[cfg(windows)]
fn installed(done: &Handle, parent: u32) -> bool {
    if let Some(old) = Handle::process(parent) {
        if done.wait_or(Some(&old), QUIT_WAIT) {
            return true;
        }
    }
    if let Some(installer) = installer_of(parent) {
        if done.wait_or(Some(&installer), INSTALL_WAIT) {
            return true;
        }
    }
    done.wait_or(None, START_WAIT)
}

/// The installer the old version started: its child, other than this
/// splash, and started after it. The old version is gone by now, so the
/// start time rules out an unrelated process that reused its id.
#[cfg(windows)]
fn installer_of(parent: u32) -> Option<Handle> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    let me = std::process::id();
    // SAFETY: the pseudo handle needs no closing.
    let since = started(unsafe { GetCurrentProcess() })?;
    // SAFETY: the snapshot is walked with a correctly sized entry and closed
    // when its wrapper drops.
    unsafe {
        let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?);
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut more = Process32FirstW(snapshot.0, &mut entry).is_ok();
        while more {
            if entry.th32ParentProcessID == parent && entry.th32ProcessID != me {
                if let Some(child) = Handle::process(entry.th32ProcessID) {
                    if started(child.0).is_some_and(|t| t >= since) {
                        return Some(child);
                    }
                }
            }
            more = Process32NextW(snapshot.0, &mut entry).is_ok();
        }
    }
    None
}

#[cfg(windows)]
fn started(process: windows::Win32::Foundation::HANDLE) -> Option<u64> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetProcessTimes;
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: the handle carries query rights and the out params are live.
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
    Some(u64::from(created.dwHighDateTime) << 32 | u64::from(created.dwLowDateTime))
}

#[cfg(windows)]
fn reopen(app: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

    Command::new(app)
        .creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

/// Tells a waiting splash the new version is up, then clears out its files
/// once it has gone.
#[cfg(windows)]
pub fn release() {
    Handle::signal();
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
struct Handle(windows::Win32::Foundation::HANDLE);

// Each handle is only used from the one thread it is moved to.
#[cfg(windows)]
unsafe impl Send for Handle {}

#[cfg(windows)]
impl Handle {
    fn event() -> windows::core::Result<Self> {
        use windows::core::HSTRING;
        use windows::Win32::System::Threading::CreateEventW;
        // SAFETY: a named manual-reset event with default security; the
        // handle is closed in Drop.
        unsafe { CreateEventW(None, true, false, &HSTRING::from(EVENT)) }.map(Self)
    }

    /// A process to wait on and read the start time of; None once it is gone.
    fn process(pid: u32) -> Option<Self> {
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        // SAFETY: the handle is closed in Drop.
        unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .ok()
        .map(Self)
    }

    /// Waits on this event; true once it is set, false when `other` ends
    /// or `timeout` passes first.
    fn wait_or(&self, other: Option<&Handle>, timeout: Duration) -> bool {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::WaitForMultipleObjects;
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        let handles: Vec<_> = std::iter::once(self.0).chain(other.map(|h| h.0)).collect();
        // SAFETY: every handle is live for as long as its owner is.
        unsafe { WaitForMultipleObjects(&handles, false, ms) == WAIT_OBJECT_0 }
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
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: each wrapped handle is owned and closed once.
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
    fn splash_mode_comes_from_the_args() {
        assert_eq!(parse(args(&["prismoid.exe"])), None);
        assert_eq!(
            parse(args(&[
                "x",
                ARG,
                "light",
                "42",
                r"C:\Prismoid\prismoid.exe"
            ])),
            Some(Splash {
                palette: "light",
                parent: 42,
                app: PathBuf::from(r"C:\Prismoid\prismoid.exe"),
            })
        );
        let odd = parse(args(&["x", ARG, "<script>", "42", "app.exe"])).unwrap();
        assert_eq!(odd.palette, "dark");
        assert_eq!(parse(args(&["x", ARG, "dark", "nope", "app.exe"])), None);
        assert_eq!(parse(args(&["x", ARG, "dark", "42"])), None);
    }

    #[test]
    fn a_waiting_splash_wakes_when_signalled() {
        let event = Handle::event().unwrap();
        let waiter = std::thread::spawn(move || event.wait_or(None, Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(50));
        Handle::signal();
        assert!(waiter.join().unwrap());
    }

    #[test]
    fn finds_the_installer_and_stops_waiting_when_it_ends() {
        use windows::core::PCWSTR;
        use windows::Win32::System::Threading::CreateEventW;

        // A child of this test process that ends on its own, standing in
        // for the installer the old version starts.
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping -n 2 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        let installer = installer_of(std::process::id()).expect("child found");
        // An unnamed event nobody sets, so only the child ending stops it.
        let event = Handle(unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.unwrap());
        assert!(!event.wait_or(Some(&installer), Duration::from_secs(20)));
        child.wait().unwrap();
    }
}
