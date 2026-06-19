// RestArkadeClient — the real arkd adapter (Phase 3), built on @arkade-os/sdk's
// RestArkProvider (REST + SSE; runs in the Workers runtime, DESIGN §3, §6).
//
// IMPORTANT: this module imports the SDK, so it is deliberately NOT imported by
// the dependency-light unit/contract suite (`test/*.test.ts`). It is exercised
// by the arkd-gated integration suite (`test/integration/*.test.ts`, run via
// `pnpm test:e2e` against the regtest stack — docs/REGTEST.md).
//
// What this adapter does:
//   - provider wiring + `health()` (server reachability via getInfo),
//   - reconstruction of the SDK `SignedIntent<RegisterMessage>` from the stored
//     encoded message/proof (our R2 record mirrors Fulmine's, DESIGN §2.1),
//   - idempotent `registerIntent` — dedupe by the signed proof so a re-trigger
//     cannot double-register the same intent (DESIGN §8.1, layer 3),
//   - `rideRound` — the MuSig2 batch round, driven by the SDK's reusable
//     `Batch.join` state machine + a delegate-specific `Batch.Handler`
//     (DESIGN §2.2 step 3). The delegate co-signs the VTXO tree with its OWN
//     key (listed in the intent's `cosigners_public_keys`) and forwards the
//     user's pre-signed forfeit txs verbatim — it never signs, re-signs, or
//     redirects user funds (CLAUDE.md invariant #1). `Batch.join` resolves to
//     the real commitment txid; we never fabricate one (a failed/unreachable
//     round throws — a liveness fault, never a safety one).
//
// Remaining live-verification points (Phase-3 exit criterion, needs a running
// regtest arkd — docs/REGTEST.md, docs/PROGRESS.md): an end-to-end VTXO renewal,
// and whether arkd requires each forfeit tx to carry its connector input before
// submission (DESIGN §2.2 step 3), which depends on the wallet-side hand-off
// format that produces the pre-signed forfeits.

import { Batch, CSVMultisigTapscript, RestArkProvider, Transaction } from "@arkade-os/sdk";
import type {
  ArkInfo,
  ArkProvider,
  BatchFinalizationEvent,
  BatchStartedEvent,
  Identity,
  Intent,
  SignedIntent,
  SignerSession,
  TreeNoncesEvent,
  TreeSigningStartedEvent,
  TxTree,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";

import type { ArkadeClient, SettleRequest, SettleResult } from "../application/ports.ts";

type RegisterIntent = SignedIntent<Intent.RegisterMessage>;

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
    // Then ride the batch round to a real commitment txid.
    return this.rideRound(intentId, req);
  }

  /**
   * Ride the MuSig2 batch round as the delegate cosigner, mirroring Fulmine
   * (DESIGN §2.2). The SDK's exported `Batch.join` drives the full state machine
   * (accumulating the streamed tree-tx chunks, building the `TxTree`, applying
   * the server's aggregated tree signatures, reconstructing the connector tree)
   * and resolves to the commitment txid. We supply a {@link DelegateBatchHandler}
   * that co-signs the tree with the delegate's OWN key and forwards the user's
   * pre-signed forfeit txs — never re-signing or redirecting user funds
   * (CLAUDE.md invariant #1).
   */
  private async rideRound(intentId: string, req: SettleRequest): Promise<SettleResult> {
    const identity = this.identity;
    if (!identity) throw new Error("RestArkadeClient: missing delegate signing identity");

    // arkd's forfeit key (33-byte compressed hex) -> x-only (32 bytes). It is
    // the single pubkey in the sweep tapscript that SignerSession.init tweaks the
    // tree MuSig2 keys with, so it must match arkd's exactly (see the handler).
    const info = await this.provider.getInfo();
    if (!info.forfeitPubkey) {
      throw new Error("RestArkadeClient: arkd getInfo() returned no forfeitPubkey");
    }
    const forfeitPubkey = hex.decode(info.forfeitPubkey).slice(1);

    const session = identity.signerSession();
    const handler = new DelegateBatchHandler(
      session,
      this.provider,
      req.forfeitTxs.map((f) => f.forfeitTx),
      forfeitPubkey,
    );

    const controller = new AbortController();
    try {
      const stream = this.provider.getEventStream(controller.signal, [intentId]);
      const commitmentTxid = await Batch.join(stream, handler, {
        abortController: controller,
        // We always co-sign the tree (the renewal has offchain outputs).
        skipVtxoTreeSigning: false,
      });
      return { commitmentTxid };
    } finally {
      controller.abort();
    }
  }
}

/**
 * The delegate's MuSig2 batch-round handler for `Batch.join` (DESIGN §2.2 step
 * 3). It mirrors the SDK wallet's internal `createBatchHandler`, but for the
 * no-custody delegate: it co-signs the VTXO tree with the delegate's OWN key
 * and forwards the user's pre-signed forfeit txs verbatim. It NEVER signs,
 * re-signs, or redirects user funds (CLAUDE.md invariant #1).
 */
class DelegateBatchHandler implements Batch.Handler {
  private readonly session: SignerSession;
  private readonly provider: ArkProvider;
  /** User-pre-signed forfeit txs, forwarded as-is at finalization. */
  private readonly forfeitTxs: string[];
  /** arkd's forfeit key, x-only (32 bytes), for the single-leaf sweep tap tree. */
  private readonly forfeitPubkey: Uint8Array;
  /** arkd's sweep tap-tree root; captured at BatchStarted, consumed at TreeSigningStarted. */
  private sweepTapTreeRoot: Uint8Array | undefined;

  constructor(
    session: SignerSession,
    provider: ArkProvider,
    forfeitTxs: string[],
    forfeitPubkey: Uint8Array,
  ) {
    this.session = session;
    this.provider = provider;
    this.forfeitTxs = forfeitTxs;
    this.forfeitPubkey = forfeitPubkey;
  }

  /**
   * Rebuild arkd's sweep tap-tree root from the batch's expiry timelock + the
   * server forfeit key, exactly as the server does: a single CSV-multisig leaf
   * `<batchExpiry> CSV DROP <multisig([forfeitPubkey])>`, hashed to a tap leaf.
   * `SignerSession.init` tweaks the tree MuSig2 keys with this root, so it must
   * match arkd's or our partial signatures are invalid.
   */
  async onBatchStarted(event: BatchStartedEvent): Promise<{ skip: boolean }> {
    const sweepScript = CSVMultisigTapscript.encode({
      timelock: {
        value: event.batchExpiry,
        type: event.batchExpiry >= 512n ? "seconds" : "blocks",
      },
      pubkeys: [this.forfeitPubkey],
    }).script;
    this.sweepTapTreeRoot = tapLeafHash(sweepScript);
    return { skip: false };
  }

  /**
   * Init the MuSig2 session against the reconstructed tree, then submit our
   * public nonces. `rootInputAmount` is the batch shared-output amount = output
   * 0 of the unsigned commitment tx carried in the event.
   */
  async onTreeSigningStarted(
    event: TreeSigningStartedEvent,
    vtxoTree: TxTree,
  ): Promise<{ skip: boolean }> {
    if (!this.sweepTapTreeRoot) {
      throw new Error("RestArkadeClient: tree signing started before BatchStarted set the sweep root");
    }
    const commitmentTx = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));
    const sharedOutput = commitmentTx.getOutput(0);
    if (!sharedOutput?.amount) {
      throw new Error("RestArkadeClient: batch shared output (commitment output 0) not found");
    }
    await this.session.init(vtxoTree, this.sweepTapTreeRoot, sharedOutput.amount);
    const pubkey = hex.encode(await this.session.getPublicKey());
    await this.provider.submitTreeNonces(event.id, pubkey, await this.session.getNonces());
    return { skip: false };
  }

  /**
   * Aggregate the round's nonces; once every tree node has one, produce our
   * partial signatures and submit them. `Batch.join` applies the server's
   * aggregated `tree_signature` events to the tree for us.
   */
  async onTreeNonces(event: TreeNoncesEvent): Promise<{ fullySigned: boolean }> {
    const { hasAllNonces } = await this.session.aggregatedNonces(event.txid, event.nonces);
    if (!hasAllNonces) return { fullySigned: false };
    const pubkey = hex.encode(await this.session.getPublicKey());
    await this.provider.submitTreeSignatures(event.id, pubkey, await this.session.sign());
    return { fullySigned: true };
  }

  /**
   * Submit the user's pre-signed forfeit txs. They renew the VTXO back to its
   * owner (minus fee); we forward them untouched. NOTE: arkd may require each
   * forfeit to carry its connector input (from `connectorTree`) before
   * submission (DESIGN §2.2 step 3); that attachment depends on the wallet-side
   * hand-off format and is the remaining live-verify point (docs/REGTEST.md).
   */
  async onBatchFinalization(
    _event: BatchFinalizationEvent,
    _vtxoTree?: TxTree,
    _connectorTree?: TxTree,
  ): Promise<void> {
    if (this.forfeitTxs.length > 0) {
      await this.provider.submitSignedForfeitTxs(this.forfeitTxs);
    }
  }
}
