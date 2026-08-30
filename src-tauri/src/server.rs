// Supervises the local Node/Fastify server (../../server): decides whether
// to attach to an already-running Claudia or spawn a new one, waits for it
// to become reachable, and — only for a server this shell spawned itself —
// shuts it down again on Quit. See main.rs's module doc comment for why
// "attach, never duplicate" and "only kill what we spawned" are the two
// invariants this file exists to protect.

use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use tauri::Manager;

use crate::window;

mod health;

/// Mirrors `CLAUDIA_PORT` in shared/src (the single source of truth for the
/// number); duplicated here because a Rust binary can't import a TS module.
pub const DEFAULT_PORT: u16 = 4317;

/// Holds the Child IFF this shell spawned it. `None` covers two different
/// cases on purpose: nothing has been spawned yet, and the shell attached to
/// a server it does not own. Both must behave identically on Quit — do
/// nothing to the server — so collapsing them into one `None` state is what
/// makes "only ever kill a child we started" hard to get wrong later.
pub struct ServerProc(Mutex<Option<Child>>);

impl ServerProc {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

pub fn app_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn repo_root() -> PathBuf {
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

/// Quick synchronous probe of the canonical default port, used only to
/// decide attach-vs-spawn during `setup()` — which must return promptly so
/// the splash shows right away. The potentially-slow follow-up work happens
/// in `spawn_and_supervise`, off the UI thread. The actual HTTP probe and its
/// Claudia-shape classification live in `health` (split out once this file
/// crossed the repo's 400-line size ratchet).
pub fn quick_health_probe() -> bool {
    health::wait_for_health(Duration::from_millis(800), DEFAULT_PORT)
}

/// The one decision this whole shell exists to get right: reuse an
/// already-healthy Claudia rather than ever spawning a second one. A second
/// server would be a second, completely disjoint board of sessions — the
/// worst failure mode available to this shell, worse than the shell simply
/// not existing.
///
/// Runs entirely on its own background thread (never blocks the caller): the
/// potentially-slow parts (rebuilding the UI, waiting for a freshly spawned
/// server) must not block `setup()`, which needs to return promptly so the
/// splash shows right away.
pub fn spawn_and_supervise(handle: tauri::AppHandle, repo: PathBuf, already: bool) {
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
                        window::show_splash_error(
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
                        window::show_splash_error(&win, &format!("Claudia's server did not start: {reason}"));
                    }
                    return;
                }
            }
        };

        let ok = already || health::wait_for_health(Duration::from_secs(30), port);
        if let Some(win) = handle.get_webview_window("main") {
            if ok {
                if let Ok(url) = app_url(port).parse() {
                    let _ = win.navigate(url);
                }
            } else {
                window::show_splash_error(&win, &format!("Claudia could not reach its local server on port {port}."));
            }
        }
    });
}

/// Stops the server, but ONLY if this shell spawned it — see `ServerProc`.
/// Called exclusively from the tray's "Quit" item (via `RunEvent::Exit`),
/// never from a window close, which hides instead (see `window::handle_window_event`).
pub fn stop_owned_server(app: &tauri::AppHandle) {
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

    // Health-probe classification (health_body_ok / health_response_ok) is
    // tested alongside its own code in server/health.rs.
}
