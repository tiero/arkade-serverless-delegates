import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cancelDelegate,
  createDelegate,
  runDelegate,
  sweepDelegates,
} from "../src/application/use-cases.ts";
import { ConflictError, NotFoundError, ValidationError } from "../src/domain/errors.ts";
import { InMemoryDelegateRepository } from "../src/infrastructure/in-memory-repository.ts";
import { MockArkadeClient } from "../src/infrastructure/arkade-clients.ts";
import { FixedClock, makeCreateInput, makeState } from "./helpers.ts";

const NOW = 1_000_000_000;

describe("createDelegate", () => {
  it("stores a pending task with the intent verbatim (no custody)", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    const input = makeCreateInput();
    const state = await createDelegate(repo, clock, "t_a", input);
    assert.equal(state.status, "pending");
    assert.match(state.id, /^del_/);
    assert.deepEqual(state.intent, input.intent);
    assert.deepEqual(state.forfeitTxs, input.forfeitTxs);
  });

  it("rejects malformed input with ValidationError (not a crash)", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    await assert.rejects(
      () => createDelegate(repo, clock, "t_a", makeCreateInput({ forfeitTxs: [{ forfeitTx: "00" }] })),
      ValidationError,
    );
    await assert.rejects(
      () => createDelegate(repo, clock, "t_a", makeCreateInput({ fee: 1.5 })),
      ValidationError,
    );
  });

  it("rejects overlapping inputs with ConflictError, but isolates tenants", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    await createDelegate(repo, clock, "t_a", makeCreateInput());
    await assert.rejects(() => createDelegate(repo, clock, "t_a", makeCreateInput()), ConflictError);
    assert.ok(await createDelegate(repo, clock, "t_b", makeCreateInput())); // other tenant ok
  });

  it("lets only one of two CONCURRENT creates claim the same inputs (atomic guard)", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    const input = makeCreateInput(); // both requests claim the same input
    // Fire both without awaiting between them: the old read-then-save guard let
    // both through (each saw an empty active set before either saved).
    const results = await Promise.allSettled([
      createDelegate(repo, clock, "t_a", input),
      createDelegate(repo, clock, "t_a", input),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one create wins");
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ConflictError);
    assert.equal((await repo.list("t_a")).length, 1, "only one task persisted");
  });
});

describe("cancelDelegate", () => {
  it("cancels pending, 404s unknown/cross-tenant", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    const created = await createDelegate(repo, clock, "t_a", makeCreateInput());

    await assert.rejects(() => cancelDelegate(repo, clock, "t_a", "nope"), NotFoundError);

    const other = await createDelegate(repo, clock, "t_b", makeCreateInput());
    await assert.rejects(() => cancelDelegate(repo, clock, "t_a", other.id), NotFoundError); // cross-tenant

    const ownCancel = await cancelDelegate(repo, clock, "t_b", other.id); // owner cancels its own pending task
    assert.equal(ownCancel.status, "cancelled");
    const cancelled = await cancelDelegate(repo, clock, "t_a", created.id);
    assert.equal(cancelled.status, "cancelled");
  });

  it("409s a non-pending task", async () => {
    const repo = new InMemoryDelegateRepository();
    const clock = new FixedClock(NOW);
    await repo.save(makeState({ id: "del_x", tenantId: "t_a", status: "in_round" }));
    await assert.rejects(() => cancelDelegate(repo, clock, "t_a", "del_x"), ConflictError);
  });
});

describe("runDelegate", () => {
  async function seed(repo: InMemoryDelegateRepository, over = {}) {
    const s = makeState({ id: "del_1", tenantId: "t_a", status: "pending", ...over });
    await repo.save(s);
    return s;
  }

  it("renews a pending task to completed and forwards material verbatim", async () => {
    const repo = new InMemoryDelegateRepository();
    const s = await seed(repo);
    const ark = new MockArkadeClient({ txidPrefix: "cmt" });
    const out = await runDelegate(repo, ark, new FixedClock(10), "t_a", "del_1");
    assert.ok(out.ran);
    assert.equal(out.state?.status, "completed");
    assert.equal(out.state?.commitmentTxid, "cmt_1");
    assert.deepEqual(ark.calls[0], {
      intentMessage: s.intent.message,
      intentProof: s.intent.proof,
      forfeitTxs: s.forfeitTxs,
    });
  });

  it("records failure and is idempotent on non-pending", async () => {
    const repo = new InMemoryDelegateRepository();
    await seed(repo);
    const ark = new MockArkadeClient({ failTimes: 1, failMessage: "round rejected" });
    const failed = await runDelegate(repo, ark, new FixedClock(10), "t_a", "del_1");
    assert.equal(failed.state?.status, "failed");
    assert.match(failed.state?.failReason ?? "", /round rejected/);

    const again = await runDelegate(repo, ark, new FixedClock(11), "t_a", "del_1");
    assert.equal(again.ran, false); // failed is not pending -> no-op
    assert.equal(ark.calls.length, 1);
  });
});

describe("sweepDelegates", () => {
  it("dispatches a due pending task to completion", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(makeState({ id: "due", tenantId: "t_a", status: "pending", scheduledAt: 9_999 }));
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a");
    assert.deepEqual(summary, {
      recovered: 0,
      gaveUp: 0,
      dispatched: 1,
      completed: 1,
      failed: 0,
      escalated: 0,
      expired: 0,
    });
  });

  it("survives missed crons: a long-overdue task still runs on the next sweep", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(makeState({ id: "overdue", tenantId: "t_a", status: "pending", scheduledAt: 1 }));
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(1_000_000), "t_a");
    assert.equal(summary.completed, 1);
  });

  it("leaves future tasks untouched", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(makeState({ id: "future", tenantId: "t_a", status: "pending", scheduledAt: 20_000 }));
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a");
    assert.equal(summary.dispatched, 0);
  });

  it("recovers a stuck in-flight task but does NOT re-dispatch it the same tick", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(
      makeState({
        id: "stuck",
        tenantId: "t_a",
        status: "in_round",
        scheduledAt: 100,
        updatedAt: 100, // older than 300s timeout at now=10000
        attempts: 1,
      }),
    );
    const ark = new MockArkadeClient();
    const first = await sweepDelegates(repo, ark, new FixedClock(10_000), "t_a");
    assert.equal(first.recovered, 1);
    assert.equal(first.dispatched, 0); // not re-submitted same tick (avoids double-submit)
    assert.equal(ark.calls.length, 0);
    assert.equal((await repo.load("t_a", "stuck"))?.status, "pending");

    const second = await sweepDelegates(repo, ark, new FixedClock(10_001), "t_a");
    assert.equal(second.completed, 1); // dispatched on the next sweep
  });

  it("gives up after maxAttempts", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(makeState({ id: "spent", tenantId: "t_a", status: "failed", attempts: 3, scheduledAt: 1 }));
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a", {
      maxAttempts: 3,
    });
    assert.equal(summary.gaveUp, 1);
    assert.equal((await repo.load("t_a", "spent"))?.status, "failed");
  });

  it("is tenant-scoped", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(makeState({ id: "a", tenantId: "t_a", status: "pending", scheduledAt: 1 }));
    await repo.save(makeState({ id: "b", tenantId: "t_b", status: "pending", scheduledAt: 1 }));
    await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a");
    assert.equal((await repo.load("t_b", "b"))?.status, "pending");
  });
});

describe("sweepDelegates — near-expiry escalation (DESIGN §8.1)", () => {
  // now=10_000; window=3600 => urgent when expiresAt in (10_000, 13_600].
  it("force-dispatches an urgent task whose scheduledAt is still in the future", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(
      makeState({ id: "urgent", tenantId: "t_a", status: "pending", scheduledAt: 20_000, expiresAt: 12_000 }),
    );
    const ark = new MockArkadeClient();
    const summary = await sweepDelegates(repo, ark, new FixedClock(10_000), "t_a");
    assert.equal(summary.dispatched, 1, "pulled forward despite scheduledAt > now");
    assert.equal(summary.completed, 1);
    assert.equal(summary.escalated, 1);
    assert.equal(ark.calls.length, 1);
  });

  it("does NOT force-dispatch a future task that is still far from expiry", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(
      makeState({ id: "far", tenantId: "t_a", status: "pending", scheduledAt: 20_000, expiresAt: 100_000 }),
    );
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a");
    assert.equal(summary.dispatched, 0);
    assert.equal(summary.escalated, 0);
  });

  it("retries an urgent failed task past the normal maxAttempts cap", async () => {
    const repo = new InMemoryDelegateRepository();
    // attempts == maxAttempts(3): a non-urgent task gives up; an urgent one recovers.
    await repo.save(
      makeState({ id: "spent", tenantId: "t_a", status: "failed", attempts: 3, scheduledAt: 1, expiresAt: 12_000 }),
    );
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a", {
      maxAttempts: 3,
      maxUrgentAttempts: 6,
    });
    assert.equal(summary.gaveUp, 0);
    assert.equal(summary.recovered, 1);
    assert.equal(summary.escalated, 1);
    assert.equal((await repo.load("t_a", "spent"))?.status, "pending");
  });

  it("gives up an urgent task once even the urgent cap is exhausted", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(
      makeState({ id: "done", tenantId: "t_a", status: "failed", attempts: 6, scheduledAt: 1, expiresAt: 12_000 }),
    );
    const summary = await sweepDelegates(repo, new MockArkadeClient(), new FixedClock(10_000), "t_a", {
      maxUrgentAttempts: 6,
    });
    assert.equal(summary.gaveUp, 1);
    assert.equal(summary.recovered, 0);
  });

  it("fails an active task whose VTXO hard-expired, instead of dispatching it", async () => {
    const repo = new InMemoryDelegateRepository();
    await repo.save(
      makeState({ id: "gone", tenantId: "t_a", status: "pending", scheduledAt: 1, expiresAt: 9_000 }),
    );
    const ark = new MockArkadeClient();
    const summary = await sweepDelegates(repo, ark, new FixedClock(10_000), "t_a");
    assert.equal(summary.expired, 1);
    assert.equal(summary.dispatched, 0);
    assert.equal(ark.calls.length, 0, "never tries to renew a swept VTXO");
    const gone = await repo.load("t_a", "gone");
    assert.equal(gone?.status, "failed");
    assert.match(gone?.failReason ?? "", /hard-expired/);
  });
});
