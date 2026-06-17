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

**Phase 1 is complete. Settlement (`RestArkadeClient`) is the one remaining seam,
BLOCKED on a live arkd — see Phase 3.**

Deferred from the review (need arkd/codec or runtime, not faked here):
`scheduledAt` is still request-supplied (derived from the signed `validAt` only
when the message is decodable — full derivation is Phase 3); DO serialization is
not runtime-verified (Phase 4).

## Phase 2 — SDK spike (go/no-go)  ← likely BLOCKED here
- [ ] [BLOCKED] Validate `@arkade-os/sdk` imports + runs under `workerd`
      (`nodejs_compat`). *Needs:* npm install of the SDK (network) and a
      `wrangler dev` run.
- [ ] [BLOCKED] Decide raw MuSig2 round vs. SDK delegator helper; measure round
      duration vs DO budget. *Needs:* the SDK + a reachable `arkd`/regtest.

## Phase 3 — Real settlement round
- [ ] [BLOCKED] `RestArkadeClient` against `arkd` on the regtest stack; derive
      `scheduledAt` from the decoded signed intent `validAt`. *Needs:* the
      Arkade regtest stack + outbound network.

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
