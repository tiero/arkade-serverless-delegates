// Application ports: the interfaces the use cases depend on. Infrastructure
// provides the adapters (R2 / in-memory repo, Arkade REST / mock client, system
// clock). This is the seam that keeps the domain + use cases free of Cloudflare,
// the network, and the wall clock — and makes everything unit-testable.

import type { DelegateStatus, DelegateTaskState, ForfeitTx } from "../domain/task.ts";

/** Injectable wall clock (unix seconds). Tests pass a fixed clock. */
export interface Clock {
  now(): number;
}

export interface ListOptions {
  status?: DelegateStatus;
  limit?: number;
  offset?: number;
}

/**
 * Persistence port. Every method is scoped by tenantId and MUST NOT leak across
 * tenants. Records are plain `DelegateTaskState`; the domain wraps them.
 */
export interface DelegateRepository {
  save(state: DelegateTaskState): Promise<void>;
  load(tenantId: string, id: string): Promise<DelegateTaskState | null>;
  list(tenantId: string, opts?: ListOptions): Promise<DelegateTaskState[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Union of input keys held by the tenant's ACTIVE tasks (overlap guard). */
  activeInputKeys(tenantId: string): Promise<Set<string>>;
}

export interface SettleRequest {
  intentMessage: string;
  intentProof: string;
  forfeitTxs: ForfeitTx[];
}

export interface SettleResult {
  commitmentTxid: string;
}

/**
 * The seam to the Arkade protocol. A real adapter (RestArkadeClient, Phase 3)
 * performs RegisterIntent -> batch MuSig2 round -> SubmitSignedForfeitTxs ->
 * finalized. Registration MUST be idempotent (dedupe by intent txid) so a
 * re-trigger can't double-renew (docs/DESIGN.md §8.1).
 */
export interface ArkadeClient {
  settleDelegatedIntent(req: SettleRequest): Promise<SettleResult>;
}
