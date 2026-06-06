//! Background update check. Notifies (non-intrusively) when a newer release is
//! published; the actual download/install can be triggered from the UI via the
//! updater JS API (the plugin + capability are wired up). Keeping the app
//! current is also how the bundled yt-dlp/ffmpeg get refreshed.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

pub fn check_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let the window/services settle before reaching out to the network.
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    let _ = app
                        .notification()
                        .builder()
                        .title("Update available")
                        .body(format!("yt-dlp-ui {} is available", update.version))
                        .show();
                }
                Ok(None) => {}
                Err(e) => eprintln!("[updater] check failed: {e}"),
            },
            Err(e) => eprintln!("[updater] unavailable: {e}"),
        }
    });
}
