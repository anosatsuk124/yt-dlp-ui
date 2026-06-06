//! Bridges the Go downloader's SSE `/events` stream to the webview as Tauri
//! events. The webview can't open a WebSocket through the custom protocol, so on
//! desktop the live job updates arrive as `downloader-event` Tauri events
//! instead. The Go EventBus fans out to multiple subscribers, so this runs
//! alongside the Next.js server's own SSE consumer (which owns the DB writes).

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use tauri::{AppHandle, Emitter};

use crate::transport;

pub const EVENT_NAME: &str = "downloader-event";

/// Spawn the long-lived bridge task (reconnects with a fixed backoff).
pub fn start(app: AppHandle, dl_socket: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = stream_once(&app, &dl_socket).await {
                eprintln!("[events] sse: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        }
    });
}

async fn stream_once(app: &AppHandle, socket: &str) -> Result<(), String> {
    let stream = transport::connect(socket)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req = hyper::Request::builder()
        .method("GET")
        .uri("/events")
        .header("host", "localhost")
        .body(Full::new(Bytes::new()))
        .map_err(|e| e.to_string())?;
    let res = sender.send_request(req).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("status {}", res.status()));
    }

    let mut body = res.into_body();
    let mut buf = String::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| e.to_string())?;
        let Ok(data) = frame.into_data() else { continue };
        buf.push_str(&String::from_utf8_lossy(&data));
        // SSE frames are separated by a blank line.
        while let Some(idx) = buf.find("\n\n") {
            let raw: String = buf.drain(..idx + 2).collect();
            for line in raw.lines() {
                let Some(payload) = line.strip_prefix("data: ") else {
                    continue;
                };
                let payload = payload.trim();
                if payload.is_empty() {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                    let _ = app.emit(EVENT_NAME, json);
                }
            }
        }
    }
    Ok(())
}
