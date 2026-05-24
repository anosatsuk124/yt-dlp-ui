import fs from "node:fs";
import path from "node:path";
import { COOKIES_DIR } from "./env";

// Resolve a URL's hostname to a cookies.txt path on disk, if one exists.
// Tries the exact host, then progressively strips subdomain labels.
// Returns the absolute container-side path that the downloader will see.
export function resolveCookiesFile(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);

  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const p = path.join(COOKIES_DIR, `${candidate}.txt`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface CookieEntry {
  domain: string;
  size: number;
  mtime: number;
}

export function listCookies(): CookieEntry[] {
  if (!fs.existsSync(COOKIES_DIR)) return [];
  return fs.readdirSync(COOKIES_DIR)
    .filter(name => name.endsWith(".txt"))
    .map(name => {
      const stat = fs.statSync(path.join(COOKIES_DIR, name));
      return {
        domain: name.replace(/\.txt$/, ""),
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// Reject anything that doesn't look like a Netscape cookie file.
export function isNetscapeCookieFile(contents: string): boolean {
  const head = contents.slice(0, 512);
  return /^#\s*(Netscape\s+)?HTTP\s+Cookie\s+File/i.test(head);
}

const VALID_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return VALID_DOMAIN.test(domain.toLowerCase());
}

export function writeCookieFile(domain: string, contents: string): void {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  const target = path.join(COOKIES_DIR, `${domain}.txt`);
  fs.writeFileSync(target, contents, { mode: 0o600 });
}

export function deleteCookieFile(domain: string): boolean {
  if (!isValidDomain(domain)) return false;
  const target = path.join(COOKIES_DIR, `${domain}.txt`);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}
