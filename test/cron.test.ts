import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSweep } from "../src/scheduler/cron.ts";
import { InMemoryDelegateStore } from "../src/store/memory.ts";
import { MockArkClient } from "../src/ark/mock.ts";
import { makeRecord } from "./helpers.ts";

const NOW = 10_000;

describe("runSweep", () => {
  it("dispatches a due pending task to completion", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "due", tenantId: "t_a", status: "pending", scheduledAt: NOW - 1 }));
    const summary = await runSweep(store, new MockArkClient(), "t_a", NOW);
    assert.deepEqual(summary, { recovered: 0, gaveUp: 0, dispatched: 1, completed: 1, failed: 0 });
    assert.equal((await store.get("t_a", "due"))?.status, "completed");
  });

  it("leaves future tasks untouched", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "future", tenantId: "t_a", status: "pending", scheduledAt: NOW + 100 }));
    const summary = await runSweep(store, new MockArkClient(), "t_a", NOW);
    assert.equal(summary.dispatched, 0);
    assert.equal((await store.get("t_a", "future"))?.status, "pending");
  });

  it("recovers a stuck in-flight task, then re-drives it", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(
      makeRecord({
        id: "stuck",
        tenantId: "t_a",
        status: "in_round",
        scheduledAt: NOW - 1000,
        updatedAt: NOW - 1000, // older than default 300s timeout
        attempts: 1,
      }),
    );
    const summary = await runSweep(store, new MockArkClient(), "t_a", NOW);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.completed, 1);
    assert.equal((await store.get("t_a", "stuck"))?.status, "completed");
  });

  it("gives up on a task that exhausted maxAttempts", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(
      makeRecord({ id: "spent", tenantId: "t_a", status: "failed", attempts: 3, scheduledAt: NOW - 1 }),
    );
    const summary = await runSweep(store, new MockArkClient(), "t_a", NOW, { maxAttempts: 3 });
    assert.equal(summary.gaveUp, 1);
    assert.equal(summary.dispatched, 0);
    assert.equal((await store.get("t_a", "spent"))?.status, "failed");
  });

  it("retries a failed task that still has attempts left", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(
      makeRecord({ id: "retry", tenantId: "t_a", status: "failed", attempts: 1, scheduledAt: NOW - 1 }),
    );
    const summary = await runSweep(store, new MockArkClient(), "t_a", NOW, { maxAttempts: 3 });
    assert.equal(summary.recovered, 1);
    assert.equal(summary.completed, 1);
    assert.equal((await store.get("t_a", "retry"))?.status, "completed");
  });

  it("records a failure when the round throws", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "due", tenantId: "t_a", status: "pending", scheduledAt: NOW - 1 }));
    const summary = await runSweep(store, new MockArkClient({ failTimes: 1 }), "t_a", NOW);
    assert.equal(summary.failed, 1);
    assert.equal((await store.get("t_a", "due"))?.status, "failed");
  });

  it("is tenant-scoped: sweeping t_a does not touch t_b", async () => {
    const store = new InMemoryDelegateStore();
    await store.put(makeRecord({ id: "a", tenantId: "t_a", status: "pending", scheduledAt: NOW - 1 }));
    await store.put(makeRecord({ id: "b", tenantId: "t_b", status: "pending", scheduledAt: NOW - 1 }));
    await runSweep(store, new MockArkClient(), "t_a", NOW);
    assert.equal((await store.get("t_b", "b"))?.status, "pending");
  });
});
