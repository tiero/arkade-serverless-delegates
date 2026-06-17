// The seam between our serverless plumbing and the Arkade protocol.
//
// A real implementation (Phase 3) wraps @arkade-os/sdk and performs the full
// settlement round: RegisterIntent -> join batch -> MuSig2 tree nonces/signatures
// -> SubmitSignedForfeitTxs -> finalized. See docs/DESIGN.md §2.2 and §3.
//
// Keeping this narrow interface lets the DelegateRunner (the Durable Object) be
// written and tested against a mock long before arkd is wired up.

import type { DelegateForfeitTx } from "../types.ts";

export interface SettleRequest {
  /** encoded intent message (carries validAt) */
  intentMessage: string;
  /** encoded BIP322-style ownership proof */
  intentProof: string;
  /** user-pre-signed forfeit transactions, one per input */
  forfeitTxs: DelegateForfeitTx[];
}

export interface SettleResult {
  /** commitment txid of the batch that renewed the VTXOs */
  commitmentTxid: string;
}

export interface ArkClient {
  /**
   * Submit a pre-signed delegated intent and ride the settlement round to
   * completion. Resolves with the commitment txid, or rejects if the round
   * fails (the caller retries until the renewal deadline).
   */
  settleDelegatedIntent(req: SettleRequest): Promise<SettleResult>;
}
