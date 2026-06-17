/// <reference types="@cloudflare/workers-types" />
// Cloudflare Worker entry (docs/DESIGN.md §10).
//   fetch()     — serves the HTTP API (src/api/router.ts) over R2.
//   scheduled() — the Cron Trigger; fans out to one DelegateRunner DO per tenant
//                 (the per-tenant serialization point, §8.1).

import { handleRequest, type RouterEnv } from "./api/router.ts";
import { R2DelegateStore } from "./store/r2.ts";

export { DelegateRunner } from "./runner/DelegateRunner.ts";

export interface Env {
  DELEGATES: R2Bucket;
  RUNNER: DurableObjectNamespace;
  ARK_SERVER_URL: string;
  /** JSON map of apiKey -> tenantId (set via `wrangler secret put API_KEYS`) */
  API_KEYS: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routerEnv: RouterEnv = {
      store: new R2DelegateStore(env.DELEGATES),
      resolveTenant: (token) => tenantsFromEnv(env)[token] ?? null,
      now: () => Math.floor(Date.now() / 1000),
    };
    return handleRequest(request, routerEnv);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const tenantIds = [...new Set(Object.values(tenantsFromEnv(env)))];
    // One DO per tenant; the DO serializes that tenant's dispatch so concurrent
    // ticks can't double-process a delegation (§8.1).
    await Promise.all(
      tenantIds.map((tenantId) => {
        const stub = env.RUNNER.get(env.RUNNER.idFromName(tenantId));
        return stub.fetch("https://runner/sweep", {
          method: "POST",
          body: JSON.stringify({ tenantId }),
        });
      }),
    );
  },
};

function tenantsFromEnv(env: Env): Record<string, string> {
  try {
    return JSON.parse(env.API_KEYS ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
