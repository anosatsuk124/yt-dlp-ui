import { getAuthBinding, type AuthBindingRow } from "./db";

// AuthOptions is the merged set of yt-dlp credentials forwarded to the
// downloader. Every field is optional; empty/missing values become no-ops
// in the Go-side argv builder. The shape matches the JSON tags on Job in
// downloader/cmd/downloader/main.go.
export interface AuthOptions {
  username?:           string;
  password?:           string;
  twoFactor?:          string;
  videoPassword?:      string;
  apMso?:              string;
  apUsername?:         string;
  apPassword?:         string;
  clientCertFile?:     string;
  clientCertKeyFile?:  string;
  clientCertPassword?: string;
}

// Fields that may be persisted as a per-domain binding. twoFactor is
// intentionally absent — TOTP codes expire in seconds, so we only accept
// them as per-job inputs.
export const BINDABLE_AUTH_KEYS = [
  "username",
  "password",
  "videoPassword",
  "apMso",
  "apUsername",
  "apPassword",
  "clientCertFile",
  "clientCertKeyFile",
  "clientCertPassword",
] as const satisfies ReadonlyArray<keyof AuthOptions>;

export type BindableAuthKey = (typeof BINDABLE_AUTH_KEYS)[number];

// All keys (including twoFactor) accepted on a per-job override.
export const ALL_AUTH_KEYS = [
  ...BINDABLE_AUTH_KEYS,
  "twoFactor",
] as const satisfies ReadonlyArray<keyof AuthOptions>;

// Keys whose values are sensitive and must never be echoed back via the API.
export const SECRET_AUTH_KEYS = new Set<keyof AuthOptions>([
  "password",
  "videoPassword",
  "apPassword",
  "clientCertPassword",
  "twoFactor",
]);

const ROW_TO_OPT: Record<BindableAuthKey, keyof AuthBindingRow> = {
  username:           "username",
  password:           "password",
  videoPassword:      "video_password",
  apMso:              "ap_mso",
  apUsername:         "ap_username",
  apPassword:         "ap_password",
  clientCertFile:     "client_cert_file",
  clientCertKeyFile:  "client_cert_key_file",
  clientCertPassword: "client_cert_password",
};

const OPT_TO_ROW: Record<BindableAuthKey, keyof AuthBindingRow> = ROW_TO_OPT;

export function rowToOptions(row: AuthBindingRow): AuthOptions {
  const out: AuthOptions = {};
  for (const k of BINDABLE_AUTH_KEYS) {
    const v = row[ROW_TO_OPT[k]];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// Convert an incoming patch (camelCase keys) into the snake_case row patch
// the DB layer expects. Unknown keys are dropped.
export function optionsToRowPatch(
  patch: Partial<AuthOptions>,
): Partial<Record<keyof AuthBindingRow, string | null>> {
  const out: Partial<Record<keyof AuthBindingRow, string | null>> = {};
  for (const k of BINDABLE_AUTH_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    out[OPT_TO_ROW[k]] = v === "" ? null : v;
  }
  return out;
}

// Resolve the URL's hostname to a per-domain auth binding, with subdomain
// stripping. Same matching strategy as resolveCookiesFile in cookies.ts so
// the two stores feel symmetrical.
export function resolveAuthBinding(rawUrl: string): AuthOptions | null {
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
    const row = getAuthBinding(candidate);
    if (row) return rowToOptions(row);
  }
  return null;
}

// Field-by-field merge. `override` wins where it has a non-empty value;
// anything else falls through to `base`. Empty strings are treated as
// "not provided" so the UI can leave a field blank without clobbering a
// per-domain binding.
export function mergeAuth(
  base: AuthOptions | null,
  override: AuthOptions | null,
): AuthOptions | null {
  const result: AuthOptions = { ...(base ?? {}) };
  if (override) {
    for (const k of ALL_AUTH_KEYS) {
      const v = override[k];
      if (v !== undefined && v !== "") result[k] = v;
    }
  }
  return hasAny(result) ? result : null;
}

export function hasAny(opts: AuthOptions): boolean {
  for (const k of ALL_AUTH_KEYS) {
    if (opts[k]) return true;
  }
  return false;
}

// Returned to the UI so it can show "saved" indicators without revealing the
// underlying secret. Mirrors the mega.hasPassword convention.
export interface AuthBindingPublic {
  domain:                  string;
  username:                string | null;
  apMso:                   string | null;
  apUsername:              string | null;
  clientCertFile:          string | null;
  clientCertKeyFile:       string | null;
  hasPassword:             boolean;
  hasVideoPassword:        boolean;
  hasApPassword:           boolean;
  hasClientCertPassword:   boolean;
  createdAt:               number;
  updatedAt:               number;
}

export function redactBinding(row: AuthBindingRow): AuthBindingPublic {
  return {
    domain:                row.domain,
    username:              row.username,
    apMso:                 row.ap_mso,
    apUsername:            row.ap_username,
    clientCertFile:        row.client_cert_file,
    clientCertKeyFile:     row.client_cert_key_file,
    hasPassword:           !!row.password,
    hasVideoPassword:      !!row.video_password,
    hasApPassword:         !!row.ap_password,
    hasClientCertPassword: !!row.client_cert_password,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
  };
}

// Coerce an arbitrary incoming JSON body into an AuthOptions patch. Anything
// not on the allowlist is dropped. Values are trimmed; non-strings are
// rejected by returning undefined for that field.
export function sanitizeAuthPatch(
  input: unknown,
  { allowTwoFactor = false }: { allowTwoFactor?: boolean } = {},
): Partial<AuthOptions> {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const out: Partial<AuthOptions> = {};
  const keys: ReadonlyArray<keyof AuthOptions> =
    allowTwoFactor ? ALL_AUTH_KEYS : BINDABLE_AUTH_KEYS;
  for (const k of keys) {
    if (!(k in src)) continue;
    const v = src[k];
    if (v === null) { out[k] = ""; continue; }   // null = explicit clear
    if (typeof v !== "string") continue;          // ignore wrong types
    out[k] = v.trim();
  }
  return out;
}
