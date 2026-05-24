import fs from "node:fs";
import path from "node:path";
import { CERTS_DIR } from "./env";

// Files are listed by their on-disk basename so the UI can show meaningful
// labels (e.g. "youtube-mso.cert.pem") and per-domain bindings can store
// the absolute container path (e.g. /certs/youtube-mso.cert.pem) directly,
// the same way cookies bindings store /cookies/example.com.txt.
export interface CertEntry {
  name:  string;   // basename, with extension
  size:  number;
  mtime: number;
  path:  string;   // absolute container path (what the downloader will see)
}

export function listCerts(): CertEntry[] {
  if (!fs.existsSync(CERTS_DIR)) return [];
  return fs.readdirSync(CERTS_DIR)
    .filter(name => CERT_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext)))
    .map(name => {
      const full = path.join(CERTS_DIR, name);
      const stat = fs.statSync(full);
      return { name, size: stat.size, mtime: stat.mtimeMs, path: full };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CERT_EXTENSIONS = [".pem", ".crt", ".cer", ".key"];

// Filenames must be a short slug (plus extension) so they can't escape the
// certs dir and don't surprise the user. We also reject anything not ending
// in a known cert/key extension.
const VALID_CERT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export function isValidCertName(name: string): boolean {
  if (!VALID_CERT_NAME.test(name)) return false;
  if (name.includes("..")) return false;
  const lower = name.toLowerCase();
  return CERT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Sniff a PEM file. We accept any "-----BEGIN ..." block, which covers
// CERTIFICATE, PRIVATE KEY, ENCRYPTED PRIVATE KEY, EC PRIVATE KEY, and
// RSA PRIVATE KEY. We don't try to parse DER — if the user has a DER cert
// they can wrap it in PEM first.
export function isPemFile(contents: string): boolean {
  return /-----BEGIN [A-Z ]+-----/.test(contents.slice(0, 256));
}

export function writeCertFile(name: string, contents: string): string {
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const target = path.join(CERTS_DIR, name);
  fs.writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

export function deleteCertFile(name: string): boolean {
  if (!isValidCertName(name)) return false;
  const target = path.join(CERTS_DIR, name);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

// Resolve a basename to its absolute container path, asserting the file
// exists and the name is well-formed. Used by API routes that accept a cert
// reference from the client.
export function resolveCertPath(name: string): string | null {
  if (!isValidCertName(name)) return null;
  const full = path.join(CERTS_DIR, name);
  return fs.existsSync(full) ? full : null;
}

// Convert a stored absolute path back to its basename, for display in the UI.
export function certBasename(absPath: string | null): string | null {
  if (!absPath) return null;
  return path.basename(absPath);
}
