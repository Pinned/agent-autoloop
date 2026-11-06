// `agent-autoloop uninstall`, run from a copy of the program laid out as an install is, in a throwaway home with stand-ins for
// launchctl and systemctl: nothing real can be reached. Failure cases: the service keeps running, or one started by hand does;
// a process that only has the old number is killed; a link is left behind, in ~/.local/bin, elsewhere on PATH or among the
// Agents' Skills; someone's own file, folder or link of the same name is removed, or a link that leads somewhere else; the
// data is deleted by uninstall or --yes; with nobody at a terminal it hangs on the question; AGENT_AUTOLOOP_HOME
// naming the user's home, or a folder this program didn't make, gets it deleted.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-uninstall-")));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

let people = 0;
/** Somebody with an install in the usual place, things of their own around it, and links as the install script makes them. */
function install() {
  const person = join(dir, `person-${++people}`);
  const hub = join(person, ".agent-autoloop");
  const app = join(hub, "app");
  for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
    cpSync(join(repo, part), join(app, part), { recursive: true });
  }
  const standIns = join(person, "stand-ins");
  const called = join(person, "service-calls");
  mkdirSync(standIns, { recursive: true });
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(standIns, name), `#!/bin/sh\necho "${name} $*" >> "${called}"\nexit 1\n`);
    chmodSync(join(standIns, name), 0o755);
  }
  const elsewhere = join(person, "elsewhere");
  const mine = join(person, "mine");
  const theirs = join(person, "theirs");
  const dangling = join(person, "dangling");
  for (const place of [join(person, ".local", "bin"), elsewhere, mine, theirs, dangling]) {
    mkdirSync(place, { recursive: true });
  }
  mkdirSync(join(person, ".claude"));
  mkdirSync(join(person, ".codex", "skills", "agent-autoloop"), { recursive: true });
  writeFileSync(join(person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "their own");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: person,
    PATH: [standIns, join(person, ".local", "bin"), elsewhere, mine, theirs, dangling, "/usr/bin", "/bin"].join(":"),
  };
  for (const name of [
    "AGENT_AUTOLOOP_HOME",
    "AGENT_AUTOLOOP_RULES",
    "AGENT_AUTOLOOP_PUBLIC_URL",
    "AGENT_AUTOLOOP_COMMIT",
  ])
    delete env[name];
  const program = join(app, "bin", "agent-autoloop.ts");
  const run = (args: string[], over: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", program, ...args], {
      env: { ...env, ...over },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const set = run(["init", "--no-service", "--command", "true", "--port", "3999"]);
  assert.equal(set.status, 0, set.stderr);
  symlinkSync(program, join(person, ".local", "bin", "agent-autoloop"));
  symlinkSync(program, join(elsewhere, "agent-autoloop"));
  writeFileSync(join(mine, "agent-autoloop"), "#!/bin/sh\necho mine\n");
  symlinkSync(join(mine, "agent-autoloop"), join(theirs, "agent-autoloop"));
  symlinkSync(join(person, "gone"), join(dangling, "agent-autoloop"));
  return { person, hub, app, env, run, called, elsewhere, mine, theirs, dangling, program };
}
type Install = ReturnType<typeof install>;
const skillLink = ({ person }: Install) => join(person, ".claude", "skills", "agent-autoloop");
const isThere = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

function ownThingsAreThere(it: Install) {
  assert.equal(readFileSync(join(it.mine, "agent-autoloop"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(readlinkSync(join(it.theirs, "agent-autoloop")), join(it.mine, "agent-autoloop"));
  assert.equal(readlinkSync(join(it.dangling, "agent-autoloop")), join(it.person, "gone"));
  assert.equal(readFileSync(join(it.person, ".codex", "skills", "agent-autoloop", "SKILL.md"), "utf8"), "their own");
}

function linksAreGone(it: Install) {
  assert.ok(!isThere(join(it.person, ".local", "bin", "agent-autoloop")));
  assert.ok(!isThere(join(it.elsewhere, "agent-autoloop")));
  assert.ok(!isThere(skillLink(it)));
}

function serviceFile(it: Install) {
  const file =
    process.platform === "darwin"
      ? join(it.person, "Library", "LaunchAgents", "agent-autoloop.plist")
      : join(it.person, ".config", "systemd", "user", "agent-autoloop.service");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `<string>${it.program}</string>`);
  return file;
}

function resourcesRemain(it: Install) {
  assert.ok(existsSync(it.app));
  assert.ok(isThere(join(it.person, ".local", "bin", "agent-autoloop")));
  assert.ok(isThere(join(it.elsewhere, "agent-autoloop")));
  assert.ok(isThere(skillLink(it)));
}

async function ignoredTermOwner(it: Install) {
  const file = join(it.person, "lock-owner.mjs");
  writeFileSync(
    file,
    `import { acquireRunLock } from ${JSON.stringify(join(it.app, "host/runlock.ts"))};
const lock = acquireRunLock();
process.on('SIGTERM', () => {});
process.send({ready:true});
setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [file], { env: it.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("exit", (code) => reject(new Error(`Lock owner exited ${code}`)));
    child.once("error", reject);
  });
  return child;
}

test("unknown numeric metadata refuses uninstall before any service or resource removal", () => {
  const it = install();
  const service = serviceFile(it);
  writeFileSync(join(it.hub, "up.pid"), "123456789\n");
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /人工核验/);
  assert.ok(!existsSync(it.called), "no service hooks before identity preflight");
  assert.ok(existsSync(service));
  resourcesRemain(it);
  assert.equal(readFileSync(join(it.hub, "up.pid"), "utf8"), "123456789\n");
});

for (const content of [
  "123456789x\n",
  '{"pid":123456789',
  "not-json\n",
  "0\n",
  "{}",
  "",
  "null",
  "[]",
  '{"pid":0,"startedAt":"stale","token":"stale"}',
  '{"pid":1.5,"startedAt":"stale","token":"stale"}',
  '{"pid":1,"startedAt":"","token":"stale"}',
  '{"pid":1,"startedAt":"stale"}',
]) {
  test(`malformed metadata ${JSON.stringify(content)} refuses uninstall without deleting anything`, () => {
    const it = install();
    const service = serviceFile(it);
    writeFileSync(join(it.hub, "up.pid"), content);
    const done = it.run(["uninstall", "--yes"]);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /人工核验/);
    assert.ok(!existsSync(it.called));
    assert.ok(existsSync(service));
    resourcesRemain(it);
    assert.equal(readFileSync(join(it.hub, "up.pid"), "utf8"), content);
  });
}

for (const kind of ["symlink", "dangling symlink", "directory", "hardlink"] as const) {
  test(`unsafe metadata ${kind} refuses uninstall before service hooks or deletion`, () => {
    const it = install();
    const service = serviceFile(it);
    const file = join(it.hub, "up.pid");
    const target = join(it.person, "metadata-target");
    if (kind === "directory") mkdirSync(file);
    else {
      if (kind === "symlink" || kind === "hardlink")
        writeFileSync(target, JSON.stringify({ pid: process.pid, startedAt: "stale", token: "stale" }));
      if (kind === "hardlink") linkSync(target, file);
      else symlinkSync(target, file);
    }
    const done = it.run(["uninstall", "--yes"]);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /人工核验/);
    assert.ok(!existsSync(it.called));
    assert.ok(existsSync(service));
    resourcesRemain(it);
    assert.ok(isThere(file));
    if (kind === "hardlink") assert.equal(lstatSync(file).ino, lstatSync(target).ino);
    else if (kind !== "directory") assert.equal(readlinkSync(file), target);
  });
}

test("held lock with unverifiable identity refuses uninstall before service removal", async () => {
  const it = install();
  const service = serviceFile(it);
  await ignoredTermOwner(it);
  writeFileSync(join(it.hub, "up.pid"), JSON.stringify({ pid: 123456789, startedAt: "unknown", token: "unknown" }));
  const metadata = readFileSync(join(it.hub, "up.pid"), "utf8");
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /人工核验/);
  assert.ok(!existsSync(it.called));
  assert.ok(existsSync(service));
  resourcesRemain(it);
  assert.equal(readFileSync(join(it.hub, "up.pid"), "utf8"), metadata);
});

test("a verified owner ignoring TERM times out without removing app or links or claiming success", async () => {
  const it = install();
  await ignoredTermOwner(it);
  const metadata = readFileSync(join(it.hub, "up.pid"), "utf8");
  const preload = join(it.person, "fast-wait.mjs");
  writeFileSync(preload, "Atomics.wait = () => 'timed-out';");
  const done = it.run(["uninstall", "--yes"], { NODE_OPTIONS: `--import=${preload}` });
  assert.equal(done.status, 1);
  assert.match(done.stderr, /停止超时/);
  assert.doesNotMatch(done.stdout, /卸载好了/);
  resourcesRemain(it);
  assert.equal(readFileSync(join(it.hub, "up.pid"), "utf8"), metadata);
});

test("unheld stale JSON metadata does not block safe uninstall", () => {
  const it = install();
  writeFileSync(join(it.hub, "up.pid"), JSON.stringify({ pid: process.pid, startedAt: "stale", token: "stale" }));
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!existsSync(it.app));
  linksAreGone(it);
});

test("the install it makes is what it takes away: service stopped, links gone, all data always kept", () => {
  const it = install();
  assert.ok(lstatSync(skillLink(it)).isSymbolicLink(), "init linked the Skill");
  const service =
    process.platform === "darwin"
      ? join(it.person, "Library", "LaunchAgents", "agent-autoloop.plist")
      : join(it.person, ".config", "systemd", "user", "agent-autoloop.service");
  mkdirSync(join(service, ".."), { recursive: true });
  writeFileSync(service, `<string>${it.program}</string>`);

  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  const calls = readFileSync(it.called, "utf8");
  if (process.platform === "darwin")
    assert.match(calls, new RegExp(`launchctl bootout gui/${process.getuid!()}/agent-autoloop$`, "m"));
  else assert.match(calls, /^systemctl --user disable --now agent-autoloop$/m);
  assert.ok(!existsSync(service));
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(join(it.hub, "config.json")), "nobody was there to say yes, so the data stays");
  assert.match(done.stdout, /规则、密钥和记录还留在/);
  assert.ok(!existsSync(it.app), "the installed code is removed");
});

test("--yes skips confirmation and preserves all data", () => {
  const it = install();
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(existsSync(join(it.hub, "config.json")));
  assert.ok(!existsSync(it.app));
  linksAreGone(it);
  ownThingsAreThere(it);
  assert.ok(existsSync(it.person));
});

test("at a terminal only confirming removes the program, and every answer preserves data", () => {
  const answering = (it: Install, words: string) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { uninstall } = await import(${JSON.stringify(join(it.app, "cli", "uninstall.ts"))});
         await uninstall(false, async () => ${JSON.stringify(words)});`,
      ],
      { env: it.env, encoding: "utf8", timeout: 30_000 },
    );
  for (const [words, gone] of [
    ["", false],
    ["n", false],
    ["\n", false],
    ["y", true],
    ["Yes\n", true],
  ] as const) {
    const it = install();
    const done = answering(it, words);
    assert.equal(done.status, 0, done.stderr);
    assert.ok(existsSync(it.hub), JSON.stringify(words));
    assert.equal(existsSync(it.app), !gone);
    if (gone) linksAreGone(it);
  }
});

test("a hub started by hand is stopped too; a process that only has the old number isn't", async () => {
  const it = install();
  const launch = join(it.person, "held-child.mjs");
  const configFile = join(it.hub, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  delete config.worker;
  config.channels = {};
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(
    launch,
    `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url.endsWith('/host/http.ts')) return { format: 'module', shortCircuit: true, source: \"import { EventEmitter } from 'node:events'; export function serve() { const server = new EventEmitter(); server.close = (done) => { server.emit('close'); done?.(); }; server.closeAllConnections = () => {}; setImmediate(() => server.emit('listening')); return server; }\" };
  return next(url, context);
} });
const { up } = await import(${JSON.stringify(join(it.app, "host/up.ts"))});
await up();
setInterval(() => {}, 1000);
`,
  );
  const asIfUp = spawn(process.execPath, [launch], {
    env: it.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(asIfUp);
  await new Promise<void>((resolve) => asIfUp.once("message", () => resolve()));
  const stopped = new Promise((resolve) => asIfUp.on("exit", resolve));
  assert.equal(it.run(["uninstall", "--yes"]).status, 0);
  await stopped;

  const other = install();
  const someoneElse = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  children.push(someoneElse);
  writeFileSync(join(other.hub, "up.pid"), String(someoneElse.pid));
  const refused = other.run(["uninstall", "--yes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /人工核验/);
  assert.ok(existsSync(other.app));
  assert.ok(isThere(join(other.person, ".local", "bin", "agent-autoloop")));
  assert.equal(readFileSync(join(other.hub, "up.pid"), "utf8"), String(someoneElse.pid));
  assert.equal(someoneElse.exitCode, null);
  assert.equal(someoneElse.signalCode, null);

  const disguised = install();
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); // agent-autoloop up"], {
    stdio: "ignore",
  });
  children.push(fake);
  writeFileSync(join(disguised.hub, "up.pid"), String(fake.pid));
  const rejected = disguised.run(["uninstall", "--yes"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /人工核验/);
  assert.ok(existsSync(disguised.app));
  assert.equal(readFileSync(join(disguised.hub, "up.pid"), "utf8"), String(fake.pid));
  assert.equal(fake.exitCode, null);
  assert.equal(fake.signalCode, null);
});

test("AGENT_AUTOLOOP_HOME can name anything: a folder this program didn't make, or the user's home, isn't deleted", () => {
  const it = install();
  const projects = join(it.person, "projects");
  mkdirSync(projects);
  writeFileSync(join(projects, "thesis.txt"), "years of work");
  const inFolder = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: projects });
  assert.equal(inFolder.status, 0, inFolder.stderr);
  assert.equal(readFileSync(join(projects, "thesis.txt"), "utf8"), "years of work");
  assert.ok(existsSync(projects));

  writeFileSync(join(it.person, "config.json"), "{}");
  assert.equal(it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: it.person }).status, 0);
  assert.ok(existsSync(join(it.person, "config.json")));
  assert.ok(existsSync(join(it.hub, "config.json")));
});

test("with nothing installed it still finishes, and says so plainly", () => {
  const it = install();
  const nothing = it.run(["uninstall", "--yes"], { AGENT_AUTOLOOP_HOME: join(it.person, "never") });
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /卸载好了/);
});

test("without a terminal uninstall asks for --yes before removing anything", () => {
  const it = install();
  const done = it.run(["uninstall"]);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /--yes/);
  assert.ok(existsSync(it.app));
  assert.ok(isThere(join(it.person, ".local", "bin", "agent-autoloop")));
});

test("an unrelated service file with the same name is left running and untouched", () => {
  const it = install();
  const service =
    process.platform === "darwin"
      ? join(it.person, "Library/LaunchAgents/agent-autoloop.plist")
      : join(it.person, ".config/systemd/user/agent-autoloop.service");
  mkdirSync(join(service, ".."), { recursive: true });
  writeFileSync(service, "another program");
  const done = it.run(["uninstall", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(readFileSync(service, "utf8"), "another program");
  assert.ok(!existsSync(it.called));
});
