//! The Tauri side of user cards: the commands the card windows call, the
//! real window [`Host`], and the focus events that close a card. Thin
//! adapters over the logic in `mod.rs`, which is unit-tested there; they
//! need a Tauri runtime and real windows, so they are excluded from
//! coverage in `codecov.yml`.

use tauri::{
    AppHandle, Emitter, EventTarget, LogicalSize, Manager, PhysicalPosition, Runtime, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use super::{
    logical_size, open_on, Area, CardUser, Host, Point, UserCardError, UserCards, SHOW_EVENT,
};

#[tauri::command]
pub async fn user_card_open<R: Runtime>(
    app: AppHandle<R>,
    cards: State<'_, UserCards>,
    user: CardUser,
    zoom: f64,
) -> Result<(), UserCardError> {
    open_on(&App(app), &cards, user, zoom).await
}

/// The user of the card that calls this.
#[tauri::command]
pub fn user_card_current<R: Runtime>(
    window: WebviewWindow<R>,
    cards: State<'_, UserCards>,
) -> Option<CardUser> {
    cards.lock().user(window.label())
}

/// Called by a card once it has rendered, so it never shows blank.
#[tauri::command]
pub fn user_card_ready<R: Runtime>(
    window: WebviewWindow<R>,
    cards: State<'_, UserCards>,
) -> Result<(), UserCardError> {
    if !cards.lock().mark_ready(window.label()) {
        return Err(UserCardError::not_a_card(window.label()));
    }
    bring_forward(&window).map_err(UserCardError::window)
}

#[tauri::command]
pub fn user_card_set_pinned<R: Runtime>(
    window: WebviewWindow<R>,
    cards: State<'_, UserCards>,
    pinned: bool,
) -> Result<(), UserCardError> {
    if cards.lock().set_pinned(window.label(), pinned) {
        Ok(())
    } else {
        Err(UserCardError::not_a_card(window.label()))
    }
}

/// Closes the card that calls this.
#[tauri::command]
pub fn user_card_close<R: Runtime>(
    window: WebviewWindow<R>,
    cards: State<'_, UserCards>,
) -> Result<(), UserCardError> {
    if !cards.lock().forget(window.label()) {
        return Err(UserCardError::not_a_card(window.label()));
    }
    window.destroy().map_err(UserCardError::window)
}

/// Closes the unpinned card when the user comes back to the main window.
pub fn main_focused<R: Runtime>(app: &AppHandle<R>) {
    let labels = app.state::<UserCards>().lock().app_focused();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

/// Closes every card; the main window going away takes them with it.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    let labels = app.state::<UserCards>().lock().drain();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

/// Whether the main window is pinned on top. A card has to be too, or it
/// opens hidden behind the window it was opened from.
fn main_on_top<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_always_on_top().ok())
        .unwrap_or(false)
}

fn bring_forward<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

fn on_card_event<R: Runtime>(app: &AppHandle<R>, label: &str, event: &WindowEvent) {
    let cards = app.state::<UserCards>();
    match event {
        WindowEvent::Focused(true) => cards.lock().focused(label),
        WindowEvent::Focused(false) => {
            let Some(window) = app.get_webview_window(label) else {
                return;
            };
            let to_app = focus_went_to_app(&window);
            if cards.lock().blurred(label, to_app) {
                let _ = window.destroy();
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            cards.lock().forget(label);
        }
        _ => {}
    }
}

/// Whether the window now in front is another of Prismoid's. The card
/// itself counts as no: its webview loses focus to its own frame while it
/// is dragged.
#[cfg(windows)]
fn focus_went_to_app<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: both only read; the pid is written to a local.
    let (foreground, pid) = unsafe {
        let foreground = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut pid));
        (foreground, pid)
    };
    let is_card = window.hwnd().is_ok_and(|hwnd| hwnd.0 == foreground.0);
    !is_card && pid == std::process::id()
}

#[cfg(not(windows))]
fn focus_went_to_app<R: Runtime>(_window: &WebviewWindow<R>) -> bool {
    true
}

struct App<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Host for App<R> {
    fn cursor(&self) -> Result<Point, String> {
        let p = self.0.cursor_position().map_err(|e| e.to_string())?;
        Ok(Point {
            x: p.x.round() as i32,
            y: p.y.round() as i32,
        })
    }

    fn work_area(&self, at: Point) -> Option<(Area, f64)> {
        let monitor = self
            .0
            .monitor_from_point(f64::from(at.x), f64::from(at.y))
            .ok()??;
        let work = monitor.work_area();
        let area = Area {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        };
        Some((area, monitor.scale_factor()))
    }

    fn main_on_top(&self) -> bool {
        main_on_top(&self.0)
    }

    fn create(
        &self,
        label: &str,
        at: Point,
        user: &CardUser,
        zoom: f64,
        on_top: bool,
    ) -> Result<(), String> {
        let (width, height) = logical_size(zoom);
        let builder =
            WebviewWindowBuilder::new(&self.0, label, WebviewUrl::App("index.html".into()))
                .title(&user.display_name)
                .inner_size(width, height)
                .always_on_top(on_top)
                // A fixed size that follows the zoom, so the card always looks
                // the same.
                .resizable(false)
                // The main window's origin, so both share localStorage.
                .use_https_scheme(true)
                .additional_browser_args(crate::browser_args::BROWSER_ARGS)
                .visible(false);
        // Same chrome as the main window: the card draws its own title bar
        // on Windows.
        #[cfg(windows)]
        let builder = builder.decorations(false);
        let window = builder.build().map_err(|e| e.to_string())?;
        let app = self.0.clone();
        let owned = label.to_owned();
        window.on_window_event(move |event| on_card_event(&app, &owned, event));
        window
            .set_position(PhysicalPosition::new(at.x, at.y))
            .map_err(|e| e.to_string())
    }

    fn reuse(
        &self,
        label: &str,
        at: Point,
        user: &CardUser,
        zoom: f64,
        showing: bool,
        on_top: bool,
    ) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window(label)
            .ok_or_else(|| format!("no window {label}"))?;
        let (width, height) = logical_size(zoom);
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(at.x, at.y))
            .map_err(|e| e.to_string())?;
        window
            .set_title(&user.display_name)
            .map_err(|e| e.to_string())?;
        window
            .set_always_on_top(on_top)
            .map_err(|e| e.to_string())?;
        self.0
            .emit_to(EventTarget::webview_window(label), SHOW_EVENT, user)
            .map_err(|e| e.to_string())?;
        if showing {
            bring_forward(&window).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
