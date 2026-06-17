# Workflow — the dialectical build loop

We drive this project to its end goal with a **dialectical loop**: small,
self-critiquing iterations. Each one takes a single contract piece from
thesis, through antithesis, to synthesis — then proves it with tests and
records the new state. `CLAUDE.md` holds the guardrails; this file is the
*procedure*.

## The end goal

A multi-tenant Arkade delegate that, on Cloudflare:

1. accepts a signed delegation hand-off (intent + forfeit txs) over an
   authenticated API,
2. persists it (R2) and schedules renewal (Cron + DO alarm),
3. at the right time, runs the settlement round against `arkd` and renews the
   VTXOs **without custody**,
4. records the outcome and is observable, crash-safe, and tenant-isolated.

The phased path to get there is `docs/DESIGN.md` §12. The live checklist is
`docs/PROGRESS.md`.

## One iteration = Thesis → Antithesis → Synthesis

**0. Orient.** Read `CLAUDE.md`, `docs/DESIGN.md`, `docs/PROGRESS.md`. Pick the
single next unchecked item in PROGRESS (smallest useful step). State it.

**1. Thesis — build it.** Implement that one piece per the design. Keep the diff
small and focused on this piece.

**2. Antithesis — attack it.** Argue against your own work. Specifically check:
   - Does it violate any **invariant** in `CLAUDE.md`? (custody, isolation,
     ambiguous hand-offs, secret/amount logging)
   - Where does it break? Edge cases, races (R2 is not transactional),
     crash/restart, retries, clock skew, pagination, empty/duplicate inputs.
   - Is the **design** actually right here, or did implementing reveal a flaw?
   - What's untested? What would a hostile tenant try?

**3. Synthesis — reconcile.** Resolve the tension from step 2:
   - fix the implementation, **and/or**
   - update `docs/DESIGN.md` (the contract) in the *same* change, explaining the
     revision, **and**
   - add or strengthen **component tests** that pin the resolved behaviour.

**4. Prove + record.**
   - `npm test` must be green. **Never commit on red.**
   - Update `docs/PROGRESS.md` (check the item, note follow-ups / new BLOCKED).
   - Commit small with the standard footer; push to the working branch.

Then advance to the next item. Prefer depth over breadth: finish and test one
piece before starting another.

## Stop / blocked conditions

End the loop (don't reschedule) and report when **any** of these holds:

- **Done:** the next phase's checklist in `docs/PROGRESS.md` is fully green and
  committed (e.g. Phase 1 complete, or the Phase 2 spike has produced a go/no-go
  decision).
- **Blocked:** the next step requires something unavailable in this environment
  — a live `arkd`, the regtest stack, npm/SDK installs the network policy
  blocks, or Cloudflare credentials. Mark it BLOCKED in `docs/PROGRESS.md` with
  exactly what's needed, then stop.
- **Stuck:** tests can't be made green after a couple of honest attempts, or the
  same item keeps reopening. Stop and report the diagnosis — don't thrash or
  weaken tests to force green.

Never fake integration to "make progress": a stub that pretends to talk to
`arkd` is a BLOCKED item, not a synthesis.

## Why this shape

The antithesis step is where correctness is won: a delegate's whole value is
that it *cannot* steal, so every iteration must try to prove it can — and fail.
Keeping iterations to one tested piece keeps the design and code honest and the
history reviewable.
