import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { overlappingInputs, validateDelegateRequest, MAX_FEE } from "../src/api/validate.ts";
import { makeIntent, makeRequest } from "./helpers.ts";

const NOW = 1_000_000_000;

function expectError(req: ReturnType<typeof makeRequest>, match: RegExp) {
  const res = validateDelegateRequest(req, NOW);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, match);
}

describe("validateDelegateRequest", () => {
  it("accepts a well-formed hand-off", () => {
    assert.deepEqual(validateDelegateRequest(makeRequest(), NOW), { ok: true });
  });

  it("requires intent message and proof", () => {
    expectError(makeRequest({ intent: { ...makeIntent(), message: "" } }), /message/);
    expectError(makeRequest({ intent: { ...makeIntent(), proof: "" } }), /proof/);
  });

  it("requires at least one input", () => {
    expectError(makeRequest({ intent: { ...makeIntent(), inputs: [] } }), /inputs/);
  });

  it("rejects duplicate inputs", () => {
    const dup = { txid: "a".repeat(64), vout: 0 };
    const intent = makeIntent([dup, dup]);
    expectError(makeRequest({ intent, forfeitTxs: [{ input: dup, forfeitTx: "00" }] }), /duplicate input/);
  });

  it("requires exactly one forfeit tx per input", () => {
    const intent = makeIntent([{ txid: "a".repeat(64), vout: 0 }]);
    // missing forfeit
    expectError(makeRequest({ intent, forfeitTxs: [] }), /exactly one forfeit/);
    // forfeit for unknown input
    expectError(
      makeRequest({
        intent,
        forfeitTxs: [{ input: { txid: "b".repeat(64), vout: 0 }, forfeitTx: "00" }],
      }),
      /unknown input/,
    );
  });

  it("rejects bad fees", () => {
    expectError(makeRequest({ fee: -1 }), /fee/);
    expectError(makeRequest({ fee: MAX_FEE + 1 }), /sanity cap/);
  });

  it("requires renewal scheduled in the future", () => {
    expectError(makeRequest({ scheduledAt: NOW - 1 }), /future/);
  });
});

describe("overlappingInputs", () => {
  it("flags inputs already claimed by active tasks", () => {
    const intent = makeIntent([
      { txid: "a".repeat(64), vout: 0 },
      { txid: "a".repeat(64), vout: 1 },
    ]);
    const active = new Set([`${"a".repeat(64)}:0`]);
    assert.deepEqual(overlappingInputs(active, intent), [`${"a".repeat(64)}:0`]);
  });

  it("returns empty when there is no overlap", () => {
    assert.deepEqual(overlappingInputs(new Set(), makeIntent()), []);
  });
});
