import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_SETUP_ERROR_MESSAGES,
  desktopSetupFailure,
  type DesktopJoinInput,
  type DesktopSetupErrorCode,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
} from "../../host/desktop-setup-contract.ts";
import {
  createRendererSetup,
  type SetupBridge,
  type SetupState,
  type Wizard,
} from "../src/renderer/setup-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const status = (
  configuration: "unconfigured" | "configured" | "incomplete" | "invalid" = "unconfigured",
  role: "hub-worker" | "worker" | null = null,
): DesktopSetupResponse => ({
  version: 1,
  operation: "status",
  ok: true,
  data: { configuration, role },
});
const written = (operation: "init" | "join"): DesktopSetupResponse =>
  operation === "init"
    ? { version: 1, operation, ok: true, data: { configuration: "configured", role: "hub-worker" } }
    : { version: 1, operation, ok: true, data: { configuration: "configured", role: "worker" } };
const launchStatus = (
  completion: "first-run" | "legacy" | "recovery" | "prepared" | "complete" | "invalid",
  nextLaunch: "embedded" | "worker" | null = null,
): DesktopSetupResponse => ({
  version: 1,
  operation: "launch-status",
  ok: true,
  data: { completion, nextLaunch, current: nextLaunch },
});

test("startup reads launch policy once before opening first-run wizard; legacy never completes or starts", async () => {
  for (const completion of ["first-run", "legacy", "complete", "prepared", "recovery", "invalid"] as const) {
    const f = fixture();
    f.controller.bootstrap();
    f.controller.bootstrap();
    assert.deepEqual(f.calls, ["launch-status"]);
    assert.notEqual(f.controller.state.kind, "wizard");
    f.gates[0].resolve(
      launchStatus(completion, completion === "complete" || completion === "prepared" ? "embedded" : null),
    );
    await flush();
    if (completion === "first-run") {
      assert.deepEqual(f.calls, ["launch-status", "status"]);
      f.gates[1].resolve(status());
      await flush();
      assert.equal(f.controller.state.kind, "wizard");
    } else {
      assert.deepEqual(f.calls, ["launch-status"]);
      assert.equal(
        f.controller.state.kind,
        completion === "prepared"
          ? "prepared"
          : completion === "recovery" || completion === "invalid"
            ? "blocked"
            : "idle",
      );
    }
    f.controller.bootstrap();
    assert.equal(f.calls.includes("complete"), false);
  }
});

test("the connect step saves in one action; saving never starts by itself", async () => {
  const f = fixture();
  await ready(f);
  assert.equal(f.controller.submit(), true);
  f.gates.at(-1)!.resolve(written("init"));
  await flush();
  assert.equal(f.controller.state.kind, "prepared");
  assert.equal(f.calls.includes("complete"), false);
  assert.equal(f.controller.complete(), true);
  assert.equal(f.controller.complete(), false);
  assert.equal(f.controller.leave(), false);
  f.gates.at(-1)!.resolve({ version: 1, operation: "complete", ok: true, data: { nextLaunch: "embedded" } });
  await flush();
  assert.equal(f.controller.state.kind, "completed");
});

test("a refused connection writes nothing and keeps the wizard correctable", async () => {
  for (const code of ["connection-failed", "credential-rejected", "identity-mismatch"] as const) {
    const f = fixture();
    await ready(f, "worker");
    assert.equal(f.controller.submit(syntheticKey), true);
    f.gates.at(-1)!.resolve(desktopSetupFailure("join", code));
    await flush();
    const state = wizardState(f.controller.state);
    assert.equal(state.step, 2);
    assert.equal(state.error, DESKTOP_SETUP_ERROR_MESSAGES[code]);
    assert.equal(f.controller.busy, false);
    assert.deepEqual(wizardState(f.controller.state).draft, draft);
    assert.equal(f.controller.submit(syntheticKey), true);
    f.gates.at(-1)!.resolve(written("join"));
    await flush();
    assert.deepEqual(f.controller.state, { kind: "prepared", mode: "worker" });
    assert.deepEqual(f.calls, ["status", "join", "join"]);
  }
});

test("prepared startup completes explicitly; definite failure recovers policy but unknown is permanently locked", async () => {
  for (const code of ["busy", "operation-failed", "unknown"] as const) {
    const f = fixture();
    f.controller.bootstrap();
    assert.equal(f.controller.leave(), false);
    f.gates[0].resolve(launchStatus("prepared", "worker"));
    await flush();
    assert.equal(f.controller.complete(), true);
    f.gates[1].resolve(desktopSetupFailure("complete", code));
    await flush();
    assert.equal(f.controller.state.kind, code === "unknown" ? "unknown-locked" : "mutation-unresolved");
    assert.equal(f.controller.complete(), false);
    f.controller.recheck();
    if (code === "unknown") assert.equal(f.calls.length, 2);
    else {
      assert.equal(f.calls.at(-1), "launch-status");
      f.gates.at(-1)!.resolve(launchStatus("complete", "worker"));
      await flush();
      assert.equal(f.controller.state.kind, "idle");
      assert.equal(f.controller.complete(), false);
      assert.equal(f.calls.filter((value) => value === "complete").length, 1);
    }
  }
});

const draft = { url: "https://example.test/hub", worker: "worker-1" };
const syntheticKey = "  synthetic-only-key  ";
function fixture(listener?: (controller: ReturnType<typeof createRendererSetup>) => void) {
  const calls: DesktopSetupOperation[] = [];
  const gates: ReturnType<typeof deferred<DesktopSetupResponse>>[] = [];
  const joins: DesktopJoinInput[] = [];
  let notifications = 0;
  let hook: ((operation: DesktopSetupOperation) => void) | undefined;
  function run(operation: DesktopSetupOperation) {
    calls.push(operation);
    const gate = deferred<DesktopSetupResponse>();
    gates.push(gate);
    hook?.(operation);
    return gate.promise;
  }
  const bridge: SetupBridge = {
    launchStatus: () => run("launch-status"),
    completeSetup: () => run("complete"),
    setupStatus: () => run("status"),
    initHub: () => run("init"),
    joinWorker: (input) => {
      joins.push(input);
      return run("join");
    },
  };
  const controller = createRendererSetup(bridge, () => {
    notifications++;
    listener?.(controller);
  });
  return {
    controller,
    calls,
    gates,
    joins,
    bridge,
    notifications: () => notifications,
    hook: (value: typeof hook) => {
      hook = value;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function wizardState(state: SetupState): Wizard {
  assert.equal(state.kind, "wizard");
  if (state.kind !== "wizard") throw new Error("expected wizard");
  return state;
}
async function ready(f: Fixture, role: "hub-worker" | "worker" = "hub-worker") {
  f.controller.open();
  f.gates.at(-1)!.resolve(status());
  await flush();
  f.controller.chooseRole(role);
  assert.equal(f.controller.next(), true);
  if (role === "worker") assert.equal(f.controller.draft(draft), true);
}

test("construction is inert; explicit operations reserve synchronously, never queue", async () => {
  const f = fixture();
  assert.deepEqual(f.controller.state, { kind: "idle" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.notifications(), 0);
  const reservations: boolean[] = [];
  f.hook(() => {
    reservations.push(f.controller.busy);
    f.controller.open();
  });
  f.controller.open();
  assert.deepEqual(f.calls, ["status"]);
  assert.deepEqual(reservations, [true]);
  assert.equal(f.controller.state.kind, "reading-status");
  f.controller.recheck();
  assert.equal(f.controller.next(), false);
  assert.equal(f.controller.submit(), false);
  const before = f.notifications();
  f.controller.open();
  assert.equal(f.notifications(), before + 1);
  f.gates[0].resolve(status());
  await flush();
  assert.equal(f.controller.busy, false);
  f.controller.open();
  assert.equal(f.calls.length, 1);
});

test("status maps configurations and fixed errors; retries are explicit", async () => {
  for (const configuration of ["configured", "incomplete", "invalid"] as const) {
    const f = fixture();
    f.controller.open();
    f.gates[0].resolve(status(configuration, configuration === "configured" ? "worker" : null));
    await flush();
    if (configuration === "configured") {
      assert.deepEqual(f.controller.state, { kind: "configured", role: "worker", created: false });
      f.controller.leave();
      f.controller.open();
    } else {
      assert.deepEqual(f.controller.state, {
        kind: "blocked",
        message: DESKTOP_SETUP_ERROR_MESSAGES[configuration === "incomplete" ? "incomplete-setup" : "invalid-config"],
        retry: false,
      });
      f.controller.open();
    }
    assert.equal(f.calls.length, 1);
  }
  for (const code of ["busy", "unavailable", "operation-failed"] as const) {
    const f = fixture();
    f.controller.open();
    f.gates[0].resolve(desktopSetupFailure("status", code));
    await flush();
    assert.deepEqual(f.controller.state, { kind: "blocked", message: DESKTOP_SETUP_ERROR_MESSAGES[code], retry: true });
    assert.equal(f.calls.length, 1);
    f.controller.open();
    assert.equal(f.calls.length, 2);
    f.gates[1].resolve(status());
    await flush();
    assert.equal(f.controller.state.kind, "wizard");
  }
});

test("wizard retains bounded non-secret invalid drafts, clears unsafe URLs and validates without a key", async () => {
  const f = fixture();
  await ready(f, "worker");
  assert.equal(wizardState(f.controller.state).step, 2);
  for (const input of [
    { ...draft, worker: "Worker" },
    { ...draft, worker: "a\n" },
    { ...draft, worker: "a".repeat(129) },
  ]) {
    assert.equal(f.controller.draft(input), false);
    assert.equal(wizardState(f.controller.state).step, 2);
    assert.deepEqual(wizardState(f.controller.state).draft, { url: input.url, worker: input.worker.slice(0, 128) });
    assert.equal(wizardState(f.controller.state).error, "请填写有效的中台地址与本机名称。");
  }
  for (const url of [
    "https://user:synthetic-secret@example.test",
    "https://example.test/?key=synthetic-secret",
    "file:///tmp/home",
    " https://example.test",
    "https://example.test/#synthetic-secret",
  ]) {
    assert.equal(f.controller.draft({ ...draft, url }), false);
    assert.equal(wizardState(f.controller.state).draft.url, "");
    assert.equal(JSON.stringify(f.controller.state).includes("synthetic-secret"), false);
  }
  const supplied = { ...draft };
  assert.equal(f.controller.draft(supplied), true);
  supplied.url = "https://changed.test";
  assert.deepEqual(wizardState(f.controller.state).draft, draft);
  assert.equal(Object.isFrozen(f.controller.state), true);
  assert.equal(Object.isFrozen(wizardState(f.controller.state).draft), true);
  assert.equal(f.controller.next(), false);
  assert.equal(f.controller.submit(syntheticKey), true);
  f.gates.at(-1)!.resolve(written("join"));
  await flush();
  assert.deepEqual(f.controller.state, { kind: "prepared", mode: "worker" });
  assert.deepEqual(f.calls, ["status", "join"]);
});

test("join validates key at submit; synchronous handoff precedes listener and caller finally; state has no key", async () => {
  const observed: string[] = [];
  const handoffs: DesktopJoinInput[][] = [];
  const f = fixture((controller) => {
    observed.push(JSON.stringify(controller.state));
    if (controller.submitting) handoffs.push(f.joins.map((input) => ({ ...input })));
  });
  await ready(f, "worker");
  for (const key of [undefined, "", "synthetic\nkey", "a".repeat(4097)]) {
    assert.equal(f.controller.submit(key), false);
    assert.equal(f.joins.length, 0);
    assert.equal(wizardState(f.controller.state).error, "请填写有效的加入密钥。");
  }
  const reservations: boolean[] = [];
  f.hook((operation) => {
    if (operation !== "join") return;
    reservations.push(f.controller.submitting);
    reservations.push(!f.controller.leave());
    reservations.push(!f.controller.submit("duplicate"));
    f.controller.open();
  });
  let callerInput = syntheticKey;
  let accepted = false;
  try {
    accepted = f.controller.submit(callerInput);
  } finally {
    callerInput = "";
  }
  assert.equal(accepted, true);
  assert.equal(callerInput, "");
  assert.deepEqual(reservations, [true, true, true]);
  assert.ok(handoffs.length > 0);
  for (const handoff of handoffs) assert.deepEqual(handoff, [{ ...draft, key: syntheticKey }]);
  assert.deepEqual(f.calls, ["status", "join"]);
  assert.equal(
    observed.some((value) => value.includes(syntheticKey)),
    false,
  );
  assert.equal(JSON.stringify(f.controller.state).includes('"key"'), false);
  f.gates.at(-1)!.resolve(written("join"));
  await flush();
  assert.equal(f.controller.submitting, false);
  assert.deepEqual(f.controller.state, { kind: "prepared", mode: "worker" });
  f.controller.leave();
  f.controller.open();
  f.controller.recheck();
  assert.equal(f.calls.length, 2);
});

test("every definite write failure locks mutation, only explicit status may recover", async () => {
  const codes: DesktopSetupErrorCode[] = [
    "invalid-request",
    "busy",
    "unavailable",
    "already-configured",
    "incomplete-setup",
    "invalid-config",
    "operation-failed",
  ];
  for (const role of ["hub-worker", "worker"] as const) {
    for (const code of codes) {
      const f = fixture();
      await ready(f, role);
      assert.equal(f.controller.submit(syntheticKey), true);
      const operation = role === "worker" ? "join" : "init";
      f.gates.at(-1)!.resolve(desktopSetupFailure(operation, code));
      await flush();
      assert.deepEqual(f.controller.state, {
        kind: "mutation-unresolved",
        message: DESKTOP_SETUP_ERROR_MESSAGES.unknown,
      });
      assert.equal(f.controller.submit(syntheticKey), false);
      f.controller.leave();
      f.controller.open();
      assert.equal(f.calls.length, 2);
      f.controller.recheck();
      f.gates.at(-1)!.resolve(desktopSetupFailure("status", "busy"));
      await flush();
      assert.equal(f.controller.state.kind, "mutation-unresolved");
      f.controller.recheck();
      f.gates.at(-1)!.resolve(status());
      await flush();
      assert.equal(f.controller.state.kind, "wizard");
      assert.deepEqual(f.calls, ["status", operation, "status", "status"]);
    }
  }
});

test("unknown, rejected, malformed and synchronous throws lock every operation permanently", async () => {
  for (const operation of ["status", "init", "join"] as const) {
    for (const failure of ["unknown", "reject", "malformed", "throw"] as const) {
      const f = fixture();
      if (operation !== "status") await ready(f, operation === "join" ? "worker" : "hub-worker");
      if (failure === "throw") {
        const fail = () => {
          throw new Error(syntheticKey);
        };
        if (operation === "status") f.bridge.setupStatus = fail;
        else if (operation === "init") f.bridge.initHub = fail;
        else f.bridge.joinWorker = fail;
      }
      if (operation === "status") f.controller.open();
      else assert.equal(f.controller.submit(syntheticKey), true);
      if (failure === "reject") f.gates.at(-1)!.reject(new Error(syntheticKey));
      else if (failure === "malformed") {
        const malformed: unknown = { ...written("init"), extra: syntheticKey };
        f.gates.at(-1)!.resolve(malformed as DesktopSetupResponse);
      } else if (failure === "unknown") f.gates.at(-1)!.resolve(desktopSetupFailure(operation, "unknown"));
      await flush();
      assert.deepEqual(f.controller.state, { kind: "unknown-locked", message: DESKTOP_SETUP_ERROR_MESSAGES.unknown });
      assert.equal(f.controller.busy, false);
      assert.equal(JSON.stringify(f.controller.state).includes(syntheticKey), false);
      const count = f.calls.length;
      f.controller.leave();
      f.controller.open();
      f.controller.recheck();
      assert.equal(f.controller.submit(syntheticKey), false);
      assert.equal(f.calls.length, count);
    }
  }
});

test("status recovery from mutation handles configured/incomplete/invalid or upgrades to unknown", async () => {
  for (const configuration of ["configured", "incomplete", "invalid", "unknown"] as const) {
    const f = fixture();
    await ready(f);
    f.controller.submit();
    f.gates.at(-1)!.resolve(desktopSetupFailure("init", "operation-failed"));
    await flush();
    f.controller.recheck();
    f.gates
      .at(-1)!
      .resolve(
        configuration === "unknown"
          ? desktopSetupFailure("status", "unknown")
          : status(configuration, configuration === "configured" ? "hub-worker" : null),
      );
    await flush();
    assert.equal(
      f.controller.state.kind,
      configuration === "unknown" ? "unknown-locked" : configuration === "configured" ? "configured" : "blocked",
    );
  }
});

test("a departed read keeps its flight but ordinary late results never repaint; safety is global", async () => {
  for (const result of ["success", "operation-failed", "unknown", "reject", "malformed"] as const) {
    const f = fixture();
    f.controller.open();
    const gate = f.gates.at(-1)!;
    assert.equal(f.controller.leave(), true);
    assert.equal(f.controller.state.kind, "idle");
    assert.equal(f.controller.busy, true);
    const before = f.notifications();
    if (result === "reject") gate.reject(new Error(syntheticKey));
    else if (result === "malformed") gate.resolve(written("join"));
    else gate.resolve(result === "success" ? status() : desktopSetupFailure("status", result));
    await flush();
    const safe = result === "success" || result === "operation-failed";
    assert.equal(f.controller.state.kind, safe ? "idle" : "unknown-locked");
    assert.equal(f.controller.busy, false);
    assert.equal(f.notifications(), safe ? before : before + 1);
    if (safe) {
      f.controller.open();
      assert.equal(f.calls.at(-1), "status");
    }
  }
});

test("reopening adopts an in-flight read visibly without another request; a second leave invalidates it", async () => {
  for (const leaveAgain of [false, true]) {
    const f = fixture();
    f.controller.open();
    const gate = f.gates.at(-1)!;
    const count = f.calls.length;
    f.controller.leave();
    f.controller.open();
    assert.equal(f.controller.state.kind, "reading-status");
    assert.equal(f.calls.length, count);
    if (leaveAgain) f.controller.leave();
    const before = f.notifications();
    gate.resolve(status());
    await flush();
    assert.equal(f.controller.state.kind, leaveAgain ? "idle" : "wizard");
    assert.equal(f.controller.busy, false);
    assert.equal(f.notifications(), leaveAgain ? before : before + 1);
  }
});

test("mutation recovery leave/reopen adopts explicit status, but leave alone cannot recover it", async () => {
  for (const reopen of [false, true]) {
    const f = fixture();
    await ready(f);
    f.controller.submit();
    f.gates.at(-1)!.resolve(desktopSetupFailure("init", "operation-failed"));
    await flush();
    f.controller.recheck();
    const count = f.calls.length;
    f.controller.leave();
    if (reopen) {
      f.controller.open();
      assert.equal(f.controller.state.kind, "reading-status");
    }
    assert.equal(f.calls.length, count);
    f.gates.at(-1)!.resolve(status());
    await flush();
    assert.equal(f.controller.state.kind, reopen ? "wizard" : "mutation-unresolved");
  }
});

test("strict parsing rejects extra fields/accessors/arbitrary messages without invoking getters", async () => {
  let getterCalls = 0;
  const accessor = {
    version: 1,
    operation: "status",
    ok: true,
    get data() {
      getterCalls++;
      return { configuration: "unconfigured", role: null };
    },
  };
  for (const value of [
    accessor,
    { ...status(), extra: "private" },
    { version: 2, operation: "status", ok: true, data: { configuration: "unconfigured", role: null } },
    { version: 1, operation: "status", ok: true, data: { configuration: "configured", role: null } },
    { version: 1, operation: "status", ok: false, error: { code: "busy", message: syntheticKey } },
    Object.assign(Object.create(null), status()),
  ]) {
    const f = fixture();
    f.controller.open();
    f.gates[0].resolve(value as DesktopSetupResponse);
    await flush();
    assert.deepEqual(f.controller.state, { kind: "unknown-locked", message: DESKTOP_SETUP_ERROR_MESSAGES.unknown });
  }
  assert.equal(getterCalls, 0);
  const f = fixture();
  await ready(f, "worker");
  f.controller.submit(syntheticKey);
  f.gates.at(-1)!.resolve({ ...written("join"), extra: syntheticKey } as unknown as DesktopSetupResponse);
  await flush();
  assert.deepEqual(f.controller.state, { kind: "unknown-locked", message: DESKTOP_SETUP_ERROR_MESSAGES.unknown });
});

test("throwing listeners do not corrupt bridge success; listeners may synchronously re-enter", async () => {
  const f = fixture(() => {
    throw new Error("render failed");
  });
  await ready(f);
  assert.equal(f.controller.submit(), true);
  f.gates.at(-1)!.resolve(written("init"));
  await flush();
  assert.deepEqual(f.controller.state, { kind: "prepared", mode: "embedded" });
  assert.equal(f.controller.busy, false);
  let reentered = false;
  const reservations: boolean[] = [];
  const reentrant = fixture((controller) => {
    if (controller.busy && !reentered) {
      reentered = true;
      controller.open();
      controller.back();
      reservations.push(!controller.submit());
    }
  });
  await ready(reentrant);
  assert.deepEqual(reentrant.calls, ["status"]);
  assert.deepEqual(reservations, [true]);
});
