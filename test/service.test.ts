import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cancelDelegate, createDelegate } from "../src/core/service.ts";
import { InMemoryDelegateStore } from "../src/store/memory.ts";
import { makeRequest } from "./helpers.ts";

const NOW = 1_000_000_000;

describe("createDelegate", () => {
  it("stores a pending task and returns it", async () => {
    const store = new InMemoryDelegateStore();
    const res = await createDelegate(store, "t_a", makeRequest(), NOW);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.record.status, "pending");
    assert.match(res.record.id, /^del_/);
    assert.equal((await store.get("t_a", res.record.id))?.id, res.record.id);
  });

  it("stores the user's intent verbatim (no custody / no rewrite)", async () => {
    const store = new InMemoryDelegateStore();
    const req = makeRequest();
    const res = await createDelegate(store, "t_a", req, NOW);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(res.record.intent, req.intent);
    assert.deepEqual(res.record.forfeitTxs, req.forfeitTxs);
  });

  it("rejects invalid hand-offs with 400", async () => {
    const store = new InMemoryDelegateStore();
    const res = await createDelegate(store, "t_a", makeRequest({ fee: -1 }), NOW);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 400);
  });

  it("rejects inputs already claimed by an active task with 409", async () => {
    const store = new InMemoryDelegateStore();
    const first = await createDelegate(store, "t_a", makeRequest(), NOW);
    assert.ok(first.ok);
    const dup = await createDelegate(store, "t_a", makeRequest(), NOW); // same default input
    assert.equal(dup.ok, false);
    if (dup.ok) return;
    assert.equal(dup.status, 409);
  });

  it("isolates tenants: same input is fine for a different tenant", async () => {
    const store = new InMemoryDelegateStore();
    assert.ok((await createDelegate(store, "t_a", makeRequest(), NOW)).ok);
    assert.ok((await createDelegate(store, "t_b", makeRequest(), NOW)).ok);
  });
});

describe("cancelDelegate", () => {
  it("cancels a pending task", async () => {
    const store = new InMemoryDelegateStore();
    const created = await createDelegate(store, "t_a", makeRequest(), NOW);
    assert.ok(created.ok);
    if (!created.ok) return;
    const res = await cancelDelegate(store, "t_a", created.record.id, NOW + 1);
    assert.ok(res.ok);
    assert.equal((await store.get("t_a", created.record.id))?.status, "cancelled");
  });

  it("404s an unknown id, and is tenant-scoped", async () => {
    const store = new InMemoryDelegateStore();
    const created = await createDelegate(store, "t_a", makeRequest(), NOW);
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal((await cancelDelegate(store, "t_a", "nope", NOW)).ok, false);
    // another tenant cannot see or cancel it
    const cross = await cancelDelegate(store, "t_b", created.record.id, NOW);
    assert.equal(cross.ok, false);
    if (cross.ok) return;
    assert.equal(cross.status, 404);
  });

  it("refuses to cancel a non-pending task with 409", async () => {
    const store = new InMemoryDelegateStore();
    const created = await createDelegate(store, "t_a", makeRequest(), NOW);
    assert.ok(created.ok);
    if (!created.ok) return;
    const rec = (await store.get("t_a", created.record.id))!;
    rec.status = "in_round";
    await store.put(rec);
    const res = await cancelDelegate(store, "t_a", created.record.id, NOW);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.status, 409);
  });
});
