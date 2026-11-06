// Copied into the resource tree and executed ONLY by the verified independent Node.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const home = process.env.AGENT_AUTOLOOP_HOME!;
assert.ok(process.cwd().includes("resources with spaces"));
assert.ok(home.startsWith(process.env.HOME!));
assert.equal(process.versions.electron, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
for (const file of [
  "kernel/schema.sql",
  "kernel/evolve.ts",
  "kernel/credentials.ts",
  "host/runtime.ts",
  "protocol/schema.json",
  "package.json",
])
  assert.ok(readFileSync(new URL(file, import.meta.url), "utf8").length);
assert.equal(existsSync(new URL("prompt", import.meta.url)), false);

// Build a private fixture using only committed runtime/config APIs. No discovery, setup or service installation.
mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES!,
  JSON.stringify({
    sources: { local: { name: "Runtime fixture" } },
    agents: {
      fixture: {
        name: "Never execute",
        worker: "runtime-fixture",
        use: "command",
        command: ["runtime-probe-never-execute"],
      },
    },
    channels: { desktop: { name: "Import only" } },
    rules: [],
    elsewhere: [],
  }),
  { flag: "wx", mode: 0o600 },
);
const runtime = await import("./host/runtime.ts");
const { writeConfig, readConfig } = await import("./host/config.ts");
const workerKey = runtime.addKey("worker", "runtime-fixture");
const ownerKey = runtime.addKey("owner", "owner");
writeConfig({ url: "http://127.0.0.1:0", worker: { name: "runtime-fixture", key: workerKey }, owner: ownerKey });
assert.equal(readConfig().worker?.key, workerKey);
assert.equal(readConfig().owner, ownerKey);
assert.equal(runtime.whose("worker", workerKey), "runtime-fixture");
assert.equal(runtime.whose("owner", ownerKey), "owner");
assert.ok(existsSync(join(home, "config.json")));
const sql = runtime.db
  .prepare("SELECT card_token(?,?) AS token, card_hash(?,?) AS hash")
  .get(1, "2026-01-01", 1, "2026-01-01")!;
assert.equal(typeof sql.token, "string");
assert.equal(typeof sql.hash, "string");
assert.notEqual(sql.token, sql.hash);
const event = runtime.ingest("local", { id: "runtime-probe-event", type: "probe.received" });
assert.equal(event.duplicate, false);
assert.equal(runtime.ingest("local", { id: "runtime-probe-event", type: "probe.received" }).duplicate, true);
assert.ok(runtime.all("SELECT id FROM events").length);
const card = runtime.tell("runtime-probe-card", "Isolated runtime", "No agent or notification was invoked");
const row = runtime.one<any>("SELECT token FROM cards WHERE id=?", [card.card])!;
assert.equal(runtime.cardByToken(row.token)?.id, card.card);
assert.ok(runtime.stateOf());
const { loadPlugin } = await import("./host/plugins.ts");
const command = await loadPlugin("command", "agent");
assert.equal(command.read("fixture output", 0, "").text, "fixture output");
const webhook = await loadPlugin("webhook", "channel");
assert.ok(webhook); // Import only; never call delivery or any network operation.
for (const name of ["runtime-fixture", "command"]) {
  const directory = join(home, "plugins", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "helper.ts"), "export const marker: number = 42;\n");
  writeFileSync(join(directory, "agent.ts"), 'import {marker} from "./helper.ts"; export default {marker};\n');
}
assert.equal((await loadPlugin("runtime-fixture", "agent")).marker, 42);
assert.equal((await loadPlugin("command", "agent")).marker, 42);
await assert.rejects(() => loadPlugin("../escape", "agent"));
runtime.db.close();
// A fresh process reimports the copied runtime, reads its source hash and reopens persisted facts/projections.
const reopened = spawnSync(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    "--input-type=module",
    "-e",
    'const r=await import("./host/runtime.ts"); const {readConfig}=await import("./host/config.ts"); const config=readConfig(); if(r.whose("worker",config.worker.key)!=="runtime-fixture" || r.whose("owner",config.owner)!=="owner") throw Error("lost credentials"); if(!r.all("SELECT id FROM events").length) throw Error("lost event"); if(!r.one("SELECT card_hash(1,?) AS hash",["2026-01-01"]).hash) throw Error("missing function"); r.getView(); r.db.close();',
  ],
  { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 },
);
assert.equal(reopened.status, 0, reopened.stderr);
console.log(
  JSON.stringify({
    version: process.version,
    execPath: process.execPath,
    electron: false,
    init: true,
    sqlite: true,
    event: true,
    plugins: true,
    sourceTree: true,
    reopen: true,
  }),
);
