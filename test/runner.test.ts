import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runDelegate } from "../src/runner/runner.ts";
import { InMemoryDelegateStore } from "../src/store/memory.ts";
import { MockArkClient } from "../src/ark/mock.ts";
import { makeRecord } from "./helpers.ts";

const NOW = 1_000;

async function seed(store: InMemoryDelegateStore, over = {}) {
  const rec = makeRecord({ id: "del_1", tenantId: "t_a", status: "pending", ...over });
  await store.put(rec);
  return rec;
}

describe("runDelegate", () => {
  it("renews a pending task to completed and records the commitment txid", async () => {
    const store = new InMemoryDelegateStore();
    await seed(store);
    const ark = new MockArkClient({ txidPrefix: "cmt" });

    const out = await runDelegate(store, ark, "t_a", "del_1", NOW);
    assert.ok(out.ran);
    const rec = (await store.get("t_a", "del_1"))!;
    assert.equal(rec.status, "completed");
    assert.equal(rec.commitmentTxid, "cmt_1");
    assert.equal(rec.attempts, 1);
  });

  it("forwards the user's pre-signed material verbatim (custody invariant)", async () => {
    const store = new InMemoryDelegateStore();
    const rec = await seed(store);
    const ark = new MockArkClient();

    await runDelegate(store, ark, "t_a", "del_1", NOW);
    assert.equal(ark.calls.length, 1);
    assert.deepEqual(ark.calls[0], {
      intentMessage: rec.intent.message,
      intentProof: rec.intent.proof,
      forfeitTxs: rec.forfeitTxs,
    });
  });

  it("marks the task failed (with reason) when the round throws", async () => {
    const store = new InMemoryDelegateStore();
    await seed(store);
    const ark = new MockArkClient({ failTimes: 1, failMessage: "round rejected" });

    const out = await runDelegate(store, ark, "t_a", "del_1", NOW);
    assert.ok(out.ran);
    const rec = (await store.get("t_a", "del_1"))!;
    assert.equal(rec.status, "failed");
    assert.match(rec.failReason, /round rejected/);
    assert.equal(rec.commitmentTxid, "");
    assert.equal(rec.attempts, 1);
  });

  it("is idempotent: non-pending tasks are no-ops", async () => {
    const store = new InMemoryDelegateStore();
    await seed(store, { status: "completed", commitmentTxid: "done" });
    const ark = new MockArkClient();

    const out = await runDelegate(store, ark, "t_a", "del_1", NOW);
    assert.equal(out.ran, false);
    assert.equal(ark.calls.length, 0);
  });

  it("supports retry after a reset to pending (attempts accumulate)", async () => {
    const store = new InMemoryDelegateStore();
    await seed(store);
    const ark = new MockArkClient({ failTimes: 1, failMessage: "transient" });

    await runDelegate(store, ark, "t_a", "del_1", NOW); // fails
    const failed = (await store.get("t_a", "del_1"))!;
    failed.status = "pending"; // sweep would do this
    await store.put(failed);

    const out = await runDelegate(store, ark, "t_a", "del_1", NOW + 1);
    assert.ok(out.ran);
    const rec = (await store.get("t_a", "del_1"))!;
    assert.equal(rec.status, "completed");
    assert.equal(rec.attempts, 2);
  });

  it("404s an unknown id", async () => {
    const store = new InMemoryDelegateStore();
    const out = await runDelegate(store, new MockArkClient(), "t_a", "nope", NOW);
    assert.equal(out.ran, false);
  });
});
