// R2-backed DelegateStore (docs/DESIGN.md §5). Conforms to the same contract as
// InMemoryDelegateStore, so the store contract tests cover its semantics
// (`test/r2-store.test.ts` runs them against an in-memory R2 fake). Runtime
// verification against real R2 / miniflare is Phase 4.
//
// Keyspace: tenants/{tenantId}/delegates/{id}.json

import { inputKey, isActive, type DelegateRecord } from "../types.ts";
import type { DelegateStore, ListOptions } from "./store.ts";

/** Minimal structural view of the R2 binding — avoids a workers-types dependency. */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ objects: { key: string }[] }>;
}

export class R2DelegateStore implements DelegateStore {
  private bucket: R2Like;
  constructor(bucket: R2Like) {
    this.bucket = bucket;
  }

  private prefix(tenantId: string): string {
    return `tenants/${tenantId}/delegates/`;
  }
  private key(tenantId: string, id: string): string {
    return `${this.prefix(tenantId)}${id}.json`;
  }

  async put(rec: DelegateRecord): Promise<void> {
    await this.bucket.put(this.key(rec.tenantId, rec.id), JSON.stringify(rec));
  }

  async get(tenantId: string, id: string): Promise<DelegateRecord | null> {
    const obj = await this.bucket.get(this.key(tenantId, id));
    return obj ? (JSON.parse(await obj.text()) as DelegateRecord) : null;
  }

  async list(tenantId: string, opts: ListOptions = {}): Promise<DelegateRecord[]> {
    // NOTE: R2 list() is capped (~1000) and may be truncated; large tenants need
    // cursor paging + a status index (Phase 4). Fine for the reference scale.
    const listed = await this.bucket.list({ prefix: this.prefix(tenantId) });
    const recs: DelegateRecord[] = [];
    for (const o of listed.objects) {
      const obj = await this.bucket.get(o.key);
      if (obj) recs.push(JSON.parse(await obj.text()) as DelegateRecord);
    }
    let out = opts.status ? recs.filter((r) => r.status === opts.status) : recs;
    out = out.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id));
    const offset = opts.offset ?? 0;
    const end = opts.limit === undefined ? out.length : offset + opts.limit;
    return out.slice(offset, end);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const existed = (await this.bucket.get(this.key(tenantId, id))) !== null;
    await this.bucket.delete(this.key(tenantId, id));
    return existed;
  }

  async activeInputKeys(tenantId: string): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const rec of await this.list(tenantId)) {
      if (!isActive(rec.status)) continue;
      for (const i of rec.intent.inputs) keys.add(inputKey(i));
    }
    return keys;
  }
}
