"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/use-toast";
import { timeAgo } from "@/lib/format";

interface BindingPublic {
  domain:                 string;
  username:               string | null;
  apMso:                  string | null;
  apUsername:             string | null;
  clientCertFile:         string | null;
  clientCertKeyFile:      string | null;
  hasPassword:            boolean;
  hasVideoPassword:       boolean;
  hasApPassword:          boolean;
  hasClientCertPassword:  boolean;
  createdAt:              number;
  updatedAt:              number;
}

interface CertEntry { name: string; path: string }

type Field =
  | "username"
  | "password"
  | "videoPassword"
  | "apMso"
  | "apUsername"
  | "apPassword"
  | "clientCertFile"
  | "clientCertKeyFile"
  | "clientCertPassword";

type FormState = Record<Field, string>;

const EMPTY_FORM: FormState = {
  username: "", password: "", videoPassword: "",
  apMso: "", apUsername: "", apPassword: "",
  clientCertFile: "", clientCertKeyFile: "", clientCertPassword: "",
};

// Take the last segment of a stored absolute path (e.g. /certs/foo.pem → foo.pem).
function basename(p: string | null): string {
  if (!p) return "";
  const ix = p.lastIndexOf("/");
  return ix >= 0 ? p.slice(ix + 1) : p;
}

export default function Page() {
  const { toast } = useToast();
  const [bindings, setBindings] = useState<BindingPublic[]>([]);
  const [certs, setCerts] = useState<CertEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [domain, setDomain] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<BindingPublic | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/auth").then(r => r.json()),
      fetch("/api/certs").then(r => r.json()),
    ])
      .then(([a, c]) => {
        setBindings((a.bindings ?? []) as BindingPublic[]);
        setCerts((c.certs ?? []) as CertEntry[]);
      })
      .catch(() => { /* keep stale */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setEditing(null);
    setDomain("");
    setForm(EMPTY_FORM);
  }

  function startEdit(b: BindingPublic) {
    setEditing(b);
    setDomain(b.domain);
    setForm({
      ...EMPTY_FORM,
      username:          b.username  ?? "",
      apMso:             b.apMso     ?? "",
      apUsername:        b.apUsername ?? "",
      clientCertFile:    basename(b.clientCertFile),
      clientCertKeyFile: basename(b.clientCertKeyFile),
      // password fields stay blank — placeholder hints whether one is saved.
    });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fieldChange<K extends Field>(k: K, v: string) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const d = domain.trim().toLowerCase();
    if (!d) {
      toast({ title: "Domain required" });
      return;
    }

    // Build patch: empty password-style fields = "leave unchanged" on edit,
    // empty plain-text fields = "leave unchanged" too. Use the clear button
    // for explicit nulls (not implemented as a separate control yet — the
    // delete-binding flow covers the bulk case).
    const patch: Partial<Record<Field, string>> = {};
    for (const k of Object.keys(form) as Field[]) {
      const v = form[k].trim();
      if (v !== "") patch[k] = v;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/auth/${encodeURIComponent(d)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: editing ? "Updated" : "Saved", description: d });
      resetForm();
      load();
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(d: string) {
    if (!window.confirm(`Delete credentials for ${d}?`)) return;
    try {
      const res = await fetch(`/api/auth/${encodeURIComponent(d)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Deleted", description: d });
      if (editing?.domain === d) resetForm();
      load();
    } catch (err) {
      toast({ title: "Delete failed", description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Credentials</h1>
      <p className="text-sm text-muted-foreground">
        Per-domain yt-dlp credentials. Applied automatically when the
        URL&rsquo;s hostname matches (with subdomain stripping). Per-job
        inputs on the Queue form override these field-by-field. 2FA codes
        are entered per-job only.
      </p>

      <Card ref={formRef}>
        <CardHeader>
          <CardTitle className="text-lg">
            {editing ? `Edit ${editing.domain}` : "New binding"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="auth-domain">Domain</Label>
              <Input
                id="auth-domain"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                placeholder="example.com"
                required
                disabled={!!editing}
                className="font-mono"
              />
            </div>

            <fieldset className="grid gap-3 md:grid-cols-2">
              <PassField id="auth-user" label="Username"
                value={form.username} onChange={v => fieldChange("username", v)} />
              <PassField id="auth-pass" label="Password" type="password"
                value={form.password} onChange={v => fieldChange("password", v)}
                placeholder={editing?.hasPassword ? "(saved — leave blank to keep)" : ""} />
              <PassField id="auth-video-pass" label="Video password" type="password"
                value={form.videoPassword} onChange={v => fieldChange("videoPassword", v)}
                placeholder={editing?.hasVideoPassword ? "(saved — leave blank to keep)" : ""} />
            </fieldset>

            <fieldset className="grid gap-3 md:grid-cols-3">
              <PassField id="auth-ap-mso" label="Adobe Pass MSO"
                value={form.apMso} onChange={v => fieldChange("apMso", v)}
                placeholder="e.g. DTV" />
              <PassField id="auth-ap-user" label="Adobe Pass user"
                value={form.apUsername} onChange={v => fieldChange("apUsername", v)} />
              <PassField id="auth-ap-pass" label="Adobe Pass password" type="password"
                value={form.apPassword} onChange={v => fieldChange("apPassword", v)}
                placeholder={editing?.hasApPassword ? "(saved — leave blank to keep)" : ""} />
            </fieldset>

            <fieldset className="grid gap-3 md:grid-cols-3">
              <CertSelect id="auth-cert" label="Client certificate"
                value={form.clientCertFile} onChange={v => fieldChange("clientCertFile", v)}
                certs={certs} />
              <CertSelect id="auth-cert-key" label="Client cert key"
                value={form.clientCertKeyFile} onChange={v => fieldChange("clientCertKeyFile", v)}
                certs={certs} />
              <PassField id="auth-cert-pass" label="Cert key password" type="password"
                value={form.clientCertPassword} onChange={v => fieldChange("clientCertPassword", v)}
                placeholder={editing?.hasClientCertPassword ? "(saved — leave blank to keep)" : ""} />
            </fieldset>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : editing ? "Update" : "Save"}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Stored</h2>
        {loading && bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credentials stored.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Saved fields</TableHead>
                <TableHead className="w-[160px]">Updated</TableHead>
                <TableHead className="w-[180px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.map(b => (
                <TableRow key={b.domain}>
                  <TableCell className="font-mono text-sm">{b.domain}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {summarize(b)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {timeAgo(b.updatedAt)}
                  </TableCell>
                  <TableCell className="space-x-2">
                    <Button size="sm" variant="outline" onClick={() => startEdit(b)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => onDelete(b.domain)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function summarize(b: BindingPublic): string {
  const parts: string[] = [];
  if (b.username)              parts.push(`user=${b.username}`);
  if (b.hasPassword)           parts.push("pw");
  if (b.hasVideoPassword)      parts.push("video-pw");
  if (b.apMso)                 parts.push(`ap-mso=${b.apMso}`);
  if (b.apUsername)            parts.push(`ap-user=${b.apUsername}`);
  if (b.hasApPassword)         parts.push("ap-pw");
  if (b.clientCertFile)        parts.push(`cert=${basename(b.clientCertFile)}`);
  if (b.clientCertKeyFile)     parts.push(`key=${basename(b.clientCertKeyFile)}`);
  if (b.hasClientCertPassword) parts.push("cert-pw");
  return parts.length ? parts.join(" · ") : "(empty)";
}

function PassField(props: {
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

function CertSelect(props: {
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
