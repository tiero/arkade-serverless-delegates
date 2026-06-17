// Core data model for delegated VTXO renewal.
//
// Mirrors Fulmine's Delegate / DelegateIntent / DelegateForfeitTx messages
// (api-spec/protobuf/fulmine/v1/service.proto). See docs/DESIGN.md §2.1 and §5.

export interface Input {
  txid: string;
  vout: number;
}

export interface DelegateIntent {
  /** proof.UnsignedTx.TxID() */
  txid: string;
  /** encoded intent message; carries `validAt` (when the renewal becomes valid) */
  message: string;
  /** encoded BIP322-style ownership proof */
  proof: string;
  inputs: Input[];
}

export interface DelegateForfeitTx {
  input: Input;
  /** hex, pre-signed by the user */
  forfeitTx: string;
}

export type DelegateStatus =
  | "pending"
  | "registering"
  | "in_round"
  | "completed"
  | "failed"
  | "cancelled";

export interface DelegateRecord {
  id: string;
  tenantId: string;
  intent: DelegateIntent;
  forfeitTxs: DelegateForfeitTx[];
  fee: number;
  delegatePublicKey: string;
  /** unix seconds; when to renew (== intent validAt) */
  scheduledAt: number;
  status: DelegateStatus;
  failReason: string;
  commitmentTxid: string;
  createdAt: number;
  updatedAt: number;
}

/** Statuses where the task still holds a claim on its inputs. */
export const ACTIVE_STATUSES: readonly DelegateStatus[] = ["pending", "registering", "in_round"];
/** Statuses where the task is done and releases its inputs. */
export const TERMINAL_STATUSES: readonly DelegateStatus[] = ["completed", "failed", "cancelled"];

export function isActive(s: DelegateStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

export function isTerminal(s: DelegateStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** Stable key for an Input, used for overlap detection and forfeit pairing. */
export function inputKey(i: Input): string {
  return `${i.txid}:${i.vout}`;
}

/**
 * Allowed status transitions (docs/DESIGN.md §4.3). `failed -> pending` and the
 * in-flight `-> pending` edges model retry-before-deadline.
 */
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

/** Opaque, URL-safe delegate id. */
export function newDelegateId(): string {
  return `del_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
