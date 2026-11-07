import assert from "node:assert/strict";
import { test } from "node:test";
import { createSetupRunner, type SetupResources } from "../src/setup-runner.ts";
import type { LocalProcessOptions, LocalProcessResult } from "../../host/local-process.ts";
import {
  DESKTOP_SETUP_RESPONSE_MAX_BYTES,
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
const resources: SetupResources = {
  nodePath: "/owned/official-node/bin/node",
  entryPath: "/owned/sources/host/desktop-setup.ts",
  home: "/isolated/business-home",
  environmentHome: "/owned/environment-home",
};
const request = (operation: "status" | "check" | "init" = "status"): DesktopSetupRequest => ({ version: 1, operation });
const success = (): DesktopSetupResponse => ({
  version: 1,
  operation: "status",
  ok: true,
  data: { configuration: "unconfigured", role: null },
});
const completed = (value: unknown = success(), failure: Error | null = null): LocalProcessResult => ({
  state: "completed",
  output: Buffer.from(JSON.stringify(value)),
  failure,
});
const unknown = (): LocalProcessResult => ({
  state: "unknown",
  failure: new Error("synthetic-key"),
  cleanupFailure: new Error("private-path"),
});
const code = (response: DesktopSetupResponse) => (response.ok ? null : response.error.code);

function fixture(result: LocalProcessResult = completed()) {
  let prepares = 0;
  let processes = 0;
  let cleanups = 0;
  let observed: LocalProcessOptions | undefined;
  const runner = createSetupRunner({
    prepare: async (own) => {
      prepares++;
      own(async () => {
        cleanups++;
      });
      return resources;
    },
    runProcess: async (options) => {
      processes++;
      observed = options;
      return result;
    },
  });
  return {
    runner,
    prepares: () => prepares,
    processes: () => processes,
    cleanups: () => cleanups,
    observed: () => observed!,
  };
}

test("construction is inert; all operations use fixed Node/driver and read-only or mutation mode", async () => {
  const inputs: DesktopSetupRequest[] = [
    request(),
    request("check"),
    request("init"),
    {
      version: 1,
      operation: "join",
      input: { url: "https://example.test", worker: "worker-1", key: " synthetic-key " },
    },
  ];
  for (const input of inputs) {
    const f = fixture(completed(desktopSetupFailure(input.operation, "already-configured")));
    assert.equal(f.prepares(), 0);
    assert.equal(f.processes(), 0);
    const response = await f.runner.run(input);
    const observed = f.observed();
    assert.equal(observed.file, resources.nodePath);
    assert.deepEqual(observed.args, [resources.entryPath]);
    assert.equal(observed.cwd, "/owned/sources");
    assert.equal(observed.mode, input.operation === "status" || input.operation === "check" ? "read-only" : "mutation");
    assert.deepEqual(JSON.parse(String(observed.input)), input);
    assert.equal(observed.maxOutputBytes, DESKTOP_SETUP_RESPONSE_MAX_BYTES);
    assert.equal(f.cleanups(), 1);
    assert.equal(code(response), "already-configured");
    assert.doesNotMatch(JSON.stringify([observed.args, observed.env, response]), /synthetic-key/);
  }
});

test("environment is created from zero: only fixed paths, language and own HOME/tmp are allowed", async () => {
  const f = fixture();
  await f.runner.run(request());
  const env = f.observed().env!;
  assert.deepEqual(
    Object.keys(env).sort(),
    [
      "AGENT_AUTOLOOP_HOME",
      "HOME",
      "LANG",
      "PATH",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ].sort(),
  );
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"])
    assert.equal(env[name], resources.environmentHome);
  assert.equal(env.AGENT_AUTOLOOP_HOME, resources.home);
  assert.ok(["/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "/usr/local/bin:/usr/bin:/bin"].includes(env.PATH!));
  for (const name of [
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "ENV",
    "BASH_ENV",
    "ZDOTDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ])
    assert.equal(env[name], undefined);
});

test("safe result is reconstructed and withheld until reverse-order owned cleanup finishes", async () => {
  const cleanupReady = deferred<void>();
  const cleanupEntered = deferred<void>();
  const events: string[] = [];
  const source = success();
  const runner = createSetupRunner({
    prepare: async (own) => {
      own(async () => {
        events.push("first");
      });
      own(async () => {
        events.push("second");
        cleanupEntered.resolve();
        await cleanupReady.promise;
      });
      return resources;
    },
    runProcess: async () => {
      events.push("process-completed");
      return completed(source);
    },
  });
  let settled = false;
  const flight = runner.run(request());
  void flight.then(() => {
    settled = true;
  });
  await cleanupEntered.promise;
  assert.equal(settled, false);
  assert.deepEqual(events, ["process-completed", "second"]);
  cleanupReady.resolve();
  const response = await flight;
  assert.deepEqual(response, source);
  assert.notEqual(response, source);
  assert.deepEqual(events, ["process-completed", "second", "first"]);
});

test("preparation failure cleans only already-registered owners and returns fixed codes", async () => {
  for (const [name, expected] of [
    ["Error", "operation-failed"],
    ["RuntimeUnavailableError", "unavailable"],
  ]) {
    const events: string[] = [];
    const runner = createSetupRunner({
      prepare: async (own) => {
        own(async () => {
          events.push("clean");
        });
        throw Object.assign(new Error("synthetic-secret"), { name });
      },
      runProcess: async () => {
        throw new Error("must not spawn");
      },
    });
    const response = await runner.run(request());
    assert.equal(code(response), expected);
    assert.deepEqual(events, ["clean"]);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-secret/);
  }
});

test("preparer RuntimeCleanupError retains ownership and never retries the failed cleanup", async () => {
  let cleanups = 0;
  let retries = 0;
  let prepares = 0;
  const runner = createSetupRunner({
    prepare: async (own) => {
      prepares++;
      own(async () => {
        cleanups++;
      });
      throw Object.assign(new Error("private-path"), {
        name: "RuntimeCleanupError",
        cleanupPending: true,
        retryCleanup: async () => {
          retries++;
        },
      });
    },
    runProcess: async () => {
      throw new Error("must not spawn");
    },
  });
  assert.equal(code(await runner.run(request())), "unknown");
  assert.equal(code(await runner.run(request("init"))), "unknown");
  assert.equal(prepares, 1);
  assert.equal(cleanups, 0);
  assert.equal(retries, 0);
});

test("cleanup failure is sticky, does not continue or retry, and overrides a successful DTO", async () => {
  let prepares = 0;
  const events: string[] = [];
  const runner = createSetupRunner({
    prepare: async (own) => {
      prepares++;
      own(async () => {
        events.push("must-not-clean-earlier");
      });
      own(async () => {
        events.push("failed-cleanup");
        throw new Error("private-path");
      });
      return resources;
    },
    runProcess: async () => completed(),
  });
  const response = await runner.run(request());
  assert.equal(code(response), "unknown");
  assert.equal(code(await runner.run(request())), "unknown");
  assert.deepEqual(events, ["failed-cleanup"]);
  assert.equal(prepares, 1);
  assert.doesNotMatch(JSON.stringify(response), /private-path/);
});

test("unknown process, rejected runner and driver unknown retain all resources", async () => {
  for (const runProcess of [
    async () => unknown(),
    async (): Promise<LocalProcessResult> => {
      throw new Error("synthetic-key");
    },
    async () => completed(desktopSetupFailure("status", "unknown")),
  ]) {
    let cleanups = 0;
    let processes = 0;
    const runner = createSetupRunner({
      prepare: async (own) => {
        own(async () => {
          cleanups++;
        });
        return resources;
      },
      runProcess: async () => {
        processes++;
        return runProcess();
      },
    });
    const response = await runner.run(request());
    assert.equal(code(response), "unknown");
    assert.equal(code(await runner.run(request())), "unknown");
    assert.equal(cleanups, 0);
    assert.equal(processes, 1);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-key|private-path/);
  }
});

test("nonzero/error, empty, truncated, oversized, wrong operation/version and extra/raw fields fail safely", async () => {
  const malformed: LocalProcessResult[] = [
    completed(success(), new Error("synthetic-key")),
    { state: "completed", output: Buffer.alloc(0), failure: null },
    { state: "completed", output: Buffer.from('{"version":1'), failure: null },
    { state: "completed", output: Buffer.alloc(DESKTOP_SETUP_RESPONSE_MAX_BYTES + 1, 32), failure: null },
    completed({ ...success(), operation: "init" }),
    completed({ ...success(), version: 2 }),
    completed({ ...success(), key: "synthetic-key" }),
    completed({ ...success(), data: { configuration: "unconfigured", role: null, key: "synthetic-key" } }),
    completed({
      version: 1,
      operation: "status",
      ok: false,
      error: { code: "operation-failed", message: "synthetic-key" },
    }),
    completed({
      version: 1,
      operation: "status",
      ok: false,
      error: { code: "operation-failed", message: "fixed", stack: "synthetic-key" },
    }),
  ];
  for (const result of malformed) {
    const f = fixture(result);
    const response = await f.runner.run(request());
    assert.equal(code(response), "operation-failed");
    assert.equal(f.cleanups(), 1);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-key/);
    await f.runner.run(request());
    assert.equal(f.processes(), 2);
  }
});

test("mutation without a valid explicit response stays unknown even after safe child termination", async () => {
  const inputs: DesktopSetupRequest[] = [
    request("init"),
    {
      version: 1,
      operation: "join",
      input: { url: "https://example.test", worker: "worker-1", key: "synthetic-key" },
    },
  ];
  for (const input of inputs) {
    const success: DesktopSetupResponse =
      input.operation === "init"
        ? { version: 1, operation: "init", ok: true, data: { configuration: "configured", role: "hub-worker" } }
        : { version: 1, operation: "join", ok: true, data: { configuration: "configured", role: "worker" } };
    const results: LocalProcessResult[] = [
      completed(success, new Error("possibly-committed")),
      { state: "completed", output: Buffer.alloc(0), failure: null },
      { state: "completed", output: Buffer.from('{"version":1'), failure: null },
      { state: "completed", output: Buffer.alloc(DESKTOP_SETUP_RESPONSE_MAX_BYTES + 1), failure: null },
      completed({ ...success, operation: "status" }),
      completed({ ...success, version: 2 }),
      completed({ ...success, raw: "synthetic-key" }),
    ];
    for (const result of results) {
      const f = fixture(result);
      assert.equal(code(await f.runner.run(input)), "unknown");
      assert.equal(f.cleanups(), 0);
      assert.equal(code(await f.runner.run(input)), "unknown");
      assert.equal(f.processes(), 1);
    }
    for (const value of [success, desktopSetupFailure(input.operation, "operation-failed")]) {
      const f = fixture(completed(value));
      assert.deepEqual(await f.runner.run(input), value);
      assert.equal(f.cleanups(), 1);
      await f.runner.run(input);
      assert.equal(f.processes(), 2);
    }
  }
});

test("concurrent requests are busy through preparation and cleanup, never queued", async () => {
  const prepareReady = deferred<void>();
  const cleanupReady = deferred<void>();
  const cleanupEntered = deferred<void>();
  let prepares = 0;
  const runner = createSetupRunner({
    prepare: async (own) => {
      prepares++;
      own(async () => {
        cleanupEntered.resolve();
        await cleanupReady.promise;
      });
      await prepareReady.promise;
      return resources;
    },
    runProcess: async () => completed(),
  });
  const first = runner.run(request());
  assert.equal(code(await runner.run(request("check"))), "busy");
  prepareReady.resolve();
  await cleanupEntered.promise;
  assert.equal(code(await runner.run(request("init"))), "busy");
  cleanupReady.resolve();
  assert.equal((await first).ok, true);
  assert.equal(prepares, 1);
});

test("disabled, invalid requests and resource path failures never transfer process ownership", async () => {
  let prepares = 0;
  const disabled = createSetupRunner({
    enabled: false,
    prepare: async () => {
      prepares++;
      return resources;
    },
    runProcess: async () => {
      throw new Error("must not spawn");
    },
  });
  assert.equal(code(await disabled.run(request())), "unavailable");
  assert.equal(prepares, 0);
  const f = fixture();
  assert.equal(
    code(await f.runner.run({ ...request(), extra: "private" } as unknown as DesktopSetupRequest)),
    "invalid-request",
  );
  assert.equal(f.prepares(), 0);
  const badResources = [
    { ...resources, nodePath: "node" },
    { ...resources, entryPath: "/owned/sources/bin/agent-autoloop.ts" },
    { ...resources, entryPath: "/owned/sources/elsewhere/desktop-setup.ts" },
    { ...resources, environmentHome: resources.home },
  ];
  for (const prepared of badResources) {
    let cleaned = 0;
    const runner = createSetupRunner({
      prepare: async (own) => {
        own(async () => {
          cleaned++;
        });
        return prepared;
      },
      runProcess: async () => {
        throw new Error("must not spawn");
      },
    });
    assert.equal(code(await runner.run(request())), "operation-failed");
    assert.equal(cleaned, 1);
  }
});

test("timeout options are validated and forwarded without adding cancellation or signal APIs", async () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createSetupRunner({ prepare: async () => resources, timeoutMs: value }));
    assert.throws(() => createSetupRunner({ prepare: async () => resources, stopTimeoutMs: value }));
  }
  let observed: LocalProcessOptions | undefined;
  const runner = createSetupRunner({
    timeoutMs: 1234,
    stopTimeoutMs: 5678,
    prepare: async () => resources,
    runProcess: async (options) => {
      observed = options;
      return completed(desktopSetupFailure("init", "operation-failed"));
    },
  });
  await runner.run(request("init"));
  assert.equal(observed!.timeoutMs, 1234);
  assert.equal(observed!.stopTimeoutMs, 5678);
  assert.equal(observed!.mode, "mutation");
  assert.deepEqual(Object.keys(runner), ["run"]);
});
