"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { FORMATS, type FormatKey, isFormatKey } from "@/lib/formats";

const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];

export default function Page() {
  const { toast } = useToast();
  const [defaultFormat, setDefaultFormat] = useState<FormatKey>("best");
  const [maxParallel, setMaxParallel] = useState(2);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((s: { defaultFormat?: string; maxParallel?: number }) => {
        if (s.defaultFormat && isFormatKey(s.defaultFormat)) {
          setDefaultFormat(s.defaultFormat);
        }
        if (typeof s.maxParallel === "number") setMaxParallel(s.maxParallel);
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
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultFormat, maxParallel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Saved" });
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
