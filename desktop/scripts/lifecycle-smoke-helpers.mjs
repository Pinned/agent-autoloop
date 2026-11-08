// Dependency-injected lifecycle primitives. No process ownership guesses or signals.
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// PATH-selected desktop notification commands are harmless local fixtures. Creation must
// finish before any app/CLI launch; failure refuses the run, never falls back to real commands.
export async function createNotificationFixtures(root) {
  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin, { mode: 0o700 });
  const log = "'" + join(root, "notifications.log").replaceAll("'", "'\\''") + "'";
  for (const name of ["osascript", "notify-send"])
    await writeFile(join(fakeBin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> ${log}\n`, {
      mode: 0o700,
      flag: "wx",
    });
  return fakeBin;
}

export function isolatedEnvironment(home, nodePath, source = {}, fakeBin) {
  return {
    PATH: `${fakeBin ? `${fakeBin}:` : ""}${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: join(home, "tmp"),
    TMP: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    LANG: source.LANG || "en_US.UTF-8",
    LC_ALL: source.LC_ALL || source.LANG || "en_US.UTF-8",
  };
}

// Release the OS-selected loopback port before app init. A bind race is a failure, not a
// reason to search machine services or connect to a different running hub.
export function pickLoopbackPort(makeServer = createServer) {
  return new Promise((resolve, reject) => {
    const server = makeServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === "string" || address.port < 1024 || address.port === 3350)
          return reject(new Error("未分配安全的随机回环端口"));
        resolve(address.port);
      });
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

export function portOpen(port, maxMs = 2_000, connect = createConnection) {
  return new Promise((resolve, reject) => {
    const probe = connect({ port, host: "127.0.0.1" });
    const finish = (error, open) => {
      clearTimeout(timer);
      probe.destroy();
      if (error) reject(error);
      else resolve(open);
    };
    const timer = setTimeout(() => finish(new Error("回环端口探测超时")), maxMs);
    probe.once("connect", () => finish(null, true));
    probe.once("error", (error) => finish(error.code === "ECONNREFUSED" ? null : error, false));
  });
}

export function trackChild(child, name, log) {
  const listeners = new Set();
  const run = { child, name, output: "", errors: "", exited: false, result: null, listeners };
  let resolveClosed;
  run.closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const finish = (result) => {
    if (run.exited) return;
    run.exited = true;
    run.result = result;
    resolveClosed(result);
    notify();
  };
  // Spawn failure has no live process. For an existing process wait for close, not merely exit:
  // descendants may still hold its pipes, and evidence must be flushed before claiming success.
  child.once("error", (error) => {
    log("stderr", `${error.stack || error}\n`);
    if (!child.pid) finish({ code: null, signal: null, error: error.message });
    else run.errors += `${error.stack || error}\n`;
  });
  child.once("close", (code, signal) => finish({ code, signal }));
  child.stdout.on("data", (chunk) => {
    run.output += chunk.toString();
    log("stdout", chunk);
    notify();
  });
  child.stderr.on("data", (chunk) => {
    run.errors += chunk.toString();
    log("stderr", chunk);
  });
  return run;
}

export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("验收已取消"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function waitForMarker(run, marker, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      run.listeners.delete(check);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason || new Error("验收已取消"));
    const check = () => {
      if (signal.aborted) return abort();
      if (run.exited && (run.result.code !== 0 || run.result.signal || run.result.error))
        return finish(new Error(`${run.name} failed before ${marker}`));
      if (run.output.includes(marker)) return finish();
      if (run.exited) finish(new Error(`${run.name} exited before ${marker}`));
    };
    run.listeners.add(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

export async function settleChildren(runs, requestQuit, maxMs) {
  // ChildProcess handles cover direct launches only, never an inferred business process tree.
  const scope = { scope: "direct-children-only", businessDescendants: "unknown" };
  if (runs.every((run) => run.exited)) return { ...scope, residual: [] };
  let requestError;
  let timer;
  await Promise.race([
    (async () => {
      try {
        await requestQuit();
      } catch (error) {
        requestError = String(error);
      }
      await Promise.all(runs.map((run) => run.closed));
    })(),
    new Promise((resolve) => {
      timer = setTimeout(resolve, maxMs);
    }),
  ]);
  clearTimeout(timer);
  return {
    ...scope,
    residual: runs.filter((run) => !run.exited).map((run) => ({ name: run.name, pid: run.child.pid ?? null })),
    ...(requestError ? { requestError } : {}),
  };
}
