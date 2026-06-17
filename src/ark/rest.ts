// RestArkClient — the real arkd integration (Phase 3, BLOCKED on a live arkd).
//
// Intended flow via @arkade-os/sdk's RestArkProvider (REST + SSE), mirroring
// Fulmine (docs/DESIGN.md §2.2, §3):
//   RegisterIntent(proof, message)
//     -> join batch on BatchStarted
//     -> MuSig2 tree: SubmitTreeNonces, then SubmitTreeSignatures
//     -> OnBatchFinalization: SubmitSignedForfeitTxs
//     -> OnBatchFinalized: return the commitment txid.
//
// Registration MUST be idempotent (dedupe by intent txid) so a re-trigger can't
// double-renew — see DESIGN §8.1, layer 3.
//
// Implemented as an explicit NotImplemented stub: it throws rather than faking
// success, so the plumbing is complete and honest until Phase 3 lands.

import type { ArkClient, SettleRequest, SettleResult } from "./ArkClient.ts";

export class RestArkClient implements ArkClient {
  private serverUrl: string;
  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async settleDelegatedIntent(_req: SettleRequest): Promise<SettleResult> {
    throw new Error(
      "RestArkClient: arkd settlement not implemented yet (Phase 3). " +
        `Wire @arkade-os/sdk RestArkProvider against ${this.serverUrl}.`,
    );
  }
}
