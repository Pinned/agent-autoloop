import assert from "node:assert/strict";
import { test } from "node:test";
import { loginShell, resolveTerminalEnvironment } from "../src/login-environment.ts";

const MARKER = "AGENT_AUTOLOOP_LOGIN_PATH";

/** A stand-in for execFile that records calls and answers with the shell's standard output. */
function fakeExec(answers: Array<string | Error>) {
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const exec = ((file: string, args: string[], options: Record<string, unknown>, done: Function) => {
    calls.push({ file, args, options });
    const answer = answers.shift();
    if (answer instanceof Error) done(answer, "", "");
    else done(null, answer ?? "", "");
  }) as never;
  return { exec, calls };
}

test("an inherited SHELL wins over the account record; an empty one falls back to it", () => {
  assert.equal(
    loginShell({ SHELL: "/bin/fish" }, () => "/bin/zsh", "darwin"),
    "/bin/fish",
  );
  assert.equal(
    loginShell({}, () => "/bin/zsh", "darwin"),
    "/bin/zsh",
  );
  assert.equal(
    loginShell({ SHELL: "" }, () => "/bin/zsh", "darwin"),
    "/bin/zsh",
  );
  // Windows has no login shell to ask; the inherited PATH is what a terminal there gets.
  assert.equal(
    loginShell({}, () => "C:\\shell.exe", "win32"),
    undefined,
  );
});

test("the shell is asked interactively first, and noisy output is read by marker", async () => {
  const { exec, calls } = fakeExec([`welcome banner\n${MARKER}=/opt/homebrew/bin:/usr/bin\nlast line\n`]);
  const resolved = await resolveTerminalEnvironment({
    environment: { SHELL: "/bin/zsh" },
    exec,
    platform: "darwin",
  });
  assert.deepEqual(resolved, Object.freeze({ shell: "/bin/zsh", path: "/opt/homebrew/bin:/usr/bin" }));
  assert.equal(calls[0].file, "/bin/zsh");
  // An interactive login shell: PATH exported from ~/.zshrc is only visible to one.
  assert.equal(calls[0].args[0], "-ilc");
  // The marker is last, so a start-up file echoing a PATH-like line cannot win.
  assert.match(String(calls[0].args[1]), /printf/);
  assert.equal(calls.length, 1);
});

test("a failing interactive attempt retries as a plain login shell", async () => {
  const { exec, calls } = fakeExec([new Error("interactive refused"), `${MARKER}=/usr/local/bin\n`]);
  const resolved = await resolveTerminalEnvironment({
    environment: { SHELL: "/bin/zsh" },
    exec,
    platform: "darwin",
  });
  assert.deepEqual(resolved, { shell: "/bin/zsh", path: "/usr/local/bin" });
  assert.equal(calls[0].args[0], "-ilc");
  assert.equal(calls[1].args[0], "-lc");
});

test("fish gets its list-shaped PATH joined, not printed as tokens", async () => {
  const { exec, calls } = fakeExec([`${MARKER}=/usr/bin:/bin\n`]);
  await resolveTerminalEnvironment({ environment: { SHELL: "/opt/homebrew/bin/fish" }, exec, platform: "darwin" });
  assert.match(String(calls[0].args[1]), /string join : \$PATH/);
});

test("a shell that never answers leaves the inherited values alone", async () => {
  const { exec, calls } = fakeExec([new Error("timeout"), new Error("timeout")]);
  const resolved = await resolveTerminalEnvironment({
    environment: { SHELL: "/bin/zsh" },
    exec,
    platform: "darwin",
  });
  // The shell itself is still a fact worth passing on; no PATH is invented.
  assert.deepEqual(resolved, { shell: "/bin/zsh" });
  assert.equal(calls.length, 2);
});

test("no shell means no question at all", async () => {
  const { exec, calls } = fakeExec([]);
  const resolved = await resolveTerminalEnvironment({ environment: {}, accountShell: () => undefined, exec });
  assert.deepEqual(resolved, {});
  assert.equal(calls.length, 0);
});

test("blank, NUL-bearing and oversized PATH values are refused rather than passed to a child", async () => {
  for (const printed of [`${MARKER}=\n`, `${MARKER}=/usr/bin\0/etc\n`, `${MARKER}=${"/x".repeat(5000)}\n`]) {
    const { exec } = fakeExec([printed, printed]);
    const resolved = await resolveTerminalEnvironment({
      environment: { SHELL: "/bin/sh" },
      exec,
      platform: "darwin",
    });
    assert.deepEqual(resolved, { shell: "/bin/sh" }, `unexpected PATH for ${JSON.stringify(printed.slice(0, 40))}`);
  }
});

test("relative and empty entries are dropped, absolute directories survive", async () => {
  const { exec } = fakeExec([`${MARKER}=bin:/opt/homebrew/bin::/usr/bin\n`]);
  const resolved = await resolveTerminalEnvironment({
    environment: { SHELL: "/bin/zsh" },
    exec,
    platform: "darwin",
  });
  assert.equal(resolved.path, "/opt/homebrew/bin:/usr/bin");
});

test("a PATH with no absolute directory at all is not passed on", async () => {
  const { exec } = fakeExec([`${MARKER}=bin:.\n`, `${MARKER}=bin:.\n`]);
  const resolved = await resolveTerminalEnvironment({
    environment: { SHELL: "/bin/zsh" },
    exec,
    platform: "darwin",
  });
  assert.deepEqual(resolved, { shell: "/bin/zsh" });
});
