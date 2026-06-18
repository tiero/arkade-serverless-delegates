// Application use cases. Thin orchestration over the domain aggregate and the
// ports; no transport, persistence, or clock details leak in here. Each use case
// throws domain errors (mapped to HTTP at the boundary) and returns plain state.

import {
  DelegateTask,
  isActive,
  parseDelegatePublicKey,
  parseFee,
  parseForfeitTxs,
  parseIntent,
  resolveScheduledAt,
  type DelegateTaskState,
} from "../domain/task.ts";
import { ConflictError, NotFoundError } from "../domain/errors.ts";
import type { ArkadeClient, Clock, DelegateRepository, ListOptions } from "./ports.ts";

export interface CreateDelegateInput {
  intent: unknown;
  forfeitTxs: unknown;
  delegatePublicKey: unknown;
  fee: unknown;
  scheduledAt?: unknown;
}

export async function createDelegate(
  repo: DelegateRepository,
  clock: Clock,
  tenantId: string,
  input: CreateDelegateInput,
): Promise<DelegateTaskState> {
  // Value-object construction validates everything; malformed input throws
  // ValidationError (-> 400), never an uncaught crash.
  const intent = parseIntent(input.intent);
  const forfeitTxs = parseForfeitTxs(input.forfeitTxs, intent.inputs);
  const fee = parseFee(input.fee);
  const delegatePublicKey = parseDelegatePublicKey(input.delegatePublicKey);
  const now = clock.now();
  const scheduledAt = resolveScheduledAt(intent.message, input.scheduledAt, now);

  const task = DelegateTask.create(
    { tenantId, intent, forfeitTxs, fee, delegatePublicKey, scheduledAt },
    now,
  );

  // Strict overlap guard: atomically reject inputs already claimed by an active
  // task (one critical section, no read-then-act window). Per-tenant DO
  // serialization extends this across isolates (docs/DESIGN.md §5, §8.1).
  const overlap = await repo.saveIfNoOverlap(task.toState());
  if (overlap.length > 0) throw new ConflictError(`inputs already delegated: ${overlap.join(", ")}`);
  return task.toState();
}

export async function cancelDelegate(
  repo: DelegateRepository,
  clock: Clock,
  tenantId: string,
  id: string,
): Promise<DelegateTaskState> {
  const state = await repo.load(tenantId, id);
  if (!state) throw new NotFoundError();
  const task = DelegateTask.fromState(state);
  // Only pending tasks are user-cancellable; in-flight ones are cancelled by
  // the spent-input watcher (docs/DESIGN.md §2.2).
  if (task.status !== "pending") throw new ConflictError(`cannot cancel a ${task.status} task`);
  task.cancel(clock.now());
  await repo.save(task.toState());
  return task.toState();
}

export async function getDelegate(
  repo: DelegateRepository,
  tenantId: string,
  id: string,
): Promise<DelegateTaskState> {
  const state = await repo.load(tenantId, id);
  if (!state) throw new NotFoundError();
  return state;
}

export async function listDelegates(
  repo: DelegateRepository,
  tenantId: string,
  opts: ListOptions = {},
): Promise<DelegateTaskState[]> {
  return repo.list(tenantId, opts);
}

export interface RunResult {
  ran: boolean;
  state: DelegateTaskState | null;
}

/**
 * Drive one pending task through a settlement round. Idempotent: non-pending
 * tasks are no-ops, so a repeated trigger renews exactly once. Forwards the
 * user's pre-signed intent + forfeits verbatim (custody invariant).
 */
export async function runDelegate(
  repo: DelegateRepository,
  arkade: ArkadeClient,
  clock: Clock,
  tenantId: string,
  id: string,
): Promise<RunResult> {
  const state = await repo.load(tenantId, id);
  if (!state) return { ran: false, state: null };
  const task = DelegateTask.fromState(state);
  if (task.status !== "pending") return { ran: false, state: task.toState() };

  const now = clock.now();
  task.markAttempt(now);
  task.register(now);
  task.enterRound(now);
  await repo.save(task.toState()); // durable in_round marker for stuck detection

  try {
    const { commitmentTxid } = await arkade.settleDelegatedIntent({
      intentMessage: state.intent.message,
      intentProof: state.intent.proof,
      forfeitTxs: state.forfeitTxs,
    });
    task.complete(commitmentTxid, clock.now());
  } catch (e) {
    task.fail(e instanceof Error ? e.message : String(e), clock.now());
  }
  await repo.save(task.toState());
  return { ran: true, state: task.toState() };
}

export interface SweepOptions {
  maxAttempts?: number;
  stuckTimeoutSecs?: number;
  /** Attempt cap for tasks near their hard expiry (>= maxAttempts). Default 6. */
  maxUrgentAttempts?: number;
  /** How long before `expiresAt` a task becomes urgent (seconds). Default 3600. */
  escalationWindowSecs?: number;
}

export interface SweepSummary {
  recovered: number;
  gaveUp: number;
  dispatched: number;
  completed: number;
  failed: number;
  /** Tasks the near-expiry escalation pulled in (force-due or retried past maxAttempts). */
  escalated: number;
  /** Active tasks failed because their VTXO hard-expired before renewal. */
  expired: number;
}

/**
 * Per-tenant cron sweep. Recovers in-flight tasks stuck past a timeout and
 * retryable failed tasks (bounded by maxAttempts), then dispatches the tasks
 * that were ALREADY due+pending in this snapshot.
 *
 * Recovered tasks are intentionally NOT dispatched in the same tick — they wait
 * for the next sweep — so we never re-submit an intent whose previous round may
 * still be in flight (docs/DESIGN.md §8.1). Level-triggered: a task survives any
 * number of missed ticks and runs on the next successful one.
 *
 * Near-expiry escalation (docs/DESIGN.md §8.1), keyed off the signed `expiresAt`:
 * within `escalationWindowSecs` of hard expiry a task is *urgent* — it is
 * force-due even if `scheduledAt` is still ahead (pull renewal forward), and its
 * attempt cap is raised to `maxUrgentAttempts` so we keep trying while renewal
 * can still help. Once a task is PAST hard expiry, renewal is futile (the VTXO
 * is swept), so an active task is failed rather than retried.
 */
export async function sweepDelegates(
  repo: DelegateRepository,
  arkade: ArkadeClient,
  clock: Clock,
  tenantId: string,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxUrgentAttempts = opts.maxUrgentAttempts ?? 6;
  const stuckTimeoutSecs = opts.stuckTimeoutSecs ?? 300;
  const escalationWindowSecs = opts.escalationWindowSecs ?? 3600;
  const now = clock.now();
  const summary: SweepSummary = {
    recovered: 0,
    gaveUp: 0,
    dispatched: 0,
    completed: 0,
    failed: 0,
    escalated: 0,
    expired: 0,
  };

  // Urgent: hard expiry known, inside the window, and not yet past it.
  const isUrgent = (s: DelegateTaskState): boolean =>
    s.expiresAt > 0 && now >= s.expiresAt - escalationWindowSecs && now < s.expiresAt;
  const pastExpiry = (s: DelegateTaskState): boolean => s.expiresAt > 0 && now >= s.expiresAt;

  const snapshot = await repo.list(tenantId);
  const expiredIds = new Set<string>();

  // 0. Hard-expired active tasks: renewal can no longer help — fail them so we
  //    stop spending attempts and surface the (liveness) outcome.
  for (const s of snapshot) {
    if (!isActive(s.status) || !pastExpiry(s)) continue;
    const task = DelegateTask.fromState(s);
    task.fail("vtxo hard-expired before renewal", now);
    await repo.save(task.toState());
    expiredIds.add(s.id);
    summary.expired += 1;
  }

  for (const s of snapshot) {
    if (expiredIds.has(s.id)) continue;
    const inFlightStuck =
      (s.status === "registering" || s.status === "in_round") && s.updatedAt <= now - stuckTimeoutSecs;
    const retryable = s.status === "failed";
    if (!inFlightStuck && !retryable) continue;

    const cap = isUrgent(s) ? maxUrgentAttempts : maxAttempts;
    const task = DelegateTask.fromState(s);
    if (task.attempts >= cap) {
      if (inFlightStuck) {
        task.fail("max attempts exceeded", now);
        await repo.save(task.toState());
      }
      summary.gaveUp += 1;
      continue;
    }
    if (isUrgent(s) && task.attempts >= maxAttempts) summary.escalated += 1; // retried past the normal cap
    task.recover(now);
    await repo.save(task.toState());
    summary.recovered += 1;
  }

  // Dispatch tasks due in this snapshot. Urgent pending tasks are force-due even
  // when scheduledAt is still ahead.
  const dueNow = snapshot.filter(
    (s) => s.status === "pending" && !expiredIds.has(s.id) && (s.scheduledAt <= now || isUrgent(s)),
  );
  for (const s of dueNow) {
    if (isUrgent(s) && s.scheduledAt > now) summary.escalated += 1; // force-due by urgency
    const { ran, state } = await runDelegate(repo, arkade, clock, tenantId, s.id);
    if (!ran || !state) continue;
    summary.dispatched += 1;
    if (state.status === "completed") summary.completed += 1;
    else if (state.status === "failed") summary.failed += 1;
  }
  return summary;
}
