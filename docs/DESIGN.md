# Arkade Serverless Delegate — Design

> Status: **Design doc (v0.1)** — no implementation yet. This document is the
> contract we implement against. Code lands only after this is approved.

A serverless, multi-tenant **Arkade delegate**: a hosted service that keeps
users' VTXOs alive by renewing them before they expire, **without ever taking
custody**. Built to deploy to **Cloudflare** with (near) one click.

- **Language:** TypeScript
- **Runtime:** Cloudflare Workers + Durable Objects (no container required — see
  [§6 Architecture decision](#6-architecture-decision-pure-workers-vs-container))
- **Storage:** Cloudflare R2 (task store)
- **Scheduler:** Cloudflare Cron Triggers (coarse sweep) + Durable Object alarms
  (precise per-task)
- **Tenancy:** multi-tenant (one delegate operator, many users' intents)

---

## 1. Background: why a delegate exists

### 1.1 VTXO liveness

In Arkade, off-chain funds are held as **VTXOs** (virtual UTXOs) inside a
shared, server-coordinated transaction tree. Each VTXO carries a **batch
expiry**. To keep the right to unilaterally exit on-chain, the owner must
periodically **renew** (a.k.a. *refresh* / *settle*) the VTXO into a fresh batch
before that expiry.

If the owner misses the renewal window, the operator **sweeps** the expired
VTXO. Funds are still recoverable cooperatively, but the owner loses the ability
to *unilaterally* enforce ownership on-chain. In short: **expiry imposes a
liveness requirement on the user** — they (or their software) must be online and
act on a schedule.

> Sources: Arkade docs — *VTXO lifecycle and liveness* (`docs.arkadeos.com`);
> Ark Labs blog — *Adios, Expiry: Rethinking Liveness and Liquidity in Arkade*.

### 1.2 Delegation: liveness without custody

**Delegation** lets a user authorize a third party to perform that renewal on
their behalf. The crucial property: **the delegate never takes custody.** The
user hands over pre-signed material that *only* authorizes "renew my VTXO into a
fresh VTXO that still belongs to me" (minus an agreed fee). The user keeps full
unilateral control the whole time.

Concretely, the user gives the delegate, per cycle:

1. A signed **intent** — a Bitcoin-native ownership proof (BIP322-style) that
   proves the user owns specific VTXOs and specifies the desired output
   (a fresh VTXO back to the user's address, minus fee).
2. Pre-signed **forfeit transactions** — one per input, which let the operator
   reclaim the old VTXO once the new one is committed.

The delegate stores these and, just before expiry, submits the intent to the
Ark server and rides the settlement round to completion.

> Sources: Arkade docs — *Intent delegation: intent construction and hand-off*;
> Arkade demos — `delegate` example ("submit a delegation intent to a delegate,
> consolidating funds into a single settled output").

### 1.3 What we are NOT building

- Not a wallet. The delegate holds no user funds and no user spending keys.
- Not a custodian. It cannot move funds anywhere except where the user's
  pre-signed intent already dictates.
- Not the Ark server (`arkd`). We are a *client* of `arkd`.

---

## 2. Reference implementation: Fulmine

[Fulmine](https://github.com/ArkLabsHQ/fulmine) (Go) is Ark Labs' wallet daemon
that, among other things, "acts as a delegate for automated VTXO refresh." We
mirror its delegate flow. The relevant code lives in
`internal/core/application/delegator_service.go` and
`delegator_batch_handler.go`.

### 2.1 Fulmine's data model (`api-spec/.../service.proto`)

This is the shape we persist (verbatim from Fulmine's proto, our R2 records
mirror it):

```proto
message DelegateIntent {
  string txid    = 1;   // proof.UnsignedTx.TxID()
  string message = 2;   // encoded intent message (carries `valid_at`)
  string proof   = 3;   // encoded BIP322-style ownership proof
  repeated Input inputs = 4;
}

message DelegateForfeitTx {
  Input  input      = 1;
  string forfeit_tx = 2;   // hex, pre-signed by the user
}

message Delegate {
  string id                  = 1;
  DelegateIntent intent      = 2;
  repeated DelegateForfeitTx forfeit_txs = 3;
  uint64 fee                 = 4;
  string delegate_public_key = 5;
  int64  scheduled_at        = 6;   // when to renew (Unix seconds)
  string status              = 7;
  string fail_reason         = 8;
  string commitment_txid     = 9;   // set after a successful round
}
```

### 2.2 Fulmine's flow (what we re-implement in TS)

1. **Hand-off** — `Delegate(message, proof, forfeitTxs)`:
   - decode/validate intent, reject **overlapping inputs** with existing tasks
     (under a lock),
   - `scheduledAt = time.Unix(message.valid_at, 0)`,
   - persist task as `pending`,
   - schedule `registerDelegate` at `scheduledAt`.
2. **Fire** (`registerDelegate` at the scheduled time):
   - `intentId = Client().RegisterIntent(ctx, proof, message)`,
   - watch `BatchStartedEvent`, join the batch containing `intentId`.
3. **Round** (MuSig2 batch session):
   - `OnTreeSigningStarted` → build script tree, `SubmitTreeNonces`,
   - `OnTreeNonces` → aggregate nonces, `Sign`, `SubmitTreeSignatures`,
   - `OnBatchFinalization` → fetch non-recoverable VTXOs, attach connector
     inputs to each pre-signed forfeit PSBT, `SignTransaction`,
     `SubmitSignedForfeitTxs`,
   - `OnBatchFinalized` → mark `completed`, store `commitment_txid`.
4. **Cancellation** — watch for spent VTXOs; cancel pending tasks whose inputs
   were already spent (the user moved funds elsewhere).

---

## 3. The Arkade TypeScript SDK (`@arkade-os/sdk`)

We build on [`arkade-os/ts-sdk`](https://github.com/arkade-os/ts-sdk)
(`@arkade-os/sdk`). Confirmed, relevant surface:

- `Wallet` — wallet/operations entry point.
- **Providers** — `RestArkProvider` (Ark server) and `RestIndexerProvider`
  (VTXO/address state). Transport is **REST + SSE** for settlement/transaction
  streams and address subscriptions. **This is why we don't need a container:
  SSE over `fetch` works in the Workers runtime.**
- `settle()` — the renewal primitive (inputs from `getVtxos()`, outputs to a
  destination + amount).
- `VtxoManager` — renewal of VTXOs before expiry + recovery of swept/expired
  ones.
- `registerIntent` / `deleteIntent` — manage spend intents for collaborative
  (batch) transactions.
- Identity from a single key (e.g. `SingleKey`) for the **delegate's own** key
  (used to co-sign the tree, supply connectors, and pay fees — not user funds).

> ⚠️ Exact signatures must be verified against the SDK TypeDoc
> (`arkade-os.github.io/ts-sdk`) during Phase 2. Code snippets below are
> **illustrative**.

> The SDK README already describes a built-in delegator notion: *"the delegator
> will automatically settle VTXOs before they expire, sending the funds back to
> your wallet address (minus a service fee)."* We may be able to lean on SDK
> primitives rather than reimplementing the raw MuSig2 round — a Phase-2
> spike decides this.

---

## 4. System architecture (recommended: pure Workers)

```
                          ┌──────────────────────────────────────────┐
   user / wallet          │             Cloudflare                    │
   (holds keys) ──HTTPS──▶ │  ┌────────────────┐                       │
   POST /v1/delegates     │  │   API Worker     │   bind  ┌──────────┐ │
   (intent + forfeits)    │  │  (fetch handler) │────────▶│   R2     │ │
                          │  │  - authn (key)   │  store  │ task     │ │
   GET /v1/delegates  ───▶ │  │  - validate      │◀────────│ store    │ │
                          │  │  - persist+sched │  list   └──────────┘ │
                          │  └───────┬──────────┘                       │
                          │          │ set alarm / dispatch             │
                          │          ▼                                  │
   Cron (* * * * *) ─────▶ │  ┌────────────────┐   alarm  ┌───────────┐ │
   scheduled() sweep ─────┼─▶│ DelegateRunner  │◀─────────│  DO alarm │ │
                          │  │  Durable Object  │          └───────────┘ │
                          │  │  - registerIntent│                        │
                          │  │  - MuSig2 round  │   REST + SSE           │
                          │  │  - submit forfeit│──────────────────────────▶  arkd
                          │  │  - write result  │                        │   (Ark server)
                          │  └────────────────┘                         │
                          └──────────────────────────────────────────┘
```

### 4.1 Components

| Component | CF primitive | Responsibility |
|---|---|---|
| **API Worker** | Worker (`fetch`) | Public HTTP API: accept hand-offs, list/get/cancel tasks, authenticate tenants, validate, persist to R2, arm scheduling. |
| **Scheduler (sweep)** | Cron Trigger (`scheduled`) | Every minute: scan R2 for due/stuck tasks and dispatch them. Reliable backstop + retry driver. |
| **DelegateRunner** | Durable Object (+ alarm) | Executes exactly one settlement round per task: register intent → ride the batch round → submit forfeits → record result. Single-threaded ⇒ serializes a tenant's rounds and gives us precise per-task wakeups. |
| **Task store** | R2 bucket | Source of truth for `Delegate` records (JSON). |
| **Delegate identity & config** | Worker Secrets + vars | Delegate operator's signing key, `arkd` URL, per-tenant API keys. |

### 4.2 Scheduling: two layers, on purpose

- **Durable Object alarm** = *precision.* On hand-off we set an alarm at
  `scheduledAt` so the round fires close to the right moment.
- **Cron Trigger** = *durability.* A once-a-minute sweep catches anything the
  alarm missed (deploys, alarm loss, crashes) and re-drives tasks stuck in
  `registering`/`in_round` past a timeout. It is also the natural place for
  retry-with-backoff before the hard expiry deadline.

A first cut can ship **Cron-only** (simplest, matches the user's "scheduler"
ask). DO alarms are the refinement for tight timing.

### 4.3 Status lifecycle

```
pending ──▶ registering ──▶ in_round ──▶ completed
   │             │              │
   │             └──────────────┴──▶ failed (retryable until deadline)
   └──▶ cancelled (inputs spent elsewhere / user DELETE)
```

---

## 5. Data model & R2 layout

Records mirror Fulmine's `Delegate` (§2.1), as JSON.

```jsonc
// R2 key: tenants/{tenantId}/delegates/{id}.json
{
  "id": "del_01H...",
  "tenantId": "t_abc",
  "intent": {
    "txid": "…",
    "message": "…",          // encoded; carries validAt
    "proof": "…",            // encoded BIP322 ownership proof
    "inputs": [{ "txid": "…", "vout": 0 }]
  },
  "forfeitTxs": [{ "input": { "txid": "…", "vout": 0 }, "forfeitTx": "<hex>" }],
  "fee": 250,
  "delegatePublicKey": "02…",
  "scheduledAt": 1750000000,
  "status": "pending",
  "failReason": "",
  "commitmentTxid": "",
  "attempts": 0,
  "createdAt": 1749000000,
  "updatedAt": 1749000000
}
```

**Key design**

- `tenants/{tenantId}/delegates/{id}.json` — the record (strong read-after-write
  on a single key in R2).
- **Listing/`status` filter** — R2 has no secondary index. Options:
  - *Reference simplicity:* `list()` by prefix + filter in memory (fine for
    modest volumes).
  - *Scale:* maintain a small per-tenant index object
    (`tenants/{id}/index.json`) or a status-prefixed pointer key
    (`tenants/{id}/by-status/{status}/{scheduledAt}-{id}`) updated on each
    transition. Decide in Phase 2 based on expected task counts.
- **Input-overlap guard** (Fulmine rejects overlapping inputs): keep
  `tenants/{id}/locks/{inputTxid}:{vout}` marker keys; check-and-set on
  hand-off. Document the race (R2 is not transactional) and serialize via a
  per-tenant Durable Object if strictness is required.

---

## 6. Architecture decision: pure Workers vs container

The original ask floated "container + R2 + scheduler" (because the Go reference,
Fulmine, is a container). Now that the language is **TypeScript** and the SDK
talks **REST + SSE** (browser-compatible), a container is **not required** and a
**pure-Workers** design is strictly better for the "one-click" goal.

| | **Pure Workers + DO (recommended)** | **Worker + Container** |
|---|---|---|
| One-click deploy | ✅ "Deploy to Cloudflare" button auto-provisions Worker, R2, DO, Cron — no Docker | ⚠️ needs Docker at deploy (or a prebuilt image registry); button support is heavier |
| Cost / cold start | ✅ cheap, scales to zero | ❌ container minutes, slower spin-up |
| Long-lived gRPC streams | ⚠️ no native gRPC; relies on REST+SSE (SDK supports it) | ✅ full gRPC if ever needed |
| Code reuse | TS SDK (`@arkade-os/sdk`) | could reuse Fulmine Go directly |
| Round duration limits | ⚠️ main risk (see §8) | ✅ unconstrained |

**Decision:** build **pure Workers + Durable Objects + R2 + Cron**. Keep a
documented **container variant** (a Go/Fulmine-derived image fronted by a Worker)
as a fallback *only if* settlement rounds prove too long for the DO execution
budget (§8).

---

## 7. HTTP API (v1)

All endpoints require `Authorization: Bearer <tenant-api-key>`; the key resolves
to a `tenantId` and namespaces everything in R2.

| Method | Path | Body / Query | Description |
|---|---|---|---|
| `POST` | `/v1/delegates` | `{ intent, forfeitTxs, delegatePublicKey, fee }` | Hand off a signed delegation. Validates, computes `scheduledAt` from `intent.message.validAt`, stores `pending`, arms scheduling. → `{ id, status, scheduledAt }` |
| `GET` | `/v1/delegates` | `?status=&limit=&offset=` | List tasks for the tenant (mirrors Fulmine `ListDelegates`). |
| `GET` | `/v1/delegates/:id` | — | Fetch one task. |
| `DELETE` | `/v1/delegates/:id` | — | Cancel a pending task. |
| `GET` | `/v1/health` | — | Liveness + `arkd` reachability. |

Validation on hand-off: decode intent & proof, verify it covers the declared
inputs, ensure one forfeit tx per input, reject overlapping inputs, sanity-check
fee, ensure `validAt` is in the future and before the inputs' expiry.

---

## 8. Risks & open questions

1. **Workers runtime compatibility of the SDK.** `@arkade-os/sdk` pulls in
   Bitcoin crypto libs. They run in browsers, so they should run in `workerd`
   with `compatibility_flags: ["nodejs_compat"]` — **must be validated first**
   (Phase 2 spike: import SDK + do a no-op `RestArkProvider` call in
   `wrangler dev`).
2. **Settlement-round duration vs DO budget.** A round (register → tree sign →
   finalize over SSE) can take tens of seconds. Durable Objects are the right
   home (they can await I/O across subrequests), but we must measure against
   the execution budget. If it doesn't fit → container variant (§6). This is the
   single biggest unknown.
3. **SSE longevity in a DO.** Need to confirm an SSE stream held open inside a
   DO invocation survives a full round; otherwise poll the indexer instead.
4. **Does the SDK expose the raw MuSig2 round, or a one-call delegator helper?**
   The README hints at a built-in delegator. If a high-level helper exists, the
   DelegateRunner shrinks dramatically. Spike in Phase 2.
5. **R2 has no transactions.** Input-overlap guard and status indexes need a
   serialization strategy (per-tenant DO) for strict correctness.
6. **Delegate key custody.** The operator's signing key is a Worker Secret.
   Document threat model; consider per-tenant keys or HSM/KMS later.

---

## 9. Security & trust model

- **Funds are safe by construction.** The delegate only ever holds a pre-signed
  intent + forfeit txs that send a fresh VTXO **back to the user** (minus the
  agreed fee). A malicious/compromised delegate **cannot redirect funds**; the
  worst it can do is *fail to renew* (a liveness failure, not a theft) or leak
  metadata.
- **What the delegate can see:** which VTXOs, amounts, and renewal timing for
  its tenants → a **privacy** consideration. Per-tenant isolation in R2 + API
  keys; consider not logging amounts.
- **Multi-tenant isolation:** API key → `tenantId` → R2 prefix. No cross-tenant
  reads. Rate-limit and quota per key.
- **Replay / griefing:** reject duplicate/overlapping intents; idempotent
  hand-off keyed by intent `txid`.
- **Auth on the public API.** (Fulmine's own gRPC/REST are noted as unauthenticated
  in their issue #98 — we explicitly do better with bearer keys from day one.)

---

## 10. Cloudflare configuration (sketch)

`wrangler.jsonc` (illustrative — bindings auto-provision on deploy):

```jsonc
{
  "name": "arkade-serverless-delegate",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],

  "r2_buckets": [
    // no bucket name/id => wrangler auto-provisions on deploy
    { "binding": "DELEGATES", "bucket_name": "arkade-delegate-tasks" }
  ],

  "durable_objects": {
    "bindings": [{ "name": "RUNNER", "class_name": "DelegateRunner" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DelegateRunner"] }],

  "triggers": { "crons": ["* * * * *"] },

  "vars": { "ARK_SERVER_URL": "https://ark.example.com" }
  // secrets (wrangler secret put): DELEGATE_PRIVATE_KEY, API_KEYS
}
```

**One-click deploy:** a *Deploy to Cloudflare* button in the README points at
this repo; Cloudflare clones it and provisions Worker + R2 + DO + Cron from the
config. (The container variant would additionally need Docker / a published
image, which is why pure Workers wins the one-click goal.)

---

## 11. Proposed repo layout

```
.
├── README.md
├── docs/
│   └── DESIGN.md                # this file
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Worker entry: fetch() + scheduled()
│   ├── api/
│   │   ├── router.ts            # /v1 routes
│   │   ├── auth.ts              # bearer key -> tenantId
│   │   └── validate.ts          # intent/forfeit validation
│   ├── runner/
│   │   └── DelegateRunner.ts    # Durable Object: the settlement round
│   ├── ark/
│   │   ├── ArkClient.ts         # interface over @arkade-os/sdk
│   │   └── mock.ts              # in-memory mock for local/dev + tests
│   ├── store/
│   │   └── r2.ts                # Delegate CRUD + listing/index on R2
│   ├── scheduler/
│   │   └── sweep.ts             # cron sweep: due + stuck tasks
│   └── types.ts                 # Delegate, DelegateIntent, DelegateForfeitTx
└── test/
    └── *.test.ts                # vitest + miniflare
```

---

## 12. Phased roadmap

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 — Design** | this doc | approved |
| **1 — Skeleton** | Worker + R2 + Cron + full API against a **mock `ArkClient`** | `wrangler dev`: hand off → stored → cron sweep flips to `completed` (mock); tests green |
| **2 — SDK spike** | validate `@arkade-os/sdk` in `workerd`; decide raw-round vs delegator-helper; measure round duration | go/no-go on pure-Workers vs container |
| **3 — Real round** | `DelegateRunner` against `arkd` (regtest stack) | a real VTXO renewed end-to-end on regtest |
| **4 — Hardening** | DO alarms, retry/backoff, status indexes, overlap guard, auth/quotas, observability | crash/restart safe; multi-tenant isolated |
| **5 — One-click** | Deploy-to-Cloudflare button, docs, optional container variant | deploys from a clean account in one flow |

---

## Sources

- Arkade docs — VTXO lifecycle & liveness; Intent delegation (intent
  construction and hand-off): `docs.arkadeos.com`
- Fulmine (Go delegate reference): `github.com/ArkLabsHQ/fulmine`
  (`internal/core/application/delegator_service.go`,
  `delegator_batch_handler.go`, `api-spec/.../service.proto`)
- Arkade TS SDK: `github.com/arkade-os/ts-sdk` (`@arkade-os/sdk`)
- Arkade demos (incl. `delegate`): `github.com/arkade-os/demos`
- Ark Labs blog — *Adios, Expiry: Rethinking Liveness and Liquidity in Arkade*
- Cloudflare docs — Containers, Durable Objects, R2 binding auto-provisioning,
  Cron Triggers, Wrangler configuration: `developers.cloudflare.com`
