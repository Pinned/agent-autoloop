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
    const text = desktopRuntimeStatusText({ status, pendingSync: null });
    assert.equal(text, DESKTOP_RUNTIME_STATUS_MESSAGES[status]);
    assert.ok(text.length > 0);
  }
  assert.equal(desktopRuntimeStatusText({ status: "stopped", pendingSync: 3 }), "本机已停止；3 条结果离线持久待同步");
  assert.equal(
    desktopRuntimeStatusText({ status: "unavailable", pendingSync: null }, { unavailable: "纯壳验证" }),
    "纯壳验证",
  );
});

test("main-side construction validates instead of trusting the caller", () => {
  rejects(() => desktopRuntimeSnapshotOf({ status: "paused" as never, role: null, pendingSync: null, error: null }));
  rejects(() =>
    desktopRuntimeSnapshotOf({ status: "stopped", role: "agent" as never, pendingSync: null, error: null }),
  );
  rejects(() =>
    desktopRuntimeSnapshotOf({
      status: "unknown",
      role: null,
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
