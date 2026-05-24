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
import { humanBytes, timeAgo } from "@/lib/format";

interface CookieEntry {
  domain: string;
  size: number;
  mtime: number;
}

export default function Page() {
  const { toast } = useToast();
  const [cookies, setCookies] = useState<CookieEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetch("/api/cookies")
      .then(r => r.json())
      .then((data: { cookies: CookieEntry[] }) => setCookies(data.cookies ?? []))
      .catch(() => { /* keep stale */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!domain.trim()) {
      toast({ title: "Domain required" });
      return;
    }
    if (!file) {
      toast({ title: "File required", description: "Pick a Netscape cookies.txt." });
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("domain", domain.trim());
      fd.set("file", file);
      const res = await fetch("/api/cookies", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Uploaded", description: domain.trim() });
      setDomain("");
      if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(d: string) {
    if (!window.confirm(`Delete cookies for ${d}?`)) return;
    try {
      const res = await fetch(`/api/cookies/${encodeURIComponent(d)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Deleted", description: d });
      load();
    } catch (err) {
      toast({ title: "Delete failed", description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Cookies</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="domain">Domain</Label>
              <Input
                id="domain"
                value={domain}
                onChange={e => setDomain(e.target.value)}
                placeholder="youtube.com"
                required
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cookies-file">cookies.txt</Label>
              <Input
                id="cookies-file"
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                required
              />
              <p className="text-xs text-muted-foreground">
                Must be a Netscape-format cookies file (starts with{" "}
                <code>{`# Netscape HTTP Cookie File`}</code>).
              </p>
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Uploading…" : "Upload"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">Stored</h2>
        {loading && cookies.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : cookies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cookies stored.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead className="w-[120px]">Size</TableHead>
                <TableHead className="w-[160px]">Modified</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cookies.map(c => (
                <TableRow key={c.domain}>
                  <TableCell className="font-mono text-sm">{c.domain}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {humanBytes(c.size)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {timeAgo(c.mtime)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => onDelete(c.domain)}
                    >
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
