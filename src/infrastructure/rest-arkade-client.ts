// RestArkadeClient — the real arkd adapter (Phase 3), built on @arkade-os/sdk's
// RestArkProvider (REST + SSE; runs in the Workers runtime, DESIGN §3, §6).
//
// IMPORTANT: this module imports the SDK, so it is deliberately NOT imported by
// the dependency-light unit/contract suite (`test/*.test.ts`). It is exercised
// by the arkd-gated integration suite (`test/integration/*.test.ts`, run via
// `pnpm test:e2e` against the regtest stack — docs/REGTEST.md).
//
// What is implemented and verifiable here (correct-by-construction + typechecked,
// and live-checkable against a reachable arkd):
//   - provider wiring + `health()` (server reachability via getInfo),
//   - reconstruction of the SDK `SignedIntent<RegisterMessage>` from the stored
//     encoded message/proof (our R2 record mirrors Fulmine's, DESIGN §2.1),
//   - idempotent `registerIntent` — dedupe by the signed proof so a re-trigger
//     cannot double-register the same intent (DESIGN §8.1, layer 3).
//
// What is NOT yet verified (the Phase-3 acceptance step, BLOCKED in this
// environment because the regtest Docker images cannot be pulled — see
// docs/PROGRESS.md): the MuSig2 batch round itself. `settleDelegatedIntent`
// performs the real, idempotent registration and then throws
// `RoundNotVerifiedError` rather than fabricate a commitment txid — failing to
// renew is a liveness fault; faking success would violate the custody contract.
// The exact remaining round (event sequence + the `sweepTapTreeRoot` /
// `sharedOutputAmount` derivation that `SignerSession.init` needs) is documented
// in `rideRound` below and in DESIGN §2.2 / §8.2.

import { RestArkProvider } from "@arkade-os/sdk";
import type { ArkInfo, Identity, Intent, SignedIntent } from "@arkade-os/sdk";

import type { ArkadeClient, SettleRequest, SettleResult } from "../application/ports.ts";

type RegisterIntent = SignedIntent<Intent.RegisterMessage>;

/**
 * Thrown when the verifiable steps (reconstruct + register) succeed but the
 * MuSig2 round cannot be completed because it has not been verified end-to-end
 * against a live arkd. Distinct from a config/validation error so callers can
 * tell "blocked, not broken" apart. Never returned as success.
 */
export class RoundNotVerifiedError extends Error {
  readonly intentId: string;
  constructor(intentId: string) {
    super(
      "RestArkadeClient: intent registered with arkd, but the MuSig2 settlement " +
        "round is not yet verified end-to-end (Phase 3 acceptance, BLOCKED here — " +
        "regtest images unavailable; see docs/PROGRESS.md). Refusing to fabricate a " +
        "commitment txid.",
    );
    this.name = "RoundNotVerifiedError";
    this.intentId = intentId;
  }
}

export class RestArkadeClient implements ArkadeClient {
  readonly serverUrl: string;
  private readonly provider: RestArkProvider;
  private readonly identity: Identity | undefined;
  /** Idempotency map (DESIGN §8.1 layer 3): signed-proof -> arkd intentId. */
  private readonly registeredIntents = new Map<string, string>();

  constructor(serverUrl: string, identity?: Identity) {
    this.serverUrl = serverUrl;
    this.provider = new RestArkProvider(serverUrl);
    this.identity = identity;
  }

  /** Server reachability + config. Backs a future `/v1/health` arkd probe and the integration suite. */
  async health(): Promise<ArkInfo> {
    return this.provider.getInfo();
  }

  /**
   * Rebuild the SDK `SignedIntent` from our stored strings. The Arkade register
   * message is canonical JSON (matches @arkade-os/sdk `Intent.encodeMessage`),
   * so decoding is `JSON.parse` + a shape check; the proof is the base64 signed
   * proof transaction, forwarded verbatim (custody invariant — we never re-sign
   * or alter the user's ownership proof).
   */
  reconstructSignedIntent(req: SettleRequest): RegisterIntent {
    let message: Intent.RegisterMessage;
    try {
      message = JSON.parse(req.intentMessage) as Intent.RegisterMessage;
    } catch {
      throw new Error("RestArkadeClient: intent message is not decodable JSON");
    }
    if (!message || message.type !== "register" || !Number.isFinite(message.valid_at)) {
      throw new Error("RestArkadeClient: intent message is not a valid register intent");
    }
    if (typeof req.intentProof !== "string" || req.intentProof.length === 0) {
      throw new Error("RestArkadeClient: intent proof is required");
    }
    return { proof: req.intentProof, message };
  }

  /**
   * Register the signed intent with arkd, idempotently. A repeat call for the
   * same signed proof returns the cached intentId instead of re-registering, so
   * a double-dispatch (cron + alarm) cannot double-register (DESIGN §8.1).
   */
  async register(req: SettleRequest): Promise<string> {
    const cached = this.registeredIntents.get(req.intentProof);
    if (cached) return cached;
    const intent = this.reconstructSignedIntent(req);
    const intentId = await this.provider.registerIntent(intent);
    await this.provider.confirmRegistration(intentId);
    this.registeredIntents.set(req.intentProof, intentId);
    return intentId;
  }

  async settleDelegatedIntent(req: SettleRequest): Promise<SettleResult> {
    if (!this.identity) {
      throw new Error(
        "RestArkadeClient: a delegate signing identity is required to co-sign the " +
          "round (set the DELEGATE_PRIVATE_KEY secret). The delegate co-signs with " +
          "its OWN key via the delegate tapscript path — it never holds user keys.",
      );
    }
    // Real, verifiable: register the user's pre-signed intent with arkd.
    const intentId = await this.register(req);
    // Then ride the batch round. Not yet verified end-to-end (see header).
    return this.rideRound(intentId, req);
  }

  /**
   * Ride the MuSig2 batch round as the delegate cosigner, mirroring Fulmine
   * (DESIGN §2.2). The SDK exposes every primitive needed:
   *
   *   const session = this.identity.signerSession();           // delegate key
   *   for await (const ev of this.provider.getEventStream(signal, [intentId])) {
   *     // BatchStarted        -> note batchId
   *     // TreeTx (chunks)     -> accumulate into TxTree.create(chunks)
   *     // TreeSigningStarted  -> session.init(tree, sweepTapTreeRoot, sharedOutputAmount)
   *     //                        then provider.submitTreeNonces(batchId, pubkey, await session.getNonces())
   *     // TreeNonces (aggr.)  -> session.aggregatedNonces(...); provider.submitTreeSignatures(batchId, pubkey, await session.sign())
   *     // BatchFinalization   -> attach connectors to the pre-signed forfeit PSBTs, then provider.submitSignedForfeitTxs(...)
   *     // BatchFinalized      -> return { commitmentTxid: ev.commitmentTxid }
   *     // BatchFailed         -> throw new Error(ev.reason)
   *   }
   *
   * The one piece that cannot be derived correctly without a live arkd to test
   * against is `SignerSession.init`'s `scriptRoot` (arkd's sweep tap-tree root)
   * and `rootInputAmount` (the batch shared-output amount): arkd keeps these
   * server-specific, and the SDK derives them inside its internal settlement
   * handler. Completing + verifying this is the Phase-3 exit criterion, which is
   * BLOCKED here (the regtest images can't be pulled — DESIGN §6, PROGRESS).
   */
  private async rideRound(intentId: string, _req: SettleRequest): Promise<SettleResult> {
    throw new RoundNotVerifiedError(intentId);
  }
}
