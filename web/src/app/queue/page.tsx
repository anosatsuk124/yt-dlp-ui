"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTabState, useSeedOnce, TAB_KEYS } from "@/components/tab-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { FORMATS, type FormatKey, isFormatKey, normalizeFormatKey, formatKind } from "@/lib/formats";
import {
  CONTAINER_LABELS,
  containersFor,
  isContainerKey,
  type ContainerKey,
} from "@/lib/containers";
import { COMPATS, type CompatKey, isCompatKey } from "@/lib/compat";
import { statusBadgeClass } from "@/lib/format";
import { useJobsWs } from "@/lib/use-jobs-ws";

const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
const COMPAT_KEYS = Object.keys(COMPATS) as CompatKey[];

type Selections = Record<FormatKey, Set<ContainerKey>>;
type Resolution = "append" | "overwrite" | "save-as" | "cancel";

interface Conflict {
  url: string;
  format: FormatKey;
  container: ContainerKey;
  existingId: string;
  title: string;
}

function emptySelections(): Selections {
  return FORMAT_KEYS.reduce((acc, k) => {
    acc[k] = new Set<ContainerKey>();
    return acc;
  }, {} as Selections);
}

function comboKey(url: string, format: string, container: string): string {
  return `${url}|${format}|${container}`;
}

type AuthField =
  | "username" | "password" | "twoFactor" | "videoPassword"
  | "apMso" | "apUsername" | "apPassword"
  | "clientCertFile" | "clientCertKeyFile" | "clientCertPassword";

type AuthForm = Record<AuthField, string>;

const EMPTY_AUTH: AuthForm = {
  username: "", password: "", twoFactor: "", videoPassword: "",
  apMso: "", apUsername: "", apPassword: "",
  clientCertFile: "", clientCertKeyFile: "", clientCertPassword: "",
};

interface CertEntry { name: string; path: string }

export default function Page() {
  const { connected, jobs } = useJobsWs();
  const { toast } = useToast();

  const K = TAB_KEYS.queue;
  const [urls, setUrls] = useTabState<string>(K.urls, "");
  const [selections, setSelections] = useTabState<Selections>(K.selections, emptySelections);
  const [compat, setCompat] = useTabState<CompatKey>(K.compat, "auto");
  const [extraArgs, setExtraArgs] = useTabState<string>(K.extraArgs, "");
  const [auth, setAuth] = useTabState<AuthForm>(K.auth, EMPTY_AUTH);
  const [certs, setCerts] = useState<CertEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Conflict-resolution modal state.
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [resolution, setResolution] = useState<Resolution>("append");
  const [saveAsNames, setSaveAsNames] = useState<Record<string, string>>({});

  // Seed selections/compat from saved settings — once per provider lifetime so
  // re-mounting the tab doesn't re-apply defaults over the user's toggles.
  useSeedOnce(K.seed, store => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((s: { defaultFormat?: string; defaultContainer?: string; defaultCompat?: string }) => {
        const fmt = s.defaultFormat ? normalizeFormatKey(s.defaultFormat) : "best";
        const kind = formatKind(fmt);
        const allowed = containersFor(kind);
        const cont = s.defaultContainer && isContainerKey(s.defaultContainer) && allowed.includes(s.defaultContainer)
          ? s.defaultContainer
          : allowed[0];
        store.set<Selections>(K.selections, prev => {
          const next = emptySelections();
          // preserve any user toggles that happened before settings arrived
          for (const k of FORMAT_KEYS) next[k] = new Set(prev[k]);
          next[fmt].add(cont);
          return next;
        });
        if (s.defaultCompat && isCompatKey(s.defaultCompat)) store.set<CompatKey>(K.compat, s.defaultCompat);
      })
      .catch(() => { /* leave default */ });
  });

  // Certs are live data — re-fetch on every remount so the picker stays fresh.
  useEffect(() => {
    let canceled = false;
    fetch("/api/certs")
      .then(r => r.json())
      .then((d: { certs: CertEntry[] }) => {
        if (canceled) return;
        setCerts(d.certs ?? []);
      })
      .catch(() => { /* leave empty */ });
    return () => { canceled = true; };
  }, []);

  function toggleContainer(format: FormatKey, container: ContainerKey) {
    setSelections(prev => {
      const next: Selections = { ...prev };
      const set = new Set(prev[format]);
      if (set.has(container)) set.delete(container);
      else set.add(container);
      next[format] = set;
      return next;
    });
  }

  function buildSelectionsPayload(): { format: FormatKey; containers: ContainerKey[] }[] {
    return FORMAT_KEYS
      .map(format => ({ format, containers: Array.from(selections[format]) }))
      .filter(s => s.containers.length > 0);
  }

  function setAuthField<K extends AuthField>(k: K, v: string) {
    setAuth(a => ({ ...a, [k]: v }));
  }

  // Core POST. `res` is the conflict resolution (undefined on the first try).
  async function postJobs(
    list: string[],
    sels: { format: FormatKey; containers: ContainerKey[] }[],
    res?: Resolution,
    names?: Record<string, string>,
  ): Promise<{ status: "ok" | "conflict" | "error"; failedUrls: string[] }> {
    const authPayload: Partial<AuthForm> = {};
    for (const k of Object.keys(auth) as AuthField[]) {
      const v = auth[k].trim();
      if (v !== "") authPayload[k] = v;
    }
    try {
      const r = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: list,
          selections: sels,
          compat,
          extraArgs: extraArgs.trim() || undefined,
          auth: Object.keys(authPayload).length ? authPayload : undefined,
          resolution: res,
          saveAsNames: names,
        }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        setConflicts((data.conflicts ?? []) as Conflict[]);
        setResolution("append");
        setSaveAsNames({});
        return { status: "conflict", failedUrls: [] };
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      const n = data.jobs?.length ?? 0;
      const skipped = data.skipped?.length ?? 0;
      // URLs the downloader couldn't resolve (e.g. a playlist that failed to
      // enumerate). They are NOT queued — surface them and let the caller keep
      // them in the textarea so the user can fix/retry instead of losing them.
      const failed = (data.failed ?? []) as { url: string; error: string }[];
      if (failed.length > 0) {
        toast({
          title: n > 0 ? "Enqueued with errors" : "Could not resolve",
          description:
            `${n} job(s) queued${skipped ? `, ${skipped} skipped` : ""}, ` +
            `${failed.length} URL(s) failed to resolve (kept below): ` +
            failed.map(f => f.url).join(", "),
        });
      } else {
        toast({
          title: "Enqueued",
          description: `${n} job(s) queued${skipped ? `, ${skipped} skipped` : ""}.`,
        });
      }
      return { status: "ok", failedUrls: failed.map(f => f.url) };
    } catch (err) {
      toast({ title: "Failed to enqueue", description: (err as Error).message });
      return { status: "error", failedUrls: [] };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const list = urls.split("\n").map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      toast({ title: "No URLs", description: "Paste at least one URL." });
      return;
    }
    const sels = buildSelectionsPayload();
    if (sels.length === 0) {
      toast({ title: "No format selected", description: "Pick at least one format + container." });
      return;
    }
    setSubmitting(true);
    try {
      const result = await postJobs(list, sels);
      if (result.status === "ok") {
        if (result.failedUrls.length > 0) {
          // Partial success: keep the unresolved URLs (and auth) so the user
          // can fix and retry; the queued ones are gone from the box.
          setUrls(result.failedUrls.join("\n"));
        } else {
          setUrls("");
          setAuth(a => ({ ...a, password: "", twoFactor: "", videoPassword: "", apPassword: "", clientCertPassword: "" }));
        }
      }
      // "conflict" → modal is now open; "error" → toast already shown.
    } finally {
      setSubmitting(false);
    }
  }

  async function onResolveConfirm() {
    const list = urls.split("\n").map(s => s.trim()).filter(Boolean);
    const sels = buildSelectionsPayload();
    setSubmitting(true);
    try {
      const result = await postJobs(list, sels, resolution, resolution === "save-as" ? saveAsNames : undefined);
      if (result.status === "ok") {
        setConflicts(null);
        if (result.failedUrls.length > 0) {
          setUrls(result.failedUrls.join("\n"));
        } else {
          setUrls("");
          setAuth(a => ({ ...a, password: "", twoFactor: "", videoPassword: "", apPassword: "", clientCertPassword: "" }));
        }
      }
      // a fresh 409 would re-open with new conflicts; error keeps the modal.
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel(id: string) {
    try {
      const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Canceled" });
    } catch (err) {
      toast({ title: "Cancel failed", description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Queue</h1>
        <span className="text-xs text-muted-foreground">
          {connected ? "Live" : "Reconnecting…"}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Enqueue</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="urls">URLs (one per line)</Label>
              <Textarea
                id="urls"
                value={urls}
                onChange={e => setUrls(e.target.value)}
                rows={6}
                placeholder="https://www.youtube.com/watch?v=…"
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label>Formats &amp; containers</Label>
              <p className="text-xs text-muted-foreground">
                Tick any number of containers under any number of formats. Each
                ticked format×container pair becomes its own download (e.g. Best
                → MP4, MKV and Audio → MP3, FLAC = 4 jobs).
              </p>
              <div className="space-y-2">
                {FORMAT_KEYS.map(format => {
                  const kind = FORMATS[format].kind;
                  const allowed = containersFor(kind);
                  const set = selections[format];
                  return (
                    <div
                      key={format}
                      className="flex flex-wrap items-center gap-2 rounded-md border bg-card/30 px-3 py-2"
                    >
                      <span className="w-28 shrink-0 text-sm font-medium">
                        {FORMATS[format].label}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {allowed.map(c => (
                          <Button
                            key={c}
                            type="button"
                            size="sm"
                            variant={set.has(c) ? "default" : "outline"}
                            onClick={() => toggleContainer(format, c)}
                          >
                            {CONTAINER_LABELS[c]}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Compatibility (video only)</Label>
              <div className="flex flex-wrap gap-2">
                {COMPAT_KEYS.map(key => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={compat === key ? "default" : "outline"}
                    onClick={() => setCompat(key)}
                    title={COMPATS[key].hint}
                  >
                    {COMPATS[key].label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {COMPATS[compat].hint} iOS forces video downloads to MP4. Audio
                downloads ignore this.
              </p>
            </div>

            <details className="rounded-md border bg-card/30">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                Authentication (optional)
              </summary>
              <div className="space-y-3 border-t px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  Overrides per-domain credentials saved on the{" "}
                  <Link href="/auth" className="underline">Credentials</Link> page.
                  Empty fields fall through to the saved binding. 2FA codes
                  are accepted here only (TOTP codes expire too quickly to
                  persist).
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  <AuthInput id="qa-user"  label="Username"
                    value={auth.username} onChange={v => setAuthField("username", v)} />
                  <AuthInput id="qa-pass"  label="Password" type="password"
                    value={auth.password} onChange={v => setAuthField("password", v)} />
                  <AuthInput id="qa-2fa"   label="2FA code"
                    value={auth.twoFactor} onChange={v => setAuthField("twoFactor", v)}
                    placeholder="e.g. 123456" />
                  <AuthInput id="qa-video" label="Video password" type="password"
                    value={auth.videoPassword} onChange={v => setAuthField("videoPassword", v)} />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <AuthInput id="qa-ap-mso"  label="Adobe Pass MSO"
                    value={auth.apMso} onChange={v => setAuthField("apMso", v)} placeholder="e.g. DTV" />
                  <AuthInput id="qa-ap-user" label="Adobe Pass user"
                    value={auth.apUsername} onChange={v => setAuthField("apUsername", v)} />
                  <AuthInput id="qa-ap-pass" label="Adobe Pass password" type="password"
                    value={auth.apPassword} onChange={v => setAuthField("apPassword", v)} />
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <CertPicker id="qa-cert"     label="Client certificate"
                    value={auth.clientCertFile} onChange={v => setAuthField("clientCertFile", v)}
                    certs={certs} />
                  <CertPicker id="qa-cert-key" label="Client cert key"
                    value={auth.clientCertKeyFile} onChange={v => setAuthField("clientCertKeyFile", v)}
                    certs={certs} />
                  <AuthInput id="qa-cert-pass" label="Cert key password" type="password"
                    value={auth.clientCertPassword} onChange={v => setAuthField("clientCertPassword", v)} />
                </div>
              </div>
            </details>

            <div className="space-y-2">
              <Label htmlFor="extra-args">Advanced args (optional)</Label>
              <Input
                id="extra-args"
                value={extraArgs}
                onChange={e => setExtraArgs(e.target.value)}
                placeholder="--write-subs --sub-lang en"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Example: <code>--write-subs --sub-lang en</code>
              </p>
            </div>

            <Button type="submit" disabled={submitting}>
              {submitting ? "Enqueuing…" : "Enqueue"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Active</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active jobs.</p>
        ) : (
          jobs.map(job => (
            <Card key={job.id}>
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate font-medium"
                      title={job.title || job.url}
                    >
                      {job.title || job.url}
                    </div>
                    {job.title && (
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={job.url}
                      >
                        {job.url}
                      </div>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(job.status)}`}
                  >
                    {job.status}
                  </span>
                </div>

                <Progress value={Math.max(0, Math.min(100, job.progress ?? 0))} />

                <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                  <div className="flex gap-4">
                    <span>{(job.progress ?? 0).toFixed(1)}%</span>
                    {job.speed && <span>{job.speed}</span>}
                    {job.eta && <span>ETA {job.eta}</span>}
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => onCancel(job.id)}
                  >
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <ConflictModal
        conflicts={conflicts}
        resolution={resolution}
        setResolution={setResolution}
        saveAsNames={saveAsNames}
        setSaveAsNames={setSaveAsNames}
        onConfirm={onResolveConfirm}
        onClose={() => setConflicts(null)}
        busy={submitting}
      />
    </div>
  );
}

const RESOLUTION_OPTIONS: { value: Resolution; label: string; hint: string }[] = [
  { value: "append", label: "Append (keep both)", hint: "Download anyway; the new file coexists, distinguished by its content hash." },
  { value: "overwrite", label: "Overwrite", hint: "Delete the existing entry (local + MEGA) then re-download." },
  { value: "save-as", label: "Save as…", hint: "Keep the existing entry; save the new one under a custom name." },
  { value: "cancel", label: "Skip these", hint: "Don't re-download the conflicting items (others still queue)." },
];

function ConflictModal(props: {
  conflicts: Conflict[] | null;
  resolution: Resolution;
  setResolution: (r: Resolution) => void;
  saveAsNames: Record<string, string>;
  setSaveAsNames: (n: Record<string, string>) => void;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const { conflicts } = props;
  const open = !!conflicts && conflicts.length > 0;
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Already downloaded</DialogTitle>
          <DialogDescription>
            {conflicts?.length ?? 0} of the requested downloads already exist
            with the same URL + format + container. Choose how to proceed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-40 overflow-y-auto rounded-md border bg-card/30 p-2 text-xs">
          {conflicts?.map(c => (
            <div key={c.existingId} className="truncate py-0.5" title={`${c.title} — ${c.url}`}>
              <span className="font-medium">{c.title}</span>{" "}
              <span className="text-muted-foreground">[{c.format}/{c.container}]</span>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {RESOLUTION_OPTIONS.map(opt => (
            <label key={opt.value} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm">
              <input
                type="radio"
                name="resolution"
                className="mt-1"
                checked={props.resolution === opt.value}
                onChange={() => props.setResolution(opt.value)}
              />
              <span>
                <span className="font-medium">{opt.label}</span>
                <span className="block text-xs text-muted-foreground">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {props.resolution === "save-as" && (
          <div className="space-y-2">
            <Label className="text-xs">New names</Label>
            {conflicts?.map(c => {
              const key = comboKey(c.url, c.format, c.container);
              return (
                <Input
                  key={c.existingId}
                  value={props.saveAsNames[key] ?? ""}
                  placeholder={`${c.title} [${c.format}/${c.container}]`}
                  onChange={e =>
                    props.setSaveAsNames({ ...props.saveAsNames, [key]: e.target.value })
                  }
                  className="text-sm"
                />
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
            Dismiss
          </Button>
          <Button onClick={props.onConfirm} disabled={props.busy}>
            {props.busy ? "Working…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AuthInput(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete="off"
        className="font-mono text-sm"
      />
    </div>
  );
}

function CertPicker(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  certs: CertEntry[];
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <select
        id={props.id}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">(none)</option>
        {props.certs.map(c => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
    </div>
  );
}
