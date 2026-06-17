# Guardrails — Arkade Serverless Delegate

This file is auto-loaded by Claude Code. **Read it, `docs/DESIGN.md`,
`docs/WORKFLOW.md`, and `docs/PROGRESS.md` before changing anything.** These
guardrails exist so every agent session advances the *same* plan the *same* way.

## What we are building (one line)

A serverless, multi-tenant **Arkade delegate** that renews users' VTXOs before
expiry **without taking custody** — TypeScript on Cloudflare Workers + Durable
Objects + R2 + Cron. The end goal and roadmap live in `docs/DESIGN.md` §12.

## Invariants — never violate these

1. **No custody.** The delegate only ever stores pre-signed intents + forfeit
   txs that renew a VTXO *back to its owner* (minus the agreed fee). Never add a
   code path that could redirect, spend, or withhold user funds elsewhere. A
   delegate may *fail to renew* (a liveness fault); it must never be able to
   *steal* (a safety fault).
2. **Tenant isolation.** Every store/API operation is scoped by `tenantId`.
   Never read or list across tenants. Auth is bearer-key → `tenantId`.
3. **Reject ambiguous hand-offs.** One forfeit tx per input; no overlapping
   inputs with an active task; renewal time in the future. See
   `src/api/validate.ts`.
4. **Don't log secrets or amounts.** The operator signing key is a Worker
   Secret. Treat balances/timing as private.

## Plan adherence

- **`docs/DESIGN.md` is the contract.** Implementations conform to it. If you
  must deviate, **update DESIGN.md in the same change** and say why — code and
  design never drift apart.
- **`docs/PROGRESS.md` is the live state.** Update it every iteration: check off
  what's done, note what's next, record BLOCKED items.
- Architecture is decided (DESIGN §6): **pure Workers + DO + R2 + Cron, no
  container.** Only revisit if a settlement round provably exceeds the DO
  execution budget — and then update DESIGN first.

## How to work — the dialectical loop

Follow `docs/WORKFLOW.md`. Every change is **Thesis → Antithesis → Synthesis**:
implement, then attack your own work against the invariants and the contract,
then reconcile (fix code and/or update the design) and add/strengthen tests.
Take **one contract piece per iteration**; keep diffs small and reviewable.

## Testing — non-negotiable

- Every contract piece has **component tests** in `test/`.
- Run `npm test` before every commit. **Never commit on red.**
- Tests are **dependency-light**: Node's built-in runner with type-stripping
  (`node --test --experimental-strip-types`). **Do not** introduce test deps
  that need network installs or the Workers runtime for *unit/contract* tests —
  that would make the loop fragile. (Workers-runtime integration tests via
  miniflare come in a later, clearly-separated phase.)
- TS source uses explicit `.ts` import extensions and `import type {…}` for
  type-only imports (required by Node type-stripping + `verbatimModuleSyntax`).
  Type-stripping is **strip-only**: no constructs that need code generation —
  no `enum`, no `namespace`, no constructor **parameter properties**
  (`constructor(private x)`); declare fields explicitly instead.

## Git

- Work only on branch `claude/pensive-maxwell-5riivw`. Never push elsewhere.
- Small, descriptive commits. Push after green tests.
- Do **not** open a PR unless explicitly asked.
- Commit footer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NBkxbLAVPGSoSEJMRsF5Na
  ```

## Scope & stop conditions

- **Regtest / testnet only.** Never wire real funds or mainnet.
- If a step needs a resource you don't have here (live `arkd`, regtest stack,
  outbound network the policy forbids), **mark it BLOCKED in `docs/PROGRESS.md`
  with what's needed, stop the loop, and report** — do not fake it or push past
  it with stubs pretending to be real integration.
