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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async uploadFile(localPath: string, folderNode: any): Promise<void> {
    if (!this.storage) throw new Error("mega client not connected");
    const stat = await fs.promises.stat(localPath);
    const name = path.basename(localPath);
    const uploadStream = folderNode.upload({ name, size: stat.size });
    fs.createReadStream(localPath).pipe(uploadStream);
    await uploadStream.complete;
  }

  async disconnect(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.close();
    } catch { /* ignore */ }
    this.storage = null;
  }
}
