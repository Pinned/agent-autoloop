// The attached hub belongs to a terminal. This control may only prove it is reachable, keep proving
// it, and stop proving it — never start a process, never switch mode, never hold a credential.
// In-memory fetch and scheduler only; no real timers, sockets or files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachControl, type AttachEndpoint } from "../src/attach-control.ts";

const endpoint: AttachEndpoint = { origin: "http://127.0.0.1:3350", owner: "memory-owner" };

function scheduler() {
  let next = 1;
  const timers = new Map<number, { every: number; callback: () => void }>();
  return {
    api: {
      set(callback: () => void, milliseconds: number) {
        const id = next++;
        timers.set(id, { every: milliseconds, callback });
        return id;
      },
      clear(handle: unknown) {
        timers.delete(handle as number);
      },
    },
    pending: () => timers.size,
    every: () => [...timers.values()].map((timer) => timer.every),
    /** Run every armed timer once, as the host event loop would. */
    async tick() {
      const armed = [...timers.entries()];
      timers.clear();
      for (const [, timer] of armed) timer.callback();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

function fixture(options: {
  reachable?: boolean[];
  endpoint?: () => AttachEndpoint | null;
} = {}) {
  const clock = scheduler();
  const answers = options.reachable ?? [];
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  let index = 0;
  let connected = 0;
  const control = createAttachControl({
    port: 3350,
    endpoint: options.endpoint ?? (() => endpoint),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), authorization: (init?.headers as Record<string, string>)?.authorization });
      const ok = answers[Math.min(index++, answers.length - 1)] ?? true;
      return new Response(ok ? "{}" : "", { status: ok ? 200 : 503 });
    },
    schedule: clock.api,
    onConnected: () => {
      connected++;
    },
  });
  return { control, clock, calls, connected: () => connected };
}

test("attaching proves reachability with the owner key against the hub's own state door", async () => {
  const f = fixture({ reachable: [true] });
  const state = await f.control.start();
  assert.deepEqual(state, {
    status: "running",
    role: "hub-worker",
    ownership: "external",
    pendingSync: null,
    error: null,
  });
  assert.deepEqual(f.calls, [{ url: "http://127.0.0.1:3350/v1/state", authorization: "Bearer memory-owner" }]);
  assert.equal(f.connected(), 1, "the first success wakes the live readers");
  assert.deepEqual(f.clock.every(), [5000], "a live connection keeps being checked");
});

test("a hub that never answered is reported lost at once, not after a second interval", async () => {
  const f = fixture({ reachable: [false] });
  assert.equal((await f.control.start()).status, "unknown");
  assert.equal(f.control.getState().role, null);
  assert.equal(f.connected(), 0);
});

test("one lost packet after a live connection keeps the last known status", async () => {
  const f = fixture({ reachable: [true, false] });
  await f.control.start();
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "running");
  const statuses: string[] = [];
  f.control.subscribe((state) => statuses.push(state.status));
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "unknown");
  assert.deepEqual(statuses, ["unknown"], "only the settled transition is published");
});

test("a recovered hub returns to running and wakes the live readers again", async () => {
  const f = fixture({ reachable: [true, false, false, true] });
  await f.control.start();
  assert.equal(f.connected(), 1);
  await f.control.reconnect();
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "unknown");
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "running");
  assert.equal(f.control.getState().role, "hub-worker");
  assert.equal(f.connected(), 2, "the reconnect re-opens what the disconnect closed");
  // Still running on the next successful probe: no second wake-up.
  await f.control.reconnect();
  assert.equal(f.connected(), 2);
});

test("a config that moved to another port is a changed endpoint, never a request with the old key", async () => {
  let current: AttachEndpoint | null = endpoint;
  const f = fixture({ endpoint: () => current, reachable: [true, false, false] });
  await f.control.start();
  current = null;
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "running", "one miss is not yet a disconnect");
  await f.control.reconnect();
  assert.equal(f.control.getState().status, "unknown");
  assert.equal(f.calls.length, 1, "no request leaves the app once the config no longer matches");
});

test("a credential read that throws is treated as a changed endpoint, not a crash", async () => {
  const f = fixture({
    endpoint: () => {
      throw new Error("unreadable-config");
    },
    reachable: [false],
  });
  assert.equal((await f.control.start()).status, "unknown");
  assert.equal(f.calls.length, 0);
});

test("the hub config handed to data sources carries only the live listen address and key", async () => {
  let owner = "memory-owner";
  const control = createAttachControl({ port: 3350, endpoint: () => ({ ...endpoint, owner }) });
  assert.deepEqual(control.readConfig(), {
    hub: { listen: "127.0.0.1:3350" },
    owner: "memory-owner",
  });
  owner = "rotated-owner";
  assert.deepEqual(control.readConfig(), {
    hub: { listen: "127.0.0.1:3350" },
    owner: "rotated-owner",
  });
  const state = control.getState();
  assert.equal(Object.values(state).includes("memory-owner" as never), false, "no key ever enters state");
  assert.deepEqual(Object.keys(state).sort(), ["error", "ownership", "pendingSync", "role", "status"]);
});

test("a mismatched endpoint makes data-source reads fail closed instead of sending", () => {
  const control = createAttachControl({ port: 3350, endpoint: () => null });
  assert.throws(() => control.readConfig(), /attach-endpoint-changed/);
});

test("checks never stack and a closed control never probes again", async () => {
  let release!: (value: Response) => void;
  let calls = 0;
  const clock = scheduler();
  const control = createAttachControl({
    port: 3350,
    endpoint: () => endpoint,
    fetchImpl: () => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    schedule: clock.api,
  });
  const first = control.start();
  const second = control.reconnect();
  assert.equal(calls, 1, "one probe at a time");
  release(new Response("", { status: 200 }));
  assert.strictEqual(await second, await first);
  assert.equal(clock.pending(), 1);
  control.close();
  assert.equal(clock.pending(), 0, "closing cancels the retry timer");
  await clock.tick();
  assert.equal(calls, 1);
});

test("a tick after a failed probe keeps retrying without any start or mode switch", async () => {
  const f = fixture({ reachable: [false, false, true] });
  await f.control.start();
  assert.equal(f.control.getState().status, "unknown");
  await f.clock.tick();
  await f.clock.tick();
  assert.equal(f.control.getState().status, "running");
  assert.equal(f.connected(), 1);
  assert.equal(f.calls.length, 3);
  const surfaces = Object.keys(f.control).sort();
  assert.deepEqual(surfaces, ["close", "getState", "readConfig", "reconnect", "start", "subscribe"]);
});
