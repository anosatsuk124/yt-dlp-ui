"use client";

import { useEffect, useRef, useState } from "react";
import { useTabState, useSeedOnce, TAB_KEYS } from "@/components/tab-state";
import { useNavGuard, type NavGuard } from "@/components/nav-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { FORMATS, type FormatKey, normalizeFormatKey, formatKind } from "@/lib/formats";
import { CONTAINER_LABELS, containersFor, isContainerKey, type ContainerKey } from "@/lib/containers";
import { COMPATS, type CompatKey, isCompatKey } from "@/lib/compat";

const FORMAT_KEYS = Object.keys(FORMATS) as FormatKey[];
const COMPAT_KEYS = Object.keys(COMPATS) as CompatKey[];

interface MegaSettings {
  enabled: boolean;
  email: string;
  password: string; // never echoed from the server — bound only to the input
  folder: string;
  audioSubdir: string;
  hasPassword: boolean;
  maxParallel: number;
}

const DEFAULT_MEGA: MegaSettings = {
  enabled: false,
  email: "",
  password: "",
  folder: "/yt-dlp-ui",
  audioSubdir: "audio",
  hasPassword: false,
  maxParallel: 2,
};

// Comparable snapshot of the saved settings — excludes password/hasPassword
// (server-truth, not user input) so dirtiness compares only editable fields.
interface SettingsSnapshot {
  defaultFormat: FormatKey;
  defaultContainer: ContainerKey;
  defaultCompat: CompatKey;
  maxParallel: number;
  mega: {
    enabled: boolean;
    email: string;
    folder: string;
    audioSubdir: string;
    maxParallel: number;
  };
}

function buildSnapshot(
  defaultFormat: FormatKey,
  defaultContainer: ContainerKey,
  defaultCompat: CompatKey,
  maxParallel: number,
  mega: MegaSettings,
): SettingsSnapshot {
  return {
    defaultFormat,
    defaultContainer,
    defaultCompat,
    maxParallel,
    mega: {
      enabled: mega.enabled,
      email: mega.email,
      folder: mega.folder,
      audioSubdir: mega.audioSubdir,
      maxParallel: mega.maxParallel,
    },
  };
}

export default function Page() {
  const { toast } = useToast();
  const { registerGuard } = useNavGuard();
  const K = TAB_KEYS.settings;
  const [defaultFormat, setDefaultFormat] = useTabState<FormatKey>(K.defaultFormat, "best");
  const [defaultContainer, setDefaultContainer] = useTabState<ContainerKey>(K.defaultContainer, "auto");
  const [defaultCompat, setDefaultCompat] = useTabState<CompatKey>(K.defaultCompat, "auto");
  const [maxParallel, setMaxParallel] = useTabState<number>(K.maxParallel, 2);
  const [mega, setMega] = useTabState<MegaSettings>(K.mega, DEFAULT_MEGA);
  const [baseline, setBaseline] = useTabState<SettingsSnapshot | null>(K.baseline, null);
  const [loading] = useTabState<boolean>(K.loading, true);
  const [submitting, setSubmitting] = useState(false);

  const allowedContainers = containersFor(formatKind(defaultFormat));

  // Seed from the server exactly once per provider lifetime. Re-running this on
  // every remount would clobber edits the user made and then switched away from.
  useSeedOnce(K.seed, store => {
    fetch("/api/settings")
      .then(r => r.json())
      .then((s: {
        defaultFormat?: string;
        defaultContainer?: string;
        defaultCompat?: string;
        maxParallel?: number;
        mega?: { enabled?: boolean; email?: string; hasPassword?: boolean; folder?: string; audioSubdir?: string; maxParallel?: number };
      }) => {
        const fmt = s.defaultFormat ? normalizeFormatKey(s.defaultFormat) : "best";
        const allowed = containersFor(formatKind(fmt));
        const cont: ContainerKey =
          s.defaultContainer && isContainerKey(s.defaultContainer) && allowed.includes(s.defaultContainer)
            ? s.defaultContainer
            : allowed[0];
        store.set<FormatKey>(K.defaultFormat, fmt);
        store.set<ContainerKey>(K.defaultContainer, cont);
        if (s.defaultCompat && isCompatKey(s.defaultCompat)) store.set<CompatKey>(K.defaultCompat, s.defaultCompat);
        if (typeof s.maxParallel === "number") store.set<number>(K.maxParallel, s.maxParallel);
        if (s.mega) {
          store.set<MegaSettings>(K.mega, {
            enabled: !!s.mega.enabled,
            email: s.mega.email ?? "",
            password: "",
            folder: s.mega.folder ?? "/yt-dlp-ui",
            audioSubdir: s.mega.audioSubdir ?? "audio",
            hasPassword: !!s.mega.hasPassword,
            maxParallel: typeof s.mega.maxParallel === "number" ? s.mega.maxParallel : 2,
          });
        }
      })
      .catch(() => { /* leave defaults */ })
      .finally(() => {
        // Capture whatever ended up in the store (server values or defaults) as
        // the saved baseline for dirty-tracking.
        const m = store.get<MegaSettings>(K.mega);
        store.set<SettingsSnapshot>(
          K.baseline,
          buildSnapshot(
            store.get<FormatKey>(K.defaultFormat),
            store.get<ContainerKey>(K.defaultContainer),
            store.get<CompatKey>(K.defaultCompat),
            store.get<number>(K.maxParallel),
            m,
          ),
        );
        store.set<boolean>(K.loading, false);
      });
  });

  // When the format kind changes, keep the container valid for the new kind.
  function onDefaultFormatChange(fmt: FormatKey) {
    setDefaultFormat(fmt);
    const allowed = containersFor(formatKind(fmt));
    if (!allowed.includes(defaultContainer)) setDefaultContainer(allowed[0]);
  }

  function isDirty(): boolean {
    if (!baseline) return false;
    if (mega.password !== "") return true;
    return (
      JSON.stringify(buildSnapshot(defaultFormat, defaultContainer, defaultCompat, maxParallel, mega)) !==
      JSON.stringify(baseline)
    );
  }

  async function saveSettings(): Promise<boolean> {
    if (!Number.isFinite(maxParallel) || maxParallel < 1 || maxParallel > 32) {
      toast({ title: "Invalid max parallel", description: "Must be 1–32." });
      return false;
    }
    if (mega.enabled && !mega.email) {
      toast({ title: "MEGA email required", description: "Provide an email or disable MEGA upload." });
      return false;
    }
    if (mega.enabled && !mega.hasPassword && !mega.password) {
      toast({ title: "MEGA password required", description: "Provide a password or disable MEGA upload." });
      return false;
    }
    if (!Number.isFinite(mega.maxParallel) || mega.maxParallel < 1 || mega.maxParallel > 8) {
      toast({ title: "Invalid MEGA max parallel", description: "Must be 1–8." });
      return false;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultFormat,
          defaultContainer,
          defaultCompat,
          maxParallel,
          mega: {
            enabled: mega.enabled,
            email: mega.email,
            password: mega.password,
            folder: mega.folder,
            audioSubdir: mega.audioSubdir,
            maxParallel: mega.maxParallel,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast({ title: "Saved" });
      if (mega.password) {
        setMega(m => ({ ...m, password: "", hasPassword: true }));
      }
      setBaseline(buildSnapshot(defaultFormat, defaultContainer, defaultCompat, maxParallel, mega));
      return true;
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message });
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function discardSettings() {
    if (!baseline) return;
    setDefaultFormat(baseline.defaultFormat);
    setDefaultContainer(baseline.defaultContainer);
    setDefaultCompat(baseline.defaultCompat);
    setMaxParallel(baseline.maxParallel);
    setMega(m => ({
      ...m,
      enabled: baseline.mega.enabled,
      email: baseline.mega.email,
      folder: baseline.mega.folder,
      audioSubdir: baseline.mega.audioSubdir,
      maxParallel: baseline.mega.maxParallel,
      password: "",
    }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await saveSettings();
  }

  // Point the nav guard at the latest closures without re-registering each
  // render: the registered object calls through refs refreshed every render, so
  // isDirty/save/discard always see current settings state (no stale closures).
  const isDirtyRef = useRef(isDirty);
  const saveRef = useRef(saveSettings);
  const discardRef = useRef(discardSettings);
  isDirtyRef.current = isDirty;
  saveRef.current = saveSettings;
  discardRef.current = discardSettings;
  useEffect(() => {
    const guard: NavGuard = {
      isDirty: () => isDirtyRef.current(),
      save: () => saveRef.current(),
      discard: () => discardRef.current(),
    };
    registerGuard(guard);
    return () => registerGuard(null);
  }, [registerGuard]);

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
                      onClick={() => onDefaultFormatChange(key)}
                    >
                      {FORMATS[key].label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Default container</Label>
                <div className="flex flex-wrap gap-2">
                  {allowedContainers.map(key => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={defaultContainer === key ? "default" : "outline"}
                      onClick={() => setDefaultContainer(key)}
                    >
                      {CONTAINER_LABELS[key]}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Pre-ticked in the queue form. Audio formats list codecs
                  (MP3/WAV/FLAC); video formats list containers.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Default compatibility profile</Label>
                <div className="flex flex-wrap gap-2">
                  {COMPAT_KEYS.map(key => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={defaultCompat === key ? "default" : "outline"}
                      onClick={() => setDefaultCompat(key)}
                      title={COMPATS[key].hint}
                    >
                      {COMPATS[key].label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {COMPATS[defaultCompat].hint} iOS overrides the container
                  setting and always saves video as MP4.
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
                    Absolute path inside your MEGA Cloud Drive. Video downloads
                    go here; created on first upload if missing.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="mega-audio-subdir">Audio subfolder</Label>
                  <Input
                    id="mega-audio-subdir"
                    value={mega.audioSubdir}
                    onChange={e => setMega(m => ({ ...m, audioSubdir: e.target.value }))}
                    placeholder="audio"
                  />
                  <p className="text-xs text-muted-foreground">
                    Audio-only downloads land in{" "}
                    <code>{mega.folder.replace(/\/+$/, "")}/{mega.audioSubdir.replace(/^\/+|\/+$/g, "") || "audio"}</code>.
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

      <MaintenanceCard />
    </div>
  );
}

// --- Maintenance / Update --------------------------------------------------

interface TaskInfo { id: string; title: string; description: string }
interface OperationStep { id: string; description: string; jobId?: string }
interface RunState {
  taskId: string;
  status: "running" | "done" | "error";
  total: number;
  done: number;
  current: string | null;
  log: string[];
  error: string | null;
}

function MaintenanceCard() {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [active, setActive] = useState<TaskInfo | null>(null);
  const [steps, setSteps] = useState<OperationStep[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);

  useEffect(() => {
    fetch("/api/maintenance")
      .then(r => r.json())
      .then((d: { tasks: TaskInfo[]; run: RunState | null }) => {
        setTasks(d.tasks ?? []);
        if (d.run) setRun(d.run);
      })
      .catch(() => { /* ignore */ });
  }, []);

  // Poll run status while a task is running.
  useEffect(() => {
    if (!active || run?.status !== "running") return;
    const t = setInterval(() => {
      fetch(`/api/maintenance/${active.id}/status`)
        .then(r => r.json())
        .then((d: { run: RunState | null }) => { if (d.run) setRun(d.run); })
        .catch(() => { /* ignore */ });
    }, 1500);
    return () => clearInterval(t);
  }, [active, run?.status]);

  async function openTask(task: TaskInfo) {
    setActive(task);
    setSteps(null);
    setRun(null);
    setPlanning(true);
    try {
      const r = await fetch(`/api/maintenance/${task.id}/plan`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setSteps(d.steps ?? []);
    } catch (e) {
      toast({ title: "Plan failed", description: (e as Error).message });
      setSteps([]);
    } finally {
      setPlanning(false);
    }
  }

  async function runTask() {
    if (!active) return;
    try {
      const r = await fetch(`/api/maintenance/${active.id}/run`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setRun(d.run as RunState);
    } catch (e) {
      toast({ title: "Run failed", description: (e as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Maintenance / Update</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          One-off migration and backfill tasks. Each opens a modal that lists
          the exact operations it will perform — generated from the current
          database — before you run it.
        </p>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks available.</p>
        ) : (
          tasks.map(t => (
            <div key={t.id} className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-xs text-muted-foreground">{t.description}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => openTask(t)}>
                Review &amp; run
              </Button>
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={!!active} onOpenChange={o => { if (!o) { setActive(null); setSteps(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{active?.title}</DialogTitle>
            <DialogDescription>{active?.description}</DialogDescription>
          </DialogHeader>

          <div>
            <Label className="text-xs">
              Operations to perform{steps ? ` (${steps.length})` : ""}
            </Label>
            <div className="mt-1 max-h-56 overflow-y-auto rounded-md border bg-card/30 p-2 text-xs">
              {planning && <p className="text-muted-foreground">Planning…</p>}
              {!planning && steps && steps.length === 0 && (
                <p className="text-muted-foreground">Nothing to do — everything is up to date.</p>
              )}
              {!planning && steps?.map((s, i) => (
                <div key={s.id} className="py-0.5">
                  <span className="text-muted-foreground">{i + 1}.</span> {s.description}
                </div>
              ))}
            </div>
          </div>

          {run && (
            <div className="space-y-1">
              <Label className="text-xs">
                Progress: {run.done}/{run.total} — {run.status}
                {run.current ? ` — ${run.current}` : ""}
              </Label>
              <div className="max-h-40 overflow-y-auto rounded-md border bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
                {run.log.slice(-200).map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">{line}</div>
                ))}
              </div>
              {run.error && <p className="text-xs text-destructive">{run.error}</p>}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setActive(null); setSteps(null); }}>
              Close
            </Button>
            <Button
              onClick={runTask}
              disabled={planning || !steps || steps.length === 0 || run?.status === "running"}
            >
              {run?.status === "running" ? "Running…" : "Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
