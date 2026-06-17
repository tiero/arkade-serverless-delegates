// In-memory DelegateStore (docs/DESIGN.md §5).
//
// Models the R2 keyspace `tenants/{tenantId}/delegates/{id}` and round-trips
// every record through JSON on read/write, so it has the same value semantics
// (no shared references) the R2 implementation will have.

import { inputKey, isActive, type DelegateRecord } from "../types.ts";
import type { DelegateStore, ListOptions } from "./store.ts";

export class InMemoryDelegateStore implements DelegateStore {
  private data = new Map<string, DelegateRecord>();

  private key(tenantId: string, id: string): string {
    return `${tenantId}/${id}`;
  }

  async put(rec: DelegateRecord): Promise<void> {
    this.data.set(this.key(rec.tenantId, rec.id), clone(rec));
  }

  async get(tenantId: string, id: string): Promise<DelegateRecord | null> {
    const rec = this.data.get(this.key(tenantId, id));
    return rec ? clone(rec) : null;
  }

  async list(tenantId: string, opts: ListOptions = {}): Promise<DelegateRecord[]> {
    let recs = [...this.data.values()].filter((r) => r.tenantId === tenantId);
    if (opts.status) recs = recs.filter((r) => r.status === opts.status);
    recs.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id));
    const offset = opts.offset ?? 0;
    const end = opts.limit === undefined ? recs.length : offset + opts.limit;
    return recs.slice(offset, end).map(clone);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.data.delete(this.key(tenantId, id));
  }

  async activeInputKeys(tenantId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const rec of this.data.values()) {
      if (rec.tenantId !== tenantId || !isActive(rec.status)) continue;
      for (const i of rec.intent.inputs) keys.add(inputKey(i));
    }
    return keys;
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
