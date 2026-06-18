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
// docs/PROGRESS.md): the MuSig2 batch round end-to-end. The full round is now
// structured in `rideRound` (register -> stream events -> co-sign tree nonces +
// signatures -> submit forfeits -> finalized), composed from real SDK
// primitives and ready to verify. The single value it cannot derive without a
// live arkd — `SignerSession.init`'s `scriptRoot` / `rootInputAmount` — is
// isolated in `deriveSigningContext`, which throws `RoundNotVerifiedError`
// rather than fabricate a commitment txid. Failing to renew is a liveness
// fault; faking success would violate the custody contract (DESIGN §2.2, §8.2).

import { RestArkProvider, SettlementEventType, TxTree } from "@arkade-os/sdk";
import type {
  ArkInfo,
  ArkProvider,
  Identity,
  Intent,
  SignedIntent,
  TreeSigningStartedEvent,
  TxTreeNode,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";

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
  private readonly provider: ArkProvider;
  private readonly identity: Identity | undefined;
  /** Idempotency map (DESIGN §8.1 layer 3): signed-proof -> arkd intentId. */
  private readonly registeredIntents = new Map<string, string>();
  /** Intent ids already confirmed, so a retry re-confirms at most once. */
  private readonly confirmedIntents = new Set<string>();

  // `provider` is injectable for tests; production passes none and gets a real
  // RestArkProvider against serverUrl.
  constructor(serverUrl: string, identity?: Identity, provider?: ArkProvider) {
    this.serverUrl = serverUrl;
    this.provider = provider ?? new RestArkProvider(serverUrl);
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
    let intentId = this.registeredIntents.get(req.intentProof);
    if (intentId === undefined) {
      const intent = this.reconstructSignedIntent(req);
      intentId = await this.provider.registerIntent(intent);
      // Cache BEFORE confirmRegistration: the intent is now registered with arkd,
      // so if confirm throws, the retry must re-confirm — never re-register
      // (which would double-register the same intent, defeating §8.1 layer 3).
      this.registeredIntents.set(req.intentProof, intentId);
    }
    if (!this.confirmedIntents.has(intentId)) {
      await this.provider.confirmRegistration(intentId);
      this.confirmedIntents.add(intentId);
    }
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
   * (DESIGN §2.2), composed from `RestArkProvider`'s event stream + the delegate
   * key's `SignerSession`. The full structure is here and ready to verify; the
   * one value that cannot be derived correctly without a live arkd to test
   * against is isolated in {@link deriveSigningContext} (see there).
   *
   * The delegate signs the tree with its OWN key (listed in the intent's
   * `cosigners_public_keys`); the user's forfeit txs are forwarded as-signed.
   * We never re-sign or redirect user funds (CLAUDE.md invariant #1).
   */
  private async rideRound(intentId: string, req: SettleRequest): Promise<SettleResult> {
    const identity = this.identity;
    if (!identity) throw new Error("RestArkadeClient: missing delegate signing identity");

    const session = identity.signerSession();
    const pubkey = hex.encode(await session.getPublicKey());
    const controller = new AbortController();
    const chunks: TxTreeNode[] = [];
    let signed = false;

    try {
      for await (const event of this.provider.getEventStream(controller.signal, [intentId])) {
        switch (event.type) {
          case SettlementEventType.BatchFailed:
            throw new Error(`arkd batch failed: ${event.reason}`);

          case SettlementEventType.TreeTx:
            // VTXO-tree chunks streamed before signing starts; accumulate them.
            chunks.push(event.chunk);
            break;

          case SettlementEventType.TreeSigningStarted: {
            const tree = TxTree.create(chunks);
            const { scriptRoot, rootInputAmount } = await this.deriveSigningContext(intentId, event, tree);
            await session.init(tree, scriptRoot, rootInputAmount);
            await this.provider.submitTreeNonces(event.id, pubkey, await session.getNonces());
            break;
          }

          case SettlementEventType.TreeNonces: {
            // Server-aggregated nonces; once complete, submit our partial sigs.
            const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);
            if (hasAllNonces && !signed) {
              signed = true;
              await this.provider.submitTreeSignatures(event.id, pubkey, await session.sign());
            }
            break;
          }

          case SettlementEventType.BatchFinalization:
            // Forfeit txs are already user-signed; submit them. (If arkd requires
            // connector-input attachment first, that is the other live-verify
            // point — DESIGN §2.2.)
            await this.provider.submitSignedForfeitTxs(req.forfeitTxs.map((f) => f.forfeitTx));
            break;

          case SettlementEventType.BatchFinalized:
            return { commitmentTxid: event.commitmentTxid };

          default:
            // BatchStarted / TreeSignature / StreamStarted: nothing to do.
            break;
        }
      }
      throw new Error("arkd event stream ended before the batch was finalized");
    } finally {
      controller.abort();
    }
  }

  /**
   * The remaining live-verification point (Phase-3 exit criterion).
   * `SignerSession.init` needs `scriptRoot` (arkd's sweep tap-tree root) and
   * `rootInputAmount` (the batch shared-output amount). Both are server-specific:
   * the SDK derives them inside its internal settlement handler from `ArkInfo`
   * + the unsigned commitment tx. Reproducing them must be checked against a
   * live arkd — BLOCKED here (regtest images unpullable; DESIGN §6, §8.2,
   * docs/PROGRESS.md). We refuse rather than guess, so a run never fabricates a
   * commitment txid (a liveness fault, never a safety one).
   */
  private async deriveSigningContext(
    intentId: string,
    _event: TreeSigningStartedEvent,
    _tree: TxTree,
  ): Promise<{ scriptRoot: Uint8Array; rootInputAmount: bigint }> {
    throw new RoundNotVerifiedError(intentId);
  }
}
