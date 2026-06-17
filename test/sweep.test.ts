import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectDueTasks, selectStuckTasks } from "../src/scheduler/sweep.ts";
import { makeRecord } from "./helpers.ts";

const NOW = 1_000;

describe("selectDueTasks", () => {
  it("picks pending tasks whose time has come", () => {
    const tasks = [
      makeRecord({ id: "due", status: "pending", scheduledAt: NOW - 1 }),
      makeRecord({ id: "exactly", status: "pending", scheduledAt: NOW }),
      makeRecord({ id: "future", status: "pending", scheduledAt: NOW + 1 }),
      makeRecord({ id: "not_pending", status: "in_round", scheduledAt: NOW - 100 }),
    ];
    assert.deepEqual(selectDueTasks(tasks, NOW).map((t) => t.id), ["due", "exactly"]);
  });
});

describe("selectStuckTasks", () => {
  const TIMEOUT = 60;
  it("picks in-flight tasks untouched past the timeout", () => {
    const tasks = [
      makeRecord({ id: "stuck_reg", status: "registering", updatedAt: NOW - TIMEOUT - 1 }),
      makeRecord({ id: "stuck_round", status: "in_round", updatedAt: NOW - TIMEOUT }),
      makeRecord({ id: "fresh", status: "in_round", updatedAt: NOW - 1 }),
      makeRecord({ id: "pending", status: "pending", updatedAt: NOW - 10_000 }),
      makeRecord({ id: "done", status: "completed", updatedAt: NOW - 10_000 }),
    ];
    assert.deepEqual(
      selectStuckTasks(tasks, NOW, TIMEOUT).map((t) => t.id),
      ["stuck_reg", "stuck_round"],
    );
  });
});
