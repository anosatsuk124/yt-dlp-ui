// Registry of maintenance/migration tasks. Add future schema-change migrations
// here and they appear in the settings Update modal automatically.

import type { MaintenanceTask } from "./types";
import { backfillHashTask } from "./backfill-hash";
import { regroupSeasonsTask } from "./regroup-seasons";

export const REGISTRY: MaintenanceTask[] = [backfillHashTask, regroupSeasonsTask];

export function getTask(id: string): MaintenanceTask | undefined {
  return REGISTRY.find(t => t.id === id);
}

export function listTasks(): { id: string; title: string; description: string }[] {
  return REGISTRY.map(({ id, title, description }) => ({ id, title, description }));
}
