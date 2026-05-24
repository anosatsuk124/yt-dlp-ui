// In-process pub/sub for WebSocket clients. The custom server (server.ts)
// registers/unregisters sockets here; the SSE consumer of the downloader
// publishes events here for fan-out.
//
// Only used in the Node server runtime, never in the edge/serverless one.

import type { WebSocket } from "ws";

const clients = new Set<WebSocket>();

export function register(ws: WebSocket): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
}

export function broadcast(message: unknown): void {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
