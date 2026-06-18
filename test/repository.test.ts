import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryDelegateRepository } from "../src/infrastructure/in-memory-repository.ts";
import { R2DelegateRepository, type R2Like } from "../src/infrastructure/r2-repository.ts";
import type { DelegateRepository } from "../src/application/ports.ts";
import { makeState } from "./helpers.ts";

// Fake R2 with configurable page size so the cursor path is exercised.
class FakeR2 implements R2Like {
  map = new Map<string, string>();
  private pageSize: number;
  constructor(pageSize = 1000) {
    this.pageSize = pageSize;
  }
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
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    const truncated = next < keys.length;
    return { objects: slice.map((key) => ({ key })), truncated, cursor: truncated ? String(next) : undefined };
  }
}

function contract(name: string, makeRepo: () => DelegateRepository) {
  describe(`DelegateRepository contract: ${name}`, () => {
    it("saves, loads, and isolates tenants", async () => {
      const repo = makeRepo();
      await repo.save(makeState({ id: "del_1", tenantId: "t_a" }));
      assert.equal((await repo.load("t_a", "del_1"))?.id, "del_1");
      assert.equal(await repo.load("t_b", "del_1"), null);
      assert.deepEqual(await repo.list("t_b"), []);
    });

    it("returns value copies, not shared references", async () => {
      const repo = makeRepo();
      await repo.save(makeState({ id: "del_1", tenantId: "t_a", fee: 100 }));
      const got = (await repo.load("t_a", "del_1"))!;
      got.fee = 999;
      assert.equal((await repo.load("t_a", "del_1"))?.fee, 100);
    });

    it("filters by status and orders by scheduledAt", async () => {
      const repo = makeRepo();
      await repo.save(makeState({ id: "del_2", tenantId: "t_a", scheduledAt: 200, status: "pending" }));
      await repo.save(makeState({ id: "del_1", tenantId: "t_a", scheduledAt: 100, status: "pending" }));
      await repo.save(makeState({ id: "del_3", tenantId: "t_a", scheduledAt: 300, status: "completed" }));
      const pending = await repo.list("t_a", { status: "pending" });
      assert.deepEqual(pending.map((r) => r.id), ["del_1", "del_2"]);
    });

    it("paginates with limit + offset", async () => {
      const repo = makeRepo();
      for (let i = 0; i < 5; i++) {
        await repo.save(makeState({ id: `del_${i}`, tenantId: "t_a", scheduledAt: i }));
      }
      const page = await repo.list("t_a", { limit: 2, offset: 2 });
      assert.deepEqual(page.map((r) => r.id), ["del_2", "del_3"]);
    });

    it("reports whether remove deleted anything", async () => {
      const repo = makeRepo();
      await repo.save(makeState({ id: "del_1", tenantId: "t_a" }));
      assert.equal(await repo.remove("t_a", "del_1"), true);
      assert.equal(await repo.remove("t_a", "del_1"), false);
    });

    it("collects active input keys only", async () => {
      const repo = makeRepo();
      await repo.save(
        makeState({
          id: "active",
          tenantId: "t_a",
          status: "registering",
          intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "x", vout: 0 }] },
        }),
      );
      await repo.save(
        makeState({
          id: "done",
          tenantId: "t_a",
          status: "completed",
          intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "y", vout: 0 }] },
        }),
      );
      const keys = await repo.activeInputKeys("t_a");
      assert.ok(keys.has("x:0"));
      assert.ok(!keys.has("y:0"));
    });

    it("saveIfNoOverlap persists when clear and reports conflicts otherwise", async () => {
      const repo = makeRepo();
      const first = makeState({
        id: "first",
        tenantId: "t_a",
        status: "pending",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "x", vout: 0 }] },
      });
      assert.deepEqual(await repo.saveIfNoOverlap(first), []); // clear -> saved
      assert.equal((await repo.load("t_a", "first"))?.id, "first");

      // A second task sharing input x:0 conflicts and is NOT persisted.
      const clash = makeState({
        id: "clash",
        tenantId: "t_a",
        status: "pending",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "x", vout: 0 }] },
      });
      assert.deepEqual(await repo.saveIfNoOverlap(clash), ["x:0"]);
      assert.equal(await repo.load("t_a", "clash"), null);

      // A different input is fine; another tenant reusing x:0 is also fine.
      const otherInput = makeState({
        id: "other",
        tenantId: "t_a",
        status: "pending",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "z", vout: 0 }] },
      });
      assert.deepEqual(await repo.saveIfNoOverlap(otherInput), []);
      const otherTenant = makeState({
        id: "ten_b",
        tenantId: "t_b",
        status: "pending",
        intent: { txid: "t", message: "m", proof: "p", inputs: [{ txid: "x", vout: 0 }] },
      });
      assert.deepEqual(await repo.saveIfNoOverlap(otherTenant), []);
    });
  });
}

contract("in-memory", () => new InMemoryDelegateRepository());
// pageSize 2 forces the R2 cursor path on every multi-record listing.
contract("r2", () => new R2DelegateRepository(new FakeR2(2)));

describe("R2DelegateRepository specifics", () => {
  it("follows the list cursor so >pageSize records are not truncated", async () => {
    const fake = new FakeR2(2);
    const repo = new R2DelegateRepository(fake);
    for (let i = 0; i < 5; i++) {
      await repo.save(makeState({ id: `del_${i}`, tenantId: "t_a", scheduledAt: i }));
    }
    const all = await repo.list("t_a");
    assert.equal(all.length, 5); // would be 2 if the cursor were ignored
  });

  it("skips a corrupt object instead of failing the whole read", async () => {
    const fake = new FakeR2(10);
    const repo = new R2DelegateRepository(fake);
    await repo.save(makeState({ id: "del_ok", tenantId: "t_a" }));
    await fake.put("tenants/t_a/delegates/corrupt.json", "{ not json");
    const all = await repo.list("t_a");
    assert.deepEqual(all.map((r) => r.id), ["del_ok"]);
    assert.equal(await repo.load("t_a", "corrupt"), null);
  });
});
