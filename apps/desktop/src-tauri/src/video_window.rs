//! Pop-out stream players: one window per channel, labelled by its login,
//! that the user can resize, move to another display and fullscreen. The
//! window loads the app's own page, which shows Twitch's embedded player
//! and nothing else; its capability allows logging and fullscreen only.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const LABEL_PREFIX: &str = "video-";

/// Twitch logins are 1 to 25 lowercase letters, digits and underscores,
/// which are also safe in a window label.
fn label_for(login: &str) -> Option<String> {
    let valid = (1..=25).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    valid.then(|| format!("{LABEL_PREFIX}{login}"))
}

/// Opens `login`'s player, or brings its open one forward.
#[tauri::command]
pub fn video_window_open<R: Runtime>(
    app: AppHandle<R>,
    login: String,
    title: String,
) -> Result<(), String> {
    let label = label_for(&login).ok_or("not a twitch login")?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(960.0, 540.0)
        .min_inner_size(400.0, 300.0)
        // Twitch only lets its player run under an https parent.
        .use_https_scheme(true)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_only_real_logins() {
        assert_eq!(label_for("caedrel").as_deref(), Some("video-caedrel"));
        assert_eq!(label_for("a_b_9").as_deref(), Some("video-a_b_9"));
        for bad in ["", "Caps", "has space", "../x", "a".repeat(26).as_str()] {
            assert_eq!(label_for(bad), None, "{bad}");
        }
    }
}
