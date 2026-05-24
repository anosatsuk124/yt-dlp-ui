// Thin wrapper around the `megajs` SDK. Only used inside the Node server
// process (server.ts and its background uploader). Never imported from
// client components.

import fs from "node:fs";
import path from "node:path";
// `megajs` ships TypeScript declarations that reference Deno-flavored or
// `node-fetch` types we don't have installed; the runtime API is fine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { Storage } from "megajs";
import { getSetting } from "./db";

export interface MegaConfig {
  enabled: boolean;
  email: string;
  password: string;
  folder: string;
}

export const DEFAULT_MEGA_FOLDER = "/yt-dlp-ui";

export function loadMegaConfig(): MegaConfig {
  const enabled = getSetting("mega_enabled") === "true";
  const email = getSetting("mega_email") ?? "";
  const password = getSetting("mega_password") ?? "";
  const folder = getSetting("mega_folder") || DEFAULT_MEGA_FOLDER;
  return {
    enabled: enabled && !!email && !!password,
    email,
    password,
    folder,
  };
}

function normalizeFolderPath(p: string): string[] {
  return p.split("/").map(s => s.trim()).filter(Boolean);
}

export class MegaClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private storage: any | null = null;

  async connect(email: string, password: string): Promise<void> {
    const storage = new Storage({ email, password, autologin: true });
    await storage.ready;
    this.storage = storage;
  }

  // Walk an absolute path (e.g. "/yt-dlp-ui/sub"), creating any missing
  // segment under the user's Cloud Drive root. Returns the leaf folder node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ensureFolder(folderPath: string): Promise<any> {
    if (!this.storage) throw new Error("mega client not connected");
    const parts = normalizeFolderPath(folderPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = this.storage.root;
    for (const name of parts) {
      const existing = (node.children ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => c.directory && c.name === name,
      );
      if (existing) {
        node = existing;
      } else {
        node = await node.mkdir({ name });
      }
    }
    return node;
  }

  // Upload a local file into the given folder node. Resolves to the final
  // remote MutableFile (we don't read anything off it today).
  //
  // `onProgress`, if given, is invoked with the running (uploadedBytes, totalBytes)
  // pair every time a chunk flows through the read stream. The caller is
  // expected to throttle DB writes / broadcasts from this — it can fire
  // dozens of times per second.
  async uploadFile(
    localPath: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    folderNode: any,
    onProgress?: (uploaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.storage) throw new Error("mega client not connected");
    if (signal?.aborted) throw new Error("aborted");
    const stat = await fs.promises.stat(localPath);
    const total = stat.size;
    const name = path.basename(localPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadStream: any = folderNode.upload({ name, size: total });
    const readStream = fs.createReadStream(localPath);
    if (onProgress) {
      let uploaded = 0;
      readStream.on("data", (chunk: Buffer | string) => {
        uploaded += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        onProgress(uploaded, total);
      });
    }
    const onAbort = () => {
      const err = new Error("aborted");
      try { readStream.destroy(err); } catch { /* ignore */ }
      try { uploadStream.destroy?.(err); } catch { /* ignore */ }
    };
    if (signal) signal.addEventListener("abort", onAbort);
    try {
      readStream.pipe(uploadStream);
      await uploadStream.complete;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw new Error("aborted");
  }

  async disconnect(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.close();
    } catch { /* ignore */ }
    this.storage = null;
  }
}
