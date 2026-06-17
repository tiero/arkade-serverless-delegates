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
- [ ] `wrangler.jsonc` + Worker entry (`fetch` + `scheduled`) + R2/DO bindings
      (config only; not deployed from here).

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
- [ ] DO alarms (precise scheduling), retry/backoff policy, status indexes,
      strict overlap lock (per-tenant DO), quotas, observability.

## Phase 5 — One-click deploy
- [ ] "Deploy to Cloudflare" button; deploy docs; optional container variant.

## Notes / decisions log
- 2026-06-17: Tests use Node's built-in runner + type-stripping (zero deps) so
  the loop never depends on a network install. Workers-runtime tests
  (miniflare) are deferred to a later, separate phase.
