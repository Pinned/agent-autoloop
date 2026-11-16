// Guards whole-task cancellation from being sent as a run stop, wrong target identities, or false completion.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
} from "../../host/desktop-task-action-contract.ts";
import { createTaskActionSource } from "../src/task-action-source.ts";
const input = { version: 1, action: "cancelTask", taskId: 42, input: { reason: " 不再需要 " } };
test("task cancellation has a separate explicit identity and truthful status receipt", () => {
  assert.deepEqual(parseDesktopTaskActionInput(input), { ...input, input: { reason: "不再需要" } });
  for (const bad of [
    { ...input, runId: 42 },
    { ...input, taskId: undefined },
    { ...input, input: {} },
  ])
    assert.throws(() => parseDesktopTaskActionInput(bad));
  for (const status of ["cancelling", "cancelled"])
    assert.deepEqual(
      parseDesktopTaskActionResponse({ version: 1, action: "cancelTask", taskId: 42, ok: true, result: { status } }),
      { version: 1, action: "cancelTask", taskId: 42, ok: true, result: { status } },
    );
  assert.throws(() =>
    parseDesktopTaskActionResponse({
      version: 1,
      action: "cancelTask",
      taskId: 42,
      ok: true,
      result: { status: "completed" },
    }),
  );
});
test("desktop cancellation sends exactly one owner task request and does not stop a run", async () => {
  const calls: string[] = [];
  const source = createTaskActionSource({
    home: "/tmp/test",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => ({ hub: { listen: "127.0.0.1:3350" }, owner: "owner-key" }),
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(options!.method, "POST");
      assert.equal(options!.body, JSON.stringify({ reason: "不再需要" }));
      return Response.json({ status: "cancelling" });
    },
  });
  const response = await source.execute(input);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, ["http://127.0.0.1:3350/v1/tasks/42/cancel"]);
});
