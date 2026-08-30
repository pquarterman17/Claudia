// Claudia desktop shell: a Tauri 2 window, tray icon and native notifications
// around the local Node/Fastify server (see ../../server). Modeled on
// ../../../quantized/src-tauri/src/main.rs (a working Tauri 2 shell over a
// local server by the same owner) per the sibling-repo-first convention, with
// one deliberate divergence driven by how the two apps differ:
//
// Quantized's server is stateless from the shell's point of view — closing
// its window and killing its process is an unremarkable "quit the app".
// Claudia's sessions (Claude Code / Codex `query()` calls, SDK subprocesses)
// live INSIDE the server process, so this shell treats the server as
// something to attach to or supervise, never to duplicate or casually kill:
//
//   - Attach, don't spawn, whenever a healthy Claudia already answers on the
//     canonical port. Spawning a second one would silently split the user's
//     running sessions across two disjoint boards.
//   - The window's close button hides to tray rather than closing — this app
//     exists to supervise long-running work, and a stray window close must
//     not stop it. Only the tray's "Quit" item actually stops the server,
//     and only if THIS shell spawned it.
//
// Carried across unmodified from quantized: the bundled loading splash
// (here served from a `claudia-splash://` custom protocol instead of a file
// under web/, since web/src is another lane's territory right now and this
// keeps the whole shell self-contained under src-tauri/), ephemeral-port
// fallback when the default port is held by a foreign process, hiding the
// console window in release builds, a tray icon with an explicit menu, and
// killing a spawned child directly rather than through a shell.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Mirrors `CLAUDIA_PORT` in shared/src (the single source of truth for the
/// number); duplicated here because a Rust binary can't import a TS module.
const DEFAULT_PORT: u16 = 4317;

const SPLASH_SCHEME: &str = "claudia-splash";
const SPLASH_HTML: &str = include_str!("../assets/loading.html");

/// Holds the Child IFF this shell spawned it. `None` covers two different
/// cases on purpose: nothing has been spawned yet, and the shell attached to
/// a server it does not own. Both must behave identically on Quit — do
/// nothing to the server — so collapsing them into one `None` state is what
/// makes "only ever kill a child we started" hard to get wrong later.
struct ServerProc(Mutex<Option<Child>>);

fn app_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn splash_url() -> tauri::Url {
    format!("{SPLASH_SCHEME}://localhost/index.html")
        .parse()
        .expect("static splash URL is well-formed")
}

fn repo_root() -> PathBuf {
    // src-tauri/ lives one level under the repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

/// True iff nothing currently holds 127.0.0.1:`port` (bind-probe; the
/// listener is dropped immediately). Windows binds without SO_REUSEADDR, so a
/// port a foreign server owns reads busy here rather than stolen.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn tsx_cli_path(repo: &Path) -> PathBuf {
    repo.join("node_modules").join("tsx").join("dist").join("cli.mjs")
}

/// Rebuilds `web/dist` if sources changed — exactly what `npm start` does,
/// but as its own step so the actual server spawn below stays a plain `node`
/// invocation instead of going through npm (see `spawn_server`). Cheap in the
/// common case: `ensure-build.mjs` checks mtimes itself and exits immediately
/// when nothing changed. Best-effort: a failed build still lets the server
/// start and serve whatever exists — this shell has no way to fix a broken
/// build, only to avoid blocking startup on one.
fn run_ensure_build(repo: &Path) {
    let mut cmd = Command::new("node");
    cmd.arg("scripts/ensure-build.mjs").current_dir(repo);
    hide_console(&mut cmd);
    match cmd.status() {
        Ok(status) if !status.success() => {
            eprintln!("[claudia-shell] ensure-build.mjs exited with {status}; starting the server anyway");
        }
        Err(e) => eprintln!("[claudia-shell] could not run ensure-build.mjs: {e}"),
        Ok(_) => {}
    }
}

/// Spawns `node <tsx-cli> src/index.ts` directly from the server workspace —
/// not `npm start` and not a shell — so killing this exact Child later kills
/// the server instead of orphaning a grandchild that keeps holding the port
/// (`npm start` on Windows runs through a `.cmd` shim; killing that shim does
/// not kill what it spawned). `port` is `Some(4317)` to claim the canonical
/// default, or `None` to ask the OS for an ephemeral port (`CLAUDIA_PORT=0`)
/// when something else already holds 4317.
fn spawn_server(repo: &Path, port: Option<u16>) -> io::Result<Child> {
    let mut cmd = Command::new("node");
    cmd.arg(tsx_cli_path(repo))
        .arg("src/index.ts")
        .current_dir(repo.join("server"))
        .env(
            "CLAUDIA_PORT",
            port.map(|p| p.to_string()).unwrap_or_else(|| "0".to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    cmd.spawn()
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut Command) {}

/// Pulls the bound port out of the exact line index.ts prints on startup —
/// `[claudia] listening on http://127.0.0.1:<port> · <platform>` — which is
/// the only reliable way to learn the actual port when we asked for an
/// ephemeral one (`CLAUDIA_PORT=0`): the OS picks it, not us. Pure/testable
/// on purpose, independent of the child process and thread below.
fn parse_listening_port(line: &str) -> Option<u16> {
    let marker = "listening on http://127.0.0.1:";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// Relays the server's stderr to this process's own stderr — best-effort
/// diagnostics for a debug build with a console attached; silently dropped
/// otherwise (release builds hide the console entirely, see `hide_console`).
fn relay_stderr(child: &mut Child) {
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[server] {line}");
            }
        });
    }
}

/// Blocks (on a background thread, never the UI thread) until the child
/// either prints its "listening on" line — returning the bound port — or
/// fails in a way we can report: it printed the busy-port message, its
/// stdout closed without ever printing "listening" (it exited early), or
/// `timeout` elapsed first.
fn wait_for_listening_line(child: &mut Child, timeout: Duration) -> Result<u16, String> {
    let stdout = child.stdout.take().expect("stdout was piped");
    let (tx, rx) = mpsc::channel::<Result<u16, String>>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            println!("[server] {line}");
            if let Some(port) = parse_listening_port(&line) {
                let _ = tx.send(Ok(port));
                return;
            }
            if line.contains("already in use") {
                let _ = tx.send(Err(line));
                return;
            }
        }
        let _ = tx.send(Err("the server process exited before it started listening".to_string()));
    });
    rx.recv_timeout(timeout)
        .unwrap_or_else(|_| Err("timed out waiting for the server to start".to_string()))
}

/// One HTTP GET attempt, returning the raw response text (status line and
/// body together) for `health_response_ok` to classify. `None` covers every
/// flavor of "didn't answer" (nothing listening, connection refused, read
/// timeout) without distinguishing them — the caller only needs yes/no.
fn http_get_health(port: u16) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(800))).ok();
    let req = b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    stream.write_all(req).ok()?;
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    Some(buf)
}

/// Splits a raw HTTP/1.x response into head and body and checks both. Split
/// out pure so it is unit-testable without a socket.
fn health_response_ok(raw: &str) -> bool {
    let mut parts = raw.splitn(2, "\r\n\r\n");
    let head = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("");
    (head.starts_with("HTTP/1.0 200") || head.starts_with("HTTP/1.1 200")) && health_body_ok(body)
}

/// Response classification for the health probe. Claudia's `/health` (see
/// server/src/index.ts) has no identifying "app" field the way quantized's
/// does — server/src is off-limits to this change, so this checks structural
/// shape instead: `ok` must be literally `true`, `platform` must be one of
/// Claudia's own three known values, and the session counters must be
/// present. A foreign process that happens to answer 200 on this port with
/// an unrelated JSON body is exceedingly unlikely to also produce this exact
/// shape, but it is not a cryptographic identity check the way quantized's
/// `"app":"quantized"` field is — worth another look if server/src ever adds
/// one.
fn health_body_ok(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let ok = json.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
    let platform_ok = matches!(
        json.get("platform").and_then(serde_json::Value::as_str),
        Some("win32" | "darwin" | "linux")
    );
    let has_counts = json.get("sessions").and_then(serde_json::Value::as_i64).is_some()
        && json.get("live").and_then(serde_json::Value::as_i64).is_some();
    ok && platform_ok && has_counts
}

fn http_health_ok(port: u16) -> bool {
    http_get_health(port).is_some_and(|raw| health_response_ok(&raw))
}

/// Poll `/health` until it answers Claudia's own shape or `timeout` elapses.
fn wait_for_health(timeout: Duration, port: u16) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if http_health_ok(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Turns a startup failure into the splash's own error banner (see
/// assets/loading.html's `window.__claudiaError`) instead of a spinner that
/// never resolves or a webview "can't reach this page".
fn show_splash_error(win: &tauri::WebviewWindow, msg: &str) {
    let escaped = msg.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ");
    let _ = win.eval(format!("window.__claudiaError && window.__claudiaError('{escaped}')"));
}

/// Stops the server, but ONLY if this shell spawned it — see `ServerProc`.
/// Called exclusively from the tray's "Quit" item (via `RunEvent::Exit`),
/// never from a window close, which hides instead (see `main`'s
/// `on_window_event`).
fn stop_owned_server(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ServerProc>() else { return };
    let Ok(mut guard) = state.0.lock() else { return };
    let Some(mut child) = guard.take() else { return };
    graceful_stop(&mut child);
}

/// Sends SIGTERM first and gives the process a moment to exit on its own.
/// This is the same shutdown path Ctrl+C takes in the terminal launchers
/// (start-claudia.bat / .command): index.ts's SIGTERM handler runs
/// `manager.stopAll()`, which stops each session — including any spawned
/// Codex CLI subprocess (see server/src/codex-process.ts) — before the
/// process exits. A hard kill skips all of that and can leave those
/// subprocesses orphaned. Falls back to a hard kill if the process ignores
/// SIGTERM or takes too long.
#[cfg(unix)]
fn graceful_stop(child: &mut Child) {
    let pid = child.id().to_string();
    let sent_term = Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if sent_term {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Windows has no equivalent of SIGTERM reachable from an unrelated process
/// without sharing a console group, so this is a hard kill (TerminateProcess)
/// — the same outcome as force-closing the console window of
/// start-claudia.bat, which also bypasses index.ts's `stopAll()` cleanup
/// today. Not a regression this shell introduces, but worth fixing in both
/// places together if it ever matters enough (e.g. a Job Object that kills
/// the whole process tree on close).
#[cfg(not(unix))]
fn graceful_stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Serves the bundled splash (assets/loading.html) over its own
        // scheme so it never depends on web/dist existing or on touching
        // anything under web/ — this shell stays self-contained under
        // src-tauri/. Registering the plugin above already injects a
        // window.Notification shim into every webview (including this one),
        // but the splash never calls it, so no capability grant is needed
        // for the `local` (non-remote) side of that — see capabilities/main.json.
        .register_uri_scheme_protocol(SPLASH_SCHEME, |_ctx, _req| {
            tauri::http::Response::builder()
                .status(200)
                .header(tauri::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(SPLASH_HTML.as_bytes().to_vec())
                .expect("building a static response from a fixed string cannot fail")
        })
        .setup(|app| {
            let repo = repo_root();

            // Tray icon with an explicit menu — Linux tray implementations
            // require one; a left-click also restores/focuses the window.
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

            app.manage(ServerProc(Mutex::new(None)));

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(splash_url()))
                .title("Claudia")
                .inner_size(1440.0, 920.0)
                .min_inner_size(960.0, 600.0)
                .build()?;
            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = window.set_icon(icon);
            }

            // Only a QUICK probe here (attach/spawn decision blocks setup(),
            // which should return promptly so the splash shows right away);
            // the potentially-slow parts (rebuilding the UI, waiting for a
            // freshly spawned server) happen on the background thread below.
            //
            // This is the one decision this whole shell exists to get right:
            // reuse an already-healthy Claudia rather than ever spawning a
            // second one. A second server would be a second, completely
            // disjoint board of sessions — the worst failure mode available
            // to this shell, worse than the shell simply not existing.
            let already = wait_for_health(Duration::from_millis(800), DEFAULT_PORT);

            let handle = app.handle().clone();
            thread::spawn(move || {
                let port = if already {
                    DEFAULT_PORT
                } else {
                    run_ensure_build(&repo);
                    // Claim the canonical default when it's free, so every
                    // other way of starting Claudia (the batch/command
                    // launchers, a browser bookmark, a second Tauri window)
                    // keeps finding the same one server. Only fall back to
                    // an OS-assigned port when something else already holds
                    // 4317 and isn't Claudia.
                    let claim_default = port_is_free(DEFAULT_PORT);
                    let mut child = match spawn_server(&repo, claim_default.then_some(DEFAULT_PORT)) {
                        Ok(child) => child,
                        Err(e) => {
                            if let Some(win) = handle.get_webview_window("main") {
                                show_splash_error(
                                    &win,
                                    &format!(
                                        "Could not start Node.js ({e}). Install it from https://nodejs.org and try again."
                                    ),
                                );
                            }
                            return;
                        }
                    };
                    relay_stderr(&mut child);
                    match wait_for_listening_line(&mut child, Duration::from_secs(30)) {
                        Ok(bound_port) => {
                            // Only NOW does this Child belong to ServerProc —
                            // if we returned early above, nothing was ever
                            // recorded as ours to kill.
                            if let Some(state) = handle.try_state::<ServerProc>() {
                                *state.0.lock().unwrap() = Some(child);
                            }
                            bound_port
                        }
                        Err(reason) => {
                            let _ = child.kill();
                            if let Some(win) = handle.get_webview_window("main") {
                                show_splash_error(&win, &format!("Claudia's server did not start: {reason}"));
                            }
                            return;
                        }
                    }
                };

                let ok = already || wait_for_health(Duration::from_secs(30), port);
                if let Some(win) = handle.get_webview_window("main") {
                    if ok {
                        if let Ok(url) = app_url(port).parse() {
                            let _ = win.navigate(url);
                        }
                    } else {
                        show_splash_error(&win, &format!("Claudia could not reach its local server on port {port}."));
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must not stop sessions living inside the
            // server process — treat the close button exactly like
            // minimizing to tray. Only the tray's explicit "Quit" item (via
            // RunEvent::Exit below) actually stops anything.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error building the tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_owned_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_url_formats_default_and_fallback_ports() {
        assert_eq!(app_url(DEFAULT_PORT), "http://127.0.0.1:4317");
        assert_eq!(app_url(54321), "http://127.0.0.1:54321");
    }

    #[test]
    fn port_is_free_false_while_a_listener_holds_it() {
        let held = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
        let port = held.local_addr().expect("local addr").port();
        assert!(!port_is_free(port));
        drop(held);
    }

    #[test]
    fn parse_listening_port_reads_the_real_startup_line() {
        assert_eq!(
            parse_listening_port("[claudia] listening on http://127.0.0.1:4317 · win32"),
            Some(4317)
        );
        assert_eq!(
            parse_listening_port("[claudia] listening on http://127.0.0.1:54321 · darwin"),
            Some(54321)
        );
    }

    #[test]
    fn parse_listening_port_ignores_unrelated_lines() {
        assert_eq!(parse_listening_port("[claudia] port 4317 is already in use."), None);
        assert_eq!(parse_listening_port("some unrelated server log line"), None);
        assert_eq!(parse_listening_port(""), None);
    }

    #[test]
    fn parse_listening_port_requires_digits_after_the_marker() {
        assert_eq!(parse_listening_port("[claudia] listening on http://127.0.0.1: · win32"), None);
    }

    #[test]
    fn health_body_accepts_claudias_own_shape() {
        assert!(health_body_ok(r#"{"ok":true,"sessions":2,"live":1,"platform":"win32"}"#));
        assert!(health_body_ok(r#"{"ok":true,"sessions":0,"live":0,"platform":"darwin"}"#));
    }

    #[test]
    fn health_body_rejects_wrong_platform_value() {
        // A foreign server that happens to reuse this exact JSON shape but
        // isn't one of Claudia's three real platforms.
        assert!(!health_body_ok(r#"{"ok":true,"sessions":0,"live":0,"platform":"nope"}"#));
    }

    #[test]
    fn health_body_rejects_missing_fields() {
        assert!(!health_body_ok(r#"{"ok":true,"platform":"win32"}"#));
        assert!(!health_body_ok(r#"{"sessions":0,"live":0,"platform":"win32"}"#));
    }

    #[test]
    fn health_body_rejects_ok_false_and_non_json() {
        assert!(!health_body_ok(r#"{"ok":false,"sessions":0,"live":0,"platform":"win32"}"#));
        assert!(!health_body_ok("<html>not json</html>"));
    }

    #[test]
    fn health_response_requires_200_and_a_matching_body() {
        let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"sessions\":0,\"live\":0,\"platform\":\"win32\"}";
        assert!(health_response_ok(ok));

        let not_found =
            "HTTP/1.1 404 Not Found\r\n\r\n{\"ok\":true,\"sessions\":0,\"live\":0,\"platform\":\"win32\"}";
        assert!(!health_response_ok(not_found));
    }

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
