// Shared fixtures for component tests. Not a test file itself.

import type { DelegateRecord, Input } from "../src/types.ts";
import type { DelegateRequest } from "../src/api/validate.ts";

const TXID_A = "a".repeat(64);

export function makeIntent(inputs: Input[] = [{ txid: TXID_A, vout: 0 }]) {
  return { txid: "t".repeat(64), message: "msg", proof: "proof", inputs };
}

export function makeRequest(over: Partial<DelegateRequest> = {}): DelegateRequest {
  const intent = over.intent ?? makeIntent();
  return {
    intent,
    forfeitTxs: over.forfeitTxs ?? intent.inputs.map((input) => ({ input, forfeitTx: "00ff" })),
    delegatePublicKey: over.delegatePublicKey ?? "02abc",
    fee: over.fee ?? 250,
    scheduledAt: over.scheduledAt ?? 2_000_000_000,
  };
}

export function makeRecord(over: Partial<DelegateRecord> = {}): DelegateRecord {
  const intent = over.intent ?? makeIntent();
  return {
    id: over.id ?? "del_1",
    tenantId: over.tenantId ?? "t_a",
    intent,
    forfeitTxs: over.forfeitTxs ?? intent.inputs.map((input) => ({ input, forfeitTx: "00ff" })),
    fee: over.fee ?? 250,
    delegatePublicKey: over.delegatePublicKey ?? "02abc",
    scheduledAt: over.scheduledAt ?? 1_000,
    status: over.status ?? "pending",
    failReason: over.failReason ?? "",
    commitmentTxid: over.commitmentTxid ?? "",
    attempts: over.attempts ?? 0,
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  };
}
