import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  DESKTOP_SETUP_ERROR_MESSAGES,
  DESKTOP_SETUP_REQUEST_MAX_BYTES,
  desktopSetupFailure,
  parseDesktopJoinInput,
  parseDesktopSetupRequest,
  parseDesktopSetupResponse,
} from "../host/desktop-setup-contract.ts";
import {
  createDesktopDiscovery,
  createDesktopSetupDriver,
  desktopSearchDirectories,
  desktopSetupPort,
  desktopSetupRuntimeSupported,
  DESKTOP_CONFIG_MAX_BYTES,
  DESKTOP_SETUP_PORT_VARIABLE,
  DESKTOP_SUPPORTED_NODE_MAJOR,
  DESKTOP_SYSTEM_DIRECTORIES,
  readDesktopSetupRequest,
  readDesktopSetupStatus,
  type DesktopSetupDependencies,
} from "../host/desktop-setup.ts";
import { runtimeTarget } from "../desktop/scripts/runtime.mjs";

const joinInput = { url: "https://hub.invalid", worker: "test-worker", key: " synthetic-key " };
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desktop-setup-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// All tests use synthetic private directories. No installed Agent, shell lookup or real HOME dependency.
test("contract accepts only the five exact v1 requests and preserves the join key", () => {
  for (const operation of ["status", "init", "launch-status"] as const) {
    assert.deepEqual(parseDesktopSetupRequest({ version: 1, operation }), { version: 1, operation });
    assert.throws(() => parseDesktopSetupRequest({ version: 1, operation, input: {} }));
    assert.throws(() => parseDesktopSetupRequest({ version: 1, operation, path: "/private" }));
  }
  assert.throws(() => parseDesktopSetupRequest({ version: 1, operation: "check" }));
  assert.deepEqual(parseDesktopSetupRequest({ version: 1, operation: "join", input: joinInput }), {
    version: 1,
    operation: "join",
    input: joinInput,
  });
  for (const value of [
    null,
    [],
    { version: 2, operation: "status" },
    { version: 1, operation: "exec" },
    { version: 1, operation: "join" },
    Object.assign(Object.create(null), { version: 1, operation: "status" }),
    { version: 1, operation: "status", [Symbol("hidden")]: true },
  ])
    assert.throws(() => parseDesktopSetupRequest(value));
  let getterCalls = 0;
  assert.throws(() =>
    parseDesktopSetupRequest({
      version: 1,
      get operation() {
        getterCalls++;
        return "status";
      },
    }),
  );
  assert.equal(getterCalls, 0);
});

test("join rejects oversized, malformed, inherited and secret-bearing extra input", () => {
  for (const url of [
    "file:///tmp/config",
    "ftp://hub.invalid",
    "http://user:pass@hub.invalid",
    "http://@hub.invalid",
    "http://hub.invalid?",
    "http://hub.invalid#",
    "http://hub.invalid/?q=x",
    "http://hub.invalid/#x",
    "http:\\hub.invalid",
    "http://hub.invalid\n",
    " http://hub.invalid",
    "http://hub.invalid/" + "a".repeat(2048),
  ]) {
    assert.throws(() => parseDesktopJoinInput({ ...joinInput, url }), url);
  }
  for (const worker of ["", "Worker", "1worker", "a_b", "a.b", "a/b", "a".repeat(129)]) {
    assert.throws(() => parseDesktopJoinInput({ ...joinInput, worker }));
  }
  assert.equal(parseDesktopJoinInput({ ...joinInput, worker: "a".repeat(128) }).worker.length, 128);
  for (const key of ["", "a".repeat(4097), "key\n", "key\x00", "key\x7f", "key\x85"]) {
    assert.throws(() => parseDesktopJoinInput({ ...joinInput, key }));
  }
  assert.equal(parseDesktopJoinInput({ ...joinInput, key: "a".repeat(4096) }).key.length, 4096);
  assert.throws(() => parseDesktopJoinInput({ ...joinInput, command: "launcher" }));
  assert.throws(() => parseDesktopJoinInput(Object.assign(Object.create({ injected: true }), joinInput)));
});

test("response parser reconstructs exact safe DTOs and refuses raw error or credentials", () => {
  const response = { version: 1, operation: "status", ok: true, data: { configuration: "configured", role: "worker" } };
  const parsed = parseDesktopSetupResponse(response, "status");
  assert.deepEqual(parsed, response);
  assert.notEqual(parsed, response);
  for (const malicious of [
    { ...response, key: "synthetic" },
    { ...response, version: 2 },
    { ...response, operation: "join" },
    { ...response, data: { ...response.data, key: "synthetic" } },
    { ...response, data: { configuration: "unconfigured", role: "worker" } },
    { ...response, data: { configuration: "configured", role: null } },
  ])
    assert.throws(() => parseDesktopSetupResponse(malicious, "status"), /invalid-response/);
  for (const code of Object.keys(DESKTOP_SETUP_ERROR_MESSAGES) as (keyof typeof DESKTOP_SETUP_ERROR_MESSAGES)[]) {
    const failure = desktopSetupFailure("join", code);
    assert.deepEqual(parseDesktopSetupResponse(failure, "join"), failure);
    assert.throws(() => parseDesktopSetupResponse({ ...failure, error: { code, message: "raw-secret" } }, "join"));
    assert.throws(() =>
      parseDesktopSetupResponse(
        { ...failure, error: { code, message: DESKTOP_SETUP_ERROR_MESSAGES[code], stack: "raw" } },
        "join",
      ),
    );
  }
  assert.throws(() =>
    parseDesktopSetupResponse(
      { version: 1, operation: "init", ok: true, data: { configuration: "configured", role: "worker" } },
      "init",
    ),
  );
});

test("stdin permits exactly one bounded JSON document and rejects malformed UTF-8", async () => {
  const input = async function* (buffers: Buffer[]) {
    yield* buffers;
  };
  assert.deepEqual(
    await readDesktopSetupRequest(input([Buffer.from('{"version":1,'), Buffer.from('"operation":"status"}')])),
    { version: 1, operation: "status" },
  );
  await assert.rejects(readDesktopSetupRequest(input([Buffer.from("{}{}")])));
  await assert.rejects(readDesktopSetupRequest(input([Buffer.from([0xff])])));
  await assert.rejects(readDesktopSetupRequest(input([Buffer.alloc(DESKTOP_SETUP_REQUEST_MAX_BYTES + 1)])));
});

test("status is read-only, bounded, role-validating and never follows config symlinks", (t) => {
  const root = fixture(t);
  const home = path.join(root, "not-created");
  assert.deepEqual(readDesktopSetupStatus(home), { configuration: "unconfigured", role: null });
  assert.equal(existsSync(home), false);
  mkdirSync(home);
  const config = path.join(home, "config.json");
  const write = (value: unknown) => writeFileSync(config, JSON.stringify(value));
  write({
    url: joinInput.url,
    worker: { name: joinInput.worker, key: joinInput.key, capacity: 2, unreachable: [] },
    channels: { custom: { key: "synthetic", option: { permitted: true } } },
  });
  assert.deepEqual(readDesktopSetupStatus(home), { configuration: "configured", role: "worker" });
  write({
    url: joinInput.url,
    worker: { name: joinInput.worker, key: joinInput.key },
    hub: { listen: "127.0.0.1:3350" },
    owner: "synthetic-owner",
    source: { name: "local", key: "synthetic-source" },
  });
  assert.deepEqual(readDesktopSetupStatus(home), { configuration: "configured", role: "hub-worker" });
  for (const bad of [
    null,
    {},
    { url: joinInput.url, worker: { name: "invalid_name", key: "x" } },
    { url: joinInput.url, worker: { name: "worker", key: "x" }, hub: { listen: "127.0.0.1:3350" } },
  ]) {
    write(bad);
    assert.deepEqual(readDesktopSetupStatus(home), { configuration: "invalid", role: null });
  }
  writeFileSync(config, "not-json secret");
  assert.equal(readDesktopSetupStatus(home).configuration, "invalid");
  writeFileSync(config, Buffer.alloc(DESKTOP_CONFIG_MAX_BYTES + 1));
  assert.equal(readDesktopSetupStatus(home).configuration, "invalid");
  rmSync(config);
  symlinkSync(path.join(root, "unreadable-target"), config);
  assert.equal(readDesktopSetupStatus(home).configuration, "invalid");
  rmSync(config);
  mkdirSync(config);
  assert.equal(readDesktopSetupStatus(home).configuration, "invalid");
  rmSync(config, { recursive: true });
  for (const marker of ["setup.pending.json", "setup.lock"]) {
    const file = path.join(home, marker);
    symlinkSync(path.join(root, "missing-content"), file);
    assert.deepEqual(readDesktopSetupStatus(home), { configuration: "incomplete", role: null });
    rmSync(file);
  }
  assert.deepEqual(readdirSync(home), []);
});

test("aliased home or parent is invalid and cannot acquire a mutation lock", async (t) => {
  const root = fixture(t);
  const actual = path.join(root, "actual");
  mkdirSync(actual);
  const alias = path.join(root, "alias");
  symlinkSync(actual, alias);
  for (const home of [alias, path.join(alias, "missing-child")]) {
    assert.deepEqual(readDesktopSetupStatus(home), { configuration: "invalid", role: null });
    const { driver, calls } = driverFixture(home);
    assert.deepEqual(await driver({ version: 1, operation: "init" }), desktopSetupFailure("init", "invalid-config"));
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(readdirSync(actual), []);
});

test("restricted discovery sees only fixed injected directories and never executes the launcher", (t) => {
  const root = fixture(t);
  const tools = path.join(root, "tools");
  mkdirSync(tools);
  const marker = path.join(root, "must-not-run");
  writeFileSync(path.join(tools, "claude"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  writeFileSync(path.join(tools, "codex"), "not executable", { mode: 0o600 });
  const discovery = createDesktopDiscovery([tools]);
  assert.equal(discovery.locate("claude"), path.join(tools, "claude"));
  assert.equal(discovery.locate("codex"), null);
  const turn = {
    prompt: "",
    session: "test",
    resume: null,
    cwd: root,
    access: "edit" as const,
    contextFile: "",
    folder: root,
    command: [discovery.locate("claude")!],
  };
  assert.equal(discovery.adapter("claude").command(turn)[0], path.join(tools, "claude"));
  chmodSync(path.join(tools, "codex"), 0o755);
  assert.equal(discovery.locate("codex"), path.join(tools, "codex"));
  assert.equal(
    discovery.adapter("codex").command({ ...turn, command: [discovery.locate("codex")!] })[0],
    path.join(tools, "codex"),
  );
  assert.equal(existsSync(marker), false);
  assert.throws(() => createDesktopDiscovery(["relative"]));
});

test("search directories come from the user's own PATH, and fall back to the fixed system set", () => {
  // The terminal's PATH is the only place a Homebrew or ~/.local/bin agent will be named.
  assert.deepEqual(desktopSearchDirectories("/opt/homebrew/bin:/Users/someone/.local/bin:/usr/bin:/bin"), [
    "/opt/homebrew/bin",
    "/Users/someone/.local/bin",
    "/usr/bin",
    "/bin",
  ]);
  // Duplicates collapse so each directory is probed once, in the order the terminal would.
  assert.deepEqual(desktopSearchDirectories("/usr/bin:/usr/bin:/bin"), ["/usr/bin", "/bin"]);
  // A relative or blank entry depends on an unknown cwd, so it never becomes a search root.
  assert.deepEqual(desktopSearchDirectories("relative::/usr/bin"), ["/usr/bin"]);
  // Nothing usable means the fixed system set: a shell that could not answer is not a guess.
  for (const value of [undefined, "", "relative"])
    assert.deepEqual(desktopSearchDirectories(value), [...DESKTOP_SYSTEM_DIRECTORIES]);
});

// Reject invalid allocator results before launch intent or config writes; valid boundaries never bind a socket.
for (const port of ["0", "80", "1023", "65536", "99999", "1024", "65535"]) {
  test(`L1 auto port boundary ${port}`, async (t) => {
    assert.equal(process.env[DESKTOP_SETUP_PORT_VARIABLE], undefined);
    const home = fixture(t);
    const valid = port === "1024" || port === "65535";
    const calls: string[] = [];
    const initOptions: unknown[] = [];
    let held = false;
    const discovery = createDesktopDiscovery([]);
    const driver = createDesktopSetupDriver({
      home,
      discovery,
      acquireLock() {
        assert.equal(held, false);
        held = true;
        calls.push("acquire");
        return {
          release() {
            assert.equal(held, true);
            held = false;
            calls.push("release");
          },
        };
      },
      async allocatePort() {
        assert.equal(held, true);
        calls.push("allocate");
        return port;
      },
      async init(options, restricted) {
        assert.equal(held, true);
        assert.equal(restricted, discovery);
        calls.push("init");
        initOptions.push(options);
        // Only a minimal synthetic config: no setup runtime, discovery execution, listener or network.
        writeFileSync(
          path.join(home, "config.json"),
          JSON.stringify({
            url: `http://127.0.0.1:${port}`,
            hub: { listen: `127.0.0.1:${port}` },
            worker: { name: "worker", key: "synthetic-worker" },
            owner: "synthetic-owner",
            source: { name: "local", key: "synthetic-source" },
          }),
        );
      },
      join() {
        calls.push("join");
        throw new Error("unexpected-join");
      },
    });
    assert.deepEqual(await driver({ version: 1, operation: "launch-status" }), {
      version: 1,
      operation: "launch-status",
      ok: true,
      data: { completion: "first-run", nextLaunch: null, current: null },
    });
    const response = await driver({ version: 1, operation: "init" });
    const launch = await driver({ version: 1, operation: "launch-status" });
    assert.deepEqual(
      {
        response,
        calls,
        held,
        initOptions,
        files: readdirSync(home).sort(),
        setup: readDesktopSetupStatus(home),
        launch,
      },
      {
        response: valid
          ? { version: 1, operation: "init", ok: true, data: { configuration: "configured", role: "hub-worker" } }
          : desktopSetupFailure("init", "operation-failed"),
        calls: valid ? ["acquire", "allocate", "init", "release"] : ["acquire", "allocate", "release"],
        held: false,
        initOptions: valid ? [{ allowNoAgent: true, port }] : [],
        files: valid ? ["config.json", "desktop-launch.json"] : [],
        setup: valid
          ? { configuration: "configured", role: "hub-worker" }
          : { configuration: "unconfigured", role: null },
        launch: {
          version: 1,
          operation: "launch-status",
          ok: true,
          data: valid
            ? { completion: "prepared", nextLaunch: "embedded", current: "embedded" }
            : { completion: "first-run", nextLaunch: null, current: null },
        },
      },
    );
  });
}

function driverFixture(home: string, changes: Partial<DesktopSetupDependencies> = {}) {
  const calls: string[] = [];
  let held = false;
  const discovery = createDesktopDiscovery([]);
  const dependencies: DesktopSetupDependencies = {
    home,
    allocatePort: async () => "3350", // Synthetic dependency; never listen or probe the real port.
    discovery,
    acquireLock() {
      assert.equal(held, false);
      held = true;
      calls.push("acquire");
      return {
        release() {
          assert.equal(held, true);
          calls.push("release");
          held = false;
        },
      };
    },
    async init(options, restricted) {
      assert.equal(held, true);
      assert.equal(restricted, discovery);
      assert.deepEqual(options, { allowNoAgent: true, port: "3350" });
      calls.push("init");
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({
          url: "http://127.0.0.1:3350",
          hub: { listen: "127.0.0.1:3350" },
          worker: { name: "worker", key: "generated-secret" },
          owner: "generated-owner",
          source: { name: "local", key: "generated-source" },
        }),
      );
    },
    join(input) {
      assert.equal(held, true);
      calls.push("join");
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ url: input.url, worker: { name: input.worker, key: input.key } }),
      );
    },
    ...changes,
  };
  return { driver: createDesktopSetupDriver(dependencies), calls };
}

test("driver locks around entire init/join, returns no credentials and refuses existing config", async (t) => {
  for (const operation of ["init", "join"] as const) {
    const home = fixture(t);
    const { driver, calls } = driverFixture(home);
    const request = operation === "join" ? { version: 1, operation, input: joinInput } : { version: 1, operation };
    const result = await driver(request);
    assert.deepEqual(result, {
      version: 1,
      operation,
      ok: true,
      data: { configuration: "configured", role: operation === "init" ? "hub-worker" : "worker" },
    });
    assert.deepEqual(calls, ["acquire", operation, "release"]);
    assert.doesNotMatch(JSON.stringify(result), /secret|owner|source|synthetic|command/);
    const before = readFileSync(path.join(home, "config.json"));
    assert.deepEqual(await driver(request), desktopSetupFailure(operation, "already-configured"));
    assert.deepEqual(readFileSync(path.join(home, "config.json")), before);
    assert.deepEqual(calls, ["acquire", operation, "release", "acquire", "release"]);
  }
});

test("driver completes only prepared policy under instance lock and leaves old configs unauthorized", async (t) => {
  const home = fixture(t);
  const { driver, calls } = driverFixture(home);
  assert.equal((await driver({ version: 1, operation: "complete" })).ok, false);
  assert.equal((await driver({ version: 1, operation: "init" })).ok, true);
  const before = await driver({ version: 1, operation: "launch-status" });
  assert.ok(before.ok && before.operation === "launch-status");
  assert.equal(before.data.completion, "prepared");
  assert.deepEqual(await driver({ version: 1, operation: "complete" }), {
    version: 1,
    operation: "complete",
    ok: true,
    data: { nextLaunch: "embedded" },
  });
  const after = await driver({ version: 1, operation: "launch-status" });
  assert.ok(after.ok && after.operation === "launch-status");
  assert.equal(after.data.completion, "complete");
  assert.deepEqual(calls, ["acquire", "release", "acquire", "init", "release", "acquire", "release"]);
  const legacy = fixture(t);
  writeFileSync(
    path.join(legacy, "config.json"),
    JSON.stringify({ url: joinInput.url, worker: { name: "worker", key: "fake" } }),
  );
  assert.equal((await driverFixture(legacy).driver({ version: 1, operation: "complete" })).ok, false);
});

test("driver status and invalid requests never acquire locks or invoke setup", async (t) => {
  const home = fixture(t);
  const { driver, calls } = driverFixture(home);
  assert.equal((await driver({ version: 1, operation: "status" })).ok, true);
  assert.deepEqual(
    await driver({ version: 1, operation: "join", input: { ...joinInput, use: "evil" } }),
    desktopSetupFailure("join", "invalid-request"),
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(home), []);
});

test("driver fails closed for busy, incomplete, invalid, post-commit and release failures", async (t) => {
  const home = fixture(t);
  const request = { version: 1, operation: "init" };
  const busy = new Error("secret raw busy");
  busy.name = "RunLockBusyError";
  assert.deepEqual(
    await driverFixture(home, {
      acquireLock() {
        throw busy;
      },
    }).driver(request),
    desktopSetupFailure("init", "busy"),
  );
  for (const marker of ["setup.lock", "setup.pending.json"]) {
    writeFileSync(path.join(home, marker), "secret contents must not be read");
    const { driver, calls } = driverFixture(home);
    assert.deepEqual(await driver(request), desktopSetupFailure("init", "incomplete-setup"));
    assert.deepEqual(calls, ["acquire", "release"]);
    rmSync(path.join(home, marker));
  }
  writeFileSync(path.join(home, "config.json"), "secret invalid json");
  assert.deepEqual(await driverFixture(home).driver(request), desktopSetupFailure("init", "invalid-config"));
  rmSync(path.join(home, "config.json"));
  assert.deepEqual(
    await driverFixture(home, {
      async init() {
        throw new Error("raw secret failure");
      },
    }).driver(request),
    desktopSetupFailure("init", "unknown"), // Pending intent remains: never silently authorize a retry.
  );
  rmSync(path.join(home, "desktop-launch.pending.json"));
  assert.deepEqual(
    await driverFixture(home, {
      acquireLock() {
        return {
          release() {
            throw new Error("raw release secret");
          },
        };
      },
      async init() {},
    }).driver(request),
    desktopSetupFailure("init", "unknown"),
  );
  rmSync(path.join(home, "desktop-launch.pending.json"));
  assert.deepEqual(
    await driverFixture(home, {
      async init() {
        writeFileSync(
          path.join(home, "config.json"),
          JSON.stringify({ url: joinInput.url, worker: { name: "worker", key: "secret" } }),
        );
        throw new Error("post-commit cleanup secret");
      },
    }).driver(request),
    desktopSetupFailure("init", "unknown"),
  );
});

// Full pure-setup integration runs only in a private process: HOME is established before any business import.
function isolated(t: TestContext, source: string) {
  // Register cleanup only after safe successful process completion; failures retain private evidence.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desktop-setup-process-")));
  const home = path.join(root, "data");
  const privateHome = path.join(root, "private-home");
  const tools = path.join(root, "tools");
  mkdirSync(privateHome);
  mkdirSync(tools);
  const env = {
    HOME: privateHome,
    USERPROFILE: privateHome,
    XDG_CONFIG_HOME: privateHome,
    XDG_CACHE_HOME: privateHome,
    TMPDIR: root,
    AGENT_AUTOLOOP_HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
  const url = new URL("../host/desktop-setup.ts", import.meta.url).href;
  const setupUrl = new URL("../host/setup.ts", import.meta.url).href;
  const runlockUrl = new URL("../host/runlock.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import path from 'node:path';
    const home = ${JSON.stringify(home)}, tools = ${JSON.stringify(tools)}, privateHome = ${JSON.stringify(privateHome)};
    const desktop = await import(${JSON.stringify(url)});
    const setup = await import(${JSON.stringify(setupUrl)});
    const runlock = await import(${JSON.stringify(runlockUrl)});
    const discovery = desktop.createDesktopDiscovery([tools]);
    const driver = desktop.createDesktopSetupDriver({home, discovery, acquireLock: runlock.acquireRunLock,
      init: setup.initSetup, join: setup.joinSetup, allocatePort: async () => '3350'});
    ${source}
  `,
    ],
    { env, cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 },
  );
  assert.equal(child.error, undefined, child.error?.message ?? "isolated setup process failed");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  t.after(() => rmSync(root, { recursive: true, force: true }));
}

test("isolated real run lock competition rejects setup; worker-only join creates no hub artifacts", (t) => {
  isolated(
    t,
    `
    const held = runlock.acquireRunLock();
    const {spawnSync} = await import('node:child_process');
    const probe = spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',
      ${JSON.stringify(`const locks = await import(${JSON.stringify(new URL("../host/runlock.ts", import.meta.url).href)}); try { const lock = locks.acquireRunLock(); lock.release(); process.exitCode = 7; } catch(error) { if (error.name !== 'RunLockBusyError') throw error; }`)}
    ],{env:process.env,encoding:'utf8'});
    assert.equal(probe.error,undefined); assert.equal(probe.status,0,probe.stderr);
    const refused = await driver({version:1,operation:'join',input:{url:'https://hub.invalid',worker:'worker',key:'synthetic'}});
    assert.equal(refused.ok,false); assert.equal(refused.error.code,'busy'); assert.ok(!fs.existsSync(path.join(home,'config.json')));
    held.release();
    const result = await driver({version:1,operation:'join',input:{url:'https://hub.invalid',worker:'worker',key:' synthetic '}});
    assert.deepEqual(result,{version:1,operation:'join',ok:true,data:{configuration:'configured',role:'worker'}});
    assert.equal(JSON.parse(fs.readFileSync(path.join(home,'config.json'))).worker.key,' synthetic ');
    for(const file of ['hub.db','master.key','rules.json','setup.lock','setup.pending.json','up.pid']) assert.ok(!fs.existsSync(path.join(home,file)),file);
    assert.ok(fs.existsSync(path.join(home,'up.lock.db')));
  `,
  );
});

test("isolated init uses bundled adapters and private absolute launchers without HOME plugin execution", (t) => {
  isolated(
    t,
    `
    const marker = path.join(privateHome,'must-not-run');
    fs.mkdirSync(path.join(home,'plugins','claude'),{recursive:true});
    fs.writeFileSync(path.join(home,'plugins','claude','agent.ts'), "throw new Error('HOME plugin must not load')");
    for(const id of ['claude','codex']) fs.writeFileSync(path.join(tools,id),'#!/bin/sh\\nprintf executed > ' + JSON.stringify(marker) + '\\nexit 99\\n',{mode:0o755});
    const found = await setup.agentsToUse({},'worker',discovery);
    assert.deepEqual(Object.keys(found),['claude','codex']);
    for(const id of ['claude','codex']) assert.deepEqual(found[id].command,[path.join(tools,id)]);
    const result = await driver({version:1,operation:'init'});
    assert.deepEqual(result,{version:1,operation:'init',ok:true,data:{configuration:'configured',role:'hub-worker'}});
    const config = JSON.parse(fs.readFileSync(path.join(home,'config.json')));
    assert.equal(config.url,'http://127.0.0.1:3350'); assert.ok(config.owner);
    const rules = JSON.parse(fs.readFileSync(path.join(home,'rules.json')));
    for(const id of ['claude','codex']) assert.deepEqual(rules.agents[id].command,[path.join(tools,id)]);
    assert.ok(!JSON.stringify(result).includes(config.owner));
    assert.ok(!fs.existsSync(marker)); assert.ok(!fs.existsSync(path.join(home,'setup.lock')));
    assert.ok(!fs.existsSync(path.join(home,'setup.pending.json'))); assert.ok(!fs.existsSync(path.join(home,'up.pid')));
  `,
  );
});

test("isolated direct entry accepts one stdin request and emits only a safe fd3 response", (t) => {
  // The entry refuses Electron's Node and whatever `node` the PATH offers; production always runs
  // it on the pinned, checksum-verified runtime. Test the shipped path, not the developer's node.
  const runtime = runtimeTarget();
  const node = fileURLToPath(new URL(`../desktop/.cache/runtime/${runtime.root}/bin/node`, import.meta.url));
  if (!existsSync(node)) {
    t.skip(`固定运行时未下载（${runtime.root}）；先运行 npm --prefix desktop run runtime:check`);
    return;
  }
  isolated(
    t,
    `
    const {spawnSync} = await import('node:child_process');
    const entry = ${JSON.stringify(new URL("../host/desktop-setup.ts", import.meta.url).pathname)};
    const run = (input,extra=[]) => spawnSync(${JSON.stringify(node)},['--disable-warning=ExperimentalWarning',entry,...extra],
      {env:process.env,cwd:privateHome,input,encoding:'utf8',stdio:['pipe','pipe','pipe','pipe']});
    const result = run(JSON.stringify({version:1,operation:'status'}));
    assert.equal(result.error,undefined); assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,'');
    assert.deepEqual(JSON.parse(result.output[3]),{version:1,operation:'status',ok:true,data:{configuration:'unconfigured',role:null}});
    assert.ok(!fs.existsSync(home));
    for(const input of ['{}{}','x','x'.repeat(16385)]) {
      const bad = run(input); assert.equal(bad.status,0); assert.equal(JSON.parse(bad.output[3]).error.code,'invalid-request');
    }
    const extra = run('{}',['extra']); assert.equal(extra.status,0); assert.equal(JSON.parse(extra.output[3]).error.code,'invalid-request');
  `,
  );
});

test("the direct entry refuses every runtime that was not the verified independent Node", async () => {
  const runtime = runtimeTarget();
  // process.versions.node has no leading "v"; normalize the pinned version the same way.
  const node = runtime.version.slice(1);
  // The gate is the only thing keeping first run off Electron's embedded Node and the user's PATH.
  assert.equal(desktopSetupRuntimeSupported({ node }, "darwin"), true);
  assert.equal(desktopSetupRuntimeSupported({ node }, "linux"), true);
  assert.equal(desktopSetupRuntimeSupported({ node, electron: "45.2.3" }), false);
  assert.equal(desktopSetupRuntimeSupported({ node: "26.1.0" }, "darwin"), false);
  assert.equal(desktopSetupRuntimeSupported({ node: "23.99.0" }, "darwin"), false);
  assert.equal(desktopSetupRuntimeSupported({ node }, "win32"), false);
  assert.equal(desktopSetupRuntimeSupported({}, "darwin"), false);
  // A runtime bump that forgets the gate would strand every real user at first run.
  assert.equal(
    Number(node.split(".")[0]),
    DESKTOP_SUPPORTED_NODE_MAJOR,
    "DESKTOP_SUPPORTED_NODE_MAJOR 必须与 desktop/scripts/runtime.mjs 的 NODE_VERSION 主版本一致",
  );
});

test("isolated init allows configuration before any Agent is installed", (t) => {
  isolated(
    t,
    `
    const result = await driver({version:1,operation:'init'}); assert.equal(result.ok,true);
    const rules = JSON.parse(fs.readFileSync(path.join(home,'rules.json')));
    assert.deepEqual(rules.agents,{}); assert.deepEqual(rules.rules,[]);
  `,
  );
});

test("the hub port knob defaults to 3350, accepts only real port numbers and refuses junk", async (t) => {
  assert.equal(desktopSetupPort({}), "auto");
  assert.equal(desktopSetupPort({ [DESKTOP_SETUP_PORT_VARIABLE]: undefined }), "auto");
  assert.equal(desktopSetupPort({ [DESKTOP_SETUP_PORT_VARIABLE]: "3351" }), "3351");
  assert.equal(desktopSetupPort({ [DESKTOP_SETUP_PORT_VARIABLE]: "65535" }), "65535");
  for (const junk of ["", "x", "0", "1023", "65536", "80", " 3351", "3351 ", "99999"])
    assert.equal(desktopSetupPort({ [DESKTOP_SETUP_PORT_VARIABLE]: junk }), null, junk);
  // A wrong value must fail the operation, never fall back to a guessed default port.
  process.env[DESKTOP_SETUP_PORT_VARIABLE] = "99999";
  t.after(() => delete process.env[DESKTOP_SETUP_PORT_VARIABLE]);
  const home = fixture(t);
  const { driver } = driverFixture(home, {
    async init() {
      throw new Error("invalid port must never reach setup");
    },
  });
  assert.deepEqual(await driver({ version: 1, operation: "init" }), desktopSetupFailure("init", "invalid-config"));
  assert.equal(await driver({ version: 1, operation: "join", input: joinInput }).then((r) => r.ok), false);
  // A good value reaches init exactly once, as the port the caller asked for.
  process.env[DESKTOP_SETUP_PORT_VARIABLE] = "3351";
  const second = fixture(t);
  const { driver: retry, calls } = driverFixture(second, {
    async init(options) {
      assert.deepEqual(options, { allowNoAgent: true, port: "3351" });
      calls.push("init");
      writeFileSync(
        path.join(second, "config.json"),
        JSON.stringify({
          url: "http://127.0.0.1:3351",
          hub: { listen: "127.0.0.1:3351" },
          worker: { name: "worker", key: "generated-secret" },
          owner: "generated-owner",
          source: { name: "local", key: "generated-source" },
        }),
      );
    },
  });
  assert.equal((await retry({ version: 1, operation: "init" })).ok, true);
  assert.deepEqual(calls, ["acquire", "init", "release"]);
});
