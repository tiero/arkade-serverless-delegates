// HTTP API (docs/DESIGN.md §7). Pure `Request -> Response` so it runs both in a
// Cloudflare Worker and under Node's test runner with no Workers runtime.
//
// Auth boundary: every route except /v1/health requires `Authorization: Bearer
// <key>`, resolved to a tenantId. All store access is then scoped to that
// tenant — a tenant can never see another's tasks (returns 404, not 403, so we
// don't leak existence).

import { cancelDelegate, createDelegate } from "../core/service.ts";
import type { DelegateRequest } from "./validate.ts";
import type { DelegateStore, ListOptions } from "../store/store.ts";
import type { DelegateStatus } from "../types.ts";

export interface RouterEnv {
  store: DelegateStore;
  /** map a bearer token to a tenantId, or null if unknown */
  resolveTenant(token: string): string | null | Promise<string | null>;
  /** current time in unix seconds (injectable for tests) */
  now(): number;
}

const ITEM = /^\/v1\/delegates\/([^/]+)$/;

export async function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/v1/health" && method === "GET") {
    return json(200, { status: "ok" });
  }

  const tenantId = await authenticate(request, env);
  if (!tenantId) return json(401, { error: "unauthorized" });

  if (path === "/v1/delegates") {
    if (method === "GET") return listDelegates(url, env, tenantId);
    if (method === "POST") return createDelegateRoute(request, env, tenantId);
    return json(405, { error: "method not allowed" });
  }

  const m = ITEM.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === "GET") return getDelegate(env, tenantId, id);
    if (method === "DELETE") return deleteDelegate(env, tenantId, id);
    return json(405, { error: "method not allowed" });
  }

  return json(404, { error: "not found" });
}

async function authenticate(request: Request, env: RouterEnv): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const tenantId = await env.resolveTenant(match[1].trim());
  return tenantId || null;
}

async function createDelegateRoute(
  request: Request,
  env: RouterEnv,
  tenantId: string,
): Promise<Response> {
  let body: DelegateRequest;
  try {
    body = (await request.json()) as DelegateRequest;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const res = await createDelegate(env.store, tenantId, body, env.now());
  if (!res.ok) return json(res.status, { error: res.error });
  return json(201, res.record);
}

async function listDelegates(url: URL, env: RouterEnv, tenantId: string): Promise<Response> {
  const opts: ListOptions = {};
  const status = url.searchParams.get("status");
  if (status) opts.status = status as DelegateStatus;
  const limit = parsePositiveInt(url.searchParams.get("limit"));
  if (limit !== undefined) opts.limit = limit;
  const offset = parsePositiveInt(url.searchParams.get("offset"));
  if (offset !== undefined) opts.offset = offset;

  const delegates = await env.store.list(tenantId, opts);
  return json(200, { delegates });
}

async function getDelegate(env: RouterEnv, tenantId: string, id: string): Promise<Response> {
  const rec = await env.store.get(tenantId, id);
  if (!rec) return json(404, { error: "not found" });
  return json(200, rec);
}

async function deleteDelegate(env: RouterEnv, tenantId: string, id: string): Promise<Response> {
  const res = await cancelDelegate(env.store, tenantId, id, env.now());
  if (!res.ok) return json(res.status, { error: res.error });
  return json(200, res.record);
}

function parsePositiveInt(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
