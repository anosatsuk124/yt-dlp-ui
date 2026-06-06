//! Reverse proxy from the webview's custom `app://` scheme to the Next.js
//! sidecar over the IPC socket. The full response is buffered (fine for SSR
//! pages, `/_next/*` assets, and JSON APIs); large file downloads bypass the
//! proxy via a native open/reveal action, so buffering is not a memory risk.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use tauri::http::{Request, Response, StatusCode};

use crate::transport;

// Hop-by-hop / connection-managed headers that must not be forwarded verbatim.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

fn is_hop(name: &str) -> bool {
    HOP_BY_HOP.iter().any(|h| name.eq_ignore_ascii_case(h))
}

/// Forward one webview request to the Next sidecar at `socket`, returning the
/// buffered response.
pub async fn forward(socket: &str, req: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    // WebSocket upgrades cannot traverse a custom protocol; the desktop UI gets
    // live updates via Tauri events instead, so reject this path explicitly.
    if req.uri().path() == "/api/ws" {
        return Ok(text(
            StatusCode::NOT_IMPLEMENTED,
            "websocket is not proxied; desktop uses Tauri events",
        ));
    }

    let stream = transport::connect(socket)
        .await
        .map_err(|e| format!("connect {socket}: {e}"))?;
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| format!("handshake: {e}"))?;
    // Drive the connection on the same runtime; it ends when the response is read.
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let (parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    let mut builder = hyper::Request::builder().method(parts.method).uri(pq);
    for (name, value) in parts.headers.iter() {
        let n = name.as_str();
        if n.eq_ignore_ascii_case("host") || is_hop(n) {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder.header("host", "localhost");
    let out = builder
        .body(Full::new(Bytes::from(body)))
        .map_err(|e| format!("build request: {e}"))?;

    let res = sender
        .send_request(out)
        .await
        .map_err(|e| format!("send request: {e}"))?;
    let (rparts, rbody) = res.into_parts();
    let bytes = rbody
        .collect()
        .await
        .map_err(|e| format!("read response body: {e}"))?
        .to_bytes();

    let mut rb = Response::builder().status(rparts.status);
    for (name, value) in rparts.headers.iter() {
        if is_hop(name.as_str()) {
            continue;
        }
        rb = rb.header(name, value);
    }
    rb.body(bytes.to_vec())
        .map_err(|e| format!("build response: {e}"))
}

/// Minimal GET used by the readiness gate; returns the HTTP status code.
pub async fn get_status(socket: &str, path: &str) -> Result<u16, String> {
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
        .uri(path)
        .header("host", "localhost")
        .body(Full::new(Bytes::new()))
        .map_err(|e| e.to_string())?;
    let res = sender.send_request(req).await.map_err(|e| e.to_string())?;
    Ok(res.status().as_u16())
}

pub fn error_response(msg: String) -> Response<Vec<u8>> {
    text(StatusCode::BAD_GATEWAY, &format!("proxy error: {msg}"))
}

fn text(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .expect("static text response")
}
