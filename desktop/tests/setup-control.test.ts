import assert from "node:assert/strict";
import { test } from "node:test";
import { createSetupControl } from "../src/setup-control.ts";
import {
  desktopSetupFailure,
  type DesktopSetupRequest,
  type DesktopSetupResponse,
} from "../../host/desktop-setup-contract.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request = (operation: "status" | "init" = "status"): DesktopSetupRequest => ({ version: 1, operation });
const success = (): DesktopSetupResponse => ({
  version: 1,
  operation: "status",
  ok: true,
  data: { configuration: "unconfigured", role: null },
});
const code = (response: DesktopSetupResponse) => (response.ok ? null : response.error.code);

function fixture() {
  let idle = true;
  let runs = 0;
  const gate = deferred<DesktopSetupResponse>();
  const control = createSetupControl({
    canSetup: () => idle,
    run: async () => {
      runs++;
      return gate.promise;
    },
  });
  return {
    control,
    gate,
    runs: () => runs,
    idle: (value: boolean) => {
      idle = value;
    },
  };
}

test("construction is inert; all four operations reserve synchronously and never queue", async () => {
  for (const first of [
    request("status"),
    request("init"),
    {
      version: 1,
      operation: "join",
      input: { url: "https://example.test", worker: "worker-1", key: "synthetic-key" },
    },
    { version: 1, operation: "launch-status" },
  ] as DesktopSetupRequest[]) {
    const f = fixture();
    assert.equal(f.runs(), 0);
    const accepted = f.control.runSetup(first);
    assert.equal(f.control.busy, true);
    for (const operation of ["status", "init"] as const)
      assert.equal(code(await f.control.runSetup(request(operation))), "busy");
    let started = 0;
    assert.equal(
      await f.control.runStart(
        async () => {
          started++;
          return "started";
        },
        () => "blocked",
      ),
      "blocked",
    );
    assert.equal(started, 0);
    f.gate.resolve(desktopSetupFailure(first.operation, "operation-failed"));
    await accepted;
    assert.equal(f.runs(), 1);
    assert.equal(f.control.busy, false);
    assert.equal(f.control.blocked, false);
  }
});

test("native start reserves before its first await; running stays blocked through runtime ownership", async () => {
  const f = fixture();
  const started = deferred<string>();
  let calls = 0;
  const start = f.control.runStart(
    () => {
      calls++;
      return started.promise;
    },
    () => "rejected",
  );
  assert.equal(calls, 1);
  assert.equal(f.control.busy, true);
  assert.equal(code(await f.control.runSetup(request())), "busy");
  f.idle(false);
  started.resolve("running");
  assert.equal(await start, "running");
  assert.equal(f.control.busy, false);
  for (const operation of ["status", "init"] as const)
    assert.equal(code(await f.control.runSetup(request(operation))), "busy");
  f.idle(true);
  f.gate.resolve(success());
  assert.equal((await f.control.runSetup(request())).ok, true);
});

test("failed or unknown runtime resources cannot be authorized by status alone; throwing canSetup fails closed", async () => {
  for (const idle of [
    () => false,
    () => {
      throw new Error("private-home");
    },
  ]) {
    let runs = 0;
    const control = createSetupControl({
      canSetup: idle,
      run: async () => {
        runs++;
        return success();
      },
    });
    assert.equal(code(await control.runSetup(request())), "busy");
    assert.equal(runs, 0);
  }
});

test("stop intent reaches runtime immediately without awaiting start readiness", async () => {
  const f = fixture();
  const ready = deferred<string>();
  const stopped = deferred<boolean>();
  const events: string[] = [];
  const start = f.control.runStart(
    () => {
      events.push("start");
      return ready.promise;
    },
    () => "blocked",
  );
  const stop = f.control.runStop(() => {
    events.push("stop-intent");
    return stopped.promise;
  });
  assert.deepEqual(events, ["start", "stop-intent"]);
  assert.equal(
    await f.control.runStart(
      async () => "late-start",
      () => "blocked",
    ),
    "blocked",
  );
  assert.equal(code(await f.control.runSetup(request())), "busy");
  ready.resolve("stopped");
  stopped.resolve(true);
  await Promise.all([start, stop]);
  assert.equal(f.control.busy, false);
});

test("confirmed quit closes admission synchronously and waits setup cleanup before runtime stop", async () => {
  const f = fixture();
  const accepted = f.control.runSetup(request());
  let stops = 0;
  let finished = false;
  const quit = f.control.prepareQuit(async () => {
    stops++;
    return true;
  });
  void quit.then(() => {
    finished = true;
  });
  assert.equal(f.control.quitting, true);
  assert.equal(code(await f.control.runSetup(request())), "unavailable");
  assert.equal(
    await f.control.runStart(
      async () => "started",
      () => "blocked",
    ),
    "blocked",
  );
  assert.equal(stops, 0);
  assert.equal(finished, false);
  f.gate.resolve(success());
  await accepted;
  assert.equal(await quit, true);
  assert.equal(stops, 1);
  assert.equal(f.control.quitting, true);
});

test("quit stop does not wait pending start readiness; concurrent quits share one callback", async () => {
  const f = fixture();
  const ready = deferred<string>();
  let stops = 0;
  const start = f.control.runStart(
    () => ready.promise,
    () => "blocked",
  );
  const first = f.control.prepareQuit(async () => {
    stops++;
    ready.resolve("stopped");
    return true;
  });
  const second = f.control.prepareQuit(async () => {
    throw new Error("must not stop twice");
  });
  assert.equal(first, second);
  assert.equal(await first, true);
  await start;
  assert.equal(stops, 1);
});

test("unsafe or rejected runtime quit reopens admission without overriding unknown setup", async () => {
  for (const stop of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error("private");
    },
  ]) {
    const f = fixture();
    assert.equal(await f.control.prepareQuit(stop), false);
    assert.equal(f.control.quitting, false);
    assert.equal(
      await f.control.runStart(
        async () => "started",
        () => "blocked",
      ),
      "started",
    );
  }
});

test("unknown is sticky: no later setup, start, runtime stop, or quit can reset it", async () => {
  const f = fixture();
  const accepted = f.control.runSetup(request());
  let quitStops = 0;
  const quit = f.control.prepareQuit(async () => {
    quitStops++;
    return true;
  });
  f.gate.resolve(desktopSetupFailure("status", "unknown"));
  assert.equal(code(await accepted), "unknown");
  assert.equal(await quit, false);
  assert.equal(quitStops, 0);
  assert.equal(f.control.blocked, true);
  assert.equal(f.control.quitting, false);
  assert.equal(await f.control.runStop(async () => true), true);
  assert.equal(code(await f.control.runSetup(request())), "unknown");
  assert.equal(
    await f.control.runStart(
      async () => "started",
      () => "blocked",
    ),
    "blocked",
  );
  assert.equal(
    await f.control.prepareQuit(async () => {
      quitStops++;
      return true;
    }),
    false,
  );
  assert.equal(quitStops, 0);
  assert.equal(f.runs(), 1);
});

test("runner rejection and forged response block permanently without exposing private failures", async () => {
  for (const run of [
    async (): Promise<DesktopSetupResponse> => {
      throw new Error("synthetic-secret");
    },
    async () => ({ ...success(), secret: "synthetic-secret" }) as unknown as DesktopSetupResponse,
    async () => ({ ...success(), operation: "init" }) as DesktopSetupResponse,
  ]) {
    const control = createSetupControl({ canSetup: () => true, run });
    const response = await control.runSetup(request());
    assert.equal(code(response), "unknown");
    assert.equal(control.blocked, true);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-secret/);
  }
});

test("disabled resources never invoke runner or native start; synchronous failures release gates", async () => {
  let invoked = 0;
  const disabled = createSetupControl({
    enabled: false,
    canSetup: () => true,
    run: async () => {
      invoked++;
      return success();
    },
  });
  assert.equal(code(await disabled.runSetup(request())), "unavailable");
  assert.equal(
    await disabled.runStart(
      async () => {
        invoked++;
        return "start";
      },
      () => "blocked",
    ),
    "blocked",
  );
  assert.equal(invoked, 0);
  const f = fixture();
  await assert.rejects(
    f.control.runStart(
      () => {
        throw new Error("start");
      },
      () => "blocked",
    ),
  );
  await assert.rejects(
    f.control.runStop(() => {
      throw new Error("stop");
    }),
  );
  assert.equal(f.control.busy, false);
});

test("invalid request is rejected without calling runner or poisoning later admission", async () => {
  let runs = 0;
  const control = createSetupControl({
    canSetup: () => true,
    run: async () => {
      runs++;
      return success();
    },
  });
  assert.equal(
    code(await control.runSetup({ ...request(), extra: "secret" } as unknown as DesktopSetupRequest)),
    "invalid-request",
  );
  assert.equal(runs, 0);
  assert.equal(control.blocked, false);
  assert.equal(control.busy, false);
  assert.equal((await control.runSetup(request())).ok, true);
  assert.equal(runs, 1);
});

test("completed joins are independent requests, never deduplicated", async () => {
  let runs = 0;
  const control = createSetupControl({
    canSetup: () => true,
    run: async (input) => {
      runs++;
      return desktopSetupFailure(input.operation, "already-configured");
    },
  });
  const join: DesktopSetupRequest = {
    version: 1,
    operation: "join",
    input: { url: "https://example.test", worker: "worker-1", key: "synthetic-key" },
  };
  assert.equal(code(await control.runSetup(join)), "already-configured");
  assert.equal(code(await control.runSetup(join)), "already-configured");
  assert.equal(runs, 2);
});
