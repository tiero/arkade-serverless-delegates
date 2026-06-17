import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MockArkadeClient, RestArkadeClient } from "../src/infrastructure/arkade-clients.ts";

const req = { intentMessage: "m", intentProof: "p", forfeitTxs: [] };

describe("MockArkadeClient", () => {
  it("settles, returns a commitment txid, and records calls", async () => {
    const ark = new MockArkadeClient({ txidPrefix: "cmt" });
    const res = await ark.settleDelegatedIntent(req);
    assert.equal(res.commitmentTxid, "cmt_1");
    assert.equal(ark.calls.length, 1);
  });

  it("fails the configured number of times, then succeeds", async () => {
    const ark = new MockArkadeClient({ failTimes: 2, failMessage: "boom" });
    await assert.rejects(() => ark.settleDelegatedIntent(req), /boom/);
    await assert.rejects(() => ark.settleDelegatedIntent(req), /boom/);
    assert.match((await ark.settleDelegatedIntent(req)).commitmentTxid, /_3$/);
  });
});

describe("RestArkadeClient", () => {
  it("is an explicit NotImplemented stub (Phase 3) — throws, never fakes success", async () => {
    const ark = new RestArkadeClient("https://arkade.example.com");
    await assert.rejects(() => ark.settleDelegatedIntent(req), /not implemented yet \(Phase 3\)/);
  });
});
