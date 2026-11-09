// The lifecycle drive must fail closed on every wrong environment combination, build scripts
// that use only the real renderer bridge, and never let a sentinel wait run away.
import assert from "node:assert/strict";
import { DESKTOP_TASK_MESSAGES } from "../../host/desktop-task-contract.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LIFECYCLE_AGENT_ID,
  LIFECYCLE_MARKERS,
  LIFECYCLE_RULE_NAME,
  LIFECYCLE_SENTINEL_MAX_MS,
  LIFECYCLE_TASK_TYPE,
  lifecycleHubBusinessScript,
  lifecycleHubBusinessFinishScript,
  parseLifecycleTaskReceipt,
  lifecycleHubRunScript,
  lifecycleHubSetupScript,
  lifecycleWorkerStartScript,
  parseLifecycleEnv,
  runLifecycleHubDrive,
  runLifecycleWorkerDrive,
  waitForLifecycleSentinel,
  type LifecycleDrivePort,
} from "../src/lifecycle-drive.ts";

const TASK_DEADLINE = 123456;
const taskCreated = (routed: string[] = [LIFECYCLE_RULE_NAME]) => ({
  stage: "create", deadline: TASK_DEADLINE,
  created: { version: 3, outcome: "accepted", receipt: { version: 2, ok: true, result: { event: 1, duplicate: false, routed } } },
});
const base = { isPackaged: false, hasHome: true, smoke: false };
const validJoin = { url: "http://127.0.0.1:3350", worker: "smoke-worker", key: "k" };

test("lifecycle environment stays off without the flag and validates strictly when set", () => {
  assert.deepEqual(parseLifecycleEnv({}, base), { mode: "off" });
  assert.equal(parseLifecycleEnv({ DESKTOP_LIFECYCLE: "0" }, base).mode, "off");
  assert.deepEqual(
    parseLifecycleEnv(
      { DESKTOP_LIFECYCLE: "1", DESKTOP_LIFECYCLE_ROLE: "hub", DESKTOP_LIFECYCLE_RULE_CWD: "/tmp/x" },
      base,
    ),
    {
      mode: "hub",
      ruleCwd: "/tmp/x",
    },
  );
  assert.deepEqual(
    parseLifecycleEnv(
      {
        DESKTOP_LIFECYCLE: "1",
        DESKTOP_LIFECYCLE_ROLE: "worker",
        DESKTOP_LIFECYCLE_JOIN: JSON.stringify(validJoin),
        DESKTOP_LIFECYCLE_QUIT_SENTINEL: "/tmp/s",
      },
      base,
    ),
    { mode: "worker", join: validJoin, quitSentinel: "/tmp/s" },
  );
});

test("lifecycle environment refuses every wrong combination instead of misbehaving later", () => {
  assert.throws(() => parseLifecycleEnv({ DESKTOP_LIFECYCLE: "1" }, { ...base, isPackaged: true }), /开发模式/);
  assert.throws(() => parseLifecycleEnv({ DESKTOP_LIFECYCLE: "1" }, { ...base, hasHome: false }), /DESKTOP_HOME/);
  assert.throws(() => parseLifecycleEnv({ DESKTOP_LIFECYCLE: "1" }, { ...base, smoke: true }), /互斥/);
  assert.throws(() => parseLifecycleEnv({ DESKTOP_LIFECYCLE: "1" }, base), /ROLE=hub 或 worker/);
  assert.throws(() => parseLifecycleEnv({ DESKTOP_LIFECYCLE: "1", DESKTOP_LIFECYCLE_ROLE: "hub" }, base), /RULE_CWD/);
  // A relative cwd or sentinel would silently write business output somewhere unexpected.
  assert.throws(
    () =>
      parseLifecycleEnv(
        { DESKTOP_LIFECYCLE: "1", DESKTOP_LIFECYCLE_ROLE: "hub", DESKTOP_LIFECYCLE_RULE_CWD: "x" },
        base,
      ),
    /RULE_CWD/,
  );
  assert.throws(
    () =>
      parseLifecycleEnv(
        { DESKTOP_LIFECYCLE: "1", DESKTOP_LIFECYCLE_ROLE: "worker", DESKTOP_LIFECYCLE_JOIN: "not json" },
        base,
      ),
    /JSON/,
  );
  // The join input is checked by the shared contract, so a bad key or name is refused here too.
  assert.throws(() =>
    parseLifecycleEnv(
      {
        DESKTOP_LIFECYCLE: "1",
        DESKTOP_LIFECYCLE_ROLE: "worker",
        DESKTOP_LIFECYCLE_JOIN: JSON.stringify({ ...validJoin, worker: "Bad_Name" }),
      },
      base,
    ),
  );
  assert.throws(
    () =>
      parseLifecycleEnv(
        { DESKTOP_LIFECYCLE: "1", DESKTOP_LIFECYCLE_ROLE: "worker", DESKTOP_LIFECYCLE_JOIN: JSON.stringify(validJoin) },
        base,
      ),
    /SENTINEL/,
  );
});

test("lifecycle scripts drive only the real renderer bridge with bounded polling", () => {
  const scripts = [
    lifecycleHubSetupScript(),
    lifecycleHubRunScript(),
    lifecycleHubBusinessScript("/tmp/some cwd"),
    lifecycleHubBusinessFinishScript(TASK_DEADLINE),
    lifecycleWorkerStartScript(validJoin),
  ];
  for (const script of scripts) {
    assert.match(script, /\(async \(\) => \{/);
    assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|WebSocket|require\(|process\.|node:/);
  }
  // The setup script is two straight awaits — no wait to bound. Every polling script is bounded
  // by a deadline, so a stuck door can never hang the app.
  for (const script of scripts.slice(1)) {
    if (script === lifecycleHubBusinessFinishScript(TASK_DEADLINE)) {
      assert.match(script, new RegExp(`const deadline = ${TASK_DEADLINE};`));
      assert.match(script, /Date\.now\(\) < deadline/);
      assert.doesNotMatch(script, /Date\.now\(\) \+ \d+/);
    } else assert.match(script, /Date\.now\(\) \+ \d+|deadline = Date\.now\(\) \+ \d+/);
  }
  assert.match(lifecycleHubSetupScript(), /window\.desktop\.setupStatus\(\)/);
  assert.match(lifecycleHubSetupScript(), /window\.desktop\.initHub\(\)/);
  assert.match(lifecycleHubRunScript(), /window\.desktop\.runtimeStart\(\)/);
  assert.match(lifecycleHubRunScript(), /get\.state\.status === "running"/);
  const awkward = `/tmp/rule cwd'with"quotes`;
  const business = lifecycleHubBusinessScript(awkward);
  assert.match(business, /window\.desktop\.rulesGet\(\)/);
  assert.match(business, /window\.desktop\.rulesPut\(/);
  // The rule cwd is interpolated as JSON, so quotes and spaces in the directory cannot break out.
  assert.ok(
    business.includes(
      JSON.stringify({
        name: LIFECYCLE_RULE_NAME,
        types: [LIFECYCLE_TASK_TYPE],
        to: LIFECYCLE_AGENT_ID,
        cwd: awkward,
      }),
    ),
  );
  assert.match(business, /window\.desktop\.taskCreate\(/);
  assert.match(business, new RegExp(`type: "${LIFECYCLE_TASK_TYPE}"`));
  assert.match(business, /return \{ stage: "create", created, deadline \}/);
  const finish = lifecycleHubBusinessFinishScript(TASK_DEADLINE);
  assert.match(finish, /run\.state === "done"/);
  assert.match(finish, /window\.desktop\.todayState\(\)/);
  assert.match(finish, /window\.desktop\.runtimeStop\(\)/);
  assert.match(finish, /get\.state\.error === null/);
  assert.throws(() => lifecycleHubBusinessFinishScript(NaN));
  assert.throws(() => lifecycleHubBusinessFinishScript(-1));
  assert.throws(() => parseLifecycleTaskReceipt({ version: 2, ok: true, result: { event: 1, duplicate: false, routed: [] } }));
  assert.deepEqual(parseLifecycleTaskReceipt(taskCreated().created).routed, [LIFECYCLE_RULE_NAME]);
  const worker = lifecycleWorkerStartScript(validJoin);
  assert.match(worker, /window\.desktop\.setupStatus\(\)/);
  // The join input is interpolated as strict JSON, so nothing in it can break out of the call.
  assert.ok(worker.includes(`await window.desktop.joinWorker(${JSON.stringify(validJoin)})`));
  assert.match(worker, /get\.state\.role === "worker"/);
});

test("sentinel wait resolves on the file and always ends at its cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-test-"));
  try {
    const sentinel = join(directory, "quit");
    const pending = waitForLifecycleSentinel(sentinel, 5_000);
    await writeFile(sentinel, "");
    assert.equal(await pending, true);
    assert.equal(await waitForLifecycleSentinel(join(directory, "absent"), 1), false);
    assert.ok(LIFECYCLE_SENTINEL_MAX_MS > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function recorder() {
  const events: string[] = [];
  const port: LifecycleDrivePort = {
    evaluate: async (script) => {
      events.push(script);
      throw new Error("由具体用例覆盖");
    },
    requestQuit: async () => {
      events.push("quit");
    },
    abort: (message) => {
      events.push(`abort:${message}`);
    },
  };
  return { events, port };
}

test("hub drive prints its markers stage by stage and quits through the confirmed path", async () => {
  const { events, port } = recorder();
  port.evaluate = async (script) => {
    if (script === lifecycleHubSetupScript())
      return {
        status: { ok: true, data: { configuration: "unconfigured" } },
        init: { ok: true, data: { role: "hub-worker" } },
      };
    if (script === lifecycleHubRunScript())
      return { start: { ok: true }, running: { state: { status: "running", role: "hub-worker" } } };
    if (script === lifecycleHubBusinessScript("/tmp/r")) return taskCreated();
    assert.equal(script, lifecycleHubBusinessFinishScript(TASK_DEADLINE));
    return {
      stage: "ok",
      routed: [LIFECYCLE_RULE_NAME],
      summary: "冒烟 Agent 完成",
      todayReady: true,
      stopped: { state: { status: "stopped", error: null } },
    };
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: string) => void logs.push(line);
  try {
    await runLifecycleHubDrive(port, "/tmp/r");
  } finally {
    console.log = original;
  }
  assert.deepEqual(logs, [
    LIFECYCLE_MARKERS.hubInitOk,
    LIFECYCLE_MARKERS.hubRunning,
    `${LIFECYCLE_MARKERS.hubOk} ` +
      JSON.stringify({ routed: [LIFECYCLE_RULE_NAME], summary: "冒烟 Agent 完成", todayReady: true }),
  ]);
  assert.deepEqual(events, ["quit"]);
});

test("hub drive aborts on every unverified stage instead of continuing", async () => {
  const cases = [
    { status: { ok: true, data: { configuration: "configured" } }, init: { ok: true, data: { role: "hub-worker" } } },
    { status: { ok: true, data: { configuration: "unconfigured" } }, init: { ok: false } },
  ];
  for (const first of cases) {
    const { port } = recorder();
    let evaluations = 0;
    port.evaluate = async () => { evaluations++; return first; };
    let aborted = 0; port.abort = () => { aborted++; };
    await runLifecycleHubDrive(port, "/tmp/r");
    assert.equal(aborted, 1); assert.equal(evaluations, 1);
  }
  const runCases = [
    { start: { ok: true }, running: null },
    { start: { ok: true }, running: { state: { status: "running", role: "worker" } } },
  ];
  for (const second of runCases) {
    const { events, port } = recorder();
    let evaluations = 0;
    port.evaluate = async (script) => { evaluations++; return (
      script === lifecycleHubSetupScript()
        ? {
            status: { ok: true, data: { configuration: "unconfigured" } },
            init: { ok: true, data: { role: "hub-worker" } },
          }
        : second); };
    await runLifecycleHubDrive(port, "/tmp/r");
    assert.equal(evaluations, 2); assert.equal(events.length, 1); assert.match(events[0], /^abort:/);
  }
  const businessCases = [
    { stage: "agents" },
    { stage: "ok", routed: [], summary: "", todayReady: true, stopped: { state: { status: "stopped", error: null } } },
    taskCreated([]),
    { stage: "create", deadline: TASK_DEADLINE, created: { version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain } },
    { stage: "create", deadline: TASK_DEADLINE, created: { version: 2, ok: true, result: { event: 1, duplicate: false, routed: [LIFECYCLE_RULE_NAME] } } },
    { ...taskCreated(), deadline: NaN },
    {
      stage: "ok",
      routed: [LIFECYCLE_RULE_NAME],
      summary: "",
      todayReady: false,
      stopped: { state: { status: "stopped", error: null } },
    },
    {
      stage: "ok",
      routed: [LIFECYCLE_RULE_NAME],
      summary: "",
      todayReady: true,
      stopped: { state: { status: "unknown", error: { code: "safe-stop" } } },
    },
  ];
  for (const third of businessCases) {
    const { events, port } = recorder();
    port.evaluate = async (script) => {
      if (script === lifecycleHubSetupScript())
        return {
          status: { ok: true, data: { configuration: "unconfigured" } },
          init: { ok: true, data: { role: "hub-worker" } },
        };
      if (script === lifecycleHubRunScript())
        return { start: { ok: true }, running: { state: { status: "running", role: "hub-worker" } } };
      if (script === lifecycleHubBusinessScript("/tmp/r")) return third.stage === "ok" ? taskCreated(third.routed) : third;
      assert.equal(script, lifecycleHubBusinessFinishScript(TASK_DEADLINE));
      return third;
    };
    await runLifecycleHubDrive(port, "/tmp/r");
    assert.equal(events.length, 1);
    assert.match(events[0], /^abort:/);
  }
});

test("worker drive runs until the sentinel and then quits; a missing sentinel aborts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-test-"));
  try {
    const sentinel = join(directory, "quit");
    const good = (quit: string) => {
      const { events, port } = recorder();
      port.evaluate = async (script) => {
        if (script === lifecycleWorkerStartScript(validJoin))
          return {
            status: { ok: true, data: { configuration: "unconfigured" } },
            joined: { ok: true, data: { role: "worker" } },
            start: { ok: true },
            running: { state: { status: "running", role: "worker" } },
          };
        throw new Error("unexpected script");
      };
      return { events, port, quit };
    };
    const passing = good(sentinel);
    await writeFile(sentinel, "");
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => void logs.push(line);
    try {
      await runLifecycleWorkerDrive(passing.port, validJoin, passing.quit);
    } finally {
      console.log = original;
    }
    assert.deepEqual(logs, [LIFECYCLE_MARKERS.workerRunning]);
    assert.deepEqual(passing.events, ["quit"]);

    const absent = good(join(directory, "never"));
    // The capped wait keeps this failure case a millisecond-scale abort, not a 5-minute hang.
    await runLifecycleWorkerDrive(absent.port, validJoin, absent.quit, 1);
    assert.match(absent.events[0], /^abort:.*哨兵/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker drive aborts when join, start or readiness is unverified", async () => {
  const results = [
    {
      status: { ok: true, data: { configuration: "configured" } },
      joined: { ok: true, data: { role: "worker" } },
      start: { ok: true },
      running: { state: { status: "running", role: "worker" } },
    },
    {
      status: { ok: true, data: { configuration: "unconfigured" } },
      joined: { ok: false },
      start: { ok: true },
      running: null,
    },
    {
      status: { ok: true, data: { configuration: "unconfigured" } },
      joined: { ok: true, data: { role: "worker" } },
      start: { ok: false },
      running: null,
    },
    {
      status: { ok: true, data: { configuration: "unconfigured" } },
      joined: { ok: true, data: { role: "worker" } },
      start: { ok: true },
      running: null,
    },
  ];
  for (const result of results) {
    const { events, port } = recorder();
    port.evaluate = async () => result;
    await runLifecycleWorkerDrive(port, validJoin, "/tmp/sentinel-that-never-appears-so-this-aborts-first");
    // Every case aborts before the sentinel wait — reaching the wait would mean a bad state passed.
    assert.equal(events.length, 1);
    assert.match(events[0], /^abort:/);
  }
  // The smoke agent identity stays a single fixed fact shared with the driver.
  assert.equal(LIFECYCLE_AGENT_ID, "smoke-agent");
  assert.equal(LIFECYCLE_RULE_NAME, "冒烟入口");
  assert.equal(LIFECYCLE_TASK_TYPE, "smoke.ping");
});
