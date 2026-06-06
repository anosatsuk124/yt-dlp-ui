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
  folder: string;       // destination for video downloads
  audioFolder: string;  // destination for audio-only downloads (folder/<audioSubdir>)
  // Global default: keep the local copy after a successful MEGA upload instead
  // of deleting it. Per-job overrides (jobs.mega_keep_local) take precedence.
  keepLocal: boolean;
}

export const DEFAULT_MEGA_FOLDER = "/yt-dlp-ui";
export const DEFAULT_AUDIO_SUBDIR = "audio";

function joinMegaPath(folder: string, sub: string): string {
  const f = folder.replace(/\/+$/, "");
  const s = sub.replace(/^\/+|\/+$/g, "");
  return s ? `${f}/${s}` : f;
}

export function loadMegaConfig(): MegaConfig {
  const enabled = getSetting("mega_enabled") === "true";
  const email = getSetting("mega_email") ?? "";
  const password = getSetting("mega_password") ?? "";
  const folder = getSetting("mega_folder") || DEFAULT_MEGA_FOLDER;
  const audioSub = getSetting("mega_audio_subdir") || DEFAULT_AUDIO_SUBDIR;
  return {
    enabled: enabled && !!email && !!password,
    email,
    password,
    folder,
    audioFolder: joinMegaPath(folder, audioSub),
    keepLocal: getSetting("mega_keep_local") === "true",
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
    // megajs's `uploadStream.complete` does not reject when the underlying
    // streams are destroyed — it just hangs. We race it against a promise
    // that rejects synchronously on abort, so a cancel actually unblocks
    // the await even if megajs's HTTP requests keep churning in the
    // background until they fail naturally.
    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const onAbortDestroy = () => {
      const err = new Error("aborted");
      try { readStream.destroy(err); } catch { /* ignore */ }
      try { uploadStream.destroy?.(err); } catch { /* ignore */ }
    };
    if (signal) signal.addEventListener("abort", onAbortDestroy, { once: true });
    try {
      readStream.pipe(uploadStream);
      await Promise.race([uploadStream.complete, abortPromise]);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbortDestroy);
    }
    if (signal?.aborted) throw new Error("aborted");
  }

  // Delete a file node by name directly under the given folder node. Returns
  // true if a node was found and deletion was requested. Used for overwrite /
  // maintenance passes that must replace an already-uploaded remote file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async deleteByName(folderNode: any, name: string): Promise<boolean> {
    if (!this.storage) throw new Error("mega client not connected");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (folderNode.children ?? []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => !c.directory && c.name === name,
    );
    if (!target) return false;
    await target.delete(true); // permanent delete (skip Rubbish Bin)
    return true;
  }

  // Find a file node (not a folder) by name directly under a folder node.
  // Returns the node or null. Same lookup pattern as deleteByName.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findFile(folderNode: any, name: string): any | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (folderNode.children ?? []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => !c.directory && c.name === name,
    ) ?? null;
  }

  // Stream a remote file node's content to a local path. Resolves when the
  // write finishes. `onProgress`, if given, receives (downloaded, total).
  async downloadFile(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<void> {
    if (!this.storage) throw new Error("mega client not connected");
    const total = typeof node.size === "number" ? node.size : 0;
    await new Promise<void>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dl: any = node.download({ maxConnections: 4 });
      const out = fs.createWriteStream(destPath);
      if (onProgress) {
        dl.on("progress", (e: { bytesLoaded?: number; bytesTotal?: number }) => {
          onProgress(e.bytesLoaded ?? 0, e.bytesTotal ?? total);
        });
      }
      dl.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
      dl.pipe(out);
    });
  }

  // Rename a remote node in place — updates the name attribute only, no bytes
  // are re-uploaded. Used to embed the content hash into an already-uploaded
  // file's name without re-transferring it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async renameFile(node: any, newName: string): Promise<void> {
    if (!this.storage) throw new Error("mega client not connected");
    await node.rename(newName);
  }

  async disconnect(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.close();
    } catch { /* ignore */ }
    this.storage = null;
  }
}
