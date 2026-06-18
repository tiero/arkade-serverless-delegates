# Arkade Serverless Delegate

A serverless, multi-tenant **Arkade delegate**: a hosted service that keeps
users' [VTXOs](https://docs.arkadeos.com/learn/core-concepts/vtxo-lifecycle-and-liveness)
alive by **renewing them before they expire — without ever taking custody**.
TypeScript on **Cloudflare Workers + Durable Objects + R2 + Cron**, deployable to
your own Cloudflare account.

This is the serverless analogue of the delegate built into
[Fulmine](https://github.com/ArkLabsHQ/fulmine) (Go), rebuilt on the
[Arkade TypeScript SDK](https://github.com/arkade-os/ts-sdk).

> **Status (honest snapshot).** Skeleton + SDK spike done; the real arkd round is
> wired but its **end-to-end renewal is not yet verified on regtest** (see
> [Project status](#project-status)). A deployed instance today authenticates
> tenants, validates/stores hand-offs, schedules them, and **registers** intents
> with arkd — but the settlement round deliberately **refuses rather than fakes**
> completion until verified. **Regtest / testnet only — never mainnet or real
> funds.** Live state: [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Contents

- [Why a delegate](#why-a-delegate)
- [No custody — the core guarantee](#no-custody--the-core-guarantee)
- [Architecture](#architecture)
- [HTTP API (v1)](#http-api-v1)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Configuration](#configuration)
- [Local development against regtest](#local-development-against-regtest)
- [Testing](#testing)
- [Repo layout](#repo-layout)
- [Project status](#project-status)
- [How this project is built](#how-this-project-is-built)
- [References](#references)

## Why a delegate

Arkade VTXOs carry a **batch expiry** and must be periodically *renewed* (settled
into a fresh batch) to preserve the right to unilateral on-chain exit. That puts
a **liveness burden** on users: be online on a schedule, or risk your funds being
swept (recoverable cooperatively, but you lose unilateral control).

A **delegate** removes that burden. The user hands over, per cycle, a pre-signed
**intent** (a BIP322-style ownership proof carrying the renewal timing) plus
pre-signed **forfeit transactions** (one per input). These authorize *only*:
"renew my VTXO into a fresh VTXO that is still mine, minus an agreed fee." The
delegate stores them and submits them to `arkd` just before expiry. Wallets
produce this hand-off with `@arkade-os/sdk`'s `DelegateManagerImpl`.

## No custody — the core guarantee

The delegate never holds user keys and can move funds **only** where the user's
pre-signed material already dictates (back to the user, minus the fee). The worst
a faulty or malicious delegate can do is **fail to renew** (a *liveness* fault) —
it can never **redirect** funds (a *safety* fault). Everything below serves this
invariant; the most pointed example is that the settlement adapter throws rather
than fabricate a success it cannot prove (see
[`rest-arkade-client.ts:214`](src/infrastructure/rest-arkade-client.ts)).

## Architecture

Layered (DDD); dependencies point **inward**, so the core has no idea Cloudflare,
the network, or the SDK exist — which is why almost everything is unit-testable
with zero dependencies. Full contract: [`docs/DESIGN.md`](docs/DESIGN.md).

```
infrastructure  ──▶  application  ──▶  domain
 (adapters: R2,      (use cases +       (pure model: DelegateTask
  Cloudflare,         ports/seams)       aggregate, parsers, state machine)
  arkd SDK, HTTP)
```

```
wallet ──POST signed intent + forfeits──▶ API Worker ──▶ R2 (task store)
                                              │
            Cron sweep / DO alarm ────────────┘──▶ DelegateRunner (Durable Object)
                                                     └─REST+SSE─▶ arkd  (MuSig2 settlement round)
```

**Domain** — [`src/domain/task.ts`](src/domain/task.ts): the `DelegateTask`
aggregate owns the status machine (`pending → registering → in_round →
completed`, with `failed`/`cancelled`; illegal transitions throw). Value-object
parsers turn untrusted JSON into valid objects or a `ValidationError`, and the
renewal time is decoded from the **signed** intent (`valid_at`), so a caller
can't move it by lying in the request body.

**Application** — [`src/application/ports.ts`](src/application/ports.ts) defines
the seams (`Clock`, `DelegateRepository`, `ArkadeClient`);
[`src/application/use-cases.ts`](src/application/use-cases.ts) holds the logic:
`createDelegate` (atomic input-overlap guard), `runDelegate` (status-guarded so a
double trigger renews exactly once), and `sweepDelegates` (cron backstop +
near-expiry escalation).

**Infrastructure** — repositories ([in-memory](src/infrastructure/in-memory-repository.ts)
+ [R2](src/infrastructure/r2-repository.ts), sharing one contract), the
[HTTP router](src/infrastructure/http-router.ts) (bearer auth + a top-level
error→status boundary), the real arkd adapter
([`rest-arkade-client.ts`](src/infrastructure/rest-arkade-client.ts), the only
file that imports the SDK), and the
[Cloudflare Worker + `DelegateRunner` DO](src/infrastructure/cloudflare.ts) (the
per-tenant serializer that makes the overlap guard strict across isolates).

## HTTP API (v1)

All routes except `/v1/health` require `Authorization: Bearer <tenant-api-key>`;
the key resolves to a `tenantId` that namespaces everything in R2. Errors are
JSON `{ "error": "…" }` with status `400` (validation), `401` (auth), `404`,
`405`, `409` (input overlap / illegal cancel), or `500`.

| Method | Path | Body / query | Success |
|---|---|---|---|
| `POST` | `/v1/delegates` | `{ intent, forfeitTxs, delegatePublicKey, fee, scheduledAt? }` | `201` task |
| `GET` | `/v1/delegates` | `?status=&limit=&offset=` | `200 { delegates: [...] }` |
| `GET` | `/v1/delegates/:id` | — | `200` task |
| `DELETE` | `/v1/delegates/:id` | — | `200` cancelled task |
| `GET` | `/v1/health` | — | `200 { status: "ok" }` (liveness; arkd probe is via the client's `health()`) |

`scheduledAt` is **derived from the signed intent's `valid_at`** when the message
decodes; the request field is only a fallback for an opaque message. Example:

```bash
curl -X POST https://<your-worker>/v1/delegates \
  -H "Authorization: Bearer $TENANT_KEY" -H "content-type: application/json" \
  -d '{
    "intent": { "txid": "…", "message": "<canonical-json>", "proof": "<base64>",
                "inputs": [{ "txid": "…", "vout": 0 }] },
    "forfeitTxs": [{ "input": { "txid": "…", "vout": 0 }, "forfeitTx": "<hex>" }],
    "delegatePublicKey": "02…",
    "fee": 250
  }'
# → 201 { "id": "del_…", "status": "pending", "scheduledAt": …, "expiresAt": …, … }
```

## Deploy to Cloudflare

Run your own delegate on Cloudflare's free tier. `wrangler deploy` provisions the
Durable Object and Cron trigger from [`wrangler.jsonc`](wrangler.jsonc); you
create the R2 bucket once and set two secrets.

**i. Sign up & log in (OAuth).**

```bash
# 1. Create a free account at https://dash.cloudflare.com/sign-up
# 2. Authorize Wrangler in your browser (OAuth):
npx wrangler login
```

**ii. Provision the R2 bucket (one-time).**

```bash
npx wrangler r2 bucket create arkade-delegate-tasks
```

**iii. Deploy, then set config.**

```bash
npx wrangler deploy                       # uploads the Worker; creates the DO + cron
npx wrangler secret put API_KEYS          # JSON map: {"<api-key>":"<tenantId>", ...}
npx wrangler secret put DELEGATE_PRIVATE_KEY   # hex operator co-signing key (testnet only)
# ARKADE_SERVER_URL is a var in wrangler.jsonc — point it at your testnet arkd.
```

That's it — your delegate is live at `https://arkade-serverless-delegate.<subdomain>.workers.dev`.
A one-click *Deploy to Cloudflare* button (forks the repo + provisions everything
in the browser) is tracked for Phase 5 ([`docs/PROGRESS.md`](docs/PROGRESS.md)).

> **Before you rely on it:** a deployed instance accepts, stores, schedules, and
> registers delegations, but the renewal **round** is pending end-to-end
> verification (see [Project status](#project-status)) — until then it records a
> liveness failure instead of completing. **Testnet/regtest only.**

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `ARKADE_SERVER_URL` | var ([`wrangler.jsonc`](wrangler.jsonc)) | Base URL of your `arkd` (REST+SSE) |
| `API_KEYS` | secret | JSON map `apiKey → tenantId`; the bearer-auth table |
| `DELEGATE_PRIVATE_KEY` | secret | Operator hex key — co-signs the round via the delegate tapscript path; **never** a user key |

The operator key signs only the renewal round on the user's behalf; it cannot
move funds anywhere the user's intent doesn't already permit.

## Local development against regtest

The real round runs against a local Arkade **regtest** stack (Bitcoin Core +
indexers + `arkd`). Full guide: [`docs/REGTEST.md`](docs/REGTEST.md).

```bash
# requires Docker + the `docker compose` plugin, and Node >= 18
git clone https://github.com/arklabsHQ/arkade-regtest && cd arkade-regtest
node regtest.mjs start --profile ark      # arkd REST at http://localhost:7070

# from this repo:
ARKADE_SERVER_URL=http://localhost:7070 pnpm test:e2e
```

## Testing

```bash
pnpm test         # unit/contract suite — Node's built-in runner + TS type-stripping,
                  # zero install, never touches the network or the SDK
pnpm test:e2e     # arkd-gated integration suite; skips cleanly if arkd is unreachable
pnpm typecheck    # tsc --noEmit
```

Tests double as documentation — each pins one behaviour. A good first read:
`test/use-cases.test.ts` (the concurrent-claim and near-expiry-escalation cases).

## Repo layout

```
src/
  domain/          task.ts (aggregate, parsers, state machine) · errors.ts
  application/     ports.ts (Clock, DelegateRepository, ArkadeClient) · use-cases.ts
  infrastructure/  in-memory-repository.ts · r2-repository.ts · repository-helpers.ts
                   arkade-clients.ts (MockArkadeClient) · rest-arkade-client.ts (real arkd)
                   clock.ts · http-router.ts · cloudflare.ts (Worker + DelegateRunner DO)
  index.ts         re-exports the Worker default + DO (wrangler `main`)
test/              *.test.ts (unit) · integration/ (arkd-gated, pnpm test:e2e)
docs/              DESIGN.md · PROGRESS.md · WORKFLOW.md · REGTEST.md
```

## Project status

Live checklist: [`docs/PROGRESS.md`](docs/PROGRESS.md).

- ✅ **Skeleton + API** against a mock client; DDD layering; component tests.
- ✅ **SDK spike** — `@arkade-os/sdk` imports/runs; the delegate round is composed
  from `RestArkProvider` primitives (no server-side helper exists).
- 🟡 **Real round** — `RestArkadeClient` does health, `SignedIntent` reconstruction,
  and idempotent `registerIntent` for real; the MuSig2 round is fully structured
  but its final step (`SignerSession.init`'s `scriptRoot`/`rootInputAmount`) needs
  a reachable `arkd` to verify. It throws `RoundNotVerifiedError` rather than fake
  a result.
- 🟡 **Hardening** — done: idempotent registration, persisted hard expiry +
  near-expiry escalation, strict (atomic) input-overlap lock. Pending: DO alarms,
  miniflare runtime verification, status indexes, per-tenant quotas, observability.
- ⬜ **One-click deploy** — the *Deploy to Cloudflare* button + container variant.

## How this project is built

Development follows a guardrailed **dialectical loop** (thesis → antithesis →
synthesis), one tested contract piece at a time:

- [`CLAUDE.md`](CLAUDE.md) — invariants & guardrails (for AI sessions)
- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — the build procedure
- [`docs/DESIGN.md`](docs/DESIGN.md) — the authoritative design contract
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — live state

## References

- Arkade docs: [VTXO lifecycle & liveness](https://docs.arkadeos.com/learn/core-concepts/vtxo-lifecycle-and-liveness),
  [Intent delegation](https://docs.arkadeos.com/arkd/components/intent-delegation)
- [Fulmine](https://github.com/ArkLabsHQ/fulmine) — Go delegate reference
- [Arkade TS SDK](https://github.com/arkade-os/ts-sdk) · [demos](https://github.com/arkade-os/demos)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) ·
  [R2](https://developers.cloudflare.com/r2/) ·
  [Durable Objects](https://developers.cloudflare.com/durable-objects/) ·
  [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
