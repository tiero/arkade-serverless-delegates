# Running against the Arkade regtest stack (Phase 3)

The real settlement round is exercised against a local **Arkade regtest** stack
([`arklabsHQ/arkade-regtest`](https://github.com/arklabsHQ/arkade-regtest)):
Bitcoin Core + indexers + **arkd** + arkd-wallet, orchestrated by Docker Compose.
The delegate talks to **arkd** over REST + SSE at `http://localhost:7070`
(DESIGN §3, §6), via `@arkade-os/sdk`'s `RestArkProvider`.

> **Environment note.** This stack needs to **pull Docker images** from Docker
> Hub and `ghcr.io`. In the Claude Code web/CI sandbox that is currently
> **blocked** — the registry APIs are reachable but the image **blob CDNs**
> (`production.cloudfront.docker.com`, `pkg-containers.githubusercontent.com`)
> return `403`, so the stack can't come up there. Run this on a host with normal
> outbound network (a laptop, or CI with registry egress). See
> `docs/PROGRESS.md` Phase 3 for the BLOCKED marker.

## 1. Start the stack

```bash
# Requirements: Docker + the `docker compose` plugin, Node >= 18.
git clone https://github.com/arklabsHQ/arkade-regtest
cd arkade-regtest
node regtest.mjs start --profile ark    # base chain/indexers + arkd + arkd-wallet
# arkd REST:  http://localhost:7070   (admin 7071)
# Esplora:    http://localhost:3000/api
```

Useful passthroughs while iterating:

```bash
node regtest.mjs ark <args...>     # ark client CLI inside the arkd container
node regtest.mjs arkd <args...>    # arkd server CLI
node regtest.mjs mine [n]          # mine n blocks (regtest)
node regtest.mjs clean             # tear down + wipe volumes
```

## 2. Point the delegate at it & run the integration suite

```bash
# from this repo
pnpm install
ARKADE_SERVER_URL=http://localhost:7070 pnpm test:e2e
```

`test/integration/round.test.ts` is **reachability-gated**: with arkd up it
asserts `getInfo()` returns a regtest `ArkInfo` (and exercises
`reconstructSignedIntent`); with arkd down those cases **skip** rather than fail,
so the suite is safe to run anywhere. The dependency-light unit loop
(`pnpm test`) never touches the network or the SDK.

## 3. Deploying the Worker against arkd

The Worker reads `ARKADE_SERVER_URL` (var) and `DELEGATE_PRIVATE_KEY` (secret,
the operator co-signing key — **never** a user key; CLAUDE.md invariant #1):

```bash
wrangler secret put DELEGATE_PRIVATE_KEY    # hex; regtest/testnet only
# ARKADE_SERVER_URL is set in wrangler.jsonc vars
```

## What's verified vs. pending

- **Verified (with the stack up):** SDK imports + runs (Phase-2 spike), arkd
  reachability via `getInfo()`, `SignedIntent` reconstruction, idempotent
  `registerIntent`.
- **Pending (Phase-3 exit criterion):** a real VTXO renewed end-to-end — the
  MuSig2 batch round (`RestArkadeClient.rideRound`) plus the wallet-side
  hand-off that produces the signed intent + forfeit txs. See DESIGN §2.2 / §8.2
  and the skipped placeholder in the integration suite.
```
