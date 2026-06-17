// Mock ArkClient for local dev and component tests (docs/DESIGN.md §3, §11).
//
// It records every call and can be configured to fail the first N attempts, so
// tests can exercise the runner's retry/backoff behaviour without a live arkd.

import type { ArkClient, SettleRequest, SettleResult } from "./ArkClient.ts";

export interface MockOptions {
  /** fail the first N calls before succeeding (simulate transient round failures) */
  failTimes?: number;
  failMessage?: string;
  txidPrefix?: string;
}

export class MockArkClient implements ArkClient {
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
