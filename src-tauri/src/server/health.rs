// The `/health` probe: one HTTP GET against 127.0.0.1:<port>, classified as
// "this is Claudia" or not. Split out of server.rs (which now only
// orchestrates attach-vs-spawn and shutdown) once the combined file crossed
// the repo's 400-line size ratchet.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

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
pub(crate) fn wait_for_health(timeout: Duration, port: u16) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if http_health_ok(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(300));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
