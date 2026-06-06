//! Headless check of the reverse proxy without opening a window.
//! Run with: cargo run --example proxy_smoke -- <socket-path> [request-path]
//!
//! Kept as an example (not a bin) so the Tauri bundler only ever sees the one
//! application binary.

use std::env;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: proxy_smoke <socket-path> [request-path]");
        std::process::exit(2);
    }
    let socket = &args[1];
    let path = args.get(2).map(String::as_str).unwrap_or("/");

    let req = tauri::http::Request::builder()
        .method("GET")
        .uri(path)
        .body(Vec::<u8>::new())
        .expect("build request");

    match ytdlp_ui_lib::proxy::forward(socket, req).await {
        Ok(resp) => {
            let body = resp.body();
            let n = body.len();
            let preview = String::from_utf8_lossy(&body[..n.min(400)]);
            println!("STATUS {}\nLEN {}\n{}", resp.status(), n, preview);
        }
        Err(e) => {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}
