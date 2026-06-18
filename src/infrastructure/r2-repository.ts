// R2-backed DelegateRepository. Conforms to the same contract as the in-memory
// adapter (see test/repository.test.ts, which runs both through one suite).
//
// Keyspace: tenants/{tenantId}/delegates/{id}.json
//
// Hardening over a naive version:
//  - readAll() follows the R2 list cursor, so tenants with >1000 records are not
//    silently truncated (which would skip due renewals — docs/DESIGN.md §8.1).
//  - corrupt/non-JSON objects are skipped rather than throwing and breaking the
//    whole listing.

import type { DelegateTaskState } from "../domain/task.ts";
import type { DelegateRepository, ListOptions } from "../application/ports.ts";
import { activeKeysOf, filterSortPage, overlappingActiveKeys } from "./repository-helpers.ts";

/** Minimal structural view of the R2 binding — avoids a workers-types dependency. */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export class R2DelegateRepository implements DelegateRepository {
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

  async save(state: DelegateTaskState): Promise<void> {
    await this.bucket.put(this.key(state.tenantId, state.id), JSON.stringify(state));
  }

  // R2 has no compare-and-swap, so readAll()->put() yields between read and
  // write: this enforces the overlap guard, but cross-isolate strictness relies
  // on the per-tenant DelegateRunner DO serializing a tenant's writes (§8.1).
  async saveIfNoOverlap(state: DelegateTaskState): Promise<string[]> {
    const conflicts = overlappingActiveKeys(await this.readAll(state.tenantId), state);
    if (conflicts.length > 0) return conflicts;
    await this.save(state);
    return [];
  }

  async load(tenantId: string, id: string): Promise<DelegateTaskState | null> {
    const obj = await this.bucket.get(this.key(tenantId, id));
    return obj ? safeParse(await obj.text()) : null;
  }

  async list(tenantId: string, opts: ListOptions = {}): Promise<DelegateTaskState[]> {
    return filterSortPage(await this.readAll(tenantId), opts);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const existed = (await this.bucket.get(this.key(tenantId, id))) !== null;
    await this.bucket.delete(this.key(tenantId, id));
    return existed;
  }

  async activeInputKeys(tenantId: string): Promise<Set<string>> {
    return activeKeysOf(await this.readAll(tenantId));
  }

  private async readAll(tenantId: string): Promise<DelegateTaskState[]> {
    const recs: DelegateTaskState[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix: this.prefix(tenantId), cursor });
      for (const o of listed.objects) {
        const obj = await this.bucket.get(o.key);
        if (!obj) continue;
        const parsed = safeParse(await obj.text());
        if (parsed) recs.push(parsed);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return recs;
  }
}

function safeParse(text: string): DelegateTaskState | null {
  try {
    return JSON.parse(text) as DelegateTaskState;
  } catch {
    return null; // skip corrupt objects rather than failing the whole read
  }
}
