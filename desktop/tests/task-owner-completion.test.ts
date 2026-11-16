// Guards owner completion from run routing, permissive receipts, hidden reasons, and accidental extra writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
} from "../../host/desktop-task-action-contract.ts";
import { createTaskActionSource } from "../src/task-action-source.ts";
test("completion rejection accepts only known fixed reasons and keeps untrusted errors out of the renderer", async () => {
  for (const error of ["<script>owner-key</script>", "任务还有未收尾的卡片，不能确认完成 owner-key"]) {
    const source = createTaskActionSource({
      home: "/tmp/test",
      getState: () => ({ status: "running", role: "hub-worker" }),
      readConfig: () => ({ hub: { listen: "127.0.0.1:3350" }, owner: "owner-key" }),
      fetchImpl: async () => Response.json({ error }, { status: 409 }),
    });
    const response = await source.execute(input);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "rejected");
    assert.equal(JSON.stringify(response).includes("owner-key"), false);
  }
});

const input = { version: 1, action: "completeTask", taskId: 42, input: { reason: " 已验收 " } };
test("owner completion requires a task identity and a completed receipt", () => {
  assert.deepEqual(parseDesktopTaskActionInput(input), { ...input, input: { reason: "已验收" } });
  for (const bad of [
    { ...input, runId: 42 },
    { ...input, input: {} },
    { ...input, input: { reason: " " } },
  ])
    assert.throws(() => parseDesktopTaskActionInput(bad));
  assert.equal(
    parseDesktopTaskActionResponse({
      version: 1,
      ok: true,
      action: "completeTask",
      taskId: 42,
      result: { status: "completed" },
    }).ok,
    true,
  );
  assert.throws(() =>
    parseDesktopTaskActionResponse({
      version: 1,
      ok: true,
      action: "completeTask",
      taskId: 42,
      result: { status: "cancelled" },
    }),
  );
});
test("owner completion sends only the explicit task operation and preserves known rejection reasons", async () => {
  const calls: string[] = [];
  let rejected = false;
  const source = createTaskActionSource({
    home: "/tmp/test",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => ({ hub: { listen: "127.0.0.1:3350" }, owner: "owner-key" }),
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(options!.body, JSON.stringify({ reason: "已验收" }));
      assert.equal(new Headers(options!.headers).get("authorization"), "Bearer owner-key");
      return rejected
        ? Response.json({ error: "任务还有未收尾的卡片，不能确认完成" }, { status: 409 })
        : Response.json({ status: "completed" });
    },
  });
  assert.equal((await source.execute(input)).ok, true);
  rejected = true;
  const response = await source.execute(input);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.message, "任务还有未收尾的卡片，不能确认完成");
  assert.deepEqual(calls, Array(2).fill("http://127.0.0.1:3350/v1/tasks/42/complete"));
});
