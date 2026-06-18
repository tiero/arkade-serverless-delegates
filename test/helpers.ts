// Shared fixtures for component tests. Not a test file itself.

import type { DelegateTaskState, Input } from "../src/domain/task.ts";
import type { CreateDelegateInput } from "../src/application/use-cases.ts";
import type { Clock } from "../src/application/ports.ts";

const TXID_A = "a".repeat(64);

export function makeIntentRaw(inputs: Input[] = [{ txid: TXID_A, vout: 0 }]) {
  return { txid: "t".repeat(64), message: "msg", proof: "proof", inputs };
}

export function makeCreateInput(over: Record<string, unknown> = {}): CreateDelegateInput {
  const intent = (over.intent ?? makeIntentRaw()) as { inputs: Input[] };
  return {
    intent,
    forfeitTxs: over.forfeitTxs ?? intent.inputs.map((input) => ({ input, forfeitTx: "00ff" })),
    delegatePublicKey: over.delegatePublicKey ?? "02abc",
    fee: over.fee ?? 250,
    scheduledAt: over.scheduledAt ?? 2_000_000_000,
  };
}

export function makeState(over: Partial<DelegateTaskState> = {}): DelegateTaskState {
  const intent = over.intent ?? makeIntentRaw();
  return {
    id: over.id ?? "del_1",
    tenantId: over.tenantId ?? "t_a",
    intent,
    forfeitTxs: over.forfeitTxs ?? intent.inputs.map((i) => ({ input: i, forfeitTx: "00ff" })),
    fee: over.fee ?? 250,
    delegatePublicKey: over.delegatePublicKey ?? "02abc",
    scheduledAt: over.scheduledAt ?? 1_000,
    expiresAt: over.expiresAt ?? 0,
    status: over.status ?? "pending",
    failReason: over.failReason ?? "",
    commitmentTxid: over.commitmentTxid ?? "",
    attempts: over.attempts ?? 0,
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  };
}

export class FixedClock implements Clock {
  private t: number;
  constructor(t: number) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
}
