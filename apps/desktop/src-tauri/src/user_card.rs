//! User cards as their own windows, the way Chatterino's user popup works.
//! A card opens at the mouse and closes when it loses focus unless it is
//! pinned; clicking another name reuses the one unpinned card, while pinned
//! cards stay until their X. Each card is a separate webview with no access
//! to the main window's stores, so it asks the host for its user and gets
//! history, emotes and paints through the commands the feed already uses.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalSize, Manager, PhysicalPosition, Runtime, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::message::Badge;

const LABEL_PREFIX: &str = "user-card-";
/// Sent to a reused card with its new user.
const SHOW_EVENT: &str = "user_card_show";
// The card's layout in CSS pixels. The window is that times the app's zoom,
// so it holds the same content at every zoom and text size.
const CONTENT_WIDTH: f64 = 320.0;
const CONTENT_HEIGHT: f64 = 480.0;
/// Bounds on the zoom setting the app sends, against a bad value.
const MIN_ZOOM: f64 = 0.5;
const MAX_ZOOM: f64 = 6.0;
/// The scale Prismoid is drawn for; mirrors `TARGET_UI_SCALE` in
/// src/lib/uiScale.ts.
const TARGET_UI_SCALE: f64 = 1.5;

pub fn is_card(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Mirrors `CardUser` in src/components/UserCard.tsx.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardUser {
    pub channel_id: String,
    pub platform_user_id: String,
    pub username: String,
    pub display_name: String,
    pub color: Option<String>,
    pub badges: Vec<Badge>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UserCardError {
    /// `not_a_card` when the calling window is not an open card, `window`
    /// when the OS refused a window operation.
    pub kind: &'static str,
    pub message: String,
}

impl UserCardError {
    fn not_a_card(label: &str) -> Self {
        Self {
            kind: "not_a_card",
            message: format!("{label} is not an open user card"),
        }
    }

    fn window(err: impl std::fmt::Display) -> Self {
        Self {
            kind: "window",
            message: err.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Point {
    x: i32,
    y: i32,
}

/// A monitor's work area in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Top-left corner for a card of `size` opened at `cursor`: at the cursor,
/// pulled back inside `area` when it would hang off an edge. A card larger
/// than the area sticks to its top-left. Everything is physical pixels.
fn place(cursor: Point, size: (u32, u32), area: Area) -> Point {
    let fit = |pos: i32, len: u32, start: i32, span: u32| {
        let last = i64::from(start) + i64::from(span) - i64::from(len);
        let pos = i64::from(pos).min(last).max(i64::from(start));
        i32::try_from(pos).expect("clamped between two i32 values")
    };
    Point {
        x: fit(cursor.x, size.0, area.x, area.width),
        y: fit(cursor.y, size.1, area.y, area.height),
    }
}

/// The card's outer size on a monitor with this scale factor. Cards are
/// frameless on Windows, so the outer size is the inner one.
fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() {
        zoom.clamp(MIN_ZOOM, MAX_ZOOM)
    } else {
        1.0
    }
}

/// The webview zoom the card ends up with on a monitor with `scale`: the
/// setting on top of what that monitor's own scaling leaves to reach the
/// target, as in `baseZoom` in src/lib/uiScale.ts.
fn effective_zoom(setting: f64, scale: f64) -> f64 {
    setting * (TARGET_UI_SCALE / scale).max(1.0)
}

/// Window size in logical pixels for content drawn at `zoom`.
fn logical_size(zoom: f64) -> (f64, f64) {
    (CONTENT_WIDTH * zoom, CONTENT_HEIGHT * zoom)
}

/// Window size in physical pixels on a monitor with `scale`.
fn card_size(scale: f64, zoom: f64) -> (u32, u32) {
    let (w, h) = logical_size(zoom);
    ((w * scale).round() as u32, (h * scale).round() as u32)
}

struct Card {
    user: CardUser,
    pinned: bool,
    /// The webview has rendered and asked to be shown.
    ready: bool,
    /// Has held focus since it was last shown or moved. Blurs before that
    /// are the show itself settling, not the user leaving.
    armed: bool,
}

/// Every open card by window label. At most one is unpinned.
#[derive(Default)]
struct Cards {
    next: u64,
    open: HashMap<String, Card>,
}

impl Cards {
    /// Hands the unpinned card to `user` and returns its label and whether
    /// it is showing.
    fn reuse(&mut self, user: &CardUser) -> Option<(String, bool)> {
        let (label, card) = self.open.iter_mut().find(|(_, c)| !c.pinned)?;
        card.user = user.clone();
        card.armed = false;
        Some((label.clone(), card.ready))
    }

    fn add(&mut self, user: CardUser) -> String {
        self.next += 1;
        let label = format!("{LABEL_PREFIX}{}", self.next);
        self.open.insert(
            label.clone(),
            Card {
                user,
                pinned: false,
                ready: false,
                armed: false,
            },
        );
        label
    }

    fn user(&self, label: &str) -> Option<CardUser> {
        self.open.get(label).map(|c| c.user.clone())
    }

    fn mark_ready(&mut self, label: &str) -> bool {
        self.open.get_mut(label).map(|c| c.ready = true).is_some()
    }

    fn set_pinned(&mut self, label: &str, pinned: bool) -> bool {
        self.open
            .get_mut(label)
            .map(|c| c.pinned = pinned)
            .is_some()
    }

    fn focused(&mut self, label: &str) {
        if let Some(card) = self.open.get_mut(label) {
            card.armed = true;
        }
    }

    /// True when the blur closes the card, which is then forgotten so a
    /// click racing the close cannot reuse it. `still_foreground` is the
    /// OS saying the card is still the active window: the webview loses
    /// focus to the frame while the card is dragged.
    fn blurred(&mut self, label: &str, still_foreground: bool) -> bool {
        let closes = self
            .open
            .get(label)
            .is_some_and(|c| c.armed && !c.pinned && !still_foreground);
        if closes {
            self.open.remove(label);
        }
        closes
    }

    fn forget(&mut self, label: &str) -> bool {
        self.open.remove(label).is_some()
    }

    fn drain(&mut self) -> Vec<String> {
        self.open.drain().map(|(label, _)| label).collect()
    }
}

#[derive(Default)]
pub struct UserCards {
    cards: Mutex<Cards>,
    /// One open at a time, so a second click cannot reuse a card whose
    /// window is still being built.
    opening: tokio::sync::Mutex<()>,
}

impl UserCards {
    fn lock(&self) -> MutexGuard<'_, Cards> {
        self.cards.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// What opening a card does to windows. [`App`] is the real one.
trait Host {
    /// Mouse position in physical pixels.
    fn cursor(&self) -> Result<Point, String>;
    /// Work area and scale factor of the monitor under `at`.
    fn work_area(&self, at: Point) -> Option<(Area, f64)>;
    /// Builds a hidden card; it shows once its webview calls ready.
    fn create(&self, label: &str, at: Point, user: &CardUser, zoom: f64) -> Result<(), String>;
    /// Moves and resizes an existing card, hands it `user`, and brings it
    /// forward when it is already showing.
    fn reuse(
        &self,
        label: &str,
        at: Point,
        user: &CardUser,
        zoom: f64,
        showing: bool,
    ) -> Result<(), String>;
}

async fn open_on(
    host: &impl Host,
    cards: &UserCards,
    user: CardUser,
    zoom: f64,
) -> Result<(), UserCardError> {
    let _turn = cards.opening.lock().await;
    let setting = clamp_zoom(zoom);
    let cursor = host.cursor().map_err(UserCardError::window)?;
    let (at, zoom) = match host.work_area(cursor) {
        Some((area, scale)) => {
            let zoom = effective_zoom(setting, scale);
            (place(cursor, card_size(scale, zoom), area), zoom)
        }
        None => (cursor, effective_zoom(setting, 1.0)),
    };
    let reusable = cards.lock().reuse(&user);
    if let Some((label, showing)) = reusable {
        match host.reuse(&label, at, &user, zoom, showing) {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!(error = %e, label, "user card gone, opening a new one");
                cards.lock().forget(&label);
            }
        }
    }
    let label = cards.lock().add(user.clone());
    host.create(&label, at, &user, zoom).map_err(|e| {
        cards.lock().forget(&label);
        UserCardError::window(e)
    })
}

/// Opens `user`'s card at the mouse, reusing the unpinned card if there is
/// one. The position comes from the OS cursor, not the click event, since
/// webview screen coordinates are DIPs that do not map to physical pixels
/// across monitors with different scaling.
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

/// Closes every card; the main window going away takes them with it.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    let labels = app.state::<UserCards>().lock().drain();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
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
            let foreground = holds_foreground(&window);
            if cards.lock().blurred(label, foreground) {
                let _ = window.destroy();
            }
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            cards.lock().forget(label);
        }
        _ => {}
    }
}

#[cfg(windows)]
fn holds_foreground<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: GetForegroundWindow takes no arguments and only reads.
    let foreground = unsafe { GetForegroundWindow() };
    window.hwnd().is_ok_and(|hwnd| hwnd.0 == foreground.0)
}

#[cfg(not(windows))]
fn holds_foreground<R: Runtime>(_window: &WebviewWindow<R>) -> bool {
    false
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

    fn create(&self, label: &str, at: Point, user: &CardUser, zoom: f64) -> Result<(), String> {
        let (width, height) = logical_size(zoom);
        let builder =
            WebviewWindowBuilder::new(&self.0, label, WebviewUrl::App("index.html".into()))
                .title(&user.display_name)
                .inner_size(width, height)
                // A fixed size that follows the zoom, so the card always looks
                // the same.
                .resizable(false)
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
        self.0
            .emit_to(EventTarget::webview_window(label), SHOW_EVENT, user)
            .map_err(|e| e.to_string())?;
        if showing {
            bring_forward(&window).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn user(name: &str) -> CardUser {
        CardUser {
            channel_id: "c".into(),
            platform_user_id: format!("id-{name}"),
            username: name.into(),
            display_name: name.to_uppercase(),
            color: Some("#ff0000".into()),
            badges: vec![Badge {
                set_id: "moderator".into(),
                id: "1".into(),
            }],
        }
    }

    const AREA: Area = Area {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };

    #[test]
    fn card_opens_at_the_cursor() {
        let at = place(Point { x: 100, y: 200 }, (420, 640), AREA);
        assert_eq!(at, Point { x: 100, y: 200 });
    }

    #[test]
    fn card_is_pulled_back_inside_the_work_area() {
        let at = place(Point { x: 1800, y: 900 }, (420, 640), AREA);
        assert_eq!(at, Point { x: 1500, y: 400 });
        let left = Area {
            x: -1920,
            y: 0,
            ..AREA
        };
        let at = place(Point { x: -50, y: -10 }, (420, 640), left);
        assert_eq!(at, Point { x: -420, y: 0 });
    }

    #[test]
    fn card_larger_than_the_area_sticks_to_its_corner() {
        let small = Area {
            x: 10,
            y: 20,
            width: 300,
            height: 300,
        };
        let at = place(Point { x: 200, y: 200 }, (420, 640), small);
        assert_eq!(at, Point { x: 10, y: 20 });
    }

    #[test]
    fn card_size_follows_the_monitor_scale_and_the_zoom() {
        assert_eq!(card_size(1.0, 1.0), (320, 480));
        assert_eq!(card_size(1.5, 1.0), (480, 720));
        assert_eq!(card_size(1.0, 1.5), (480, 720));
        assert_eq!(card_size(1.5, 1.5), (720, 1080));
    }

    #[test]
    fn zoom_tops_up_what_the_monitor_scale_leaves() {
        assert_eq!(effective_zoom(1.0, 1.0), 1.5);
        assert_eq!(effective_zoom(1.0, 1.5), 1.0);
        assert_eq!(effective_zoom(1.0, 2.0), 1.0);
        assert_eq!(effective_zoom(1.25, 1.0), 1.875);
    }

    #[test]
    fn a_bad_zoom_is_clamped() {
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
        assert_eq!(clamp_zoom(0.01), MIN_ZOOM);
        assert_eq!(clamp_zoom(100.0), MAX_ZOOM);
        assert_eq!(clamp_zoom(1.25), 1.25);
    }

    #[test]
    fn labels_are_unique_cards() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        cards.forget(&a);
        let b = cards.add(user("b"));
        assert_ne!(a, b);
        assert!(is_card(&a) && is_card(&b));
        assert!(!is_card("main"));
        assert_eq!(cards.user(&b).unwrap().username, "b");
        assert!(cards.user(&a).is_none());
    }

    #[test]
    fn a_new_name_replaces_the_unpinned_card() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        assert_eq!(cards.reuse(&user("b")), Some((a.clone(), false)));
        assert_eq!(cards.user(&a).unwrap().username, "b");
        cards.mark_ready(&a);
        assert_eq!(cards.reuse(&user("c")), Some((a, true)));
    }

    #[test]
    fn pinned_cards_are_never_reused() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        assert!(cards.set_pinned(&a, true));
        assert_eq!(cards.reuse(&user("b")), None);
        assert_eq!(cards.user(&a).unwrap().username, "a");
        assert!(cards.set_pinned(&a, false));
        assert!(cards.reuse(&user("b")).is_some());
        assert!(!cards.set_pinned("user-card-99", true));
    }

    #[test]
    fn blur_closes_an_unpinned_card_only_after_it_held_focus() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        assert!(!cards.blurred(&a, false), "blur while the show settles");
        cards.focused(&a);
        assert!(!cards.blurred(&a, true), "webview blur while dragging");
        assert!(cards.blurred(&a, false));
        assert!(cards.user(&a).is_none());
        assert!(!cards.blurred(&a, false));
    }

    #[test]
    fn blur_leaves_pinned_cards_open() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        cards.focused(&a);
        cards.set_pinned(&a, true);
        assert!(!cards.blurred(&a, false));
        assert!(cards.user(&a).is_some());
    }

    #[test]
    fn reuse_disarms_until_the_card_is_focused_again() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        cards.focused(&a);
        cards.reuse(&user("b"));
        assert!(!cards.blurred(&a, false));
        cards.focused(&a);
        assert!(cards.blurred(&a, false));
    }

    #[test]
    fn ready_and_drain_know_only_open_cards() {
        let mut cards = Cards::default();
        let a = cards.add(user("a"));
        let b = cards.add(user("b"));
        assert!(cards.mark_ready(&a));
        assert!(!cards.mark_ready("user-card-99"));
        let mut drained = cards.drain();
        drained.sort();
        assert_eq!(drained, [a.clone(), b]);
        assert!(!cards.forget(&a));
    }

    #[derive(Default)]
    struct Fake {
        no_monitor: bool,
        cursor_fails: bool,
        create_fails: bool,
        gone: Vec<String>,
        calls: RefCell<Vec<String>>,
    }

    impl Host for Fake {
        fn cursor(&self) -> Result<Point, String> {
            if self.cursor_fails {
                return Err("no cursor".into());
            }
            Ok(Point { x: 1900, y: 100 })
        }

        fn work_area(&self, _at: Point) -> Option<(Area, f64)> {
            (!self.no_monitor).then_some((AREA, 1.0))
        }

        fn create(&self, label: &str, at: Point, user: &CardUser, zoom: f64) -> Result<(), String> {
            self.calls.borrow_mut().push(format!(
                "create {label} {},{} {} x{zoom}",
                at.x, at.y, user.username
            ));
            if self.create_fails {
                return Err("build failed".into());
            }
            Ok(())
        }

        fn reuse(
            &self,
            label: &str,
            at: Point,
            user: &CardUser,
            zoom: f64,
            showing: bool,
        ) -> Result<(), String> {
            self.calls.borrow_mut().push(format!(
                "reuse {label} {},{} {} x{zoom} {showing}",
                at.x, at.y, user.username
            ));
            if self.gone.iter().any(|g| g == label) {
                return Err("gone".into());
            }
            Ok(())
        }
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    #[tokio::test]
    async fn open_creates_then_reuses_at_the_clamped_cursor() {
        let host = Fake::default();
        let cards = UserCards::default();
        open_on(&host, &cards, user("a"), 1.0).await.unwrap();
        cards.lock().mark_ready("user-card-1");
        open_on(&host, &cards, user("b"), 1.0).await.unwrap();
        assert_eq!(
            host.calls(),
            [
                "create user-card-1 1440,100 a x1.5",
                "reuse user-card-1 1440,100 b x1.5 true"
            ]
        );
    }

    #[tokio::test]
    async fn open_beside_a_pinned_card_makes_a_new_one() {
        let host = Fake::default();
        let cards = UserCards::default();
        open_on(&host, &cards, user("a"), 1.0).await.unwrap();
        cards.lock().set_pinned("user-card-1", true);
        open_on(&host, &cards, user("b"), 1.0).await.unwrap();
        assert_eq!(host.calls()[1], "create user-card-2 1440,100 b x1.5");
        assert_eq!(cards.lock().user("user-card-1").unwrap().username, "a");
    }

    #[tokio::test]
    async fn a_card_whose_window_is_gone_is_replaced() {
        let host = Fake {
            gone: vec!["user-card-1".into()],
            ..Fake::default()
        };
        let cards = UserCards::default();
        open_on(&host, &cards, user("a"), 1.0).await.unwrap();
        open_on(&host, &cards, user("b"), 1.0).await.unwrap();
        assert_eq!(host.calls()[2], "create user-card-2 1440,100 b x1.5");
        assert!(cards.lock().user("user-card-1").is_none());
    }

    #[tokio::test]
    async fn without_a_monitor_the_card_opens_at_the_raw_cursor() {
        let host = Fake {
            no_monitor: true,
            ..Fake::default()
        };
        let cards = UserCards::default();
        open_on(&host, &cards, user("a"), 1.0).await.unwrap();
        assert_eq!(host.calls(), ["create user-card-1 1900,100 a x1.5"]);
    }

    #[tokio::test]
    async fn failures_surface_as_window_errors_and_leave_no_card() {
        let cards = UserCards::default();
        let host = Fake {
            create_fails: true,
            ..Fake::default()
        };
        let err = open_on(&host, &cards, user("a"), 1.0).await.unwrap_err();
        assert_eq!(err, UserCardError::window("build failed"));
        assert!(cards.lock().user("user-card-1").is_none());

        let host = Fake {
            cursor_fails: true,
            ..Fake::default()
        };
        let err = open_on(&host, &cards, user("a"), 1.0).await.unwrap_err();
        assert_eq!(err.kind, "window");
        assert!(host.calls().is_empty());
    }

    #[test]
    fn card_user_round_trips_the_frontend_shape() {
        let json = serde_json::json!({
            "channel_id": "c",
            "platform_user_id": "42",
            "username": "a",
            "display_name": "A",
            "color": null,
            "badges": [{ "set_id": "vip", "id": "1" }]
        });
        let u: CardUser = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(u).unwrap(), json);
    }

    #[test]
    fn error_serializes_as_kind_and_message() {
        assert_eq!(
            serde_json::to_value(UserCardError::not_a_card("main")).unwrap(),
            serde_json::json!({ "kind": "not_a_card", "message": "main is not an open user card" })
        );
    }
}
