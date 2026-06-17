# Progress — live state

> The dialectical loop (`docs/WORKFLOW.md`) updates this file every iteration.
> `[x]` done · `[~]` in progress · `[ ]` todo · `[BLOCKED]` needs something we
> don't have here.

**End goal:** custody-free, multi-tenant Arkade delegate on Cloudflare
(Workers + DO + R2 + Cron). See `docs/DESIGN.md`.

**Current phase:** Phase 1 — Skeleton (contract pieces + component tests).

## Phase 0 — Design
- [x] `docs/DESIGN.md` written and approved
- [x] Architecture decision: pure Workers + DO + R2 + Cron (DESIGN §6)
- [x] Guardrails (`CLAUDE.md`) + workflow (`docs/WORKFLOW.md`)

## Phase 1 — Skeleton (mock ArkClient, no arkd)
Contract pieces, each with component tests in `test/` (25 tests green):
- [x] Data model + status machine — `src/types.ts` (`types.test.ts`)
- [x] Hand-off validation + overlap guard — `src/api/validate.ts` (`validate.test.ts`)
- [x] Task store contract + in-memory impl — `src/store/*.ts` (`store.test.ts`)
- [x] ArkClient seam + mock — `src/ark/*.ts` (`mock-ark.test.ts`)
- [x] Cron-sweep selectors — `src/scheduler/sweep.ts` (`sweep.test.ts`)
- [x] **Delegate service** — `createDelegate()` / `cancelDelegate()` compose
      validate + overlap guard + store — `src/core/service.ts` (`service.test.ts`).
      Antithesis: stores intent verbatim (custody test), 409 on overlap, cancel
      only for `pending`, tenant-scoped 404s.
- [x] **API router** — `POST/GET/DELETE /v1/delegates`, `GET /v1/health`,
      bearer-key → tenantId — `src/api/router.ts` (`router.test.ts`).
      Antithesis: 401 unauth, 400 bad JSON, cross-tenant access → 404 (no
      existence leak), 405/404 for bad method/route.
- [x] **Runner core (mock)** — pending → registering → in_round → completed (or
      failed) via `ArkClient`, with a transition guard — `src/runner/runner.ts`
      (`runner.test.ts`). Antithesis: custody test (forwards intent/forfeits
      verbatim), idempotent on non-pending, failure records reason, retry
      accumulates `attempts`. Synthesis: added `attempts` to the record +
      DESIGN §5.
- [x] **Cron sweep wiring** — `runSweep` recovers stuck/failed (bounded by
      maxAttempts) then dispatches due tasks via the runner — `src/scheduler/cron.ts`
      (`cron.test.ts`). Level-triggered (re-derives from state each tick) →
      resilient to missed crons; tenant-scoped.
- [x] `wrangler.jsonc` + Worker entry (`fetch` + `scheduled`) + R2 store +
      `DelegateRunner` DO (per-tenant serialization, DESIGN §8.1) + `RestArkClient`
      stub — `src/index.ts`, `src/runner/DelegateRunner.ts`, `src/store/r2.ts`,
      `src/ark/rest.ts`, `wrangler.jsonc`. R2 store covered by `r2-store.test.ts`;
      the DO + deploy are config/code, not runtime-verified here.

**Phase 1 is complete: 58 component tests green. Settlement (RestArkClient) is
the one remaining seam and is BLOCKED on a live arkd — see Phase 3.**

## Phase 2 — SDK spike (go/no-go)  ← likely BLOCKED here
- [ ] [BLOCKED] Validate `@arkade-os/sdk` imports + runs under `workerd`
      (`nodejs_compat`). *Needs:* npm install of the SDK (network) and a
      `wrangler dev` run.
- [ ] [BLOCKED] Decide raw MuSig2 round vs. SDK delegator helper; measure round
      duration vs DO budget. *Needs:* the SDK + a reachable `arkd`/regtest.

## Phase 3 — Real settlement round
- [ ] [BLOCKED] `RestArkClient implements ArkClient` against `arkd` on the
      regtest stack. *Needs:* the Arkade regtest stack + outbound network.

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
