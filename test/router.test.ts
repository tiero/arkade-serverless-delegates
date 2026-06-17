import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleRequest, type RouterEnv } from "../src/api/router.ts";
import { InMemoryDelegateStore } from "../src/store/memory.ts";
import { makeRequest } from "./helpers.ts";

const KEYS: Record<string, string> = { "key-a": "t_a", "key-b": "t_b" };

function makeEnv(now = 1_000_000_000): RouterEnv {
  return {
    store: new InMemoryDelegateStore(),
    resolveTenant: (token) => KEYS[token] ?? null,
    now: () => now,
  };
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`https://d.example.com${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

describe("API router", () => {
  it("serves health without auth", async () => {
    const res = await handleRequest(req("GET", "/v1/health"), makeEnv());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("401s without a valid bearer token", async () => {
    const env = makeEnv();
    assert.equal((await handleRequest(req("GET", "/v1/delegates"), env)).status, 401);
    assert.equal(
      (await handleRequest(req("GET", "/v1/delegates", { token: "nope" }), env)).status,
      401,
    );
  });

  it("creates, gets, and lists a delegate for the tenant", async () => {
    const env = makeEnv();
    const create = await handleRequest(
      req("POST", "/v1/delegates", { token: "key-a", body: makeRequest() }),
      env,
    );
    assert.equal(create.status, 201);
    const rec = (await create.json()) as { id: string; status: string };
    assert.equal(rec.status, "pending");

    const get = await handleRequest(
      req("GET", `/v1/delegates/${rec.id}`, { token: "key-a" }),
      env,
    );
    assert.equal(get.status, 200);

    const list = await handleRequest(req("GET", "/v1/delegates", { token: "key-a" }), env);
    const body = (await list.json()) as { delegates: unknown[] };
    assert.equal(body.delegates.length, 1);
  });

  it("returns 400 on invalid JSON and on invalid hand-off", async () => {
    const env = makeEnv();
    const badJson = new Request("https://d.example.com/v1/delegates", {
      method: "POST",
      headers: { authorization: "Bearer key-a" },
      body: "{not json",
    });
    assert.equal((await handleRequest(badJson, env)).status, 400);

    const badReq = await handleRequest(
      req("POST", "/v1/delegates", { token: "key-a", body: makeRequest({ fee: -1 }) }),
      env,
    );
    assert.equal(badReq.status, 400);
  });

  it("isolates tenants: B cannot read or cancel A's task", async () => {
    const env = makeEnv();
    const create = await handleRequest(
      req("POST", "/v1/delegates", { token: "key-a", body: makeRequest() }),
      env,
    );
    const rec = (await create.json()) as { id: string };

    const crossGet = await handleRequest(
      req("GET", `/v1/delegates/${rec.id}`, { token: "key-b" }),
      env,
    );
    assert.equal(crossGet.status, 404);
    const crossDel = await handleRequest(
      req("DELETE", `/v1/delegates/${rec.id}`, { token: "key-b" }),
      env,
    );
    assert.equal(crossDel.status, 404);
    // owner can cancel
    const del = await handleRequest(
      req("DELETE", `/v1/delegates/${rec.id}`, { token: "key-a" }),
      env,
    );
    assert.equal(del.status, 200);
  });

  it("405s wrong methods and 404s unknown routes", async () => {
    const env = makeEnv();
    assert.equal(
      (await handleRequest(req("PUT", "/v1/delegates", { token: "key-a" }), env)).status,
      405,
    );
    assert.equal(
      (await handleRequest(req("GET", "/v1/nope", { token: "key-a" }), env)).status,
      404,
    );
  });
});
