// Cron-sweep selection logic (docs/DESIGN.md §4.2).
//
// The Cron Trigger runs these pure selectors over a tenant's tasks to decide
// what to dispatch: due `pending` tasks, and in-flight tasks that have been
// stuck past a timeout (e.g. a crash mid-round) and must be re-driven.

import type { DelegateRecord } from "../types.ts";

/** `pending` tasks whose renewal time has arrived. */
export function selectDueTasks(tasks: DelegateRecord[], nowSecs: number): DelegateRecord[] {
  return tasks.filter((t) => t.status === "pending" && t.scheduledAt <= nowSecs);
}

/**
 * In-flight tasks (`registering` / `in_round`) untouched for longer than
 * `timeoutSecs` — assumed stuck and eligible to be reset/retried.
 */
export function selectStuckTasks(
  tasks: DelegateRecord[],
  nowSecs: number,
  timeoutSecs: number,
): DelegateRecord[] {
  return tasks.filter(
    (t) =>
      (t.status === "registering" || t.status === "in_round") &&
      t.updatedAt <= nowSecs - timeoutSecs,
  );
}
