# Arkade Serverless Delegate

A serverless, multi-tenant **Arkade delegate** — a hosted service that keeps
users' [VTXOs](https://docs.arkadeos.com/learn/core-concepts/vtxo-lifecycle-and-liveness)
alive by **renewing them before they expire, without ever taking custody** — and
deploys to **Cloudflare** with (near) one click.

> **Status: Phase 1 (skeleton), DDD-layered.** The design is in
> **[`docs/DESIGN.md`](docs/DESIGN.md)**. Code is layered `domain` →
> `application` → `infrastructure` (the `DelegateTask` aggregate owns the
> lifecycle; use cases depend on `Clock`/`DelegateRepository`/`ArkadeClient`
> ports; adapters are R2/in-memory/Cloudflare/mock). Component tests in `test/`.
> Build proceeds via a guardrailed dialectical loop — see [`CLAUDE.md`](CLAUDE.md),
> [`docs/WORKFLOW.md`](docs/WORKFLOW.md), and live state in
> [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Why

Arkade VTXOs expire and must be periodically *renewed* to preserve unilateral
exit rights. That puts a **liveness burden** on users: be online on a schedule,
or risk your funds being swept (recoverable, but you lose unilateral control).

A **delegate** removes that burden. The user hands over a pre-signed **intent**
plus pre-signed **forfeit transactions** that authorize *only* "renew my VTXO
into a fresh VTXO that is still mine (minus a fee)". The delegate submits them
just before expiry. **Funds are safe by construction** — a faulty or malicious
delegate can fail to renew, but it can never redirect funds.

This is the serverless analogue of the delegate built into
[Fulmine](https://github.com/ArkLabsHQ/fulmine) (Go), rebuilt on the
[Arkade TypeScript SDK](https://github.com/arkade-os/ts-sdk).

## Shape

- **TypeScript** on **Cloudflare Workers + Durable Objects** (no container needed —
  the SDK speaks REST + SSE, which the Workers runtime supports)
- **R2** as the task store
- **Cron Triggers** + Durable Object alarms as the scheduler
- **Multi-tenant**: one delegate operator, many users' intents, bearer-key auth

```
user ──POST signed intent + forfeits──▶ API Worker ──▶ R2 (tasks)
                                            │
              Cron sweep / DO alarm ────────┘──▶ DelegateRunner (DO)
                                                   └─REST+SSE─▶ arkd  (settlement round)
```

See **[`docs/DESIGN.md`](docs/DESIGN.md)** for the full architecture, data model,
API, trust model, risks, and a phased roadmap.

## Develop

```bash
pnpm test       # component tests (Node's built-in runner + TS type-stripping —
                # no install needed)
```

Layout: `src/domain/` (the `DelegateTask` aggregate + value-object parsers +
typed errors), `src/application/` (`ports.ts`, `use-cases.ts`),
`src/infrastructure/` (in-memory & R2 repositories, `MockArkadeClient` /
`RestArkadeClient`, `SystemClock`, the HTTP router, and the Cloudflare
Worker + `DelegateRunner` DO). Tests in `test/` exercise each layer.

## References

- Arkade docs: [VTXO lifecycle & liveness](https://docs.arkadeos.com/learn/core-concepts/vtxo-lifecycle-and-liveness),
  [Intent delegation](https://docs.arkadeos.com/arkd/components/intent-delegation)
- [Fulmine](https://github.com/ArkLabsHQ/fulmine) — Go delegate reference
- [Arkade TS SDK](https://github.com/arkade-os/ts-sdk) · [demos](https://github.com/arkade-os/demos)
