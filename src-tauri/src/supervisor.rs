//! Spawns and supervises the Go downloader + Next.js sidecars over IPC sockets,
//! gates the main window on their readiness, and tears them down on exit.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::proxy;
use crate::sockets::SocketPaths;

/// Live sidecar handles, killed on app exit.
#[derive(Default)]
pub struct Children(pub Mutex<Vec<CommandChild>>);

pub fn start(app: &AppHandle, sockets: &SocketPaths) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(Children::default());

    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    // Finished files land in the user's Downloads/yt-dlp-ui (visible, native),
    // while cookies/certs/DB stay in the private app-data dir.
    let downloads = app
        .path()
        .download_dir()
        .map(|d| d.join("yt-dlp-ui"))
        .unwrap_or_else(|_| data_dir.join("downloads"));
    let cookies = data_dir.join("cookies");
    let certs = data_dir.join("certs");
    let db_path = data_dir.join("app.db");
    for d in [&data_dir, &downloads, &cookies, &certs] {
        let _ = std::fs::create_dir_all(d);
    }

    let bin = bin_dir(app);
    let web = web_dir(app);
    // Tools (yt-dlp/ffmpeg/node) are bundled when the bin dir holds yt-dlp;
    // otherwise the app uses the system ones (e.g. the Arch package depends on
    // yt-dlp/ffmpeg/nodejs). The Go downloader defaults YTDLP_PATH to "yt-dlp"
    // and inherits PATH, so it finds the system tools without extra env.
    let tools_bundled = bin.join(tool_name("yt-dlp")).exists();

    // Go downloader sidecar (REST + SSE over its own socket); our own binary,
    // always installed next to the app.
    let mut dl = app
        .shell()
        .sidecar("downloader")?
        .env("DOWNLOADER_SOCKET", sockets.dl.as_str())
        .env("DOWNLOAD_DIR", lossy(&downloads))
        .env("COOKIES_DIR", lossy(&cookies));
    if tools_bundled {
        dl = dl
            .env("YTDLP_PATH", lossy(&bin.join(tool_name("yt-dlp"))))
            .env("PATH", prepend_path(&bin));
    }
    let (dl_rx, dl_child) = dl.spawn()?;

    // Next.js server: `node server.js` in the web dir. Prefer the bundled node
    // next to the app; fall back to the system node on PATH (Arch package).
    let bundled_node = exe_dir().map(|d| d.join(tool_name("node")));
    let node_cmd = match &bundled_node {
        Some(p) if p.exists() => app.shell().sidecar("node")?,
        _ => app.shell().command("node"),
    };
    let mut web_cmd = node_cmd
        .args(["server.js"])
        .current_dir(&web)
        .env("WEB_SOCKET", sockets.web.as_str())
        .env("DOWNLOADER_SOCKET", sockets.dl.as_str())
        .env("DB_PATH", lossy(&db_path))
        .env("DOWNLOAD_DIR", lossy(&downloads))
        .env("COOKIES_DIR", lossy(&cookies))
        .env("CERTS_DIR", lossy(&certs))
        .env("NODE_ENV", "production");
    if tools_bundled {
        web_cmd = web_cmd.env("PATH", prepend_path(&bin));
    }
    let (web_rx, web_child) = web_cmd.spawn()?;

    app.state::<Children>()
        .0
        .lock()
        .unwrap()
        .extend([dl_child, web_child]);

    drain_logs("downloader", dl_rx);
    drain_logs("web", web_rx);

    // Bridge the downloader SSE stream to the webview as Tauri events (the
    // desktop replacement for the browser WebSocket).
    crate::events::start(app.clone(), sockets.dl.clone());

    // Readiness gate: once both sockets answer, swap the splash for the app.
    let handle = app.clone();
    let socks = sockets.clone();
    tauri::async_runtime::spawn(async move {
        if wait_ready(&socks).await {
            if let Some(win) = handle.get_webview_window("main") {
                if let Err(e) = win.navigate(app_url()) {
                    eprintln!("[supervisor] navigate failed: {e}");
                }
            }
        } else {
            eprintln!("[supervisor] local services did not become ready in time");
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.eval(
                    "var s=document.querySelector('.sub');if(s)s.textContent='Failed to start local services.';",
                );
            }
        }
    });

    Ok(())
}

/// Kill every sidecar; called on ExitRequested/Exit.
pub fn shutdown(app: &AppHandle) {
    if let Some(children) = app.try_state::<Children>() {
        for child in children.0.lock().unwrap().drain(..) {
            let _ = child.kill();
        }
    }
}

async fn wait_ready(sockets: &SocketPaths) -> bool {
    // ~30s budget polling the downloader /healthz and the Next root.
    for _ in 0..150 {
        let dl_ok = proxy::get_status(&sockets.dl, "/healthz")
            .await
            .map(|s| s < 500)
            .unwrap_or(false);
        let web_ok = proxy::get_status(&sockets.web, "/")
            .await
            .map(|s| s < 500)
            .unwrap_or(false);
        if dl_ok && web_ok {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    false
}

fn drain_logs(tag: &'static str, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    eprint!("[{tag}] {}", String::from_utf8_lossy(&b));
                }
                CommandEvent::Error(e) => eprintln!("[{tag}] error: {e}"),
                CommandEvent::Terminated(p) => {
                    eprintln!("[{tag}] terminated code={:?} signal={:?}", p.code, p.signal)
                }
                _ => {}
            }
        }
    });
}

fn app_url() -> tauri::Url {
    // On Windows custom schemes are served as http://<scheme>.localhost.
    #[cfg(windows)]
    let s = "http://app.localhost/";
    #[cfg(not(windows))]
    let s = "app://localhost/";
    tauri::Url::parse(s).expect("valid app url")
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// Locate the directory containing `name` (e.g. "web"/"bin") across the layouts
// we ship: next to the executable (system install at /usr/lib/yt-dlp-ui, or a
// portable dir) and under the Tauri resource dir (deb/AppImage; flat or
// resources/-prefixed). A marker file inside the candidate confirms the match.
fn resource_subdir(app: &AppHandle, name: &str, marker: &str) -> PathBuf {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir() {
        cands.push(d.join(name));
    }
    if let Ok(rd) = app.path().resource_dir() {
        cands.push(rd.join(name));
        cands.push(rd.join("resources").join(name));
    }
    for c in &cands {
        if c.join(marker).exists() {
            return c.clone();
        }
    }
    cands
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from(name))
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
}

fn tool_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

// Directory holding the built Next.js app (server.js + node_modules + .next +
// schema.sql). Overridable in dev via YTDLPUI_WEB_DIR; bundled under the
// resource dir in production.
fn web_dir(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("YTDLPUI_WEB_DIR") {
        return PathBuf::from(p);
    }
    resource_subdir(app, "web", "server.js")
}

// Directory holding the bundled tool binaries (yt-dlp, ffmpeg, ffprobe, node);
// prepended to the downloader's PATH so yt-dlp finds ffmpeg/node.
fn bin_dir(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("YTDLPUI_BIN_DIR") {
        return PathBuf::from(p);
    }
    let marker = if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    resource_subdir(app, "bin", marker)
}

fn prepend_path(bin: &Path) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    match std::env::var("PATH") {
        Ok(cur) => format!("{}{}{}", bin.display(), sep, cur),
        Err(_) => bin.display().to_string(),
    }
}
