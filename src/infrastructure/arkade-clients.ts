// MockArkadeClient — for local dev and the dependency-light unit/contract loop.
// Records calls and can fail the first N attempts to exercise retry/recovery.
// It imports NOTHING from @arkade-os/sdk on purpose, so `pnpm test` never pulls
// in the SDK or the network. The real arkd adapter lives in
// `rest-arkade-client.ts` (it imports the SDK) and is exercised by the
// arkd-gated integration suite — see docs/PROGRESS.md Phase 3.

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
