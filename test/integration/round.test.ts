// arkd-gated integration suite (Phase 3). Run with `pnpm test:e2e` against a
// running regtest stack (docs/REGTEST.md). It is intentionally NOT part of the
// dependency-light `pnpm test` loop (which globs only `test/*.test.ts`): this
// file imports @arkade-os/sdk and talks to a live arkd.
//
// Reachability-gated: when arkd is not reachable at ARKADE_SERVER_URL the
// network-dependent cases skip (not fail), so the suite is safe to run anywhere.
// The pure-transform case always runs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Intent } from "@arkade-os/sdk";
import type { ArkProvider } from "@arkade-os/sdk";
import { RestArkadeClient } from "../../src/infrastructure/rest-arkade-client.ts";

const REGISTER_MSG = Intent.encodeMessage({
  type: "register",
  onchain_output_indexes: [0],
  valid_at: 1_900_000_000,
  expire_at: 1_950_000_000,
  cosigners_public_keys: ["02ab"],
});

const ARKADE_SERVER_URL = process.env.ARKADE_SERVER_URL ?? "http://localhost:7070";

async function arkdReachable(url: string): Promise<boolean> {
  try {
    await Promise.race([
      new RestArkadeClient(url).health(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

describe("RestArkadeClient (arkd integration)", () => {
  it("reconstructs a SignedIntent from stored encoded message + proof (pure, always runs)", () => {
    const message = Intent.encodeMessage({
      type: "register",
      onchain_output_indexes: [0],
      valid_at: 1_900_000_000,
      expire_at: 1_950_000_000,
      cosigners_public_keys: ["02ab"],
    });
    const client = new RestArkadeClient(ARKADE_SERVER_URL);
    const signed = client.reconstructSignedIntent({ intentMessage: message, intentProof: "base64proof", forfeitTxs: [] });
    assert.equal(signed.proof, "base64proof");
    assert.equal(signed.message.type, "register");
    assert.equal(signed.message.valid_at, 1_900_000_000);
  });

  it("register() caches the intent before confirm, so a confirm failure never re-registers (no arkd)", async () => {
    let registerCalls = 0;
    let confirmCalls = 0;
    let failNextConfirm = true;
    const fake = {
      async registerIntent() {
        registerCalls += 1;
        return "intent_1";
      },
      async confirmRegistration() {
        confirmCalls += 1;
        if (failNextConfirm) {
          failNextConfirm = false;
          throw new Error("confirm blip");
        }
      },
    } as unknown as ArkProvider;

    const client = new RestArkadeClient("http://unused", undefined, fake);
    const req = { intentMessage: REGISTER_MSG, intentProof: "proof-1", forfeitTxs: [] };

    await assert.rejects(() => client.register(req), /confirm blip/); // register ok, confirm throws
    const id = await client.register(req); // retry

    assert.equal(id, "intent_1");
    assert.equal(registerCalls, 1, "registered exactly once across the retry");
    assert.equal(confirmCalls, 2, "re-confirmed on the retry");
  });

  it("reaches a regtest arkd via getInfo()", async (t) => {
    if (!(await arkdReachable(ARKADE_SERVER_URL))) {
      t.skip(`arkd not reachable at ${ARKADE_SERVER_URL} — start the regtest stack (docs/REGTEST.md)`);
      return;
    }
    const info = await new RestArkadeClient(ARKADE_SERVER_URL).health();
    assert.equal(info.network, "regtest");
    assert.ok(info.signerPubkey && info.signerPubkey.length > 0, "expected a signer pubkey");
  });

  // The Phase-3 EXIT CRITERION — a real VTXO renewed end-to-end — needs the
  // wallet-side hand-off (create a delegate VTXO, build the signed intent +
  // pre-signed forfeit txs via @arkade-os/sdk DelegateManagerImpl) AND the
  // MuSig2 round (RestArkadeClient.rideRound). It is BLOCKED in CI/this
  // environment because the regtest Docker images can't be pulled
  // (docs/PROGRESS.md). Kept as an explicit, skipped placeholder so the gap is
  // visible and the suite documents the acceptance step rather than hiding it.
  it("renews a real VTXO end-to-end on regtest", { skip: "Phase-3 exit criterion — see docs/PROGRESS.md (round not yet verified)" }, () => {});
});
