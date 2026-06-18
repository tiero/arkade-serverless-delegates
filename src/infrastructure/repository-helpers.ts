// Shared repository logic so the in-memory and R2 adapters implement one
// identical contract (no drift). Pure functions over plain state.

import { inputKey, isActive, type DelegateTaskState } from "../domain/task.ts";
import type { ListOptions } from "../application/ports.ts";

/** Filter by status, order by (scheduledAt, id), then apply offset/limit. */
export function filterSortPage(recs: DelegateTaskState[], opts: ListOptions = {}): DelegateTaskState[] {
  const filtered = opts.status ? recs.filter((r) => r.status === opts.status) : recs.slice();
  filtered.sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id));
  const offset = opts.offset ?? 0;
  const end = opts.limit === undefined ? filtered.length : offset + opts.limit;
  return filtered.slice(offset, end);
}

/** Union of input keys held by ACTIVE tasks. */
export function activeKeysOf(recs: DelegateTaskState[]): Set<string> {
  const keys = new Set<string>();
  for (const r of recs) {
    if (!isActive(r.status)) continue;
    for (const i of r.intent.inputs) keys.add(inputKey(i));
  }
  return keys;
}

/** Input keys of `state` that overlap an ACTIVE task in `recs` (empty => no overlap). */
export function overlappingActiveKeys(recs: DelegateTaskState[], state: DelegateTaskState): string[] {
  const active = activeKeysOf(recs);
  return state.intent.inputs.map(inputKey).filter((k) => active.has(k));
}
