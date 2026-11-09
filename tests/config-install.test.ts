// Prevent first installation from truncating a temp symlink or replacing any existing config entry.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const configUrl = new URL("../host/config.ts", import.meta.url).href;
const cases = {
  "existing temp symlink does not truncate its victim": `
    const victim = path.join(fixture, 'victim');
    fs.writeFileSync(victim, 'owned victim bytes\\n', {flag: 'wx'});
    fs.symlinkSync(victim, temp);
    let error;
    try { writeConfig(candidate); } catch (caught) { error = caught; }
    assert.equal(fs.readFileSync(victim, 'utf8'), 'owned victim bytes\\n');
    assert.ok(error);
    assert.equal(fs.readlinkSync(temp), victim);
    assert.throws(() => fs.lstatSync(CONFIG_FILE), {code: 'ENOENT'});
  `,
  "existing config is never overwritten": `
    fs.writeFileSync(CONFIG_FILE, 'existing config bytes\\n', {flag: 'wx'});
    let error;
    try { writeConfig(candidate); } catch (caught) { error = caught; }
    assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), 'existing config bytes\\n');
    assert.ok(error);
    assert.equal(fs.readFileSync(temp, 'utf8'), JSON.stringify(candidate, null, 2) + '\\n');
  `,
  "dangling config symlink is never replaced": `
    const missing = path.join(fixture, 'missing');
    fs.symlinkSync(missing, CONFIG_FILE);
    let error;
    try { writeConfig(candidate); } catch (caught) { error = caught; }
    assert.ok(fs.lstatSync(CONFIG_FILE).isSymbolicLink());
    assert.equal(fs.readlinkSync(CONFIG_FILE), missing);
    assert.ok(error);
    assert.throws(() => fs.lstatSync(missing), {code: 'ENOENT'});
    assert.equal(fs.readFileSync(temp, 'utf8'), JSON.stringify(candidate, null, 2) + '\\n');
  `,
  "existing config directory and its contents are never replaced": `
    fs.mkdirSync(CONFIG_FILE);
    const sentinel = path.join(CONFIG_FILE, 'sentinel');
    fs.writeFileSync(sentinel, 'existing directory bytes\\n', {flag: 'wx'});
    let error;
    try { writeConfig(candidate); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.ok(fs.lstatSync(CONFIG_FILE).isDirectory());
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing directory bytes\\n');
    assert.equal(fs.readFileSync(temp, 'utf8'), JSON.stringify(candidate, null, 2) + '\\n');
  `,
  "existing config symlink and its victim are never changed": `
    const victim = path.join(fixture, 'victim');
    fs.writeFileSync(victim, 'owned target bytes\\n', {flag: 'wx'});
    fs.symlinkSync(victim, CONFIG_FILE);
    let error;
    try { writeConfig(candidate); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.ok(fs.lstatSync(CONFIG_FILE).isSymbolicLink());
    assert.equal(fs.readlinkSync(CONFIG_FILE), victim);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'owned target bytes\\n');
    assert.equal(fs.readFileSync(temp, 'utf8'), JSON.stringify(candidate, null, 2) + '\\n');
  `,
  "new config has complete JSON, newline, mode 0600 and no temp": `
    writeConfig(candidate);
    assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), JSON.stringify(candidate, null, 2) + '\\n');
    assert.equal(fs.lstatSync(CONFIG_FILE).mode & 0o777, 0o600);
    assert.throws(() => fs.lstatSync(temp), {code: 'ENOENT'});
  `,
};

for (const [name, body] of Object.entries(cases)) {
  test(name, () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "config-install-"));
    console.log(`Retained config fixture: ${fixture}`);
    // Set fixture HOME before dynamic import; never import setup/runtime or remove failed evidence.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import assert from 'node:assert/strict';
         import * as fs from 'node:fs';
         import path from 'node:path';
         const fixture = process.env.AGENT_AUTOLOOP_HOME;
         const {CONFIG_FILE, writeConfig} = await import(${JSON.stringify(configUrl)});
         const temp = CONFIG_FILE + '.tmp';
         const candidate = {url: 'http://fixture.invalid', owner: 'fixture-only'};
         ${body}`,
      ],
      {
        encoding: "utf8",
        env: { HOME: fixture, TMPDIR: tmpdir(), AGENT_AUTOLOOP_HOME: fixture },
        cwd: fixture,
      },
    );
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  });
}
