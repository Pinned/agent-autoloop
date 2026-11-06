import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRuntimeControl } from "../src/runtime-control.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import type { Supervisor, SupervisorState } from "../src/supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const state = (status: SupervisorState["status"], pendingSync: number | null = null): SupervisorState => ({
  status,
  pendingSync,
  role: null,
  restartAttempt: 0,
  error: null,
});
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "desktop-control-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.json"), "NOT JSON: must never be parsed; secret");
  let starts = 0;
  let stops = 0;
  let current = state("stopped");
  let listener = (_state: SupervisorState) => {};
  const supervisor: Supervisor = {
    getState: () => current,
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
    start: async () => {
      starts++;
      current = state("running");
      listener(current);
      return current;
    },
    stop: async () => {
      stops++;
      listener(current);
      return current;
    },
    restart: async () => {
      throw new Error("must not restart");
    },
  };
  return {
    home,
    supervisor,
    starts: () => starts,
    stops: () => stops,
    setState: (value: SupervisorState) => {
      current = value;
      listener(value);
    },
  };
}

test("construction does not prepare or start; concurrent explicit starts share preparation", async (t) => {
  const f = await fixture(t);
  const gate = deferred<void>();
  let prepares = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async () => {
      prepares++;
      await gate.promise;
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  assert.equal(prepares, 0);
  const first = control.start();
  const second = control.start();
  assert.equal(first, second);
  gate.resolve();
  await first;
  assert.equal(prepares, 1);
  assert.equal(f.starts(), 1);
  assert.equal(control.getState().status, "running");
});

test("stop during preparation waits, prevents late spawn and rejects starts while stopping", async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const gate = deferred<void>();
  let cleaned = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        cleaned++;
      });
      entered.resolve();
      await gate.promise;
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  const start = control.start();
  await entered.promise;
  let finished = false;
  const stop = control.stop().then((safe) => {
    finished = true;
    return safe;
  });
  await control.start();
  assert.equal(finished, false);
  gate.resolve();
  await start;
  assert.equal(await stop, true);
  assert.equal(f.starts(), 0);
  assert.equal(cleaned, 1);
});

test("failed preparation cleans registered resources and emits only fixed safe errors", async (t) => {
  const f = await fixture(t);
  let cleaned = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        cleaned++;
      });
      throw new Error("secret-key");
    },
    supervisorFactory: () => f.supervisor,
  });
  await control.start();
  assert.equal(cleaned, 1);
  assert.equal(control.getState().status, "failed");
  assert.doesNotMatch(JSON.stringify(control.getState()), /secret-key/);
  assert.equal(await control.stop(), true);
});

test("cleanup failure retains ownership, blocks launch and is retried by stop", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  let prepares = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      prepares++;
      own(async () => {
        if (++attempts < 3) throw new Error("secret path");
      });
      throw new Error("copy failed");
    },
    supervisorFactory: () => f.supervisor,
  });
  await control.start();
  assert.equal(control.getState().status, "unknown");
  await control.start();
  assert.equal(prepares, 1);
  assert.equal(await control.stop(), false);
  assert.equal(await control.stop(), true);
  assert.equal(attempts, 3);
});

test("unconfigured, incomplete setup and packaged shells never prepare or initialize", async (t) => {
  const f = await fixture(t);
  let prepares = 0;
  const options = {
    home: f.home,
    enabled: true,
    prepare: async () => {
      prepares++;
      throw new Error("must not prepare");
    },
    supervisorFactory: () => f.supervisor,
  };
  await rm(join(f.home, "config.json"));
  const control = createRuntimeControl(options);
  await control.start();
  assert.equal(control.getState().status, "unconfigured");
  await writeFile(join(f.home, "config.json"), "not parsed");
  for (const name of ["setup.lock", "setup.pending.json"]) {
    await mkdir(join(f.home, name));
    await control.start();
    assert.equal(control.getState().status, "unconfigured");
    await rm(join(f.home, name), { recursive: true });
  }
  const packaged = createRuntimeControl({ ...options, enabled: false });
  assert.equal((await packaged.start()).status, "unavailable");
  assert.equal(prepares, 0);
});

test("config symlink is not followed", async (t) => {
  const f = await fixture(t);
  await rm(join(f.home, "config.json"));
  await symlink("/nonexistent-private-config", join(f.home, "config.json"));
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async () => {
      throw new Error("must not prepare");
    },
    supervisorFactory: () => f.supervisor,
  });
  await control.start();
  assert.equal(control.getState().status, "unconfigured");
});

test("unknown stop keeps resources and supervisor; retry safe stop preserves pending sync", async (t) => {
  const f = await fixture(t);
  let cleaned = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        cleaned++;
      });
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  await control.start();
  f.setState(state("unknown"));
  assert.equal(await control.stop(), false);
  assert.equal(cleaned, 0);
  await control.start();
  assert.equal(f.starts(), 1);
  f.setState(state("stopped", 7));
  assert.equal(await control.stop(), true);
  assert.equal(cleaned, 1);
  assert.equal(f.stops(), 2);
  assert.equal(control.getState().pendingSync, 7);
});

test("confirmed quit refuses unknown runtime and retries safely with offline pending results", async (t) => {
  const f = await fixture(t);
  let exits = 0;
  let cleanups = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        cleanups++;
      });
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  const lifecycle = createLifecycle({
    hide() {},
    restore() {},
    exit() {
      exits++;
    },
    confirm: async () => true,
    prepareQuit: () => control.stop(),
  });
  await control.start();
  f.setState(state("unknown"));
  await lifecycle.requestQuit();
  assert.equal(lifecycle.quitting, false);
  assert.equal(exits, 0);
  assert.equal(cleanups, 0);
  f.setState(state("stopped", 3));
  await lifecycle.requestQuit();
  assert.equal(lifecycle.quitting, true);
  assert.equal(exits, 1);
  assert.equal(cleanups, 1);
  assert.equal(control.getState().pendingSync, 3);
});

test("immediate stop fences config-check work and explicit start after safe stop remains possible", async (t) => {
  const f = await fixture(t);
  let prepares = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async () => {
      prepares++;
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  const first = control.start();
  assert.equal(await control.stop(), true);
  await first;
  assert.equal(prepares, 0);
  await control.start();
  assert.equal(prepares, 1);
  assert.equal(f.starts(), 1);
});

test("supervisor construction failure cleans resources without exposing exception", async (t) => {
  const f = await fixture(t);
  let cleaned = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        cleaned++;
      });
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => {
      throw new Error("private path");
    },
  });
  await control.start();
  assert.equal(cleaned, 1);
  assert.equal(control.getState().status, "failed");
  assert.equal(await control.stop(), true);
});

test("safe child stop with cleanup failure is unsafe until cleanup retry succeeds", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async (own) => {
      own(async () => {
        if (++attempts === 1) throw new Error("private path");
      });
      return { nodePath: "/node", entryPath: "/cli", home: f.home };
    },
    supervisorFactory: () => f.supervisor,
  });
  await control.start();
  f.setState(state("stopped", 4));
  assert.equal(await control.stop(), false);
  assert.equal(control.getState().status, "unknown");
  await control.start();
  assert.equal(f.starts(), 1);
  assert.equal(await control.stop(), true);
  assert.equal(attempts, 2);
  assert.equal(control.getState().pendingSync, 4);
});

test("stop interrupts in-flight supervisor start without waiting for readiness", async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const gate = deferred<SupervisorState>();
  f.supervisor.start = () => {
    entered.resolve();
    return gate.promise;
  };
  f.supervisor.stop = async () => {
    gate.resolve(state("stopped"));
    return state("stopped");
  };
  const control = createRuntimeControl({
    home: f.home,
    enabled: true,
    prepare: async () => ({ nodePath: "/node", entryPath: "/cli", home: f.home }),
    supervisorFactory: () => f.supervisor,
  });
  const start = control.start();
  await entered.promise;
  assert.equal(await control.stop(), true);
  await start;
});
