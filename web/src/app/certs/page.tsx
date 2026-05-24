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

interface CertEntry {
  name:  string;
  size:  number;
  mtime: number;
  path:  string;
}

export default function Page() {
  const { toast } = useToast();
  const [certs, setCerts] = useState<CertEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetch("/api/certs")
      .then(r => r.json())
      .then((data: { certs: CertEntry[] }) => setCerts(data.certs ?? []))
      .catch(() => { /* keep stale */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: "Name required" });
      return;
    }
    if (!file) {
      toast({ title: "File required", description: "Pick a PEM cert or key." });
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("name", trimmed);
      fd.set("file", file);
      const res = await fetch("/api/certs", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Uploaded", description: trimmed });
      setName("");
      if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(n: string) {
    if (!window.confirm(`Delete ${n}?`)) return;
    try {
      const res = await fetch(`/api/certs/${encodeURIComponent(n)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Deleted", description: n });
      load();
    } catch (err) {
      toast({ title: "Delete failed", description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Certs</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cert-name">Filename</Label>
              <Input
                id="cert-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="example-client.cert.pem"
                required
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Must end in <code>.pem</code>, <code>.crt</code>,{" "}
                <code>.cer</code>, or <code>.key</code>. Allowed characters:
                alphanumerics, <code>.</code>, <code>_</code>, <code>-</code>.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cert-file">PEM file</Label>
              <Input
                id="cert-file"
                ref={fileRef}
                type="file"
                accept=".pem,.crt,.cer,.key,application/x-pem-file,text/plain"
                required
              />
              <p className="text-xs text-muted-foreground">
                Must start with <code>{`-----BEGIN ...-----`}</code>{" "}
                (certificate or private key).
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
        {loading && certs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : certs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No certs stored.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-[120px]">Size</TableHead>
                <TableHead className="w-[160px]">Modified</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {certs.map(c => (
                <TableRow key={c.name}>
                  <TableCell className="font-mono text-sm">{c.name}</TableCell>
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
                      onClick={() => onDelete(c.name)}
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
