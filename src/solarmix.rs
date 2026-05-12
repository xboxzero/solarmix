// Solarmix: a feedback rhythm machine driven by Leap Motion, a Pi camera, and a
// browser mic. The web page does all DSP and visuals; this module exposes:
//   GET  /              -> the page
//   GET  /camera.mjpeg  -> shared rpicam-vid MJPEG stream (multipart/x-mixed-replace)
//   GET  /leap          -> WebSocket; broadcasts JSON hand frames pushed in by a sidecar
//   POST /leap-ingest   -> sidecar bridge posts hand frames here (one JSON object per request)
//   GET  /health
//
// The Leap path is intentionally decoupled: a tiny separate C bridge (see
// tools/leap_bridge.c) links libLeapC and POSTs frames here. This keeps the
// Rust build free of Ultraleap SDK headers and lets the page work end-to-end
// with mouse fallback when no bridge is running.

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{StatusCode, header},
    response::{Html, IntoResponse, Json},
    routing::{get, post},
};
use bytes::Bytes;
use serde_json::json;
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, broadcast};

const MJPEG_BOUNDARY: &str = "spframe";

pub struct Hub {
    camera: Mutex<Option<broadcast::Sender<Bytes>>>,
    leap: broadcast::Sender<String>,
}

impl Hub {
    fn new() -> Self {
        let (leap_tx, _) = broadcast::channel::<String>(64);
        Self {
            camera: Mutex::new(None),
            leap: leap_tx,
        }
    }

    async fn camera_subscribe(self: &Arc<Self>) -> broadcast::Receiver<Bytes> {
        let mut guard = self.camera.lock().await;
        if let Some(tx) = guard.as_ref() {
            return tx.subscribe();
        }
        let (tx, rx) = broadcast::channel::<Bytes>(4);
        *guard = Some(tx.clone());
        tokio::spawn(async move {
            if let Err(e) = run_camera(tx).await {
                tracing::warn!("solarmix camera supervisor exited: {e}");
            }
        });
        rx
    }
}

pub fn router() -> Router {
    let hub = Arc::new(Hub::new());
    Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/camera.mjpeg", get(camera_stream))
        .route("/leap", get(leap_ws))
        .route("/leap-ingest", post(leap_ingest))
        .with_state(hub)
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../static/solarmix.html"))
}

async fn health(State(hub): State<Arc<Hub>>) -> Json<serde_json::Value> {
    let cam_alive = hub.camera.lock().await.is_some();
    Json(json!({
        "ok": true,
        "camera_running": cam_alive,
        "leap_subscribers": hub.leap.receiver_count(),
    }))
}

// rpicam-vid in mjpeg mode emits a continuous stream of JPEGs concatenated.
// We scan for SOI (0xff 0xd8) / EOI (0xff 0xd9) and broadcast each complete
// JPEG as a single Bytes value.
async fn run_camera(tx: broadcast::Sender<Bytes>) -> std::io::Result<()> {
    use tokio::process::Command;
    let mut child = Command::new("rpicam-vid")
        .args([
            "-t", "0",
            "--codec", "mjpeg",
            "--width", "640",
            "--height", "480",
            "--framerate", "15",
            "--inline",
            "--nopreview",
            "--flush",
            "-o", "-",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");

    let mut buf = Vec::<u8>::with_capacity(256 * 1024);
    let mut chunk = [0u8; 32 * 1024];
    let mut frame_start: Option<usize> = None;
    loop {
        let n = stdout.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);

        loop {
            // Find SOI if we're not already inside a frame.
            if frame_start.is_none() {
                if let Some(pos) = find_marker(&buf, 0, 0xd8) {
                    frame_start = Some(pos);
                } else {
                    // Drop bytes before any possible SOI to avoid unbounded growth.
                    if buf.len() > 1 {
                        let keep = &buf[buf.len() - 1..];
                        buf = keep.to_vec();
                    }
                    break;
                }
            }
            let start = frame_start.unwrap();
            // Search for EOI after start+2.
            if let Some(end) = find_marker(&buf, start + 2, 0xd9) {
                let end = end + 2; // include EOI bytes
                let frame: Bytes = Bytes::copy_from_slice(&buf[start..end]);
                let _ = tx.send(frame);
                // Shift buffer.
                buf = buf[end..].to_vec();
                frame_start = None;
            } else {
                // Need more bytes.
                if start > 0 {
                    buf = buf[start..].to_vec();
                    frame_start = Some(0);
                }
                break;
            }
        }
    }
    let _ = child.kill().await;
    Ok(())
}

fn find_marker(buf: &[u8], from: usize, marker: u8) -> Option<usize> {
    if from + 1 >= buf.len() {
        return None;
    }
    let mut i = from;
    while i + 1 < buf.len() {
        if buf[i] == 0xff && buf[i + 1] == marker {
            return Some(i);
        }
        i += 1;
    }
    None
}

async fn camera_stream(State(hub): State<Arc<Hub>>) -> axum::response::Response {
    use axum::body::Body;
    use futures_util::StreamExt;
    use tokio_stream::wrappers::BroadcastStream;

    let rx = hub.camera_subscribe().await;
    let stream = BroadcastStream::new(rx).filter_map(|item| async move {
        match item {
            Ok(jpeg) if !jpeg.is_empty() => {
                let header_part = format!(
                    "--{}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    MJPEG_BOUNDARY,
                    jpeg.len()
                );
                let mut out = Vec::with_capacity(header_part.len() + jpeg.len() + 2);
                out.extend_from_slice(header_part.as_bytes());
                out.extend_from_slice(&jpeg);
                out.extend_from_slice(b"\r\n");
                Some(Ok::<_, std::io::Error>(Bytes::from(out)))
            }
            _ => None,
        }
    });
    let body = Body::from_stream(stream);
    (
        [
            (
                header::CONTENT_TYPE,
                format!("multipart/x-mixed-replace; boundary={}", MJPEG_BOUNDARY),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response()
}

async fn leap_ws(
    ws: WebSocketUpgrade,
    State(hub): State<Arc<Hub>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_leap_socket(socket, hub))
}

async fn handle_leap_socket(mut socket: WebSocket, hub: Arc<Hub>) {
    let mut rx = hub.leap.subscribe();
    let _ = socket.send(Message::Text("{\"type\":\"hello\"}".into())).await;
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(frame) => {
                        if socket.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            client = socket.recv() => {
                match client {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => continue,
                }
            }
        }
    }
}

async fn leap_ingest(
    State(hub): State<Arc<Hub>>,
    body: String,
) -> impl IntoResponse {
    // Accept one JSON object or one JSON line per request. We don't parse on the
    // server — the page validates structure.
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return (StatusCode::BAD_REQUEST, "empty body").into_response();
    }
    let _ = hub.leap.send(trimmed.to_string());
    (StatusCode::OK, "ok").into_response()
}
