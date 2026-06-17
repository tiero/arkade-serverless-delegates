// Delegate service: the one place a hand-off becomes a scheduled task, and the
// one place a task is cancelled. Composes validation (src/api/validate.ts), the
// overlap guard, and the store. See docs/DESIGN.md §7 and CLAUDE.md invariants.

import { newDelegateId, type DelegateRecord } from "../types.ts";
import {
  overlappingInputs,
  validateDelegateRequest,
  type DelegateRequest,
} from "../api/validate.ts";
import type { DelegateStore } from "../store/store.ts";

export type CreateResult =
  | { ok: true; record: DelegateRecord }
  | { ok: false; status: number; error: string };

export async function createDelegate(
  store: DelegateStore,
  tenantId: string,
  req: DelegateRequest,
  nowSecs: number,
): Promise<CreateResult> {
  const valid = validateDelegateRequest(req, nowSecs);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  // Overlap guard: never accept inputs already claimed by one of this tenant's
  // active tasks. (Check-then-put is not atomic on R2; strict serialization is
  // a per-tenant Durable Object — docs/DESIGN.md §5.)
  const active = await store.activeInputKeys(tenantId);
  const overlap = overlappingInputs(active, req.intent);
  if (overlap.length > 0) {
    return { ok: false, status: 409, error: `inputs already delegated: ${overlap.join(", ")}` };
  }

  // The record stores the user's pre-signed material verbatim. We never set or
  // alter a destination — the intent already pays back to the owner (minus fee).
  const rec: DelegateRecord = {
    id: newDelegateId(),
    tenantId,
    intent: req.intent,
    forfeitTxs: req.forfeitTxs,
    fee: req.fee,
    delegatePublicKey: req.delegatePublicKey,
    scheduledAt: req.scheduledAt,
    status: "pending",
    failReason: "",
    commitmentTxid: "",
    attempts: 0,
    createdAt: nowSecs,
    updatedAt: nowSecs,
  };
  await store.put(rec);
  return { ok: true, record: rec };
}

export type CancelResult =
  | { ok: true; record: DelegateRecord }
  | { ok: false; status: number; error: string };

/**
 * User-initiated cancel. Only `pending` tasks can be cancelled here: once a task
 * is registering/in a round, cancellation is driven by the spent-input watcher
 * (docs/DESIGN.md §2.2), not by the API.
 */
export async function cancelDelegate(
  store: DelegateStore,
  tenantId: string,
  id: string,
  nowSecs: number,
): Promise<CancelResult> {
  const rec = await store.get(tenantId, id);
  if (!rec) return { ok: false, status: 404, error: "not found" };
  if (rec.status !== "pending") {
    return { ok: false, status: 409, error: `cannot cancel a ${rec.status} task` };
  }
  rec.status = "cancelled";
  rec.updatedAt = nowSecs;
  await store.put(rec);
  return { ok: true, record: rec };
}
