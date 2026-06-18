/// <reference types="@cloudflare/workers-types" />
// Cloudflare adapter: the Worker entry (fetch + scheduled) and the
// DelegateRunner Durable Object (docs/DESIGN.md §4, §8.1, §10).
//
// Not runtime-verified in this repo (needs `wrangler dev` / miniflare — Phase 4);
// the testable logic lives in the pure use cases.

import { SingleKey } from "@arkade-os/sdk";

import { bearerToken, errorResponse, handleRequest, json, type RouterDeps } from "./http-router.ts";
import { R2DelegateRepository } from "./r2-repository.ts";
import { RestArkadeClient } from "./rest-arkade-client.ts";
import { SystemClock } from "./clock.ts";
import { createDelegate, sweepDelegates } from "../application/use-cases.ts";

export interface Env {
  DELEGATES: R2Bucket;
  RUNNER: DurableObjectNamespace;
  ARKADE_SERVER_URL: string;
  /** JSON map of apiKey -> tenantId (set via `wrangler secret put API_KEYS`) */
  API_KEYS: string;
  /**
   * Delegate operator signing key (hex), a Worker Secret. Used ONLY to co-sign
   * the renewal round via the delegate tapscript path — never to hold or move
   * user funds (CLAUDE.md invariant #1). Absent in mock/dev deploys.
   */
  DELEGATE_PRIVATE_KEY?: string;
}

const clock = new SystemClock();

// Parse the API-key map once per distinct secret value (immutable for the
// Worker's lifetime) into a Map — Map lookups are immune to the prototype-chain
// auth bypass that plain-object indexing suffers.
let cachedRaw: string | undefined;
let cachedMap = new Map<string, string>();

function keyMap(env: Env): Map<string, string> {
  if (env.API_KEYS !== cachedRaw) {
    cachedRaw = env.API_KEYS;
    cachedMap = parseKeyMap(env.API_KEYS);
  }
  return cachedMap;
}

function parseKeyMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const obj = JSON.parse(raw ?? "{}");
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v) map.set(k, v);
      }
    }
  } catch {
    /* malformed secret -> empty map -> all requests 401 */
  }
  return map;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const map = keyMap(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // A create mutates the tenant's input-overlap set with a read-then-write that
    // R2 can't do atomically (no CAS). Route it through the tenant's single-
    // threaded DelegateRunner DO so concurrent creates serialize and the overlap
    // guard holds across isolates (docs/DESIGN.md §5, §8.1). Reads + cancel stay
    // on the direct path.
    if (request.method === "POST" && path === "/v1/delegates") {
      const token = bearerToken(request);
      const tenantId = token ? (map.get(token) ?? null) : null;
      if (!tenantId) return json(401, { error: "unauthorized" });
      const stub = env.RUNNER.get(env.RUNNER.idFromName(tenantId));
      return stub.fetch("https://runner/op", {
        method: "POST",
        body: JSON.stringify({ op: "create", tenantId, body: await request.text() }),
      });
    }

    const deps: RouterDeps = {
      repo: new R2DelegateRepository(env.DELEGATES),
      clock,
      resolveTenant: (token) => map.get(token) ?? null,
    };
    return handleRequest(request, deps);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const tenantIds = [...new Set(keyMap(env).values())];
    // One DO per tenant serializes that tenant's dispatch (§8.1). allSettled so
    // one tenant's failure doesn't abort the rest of the fan-out.
    await Promise.allSettled(
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

/**
 * Per-tenant serialization point. A DO is single-threaded; the serial queue
 * additionally guarantees one sweep at a time, so concurrent triggers can't
 * double-process a delegation even across isolates (docs/DESIGN.md §8.1).
 */
export class DelegateRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private env: Env;
  // One client per DO instance so its idempotency map (DESIGN §8.1 layer 3)
  // survives across sweeps for the tenant this DO serializes.
  private arkade: RestArkadeClient;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
    const identity = env.DELEGATE_PRIVATE_KEY ? SingleKey.fromHex(env.DELEGATE_PRIVATE_KEY) : undefined;
    this.arkade = new RestArkadeClient(env.ARKADE_SERVER_URL, identity);
  }

  async fetch(request: Request): Promise<Response> {
    const msg = (await request.json()) as { op?: string; tenantId: string; body?: string };
    if (msg.op === "create") {
      // Serialized so the overlap guard's read-then-write can't race another create.
      return this.serialize(() => this.create(msg.tenantId, msg.body ?? ""));
    }
    const summary = await this.serialize(() =>
      sweepDelegates(new R2DelegateRepository(this.env.DELEGATES), this.arkade, clock, msg.tenantId),
    );
    return new Response(JSON.stringify(summary), { headers: { "content-type": "application/json" } });
  }

  private async create(tenantId: string, rawBody: string): Promise<Response> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    try {
      const state = await createDelegate(new R2DelegateRepository(this.env.DELEGATES), clock, tenantId, body as never);
      return json(201, state);
    } catch (e) {
      return errorResponse(e);
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
