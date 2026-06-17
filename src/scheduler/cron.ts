// Cron sweep (docs/DESIGN.md §4.2). Per tenant: recover stuck/failed tasks
// (bounded by maxAttempts), then dispatch everything that's due through the
// runner. The Cron Trigger calls this for each tenant; it is the durable
// backstop behind the per-task Durable Object alarms.

import { selectDueTasks, selectStuckTasks } from "./sweep.ts";
import { runDelegate } from "../runner/runner.ts";
import { canTransition, type DelegateRecord, type DelegateStatus } from "../types.ts";
import type { ArkClient } from "../ark/ArkClient.ts";
import type { DelegateStore } from "../store/store.ts";

export interface SweepOptions {
  maxAttempts?: number;
  stuckTimeoutSecs?: number;
}

export interface SweepSummary {
  recovered: number;
  gaveUp: number;
  dispatched: number;
  completed: number;
  failed: number;
}

export async function runSweep(
  store: DelegateStore,
  ark: ArkClient,
  tenantId: string,
  nowSecs: number,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const stuckTimeoutSecs = opts.stuckTimeoutSecs ?? 300;
  const summary: SweepSummary = { recovered: 0, gaveUp: 0, dispatched: 0, completed: 0, failed: 0 };

  // Phase A — recover. Stuck in-flight tasks (a crash mid-round) and previously
  // failed tasks become `pending` again, unless they've exhausted maxAttempts.
  //
  // NOTE: re-driving a stuck in_round task can double-submit its intent. Real
  // registration must be idempotent (dedupe by intent txid) — Phase 4 hardening.
  const tasks = await store.list(tenantId);
  const stuck = selectStuckTasks(tasks, nowSecs, stuckTimeoutSecs);
  const failed = tasks.filter((t) => t.status === "failed");
  for (const t of [...stuck, ...failed]) {
    if (t.attempts >= maxAttempts) {
      if (t.status !== "failed") {
        await setStatus(store, t, "failed", nowSecs, "max attempts exceeded");
      }
      summary.gaveUp += 1;
      continue;
    }
    await setStatus(store, t, "pending", nowSecs);
    summary.recovered += 1;
  }

  // Phase B — dispatch everything that is now due.
  const due = selectDueTasks(await store.list(tenantId), nowSecs);
  for (const t of due) {
    const out = await runDelegate(store, ark, tenantId, t.id, nowSecs);
    if (!out.ran) continue;
    summary.dispatched += 1;
    if (out.record.status === "completed") summary.completed += 1;
    else if (out.record.status === "failed") summary.failed += 1;
  }
  return summary;
}

async function setStatus(
  store: DelegateStore,
  rec: DelegateRecord,
  to: DelegateStatus,
  nowSecs: number,
  failReason = "",
): Promise<void> {
  if (!canTransition(rec.status, to)) {
    throw new Error(`illegal transition ${rec.status} -> ${to}`);
  }
  rec.status = to;
  if (to === "failed") rec.failReason = failReason;
  rec.updatedAt = nowSecs;
  await store.put(rec);
}
