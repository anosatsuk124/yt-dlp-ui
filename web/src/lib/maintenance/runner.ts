// Sequential maintenance run driver with progress, modeled on the
// mega-uploader's globalThis-state pattern so the API route view and any
// background work agree on a single run. Only one task runs at a time.

import { getTask } from "./registry";
import type { MaintenanceRunState } from "./types";

interface RunnerState {
  run: MaintenanceRunState | null;
}
const G = globalThis as unknown as { __maintRunner?: RunnerState };
if (!G.__maintRunner) G.__maintRunner = { run: null };
const state = G.__maintRunner;

export function getRunState(): MaintenanceRunState | null {
  return state.run;
}

export function isRunning(): boolean {
  return state.run?.status === "running";
}

// Start a task run in the background. Returns false if a run is already in
// flight. The plan() is regenerated here at run time, so it reflects the live
// state (identical to what the confirmation modal previewed moments earlier).
export function startRun(taskId: string): { started: boolean; error?: string } {
  if (isRunning()) return { started: false, error: "a maintenance task is already running" };
  const task = getTask(taskId);
  if (!task) return { started: false, error: `unknown task: ${taskId}` };

  const run: MaintenanceRunState = {
    taskId,
    status: "running",
    total: 0,
    done: 0,
    current: null,
    log: [],
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
  };
  state.run = run;

  const log = (msg: string) => {
    run.log.push(`[${new Date().toISOString()}] ${msg}`);
    if (run.log.length > 1000) run.log.splice(0, run.log.length - 1000);
  };

  void (async () => {
    try {
      const steps = await task.plan();
      run.total = steps.length;
      log(`Planned ${steps.length} operation(s)`);
      for (const step of steps) {
        run.current = step.description;
        log(`▶ ${step.description}`);
        try {
          await task.apply(step, log);
        } catch (e) {
          log(`✖ ${step.description} — ${(e as Error).message}`);
        }
        run.done += 1;
      }
      run.current = null;
      run.status = "done";
      run.finishedAt = Date.now();
      log(`Done: ${run.done}/${run.total}`);
    } catch (e) {
      run.status = "error";
      run.error = (e as Error).message;
      run.finishedAt = Date.now();
      log(`Run failed: ${run.error}`);
    }
  })();

  return { started: true };
}
