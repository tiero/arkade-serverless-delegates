// The task-store contract (docs/DESIGN.md §5).
//
// Phase 1 ships an in-memory implementation (memory.ts). An R2-backed
// implementation lands later and MUST satisfy these same semantics, including
// tenant isolation: every method is scoped by tenantId and must never leak
// records across tenants.

import type { DelegateRecord, DelegateStatus } from "../types.ts";

export interface ListOptions {
  status?: DelegateStatus;
  limit?: number;
  offset?: number;
}

export interface DelegateStore {
  /** Create or overwrite a record. */
  put(rec: DelegateRecord): Promise<void>;
  /** Fetch one record, or null if absent for this tenant. */
  get(tenantId: string, id: string): Promise<DelegateRecord | null>;
  /** List a tenant's records, ordered by scheduledAt then id, with optional status filter + paging. */
  list(tenantId: string, opts?: ListOptions): Promise<DelegateRecord[]>;
  /** Delete a record; returns true if something was removed. */
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Union of input keys held by the tenant's ACTIVE tasks (overlap guard). */
  activeInputKeys(tenantId: string): Promise<Set<string>>;
}
