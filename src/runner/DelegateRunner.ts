/// <reference types="@cloudflare/workers-types" />
// DelegateRunner Durable Object — the per-tenant serialization point
// (docs/DESIGN.md §4, §8.1).
//
// One instance per tenant (`id = idFromName(tenantId)`). A DO is single-threaded,
// and this class additionally chains work onto a serial queue, so cron ticks and
// per-task alarms that route through it can never double-process the same
// delegation — even across parallel isolates, where the status guard alone is
// not enough (R2 has no atomic compare-and-swap).
//
// The decision logic lives in the unit-tested pure modules (runSweep /
// runDelegate); this is a thin wrapper. Not runtime-verified in this repo yet
// (needs `wrangler dev` / miniflare — Phase 4).

import { runSweep } from "../scheduler/cron.ts";
import { R2DelegateStore } from "../store/r2.ts";
import { RestArkClient } from "../ark/rest.ts";
import type { Env } from "../index.ts";

export class DelegateRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private state: DurableObjectState; // retained for future per-task alarms (Phase 4)
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Triggered by the Worker's scheduled() handler. Body: { tenantId }. */
  async fetch(request: Request): Promise<Response> {
    const { tenantId } = (await request.json()) as { tenantId: string };
    const summary = await this.serialize(() => {
      const store = new R2DelegateStore(this.env.DELEGATES);
      const ark = new RestArkClient(this.env.ARK_SERVER_URL);
      return runSweep(store, ark, tenantId, nowSecs());
    });
    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Run `fn` after all previously-queued work, so this DO does one thing at a time. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
