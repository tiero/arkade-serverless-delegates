import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleRequest, type RouterDeps } from "../src/infrastructure/http-router.ts";
import { InMemoryDelegateRepository } from "../src/infrastructure/in-memory-repository.ts";
import { FixedClock, makeCreateInput } from "./helpers.ts";

const KEYS = new Map<string, string>([
  ["key-a", "t_a"],
  ["key-b", "t_b"],
]);

function makeDeps(over: Partial<RouterDeps> = {}): RouterDeps {
  return {
    repo: new InMemoryDelegateRepository(),
    clock: new FixedClock(1_000_000_000),
    resolveTenant: (token) => KEYS.get(token) ?? null,
    ...over,
  };
}

function req(method: string, path: string, opts: { token?: string; raw?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body =
    opts.raw !== undefined ? opts.raw : opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Request(`https://d.example.com${path}`, { method, headers, body });
}

describe("HTTP router", () => {
  it("serves health without auth", async () => {
    const res = await handleRequest(req("GET", "/v1/health"), makeDeps());
    assert.equal(res.status, 200);
  });

  it("401s without a valid bearer token", async () => {
    const deps = makeDeps();
    assert.equal((await handleRequest(req("GET", "/v1/delegates"), deps)).status, 401);
    assert.equal((await handleRequest(req("GET", "/v1/delegates", { token: "nope" }), deps)).status, 401);
  });

  it("rejects prototype-chain tokens and non-string tenant results (no auth bypass)", async () => {
    // Map-based resolveTenant already returns undefined for 'toString'; this also
    // proves the router rejects a non-string tenant id defensively.
    const deps = makeDeps({
      resolveTenant: (token) => (token === "evil" ? ({} as unknown as string) : (KEYS.get(token) ?? null)),
    });
    assert.equal((await handleRequest(req("GET", "/v1/delegates", { token: "toString" }), deps)).status, 401);
    assert.equal((await handleRequest(req("GET", "/v1/delegates", { token: "evil" }), deps)).status, 401);
  });

  it("creates (201), gets, and lists for the tenant", async () => {
    const deps = makeDeps();
    const create = await handleRequest(req("POST", "/v1/delegates", { token: "key-a", body: makeCreateInput() }), deps);
    assert.equal(create.status, 201);
    const rec = (await create.json()) as { id: string; status: string };
    assert.equal(rec.status, "pending");

    assert.equal((await handleRequest(req("GET", `/v1/delegates/${rec.id}`, { token: "key-a" }), deps)).status, 200);
    const list = await handleRequest(req("GET", "/v1/delegates", { token: "key-a" }), deps);
    assert.equal(((await list.json()) as { delegates: unknown[] }).delegates.length, 1);
  });

  it("maps bad input to 4xx, never 500", async () => {
    const deps = makeDeps();
    // malformed JSON
    assert.equal(
      (await handleRequest(req("POST", "/v1/delegates", { token: "key-a", raw: "{not json" }), deps)).status,
      400,
    );
    // structurally invalid hand-off (forfeit missing .input) -> 400, not a crash
    assert.equal(
      (
        await handleRequest(
          req("POST", "/v1/delegates", { token: "key-a", body: makeCreateInput({ forfeitTxs: [{ forfeitTx: "00" }] }) }),
          deps,
        )
      ).status,
      400,
    );
    // unknown status filter -> 400
    assert.equal(
      (await handleRequest(req("GET", "/v1/delegates?status=bogus", { token: "key-a" }), deps)).status,
      400,
    );
  });

  it("404s malformed/unknown ids instead of 500", async () => {
    const deps = makeDeps();
    assert.equal((await handleRequest(req("GET", "/v1/delegates/%", { token: "key-a" }), deps)).status, 404); // bad %-escape
    assert.equal((await handleRequest(req("GET", "/v1/delegates/not-an-id", { token: "key-a" }), deps)).status, 404);
  });

  it("isolates tenants: B cannot read or cancel A's task", async () => {
    const deps = makeDeps();
    const create = await handleRequest(req("POST", "/v1/delegates", { token: "key-a", body: makeCreateInput() }), deps);
    const rec = (await create.json()) as { id: string };
    assert.equal((await handleRequest(req("GET", `/v1/delegates/${rec.id}`, { token: "key-b" }), deps)).status, 404);
    assert.equal((await handleRequest(req("DELETE", `/v1/delegates/${rec.id}`, { token: "key-b" }), deps)).status, 404);
    assert.equal((await handleRequest(req("DELETE", `/v1/delegates/${rec.id}`, { token: "key-a" }), deps)).status, 200);
  });

  it("405s wrong methods and 404s unknown routes", async () => {
    const deps = makeDeps();
    assert.equal((await handleRequest(req("PUT", "/v1/delegates", { token: "key-a" }), deps)).status, 405);
    assert.equal((await handleRequest(req("GET", "/v1/nope", { token: "key-a" }), deps)).status, 404);
  });
});
