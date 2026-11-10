import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RUNTIME_ERROR_MESSAGES,
  DESKTOP_RUNTIME_STATUS_MESSAGES,
  desktopRuntimeFailure,
  desktopRuntimeSnapshotOf,
  desktopRuntimeStatusText,
  parseDesktopRuntimeEvent,
  parseDesktopRuntimeResponse,
  type DesktopRuntimeSnapshot,
} from "../../host/desktop-run-contract.ts";

const snapshot = (overrides: Partial<DesktopRuntimeSnapshot> = {}): DesktopRuntimeSnapshot => ({
  version: 1,
  status: "stopped",
  role: null,
  ownership: "owned",
  pendingSync: null,
  error: null,
  ...overrides,
});
const rejects = (action: () => unknown) => {
  assert.throws(action, /invalid-request/);
};

test("valid snapshots, responses and events round-trip through strict parsing", () => {
  const stopped = snapshot();
  const running = snapshot({
    status: "running",
    role: "hub-worker",
    error: { code: "service", message: DESKTOP_RUNTIME_ERROR_MESSAGES.service },
  });
  for (const state of [stopped, running]) {
    assert.deepEqual(parseDesktopRuntimeResponse({ version: 1, ok: true, state }), { version: 1, ok: true, state });
    assert.deepEqual(parseDesktopRuntimeEvent({ version: 1, state }), { version: 1, state });
  }
  assert.deepEqual(
    parseDesktopRuntimeResponse({
      version: 1,
      ok: false,
      error: { code: "busy", message: DESKTOP_RUNTIME_ERROR_MESSAGES.busy },
    }),
    desktopRuntimeFailure("busy"),
  );
  assert.deepEqual(desktopRuntimeSnapshotOf(stopped), stopped);
});

test("snapshots reject unknown fields, prototypes, accessors and symbols", () => {
  const state = snapshot();
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: { ...state, extra: 1 } }));
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: Object.assign(Object.create(null), state) }));
  const withGetter = { ...state };
  Object.defineProperty(withGetter, "status", {
    get() {
      return "stopped";
    },
    enumerable: true,
  });
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: withGetter }));
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: [state] }));
  rejects(() => parseDesktopRuntimeEvent({ version: 2, state }));
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: { ...state, status: "paused" } }));
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: { ...state, role: "agent" } }));
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: { ...state, version: 2 } }));
});

test("pendingSync must be null or a bounded safe integer", () => {
  for (const value of [3, 0, 1_000_000_000])
    parseDesktopRuntimeEvent({ version: 1, state: snapshot({ pendingSync: value }) });
  for (const value of [-1, 1.5, "3", 1_000_000_001, Number.NaN, undefined] as unknown[])
    rejects(() => parseDesktopRuntimeEvent({ version: 1, state: snapshot({ pendingSync: value as never }) }));
});

test("error and admission codes must carry their exact frozen message", () => {
  for (const code of ["safe-stop", "prepare", "service"] as const)
    parseDesktopRuntimeEvent({
      version: 1,
      state: snapshot({ status: "unknown", error: { code, message: DESKTOP_RUNTIME_ERROR_MESSAGES[code] } }),
    });
  rejects(() =>
    parseDesktopRuntimeEvent({
      version: 1,
      state: snapshot({ status: "unknown", error: { code: "service", message: "伪造文案" } }),
    }),
  );
  rejects(() =>
    parseDesktopRuntimeEvent({ version: 1, state: snapshot({ error: { code: "busy" as never, message: "" } }) }),
  );
  rejects(() =>
    parseDesktopRuntimeResponse({
      version: 1,
      ok: false,
      error: { code: "service", message: DESKTOP_RUNTIME_ERROR_MESSAGES.service },
    }),
  );
  rejects(() => parseDesktopRuntimeResponse({ version: 1, ok: false, error: { code: "later", message: "稍后" } }));
  rejects(() => parseDesktopRuntimeResponse({ version: 1, ok: true }));
  rejects(() => parseDesktopRuntimeResponse(null));
});

test("status text covers every status plus the offline pendingSync special case", () => {
  for (const status of Object.keys(
    DESKTOP_RUNTIME_STATUS_MESSAGES,
  ) as (keyof typeof DESKTOP_RUNTIME_STATUS_MESSAGES)[]) {
    const text = desktopRuntimeStatusText({ status, pendingSync: null, ownership: "owned" });
    assert.equal(text, DESKTOP_RUNTIME_STATUS_MESSAGES[status]);
    assert.ok(text.length > 0);
  }
  assert.equal(
    desktopRuntimeStatusText({ status: "stopped", pendingSync: 3, ownership: "owned" }),
    "本机已停止；3 条结果离线持久待同步",
  );
  assert.equal(
    desktopRuntimeStatusText({ status: "unavailable", pendingSync: null, ownership: "owned" }, { unavailable: "纯壳验证" }),
    "纯壳验证",
  );
});

test("an external hub never borrows the embedded wording, even through a presentation gate", () => {
  assert.equal(
    desktopRuntimeStatusText({ status: "running", pendingSync: null, ownership: "external" }),
    "已接入本机中台（由终端管理）",
  );
  assert.equal(
    desktopRuntimeStatusText({ status: "starting", pendingSync: null, ownership: "external" }),
    "正在连接本机中台",
  );
  assert.equal(
    desktopRuntimeStatusText({ status: "unknown", pendingSync: null, ownership: "external" }),
    "外部中台连接中断，正在重连",
  );
  // The presentation gate blanks role and status, but the hub is still someone else's; the caller's
  // "resources are not ready" wording would be a false claim about a process we do not own.
  assert.equal(
    desktopRuntimeStatusText({ status: "unavailable", pendingSync: null, ownership: "external" }, { unavailable: "运行资源尚未就绪" }),
    "已接入本机中台，当前操作暂不可用",
  );
});

test("ownership decides nothing about the embedded path", () => {
  // Every embedded status keeps its frozen wording; ownership only branches for external hubs.
  for (const status of Object.keys(DESKTOP_RUNTIME_STATUS_MESSAGES) as (keyof typeof DESKTOP_RUNTIME_STATUS_MESSAGES)[]) {
    assert.equal(
      desktopRuntimeStatusText({ status, pendingSync: null, ownership: "owned" }),
      DESKTOP_RUNTIME_STATUS_MESSAGES[status],
    );
  }
});

test("the unavailable line never claims the runtime resources are missing", () => {
  // This status is also the projection for presentation gates (quit dialog, setup, document swap):
  // the resources are fine, the control plane is closed. Only the tray overrides it with the true
  // missing-resource wording, because the tray reads the raw state instead of the projection.
  const text = DESKTOP_RUNTIME_STATUS_MESSAGES.unavailable;
  assert.equal(text, "本机运行服务控制暂不可用");
  assert.doesNotMatch(text, /资源|无法启动/);
});

test("main-side construction validates instead of trusting the caller", () => {
  rejects(() =>
    desktopRuntimeSnapshotOf({
      status: "paused" as never,
      role: null,
      ownership: "owned",
      pendingSync: null,
      error: null,
    }),
  );
  rejects(() =>
    desktopRuntimeSnapshotOf({
      status: "stopped",
      role: "agent" as never,
      ownership: "owned",
      pendingSync: null,
      error: null,
    }),
  );
  rejects(() =>
    desktopRuntimeSnapshotOf({
      status: "unknown",
      role: null,
      ownership: "owned",
      pendingSync: null,
      error: { code: "safe-stop", message: "替换文案" },
    }),
  );
  assert.deepEqual(desktopRuntimeFailure("unknown"), {
    version: 1,
    ok: false,
    error: { code: "unknown", message: DESKTOP_RUNTIME_ERROR_MESSAGES.unknown },
  });
});

test("an attached snapshot is a hub and only a hub", () => {
  // Before the probe answers nobody knows the role; `starting` is the only role-less external state.
  rejects(() =>
    parseDesktopRuntimeEvent({
      version: 1,
      state: snapshot({ status: "running", role: null, ownership: "external" }),
    }),
  );
  rejects(() =>
    parseDesktopRuntimeEvent({
      version: 1,
      state: snapshot({ status: "running", role: "worker", ownership: "external" }),
    }),
  );
  rejects(() =>
    parseDesktopRuntimeEvent({
      version: 1,
      state: snapshot({ status: "stopped", role: "hub-worker", ownership: "external" }),
    }),
  );
  // A live attach and a disconnected one are both legitimate external states.
  parseDesktopRuntimeEvent({
    version: 1,
    state: snapshot({ status: "running", role: "hub-worker", ownership: "external" }),
  });
  parseDesktopRuntimeEvent({
    version: 1,
    state: snapshot({ status: "unknown", role: "hub-worker", ownership: "external" }),
  });
  parseDesktopRuntimeEvent({
    version: 1,
    state: snapshot({ status: "starting", role: null, ownership: "external" }),
  });
  // The presentation gate keeps the role blank but must keep ownership.
  parseDesktopRuntimeEvent({
    version: 1,
    state: snapshot({ status: "unavailable", role: null, ownership: "external" }),
  });
});

test("ownership is required and bounded, never defaulted", () => {
  for (const value of [undefined, null, "", "attached", "OWNED"] as unknown[]) {
    const state = { ...snapshot(), ownership: value };
    rejects(() => parseDesktopRuntimeEvent({ version: 1, state }));
  }
  // A snapshot built without the field must be rejected, not silently read as "owned": a missing
  // field would otherwise hand the stop button to a process this app does not own.
  const { ownership, ...missing } = snapshot();
  rejects(() => parseDesktopRuntimeEvent({ version: 1, state: missing }));
});
