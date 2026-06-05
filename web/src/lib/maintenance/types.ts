// Maintenance / migration plugin contract.
//
// Each task is a self-describing plugin. Its plan() inspects the CURRENT
// database/filesystem state and returns the exact list of operations it would
// perform, as human-readable strings generated from that real state — never
// hardcoded. The settings UI shows precisely those strings in a modal before
// the user confirms, so the modal can never misrepresent what will run.
//
// To add a future migration, implement MaintenanceTask and register it in
// registry.ts — it then appears in the same Update modal automatically.

export interface OperationStep {
  // Stable id within a single plan() result (used as a React key and to look
  // the step back up in apply()).
  id: string;
  // The exact action, in plain language, generated from live state.
  description: string;
  // Optional association to a job row this step acts on.
  jobId?: string;
}

export interface MaintenanceTask {
  id: string;
  title: string;
  description: string;
  // Inspect live state and enumerate the concrete operations to perform.
  plan(): Promise<OperationStep[]>;
  // Execute a single step. `log` appends a line to the run's progress log.
  apply(step: OperationStep, log: (msg: string) => void): Promise<void>;
}

export interface MaintenanceRunState {
  taskId: string;
  status: "running" | "done" | "error";
  total: number;
  done: number;
  current: string | null;
  log: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
