// yt-dlp-ui desktop shell.
//
// The Rust core is a thin supervisor + reverse proxy: it spawns the existing
// Go downloader and Next.js server as sidecars that talk over Unix domain
// sockets / Windows named pipes (no TCP port), proxies the webview to the Next
// sidecar via a custom URI scheme, and bridges the downloader's SSE stream to
// the webview as Tauri events. The proxy/supervisor/event-bridge modules are
// filled in across the build phases; this file wires the Tauri builder.

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Sidecar supervisor, reverse proxy, and SSE->event bridge are
            // registered here in later phases.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
