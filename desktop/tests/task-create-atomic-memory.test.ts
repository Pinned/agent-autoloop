// Prevent stale task permission, false non-ingestion claims, and hidden-dialog duplicate submission.
// Only in-memory injections: no business files, network, processes, timers, or cleanup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimePresentation } from "../src/runtime-presentation.ts";
import { createTaskCreateHandler } from "../src/task-create-control.ts";
import { createTaskSource } from "../src/task-source.ts";
import { createRendererTask, type TaskBridge } from "../src/renderer/task-controller.ts";
import { parseLifecycleTaskReceipt } from "../src/lifecycle-drive.ts";
import { DESKTOP_TASK_MESSAGES, type DesktopTaskOutcome } from "../../host/desktop-task-contract.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const input = { type: "task.ops", summary: "目标", detail: "详情" };
const ack = { event: 1, duplicate: false, routed: ["值班规则"] };
const accepted = (): DesktopTaskOutcome => ({
  version: 3,
  outcome: "accepted",
  receipt: { version: 2, ok: true, result: { ...ack, routed: [...ack.routed] } },
});
const refusal = (outcome: "not-sent" | "uncertain" | "rejected"): DesktopTaskOutcome => ({
  version: 3,
  outcome,
  message: DESKTOP_TASK_MESSAGES[outcome],
});
function presentationFixture() {
  const state = {
    status: "running" as "running" | "stopped",
    role: "hub-worker" as "hub-worker" | null,
    ownership: "owned" as const,
    pendingSync: 0,
    error: null,
  };
  const gates = {
    phase: "idle" as "idle" | "confirming" | "preparing" | "quitting",
    busy: false,
    blocked: false,
    quitting: false,
  };
  let readHook = () => {};
  const presentation = createRuntimePresentation({
    page: "file:///trusted",
    read: () => {
      readHook();
      return state;
    },
    gates: () => gates,
    send: () => {},
    refresh: () => {},
    report: () => {},
  });
  presentation.finishDocument(presentation.beginDocument(), "file:///trusted");
  return {
    presentation,
    state,
    gates,
    setReadHook: (hook: () => void) => {
      readHook = hook;
    },
  };
}
function sourceFixture(extra: Record<string, unknown> = {}) {
  const f = presentationFixture();
  let calls = 0;
  const response = deferred<Response>();
  const source = createTaskSource({
    home: "unused",
    getState: () => f.state,
    readConfig: () => ({ hub: { listen: "127.0.0.1:8080" }, owner: "private-owner" }),
    createSignal: () => new AbortController().signal,
    fetchImpl: () => {
      calls++;
      return response.promise;
    },
    ...extra,
  });
  const handler = createTaskCreateHandler({
    assertSender: (event: unknown) => {
      if (event !== "trusted") throw new Error("sender");
    },
    presentation: f.presentation,
    create: (value, canSend) => source.create(value, canSend),
  });
  return { ...f, source, handler, response, calls: () => calls };
}
const http = (ok: boolean, payload: unknown): Response => ({ ok, json: async () => payload }) as Response;
function rendererFixture(gate: () => boolean = () => true) {
  let calls = 0;
  const reply = deferred<DesktopTaskOutcome>();
  let notify = () => {};
  const bridge: TaskBridge = {
    taskEntries: async () => ({
      version: 2,
      ok: true,
      data: { entries: [{ name: "值班规则", types: ["task.ops"], to: "worker" }] },
    }),
    taskCreate: () => {
      calls++;
      return reply.promise;
    },
  };
  const controller = createRendererTask(bridge, () => notify(), gate);
  return {
    controller,
    reply,
    bridge,
    calls: () => calls,
    setNotify: (fn: () => void) => {
      notify = fn;
    },
  };
}

test("ordinary valid pushes retain a lease; release never permits reuse", () => {
  const f = presentationFixture();
  const lease = f.presentation.acquireTaskLease()!;
  f.state.pendingSync = 8;
  f.presentation.changed();
  f.presentation.publish();
  assert.equal(f.presentation.checkTaskLease(lease), true);
  f.presentation.releaseTaskLease(lease);
  assert.equal(f.presentation.checkTaskLease(lease), false);
});
test("document ABA permanently revokes a lease", () => {
  const f = presentationFixture();
  const old = f.presentation.acquireTaskLease()!;
  const doc = f.presentation.beginDocument();
  f.presentation.finishDocument(doc, "file:///trusted");
  assert.equal(f.presentation.checkTaskLease(old), false);
  assert.ok(f.presentation.acquireTaskLease());
});
test("quit and setup gate ABA permanently revoke leases", () => {
  const f = presentationFixture();
  for (const boundary of ["confirming", "preparing", "quitting", "busy", "blocked", "setup-quitting"] as const) {
    const lease = f.presentation.acquireTaskLease()!;
    if (boundary === "busy") f.gates.busy = true;
    else if (boundary === "blocked") f.gates.blocked = true;
    else if (boundary === "setup-quitting") f.gates.quitting = true;
    else f.gates.phase = boundary;
    f.presentation.changed();
    f.gates.phase = "idle";
    f.gates.busy = false;
    f.gates.blocked = false;
    f.gates.quitting = false;
    f.presentation.changed();
    assert.equal(f.presentation.checkTaskLease(lease), false, boundary);
  }
});
test("runtime and role ABA permanently revoke leases", () => {
  const f = presentationFixture();
  const lease = f.presentation.acquireTaskLease()!;
  f.state.status = "stopped";
  f.presentation.changed();
  f.state.status = "running";
  f.presentation.changed();
  assert.equal(f.presentation.checkTaskLease(lease), false);
  const second = f.presentation.acquireTaskLease()!;
  f.state.role = null;
  f.presentation.changed();
  f.state.role = "hub-worker";
  f.presentation.changed();
  assert.equal(f.presentation.checkTaskLease(second), false);
});
test("run revokes before synchronous intent while preserving receipt semantics", async () => {
  const f = presentationFixture();
  const lease = f.presentation.acquireTaskLease()!;
  const receipt = await f.presentation.run("stop", () => {
    assert.equal(f.presentation.checkTaskLease(lease), false);
    return f.state;
  });
  assert.equal(receipt.ok, true);
  assert.equal(f.presentation.checkTaskLease(lease), false);
});
test("setup observe revokes before callback and never restores old lease", async () => {
  const f = presentationFixture();
  const lease = f.presentation.acquireTaskLease()!;
  const expected = {};
  assert.equal(
    await f.presentation.observe(() => {
      assert.equal(f.presentation.checkTaskLease(lease), false);
      return expected;
    }),
    expected,
  );
  assert.equal(f.presentation.checkTaskLease(lease), false);
});
test("reentrant read fails closed without recursive observer calls", () => {
  const f = presentationFixture();
  const old = f.presentation.acquireTaskLease()!;
  let entered = false;
  f.setReadHook(() => {
    if (!entered) {
      entered = true;
      f.presentation.invalidateDocument();
    }
  });
  assert.equal(f.presentation.checkTaskLease(old), false);
  assert.equal(f.presentation.acquireTaskLease(), undefined);
});
test("sender and v3 request validated before source; one main flight at a time", async () => {
  const f = sourceFixture();
  await assert.rejects(f.handler("bad", { version: 3, input }), /sender/);
  await assert.rejects(f.handler("trusted", input));
  await assert.rejects(f.handler("trusted", { version: 3, input }, 1));
  const first = f.handler("trusted", { version: 3, input });
  assert.equal((await f.handler("trusted", { version: 3, input })).outcome, "not-sent");
  await flush();
  assert.equal(f.calls(), 1);
  f.response.resolve(http(true, ack));
  assert.equal((await first).outcome, "accepted");
});
test("configuration accessor boundary ABA prevents any POST", async () => {
  const f = sourceFixture();
  const source = createTaskSource({
    home: "unused",
    getState: () => f.state,
    readConfig: () => {
      f.presentation.invalidateDocument();
      f.presentation.finishDocument(f.presentation.beginDocument(), "file:///trusted");
      return { hub: { listen: "127.0.0.1:8080" }, owner: "owner" };
    },
    createSignal: () => new AbortController().signal,
    fetchImpl: () => {
      throw new Error("must not send");
    },
  });
  const handler = createTaskCreateHandler({
    assertSender: () => {},
    presentation: f.presentation,
    create: (value, canSend) => source.create(value, canSend),
  });
  assert.equal((await handler({}, { version: 3, input })).outcome, "not-sent");
});
test("queued boundary before final dispatch prevents POST", async () => {
  const f = sourceFixture();
  const flight = f.handler("trusted", { version: 3, input });
  f.gates.phase = "confirming";
  f.presentation.changed();
  f.gates.phase = "idle";
  f.presentation.changed();
  assert.equal((await flight).outcome, "not-sent");
  assert.equal(f.calls(), 0);
});
test("ACK after stop/quit/document ABA remains accepted historical fact", async () => {
  const f = sourceFixture();
  const flight = f.handler("trusted", { version: 3, input });
  await flush();
  assert.equal(f.calls(), 1);
  await f.presentation.run("stop", () => f.state);
  f.gates.phase = "quitting";
  f.presentation.changed();
  f.presentation.invalidateDocument();
  f.gates.phase = "idle";
  f.presentation.finishDocument(f.presentation.beginDocument(), "file:///trusted");
  f.response.resolve(http(true, ack));
  assert.equal((await flight).outcome, "accepted");
});
test("entering fetch throw, HTTP refusal, body failure and damaged ACK are uncertain", async () => {
  const implementations = [
    () => {
      throw new Error("fetch entered");
    },
    async () => http(false, { error: "do not retry" }),
    async () =>
      ({
        ok: true,
        json: async () => {
          throw new Error("body");
        },
      }) as unknown as Response,
    async () => http(true, { ...ack, extra: "private" }),
    async () => http(true, Object.defineProperty({ ...ack }, "hidden", { value: 1 })),
  ];
  for (const fetchImpl of implementations) {
    const f = sourceFixture({ fetchImpl });
    assert.equal((await f.handler("trusted", { version: 3, input })).outcome, "uncertain");
  }
});
test("configuration/signal failure and closed qualification are not-sent", async () => {
  for (const extra of [
    {
      readConfig: () => {
        throw new Error("config");
      },
    },
    {
      createSignal: () => {
        throw new Error("signal");
      },
    },
  ]) {
    const f = sourceFixture(extra);
    assert.equal((await f.handler("trusted", { version: 3, input })).outcome, "not-sent");
    assert.equal(f.calls(), 0);
  }
  const f = sourceFixture();
  f.gates.busy = true;
  assert.equal((await f.handler("trusted", { version: 3, input })).outcome, "not-sent");
});
test("renderer pending and uncertain retain frozen operation, no reset or resend", async () => {
  const f = rendererFixture();
  const draft = { entry: "值班规则", pattern: "task.ops", concrete: "", summary: "目标", detail: "详情" };
  f.controller.submitTask(input, draft);
  const operation = f.controller.operation!;
  draft.entry = "changed";
  assert.equal(operation.draft.entry, "值班规则");
  assert.equal(Object.isFrozen(operation.input), true);
  f.controller.reset();
  f.controller.submitTask(input);
  assert.equal(f.calls(), 1);
  f.reply.resolve(refusal("uncertain"));
  await flush();
  f.controller.reset();
  f.controller.submitTask(input);
  assert.equal(f.controller.operation, operation);
  assert.equal(f.calls(), 1);
  assert.equal(f.controller.canBeginAnother, false);
});
test("renderer old v2/rejected promise never proves non-ingestion", async () => {
  for (const fail of [false, true]) {
    const f = rendererFixture();
    f.controller.submitTask(input);
    if (fail) f.reply.reject(new Error("ipc"));
    else f.reply.resolve({ version: 2, ok: true, result: ack } as never);
    await flush();
    assert.equal(f.controller.submitState.kind, "uncertain");
  }
});
test("renderer accepted after gate closes preserves result but cannot begin another", async () => {
  let eligible = true;
  const f = rendererFixture(() => eligible);
  f.controller.submitTask(input);
  eligible = false;
  f.controller.gateChanged();
  f.reply.resolve(accepted());
  await flush();
  assert.equal(f.controller.submitState.kind, "done");
  assert.equal(f.controller.canBeginAnother, false);
  f.controller.reset();
  assert.ok(f.controller.operation);
  eligible = true;
  f.controller.reset();
  assert.equal(f.controller.operation, null);
});
test("notify reentrant gate change stops bridge dispatch", () => {
  let eligible = true;
  const f = rendererFixture(() => eligible);
  f.setNotify(() => {
    eligible = false;
  });
  f.controller.submitTask(input);
  assert.equal(f.calls(), 0);
  assert.equal(f.controller.submitState.kind, "not-sent");
});
test("reset reentrant gate cannot clear current or newer operation", async () => {
  let reenter = () => {};
  const f = rendererFixture(() => {
    reenter();
    return true;
  });
  f.controller.submitTask(input);
  f.reply.resolve(accepted());
  await flush();
  const old = f.controller.operation;
  let entered = false;
  reenter = () => {
    if (!entered) {
      entered = true;
      f.controller.gateChanged();
      f.controller.reset();
      f.controller.submitTask(input);
    }
  };
  f.controller.reset();
  assert.equal(f.controller.operation, old);
  assert.equal(f.calls(), 1);
  reenter = () => {};
  f.setNotify(() => {
    if (!f.controller.operation) f.controller.submitTask(input);
  });
  f.controller.reset();
  assert.ok(f.controller.operation);
  assert.equal(f.controller.submitState.kind, "busy");
  assert.equal(f.calls(), 2);
});
test("real renderer-to-handler-to-source chain sends once and receives v3 accepted", async () => {
  const f = sourceFixture();
  const renderer = createRendererTask(
    {
      taskEntries: async () => ({ version: 2, ok: true, data: { entries: [] } }),
      taskCreate: (value) => f.handler("trusted", { version: 3, input: value }),
    },
    () => {},
    () => true,
  );
  renderer.submitTask(input);
  renderer.submitTask(input);
  await flush();
  assert.equal(f.calls(), 1);
  f.response.resolve(http(true, ack));
  await flush();
  assert.equal(renderer.submitState.kind, "done");
  assert.equal(renderer.canSubmit, false);
});
test("handler cleanup exceptions cannot rewrite accepted and next flight is independent", async () => {
  const f = presentationFixture();
  let calls = 0;
  const handler = createTaskCreateHandler({
    assertSender: () => {},
    presentation: {
      acquireTaskLease: () => f.presentation.acquireTaskLease(),
      checkTaskLease: (value) => f.presentation.checkTaskLease(value),
      releaseTaskLease: (value) => {
        f.presentation.releaseTaskLease(value);
        throw new Error("observer");
      },
    },
    create: async () => {
      calls++;
      return accepted();
    },
  });
  assert.equal((await handler({}, { version: 3, input })).outcome, "accepted");
  assert.equal((await handler({}, { version: 3, input })).outcome, "accepted");
  assert.equal(calls, 2);
});
test("late release of revoked lease cannot revoke a new document lease", () => {
  const f = presentationFixture();
  const old = f.presentation.acquireTaskLease()!;
  f.presentation.finishDocument(f.presentation.beginDocument(), "file:///trusted");
  const current = f.presentation.acquireTaskLease()!;
  f.presentation.releaseTaskLease(old);
  assert.equal(f.presentation.checkTaskLease(current), true);
});
test("lifecycle production outcome consumer accepts only strict accepted", () => {
  assert.deepEqual(parseLifecycleTaskReceipt(accepted()), ack);
  for (const value of [
    refusal("not-sent"),
    refusal("uncertain"),
    { version: 2, ok: true, result: ack },
    { ...accepted(), extra: 1 },
  ])
    assert.throws(() => parseLifecycleTaskReceipt(value));
});
