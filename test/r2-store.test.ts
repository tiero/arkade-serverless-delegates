import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { R2DelegateStore, type R2Like } from "../src/store/r2.ts";
import { makeRecord } from "./helpers.ts";

// In-memory fake of the R2 binding subset the store uses — lets us run the store
// contract against R2DelegateStore without the Workers runtime.
class FakeR2 implements R2Like {
  map = new Map<string, string>();
  async get(key: string) {
    const v = this.map.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  }
}

describe("R2DelegateStore (store contract over a fake R2)", () => {
  it("round-trips a record and isolates tenants", async () => {
    const store = new R2DelegateStore(new FakeR2());
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a" }));
    assert.equal((await store.get("t_a", "del_1"))?.id, "del_1");
    assert.equal(await store.get("t_b", "del_1"), null);
    assert.deepEqual(await store.list("t_b"), []);
  });

  it("filters by status and orders by scheduledAt", async () => {
    const store = new R2DelegateStore(new FakeR2());
    await store.put(makeRecord({ id: "del_2", tenantId: "t_a", scheduledAt: 200, status: "pending" }));
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a", scheduledAt: 100, status: "pending" }));
    await store.put(makeRecord({ id: "del_3", tenantId: "t_a", scheduledAt: 300, status: "completed" }));
    const pending = await store.list("t_a", { status: "pending" });
    assert.deepEqual(pending.map((r) => r.id), ["del_1", "del_2"]);
  });

  it("reports whether a delete removed anything", async () => {
    const store = new R2DelegateStore(new FakeR2());
    await store.put(makeRecord({ id: "del_1", tenantId: "t_a" }));
    assert.equal(await store.delete("t_a", "del_1"), true);
    assert.equal(await store.delete("t_a", "del_1"), false);
  });

  it("collects active input keys only", async () => {
    const store = new R2DelegateStore(new FakeR2());
    await store.put(
      makeRecord({
        id: "active",
        tenantId: "t_a",
        status: "registering",
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
    assert.ok(!keys.has("y:0"));
  });
});
