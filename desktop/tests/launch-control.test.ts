// Prevent renderer bootstrap from consuming autoStart's only intent via setupBusy; share only pending status reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLaunchControl, createLaunchStatusRead, safelyAbortLifecycle } from "../src/launch-control.ts";
import { desktopSetupFailure, type DesktopSetupResponse } from "../../host/desktop-setup-contract.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const first of ["renderer", "autoStart"] as const) {
  test(`P1 shared launch-status preserves autoStart when ${first} arrives first`, async () => {
    const result = deferred<DesktopSetupResponse>();
    let reads = 0;
    let starts = 0;
    const setup = createSetupControl({
      canSetup: () => true,
      run: async () => {
        reads++;
        return result.promise;
      },
    });
    const read = createLaunchStatusRead(() => setup.runSetup({ version: 1, operation: "launch-status" }));
    const launch = createLaunchControl({
      read: async () => {
        const response = await read();
        if (!response.ok || response.operation !== "launch-status") throw Error("launch-status-unavailable");
        return response.data;
      },
      start: () =>
        setup.runStart(
          async () => {
            starts++;
          },
          () => undefined,
        ),
    });
    let renderer: Promise<DesktopSetupResponse>;
    let automatic: Promise<void>;
    if (first === "renderer") {
      renderer = read();
      automatic = launch.autoStart();
    } else {
      automatic = launch.autoStart();
      renderer = read();
    }
    await Promise.resolve();
    assert.equal(setup.busy, true);
    assert.equal(reads, 1);
    result.resolve({
      version: 1,
      operation: "launch-status",
      ok: true,
      data: { completion: "complete", nextLaunch: "embedded", current: "embedded" },
    });
    const [response] = await Promise.all([renderer, automatic]);
    assert.equal(response.ok, true);
    assert.equal(starts, 1);
    assert.equal(setup.busy, false);
    await Promise.all([launch.autoStart(), launch.completed()]);
    assert.equal(starts, 1);
  });
}

test("P1 shared launch-status releases success, failure and rejection without automatic retry", async () => {
  for (const outcome of ["success", "failure", "reject", "throw"] as const) {
    const result = deferred<DesktopSetupResponse>();
    let reads = 0;
    let starts = 0;
    const read = createLaunchStatusRead(() => {
      reads++;
      if (outcome === "throw" && reads === 1) throw Error("synthetic-sync");
      return reads === 1 ? result.promise : Promise.resolve(desktopSetupFailure("launch-status", "unavailable"));
    });
    const launch = createLaunchControl({
      read: async () => {
        const response = await read();
        if (!response.ok || response.operation !== "launch-status") throw Error("launch-status-unavailable");
        return response.data;
      },
      start: async () => {
        starts++;
      },
    });
    const renderer = Promise.resolve().then(() => read());
    const automatic = Promise.resolve().then(() => launch.autoStart());
    const receipts = Promise.allSettled([renderer, automatic]);
    await Promise.resolve();
    if (outcome === "reject") result.reject(Error("synthetic-rejection"));
    else
      result.resolve(
        outcome === "success"
          ? {
              version: 1,
              operation: "launch-status",
              ok: true,
              data: { completion: "first-run", nextLaunch: null, current: null },
            }
          : desktopSetupFailure("launch-status", "unavailable"),
      );
    const [receipt] = await receipts;
    assert.equal(reads, 1, outcome);
    assert.equal(receipt.status, outcome === "reject" || outcome === "throw" ? "rejected" : "fulfilled");
    await launch.autoStart();
    assert.equal(reads, 1, "autoStart must not retry the initial intent");
    await read();
    assert.equal(reads, 2, "settled reads must not be cached");
    assert.equal(starts, 0);
  }
});

test("P1 shared launch-status does not share or admit checks and mutations", async () => {
  const result = deferred<DesktopSetupResponse>();
  const operations: string[] = [];
  const setup = createSetupControl({
    canSetup: () => true,
    run: async (request) => {
      operations.push(request.operation);
      return result.promise;
    },
  });
  const read = createLaunchStatusRead(() => setup.runSetup({ version: 1, operation: "launch-status" }));
  const status = read();
  const peer = read();
  for (const operation of ["check", "complete", "init", "join"] as const) {
    const request =
      operation === "join"
        ? { version: 1 as const, operation, input: { url: "http://127.0.0.1:4567", worker: "fake", key: "fake" } }
        : { version: 1 as const, operation };
    const response = await setup.runSetup(request);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "busy");
  }
  result.resolve({
    version: 1,
    operation: "launch-status",
    ok: true,
    data: { completion: "first-run", nextLaunch: null, current: null },
  });
  assert.equal((await status).ok, true);
  assert.equal((await peer).ok, true);
  assert.deepEqual(operations, ["launch-status"]);
});

test("P1 shared unknown receipt and runner rejection retain the setup safety fence", async () => {
  for (const outcome of ["unknown", "reject"] as const) {
    const result = deferred<DesktopSetupResponse>();
    let reads = 0;
    let starts = 0;
    const setup = createSetupControl({
      canSetup: () => true,
      run: async () => {
        reads++;
        return result.promise;
      },
    });
    const read = createLaunchStatusRead(() => setup.runSetup({ version: 1, operation: "launch-status" }));
    const launch = createLaunchControl({
      read: async () => {
        const response = await read();
        if (!response.ok || response.operation !== "launch-status") throw Error("launch-status-unavailable");
        return response.data;
      },
      start: () =>
        setup.runStart(
          async () => {
            starts++;
          },
          () => undefined,
        ),
    });
    const renderer = read();
    const auto = launch.autoStart();
    const peer = read();
    const duplicate = launch.autoStart();
    await Promise.resolve();
    if (outcome === "reject") result.reject(Error("synthetic"));
    else result.resolve(desktopSetupFailure("launch-status", "unknown"));
    const [response, , same] = await Promise.all([renderer, auto, peer, duplicate]);
    assert.strictEqual(response, same);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "unknown");
    assert.equal(reads, 1);
    assert.equal(setup.busy, false);
    assert.equal(setup.blocked, true);
    await Promise.all([launch.autoStart(), launch.completed(), launch.completed()]);
    assert.equal(starts, 0);
    assert.equal(reads, 1, "blocked setup must not reach the runner again");
  }
});

test("P1 shared launch-status never bypasses an earlier mutation or caches its busy receipt", async () => {
  const mutation = deferred<DesktopSetupResponse>();
  const operations: string[] = [];
  const setup = createSetupControl({
    canSetup: () => true,
    run: async (request) => {
      operations.push(request.operation);
      return request.operation === "init"
        ? mutation.promise
        : {
            version: 1,
            operation: "launch-status",
            ok: true,
            data: { completion: "first-run", nextLaunch: null, current: null },
          };
    },
  });
  const init = setup.runSetup({ version: 1, operation: "init" });
  const read = createLaunchStatusRead(() => setup.runSetup({ version: 1, operation: "launch-status" }));
  const [first, peer] = await Promise.all([read(), read()]);
  assert.strictEqual(first, peer);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.error.code, "busy");
  mutation.resolve({
    version: 1,
    operation: "init",
    ok: true,
    data: { configuration: "configured", role: "hub-worker" },
  });
  await init;
  assert.equal((await read()).ok, true);
  assert.deepEqual(operations, ["init", "launch-status"]);
});

test("lifecycle abort exits nonzero only after verified safe stop and retains unsafe ownership", async () => {
  for (const outcome of ["safe", "unsafe", "reject"] as const) {
    let exits = 0;
    await safelyAbortLifecycle({
      prepareQuit: async () => {
        if (outcome === "reject") throw Error("synthetic");
        return outcome === "safe";
      },
      exit: (code) => {
        assert.equal(code, 1);
        exits++;
      },
    });
    assert.equal(exits, outcome === "safe" ? 1 : 0);
  }
});
import { createSetupControl } from "../src/setup-control.ts";

test("auto launch admits only complete policy, runs once across repeated requests, retries only explicitly", async () => {
  let starts = 0,
    reads = 0;
  const control = createLaunchControl({
    read: async () => {
      reads++;
      return { completion: "complete", nextLaunch: "embedded", current: "embedded" };
    },
    start: async () => {
      starts++;
    },
  });
  await Promise.all([control.autoStart(), control.autoStart(), control.autoStart()]);
  await control.autoStart();
  assert.equal(starts, 1);
  assert.equal(reads, 1);
  await control.completed();
  assert.equal(starts, 1);
  for (const completion of ["first-run", "legacy", "recovery", "prepared", "invalid"] as const) {
    const denied = createLaunchControl({
      read: async () => ({ completion, nextLaunch: null, current: null }),
      start: async () => {
        throw Error("must not start");
      },
    });
    await denied.autoStart();
  }
});
test("failed auto launch does not loop and completed setup can start after initial first-run read", async () => {
  let complete = false,
    starts = 0;
  const control = createLaunchControl({
    read: async () =>
      complete
        ? { completion: "complete", nextLaunch: "worker", current: "worker" }
        : { completion: "first-run", nextLaunch: null, current: null },
    start: async () => {
      starts++;
      throw Error("fake failure");
    },
  });
  await control.autoStart();
  complete = true;
  await Promise.all([control.completed(), control.completed()]);
  assert.equal(starts, 1);
  await control.autoStart();
  assert.equal(starts, 1);
});
test("read-only setup remains available while runtime owns resources but mutations do not", async () => {
  const control = createSetupControl({
    canSetup: () => false,
    run: async (request) =>
      ({
        version: 1,
        operation: request.operation,
        ok: true,
        data: { completion: "complete", nextLaunch: "embedded", current: "embedded" },
      }) as never,
  });
  assert.equal((await control.runSetup({ version: 1, operation: "launch-status" })).ok, true);
  assert.equal((await control.runSetup({ version: 1, operation: "complete" })).ok, false);
});
