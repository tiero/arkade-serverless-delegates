// In-memory DelegateRepository for local dev and tests. Round-trips every record
// through structuredClone so callers can't mutate stored state by reference —
// the same value semantics the R2 adapter gets from JSON.

import type { DelegateTaskState } from "../domain/task.ts";
import type { DelegateRepository, ListOptions } from "../application/ports.ts";
import { activeKeysOf, filterSortPage, overlappingActiveKeys } from "./repository-helpers.ts";

export class InMemoryDelegateRepository implements DelegateRepository {
  private data = new Map<string, DelegateTaskState>();

  private key(tenantId: string, id: string): string {
    return `${tenantId}/${id}`;
  }

  async save(state: DelegateTaskState): Promise<void> {
    this.data.set(this.key(state.tenantId, state.id), structuredClone(state));
  }

  // No `await` between the overlap read and the write => atomic within this
  // isolate: a second concurrent claim on the same input sees the first's write.
  async saveIfNoOverlap(state: DelegateTaskState): Promise<string[]> {
    const recs = [...this.data.values()].filter((r) => r.tenantId === state.tenantId);
    const conflicts = overlappingActiveKeys(recs, state);
    if (conflicts.length > 0) return conflicts;
    this.data.set(this.key(state.tenantId, state.id), structuredClone(state));
    return [];
  }

  async load(tenantId: string, id: string): Promise<DelegateTaskState | null> {
    const rec = this.data.get(this.key(tenantId, id));
    return rec ? structuredClone(rec) : null;
  }

  async list(tenantId: string, opts: ListOptions = {}): Promise<DelegateTaskState[]> {
    const recs = [...this.data.values()].filter((r) => r.tenantId === tenantId).map((r) => structuredClone(r));
    return filterSortPage(recs, opts);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.data.delete(this.key(tenantId, id));
  }

  async activeInputKeys(tenantId: string): Promise<Set<string>> {
    return activeKeysOf([...this.data.values()].filter((r) => r.tenantId === tenantId));
  }
}
