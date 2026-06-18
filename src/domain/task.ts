// Domain model for Arkade delegated VTXO renewal.
//
// This module is the heart of the design (DDD): the `DelegateTask` aggregate
// owns its own status transitions and invariants, and the value-object parsers
// turn untrusted JSON into valid domain objects or throw a ValidationError —
// nothing downstream ever sees a malformed Intent/ForfeitTx. Mirrors Fulmine's
// Delegate / DelegateIntent / DelegateForfeitTx (see docs/DESIGN.md §2.1).

import { InvariantError, ValidationError } from "./errors.ts";

// ---- value objects ----

export interface Input {
  txid: string;
  vout: number;
}

export interface DelegateIntent {
  txid: string;
  message: string; // encoded intent message; carries validAt
  proof: string; // encoded BIP322-style ownership proof
  inputs: Input[];
}

export interface ForfeitTx {
  input: Input;
  forfeitTx: string; // hex, pre-signed by the user
}

export function inputKey(i: Input): string {
  return `${i.txid}:${i.vout}`;
}

// ---- status & transitions ----

export type DelegateStatus =
  | "pending"
  | "registering"
  | "in_round"
  | "completed"
  | "failed"
  | "cancelled";

export const DELEGATE_STATUSES: readonly DelegateStatus[] = [
  "pending",
  "registering",
  "in_round",
  "completed",
  "failed",
  "cancelled",
];

const ACTIVE_STATUSES: readonly DelegateStatus[] = ["pending", "registering", "in_round"];

export function isActive(s: DelegateStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

export function isTerminal(s: DelegateStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

// The single source of truth for the lifecycle (docs/DESIGN.md §4.3). The
// `-> pending` edges model recover/retry.
const TRANSITIONS: Record<DelegateStatus, readonly DelegateStatus[]> = {
  pending: ["registering", "cancelled", "failed"],
  registering: ["in_round", "failed", "cancelled", "pending"],
  in_round: ["completed", "failed", "pending"],
  completed: [],
  failed: ["pending"],
  cancelled: [],
};

export function canTransition(from: DelegateStatus, to: DelegateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---- parsing (untrusted JSON -> validated value objects) ----

export const MAX_FEE = 1_000_000; // sats sanity cap

function asObject(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(message);
  return raw as Record<string, unknown>;
}

export function parseInput(raw: unknown): Input {
  const o = asObject(raw, "invalid input");
  if (typeof o.txid !== "string" || o.txid.length === 0) throw new ValidationError("input.txid required");
  if (!Number.isInteger(o.vout) || (o.vout as number) < 0) {
    throw new ValidationError("input.vout must be a non-negative integer");
  }
  return { txid: o.txid, vout: o.vout as number };
}

export function parseIntent(raw: unknown): DelegateIntent {
  const o = asObject(raw, "intent is required");
  if (typeof o.message !== "string" || !o.message) throw new ValidationError("intent.message is required");
  if (typeof o.proof !== "string" || !o.proof) throw new ValidationError("intent.proof is required");
  if (!Array.isArray(o.inputs) || o.inputs.length === 0) {
    throw new ValidationError("intent.inputs must be non-empty");
  }
  const inputs = o.inputs.map(parseInput);
  const seen = new Set<string>();
  for (const i of inputs) {
    const k = inputKey(i);
    if (seen.has(k)) throw new ValidationError(`duplicate input ${k}`);
    seen.add(k);
  }
  return { txid: typeof o.txid === "string" ? o.txid : "", message: o.message, proof: o.proof, inputs };
}

export function parseForfeitTxs(raw: unknown, inputs: Input[]): ForfeitTx[] {
  if (!Array.isArray(raw)) throw new ValidationError("forfeitTxs must be an array");
  const inputKeys = new Set(inputs.map(inputKey));
  const forfeitKeys = new Set<string>();
  const out: ForfeitTx[] = [];
  for (const f of raw) {
    const o = asObject(f, "invalid forfeit tx");
    if (typeof o.forfeitTx !== "string" || !o.forfeitTx) throw new ValidationError("forfeit tx hex required");
    const input = parseInput(o.input);
    const k = inputKey(input);
    if (forfeitKeys.has(k)) throw new ValidationError(`duplicate forfeit tx for input ${k}`);
    if (!inputKeys.has(k)) throw new ValidationError(`forfeit tx for unknown input ${k}`);
    forfeitKeys.add(k);
    out.push({ input, forfeitTx: o.forfeitTx });
  }
  if (forfeitKeys.size !== inputKeys.size) throw new ValidationError("each input needs exactly one forfeit tx");
  return out;
}

export function parseFee(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new ValidationError("fee must be an integer (sats)");
  if (raw < 0) throw new ValidationError("fee must be >= 0");
  if (raw > MAX_FEE) throw new ValidationError(`fee exceeds sanity cap (${MAX_FEE})`);
  return raw;
}

export function parseDelegatePublicKey(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new ValidationError("delegatePublicKey is required");
  return raw;
}

/**
 * The Arkade register-intent message is canonical JSON (verified against
 * `@arkade-os/sdk` `Intent.encodeMessage`): `{ type: "register", valid_at,
 * expire_at, ... }` with unix-seconds integers. We decode it here in the pure
 * domain (just `JSON.parse` — no SDK dependency, so the unit loop stays
 * dependency-light) and read the signed timings directly. `validAt`/`expireAt`
 * (camelCase) are accepted as a fallback for hand-rolled fixtures.
 */
function decodeIntentField(message: string, snake: string, camel: string): number | null {
  try {
    const m = JSON.parse(message) as Record<string, unknown>;
    const raw = m?.[snake] ?? m?.[camel];
    if (Number.isFinite(raw)) return Math.floor(raw as number);
  } catch {
    /* opaque / non-JSON message — not decodable */
  }
  return null;
}

/** Renewal time signed into the intent (`valid_at`), or null if not decodable. */
export function deriveValidAt(message: string): number | null {
  return decodeIntentField(message, "valid_at", "validAt");
}

/** Hard expiry signed into the intent (`expire_at`), or null if not decodable. */
export function deriveExpireAt(message: string): number | null {
  return decodeIntentField(message, "expire_at", "expireAt");
}

/**
 * Resolve the renewal time. The signed intent's `valid_at` is authoritative
 * when the message decodes; the request-supplied `scheduledAt` is only a
 * fallback for opaque messages (docs/DESIGN.md §7, §8.1). Must be in the future.
 */
export function resolveScheduledAt(message: string, providedRaw: unknown, nowSecs: number): number {
  const derived = deriveValidAt(message);
  let scheduledAt: number;
  if (derived !== null) scheduledAt = derived;
  else if (typeof providedRaw === "number" && Number.isFinite(providedRaw)) scheduledAt = Math.floor(providedRaw);
  else throw new ValidationError("scheduledAt is required");
  if (scheduledAt <= nowSecs) throw new ValidationError("scheduledAt (validAt) must be in the future");
  return scheduledAt;
}

export function newDelegateId(): string {
  return `del_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ---- aggregate ----

export interface DelegateTaskState {
  id: string;
  tenantId: string;
  intent: DelegateIntent;
  forfeitTxs: ForfeitTx[];
  fee: number;
  delegatePublicKey: string;
  scheduledAt: number;
  /** Hard VTXO expiry (unix secs) from the signed intent (`expire_at`); 0 if not decodable. Used by the near-expiry escalation (docs/DESIGN.md §8.1). */
  expiresAt: number;
  status: DelegateStatus;
  failReason: string;
  commitmentTxid: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewDelegateArgs {
  tenantId: string;
  intent: DelegateIntent;
  forfeitTxs: ForfeitTx[];
  fee: number;
  delegatePublicKey: string;
  scheduledAt: number;
}

/**
 * The DelegateTask aggregate. All lifecycle changes go through its methods,
 * which enforce the transition table — illegal transitions throw, so no caller
 * can drive an invalid lifecycle. Persistence is plain `DelegateTaskState`.
 */
export class DelegateTask {
  private state: DelegateTaskState;

  constructor(state: DelegateTaskState) {
    this.state = state;
  }

  static create(args: NewDelegateArgs, nowSecs: number): DelegateTask {
    // `expiresAt` is 0 when the message carries no decodable `expire_at`
    // (escalation simply can't run toward an unknown deadline). When it IS
    // known it must be after the renewal time, else the task would be created
    // only to be hard-failed on the next sweep — reject the ambiguous hand-off.
    const expiresAt = deriveExpireAt(args.intent.message) ?? 0;
    if (expiresAt > 0 && expiresAt <= args.scheduledAt) {
      throw new ValidationError("intent expire_at must be after valid_at");
    }
    return new DelegateTask({
      id: newDelegateId(),
      tenantId: args.tenantId,
      intent: args.intent,
      forfeitTxs: args.forfeitTxs,
      fee: args.fee,
      delegatePublicKey: args.delegatePublicKey,
      scheduledAt: args.scheduledAt,
      expiresAt,
      status: "pending",
      failReason: "",
      commitmentTxid: "",
      attempts: 0,
      createdAt: nowSecs,
      updatedAt: nowSecs,
    });
  }

  static fromState(state: DelegateTaskState): DelegateTask {
    const cloned = structuredClone(state);
    // Back-fill expiresAt for records persisted before the field existed: it's
    // derivable from the (immutable) signed message, so old tasks get
    // escalation / hard-expiry handling without a migration.
    if (typeof cloned.expiresAt !== "number") {
      cloned.expiresAt = deriveExpireAt(cloned.intent.message) ?? 0;
    }
    return new DelegateTask(cloned);
  }

  toState(): DelegateTaskState {
    return structuredClone(this.state);
  }

  get id(): string {
    return this.state.id;
  }
  get tenantId(): string {
    return this.state.tenantId;
  }
  get status(): DelegateStatus {
    return this.state.status;
  }
  get scheduledAt(): number {
    return this.state.scheduledAt;
  }
  get expiresAt(): number {
    return this.state.expiresAt;
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get updatedAt(): number {
    return this.state.updatedAt;
  }
  get intent(): DelegateIntent {
    return this.state.intent;
  }
  get forfeitTxs(): ForfeitTx[] {
    return this.state.forfeitTxs;
  }
  get inputKeys(): string[] {
    return this.state.intent.inputs.map(inputKey);
  }

  markAttempt(nowSecs: number): void {
    this.state.attempts += 1;
    this.state.updatedAt = nowSecs;
  }

  register(nowSecs: number): void {
    this.transitionTo("registering", nowSecs);
  }

  enterRound(nowSecs: number): void {
    this.transitionTo("in_round", nowSecs);
  }

  complete(commitmentTxid: string, nowSecs: number): void {
    this.state.commitmentTxid = commitmentTxid;
    this.state.failReason = "";
    this.transitionTo("completed", nowSecs);
  }

  fail(reason: string, nowSecs: number): void {
    this.state.failReason = reason;
    this.transitionTo("failed", nowSecs);
  }

  cancel(nowSecs: number): void {
    this.transitionTo("cancelled", nowSecs);
  }

  /** Reset an in-flight/failed task to pending for a later retry; clears failReason. */
  recover(nowSecs: number): void {
    this.state.failReason = "";
    this.transitionTo("pending", nowSecs);
  }

  private transitionTo(to: DelegateStatus, nowSecs: number): void {
    if (!canTransition(this.state.status, to)) {
      throw new InvariantError(`illegal transition ${this.state.status} -> ${to}`);
    }
    this.state.status = to;
    this.state.updatedAt = nowSecs;
  }
}
