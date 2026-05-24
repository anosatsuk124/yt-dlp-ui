"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { FORMATS, type FormatKey, isFormatKey } from "@/lib/formats";
import { CONTAINERS, type ContainerKey, isContainerKey } from "@/lib/containers";
import { COMPATS, type CompatKey, isCompatKey } from "@/lib/compat";
import { statusBadgeClass } from "@/lib/format";
import { useJobsWs } from "@/lib/use-jobs-ws";

const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
const CONTAINER_KEYS = Object.keys(CONTAINERS) as ContainerKey[];
const COMPAT_KEYS = Object.keys(COMPATS) as CompatKey[];

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

  const [urls, setUrls] = useState("");
  const [format, setFormat] = useState<FormatKey>("best");
  const [container, setContainer] = useState<ContainerKey>("auto");
  const [compat, setCompat] = useState<CompatKey>("auto");
  const [extraArgs, setExtraArgs] = useState("");
  const [auth, setAuth] = useState<AuthForm>(EMPTY_AUTH);
  const [certs, setCerts] = useState<CertEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Seed the presets from saved settings on mount.
  useEffect(() => {
    let canceled = false;
    fetch("/api/settings")
      .then(r => r.json())
      .then((s: { defaultFormat?: string; defaultContainer?: string; defaultCompat?: string }) => {
        if (canceled) return;
        if (s.defaultFormat && isFormatKey(s.defaultFormat)) setFormat(s.defaultFormat);
        if (s.defaultContainer && isContainerKey(s.defaultContainer)) setContainer(s.defaultContainer);
        if (s.defaultCompat && isCompatKey(s.defaultCompat)) setCompat(s.defaultCompat);
      })
      .catch(() => { /* leave default */ });
    fetch("/api/certs")
      .then(r => r.json())
      .then((d: { certs: CertEntry[] }) => {
        if (canceled) return;
        setCerts(d.certs ?? []);
      })
      .catch(() => { /* leave empty */ });
    return () => { canceled = true; };
  }, []);

  function setAuthField<K extends AuthField>(k: K, v: string) {
    setAuth(a => ({ ...a, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const list = urls.split("\n").map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      toast({ title: "No URLs", description: "Paste at least one URL." });
      return;
    }
    // Strip empty auth fields so the request body stays small and the
    // server's "empty = leave alone" semantics work for per-job overrides.
    const authPayload: Partial<AuthForm> = {};
    for (const k of Object.keys(auth) as AuthField[]) {
      const v = auth[k].trim();
      if (v !== "") authPayload[k] = v;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: list,
          format,
          container,
          compat,
          extraArgs: extraArgs.trim() || undefined,
          auth: Object.keys(authPayload).length ? authPayload : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Enqueued", description: `${data.jobs?.length ?? list.length} job(s) queued.` });
      setUrls("");
      // Clear ephemeral secrets (2FA expires in seconds; cleartext passwords
      // shouldn't linger in the input). Leave non-secret fields alone in
      // case the user is queueing more URLs against the same site.
      setAuth(a => ({ ...a, password: "", twoFactor: "", videoPassword: "", apPassword: "", clientCertPassword: "" }));
    } catch (err) {
      toast({ title: "Failed to enqueue", description: (err as Error).message });
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
              <Label>Format preset</Label>
              <div className="flex flex-wrap gap-2">
                {FORMAT_KEYS.map(key => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={format === key ? "default" : "outline"}
                    onClick={() => setFormat(key)}
                  >
                    {FORMATS[key].label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Live streams (e.g. <code>live.nicovideo.jp</code>) often
                expose non-numeric format names (<code>high</code>/
                <code>normal</code>/…). If <em>1080p</em> / <em>720p</em>{" "}
                returns <code>Requested format is not available</code>,
                retry with <strong>best</strong>.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Container</Label>
              <div className="flex flex-wrap gap-2">
                {CONTAINER_KEYS.map(key => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={container === key ? "default" : "outline"}
                    onClick={() => setContainer(key)}
                    disabled={format === "audio" || compat === "ios"}
                    title={
                      format === "audio" ? "n/a for audio-only" :
                      compat === "ios" ? "iOS compatibility forces MP4" :
                      undefined
                    }
                  >
                    {CONTAINERS[key].label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Output container. Auto leaves it to yt-dlp; others remux to
                that format (no re-encode unless codec-incompatible).
              </p>
            </div>

            <div className="space-y-2">
              <Label>Compatibility</Label>
              <div className="flex flex-wrap gap-2">
                {COMPAT_KEYS.map(key => (
                  <Button
                    key={key}
                    type="button"
                    size="sm"
                    variant={compat === key ? "default" : "outline"}
                    onClick={() => setCompat(key)}
                    disabled={format === "audio"}
                    title={format === "audio" ? "n/a for audio-only" : COMPATS[key].hint}
                  >
                    {COMPATS[key].label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {COMPATS[compat].hint}
              </p>
            </div>

            <details className="rounded-md border bg-card/30">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                Authentication (optional)
              </summary>
              <div className="space-y-3 border-t px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  Overrides per-domain credentials saved on the{" "}
                  <a href="/auth" className="underline">Credentials</a> page.
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
    </div>
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
