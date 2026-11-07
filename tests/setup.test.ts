// Setup is a private-process API, not a service installer or a renderer credential API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "autoloop-setup-"));
// Keep evidence, including HOME, on any unexpected child outcome.
let preserveEvidence = false;
afterEach((context) => {
  if (!context.passed) preserveEvidence = true;
});
after(() => {
  if (!preserveEvidence) rmSync(root, { recursive: true, force: true });
  else console.error(`setup evidence retained: ${root}`);
});
const setupUrl = pathToFileURL(join(import.meta.dirname, "../host/setup.ts")).href;
const cli = join(import.meta.dirname, "../bin/agent-autoloop.ts");
let count = 0;
function computer(installed = true) {
  assert.ok(!preserveEvidence, `previous unexpected outcome; retained ${root}`);
  const home = join(root, `person-${++count}`);
  const data = join(home, "private-app-hub");
  const tools = join(home, "tools");
  const calls = join(home, "calls");
  mkdirSync(tools, { recursive: true });
  for (const agent of [".claude", ".codex"]) mkdirSync(join(home, agent));
  const executable = (name: string, body: string) => {
    const file = join(tools, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  for (const name of ["launchctl", "systemctl", "claude", "codex", "wrapper"]) {
    executable(
      name,
      `printf '%s\\n' '${name}'\" $*\" >> '${calls}'\ncase \"$*\" in\n'auth status') printf '{\"loggedIn\":true}' ;;\n'login status'|'codex login status') exit 0 ;;\n*) exit 93 ;;\nesac`,
    );
  }
  const shell = join(tools, "lookup");
  executable(
    "lookup",
    installed
      ? `case "$4" in\n'claude') printf '%s' '${join(tools, "claude")}' ;;\n'codex') printf '%s' '${join(tools, "codex")}' ;;\n'wrapper') printf '%s' '${join(tools, "wrapper")}' ;;\nesac`
      : "exit 1",
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    LANG: "C.UTF-8",
    AGENT_AUTOLOOP_HOME: data,
    AGENT_AUTOLOOP_RULES: join(data, "rules.json"),
    SHELL: shell,
    PATH: tools,
  };
  // Hide bundled macOS executables as well as PATH: the test must not depend on installed applications.
  const blockApps = `const appFs = (await import('node:fs')).default; const appExists = appFs.existsSync; appFs.existsSync = (file) => String(file).startsWith('/Applications/') ? false : appExists(file); (await import('node:module')).syncBuiltinESMExports();`;
  // Inject the same isolation into the innermost -e checker, before adapter imports. No production switch.
  const isolateApps = `${blockApps}
    const checkCp = (await import('node:child_process')).default; const checkSpawn = checkCp.spawn;
    checkCp.spawn = (program, args, options) => { const copied = [...args]; const index = copied.indexOf('-e'); if (index >= 0) copied[index + 1] = ${JSON.stringify(blockApps)} + copied[index + 1]; return checkSpawn(program, copied, options); };
    (await import('node:module')).syncBuiltinESMExports();`;
  // HOME and lookup shell are set before any application import (including host/home.ts).
  const run = (body: string) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import path from 'node:path'; const home = process.env.AGENT_AUTOLOOP_HOME; ${isolateApps} const setup = await import(${JSON.stringify(setupUrl)}); ${body}`,
      ],
      { env, encoding: "utf8", timeout: 30_000 },
    );
  const runCli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${isolateApps} await import(${JSON.stringify(pathToFileURL(cli).href)});`,
        cli,
        ...args,
      ],
      { env, encoding: "utf8", timeout: 30_000 },
    );
  const ok = (body: string) => {
    assert.ok(!preserveEvidence, `previous unexpected outcome; retained ${root}`);
    const result = run(body);
    if (result.status !== 0 || result.error || result.signal) preserveEvidence = true;
    assert.equal(result.status, 0, result.stderr + result.stdout + String(result.error ?? ""));
  };
  const noGlobalEffects = () => {
    for (const agent of [".claude", ".codex"]) assert.ok(!existsSync(join(home, agent, "skills")));
    if (existsSync(calls)) assert.doesNotMatch(readFileSync(calls, "utf8"), /launchctl|systemctl| -p | exec /);
  };
  return { home, data, calls, ok, runCli, noGlobalEffects };
}

test("check failure waits for exit, close and owned group before rejecting; no strong kill", () => {
  const it = computer();
  it.ok(`const cp = (await import('node:child_process')).default; const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream');
    const child = new EventEmitter(); child.pid = 424242; child.stdin = new PassThrough(); const result = new PassThrough(); child.stdio = [child.stdin, null, null, result];
    let exited = false, closed = false; const signals = []; child.kill = signal => {signals.push(signal); queueMicrotask(() => {exited = true; child.emit('exit', null, signal); setTimeout(() => {closed = true; child.emit('close', null, signal)}, 15)}); return true};
    cp.spawn = (file, args, options) => {assert.equal(file, process.execPath); assert.equal(options.env, undefined); assert.equal(options.shell, false); assert.equal(options.detached, process.platform !== 'win32'); assert.deepEqual(options.stdio, ['pipe','ignore','ignore','pipe']); assert.deepEqual(args.slice(0,3), ['--disable-warning=ExperimentalWarning','--input-type=module','-e']); queueMicrotask(() => {child.emit('spawn'); child.stdin.emit('error', new Error('injected stdin failure'))}); return child};
    cp.execFileSync = () => closed ? '1 1 S' : '424242 424242 Thu Jan 1 00:00:00 2026'; process.kill = (pid, signal) => {assert.equal(pid, -424242); return child.kill(signal)}; (await import('node:module')).syncBuiltinESMExports();
    await assert.rejects(setup.checkLocalAgents(), /injected stdin failure/); assert.ok(exited); assert.ok(closed); assert.deepEqual(signals, ['SIGTERM']); assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdin.listenerCount('error'), 0); assert.equal(result.listenerCount('data'), 0);`);
});

test("check terminal paths settle once and clean timers and listeners", () => {
  for (const scenario of [
    "spawn",
    "fd3",
    "overlimit",
    "timeout",
    "json",
    "exit",
    "success",
    "stdin-throw",
    "spawn-throw",
  ]) {
    const it = computer();
    it.ok(`const cp = (await import('node:child_process')).default; const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream'); const scenario = ${JSON.stringify(scenario)};
      const child = new EventEmitter(); child.pid = scenario === 'spawn' ? undefined : 424242; child.stdin = new PassThrough(); const result = new PassThrough(); child.stdio = [child.stdin, null, null, result];
      let closed = false, settles = 0; const signals = []; const close = code => {child.emit('exit', code); setTimeout(() => {closed = true; child.emit('close', code)}, 5)};
      if(scenario === 'stdin-throw') child.stdin.end = () => {throw new Error('stdin failure')};
      cp.spawn = () => {if(scenario === 'spawn-throw') {closed = true; throw new Error('spawn synchronous failure')} queueMicrotask(() => {
        if(scenario === 'spawn') {child.emit('error', new Error('spawn failure')); closed = true; child.emit('close', -2); return}
        child.emit('spawn');
        if(scenario === 'fd3') {result.emit('error', new Error('fd3 failure')); child.stdin.emit('error', new Error('secondary failure'))}
        if(scenario === 'overlimit') {result.emit('data', Buffer.alloc(1024*1024+1)); result.emit('data', Buffer.from('[]'))}
        if(scenario === 'stdin-throw') child.stdin.emit('error', new Error('stdin failure'));
        if(['json','exit','success'].includes(scenario)) {result.emit('data', Buffer.from(scenario === 'json' ? 'bad' : '[]')); close(scenario === 'exit' ? 7 : 0)}
      }); return child};
      cp.execFileSync = () => closed ? '1 1 S' : '424242 424242 Thu Jan 1 00:00:00 2026'; process.kill = (pid, signal) => {assert.equal(pid, -424242); signals.push(signal); close(null); return true}; (await import('node:module')).syncBuiltinESMExports();
      const outcome = await setup.checkLocalAgents({}, {timeoutMs: 20, stopTimeoutMs: 100}).then(value => {settles++; return {value}}, error => {settles++; return {error}});
      if(scenario === 'success') assert.deepEqual(outcome.value, []); else {assert.ok(outcome.error); assert.doesNotMatch(outcome.error.message, /受阻/); const expected = {spawn:'spawn failure', fd3:'fd3 failure',overlimit:'结果过大',timeout:'超时',json:'结构化结果',exit:'退出码 7','stdin-throw':'stdin failure','spawn-throw':'spawn synchronous failure'}; assert.ok(outcome.error.message.includes(expected[scenario]), outcome.error.message)}
      assert.ok(closed); assert.equal(settles, 1); assert.ok(signals.every(x => x === 'SIGTERM')); assert.ok(signals.length <= 1); assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdin.listenerCount('error'), 0); assert.equal(result.listenerCount('data'), 0);
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(settles, 1);`);
  }
});

test("unconfirmed group, identity mismatch and stop errors preserve original failure and block recheck", () => {
  for (const scenario of ["group", "identity", "signal", "ps", "no-close"]) {
    const it = computer();
    it.ok(`const cp = (await import('node:child_process')).default; const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream'); const scenario = ${JSON.stringify(scenario)};
      const child = new EventEmitter(); child.pid = 424242; child.stdin = new PassThrough(); const result = new PassThrough(); child.stdio = [child.stdin, null, null, result]; let probes = 0, launches = 0; const signals = [];
      cp.spawn = () => {launches++; queueMicrotask(() => {child.emit('spawn'); result.emit('error', new Error('original fd3 failure'))}); return child};
      cp.execFileSync = (program, args) => {assert.equal(program, '/bin/ps'); if(args[0] === '-p') {probes++; return scenario === 'identity' && probes > 1 ? '424242 999 S other' : '424242 424242 Thu Jan 1 00:00:00 2026'} if(scenario === 'ps') throw new Error('ps failure'); return scenario === 'group' ? '123 424242 S' : '1 1 S'};
      process.kill = (pid, signal) => {assert.equal(pid, -424242); signals.push(signal); if(scenario === 'signal') throw new Error('signal failure'); child.emit('exit', null, signal); if(scenario !== 'no-close') child.emit('close', null, signal); return true}; (await import('node:module')).syncBuiltinESMExports();
      let error; await assert.rejects(setup.checkLocalAgents({}, {timeoutMs:20, stopTimeoutMs:40}), value => {error = value; assert.match(value.message, /受阻.*original fd3 failure.*清理失败/); assert.ok(value.cause instanceof AggregateError); return true});
      await assert.rejects(setup.checkLocalAgents(), value => value === error); assert.equal(launches, 1); assert.deepEqual(signals, scenario === 'identity' ? [] : ['SIGTERM']); assert.equal(result.listenerCount('data'), 0);`);
  }
});

test("malformed or empty ps membership is unknown, never an empty group", () => {
  for (const row of ["", "garbage", "123 424242", "123 wrong S"]) {
    const it = computer();
    it.ok(`const cp = (await import('node:child_process')).default; const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream');
      const child = new EventEmitter(); child.pid = 424242; child.stdin = new PassThrough(); child.stdio = [child.stdin,null,null,new PassThrough()]; let launches = 0;
      cp.spawn = () => {launches++; queueMicrotask(() => {child.emit('spawn'); child.emit('exit',0); child.emit('close',0)}); return child};
      cp.execFileSync = (file,args) => args[0] === '-p' ? '424242 424242 Thu Jan 1 00:00:00 2026' : ${JSON.stringify(row)}; process.kill = () => {assert.fail('must not signal exited leader')}; (await import('node:module')).syncBuiltinESMExports();
      await assert.rejects(setup.checkLocalAgents({}, {stopTimeoutMs:40}), /受阻.*进程组查询结果无效/); await assert.rejects(setup.checkLocalAgents(), /受阻/); assert.equal(launches,1);`);
  }
});

test("capture failure and already exited or closed child stay unknown without signalling", () => {
  for (const scenario of ["capture", "early-exit", "early-close", "leader-exited-descendant"]) {
    const it = computer();
    it.ok(`const cp = (await import('node:child_process')).default; const {EventEmitter} = await import('node:events'); const {PassThrough} = await import('node:stream'); const scenario = ${JSON.stringify(scenario)};
      const child = new EventEmitter(); child.pid = 424242; child.stdin = new PassThrough(); child.stdio = [child.stdin,null,null,new PassThrough()]; let launches = 0;
      cp.spawn = () => {launches++; queueMicrotask(() => {if(scenario === 'early-exit') child.emit('exit',0); if(scenario === 'early-close') child.emit('close',0); child.emit('spawn'); if(scenario !== 'early-exit') child.emit('exit',0); if(scenario !== 'early-close') child.emit('close',0)}); return child};
      cp.execFileSync = (file,args) => {if(args[0] === '-p') {if(scenario !== 'leader-exited-descendant') throw new Error('identity capture failure'); return '424242 424242 Thu Jan 1 00:00:00 2026'} return '123 424242 S'};
      process.kill = () => {assert.fail('unknown/exited leader cannot authorize stop')}; (await import('node:module')).syncBuiltinESMExports();
      await assert.rejects(setup.checkLocalAgents({}, {stopTimeoutMs:40}), /受阻/); await assert.rejects(setup.checkLocalAgents(), /受阻/); assert.equal(launches,1);`);
  }
});

test("blocked check absorbs delayed real pipe EPIPE until the bounded child closes", () => {
  const it = computer();
  it.ok(`const cp = (await import('node:child_process')).default; const original = cp.spawn; let child, closed = false;
    cp.spawn = (program, args, options) => {child = original(program, ['--input-type=module','-e', ${JSON.stringify(`import {writeFileSync} from 'node:fs'; process.on('SIGTERM', () => {}); setTimeout(() => {writeFileSync(${JSON.stringify(it.calls)}, 'self-exited\\n'); process.exit(0)}, 600);`)}], options); child.on('close', () => {closed = true}); return child}; (await import('node:module')).syncBuiltinESMExports();
    const pending = setup.checkLocalAgents({large:{use:'command',command:['x'.repeat(8*1024*1024)]}}, {timeoutMs:200,stopTimeoutMs:30});
    await assert.rejects(pending, /受阻/); assert.equal(closed,false); assert.ok(child.stdin.listenerCount('error') > 0); assert.ok(child.stdio[3].listenerCount('error') > 0);
    await new Promise(resolve => child.once('close', resolve)); assert.equal(child.stdin.errored?.code, 'EPIPE'); assert.equal(fs.readFileSync(${JSON.stringify(it.calls)}, 'utf8'), 'self-exited\\n');
    assert.equal(child.stdin.listenerCount('error'),0); assert.equal(child.stdio[3].listenerCount('error'),0); await assert.rejects(setup.checkLocalAgents(), /受阻/);`);
});

test("short-deadline fake adapter receives controlled stop before timeout is reported", () => {
  const it = computer();
  const plugin = join(it.data, "plugins", "waiting");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "agent.ts"),
    `import {appendFileSync} from 'node:fs'; const log = ${JSON.stringify(it.calls)}; appendFileSync(log, 'loaded\\n'); process.on('SIGTERM', () => {appendFileSync(log, 'SIGTERM\\n'); process.exit(0)}); setInterval(() => {}, 50); export default {command(){throw new Error('never run')}, read(){return {}}, check(){return null}};`,
  );
  it.ok(
    `await assert.rejects(setup.checkLocalAgents({waiting:{use:'waiting'}}, {timeoutMs:500, stopTimeoutMs:1000}), /检查超时/); assert.equal(fs.readFileSync(${JSON.stringify(it.calls)}, 'utf8'), 'loaded\\nSIGTERM\\n');`,
  );
  it.noGlobalEffects();
});

test("missing built-ins cannot reach Applications fallback in the innermost checker", () => {
  const it = computer(false);
  it.ok(
    `const checks = await setup.checkLocalAgents(); assert.deepEqual(checks.map(x => x.available), [false, false]); assert.ok(checks.every(x => /找不到/.test(x.problem))); assert.ok(!fs.existsSync(home));`,
  );
  assert.ok(!existsSync(it.calls));
});

test("committed config remains authoritative when pending or lock cleanup fails", () => {
  for (const cleanup of ["setup.pending.json", "setup.lock"]) {
    const it = computer();
    it.ok(`const builtinFs = (await import('node:fs')).default; const original = builtinFs.rmSync; builtinFs.rmSync = (file, ...args) => {if(String(file) === path.join(home, ${JSON.stringify(cleanup)})) throw new Error('cleanup failure'); return original(file, ...args)}; (await import('node:module')).syncBuiltinESMExports();
      try {await assert.rejects(setup.initSetup({command:'wrapper'}), /cleanup failure/)} finally {builtinFs.rmSync = original; (await import('node:module')).syncBuiltinESMExports()}
      const config = fs.readFileSync(path.join(home, 'config.json')); const pending = fs.existsSync(path.join(home, 'setup.pending.json')) ? fs.readFileSync(path.join(home, 'setup.pending.json')) : null;
      await assert.rejects(setup.initSetup({command:'wrapper other'}), /已经装过了/); assert.throws(() => setup.joinSetup({url:'https://hub.invalid',worker:'other',key:'other'}), /已经装过了/); assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), config); if(pending) assert.deepEqual(fs.readFileSync(path.join(home, 'setup.pending.json')), pending);`);
  }
});

test("import and local checks create no config, DB, master key, service or global skill", () => {
  const it = computer();
  it.ok(
    `assert.ok(!fs.existsSync(home)); const result = await setup.checkLocalAgents(); assert.deepEqual(result.map(x => [x.id, x.available, x.problem]), [['claude', true, null], ['codex', true, null]]); assert.ok(!fs.existsSync(home));`,
  );
  assert.deepEqual(readFileSync(it.calls, "utf8").trim().split("\n"), ["claude auth status", "codex login status"]);
  it.noGlobalEffects();
});

test("init writes usable starter rules before runtime, commits private credentials last and refuses repeats", () => {
  const it = computer();
  it.ok(`const result = await setup.initSetup({ port: '3998', command: 'wrapper -q {prompt}' });
    assert.equal(result.config.url, 'http://127.0.0.1:3998'); assert.ok(result.config.owner); assert.ok(result.config.worker.key); assert.ok(result.config.channels.desktop.key); assert.equal(result.ownRules, true);
    const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'))); assert.deepEqual(rules.agents.agent.command, ['wrapper', '-q', '{prompt}']); assert.equal(rules.rules[0].to, 'agent');
    assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600); assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); assert.equal(runtime.whose('owner', result.config.owner), 'owner'); assert.equal(runtime.whose('worker', result.config.worker.key), result.config.worker.name); assert.equal(runtime.whose('source', result.config.source.key), 'local'); assert.equal(runtime.whose('channel', result.config.channels.desktop.key), 'desktop');
    const files = ['config.json', 'rules.json', 'master.key', 'hub.db']; const before = files.map(x => fs.readFileSync(path.join(home, x)));
    await assert.rejects(setup.initSetup(), /已经装过了/); files.forEach((x, i) => assert.deepEqual(fs.readFileSync(path.join(home, x)), before[i]));`);
  assert.ok(!existsSync(it.calls), "command setup must not run or authenticate its launcher");
  it.noGlobalEffects();
});

test("existing rules stay byte-for-byte unchanged and do not activate the desktop channel", () => {
  const it = computer();
  mkdirSync(it.data);
  const rules = '{"sources":{},"agents":{},"channels":{},"rules":[],"elsewhere":[]}\n';
  writeFileSync(join(it.data, "rules.json"), rules);
  it.ok(
    `const result = await setup.initSetup({ command: 'wrapper {prompt}' }); assert.equal(result.ownRules, false); assert.equal(result.config.channels, undefined);`,
  );
  assert.equal(readFileSync(join(it.data, "rules.json"), "utf8"), rules);
  it.noGlobalEffects();
});

test("no Agent rejects before creating data; only explicit allowNoAgent enables setup", () => {
  const it = computer(false);
  it.ok(`await assert.rejects(setup.initSetup(), /没找到 Claude Code 或 Codex/); assert.ok(!fs.existsSync(home));
    const result = await setup.initSetup({ allowNoAgent: true }); assert.deepEqual(result.agents, {}); assert.ok(result.config.owner); const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'))); assert.deepEqual(rules.rules, []);`);
  it.noGlobalEffects();
  const cliComputer = computer(false);
  const result = cliComputer.runCli(["init", "--no-service"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /没找到 Claude Code 或 Codex/);
  assert.ok(!existsSync(join(cliComputer.data, "config.json")));
  assert.ok(!existsSync(join(cliComputer.data, "hub.db")));
});

test("concurrent init has one winner, preserving its config and removing the setup lock", () => {
  const it = computer();
  it.ok(
    `const outcomes = await Promise.allSettled([setup.initSetup({ command: 'wrapper {prompt}' }), setup.initSetup({ command: 'wrapper {prompt}' })]); assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1); assert.ok(!fs.existsSync(path.join(home, 'setup.lock')));`,
  );
});

test("invalid existing rules prevent credential commit and are never overwritten", () => {
  const it = computer();
  mkdirSync(it.data);
  writeFileSync(join(it.data, "rules.json"), "not json");
  it.ok(
    `await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' })); assert.equal(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'), 'not json'); assert.ok(!fs.existsSync(path.join(home, 'config.json'))); assert.ok(!fs.existsSync(path.join(home, 'setup.lock')));`,
  );
});

test("join writes only worker config, never opens runtime or initializes master.key, and refuses repeats", () => {
  const it = computer();
  it.ok(`assert.throws(() => setup.joinSetup({ url: '', worker: 'worker', key: 'secret' }), /用法/); assert.ok(!fs.existsSync(home));
    const result = setup.joinSetup({ url: 'https://hub.invalid', worker: 'worker', key: 'secret' }); assert.deepEqual(result, { url: 'https://hub.invalid', worker: { name: 'worker', key: 'secret' } }); assert.deepEqual(fs.readdirSync(home), ['config.json']); assert.throws(() => setup.joinSetup({ url: 'https://other.invalid', worker: 'other', key: 'other' }), /已经装过了/); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'))), result);`);
  assert.ok(!existsSync(it.calls));
  it.noGlobalEffects();
});

test("local checks honor configured built-in prefixes and probe generic command without running it", () => {
  const it = computer();
  it.ok(
    `const agents = { wrapped: { use: 'codex', command: ['wrapper', 'codex'] }, generic: { use: 'command', command: ['wrapper', '-q', '{prompt}'] }, broken: { use: 'command', command: ['missing'] }, unknown: { use: 'not-a-plugin' } }; const checks = await setup.checkLocalAgents(agents); assert.deepEqual(checks.map(x => [x.id, x.available]), [['wrapped', true], ['generic', true], ['broken', false], ['unknown', false]]); assert.match(checks[2].problem, /找不到 missing/); assert.deepEqual(checks[0].command, ['wrapper', 'codex']); assert.ok(!fs.existsSync(home));`,
  );
  assert.equal(readFileSync(it.calls, "utf8").trim(), "wrapper codex login status");
  it.noGlobalEffects();
});

test("stale setup lock blocks init and join without modifying existing files", () => {
  const it = computer();
  mkdirSync(it.data);
  writeFileSync(join(it.data, "setup.lock"), "previous-process\n");
  it.ok(
    `await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' }), /正在初始化/); assert.throws(() => setup.joinSetup({ url: 'https://hub.invalid', worker: 'worker', key: 'secret' }), /正在初始化/); assert.deepEqual(fs.readdirSync(home), ['setup.lock']); assert.equal(fs.readFileSync(path.join(home, 'setup.lock'), 'utf8'), 'previous-process\\n');`,
  );
  it.noGlobalEffects();
});

test("config commit failure releases only its lock and leaves rules intact for safe recovery", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  const rules = '{"sources":{},"agents":{},"channels":{},"rules":[],"elsewhere":[]}\n';
  writeFileSync(join(it.data, "rules.json"), rules);
  it.ok(
    `await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' })); assert.ok(!fs.existsSync(path.join(home, 'config.json'))); assert.ok(!fs.existsSync(path.join(home, 'setup.lock'))); assert.ok(fs.existsSync(path.join(home, 'master.key'))); assert.ok(fs.existsSync(path.join(home, 'hub.db')));`,
  );
  assert.equal(readFileSync(join(it.data, "rules.json"), "utf8"), rules);
  it.noGlobalEffects();
});

test("failed config commit recovers identical credentials and owned desktop rules in the same process", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  it.ok(`await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' }));
    const file = path.join(home, 'setup.pending.json'); assert.equal(fs.statSync(file).mode & 0o777, 0o600); const pending = JSON.parse(fs.readFileSync(file)); assert.ok(pending.config.channels.desktop.key);
    const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); const keys = runtime.listKeys();
    fs.rmSync(path.join(home, 'config.json.tmp'), { recursive: true }); const result = await setup.initSetup({ command: 'wrapper different', port: '9000' }); assert.deepEqual(result.config, pending.config); assert.equal(result.ownRules, true); assert.deepEqual(runtime.listKeys(), keys); assert.ok(!fs.existsSync(file)); assert.equal(runtime.whose('channel', result.config.channels.desktop.key), 'desktop');`);
  it.noGlobalEffects();
});

test("new process resumes pending setup without rotating keys or dropping desktop channel", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  it.ok(`await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' }));`);
  const pending = readFileSync(join(it.data, "setup.pending.json"), "utf8");
  rmSync(join(it.data, "config.json.tmp"), { recursive: true });
  it.ok(
    `const expected = ${pending}; const result = await setup.initSetup(); assert.deepEqual(result.config, expected.config); assert.equal(result.ownRules, true); const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); assert.equal(runtime.whose('owner', expected.config.owner), 'owner'); assert.equal(runtime.whose('channel', expected.config.channels.desktop.key), 'desktop');`,
  );
  it.noGlobalEffects();
});

test("all existing unknown identities are rejected without replacing even one old credential", () => {
  for (const [kind, name] of [
    ["owner", "owner"],
    ["source", "local"],
    ["channel", "desktop"],
    ["worker", "host-worker"],
  ]) {
    const it = computer();
    mkdirSync(it.data);
    writeFileSync(join(it.data, "rules.json"), '{"sources":{},"agents":{},"channels":{},"rules":[],"elsewhere":[]}');
    it.ok(`const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)});
      const worker = (await setup.agentsToUse({ command: 'wrapper' }, (await import('node:os')).hostname().toLowerCase().replace(/\\.local$/, '').replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '') || 'this-machine')).agent.worker;
      const kind = ${JSON.stringify(kind)}; const name = kind === 'worker' ? worker : ${JSON.stringify(name)}; const oldKey = runtime.addKey(kind, name); const before = runtime.listKeys();
      if (kind === 'channel') fs.rmSync(path.join(home, 'rules.json'));
      await assert.rejects(setup.initSetup({ command: 'wrapper {prompt}' }), /已有.*凭据/); assert.equal(runtime.whose(kind, oldKey), name); assert.deepEqual(runtime.listKeys(), before); assert.ok(!fs.existsSync(path.join(home, 'config.json')));`);
    it.noGlobalEffects();
  }
});

test("bad rules are validated before runtime and can be fixed then retried in the same process", () => {
  const it = computer();
  mkdirSync(it.data);
  writeFileSync(join(it.data, "rules.json"), "not json");
  it.ok(`await assert.rejects(setup.initSetup({ command: 'wrapper' })); assert.ok(!fs.existsSync(path.join(home, 'master.key'))); assert.ok(!fs.existsSync(path.join(home, 'hub.db')));
    fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify({sources:{}, agents:{}, channels:{}, rules:[], elsewhere:[]})); const result = await setup.initSetup({ command: 'wrapper' }); assert.ok(result.config.owner);`);
});

test("current bad rules reject with cached runtime or a populated DB in a new process", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  it.ok(
    `await assert.rejects(setup.initSetup({ command: 'wrapper' })); const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); const before = runtime.listKeys(); fs.writeFileSync(path.join(home, 'rules.json'), 'not json'); fs.rmSync(path.join(home, 'config.json.tmp'), {recursive:true}); await assert.rejects(setup.initSetup({ command:'wrapper' })); assert.deepEqual(runtime.listKeys(), before); assert.ok(!fs.existsSync(path.join(home, 'config.json')));`,
  );
  it.ok(
    `await assert.rejects(setup.initSetup({ command:'wrapper' })); assert.ok(!fs.existsSync(path.join(home, 'config.json')));`,
  );
});

test("local Agent recheck sees an installed launcher after a failed lookup in the same parent process", () => {
  const it = computer();
  it.ok(`const agents = { generic: {use:'command', command:['later']}, codex: {use:'codex', command:['later', 'codex']}};
    assert.deepEqual((await setup.checkLocalAgents(agents)).map(x => x.available), [false, false]);
    const program = path.join(process.env.HOME, 'tools', 'later'); fs.copyFileSync(path.join(process.env.HOME, 'tools', 'wrapper'), program); fs.chmodSync(program, 0o755);
    fs.writeFileSync(process.env.SHELL, '#!/bin/sh\\ncase "$4" in\\n"later") printf "%s" ' + JSON.stringify(program) + ' ;;\\nesac\\n');
    assert.deepEqual((await setup.checkLocalAgents(agents)).map(x => x.available), [true, true]); assert.ok(!fs.existsSync(home));`);
  assert.equal(readFileSync(it.calls, "utf8").trim(), "wrapper codex login status");
  it.noGlobalEffects();
});

test("pending recovery registers missing identities with saved keys and rejects conflicting keys as a whole set", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  it.ok(`await assert.rejects(setup.initSetup({ command: 'wrapper' })); const pending = JSON.parse(fs.readFileSync(path.join(home, 'setup.pending.json')));
    const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); runtime.removeKey('worker', pending.config.worker.name); const replacement = runtime.addKey('owner', 'owner'); const before = runtime.listKeys();
    fs.rmSync(path.join(home, 'config.json.tmp'), {recursive:true}); await assert.rejects(setup.initSetup(), /已有.*凭据/); assert.deepEqual(runtime.listKeys(), before); assert.equal(runtime.whose('owner', replacement), 'owner'); assert.ok(!fs.existsSync(path.join(home, 'config.json')));
    runtime.removeKey('owner', 'owner'); const result = await setup.initSetup(); assert.deepEqual(result.config, pending.config); assert.equal(runtime.whose('owner', result.config.owner), 'owner'); assert.equal(runtime.whose('worker', result.config.worker.key), result.config.worker.name);`);
  it.noGlobalEffects();
});

test("join cannot discard an unfinished hub setup", () => {
  const it = computer();
  mkdirSync(it.data);
  mkdirSync(join(it.data, "config.json.tmp"));
  it.ok(
    `await assert.rejects(setup.initSetup({command:'wrapper'})); fs.rmSync(path.join(home, 'config.json.tmp'), {recursive:true}); assert.throws(() => setup.joinSetup({url:'https://hub.invalid', worker:'worker', key:'other'}), /初始化.*未完成/); assert.ok(!fs.existsSync(path.join(home, 'config.json'))); assert.ok(fs.existsSync(path.join(home, 'setup.pending.json')));`,
  );
});

test("program lookup treats command text as data and accepts absolute paths with spaces", () => {
  const it = computer();
  it.ok(`process.env.SHELL = '/bin/sh'; const marker = path.join(process.env.HOME, 'injected'); const malicious = 'not-a-program; /usr/bin/touch ' + marker;
    const checks = await setup.checkLocalAgents({generic:{use:'command', command:[malicious]}, builtin:{use:'codex', command:[malicious]}}); assert.deepEqual(checks.map(x => x.available), [false, false]); assert.ok(!fs.existsSync(marker));
    const program = path.join(process.env.HOME, 'tools', 'launcher with spaces'); fs.copyFileSync(path.join(process.env.HOME, 'tools', 'wrapper'), program); fs.chmodSync(program, 0o755);
    const result = await setup.checkLocalAgents({generic:{use:'command', command:[program]}, builtin:{use:'codex', command:[program, 'codex']}}); assert.deepEqual(result.map(x => x.available), [true, true]); assert.ok(!fs.existsSync(home));`);
  it.noGlobalEffects();
});

test("runtime import failure preserves pending rules ownership before effects and resumes in a new process", () => {
  const it = computer();
  mkdirSync(join(it.data, "hub.db"), { recursive: true });
  it.ok(
    `await assert.rejects(setup.initSetup({command:'wrapper {prompt}'})); const pending = JSON.parse(fs.readFileSync(path.join(home, 'setup.pending.json'))); assert.equal(pending.ownRules, true); assert.ok(pending.config.channels.desktop.key); assert.ok(fs.existsSync(path.join(home, 'rules.json')));`,
  );
  const pending = readFileSync(join(it.data, "setup.pending.json"), "utf8");
  rmSync(join(it.data, "hub.db"), { recursive: true });
  it.ok(
    `const expected = ${pending}; const result = await setup.initSetup(); assert.equal(result.ownRules, true); assert.deepEqual(result.config, expected.config);`,
  );
  it.noGlobalEffects();
});

test("failure before rules creation recovers the planned rules, while preexisting rules ownership stays false", () => {
  const it = computer();
  mkdirSync(join(it.data, "rules.json"), { recursive: true });
  it.ok(
    `await assert.rejects(setup.initSetup({command:'wrapper'})); const pending = JSON.parse(fs.readFileSync(path.join(home, 'setup.pending.json'))); assert.equal(pending.ownRules, false); assert.equal(pending.config.channels, undefined);`,
  );
  rmSync(join(it.data, "rules.json"), { recursive: true });
  writeFileSync(join(it.data, "rules.json"), '{"sources":{},"agents":{},"channels":{},"rules":[],"elsewhere":[]}');
  it.ok(
    `const result = await setup.initSetup(); assert.equal(result.ownRules, false); assert.equal(result.config.channels, undefined);`,
  );
});

test("pending intent exists before a failed rules write and safely creates the planned rules on retry", () => {
  const it = computer();
  it.ok(`const builtinFs = (await import('node:fs')).default; const original = builtinFs.writeFileSync; builtinFs.writeFileSync = (file, ...args) => { if(String(file) === path.join(home, 'rules.json')) { const pending = JSON.parse(fs.readFileSync(path.join(home, 'setup.pending.json'))); assert.equal(pending.rules.state, 'planned'); assert.equal(pending.ownRules, false); throw Object.assign(new Error('injected rules failure'), {code:'EACCES'}); } return original(file, ...args); }; (await import('node:module')).syncBuiltinESMExports();
    try { await assert.rejects(setup.initSetup({command:'wrapper'}), /injected rules failure/); } finally {builtinFs.writeFileSync = original; (await import('node:module')).syncBuiltinESMExports();}
    assert.ok(!fs.existsSync(path.join(home, 'rules.json'))); assert.ok(!fs.existsSync(path.join(home, 'master.key'))); const pending = JSON.parse(fs.readFileSync(path.join(home, 'setup.pending.json'))); const result = await setup.initSetup(); assert.equal(result.ownRules, true); assert.deepEqual(result.config, pending.config); assert.equal(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'), pending.rules.content);`);
  it.noGlobalEffects();
});

test("external rules winning the exclusive-write race remain user-owned even with identical contents", () => {
  const it = computer();
  it.ok(`const builtinFs = (await import('node:fs')).default; const original = builtinFs.writeFileSync; let raced = false;
    builtinFs.writeFileSync = (file, ...args) => { const done = original(file, ...args); if(String(file) === path.join(home, 'setup.pending.json') && !raced) {raced = true; const pending = JSON.parse(fs.readFileSync(file)); original(path.join(home, 'rules.json'), pending.rules.content);} return done; }; (await import('node:module')).syncBuiltinESMExports();
    let result; try {result = await setup.initSetup({command:'wrapper'});} finally {builtinFs.writeFileSync = original; (await import('node:module')).syncBuiltinESMExports();}
    assert.equal(result.ownRules, false); assert.equal(result.config.channels, undefined); const runtime = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../host/runtime.ts")).href)}); assert.ok(!runtime.listKeys().some(x => x.kind === 'channel'));`);
  it.noGlobalEffects();
});

test("externally modified setup rules are preserved and lose desktop ownership on recovery", () => {
  const it = computer();
  mkdirSync(join(it.data, "hub.db"), { recursive: true });
  it.ok(`await assert.rejects(setup.initSetup({command:'wrapper'}));`);
  rmSync(join(it.data, "hub.db"), { recursive: true });
  const changed = '{"sources":{},"agents":{},"channels":{"desktop":{"name":"My desktop"}},"rules":[],"elsewhere":[]}\n';
  writeFileSync(join(it.data, "rules.json"), changed);
  it.ok(
    `const result = await setup.initSetup(); assert.equal(result.ownRules, false); assert.equal(result.config.channels, undefined);`,
  );
  assert.equal(readFileSync(join(it.data, "rules.json"), "utf8"), changed);
  it.noGlobalEffects();
});

test("local check result is isolated from plugin stdout and beforeExit tail logs", () => {
  const it = computer();
  const plugin = join(it.data, "plugins", "noisy");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "agent.ts"),
    `console.log('plugin import log'); process.on('beforeExit', () => console.log('\\nSETUP_CHECK_RESULT=not JSON\\ntail log')); export default {command(){throw new Error('never run')}, read(){return {}}, check(){console.log('check log'); return null}};`,
  );
  it.ok(
    `const result = await setup.checkLocalAgents({noisy:{use:'noisy'}}); assert.deepEqual(result, [{id:'noisy',use:'noisy',available:true,problem:null}]); assert.ok(!fs.existsSync(path.join(home, 'hub.db'))); assert.ok(!fs.existsSync(path.join(home, 'config.json')));`,
  );
  it.noGlobalEffects();
});

test("installed Agents are discovered without login checks and --agent selection remains compatible", () => {
  const it = computer();
  it.ok(
    `const agents = await setup.agentsToUse({}, 'this-machine'); assert.deepEqual(Object.keys(agents), ['claude', 'codex']); const selected = await setup.agentsToUse({ agent: 'codex' }, 'this-machine'); assert.deepEqual(Object.keys(selected), ['codex']); const result = await setup.initSetup({ agent: 'codex' }); assert.deepEqual(Object.keys(result.agents), ['codex']);`,
  );
  assert.ok(!existsSync(it.calls), "discovery must not run an Agent or login command");
  it.noGlobalEffects();
});

test("CLI init and join reuse setup while retaining --no-service output and command syntax", () => {
  const it = computer();
  const initialized = it.runCli(["init", "--command", "wrapper -q {prompt}", "--port", "3997", "--no-service"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /装好了/);
  assert.match(initialized.stdout, /先运行 .* up 启动中台/);
  assert.deepEqual(JSON.parse(readFileSync(join(it.data, "rules.json"), "utf8")).agents.agent.command, [
    "wrapper",
    "-q",
    "{prompt}",
  ]);
  it.noGlobalEffects();
  const worker = computer();
  const joined = worker.runCli([
    "join",
    "https://hub.invalid",
    "--worker",
    "another",
    "--key",
    "secret",
    "--no-service",
  ]);
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(joined.stdout, /以 another 的身份接活了/);
  assert.ok(!existsSync(join(worker.data, "hub.db")));
  assert.ok(!existsSync(join(worker.data, "master.key")));
  worker.noGlobalEffects();
});
