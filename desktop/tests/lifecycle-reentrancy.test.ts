// Prevent synchronous callbacks from duplicating quit flights, losing retries or reopening irreversible exit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLifecycle } from "../src/lifecycle.ts";

type Phase = "idle" | "confirming" | "preparing" | "quitting";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const noop = () => {};

// This regression uses only the existing API, with one bounded reentry.
test("synchronous confirm reentry shares one flight and confirms only once", async () => {
  let confirms = 0;
  let nested: Promise<void> | undefined;
  const lifecycle = createLifecycle({
    hide: noop,
    restore: noop,
    exit: noop,
    confirm: () => {
      confirms++;
      if (confirms === 1) nested = lifecycle.requestQuit();
      return Promise.resolve(false);
    },
  });
  const first = lifecycle.requestQuit();
  await Promise.all([first, nested]);
  assert.equal(confirms, 1);
  assert.strictEqual(nested, first);
});

test("initial idle is silent; every active phase and action reenters the same flight", async () => {
  const phases: Phase[] = [];
  const reentries: Promise<void>[] = [];
  const answer = deferred<boolean>();
  const safe = deferred<boolean>();
  let confirms = 0;
  let prepares = 0;
  let exits = 0;
  let hides = 0;
  let restores = 0;
  const lifecycle = createLifecycle({
    hide: () => hides++,
    restore: () => restores++,
    onPhase: (phase) => {
      phases.push(phase);
      assert.equal(lifecycle.phase, phase);
      assert.equal(lifecycle.quitting, phase === "quitting");
      reentries.push(lifecycle.requestQuit());
    },
    confirm: () => {
      confirms++;
      assert.equal(lifecycle.phase, "confirming");
      reentries.push(lifecycle.requestQuit());
      return answer.promise;
    },
    prepareQuit: () => {
      prepares++;
      assert.equal(lifecycle.phase, "preparing");
      reentries.push(lifecycle.requestQuit());
      return safe.promise;
    },
    exit: () => {
      exits++;
      assert.equal(lifecycle.phase, "quitting");
      assert.equal(lifecycle.close(), true);
      reentries.push(lifecycle.requestQuit());
    },
  });
  assert.equal(lifecycle.phase, "idle");
  assert.deepEqual(phases, []);
  const first = lifecycle.requestQuit();
  assert.equal(confirms, 1);
  assert.equal(prepares, 0);
  assert.equal(lifecycle.close(), false);
  lifecycle.restore();
  answer.resolve(true);
  await Promise.resolve();
  assert.equal(prepares, 1);
  assert.equal(lifecycle.close(), false);
  lifecycle.restore();
  safe.resolve(true);
  await first;
  assert.deepEqual(phases, ["confirming", "preparing", "quitting"]);
  for (const reentry of reentries) assert.strictEqual(reentry, first);
  assert.deepEqual([confirms, prepares, exits, hides, restores], [1, 1, 1, 2, 2]);
  await lifecycle.requestQuit();
  assert.equal(exits, 1);
});

for (const mode of [
  "cancel",
  "unsafe",
  "confirm-throw",
  "confirm-reject",
  "prepare-throw",
  "prepare-reject",
] as const) {
  test(`${mode} restores idle, preserves failure identity and permits retry`, async () => {
    const phases: Phase[] = [];
    const error = new Error(mode);
    let confirms = 0;
    let prepares = 0;
    let exits = 0;
    const lifecycle = createLifecycle({
      hide: noop,
      restore: noop,
      onPhase: (phase) => phases.push(phase),
      confirm: () => {
        confirms++;
        if (confirms === 1) {
          if (mode === "cancel") return Promise.resolve(false);
          if (mode === "confirm-throw") throw error;
          if (mode === "confirm-reject") return Promise.reject(error);
        }
        return Promise.resolve(true);
      },
      prepareQuit: () => {
        prepares++;
        if (prepares === 1) {
          if (mode === "unsafe") return Promise.resolve(false);
          if (mode === "prepare-throw") throw error;
          if (mode === "prepare-reject") return Promise.reject(error);
        }
        return Promise.resolve(true);
      },
      exit: () => exits++,
    });
    let first!: Promise<void>;
    assert.doesNotThrow(() => {
      first = lifecycle.requestQuit();
    });
    if (mode === "cancel" || mode === "unsafe") await first;
    else await assert.rejects(first, (caught) => caught === error);
    assert.equal(lifecycle.phase, "idle");
    assert.equal(lifecycle.quitting, false);
    assert.equal(exits, 0);
    assert.deepEqual(
      phases,
      mode.startsWith("prepare") || mode === "unsafe" ? ["confirming", "preparing", "idle"] : ["confirming", "idle"],
    );
    const retry = lifecycle.requestQuit();
    assert.notStrictEqual(retry, first);
    assert.strictEqual(lifecycle.requestQuit(), retry);
    await retry;
    assert.equal(exits, 1);
    assert.equal(lifecycle.phase, "quitting");
  });
}

for (const mode of ["cancel", "unsafe", "failure"] as const) {
  test(`idle notification starts a new ${mode} retry that old settlement cannot clear`, async () => {
    const answer = deferred<boolean>();
    const primary = new Error("primary");
    let confirms = 0;
    let prepares = 0;
    let retry: Promise<void> | undefined;
    let duplicate: Promise<void> | undefined;
    const lifecycle = createLifecycle({
      hide: noop,
      restore: noop,
      exit: noop,
      confirm: () => {
        confirms++;
        if (confirms > 1) return answer.promise;
        if (mode === "failure") return Promise.reject(primary);
        return Promise.resolve(mode !== "cancel");
      },
      prepareQuit: () => Promise.resolve(++prepares > 1 || mode !== "unsafe"),
      onPhase: (phase) => {
        if (phase === "idle" && !retry) {
          retry = lifecycle.requestQuit();
          duplicate = lifecycle.requestQuit();
        }
      },
    });
    const old = lifecycle.requestQuit();
    if (mode === "failure") await assert.rejects(old, (caught) => caught === primary);
    else await old;
    assert.ok(retry);
    assert.notStrictEqual(retry, old);
    assert.strictEqual(duplicate, retry);
    assert.strictEqual(lifecycle.requestQuit(), retry);
    assert.equal(confirms, 2);
    assert.equal(lifecycle.phase, "confirming");
    answer.resolve(true);
    await retry;
    assert.equal(lifecycle.phase, "quitting");
  });
}

for (const phase of ["confirming", "preparing"] as const) {
  test(`${phase} notification throw restores idle and rejects the same flight`, async () => {
    const error = new Error(phase);
    const phases: Phase[] = [];
    let nested: Promise<void> | undefined;
    let confirms = 0;
    let prepares = 0;
    let exits = 0;
    let fail = true;
    const lifecycle = createLifecycle({
      hide: noop,
      restore: noop,
      exit: () => exits++,
      confirm: () => {
        confirms++;
        return Promise.resolve(true);
      },
      prepareQuit: () => {
        prepares++;
        return Promise.resolve(true);
      },
      onPhase: (current) => {
        phases.push(current);
        if (current === phase && fail) {
          nested = lifecycle.requestQuit();
          fail = false;
          throw error;
        }
      },
    });
    const first = lifecycle.requestQuit();
    await assert.rejects(first, (caught) => caught === error);
    assert.strictEqual(nested, first);
    assert.equal(lifecycle.phase, "idle");
    assert.equal(exits, 0);
    assert.equal(confirms, phase === "confirming" ? 0 : 1);
    assert.equal(prepares, 0);
    assert.deepEqual(phases, phase === "confirming" ? ["confirming", "idle"] : ["confirming", "preparing", "idle"]);
    await lifecycle.requestQuit();
    assert.equal(exits, 1);
  });
}

for (const mode of [
  "cancel",
  "unsafe",
  "confirming",
  "preparing",
  "confirm-throw",
  "confirm-reject",
  "prepare-throw",
  "prepare-reject",
  "undefined",
] as const) {
  test(`${mode} plus idle notification throw preserves restore error and ordered primary`, async () => {
    const primary = mode === "undefined" ? undefined : new Error("primary");
    const restore = new Error("restore");
    let fail = true;
    const lifecycle = createLifecycle({
      hide: noop,
      restore: noop,
      exit: noop,
      confirm: () => {
        if (fail && (mode === "confirm-throw" || mode === "undefined")) throw primary;
        if (fail && mode === "confirm-reject") return Promise.reject(primary);
        return Promise.resolve(!fail || mode !== "cancel");
      },
      prepareQuit: () => {
        if (fail && mode === "prepare-throw") throw primary;
        if (fail && mode === "prepare-reject") return Promise.reject(primary);
        return Promise.resolve(!fail || mode !== "unsafe");
      },
      onPhase: (phase) => {
        if (!fail) return;
        if (phase === mode) throw primary;
        if (phase === "idle") throw restore;
      },
    });
    const first = lifecycle.requestQuit();
    await assert.rejects(first, (caught) => {
      if (mode === "cancel" || mode === "unsafe") return caught === restore;
      assert.ok(caught instanceof AggregateError);
      assert.equal(caught.errors.length, 2);
      assert.strictEqual(caught.errors[0], primary);
      assert.strictEqual(caught.errors[1], restore);
      return true;
    });
    assert.equal(lifecycle.phase, "idle");
    fail = false;
    await lifecycle.requestQuit();
    assert.equal(lifecycle.phase, "quitting");
  });
}

test("throwing idle observer cannot clear the retry it started", async () => {
  const answer = deferred<boolean>();
  const restore = new Error("restore");
  let confirms = 0;
  let retry: Promise<void> | undefined;
  const lifecycle = createLifecycle({
    hide: noop,
    restore: noop,
    exit: noop,
    confirm: () => (++confirms === 1 ? Promise.resolve(false) : answer.promise),
    onPhase: (phase) => {
      if (phase === "idle") {
        retry = lifecycle.requestQuit();
        assert.strictEqual(lifecycle.requestQuit(), retry);
        throw restore;
      }
    },
  });
  const first = lifecycle.requestQuit();
  await assert.rejects(first, (caught) => caught === restore);
  assert.ok(retry);
  assert.strictEqual(lifecycle.requestQuit(), retry);
  answer.resolve(true);
  await retry;
});

test("hide and restore reentry during confirmation preserve close behavior and the active flight", async () => {
  const answer = deferred<boolean>();
  const nested: Promise<void>[] = [];
  let confirms = 0;
  let hides = 0;
  let restores = 0;
  let exits = 0;
  const lifecycle = createLifecycle({
    hide: () => {
      hides++;
      assert.equal(lifecycle.phase, "confirming");
      nested.push(lifecycle.requestQuit());
    },
    restore: () => {
      restores++;
      assert.equal(lifecycle.phase, "confirming");
      nested.push(lifecycle.requestQuit());
    },
    confirm: () => {
      confirms++;
      return answer.promise;
    },
    exit: () => exits++,
  });
  const first = lifecycle.requestQuit();
  assert.equal(lifecycle.close(), false);
  assert.equal(lifecycle.restore(), undefined);
  assert.deepEqual([confirms, hides, restores, exits], [1, 1, 1, 0]);
  assert.equal(nested.length, 2);
  for (const reentry of nested) assert.strictEqual(reentry, first);
  assert.strictEqual(lifecycle.requestQuit(), first);
  answer.resolve(true);
  await first;
  assert.equal(lifecycle.close(), true);
  assert.equal(hides, 1);
  assert.equal(exits, 1);
});

for (const stage of ["confirm", "prepare"] as const) {
  for (const failure of ["throw", "reject"] as const) {
    test(`${stage} ${failure} undefined is a single rejection that restores idle and allows retry`, async () => {
      const phases: Phase[] = [];
      let confirms = 0;
      let prepares = 0;
      let exits = 0;
      const fail = (): Promise<boolean> => {
        if (failure === "throw") throw undefined;
        return Promise.reject(undefined);
      };
      const lifecycle = createLifecycle({
        hide: noop,
        restore: noop,
        onPhase: (phase) => phases.push(phase),
        confirm: () => {
          confirms++;
          if (stage === "confirm" && confirms === 1) return fail();
          return Promise.resolve(true);
        },
        prepareQuit: () => {
          prepares++;
          if (stage === "prepare" && prepares === 1) return fail();
          return Promise.resolve(true);
        },
        exit: () => exits++,
      });
      let first!: Promise<void>;
      assert.doesNotThrow(() => {
        first = lifecycle.requestQuit();
      });
      let caughtFailure = false;
      let caught: unknown = Symbol("not caught");
      try {
        await first;
      } catch (error) {
        caughtFailure = true;
        caught = error;
      }
      assert.equal(caughtFailure, true);
      assert.strictEqual(caught, undefined);
      assert.equal(lifecycle.phase, "idle");
      assert.equal(lifecycle.quitting, false);
      assert.equal(exits, 0);
      assert.deepEqual(phases, stage === "confirm" ? ["confirming", "idle"] : ["confirming", "preparing", "idle"]);
      const retry = lifecycle.requestQuit();
      assert.notStrictEqual(retry, first);
      assert.strictEqual(lifecycle.requestQuit(), retry);
      await retry;
      assert.equal(confirms, 2);
      assert.equal(prepares, stage === "confirm" ? 1 : 2);
      assert.equal(exits, 1);
      assert.equal(lifecycle.phase, "quitting");
    });
  }
}

test("primary failure and throwing idle observer preserve the new pending retry and ordered aggregate", async () => {
  const answer = deferred<boolean>();
  const primary = new Error("primary");
  const restore = new Error("restore");
  let confirms = 0;
  let exits = 0;
  let retry: Promise<void> | undefined;
  let duplicate: Promise<void> | undefined;
  const lifecycle = createLifecycle({
    hide: noop,
    restore: noop,
    exit: () => exits++,
    confirm: () => (++confirms === 1 ? Promise.reject(primary) : answer.promise),
    onPhase: (phase) => {
      if (phase === "idle") {
        retry = lifecycle.requestQuit();
        duplicate = lifecycle.requestQuit();
        throw restore;
      }
    },
  });
  const old = lifecycle.requestQuit();
  await assert.rejects(old, (caught) => {
    assert.ok(caught instanceof AggregateError);
    assert.equal(caught.errors.length, 2);
    assert.strictEqual(caught.errors[0], primary);
    assert.strictEqual(caught.errors[1], restore);
    return true;
  });
  assert.ok(retry);
  assert.notStrictEqual(retry, old);
  assert.strictEqual(duplicate, retry);
  assert.strictEqual(lifecycle.requestQuit(), retry);
  assert.equal(confirms, 2);
  assert.equal(exits, 0);
  assert.equal(lifecycle.phase, "confirming");
  answer.resolve(true);
  await retry;
  assert.equal(lifecycle.phase, "quitting");
  assert.equal(lifecycle.quitting, true);
  assert.equal(exits, 1);
  await lifecycle.requestQuit();
  assert.equal(confirms, 2);
  assert.equal(exits, 1);
});

for (const mode of ["observer", "exit"] as const) {
  test(`terminal ${mode} throw never reopens or repeats exit and reentry shares pending`, async () => {
    const error = new Error(mode);
    const phases: Phase[] = [];
    const nested: Promise<void>[] = [];
    let confirms = 0;
    let exits = 0;
    const lifecycle = createLifecycle({
      hide: () => assert.fail("terminal close must not hide"),
      restore: noop,
      confirm: () => {
        confirms++;
        return Promise.resolve(true);
      },
      onPhase: (phase) => {
        phases.push(phase);
        if (phase === "quitting") {
          nested.push(lifecycle.requestQuit());
          if (mode === "observer") throw error;
        }
      },
      exit: () => {
        exits++;
        nested.push(lifecycle.requestQuit());
        throw error;
      },
    });
    const first = lifecycle.requestQuit();
    await assert.rejects(first, (caught) => caught === error);
    for (const reentry of nested) assert.strictEqual(reentry, first);
    assert.equal(lifecycle.phase, "quitting");
    assert.equal(lifecycle.quitting, true);
    assert.equal(lifecycle.close(), true);
    const completed = lifecycle.requestQuit();
    assert.notStrictEqual(completed, first);
    await completed;
    await lifecycle.requestQuit();
    assert.equal(confirms, 1);
    assert.equal(exits, mode === "exit" ? 1 : 0);
    assert.deepEqual(phases, ["confirming", "preparing", "quitting"]);
  });
}
