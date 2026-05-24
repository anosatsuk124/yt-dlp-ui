// Custom Next.js server that adds:
//   - a WebSocket endpoint at /api/ws for live progress fan-out
//   - a long-lived consumer of the downloader's SSE /events stream

import { createServer, IncomingMessage } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";

import { register, broadcast } from "./src/lib/ws-hub";
import {
  listActiveJobs,
  updateJobStatus,
  updateJobProgress,
  updateJobTitle,
  markMegaPending,
  reconcileOrphans,
} from "./src/lib/db";
import { DOWNLOADER_URL } from "./src/lib/env";
import { getJobs as getDownloaderJobs } from "./src/lib/downloader";
import { loadMegaConfig } from "./src/lib/mega";
import { enqueueMegaUpload, startMegaUploader } from "./src/lib/mega-uploader";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const hostname = "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// --- SSE consumer --------------------------------------------------------

const DB_WRITE_THROTTLE_MS = 2000;
const lastProgressWrite = new Map<string, number>();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface DownloaderEvent {
  type: "progress" | "status" | "title";
  id: string;
  status?: string;
  progress?: number;
  speed?: string;
  eta?: string;
  filePath?: string;
  title?: string;
  error?: string;
}

function applyEvent(event: DownloaderEvent) {
  if (event.type === "progress") {
    const now = Date.now();
    const last = lastProgressWrite.get(event.id) ?? 0;
    if (now - last >= DB_WRITE_THROTTLE_MS) {
      lastProgressWrite.set(event.id, now);
      try {
        updateJobProgress(event.id, event.progress ?? 0, event.speed ?? null, event.eta ?? null);
      } catch (e) { console.error("db progress update failed:", e); }
    }
  } else if (event.type === "status") {
    const now = Date.now();
    const extras: Parameters<typeof updateJobStatus>[2] = {};
    if (event.status === "running") extras.started_at = now;
    if (event.status && ["completed", "failed", "canceled"].includes(event.status)) {
      extras.finished_at = now;
    }
    if (event.filePath) extras.file_path = event.filePath;
    if (event.error) extras.error = event.error;
    try {
      updateJobStatus(event.id, event.status as any, extras);
    } catch (e) { console.error("db status update failed:", e); }
    lastProgressWrite.delete(event.id);
    if (event.status === "completed" && event.filePath) {
      try {
        if (loadMegaConfig().enabled) {
          markMegaPending(event.id);
          enqueueMegaUpload(event.id);
        }
      } catch (e) { console.error("mega enqueue failed:", e); }
    }
  } else if (event.type === "title" && event.title) {
    try {
      updateJobTitle(event.id, event.title);
    } catch { /* job may not exist yet locally */ }
  }
}

async function reconcileNow(reason: string) {
  const alive = new Set<string>();
  try {
    const jobs = await getDownloaderJobs();
    for (const j of jobs) {
      if (j.status === "queued" || j.status === "running") alive.add(j.id);
    }
  } catch (e) {
    console.log(`[reconcile/${reason}] downloader unreachable, treating all active rows as orphan:`, (e as Error).message);
  }
  try {
    const n = reconcileOrphans(alive);
    if (n > 0) console.log(`[reconcile/${reason}] marked ${n} stale job(s) as failed`);
  } catch (e) {
    console.log(`[reconcile/${reason}] failed:`, (e as Error).message);
  }
}

async function consumeEvents(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const res = await fetch(`${DOWNLOADER_URL}/events`, { signal });
      if (!res.ok || !res.body) {
        await sleep(2000);
        continue;
      }
      console.log("[sse] connected to downloader /events");
      // Every successful (re)connect: reconcile orphans. If the downloader
      // was just restarted, any DB rows still tagged 'queued'/'running' that
      // it doesn't know about get marked 'failed'.
      await reconcileNow("sse-connect");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            try {
              const ev = JSON.parse(payload) as DownloaderEvent;
              applyEvent(ev);
              broadcast(ev);
            } catch { /* ignore bad json */ }
          }
        }
      }
      console.log("[sse] downloader /events closed, reconnecting");
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.log("[sse] error, reconnecting in 2s:", (e as Error).message);
      }
    }
    await sleep(2000);
  }
}

// --- main ----------------------------------------------------------------

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url ?? "", true));
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, _req: IncomingMessage) => {
    register(ws);
    try {
      ws.send(JSON.stringify({ type: "snapshot", jobs: listActiveJobs() }));
    } catch { /* ignore */ }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = parse(req.url ?? "", true);
    if (url.pathname === "/api/ws") {
      wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  const controller = new AbortController();
  // consumeEvents calls reconcileNow on every successful (re)connect, so a
  // startup with a healthy downloader covers itself; no separate startup
  // reconciliation needed here.
  void consumeEvents(controller.signal);
  startMegaUploader();

  server.listen(port, hostname, () => {
    console.log(`> ready on http://${hostname}:${port}`);
  });

  const shutdown = () => {
    console.log("> shutting down");
    controller.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
