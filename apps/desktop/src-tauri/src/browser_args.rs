//! WebView2 switches every window starts with. All windows share one
//! WebView2 environment, which only works when their switches match, so
//! windows built in code use this and the main window's config repeats it.
//! Setting any switches replaces wry's defaults, so those come first.

/// wry's defaults, then autoplay with sound without a click first, so a
/// stream starts when its preview or pop-out opens, as in other desktop apps.
pub const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_config_matches() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["windows"][0]["additionalBrowserArgs"],
            BROWSER_ARGS
        );
    }
}
