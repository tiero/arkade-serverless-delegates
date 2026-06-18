import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DelegateTask,
  canTransition,
  deriveExpireAt,
  deriveValidAt,
  inputKey,
  parseFee,
  parseForfeitTxs,
  parseIntent,
  resolveScheduledAt,
  type Input,
} from "../src/domain/task.ts";
import { InvariantError, ValidationError } from "../src/domain/errors.ts";
import { makeIntentRaw } from "./helpers.ts";

describe("status transitions", () => {
  it("allows only sanctioned transitions", () => {
    assert.ok(canTransition("pending", "registering"));
    assert.ok(canTransition("registering", "in_round"));
    assert.ok(canTransition("in_round", "completed"));
    assert.ok(canTransition("failed", "pending"));
    assert.ok(!canTransition("pending", "completed"));
    assert.ok(!canTransition("completed", "pending"));
    assert.ok(!canTransition("cancelled", "registering"));
  });
});

describe("value-object parsing (untrusted input -> ValidationError, never a crash)", () => {
  it("accepts a well-formed intent", () => {
    const intent = parseIntent(makeIntentRaw());
    assert.equal(intent.inputs.length, 1);
  });

  it("rejects malformed shapes instead of throwing TypeError", () => {
    assert.throws(() => parseIntent(null), ValidationError);
    assert.throws(() => parseIntent({ proof: "p", inputs: [] }), ValidationError); // missing message
    assert.throws(() => parseIntent({ message: "m", proof: "p", inputs: [] }), ValidationError); // empty
    assert.throws(() => parseIntent({ message: "m", proof: "p", inputs: [null] }), ValidationError); // null element
    const dup = { txid: "a".repeat(64), vout: 0 };
    assert.throws(() => parseIntent({ message: "m", proof: "p", inputs: [dup, dup] }), ValidationError);
  });

  it("requires exactly one forfeit tx per input, with a valid .input", () => {
    const inputs: Input[] = [{ txid: "a".repeat(64), vout: 0 }];
    assert.throws(() => parseForfeitTxs([], inputs), ValidationError); // missing
    assert.throws(() => parseForfeitTxs([{ forfeitTx: "00" }], inputs), ValidationError); // no .input
    assert.throws(
      () => parseForfeitTxs([{ input: { txid: "b".repeat(64), vout: 0 }, forfeitTx: "00" }], inputs),
      ValidationError, // unknown input
    );
    const ok = parseForfeitTxs([{ input: inputs[0], forfeitTx: "00" }], inputs);
    assert.equal(ok.length, 1);
  });

  it("requires fee to be a non-negative integer within the cap", () => {
    assert.equal(parseFee(250), 250);
    assert.throws(() => parseFee(250.5), ValidationError);
    assert.throws(() => parseFee(-1), ValidationError);
    assert.throws(() => parseFee(2_000_000), ValidationError);
    assert.throws(() => parseFee("250"), ValidationError);
  });
});

describe("signed-intent timing (scheduledAt / expiresAt from the message)", () => {
  // Canonical Arkade register-intent message: JSON with snake_case unix-secs
  // (matches @arkade-os/sdk Intent.encodeMessage; see docs/DESIGN.md §2.1, §3).
  const registerMsg = JSON.stringify({
    type: "register",
    onchain_output_indexes: [0],
    valid_at: 1_900_000_000,
    expire_at: 1_950_000_000,
    cosigners_public_keys: ["02ab"],
  });

  it("decodes valid_at / expire_at from the canonical message", () => {
    assert.equal(deriveValidAt(registerMsg), 1_900_000_000);
    assert.equal(deriveExpireAt(registerMsg), 1_950_000_000);
  });

  it("returns null for an opaque (non-JSON) message", () => {
    assert.equal(deriveValidAt("not-json"), null);
    assert.equal(deriveExpireAt("not-json"), null);
  });

  it("treats the signed valid_at as authoritative over a request-supplied scheduledAt", () => {
    // Even with a (bogus) provided value, the decoded valid_at wins.
    assert.equal(resolveScheduledAt(registerMsg, 12345, 1_000), 1_900_000_000);
  });

  it("falls back to the request scheduledAt only when the message is opaque", () => {
    assert.equal(resolveScheduledAt("opaque", 1_900_000_000, 1_000), 1_900_000_000);
    assert.throws(() => resolveScheduledAt("opaque", undefined, 1_000), ValidationError);
  });

  it("rejects a renewal time in the past", () => {
    assert.throws(() => resolveScheduledAt(registerMsg, undefined, 1_900_000_001), ValidationError);
  });

  it("DelegateTask.create captures expiresAt from the signed message", () => {
    const intent = parseIntent({ ...makeIntentRaw(), message: registerMsg });
    const task = DelegateTask.create(
      { tenantId: "t_a", intent, forfeitTxs: [], fee: 0, delegatePublicKey: "02abc", scheduledAt: 1_900_000_000 },
      1_000,
    );
    assert.equal(task.expiresAt, 1_950_000_000);
    assert.equal(task.toState().expiresAt, 1_950_000_000);
  });
});

describe("DelegateTask aggregate", () => {
  function create() {
    return DelegateTask.create(
      {
        tenantId: "t_a",
        intent: parseIntent(makeIntentRaw()),
        forfeitTxs: [{ input: { txid: "a".repeat(64), vout: 0 }, forfeitTx: "00ff" }],
        fee: 250,
        delegatePublicKey: "02abc",
        scheduledAt: 2_000_000_000,
      },
      1000,
    );
  }

  it("starts pending with a del_ id and zero attempts", () => {
    const task = create();
    assert.equal(task.status, "pending");
    assert.match(task.id, /^del_[0-9a-f]{24}$/);
    assert.equal(task.attempts, 0);
  });

  it("walks the happy path and records the commitment txid", () => {
    const task = create();
    task.markAttempt(1001);
    task.register(1001);
    task.enterRound(1001);
    task.complete("cmt_1", 1002);
    assert.equal(task.status, "completed");
    assert.equal(task.toState().commitmentTxid, "cmt_1");
    assert.equal(task.attempts, 1);
  });

  it("refuses illegal transitions", () => {
    const task = create();
    assert.throws(() => task.complete("x", 1001), InvariantError); // pending -> completed is illegal
  });

  it("recover clears the previous failReason", () => {
    const task = create();
    task.register(1001);
    task.fail("boom", 1002);
    assert.equal(task.toState().failReason, "boom");
    task.recover(1003);
    assert.equal(task.status, "pending");
    assert.equal(task.toState().failReason, "");
  });
});
