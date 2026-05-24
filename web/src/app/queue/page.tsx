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

export default function Page() {
  const { connected, jobs } = useJobsWs();
  const { toast } = useToast();

  const [urls, setUrls] = useState("");
  const [format, setFormat] = useState<FormatKey>("best");
  const [container, setContainer] = useState<ContainerKey>("auto");
  const [compat, setCompat] = useState<CompatKey>("auto");
  const [extraArgs, setExtraArgs] = useState("");
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
    return () => { canceled = true; };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const list = urls.split("\n").map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      toast({ title: "No URLs", description: "Paste at least one URL." });
      return;
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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Enqueued", description: `${data.jobs?.length ?? list.length} job(s) queued.` });
      setUrls("");
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
