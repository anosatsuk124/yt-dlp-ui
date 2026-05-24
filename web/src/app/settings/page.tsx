"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { FORMATS, type FormatKey, isFormatKey } from "@/lib/formats";
import { CONTAINERS, type ContainerKey, isContainerKey } from "@/lib/containers";

const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
const CONTAINER_KEYS = Object.keys(CONTAINERS) as ContainerKey[];

interface MegaSettings {
  enabled: boolean;
  email: string;
  password: string; // never echoed from the server — bound only to the input
  folder: string;
  hasPassword: boolean;
  maxParallel: number;
}

const DEFAULT_MEGA: MegaSettings = {
  enabled: false,
  email: "",
  password: "",
  folder: "/yt-dlp-ui",
  hasPassword: false,
  maxParallel: 2,
};

export default function Page() {
  const { toast } = useToast();
  const [defaultFormat, setDefaultFormat] = useState<FormatKey>("best");
  const [defaultContainer, setDefaultContainer] = useState<ContainerKey>("auto");
  const [maxParallel, setMaxParallel] = useState(2);
  const [mega, setMega] = useState<MegaSettings>(DEFAULT_MEGA);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((s: {
        defaultFormat?: string;
        defaultContainer?: string;
        maxParallel?: number;
        mega?: { enabled?: boolean; email?: string; hasPassword?: boolean; folder?: string; maxParallel?: number };
      }) => {
        if (s.defaultFormat && isFormatKey(s.defaultFormat)) {
          setDefaultFormat(s.defaultFormat);
        }
        if (s.defaultContainer && isContainerKey(s.defaultContainer)) {
          setDefaultContainer(s.defaultContainer);
        }
        if (typeof s.maxParallel === "number") setMaxParallel(s.maxParallel);
        if (s.mega) {
          setMega({
            enabled: !!s.mega.enabled,
            email: s.mega.email ?? "",
            password: "",
            folder: s.mega.folder ?? "/yt-dlp-ui",
            hasPassword: !!s.mega.hasPassword,
            maxParallel: typeof s.mega.maxParallel === "number" ? s.mega.maxParallel : 2,
          });
        }
      })
      .catch(() => { /* leave defaults */ })
      .finally(() => setLoading(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(maxParallel) || maxParallel < 1 || maxParallel > 32) {
      toast({ title: "Invalid max parallel", description: "Must be 1–32." });
      return;
    }
    if (mega.enabled && !mega.email) {
      toast({ title: "MEGA email required", description: "Provide an email or disable MEGA upload." });
      return;
    }
    if (mega.enabled && !mega.hasPassword && !mega.password) {
      toast({ title: "MEGA password required", description: "Provide a password or disable MEGA upload." });
      return;
    }
    if (!Number.isFinite(mega.maxParallel) || mega.maxParallel < 1 || mega.maxParallel > 8) {
      toast({ title: "Invalid MEGA max parallel", description: "Must be 1–8." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultFormat,
          defaultContainer,
          maxParallel,
          mega: {
            enabled: mega.enabled,
            email: mega.email,
            // Empty string -> server keeps existing password.
            password: mega.password,
            folder: mega.folder,
            maxParallel: mega.maxParallel,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Saved" });
      // If user just typed a new password, treat it as stored from now on.
      if (mega.password) {
        setMega(m => ({ ...m, password: "", hasPassword: true }));
      }
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label>Default format preset</Label>
                <div className="flex flex-wrap gap-2">
                  {FORMAT_KEYS.map(key => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={defaultFormat === key ? "default" : "outline"}
                      onClick={() => setDefaultFormat(key)}
                    >
                      {FORMATS[key].label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Default container</Label>
                <div className="flex flex-wrap gap-2">
                  {CONTAINER_KEYS.map(key => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={defaultContainer === key ? "default" : "outline"}
                      onClick={() => setDefaultContainer(key)}
                    >
                      {CONTAINERS[key].label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Used when a job doesn't pick its own container. Auto keeps
                  whatever yt-dlp's natural muxer picks.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="max-parallel">Max parallel downloads</Label>
                <Input
                  id="max-parallel"
                  type="number"
                  min={1}
                  max={32}
                  value={maxParallel}
                  onChange={e => setMaxParallel(parseInt(e.target.value, 10) || 1)}
                  className="w-32"
                />
                <p className="text-xs text-muted-foreground">
                  Max parallel is also applied immediately to the downloader.
                </p>
              </div>

              <div className="space-y-4 rounded-md border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-base">MEGA upload</Label>
                    <p className="text-xs text-muted-foreground">
                      When enabled, finished downloads are uploaded to MEGA and
                      the local copy is deleted on success.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={mega.enabled ? "default" : "outline"}
                    onClick={() => setMega(m => ({ ...m, enabled: !m.enabled }))}
                  >
                    {mega.enabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mega-email">Email</Label>
                  <Input
                    id="mega-email"
                    type="email"
                    autoComplete="off"
                    value={mega.email}
                    onChange={e => setMega(m => ({ ...m, email: e.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mega-password">Password</Label>
                  <Input
                    id="mega-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={mega.hasPassword ? "(saved — leave blank to keep)" : ""}
                    value={mega.password}
                    onChange={e => setMega(m => ({ ...m, password: e.target.value }))}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mega-folder">Destination folder</Label>
                  <Input
                    id="mega-folder"
                    value={mega.folder}
                    onChange={e => setMega(m => ({ ...m, folder: e.target.value }))}
                    placeholder="/yt-dlp-ui"
                  />
                  <p className="text-xs text-muted-foreground">
                    Absolute path inside your MEGA Cloud Drive. Created on
                    first upload if missing.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mega-max-parallel">Max parallel MEGA uploads</Label>
                  <Input
                    id="mega-max-parallel"
                    type="number"
                    min={1}
                    max={8}
                    value={mega.maxParallel}
                    onChange={e =>
                      setMega(m => ({ ...m, maxParallel: parseInt(e.target.value, 10) || 1 }))
                    }
                    className="w-32"
                  />
                  <p className="text-xs text-muted-foreground">
                    1–8. Each worker opens its own MEGA session; raising this
                    takes effect immediately, lowering it kicks in as workers
                    finish their current upload.
                  </p>
                </div>
              </div>

              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
