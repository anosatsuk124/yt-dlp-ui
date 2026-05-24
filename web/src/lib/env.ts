// Centralised access to server-side environment variables.
// Defaults match the values baked into docker-compose.yml.

export const DOWNLOADER_URL = process.env.DOWNLOADER_URL ?? "http://downloader:8080";
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/downloads";
export const COOKIES_DIR = process.env.COOKIES_DIR ?? "/cookies";
export const DB_PATH = process.env.DB_PATH ?? "/data/app.db";
export const PORT = parseInt(process.env.PORT ?? "3000", 10);
