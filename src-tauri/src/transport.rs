//! Per-OS connector to a sidecar IPC endpoint: a Unix domain socket on Unix, a
//! named pipe on Windows. Returns a concrete async stream the proxy/event
//! bridge drive HTTP/1 over with hyper.

#[cfg(unix)]
pub use imp::*;
#[cfg(windows)]
pub use imp::*;

#[cfg(unix)]
mod imp {
    use tokio::net::UnixStream;

    pub type Stream = UnixStream;

    pub async fn connect(path: &str) -> std::io::Result<Stream> {
        UnixStream::connect(path).await
    }
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    pub type Stream = NamedPipeClient;

    // ERROR_PIPE_BUSY: all pipe instances are busy; the server will free one.
    const ERROR_PIPE_BUSY: i32 = 231;

    pub async fn connect(path: &str) -> std::io::Result<Stream> {
        loop {
            match ClientOptions::new().open(path) {
                Ok(client) => return Ok(client),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}
