// Centralised access to server-side environment variables.
// Defaults match the values baked into docker-compose.yml.

export const DOWNLOADER_URL = process.env.DOWNLOADER_URL ?? "http://downloader:8080";
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/downloads";
export const COOKIES_DIR = process.env.COOKIES_DIR ?? "/cookies";
export const CERTS_DIR = process.env.CERTS_DIR ?? "/certs";
export const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
export const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Desktop (Tauri) IPC transport. When set, the Go downloader is reached over a
// Unix domain socket / Windows named pipe (DOWNLOADER_SOCKET) instead of TCP,
// and this Next server listens on WEB_SOCKET instead of a TCP port — so the
// packaged app never opens a network port. Empty in Docker (TCP via DOWNLOADER_URL).
export const DOWNLOADER_SOCKET = process.env.DOWNLOADER_SOCKET ?? "";
export const WEB_SOCKET = process.env.WEB_SOCKET ?? "";
