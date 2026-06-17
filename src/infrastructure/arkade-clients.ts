// ArkadeClient adapters.
//
// MockArkadeClient — for local dev and tests; records calls and can fail the
// first N attempts to exercise retry/recovery.
//
// RestArkadeClient — the real arkd integration (Phase 3, BLOCKED on a live
// arkd). Intended flow via @arkade-os/sdk's RestArkProvider (REST + SSE),
// mirroring Fulmine (docs/DESIGN.md §2.2, §3):
//   RegisterIntent(proof, message) -> join batch -> MuSig2 tree nonces/sigs
//   -> SubmitSignedForfeitTxs -> finalized -> commitment txid.
// Registration MUST be idempotent (dedupe by intent txid) — DESIGN §8.1.
// Implemented as an explicit NotImplemented stub: it throws rather than faking
// success.

import type { ArkadeClient, SettleRequest, SettleResult } from "../application/ports.ts";

export interface MockOptions {
  failTimes?: number;
  failMessage?: string;
  txidPrefix?: string;
}

export class MockArkadeClient implements ArkadeClient {
  readonly calls: SettleRequest[] = [];
  private remainingFails: number;
  private readonly failMessage: string;
  private readonly txidPrefix: string;

  constructor(opts: MockOptions = {}) {
    this.remainingFails = opts.failTimes ?? 0;
    this.failMessage = opts.failMessage ?? "mock settlement failure";
    this.txidPrefix = opts.txidPrefix ?? "mocktxid";
  }

  async settleDelegatedIntent(req: SettleRequest): Promise<SettleResult> {
    this.calls.push(req);
    if (this.remainingFails > 0) {
      this.remainingFails--;
      throw new Error(this.failMessage);
    }
    return { commitmentTxid: `${this.txidPrefix}_${this.calls.length}` };
  }
}

export class RestArkadeClient implements ArkadeClient {
  private serverUrl: string;
  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async settleDelegatedIntent(_req: SettleRequest): Promise<SettleResult> {
    throw new Error(
      "RestArkadeClient: arkd settlement not implemented yet (Phase 3). " +
        `Wire @arkade-os/sdk RestArkProvider against ${this.serverUrl}.`,
    );
  }
}
