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
//
// Split into server.rs (supervising the Node process: attach-vs-spawn
// decision, spawning, health probing, graceful shutdown) and window.rs (the
// tray icon, splash protocol, and main window) once this file crossed the
// repo's 400-line size ratchet (see server/test/repo-integrity.test.ts).
// This file is left as the thin wiring between the two.

#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod server;
mod window;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Registering the plugin above already injects a window.Notification
        // shim into every webview (including this one), but the splash never
        // calls it, so no capability grant is needed for the `local`
        // (non-remote) side of that — see capabilities/main.json.
        .register_uri_scheme_protocol(window::SPLASH_SCHEME, |_ctx, _req| window::splash_response())
        .setup(|app| {
            window::setup_tray(app)?;

            app.manage(server::ServerProc::new());
            window::create_main_window(app)?;

            // Only a QUICK probe here (attach/spawn decision blocks setup(),
            // which should return promptly so the splash shows right away);
            // the potentially-slow parts (rebuilding the UI, waiting for a
            // freshly spawned server) happen in server::spawn_and_supervise,
            // on its own background thread.
            //
            // This is the one decision this whole shell exists to get right:
            // reuse an already-healthy Claudia rather than ever spawning a
            // second one. A second server would be a second, completely
            // disjoint board of sessions — the worst failure mode available
            // to this shell, worse than the shell simply not existing.
            let already = server::quick_health_probe();
            server::spawn_and_supervise(app.handle().clone(), server::repo_root(), already);

            Ok(())
        })
        .on_window_event(window::handle_window_event)
        .build(tauri::generate_context!())
        .expect("error building the tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                server::stop_owned_server(app);
            }
        });
}
