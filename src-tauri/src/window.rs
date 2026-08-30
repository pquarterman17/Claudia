// The native window, tray icon, and splash-screen protocol around Claudia's
// web UI. Nothing here talks to the Node server directly — server.rs owns
// that — this file only ever renders things and reacts to window/tray
// events. Carried across unmodified from quantized (see main.rs's module
// doc comment): the bundled loading splash (here served from a
// `claudia-splash://` custom protocol instead of a file under web/, since
// web/src is another lane's territory right now and this keeps the whole
// shell self-contained under src-tauri/), and a tray icon with an explicit
// menu.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const SPLASH_SCHEME: &str = "claudia-splash";
const SPLASH_HTML: &str = include_str!("../assets/loading.html");

pub fn splash_url() -> tauri::Url {
    format!("{SPLASH_SCHEME}://localhost/index.html")
        .parse()
        .expect("static splash URL is well-formed")
}

/// The response body for the custom `claudia-splash://` protocol registered
/// on the builder in main.rs — serves the bundled splash (assets/loading.html)
/// over its own scheme so it never depends on web/dist existing or on
/// touching anything under web/ — this shell stays self-contained under
/// src-tauri/.
pub fn splash_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header(tauri::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(SPLASH_HTML.as_bytes().to_vec())
        .expect("building a static response from a fixed string cannot fail")
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Turns a startup failure into the splash's own error banner (see
/// assets/loading.html's `window.__claudiaError`) instead of a spinner that
/// never resolves or a webview "can't reach this page".
pub fn show_splash_error(win: &tauri::WebviewWindow, msg: &str) {
    let escaped = msg.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ");
    let _ = win.eval(format!("window.__claudiaError && window.__claudiaError('{escaped}')"));
}

/// Tray icon with an explicit menu — Linux tray implementations require one;
/// a left-click also restores/focuses the window.
pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    if let Some(icon) = app.default_window_icon().cloned() {
        let show = MenuItem::with_id(app, "tray-show", "Show Claudia", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "tray-quit", "Quit Claudia", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &quit])?;
        TrayIconBuilder::with_id("claudia-tray")
            .icon(icon)
            .tooltip("Claudia")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                ) {
                    show_main_window(tray.app_handle());
                }
            })
            .on_menu_event(|app, event| match event.id().as_ref() {
                "tray-show" => show_main_window(app),
                "tray-quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
    }
    Ok(())
}

/// Builds the main webview window, initially pointed at the bundled splash
/// (see `splash_url`) — main.rs's server supervision (`server::spawn_and_supervise`)
/// navigates it to the live server once one is reachable.
pub fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(splash_url()))
        .title("Claudia")
        .inner_size(1440.0, 920.0)
        .min_inner_size(960.0, 600.0)
        .build()?;
    if let Some(icon) = app.default_window_icon().cloned() {
        let _ = window.set_icon(icon);
    }
    Ok(())
}

/// Closing the window must not stop sessions living inside the server
/// process — treat the close button exactly like minimizing to tray. Only
/// the tray's explicit "Quit" item (via `RunEvent::Exit` in main.rs, which
/// calls `server::stop_owned_server`) actually stops anything.
pub fn handle_window_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    /// Exercises the exact matcher Tauri's ACL uses at runtime (not a
    /// reimplementation of it) against the literal string in
    /// capabilities/main.json, so a future edit to that file that breaks the
    /// port-wildcard is caught here instead of only at GUI-test time, which
    /// this environment cannot run.
    #[test]
    fn capability_remote_pattern_matches_claudia_ports_but_not_other_hosts() {
        let raw = include_str!("../capabilities/main.json");
        let json: serde_json::Value = serde_json::from_str(raw).expect("capabilities/main.json is valid JSON");
        let pattern_str = json["remote"]["urls"][0].as_str().expect("remote.urls[0] is a string");
        let pattern: tauri_utils::acl::RemoteUrlPattern = pattern_str.parse().expect("pattern parses");

        // The canonical default port, and an arbitrary ephemeral one — both
        // must match, since which one Claudia binds to depends on whether
        // something else already held 4317 at startup.
        assert!(pattern.test(&url::Url::parse("http://127.0.0.1:4317/").unwrap()));
        assert!(pattern.test(&url::Url::parse("http://127.0.0.1:54321/ws").unwrap()));

        // Never a non-loopback host, even on the right port — scoping this
        // capability to loopback only is the entire point of writing our own
        // pattern instead of a bare wildcard.
        assert!(!pattern.test(&url::Url::parse("http://example.com:4317/").unwrap()));
    }
}
