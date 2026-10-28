//! Log file for bug reports. The host logs through `tracing` with its `log`
//! feature and no subscriber installed, so every event lands on the `log`
//! facade that the log plugin owns; the webview forwards its warnings and
//! errors through the same plugin. One file under the OS log directory
//! holds both sides.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_opener::OpenerExt;

/// Rotation point. A few rotated files stay behind so a report filed after
/// a restart still has the run that went wrong.
const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
const KEEP_FILES: usize = 3;
/// Log bytes in a support bundle, small enough to paste into an issue.
const BUNDLE_LOG_BYTES: u64 = 200 * 1024;

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("prismoid", log::LevelFilter::Debug)
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_FILES))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: None }));
    // Release builds run without a console on Windows, so only dev builds
    // mirror the file to the terminal.
    #[cfg(debug_assertions)]
    let builder = builder.target(Target::new(TargetKind::Stdout));
    builder.build()
}

#[tauri::command]
pub fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Version and platform details followed by the newest log lines, redacted,
/// as one block of text for a bug report.
#[tauri::command]
pub async fn support_bundle<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let info = app.package_info();
    let header = header(
        &info.version.to_string(),
        &os_info::get().to_string(),
        tauri::webview_version().ok(),
    );
    // The plugin names its file after the product name.
    let stem = info.name.clone();
    tauri::async_runtime::spawn_blocking(move || bundle(&header, &dir, &stem))
        .await
        .map_err(|e| e.to_string())
}

fn header(version: &str, os: &str, webview: Option<String>) -> String {
    format!(
        "Prismoid {version}\nOS: {os}\nArch: {}\nWebView2: {}\n",
        std::env::consts::ARCH,
        webview.as_deref().unwrap_or("unknown"),
    )
}

fn bundle(header: &str, dir: &Path, stem: &str) -> String {
    let tail = read_tail(&log_files(dir, stem), BUNDLE_LOG_BYTES);
    redact(&format!("{header}\n{tail}"))
}

/// The plugin's files for `stem`, oldest first: rotated copies named
/// `{stem}_{YYYY-MM-DD_HH-MM-SS}.log`, then the active `{stem}.log`.
fn log_files(dir: &Path, stem: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let active = format!("{stem}.log");
    let mut rotated = Vec::new();
    let mut current = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == active {
            current = Some(entry.path());
        } else if let Some(date) = name
            .strip_prefix(stem)
            .and_then(|rest| rest.strip_prefix('_'))
            .and_then(|rest| rest.strip_suffix(".log"))
        {
            rotated.push((date.to_owned(), entry.path()));
        }
    }
    // The date format sorts lexically, the same order the plugin prunes by.
    rotated.sort();
    rotated
        .into_iter()
        .map(|(_, path)| path)
        .chain(current)
        .collect()
}

/// The last `budget` bytes across `files`, newest last, each file under a
/// name line. A file cut short starts at its next whole line.
fn read_tail(files: &[PathBuf], budget: u64) -> String {
    let mut remaining = budget;
    let mut parts = Vec::new();
    for path in files.iter().rev() {
        if remaining == 0 {
            break;
        }
        // Files the plugin rotates or prunes mid-read are skipped. std opens
        // with delete sharing on Windows, so holding one open here never
        // blocks the plugin's rename.
        let Ok(chunk) = tail_of(path, remaining) else {
            continue;
        };
        remaining -= chunk.len as u64;
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        parts.push(format!("--- {name} ---\n{}", chunk.text));
    }
    parts.reverse();
    parts.join("\n")
}

struct Chunk {
    text: String,
    len: usize,
}

fn tail_of(path: &Path, max: u64) -> std::io::Result<Chunk> {
    let mut file = File::open(path)?;
    // The writer keeps appending; reading up to the length seen at open
    // keeps the chunk inside the budget.
    let len = file.metadata()?.len();
    let take = len.min(max);
    file.seek(SeekFrom::Start(len - take))?;
    let mut bytes = Vec::new();
    file.take(take).read_to_end(&mut bytes)?;
    let read = bytes.len();
    if take < len {
        let start = bytes
            .iter()
            .position(|&b| b == b'\n')
            .map_or(read, |i| i + 1);
        bytes.drain(..start);
    }
    Ok(Chunk {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        len: read,
    })
}

const REDACTED: &str = "[redacted]";

/// Credentials that could reach the log through an error message or a
/// forwarded webview error: Authorization headers, bearer and IRC tokens,
/// and OAuth parameters in URLs, form bodies and JSON.
static SECRETS: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    let value = r#"[^\["'&\s,;}\]][^"'&\s,;}\]]*"#;
    [
        (
            r#"(?i)(\bauthorization["']?\s*[:=]\s*\[?["']?)[^\["'\r\n,}\]][^"'\r\n,}\]]*"#
                .to_owned(),
            format!("${{1}}{REDACTED}"),
        ),
        (
            r"(?i)\b(bearer|oauth)\s+[A-Za-z0-9\-._~+/]{16,}=*".to_owned(),
            format!("${{1}} {REDACTED}"),
        ),
        (
            r"(?i)\boauth:[A-Za-z0-9]+".to_owned(),
            format!("oauth:{REDACTED}"),
        ),
        (
            format!(
                r#"(?i)(\b(?:access_token|refresh_token|id_token|client_secret|code_verifier)["']?\s*[:=]\s*["']?){value}"#
            ),
            format!("${{1}}{REDACTED}"),
        ),
        (
            format!(r"(?i)([?&#](?:code|token)=){value}"),
            format!("${{1}}{REDACTED}"),
        ),
        (
            r#"(?i)("token"\s*:\s*")[^"]+"#.to_owned(),
            format!("${{1}}{REDACTED}"),
        ),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(&pattern).expect("valid pattern"), replacement))
    .collect()
});

fn redact(text: &str) -> String {
    SECRETS
        .iter()
        .fold(text.to_owned(), |out, (re, replacement)| {
            re.replace_all(&out, replacement.as_str()).into_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_authorization_headers() {
        assert_eq!(
            redact("request failed Authorization: Bearer abcdef0123456789abcdef"),
            "request failed Authorization: [redacted]"
        );
        assert_eq!(
            redact(r#"{"Authorization":"OAuth 0123456789abcdefghij","x":1}"#),
            r#"{"Authorization":"[redacted]","x":1}"#
        );
        assert_eq!(
            redact("md=map[authorization:[Bearer ya29.a0AfB_byC-xyz]]"),
            "md=map[authorization:[[redacted]]]"
        );
    }

    #[test]
    fn redacts_bare_bearer_and_irc_tokens() {
        assert_eq!(
            redact("sent Bearer ya29.a0AfB_byC-0123456789xyz to helix"),
            "sent Bearer [redacted] to helix"
        );
        assert_eq!(
            redact("PASS oauth:abcdefghij0123456789"),
            "PASS oauth:[redacted]"
        );
    }

    #[test]
    fn redacts_oauth_parameters() {
        assert_eq!(
            redact("open prismoid://auth/twitch#access_token=abc123&scope=chat%3Aread&state=s1"),
            "open prismoid://auth/twitch#access_token=[redacted]&scope=chat%3Aread&state=s1"
        );
        assert_eq!(
            redact("GET /callback?state=s1&code=4/0AeanS0b-xyz HTTP/1.1"),
            "GET /callback?state=s1&code=[redacted] HTTP/1.1"
        );
        assert_eq!(
            redact("body grant_type=refresh_token&refresh_token=1//0g-abc&client_secret=GOCSPX-x"),
            "body grant_type=refresh_token&refresh_token=[redacted]&client_secret=[redacted]"
        );
        assert_eq!(
            redact(r#"{"access_token":"ya29.x","expires_in":3599,"id_token":"eyJ.a.b"}"#),
            r#"{"access_token":"[redacted]","expires_in":3599,"id_token":"[redacted]"}"#
        );
        assert_eq!(
            redact(r#"{"cmd":"token_refresh","token":"abc123"}"#),
            r#"{"cmd":"token_refresh","token":"[redacted]"}"#
        );
    }

    #[test]
    fn leaves_ordinary_lines_alone() {
        let lines = [
            "[2026-10-27][06:38:50][INFO][prismoid_lib::sidecar_supervisor] proactive token refresh sent to sidecar",
            "[WARN][prismoid_lib::sidecar_supervisor] sidecar terminated code=Some(1) attempt=2",
            "twitch oauth failed: user denied",
            "already [redacted] stays as is: access_token=[redacted]",
        ];
        for line in lines {
            assert_eq!(redact(line), line);
        }
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn finds_rotated_files_oldest_first_and_active_last() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Prismoid.log", "");
        write(dir.path(), "Prismoid_2026-10-27_08-00-00.log", "");
        write(dir.path(), "Prismoid_2026-10-26_23-59-59.log", "");
        write(dir.path(), "Prismoid_2026-10-27_08-00-00.log.bak", "");
        write(dir.path(), "Other.log", "");
        let names: Vec<_> = log_files(dir.path(), "Prismoid")
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "Prismoid_2026-10-26_23-59-59.log",
                "Prismoid_2026-10-27_08-00-00.log",
                "Prismoid.log"
            ]
        );
    }

    #[test]
    fn header_names_version_platform_and_webview() {
        let arch = std::env::consts::ARCH;
        assert_eq!(
            header("0.6.0", "Windows 11", Some("130.0.2849.80".into())),
            format!("Prismoid 0.6.0\nOS: Windows 11\nArch: {arch}\nWebView2: 130.0.2849.80\n")
        );
        assert!(header("0.6.0", "Windows 11", None).ends_with("WebView2: unknown\n"));
    }

    #[test]
    fn bundle_is_header_then_redacted_tail() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "Prismoid.log",
            "[INFO] joined\n[ERROR] webview: open prismoid://auth/twitch#access_token=abc123\n",
        );
        assert_eq!(
            bundle("Prismoid 0.6.0\n", dir.path(), "Prismoid"),
            "Prismoid 0.6.0\n\n--- Prismoid.log ---\n[INFO] joined\n\
             [ERROR] webview: open prismoid://auth/twitch#access_token=[redacted]\n"
        );
        assert_eq!(
            bundle("Prismoid 0.6.0\n", &dir.path().join("none"), "Prismoid"),
            "Prismoid 0.6.0\n\n"
        );
    }

    #[test]
    fn tail_skips_a_file_rotated_away_mid_read() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Prismoid.log", "new 1\n");
        let files = [
            dir.path().join("Prismoid_2026-10-27_08-00-00.log"),
            dir.path().join("Prismoid.log"),
        ];
        assert_eq!(read_tail(&files, 1024), "--- Prismoid.log ---\nnew 1\n");
    }

    #[test]
    fn missing_log_dir_gives_no_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(log_files(&dir.path().join("logs"), "Prismoid").is_empty());
    }

    #[test]
    fn tail_spans_files_newest_last() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "Prismoid_2026-10-27_08-00-00.log",
            "old 1\nold 2\n",
        );
        write(dir.path(), "Prismoid.log", "new 1\nnew 2\n");
        let files = log_files(dir.path(), "Prismoid");
        assert_eq!(
            read_tail(&files, 1024),
            "--- Prismoid_2026-10-27_08-00-00.log ---\nold 1\nold 2\n\n--- Prismoid.log ---\nnew 1\nnew 2\n"
        );
    }

    #[test]
    fn tail_stops_at_the_budget_on_a_line_boundary() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "Prismoid_2026-10-27_08-00-00.log",
            "old 1\nold 2\n",
        );
        write(dir.path(), "Prismoid.log", "new 1\nnew 2\n");
        let files = log_files(dir.path(), "Prismoid");

        // The active file fits and the rest of the budget lands mid-line in
        // the rotated one, which then starts at its next whole line.
        let tail = read_tail(&files, 12 + 8);
        assert_eq!(
            tail,
            "--- Prismoid_2026-10-27_08-00-00.log ---\nold 2\n\n--- Prismoid.log ---\nnew 1\nnew 2\n"
        );

        assert_eq!(read_tail(&files, 9), "--- Prismoid.log ---\nnew 2\n");
        assert_eq!(read_tail(&files, 0), "");
    }

    #[test]
    fn tail_reads_at_most_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let line = "x".repeat(99) + "\n";
        write(dir.path(), "Prismoid.log", &line.repeat(50));
        let files = log_files(dir.path(), "Prismoid");
        let tail = read_tail(&files, 1000);
        let body = tail.strip_prefix("--- Prismoid.log ---\n").unwrap();
        assert!(body.len() <= 1000);
        assert_eq!(body, line.repeat(9));
    }
}
