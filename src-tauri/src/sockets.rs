//! Ephemeral IPC endpoint paths for this app instance.
//!
//! Unix domain sockets (Linux/macOS) live under XDG_RUNTIME_DIR (per-user,
//! cleaned on logout) or the temp dir; Windows uses named pipes. The pid keeps
//! concurrent instances from colliding.

#[derive(Clone)]
pub struct SocketPaths {
    /// The Next.js server endpoint (the webview proxy target).
    pub web: String,
    /// The Go downloader endpoint (REST + SSE).
    pub dl: String,
}

impl SocketPaths {
    pub fn new() -> Self {
        let pid = std::process::id();

        #[cfg(windows)]
        {
            SocketPaths {
                web: format!(r"\\.\pipe\ytdlpui-web-{pid}"),
                dl: format!(r"\\.\pipe\ytdlpui-dl-{pid}"),
            }
        }

        #[cfg(unix)]
        {
            let dir = std::env::var("XDG_RUNTIME_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir());
            let p = |name: String| dir.join(name).to_string_lossy().into_owned();
            SocketPaths {
                web: p(format!("ytdlpui-web-{pid}.sock")),
                dl: p(format!("ytdlpui-dl-{pid}.sock")),
            }
        }
    }
}
