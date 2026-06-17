import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DelegateTask,
  canTransition,
  inputKey,
  parseFee,
  parseForfeitTxs,
  parseIntent,
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
