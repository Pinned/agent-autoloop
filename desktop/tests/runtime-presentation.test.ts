// Failure mode: late operation receipts reopen presentation gates, or old finally/push work overwrites a newer operation/document.
// Exercise the production settlement wrapper with memory callbacks only; never import main or Electron.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimePresentation, RUNTIME_PRESENTATION_DIAGNOSTIC } from "../src/runtime-presentation.ts";
import { desktopRuntimeSnapshotOf, desktopRuntimeStatusText, DESKTOP_RUNTIME_ERROR_MESSAGES, type DesktopRuntimeEvent } from "../../host/desktop-run-contract.ts";
import { createRendererRun } from "../src/renderer/run-controller.ts";
import { createSetupControl } from "../src/setup-control.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let state = desktopRuntimeSnapshotOf({
    status: "stopped",
    role: "worker",
    ownership: "owned",
    pendingSync: 3,
    error: null,
  });
  const gates = { phase: "idle" as "idle" | "confirming" | "preparing" | "quitting", busy: false, blocked: false, quitting: false };
  const events: DesktopRuntimeEvent[] = [];
  const diagnostics: string[] = [];
  const hooks = { read: () => {}, gates: () => {}, send: (_event: DesktopRuntimeEvent) => {}, refresh: () => {}, report: (_message: string) => {} };
  const control = createRuntimePresentation({
    page: "file:///trusted/index.html",
    read: () => { hooks.read(); return state; },
    gates: () => { hooks.gates(); return gates; },
    send: (event) => { hooks.send(event); events.push(event); },
    refresh: () => hooks.refresh(),
    report: (message) => { diagnostics.push(message); hooks.report(message); },
  });
  const document = control.beginDocument();
  assert.equal(control.finishDocument(document, "file:///trusted/index.html"), true);
  events.length = 0;
  return { control, gates, events, diagnostics, hooks, setState: (next: typeof state) => { state = next; }, state: () => state };
}

test("run releases its token after callback settlement and publishes even unchanged status/role", async () => {
  const f = fixture();
  const d = deferred<ReturnType<typeof f.state>>();
  const run = f.control.run("stop", () => { f.gates.busy = true; return d.promise.finally(() => { f.gates.busy = false; }); });
  assert.equal(f.control.snapshot().status, "draining");
  f.setState({ ...f.state(), pendingSync: 8 });
  d.resolve(f.state());
  const receipt = await run;
  assert.equal(receipt.ok, true);
  if (receipt.ok) assert.equal(receipt.state.pendingSync, 8);
  assert.deepEqual(f.events.at(-1)?.state, f.state());
});

test("overlapping start/stop releases only this operation; both completion orders preserve the remaining fence", async () => {
  for (const first of ["start", "stop"] as const) {
    const f = fixture();
    const start = deferred<ReturnType<typeof f.state>>();
    const stop = deferred<ReturnType<typeof f.state>>();
    const a = f.control.run("start", () => start.promise);
    const b = f.control.run("stop", () => stop.promise);
    (first === "start" ? start : stop).resolve(f.state());
    await (first === "start" ? a : b);
    assert.equal(f.events.at(-1)?.state.status, first === "start" ? "draining" : "starting");
    assert.equal(f.events.at(-1)?.state.role, null);
    const unsafe = { ...f.state(), status: "unknown" as const, error: { code: "safe-stop" as const, message: DESKTOP_RUNTIME_ERROR_MESSAGES["safe-stop"] } };
    f.setState(unsafe);
    (first === "start" ? stop : start).resolve(unsafe);
    await (first === "start" ? b : a);
    assert.deepEqual(f.events.at(-1)?.state, unsafe);
  }
});

test("all exit phases fence admission and final push; cancellation restores only current state", async () => {
  for (const phase of ["confirming", "preparing", "quitting"] as const) {
    const f = fixture(); const d = deferred<ReturnType<typeof f.state>>();
    const run = f.control.run("start", () => d.promise);
    f.gates.phase = phase; f.control.publish();
    let called = false;
    assert.equal((await f.control.run("stop", () => { called = true; return f.state(); })).ok, false);
    assert.equal(called, false);
    d.resolve(f.state()); await run;
    assert.equal(f.events.at(-1)?.state.status, "unavailable");
    assert.equal(f.events.at(-1)?.state.pendingSync, 3);
    // A closed control plane is not a missing runtime: the quit dialog must not blame resources.
    assert.doesNotMatch(desktopRuntimeStatusText(f.control.snapshot()), /资源|无法启动/);
    f.gates.phase = "idle"; f.control.publish();
    assert.deepEqual(f.events.at(-1)?.state, f.state());
  }
});

test("setup busy/blocked/quitting fence both actions; own start busy still permits immediate stop", async () => {
  for (const gate of ["busy", "blocked", "quitting"] as const) {
    const f = fixture(); f.gates[gate] = true;
    assert.equal(f.control.snapshot().status, "unavailable");
    for (const operation of ["start", "stop"] as const) {
      let called = false;
      assert.equal((await f.control.run(operation, () => { called = true; return f.state(); })).ok, false);
      assert.equal(called, false);
    }
  }
  const f = fixture(); const d = deferred<ReturnType<typeof f.state>>();
  const a = f.control.run("start", () => { f.gates.busy = true; return d.promise.finally(() => { f.gates.busy = false; }); });
  let stopped = false;
  const b = f.control.run("stop", () => { stopped = true; return f.state(); });
  assert.equal(stopped, true); await b;
  assert.equal(f.control.snapshot().status, "starting");
  d.resolve(f.state()); await a;
});

test("document generations reject old or untrusted completion and late receipts cannot restore them", async () => {
  const f = fixture(); const d = deferred<ReturnType<typeof f.state>>();
  const run = f.control.run("start", () => d.promise);
  const old = f.control.beginDocument();
  const sentBeforeInvalid = f.events.length;
  const current = f.control.beginDocument();
  assert.equal(f.control.finishDocument(old, "file:///trusted/index.html"), false);
  assert.equal(f.control.finishDocument(current, "file:///untrusted/index.html"), false);
  d.resolve(f.state()); assert.equal((await run).ok, true);
  assert.equal(f.control.snapshot().status, "unavailable");
  assert.equal(f.events.length, sentBeforeInvalid);
  f.control.invalidateDocument();
  assert.equal(f.control.finishDocument(current, "file:///trusted/index.html"), false);
  const next = f.control.beginDocument();
  assert.equal(f.control.finishDocument(next, "file:///trusted/index.html"), true);
  assert.deepEqual(f.control.snapshot(), f.state());
});

test("invalid document refuses start and stop without invoking business callbacks", async () => {
  const f = fixture(); f.control.invalidateDocument();
  for (const op of ["start", "stop"] as const) {
    let called = false;
    const response = await f.control.run(op, () => { called = true; return f.state(); });
    assert.equal(response.ok, false); assert.equal(called, false);
  }
});

test("send, menu and diagnostic exceptions never rewrite a confirmed receipt; diagnostic is fixed and once", async () => {
  const f = fixture();
  f.hooks.send = () => { throw new Error("private-token"); };
  f.hooks.refresh = () => { throw new Error("private-home"); };
  f.hooks.report = () => { throw new Error("private-log"); };
  for (const op of ["start", "stop"] as const) {
    const response = await f.control.run(op, () => f.state());
    assert.deepEqual(response, { version: 1, ok: true, state: f.state() });
  }
  assert.deepEqual(f.diagnostics, [RUNTIME_PRESENTATION_DIAGNOSTIC]);
  assert.doesNotMatch(f.diagnostics.join(""), /private/);
});

test("callback throws or rejects release fences, report unknown and preserve safe final presentation", async () => {
  for (const callback of [() => { throw new Error("private"); }, () => Promise.reject(new Error("private"))]) {
    const f = fixture();
    assert.equal((await f.control.run("start", callback)).ok, false);
    assert.deepEqual(f.control.snapshot(), f.state());
    assert.deepEqual(f.events.at(-1)?.state, f.state());
  }
});

test("menu synchronous reentry may reserve stop; old start finally cannot release that stop", async () => {
  const f = fixture(); const a = deferred<ReturnType<typeof f.state>>(); const b = deferred<ReturnType<typeof f.state>>();
  let stop: ReturnType<typeof f.control.run> | undefined;
  f.hooks.refresh = () => { f.hooks.refresh = () => {}; stop = f.control.run("stop", () => b.promise); };
  const start = f.control.run("start", () => a.promise);
  a.resolve(f.state()); await start;
  assert.equal(f.control.snapshot().status, "draining");
  b.resolve(f.state()); await stop;
  assert.deepEqual(f.control.snapshot(), f.state());
});

test("generation or sender reentry invalidating a document pauses sends until a trusted new document", () => {
  for (const hook of ["read", "send"] as const) {
    const f = fixture();
    f.hooks[hook] = () => { f.hooks[hook] = () => {}; f.control.invalidateDocument(); };
    f.control.publish();
    // A send already entered cannot be retracted; no subsequent sends may target the invalid document.
    assert.equal(f.events.length, hook === "send" ? 1 : 0);
    const count = f.events.length;
    f.control.publish();
    assert.equal(f.events.length, count);
    assert.equal(f.control.snapshot().status, "unavailable");
    const token = f.control.beginDocument();
    f.control.finishDocument(token, "file:///trusted/index.html");
    assert.equal(f.events.length, count + 1);
    assert.deepEqual(f.events.at(-1)?.state, f.state());
  }
});

test("sync business callback executes once before presentation observers can reenter", async () => {
  const f = fixture(); const order: string[] = [];
  f.hooks.refresh = () => { order.push("refresh"); };
  const response = await f.control.run("start", () => { order.push("callback"); return f.state(); });
  assert.equal(response.ok, true); assert.equal(order[0], "callback");
  assert.equal(order.filter((item) => item === "callback").length, 1);
});

test("admission reentry invalidating the document refuses the callback", async () => {
  const f = fixture();
  f.hooks.gates = () => { f.hooks.gates = () => {}; f.control.invalidateDocument(); };
  let called = false;
  const response = await f.control.run("start", () => { called = true; return f.state(); });
  assert.equal(response.ok, false);
  assert.equal(called, false);
});

test("hostile repeating sender is bounded and reports only the fixed diagnostic", () => {
  const f = fixture(); let sends = 0;
  f.hooks.send = () => { sends++; f.control.publish(); };
  f.control.publish();
  assert.equal(sends, 8);
  assert.deepEqual(f.diagnostics, [RUNTIME_PRESENTATION_DIAGNOSTIC]);
  f.hooks.send = () => {};
  const count = f.events.length;
  f.control.invalidateDocument();
  assert.equal(f.events.length, count);
  assert.equal(f.control.snapshot().status, "unavailable");
});

test("tray start presentation reaches the real renderer view and its stop path interrupts start", async () => {
  const { mountRunCard } = await import("../src/renderer/run-view.ts");
  class Node {
    textContent = ""; className = ""; hidden = false; disabled = false; id = ""; type = "";
    dataset: Record<string, string> = {}; children: Node[] = []; click: (() => void) | undefined;
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute() {}
    addEventListener(_name: string, callback: () => void) { this.click = callback; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Node() } });
  try {
    const f = fixture(); const start = deferred<ReturnType<typeof f.state>>(); const stop = deferred<ReturnType<typeof f.state>>();
    let listener: ((event: DesktopRuntimeEvent) => void) | undefined;
    let stopCalls = 0; let stopFlight: ReturnType<typeof f.control.run> | undefined;
    let view: { update(): void } | undefined;
    const renderer = createRendererRun({
      runtimeGet: async () => ({ version: 1, ok: true, state: f.control.snapshot() }),
      runtimeStart: () => { throw new Error("not renderer initiated"); },
      runtimeStop: () => { stopCalls++; return (stopFlight = f.control.run("stop", () => stop.promise)); },
      onRuntimeEvent: (callback) => { listener = callback; return () => { listener = undefined; }; },
    }, () => ({ setupLocked: false, setupBusy: false }), () => view?.update());
    f.hooks.send = (event) => listener?.(event);
    f.control.publish();
    const root = new Node();
    view = mountRunCard(root as unknown as HTMLElement, renderer, () => {}, { setupBusy: () => false, setupLocked: () => false });
    const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
    const stopButton = nodes(root).find((node) => node.textContent === "停止本机运行服务")!;
    const run = f.control.run("start", () => { f.gates.busy = true; return start.promise.finally(() => { f.gates.busy = false; }); });
    assert.equal(renderer.state.kind, "ready");
    if (renderer.state.kind !== "ready") throw new Error("expected ready");
    assert.equal(renderer.state.snapshot.status, "starting");
    assert.equal(renderer.state.snapshot.role, null);
    assert.equal(stopButton.disabled, false);
    stopButton.click!();
    assert.equal(stopCalls, 1);
    assert.equal(f.control.snapshot().status, "draining");
    start.resolve(f.state()); await run;
    assert.equal(f.control.snapshot().status, "draining");
    stop.resolve(f.state()); await stopFlight;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(renderer.busy, false);
    assert.equal(renderer.state.kind, "ready");
    if (renderer.state.kind === "ready") assert.deepEqual(renderer.state.snapshot, f.state());
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("observed real setup read clears busy before its final push restores the real renderer", async () => {
  const f = fixture(); const pending = deferred<{ version: 1; ok: true; operation: "status"; data: { configuration: "unconfigured"; role: null } }>();
  const setup = createSetupControl({ canSetup: () => true, run: () => pending.promise });
  f.hooks.gates = () => { f.gates.busy = setup.busy; f.gates.blocked = setup.blocked; f.gates.quitting = setup.quitting; };
  let listener: ((event: DesktopRuntimeEvent) => void) | undefined;
  const renderer = createRendererRun({
    runtimeGet: async () => ({ version: 1, ok: true, state: f.control.snapshot() }),
    runtimeStart: async () => { throw new Error("unexpected start"); },
    runtimeStop: async () => { throw new Error("unexpected stop"); },
    onRuntimeEvent: (callback) => { listener = callback; return () => { listener = undefined; }; },
  }, () => ({ setupLocked: false, setupBusy: false }), () => {});
  const read = f.control.observe(() => setup.runSetup({ version: 1, operation: "status" }));
  f.hooks.send = (event) => listener?.(event);
  renderer.init();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(renderer.state.kind, "ready");
  if (renderer.state.kind === "ready") assert.equal(renderer.state.snapshot.status, "unavailable");
  const receipt = { version: 1 as const, ok: true as const, operation: "status" as const, data: { configuration: "unconfigured" as const, role: null } };
  pending.resolve(receipt);
  assert.deepEqual(await read, receipt);
  assert.equal(setup.busy, false);
  assert.equal(renderer.state.kind, "ready");
  if (renderer.state.kind === "ready") assert.deepEqual(renderer.state.snapshot, f.control.snapshot());
  assert.equal(setup.blocked, false);
  assert.equal(f.events.at(-1)?.state.status, "stopped");
});

test("observe preserves receipt identity and rejection including synchronous throws despite observer exceptions", async () => {
  const f = fixture(); const receipt = Object.freeze({ ok: true, marker: "confirmed" });
  f.hooks.refresh = () => { throw new Error("private-menu"); };
  f.hooks.send = () => { throw new Error("private-send"); };
  f.hooks.report = () => { throw new Error("private-log"); };
  assert.equal(await f.control.observe(() => receipt), receipt);
  for (const callback of [() => { throw receipt; }, () => Promise.reject(receipt)]) {
    await assert.rejects(f.control.observe(callback), (error) => error === receipt);
  }
  assert.deepEqual(f.diagnostics, [RUNTIME_PRESENTATION_DIAGNOSTIC]);
});

test("old observed read settlement cannot clear a newer read or invalid document gate", async () => {
  const f = fixture(); const a = deferred<string>(); const b = deferred<string>();
  let reads = 0;
  const reader = (pending: ReturnType<typeof deferred<string>>) => f.control.observe(() => {
    reads++; f.gates.busy = true;
    return pending.promise.finally(() => { reads--; f.gates.busy = reads > 0; });
  });
  const first = reader(a); const second = reader(b);
  a.resolve("first"); assert.equal(await first, "first");
  assert.equal(f.control.snapshot().status, "unavailable");
  const count = f.events.length; f.control.invalidateDocument();
  b.resolve("second"); assert.equal(await second, "second");
  assert.equal(f.events.length, count);
  assert.equal(f.control.snapshot().status, "unavailable");
  const token = f.control.beginDocument(); f.control.finishDocument(token, "file:///trusted/index.html");
  assert.deepEqual(f.events.at(-1)?.state, f.state());
});

test("hard gates override runtime transitions without losing pendingSync/error", async () => {
  for (const gate of ["blocked", "quitting"] as const) {
    const f = fixture(); const pending = deferred<ReturnType<typeof f.state>>();
    const run = f.control.run("start", () => pending.promise);
    f.gates[gate] = true; f.control.publish();
    assert.equal(f.control.snapshot().status, "unavailable");
    assert.equal(f.control.snapshot().role, null);
    assert.equal(f.control.snapshot().pendingSync, 3);
    pending.resolve(f.state()); await run;
    assert.equal(f.control.snapshot().status, "unavailable");
  }
});

test("raw state read failure is contained by push and does not rewrite callback-confirmed receipt", async () => {
  const f = fixture(); const state = f.state();
  f.hooks.read = () => { throw new Error("private-state"); };
  const response = await f.control.run("start", () => state);
  assert.deepEqual(response, { version: 1, ok: true, state });
  assert.deepEqual(f.diagnostics, [RUNTIME_PRESENTATION_DIAGNOSTIC]);
});
