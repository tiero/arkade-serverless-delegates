import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canTransition,
  inputKey,
  isActive,
  isTerminal,
  newDelegateId,
} from "../src/types.ts";

describe("types contract", () => {
  it("inputKey is stable and unambiguous", () => {
    assert.equal(inputKey({ txid: "abc", vout: 0 }), "abc:0");
    assert.notEqual(inputKey({ txid: "ab", vout: 1 }), inputKey({ txid: "ab", vout: 11 }));
  });

  it("classifies active vs terminal statuses", () => {
    assert.ok(isActive("pending"));
    assert.ok(isActive("registering"));
    assert.ok(isActive("in_round"));
    assert.ok(!isActive("completed"));
    assert.ok(isTerminal("completed"));
    assert.ok(isTerminal("failed"));
    assert.ok(isTerminal("cancelled"));
    assert.ok(!isTerminal("pending"));
  });

  it("allows only sanctioned status transitions", () => {
    assert.ok(canTransition("pending", "registering"));
    assert.ok(canTransition("registering", "in_round"));
    assert.ok(canTransition("in_round", "completed"));
    assert.ok(canTransition("failed", "pending")); // retry
    // forbidden
    assert.ok(!canTransition("pending", "completed"));
    assert.ok(!canTransition("completed", "pending"));
    assert.ok(!canTransition("cancelled", "registering"));
  });

  it("mints unique, prefixed ids", () => {
    const a = newDelegateId();
    const b = newDelegateId();
    assert.match(a, /^del_[0-9a-f]{24}$/);
    assert.notEqual(a, b);
  });
});
