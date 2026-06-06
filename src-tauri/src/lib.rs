// yt-dlp-ui desktop shell.
//
// The Rust core is a thin supervisor + reverse proxy: it spawns the existing
// Go downloader and Next.js server as sidecars that talk over Unix domain
// sockets / Windows named pipes (no TCP port), proxies the webview to the Next
// sidecar via the custom `app://` URI scheme, and (in a later phase) bridges
// the downloader's SSE stream to the webview as Tauri events.

mod events;
pub mod proxy;
mod sockets;
mod supervisor;
mod transport;

pub fn run() {
    let sockets = sockets::SocketPaths::new();
    let next_sock = sockets.web.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Reverse-proxy every webview request to the Next.js sidecar. Buffered
        // responses; /api/ws is rejected (desktop uses Tauri events).
        .register_asynchronous_uri_scheme_protocol("app", move |_ctx, request, responder| {
            let sock = next_sock.clone();
            tauri::async_runtime::spawn(async move {
                let response = match proxy::forward(&sock, request).await {
                    Ok(r) => r,
                    Err(e) => proxy::error_response(e),
                };
                responder.respond(response);
            });
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            supervisor::start(&handle, &sockets)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            supervisor::shutdown(handle);
        }
    });
}
