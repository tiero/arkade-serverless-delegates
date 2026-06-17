import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDelegateStore } from "../src/store/memory.ts";
import { makeRecord } from "./helpers.ts";

describe("DelegateStore (in-memory)", () => {
  it("puts and gets a record by tenant + id", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a" }));
    const got = await store.get("t_a", "del_1");
    assert.equal(got?.id, "del_1");
    assert.equal(await store.get("t_a", "nope"), null);
  });

  it("isolates tenants", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a" }));
    assert.equal(await store.get("t_b", "del_1"), null);
    assert.deepEqual(await store.list("t_b"), []);
  });

  it("returns clones, not internal references", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a", fee: 100 }));
    const got = (await store.get("t_a", "del_1"))!;
    got.fee = 999;
    const again = (await store.get("t_a", "del_1"))!;
    assert.equal(again.fee, 100);
  });

  it("filters by status and orders by scheduledAt", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "del_2", tenantId: "t_a", scheduledAt: 200, status: "pending" }));
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a", scheduledAt: 100, status: "pending" }));
    await store.put(makeRecord({ id: "del_3", tenantId: "t_a", scheduledAt: 300, status: "completed" }));

    const pending = await store.list("t_a", { status: "pending" });
    assert.deepEqual(pending.map((r) => r.id), ["del_1", "del_2"]);
    const completed = await store.list("t_a", { status: "completed" });
    assert.deepEqual(completed.map((r) => r.id), ["del_3"]);
  });

  it("paginates with limit + offset", async () => {
    const store = new InMemoryDelegateStore();
    for (let i = 0; i < 5; i++) {
      await store.put(makeRecord({ id: `del_${i}`, tenantId: "t_a", scheduledAt: i }));
    }
    const page = await store.list("t_a", { limit: 2, offset: 2 });
    assert.deepEqual(page.map((r) => r.id), ["del_2", "del_3"]);
  });

  it("deletes and reports whether anything was removed", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a" }));
    assert.equal(await store.delete("t_a", "del_1"), true);
    assert.equal(await store.delete("t_a", "del_1"), false);
    assert.equal(await store.get("t_a", "del_1"), null);
  });

  it("collects active input keys only (overlap guard source)", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(
      makeRecord({
        id: "active",
        tenantId: "t_a",
        status: "pending",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "x", vout: 0 }] },
      }),
    );
    await store.put(
      makeRecord({
        id: "done",
        tenantId: "t_a",
        status: "completed",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "y", vout: 0 }] },
      }),
    );
    const keys = await store.activeInputKeys("t_a");
    assert.ok(keys.has("x:0"));
    assert.ok(!keys.has("y:0")); // completed task releases its inputs
  });
});
