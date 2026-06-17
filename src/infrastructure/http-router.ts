// HTTP adapter (docs/DESIGN.md §7). Pure Request -> Response so it runs in a
// Worker and under Node's test runner. A single top-level boundary maps domain
// errors to their status and turns any unexpected throw into a clean 500 — no
// route can leak a stack or crash the isolate.

import { DomainError, ValidationError } from "../domain/errors.ts";
import {
  cancelDelegate,
  createDelegate,
  getDelegate,
  listDelegates,
} from "../application/use-cases.ts";
import type { Clock, DelegateRepository, ListOptions } from "../application/ports.ts";
import { DELEGATE_STATUSES, type DelegateStatus } from "../domain/task.ts";

export interface RouterDeps {
  repo: DelegateRepository;
  clock: Clock;
  /** map a bearer token to a tenantId, or null if unknown */
  resolveTenant(token: string): string | null | Promise<string | null>;
}

const ITEM = /^\/v1\/delegates\/([^/]+)$/;
const ID_RE = /^del_[0-9a-f]{24}$/;
const STATUS_SET = new Set<string>(DELEGATE_STATUSES);

export async function handleRequest(request: Request, deps: RouterDeps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (e) {
    if (e instanceof DomainError) return json(e.httpStatus, { error: e.message });
    return json(500, { error: "internal error" });
  }
}

async function route(request: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/v1/health" && method === "GET") return json(200, { status: "ok" });

  const tenantId = await authenticate(request, deps);
  if (!tenantId) return json(401, { error: "unauthorized" });

  if (path === "/v1/delegates") {
    if (method === "GET") return await listRoute(url, deps, tenantId);
    if (method === "POST") return await createRoute(request, deps, tenantId);
    return json(405, { error: "method not allowed" });
  }

  const m = ITEM.exec(path);
  if (m) {
    const id = safeDecodeId(m[1]);
    if (id === null) return json(404, { error: "not found" }); // malformed/invalid id shape
    if (method === "GET") return json(200, await getDelegate(deps.repo, tenantId, id));
    if (method === "DELETE") return json(200, await cancelDelegate(deps.repo, deps.clock, tenantId, id));
    return json(405, { error: "method not allowed" });
  }

  return json(404, { error: "not found" });
}

async function authenticate(request: Request, deps: RouterDeps): Promise<string | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const tenantId = await deps.resolveTenant(m[1].trim());
  // Guard against non-string results (e.g. prototype-chain lookups returning a
  // function); only a real, non-empty tenant id authenticates.
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
}

async function createRoute(request: Request, deps: RouterDeps, tenantId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("invalid JSON body");
  }
  const state = await createDelegate(deps.repo, deps.clock, tenantId, body as never);
  return json(201, state);
}

async function listRoute(url: URL, deps: RouterDeps, tenantId: string): Promise<Response> {
  const opts: ListOptions = {};
  const status = url.searchParams.get("status");
  if (status) {
    if (!STATUS_SET.has(status)) throw new ValidationError(`unknown status: ${status}`);
    opts.status = status as DelegateStatus;
  }
  const limit = parsePositiveInt(url.searchParams.get("limit"));
  if (limit !== undefined) opts.limit = limit;
  const offset = parsePositiveInt(url.searchParams.get("offset"));
  if (offset !== undefined) opts.offset = offset;
  return json(200, { delegates: await listDelegates(deps.repo, tenantId, opts) });
}

function safeDecodeId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }
  return ID_RE.test(id) ? id : null;
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
