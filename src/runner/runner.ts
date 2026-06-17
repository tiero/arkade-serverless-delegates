// Runner core (docs/DESIGN.md §2.2, §4). Drives one task through the settlement
// round via the ArkClient seam:  pending -> registering -> in_round -> completed
// (or -> failed). Pure orchestration over the store + ArkClient, so it tests
// against MockArkClient without a live arkd.
//
// Custody invariant (CLAUDE.md): the runner forwards the user's pre-signed
// intent + forfeit txs verbatim. It never constructs a destination of its own.

import { canTransition, type DelegateRecord, type DelegateStatus } from "../types.ts";
import type { ArkClient } from "../ark/ArkClient.ts";
import type { DelegateStore } from "../store/store.ts";

export type RunOutcome =
  | { ran: true; record: DelegateRecord }
  | { ran: false; reason: string };

export async function runDelegate(
  store: DelegateStore,
  ark: ArkClient,
  tenantId: string,
  id: string,
  nowSecs: number,
): Promise<RunOutcome> {
  const rec = await store.get(tenantId, id);
  if (!rec) return { ran: false, reason: "not found" };
  // Idempotent: only `pending` tasks are dispatched. Retrying a failed task is
  // the sweep's job (failed -> pending); completed/in-flight tasks are no-ops.
  if (rec.status !== "pending") return { ran: false, reason: `not pending (${rec.status})` };

  rec.attempts += 1;
  await transition(store, rec, "registering", nowSecs);
  await transition(store, rec, "in_round", nowSecs);

  try {
    const { commitmentTxid } = await ark.settleDelegatedIntent({
      intentMessage: rec.intent.message,
      intentProof: rec.intent.proof,
      forfeitTxs: rec.forfeitTxs,
    });
    rec.commitmentTxid = commitmentTxid;
    rec.failReason = "";
    await transition(store, rec, "completed", nowSecs);
  } catch (e) {
    rec.failReason = errorMessage(e);
    await transition(store, rec, "failed", nowSecs);
  }
  return { ran: true, record: rec };
}

/** Mutate + persist a record's status, refusing illegal transitions. */
async function transition(
  store: DelegateStore,
  rec: DelegateRecord,
  to: DelegateStatus,
  nowSecs: number,
): Promise<void> {
  if (!canTransition(rec.status, to)) {
    throw new Error(`illegal transition ${rec.status} -> ${to}`);
  }
  rec.status = to;
  rec.updatedAt = nowSecs;
  await store.put(rec);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
