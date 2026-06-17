import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MockArkClient } from "../src/ark/mock.ts";

const req = { intentMessage: "m", intentProof: "p", forfeitTxs: [] };

describe("MockArkClient (ArkClient contract)", () => {
  it("settles and returns a commitment txid", async () => {
    const ark = new MockArkClient({ txidPrefix: "cmt" });
    const res = await ark.settleDelegatedIntent(req);
    assert.equal(res.commitmentTxid, "cmt_1");
    assert.equal(ark.calls.length, 1);
  });

  it("records every call", async () => {
    const ark = new MockArkClient();
    await ark.settleDelegatedIntent({ ...req, intentMessage: "first" });
    await ark.settleDelegatedIntent({ ...req, intentMessage: "second" });
    assert.deepEqual(ark.calls.map((c) => c.intentMessage), ["first", "second"]);
  });

  it("fails the configured number of times, then succeeds (retry seam)", async () => {
    const ark = new MockArkClient({ failTimes: 2, failMessage: "boom" });
    await assert.rejects(() => ark.settleDelegatedIntent(req), /boom/);
    await assert.rejects(() => ark.settleDelegatedIntent(req), /boom/);
    const res = await ark.settleDelegatedIntent(req);
    assert.match(res.commitmentTxid, /_3$/);
    assert.equal(ark.calls.length, 3);
  });
});
