# Progress — live state

> The dialectical loop (`docs/WORKFLOW.md`) updates this file every iteration.
> `[x]` done · `[~]` in progress · `[ ]` todo · `[BLOCKED]` needs something we
> don't have here.

**End goal:** custody-free, multi-tenant Arkade delegate on Cloudflare
(Workers + DO + R2 + Cron). See `docs/DESIGN.md`.

**Current phase:** Phase 3 — Real settlement round (SDK wired; round verification
BLOCKED on the regtest stack — see Phase 3 below).

## Phase 0 — Design
- [x] `docs/DESIGN.md` written and approved
- [x] Architecture decision: pure Workers + DO + R2 + Cron (DESIGN §6)
- [x] Guardrails (`CLAUDE.md`) + workflow (`docs/WORKFLOW.md`)

## Phase 1 — Skeleton, DDD-layered (mock ArkadeClient, no arkd)
47 component tests green (`pnpm test`). Layered `domain → application → infrastructure`:
- **Domain** — `src/domain/task.ts`: `DelegateTask` aggregate owns the status
  machine (illegal transitions throw); value-object parsers (`parseIntent`,
  `parseForfeitTxs`, `parseFee`, `resolveScheduledAt`) turn untrusted JSON into
  valid objects or `ValidationError`. `src/domain/errors.ts`: typed errors →
  httpStatus. (`domain.test.ts`)
- **Application** — `src/application/ports.ts` (`Clock`, `DelegateRepository`,
  `ArkadeClient`); `src/application/use-cases.ts` (`createDelegate`,
  `cancelDelegate`, `getDelegate`, `listDelegates`, `runDelegate`,
  `sweepDelegates`). (`use-cases.test.ts`)
- **Infrastructure** — in-memory + R2 repositories (shared helpers; R2 follows
  the list cursor + skips corrupt objects), `MockArkadeClient` /
  `RestArkadeClient` (Phase-3 stub), `SystemClock`, the HTTP router (error
  boundary + bearer auth + id/status validation), and the Cloudflare worker +
  `DelegateRunner` DO. (`repository.test.ts`, `http-router.test.ts`,
  `arkade-client.test.ts`)

Review-driven fixes folded into the refactor: prototype-chain auth bypass
(Map lookup + non-string guard), malformed input → 400 not 500 (value-object
parsing + top-level error boundary), R2 list truncation → cursor pagination,
corrupt-record skip, decodeURIComponent/id-shape → 404, no same-tick re-dispatch
of recovered tasks, fee-as-integer, status allow-list, API_KEYS parsed once,
`allSettled` fan-out, stale `failReason` cleared on recover, `structuredClone`.

**Phase 1 is complete.** The settlement seam is now wired to the real SDK (Phase
3 below); the full round's end-to-end verification is the one BLOCKED step.

Deferred-review items, updated:
- `scheduledAt` now derives from the **signed** intent `valid_at` (authoritative
  when the message decodes; request value is only a fallback for opaque
  messages). `expiresAt` is captured from `expire_at`. ✅ closed (53 unit tests).
- DO serialization is still not runtime-verified (Phase 4).

## Phase 2 — SDK spike (go/no-go)
- [x] `@arkade-os/sdk@0.4.37` installed and **imports + instantiates under Node 22**
      (`RestArkProvider`/`Intent`/`SingleKey`; 135 exports). `wrangler dev`/workerd
      confirmation deferred to a regtest deploy (DESIGN §8 Q1).
- [x] Decided: **no server-side delegator helper** — the SDK's
      `DelegateProvider`/`DelegateManagerImpl` are the wallet/client side; the
      delegate round is composed from `RestArkProvider` primitives + `signerSession()`
      (we reimplement Fulmine's round). DESIGN §8 Q4 / §8.2. **Go** on pure Workers.

## Phase 3 — Real settlement round
- [x] `scheduledAt`/`expiresAt` derived from the signed intent message (canonical
      JSON `valid_at`/`expire_at`; DESIGN §8.2). Pure domain, unit-tested.
- [x] `RestArkadeClient` wired to `@arkade-os/sdk` `RestArkProvider`
      (`src/infrastructure/rest-arkade-client.ts`): `health()` (getInfo),
      `SignedIntent` reconstruction from stored strings, **idempotent
      `registerIntent`** (dedupe by signed proof — DESIGN §8.1 layer 3). Worker/DO
      wired with the `DELEGATE_PRIVATE_KEY` operator key.
- [x] arkd-gated integration suite (`test/integration/round.test.ts`, `pnpm test:e2e`)
      + `docs/REGTEST.md` (how to run `arklabsHQ/arkade-regtest` and point the
      delegate at it). Reachability-gated: skips when arkd is absent.
- [ ] [BLOCKED] **Phase-3 exit criterion: a real VTXO renewed end-to-end on
      regtest.** Needs `RestArkadeClient.rideRound` (MuSig2 round — `SignerSession.init`'s
      `scriptRoot`/`rootInputAmount` derivation must be verified live) AND the
      wallet-side hand-off. `settleDelegatedIntent` registers (real) then throws
      `RoundNotVerifiedError` rather than fake success.
      *Needs:* the regtest Docker stack — **unavailable here**: the registry APIs
      are reachable but the image blob CDNs (`production.cloudfront.docker.com`,
      `pkg-containers.githubusercontent.com`) return `403` under this environment's
      network policy, so the images can't be pulled. Run on a host with registry
      egress (`docs/REGTEST.md`).

## Phase 4 — Hardening
- [ ] DO alarms for precise per-task scheduling (backstop: the cron sweep).
- [ ] Persist hard expiry (`expiresAt`) + escalate tasks near expiry — closes
      the missed-cron safety gap (DESIGN §8.1).
- [ ] Idempotent `RegisterIntent` (dedupe by intent txid) — DESIGN §8.1 layer 3.
- [ ] Runtime-verify the DO serialization under miniflare; status indexes for
      large tenants; strict overlap lock; per-tenant quotas; observability.

## Phase 5 — One-click deploy
- [ ] "Deploy to Cloudflare" button; deploy docs; optional container variant.

## Notes / decisions log
- 2026-06-17: Tests use Node's built-in runner + type-stripping (zero deps) so
  the loop never depends on a network install. Workers-runtime tests
  (miniflare) are deferred to a later, separate phase.
- 2026-06-17: Switched to **pnpm**; renamed Ark → **Arkade** in our own symbols
  (`ArkadeClient`, `ARKADE_SERVER_URL`), keeping `arkd` (the daemon's real name).
- 2026-06-17: Restructured to a **DDD** layout (domain/application/infrastructure)
  with a `Clock` port + injectable repositories so cron/time are testable. The
  refactor folded in the `/code-review` findings (auth bypass, malformed-input
  500s, R2 truncation, double-dispatch window, etc.).
- 2026-06-18: Phase 2/3. Added `@arkade-os/sdk` (a runtime **dependency**, used
  only in `rest-arkade-client.ts`; the unit loop stays SDK-free — `pnpm test`
  globs `test/*.test.ts`, the SDK-backed suite is `test/integration/` via
  `pnpm test:e2e`). Decoded the signed intent timings; wired the real
  `RestArkProvider` (health + idempotent registration); documented the SDK
  surface (DESIGN §8.2). **e2e renewal BLOCKED**: regtest Docker image blob CDNs
  return 403 under this environment's network policy (`docs/REGTEST.md`).
