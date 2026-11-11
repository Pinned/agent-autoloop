// Prevent untrusted senders, malformed drafts, duplicate writes, stale leases and late gate changes
// from reshaping what the hub already recorded.
// Production modules only, memory config/fetch/stream and the real runtime presentation; no fs/network/process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskActionSource } from "../src/task-action-source.ts";
import { createTaskActionIpc } from "../src/task-action-ipc.ts";
import { createRuntimePresentation } from "../src/runtime-presentation.ts";
function fixture() {
  let state: {
    status: "running" | "stopped";
    role: "hub-worker" | "worker" | null;
    ownership: "owned";
    pendingSync: number | null;
    error: { code: "service"; message: string } | null;
  } = { status: "running", role: "hub-worker", ownership: "owned", pendingSync: 0, error: null };
  const gates = { phase: "idle" as "idle" | "quitting", busy: false, blocked: false, quitting: false };
  const p = createRuntimePresentation({
    page: "file:///trusted",
    read: () => state,
    gates: () => gates,
    send: () => {},
    refresh: () => {},
    report: () => {},
  });
  p.finishDocument(p.beginDocument(), "file:///trusted");
  const seen: string[] = [];
  let config = () => ({ hub: { listen: "127.0.0.1:43210" }, owner: "memory-owner" });
  let resolve!: (value: Response) => void;
  let fetcher = (_url: string, _init?: RequestInit) =>
    new Promise<Response>((yes) => {
      resolve = yes;
    });
  const source = createTaskActionSource({
    home: "unused",
    getState: () => p.snapshot(),
    readConfig: () => config(),
    fetchImpl: (url, init) => {
      seen.push(`${init?.method} ${url} ${(init?.headers as Record<string, string>).authorization}`);
      return fetcher(String(url), init);
    },
  });
  const event = {};
  const ipc = createTaskActionIpc({
    assertSender: (v) => {
      if (v !== event) throw new Error("拒绝非本地顶层窗口的请求");
    },
    presentation: p,
    source,
  });
  const respond = (response: Response) => resolve(response);
  const reply = (data: unknown, status = 200) => respond(new Response(JSON.stringify(data), { status }));
  return {
    p,
    gates,
    event,
    ipc,
    seen,
    reply,
    respond,
    setConfig: (f: typeof config) => {
      config = f;
    },
    setFetch: (f: typeof fetcher) => {
      fetcher = f;
    },
    setState: (s: typeof state) => {
      state = s;
    },
  };
}
const answer = { version: 1, action: "answer", cardId: 7, input: { choice: 0 } } as const;
const memo = { version: 1, action: "memo", runId: 9, input: { text: "更正" } } as const;
// The hub's own answer body, not the desktop envelope around it.
const receipt = { changed: true, state: "decided" } as const;
test("sender first, strict arity and draft parsing happen before any request or lease", async () => {
  const f = fixture();
  let touched = 0;
  const poison = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        throw Error("poison");
      },
      get() {
        touched++;
        throw Error("poison");
      },
    },
  );
  // A foreign sender is rejected before the argument is ever inspected.
  await assert.rejects(f.ipc({}, poison), /拒绝非本地顶层窗口的请求/);
  assert.equal(touched, 0);
  await assert.rejects(f.ipc(f.event, answer, undefined), /invalid-request/);
  await assert.rejects(f.ipc(f.event), /invalid-request/);
  for (const bad of [
    { version: 2, action: "answer", cardId: 7, input: { choice: 0 } },
    { version: 1, action: "cancel", cardId: 7, input: {} },
    { version: 1, action: "answer", cardId: 7, input: { choice: 0, text: "x" } },
    { version: 1, action: "memo", runId: 9, input: { text: "  " } },
    { version: 1, action: "resolve", cardId: 7, input: { reason: "x".repeat(1001) } },
  ])
    assert.deepEqual(await f.ipc(f.event, bad), {
      version: 1,
      ok: false,
      error: { code: "invalid", message: "操作内容不正确，请检查。" },
    });
  assert.equal(f.seen.length, 0);
});
test("a valid write reaches exactly one fixed hub route with the owner credential", async () => {
  const f = fixture();
  const pending = f.ipc(f.event, memo);
  f.reply({ stopped: false });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(f.seen, ["POST http://127.0.0.1:43210/v1/runs/9/memo Bearer memory-owner"]);
});
test("closed gate, worker role, missing hub and bad config fail closed without sending", async () => {
  const cases: [(f: ReturnType<typeof fixture>) => void, string][] = [
    [
      (f) => {
        f.gates.busy = true;
        f.p.changed();
      },
      "unavailable",
    ],
    [
      (f) => {
        f.gates.quitting = true;
        f.p.changed();
      },
      "unavailable",
    ],
    // The IPC lease closes before the source: a worker-only role never even reaches the no-hub check.
    [
      (f) => {
        f.setState({ status: "running", role: "worker", ownership: "owned", pendingSync: 0, error: null });
        f.p.changed();
      },
      "unavailable",
    ],
    [
      (f) => {
        f.setState({ status: "stopped", role: null, ownership: "owned", pendingSync: 0, error: null });
        f.p.changed();
      },
      "unavailable",
    ],
    [(f) => f.setConfig(() => ({ hub: { listen: "0.0.0.0:80" }, owner: "o" })), "config"],
  ];
  for (const [breakIt, code] of cases) {
    const f = fixture();
    breakIt(f);
    const result = await f.ipc(f.event, answer);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
    assert.equal(f.seen.length, 0);
  }
});
test("the lease is acquired fresh per call and never reused across a runtime change", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "worker", ownership: "owned", pendingSync: 0, error: null });
  f.p.changed();
  const first = await f.ipc(f.event, answer);
  assert.equal(first.ok, false);
  assert.equal(f.seen.length, 0);
  f.setState({ status: "running", role: "hub-worker", ownership: "owned", pendingSync: 0, error: null });
  f.p.changed();
  const pending = f.ipc(f.event, answer);
  f.reply(receipt);
  const second = await pending;
  assert.equal(second.ok, true);
  assert.equal(f.seen.length, 1);
});
test("one write at a time; a duplicate click is busy and never becomes a second request", async () => {
  const f = fixture();
  const pending = f.ipc(f.event, answer);
  assert.equal(f.seen.length, 1);
  const duplicate = await f.ipc(f.event, answer);
  assert.deepEqual(duplicate, {
    version: 1,
    ok: false,
    error: { code: "busy", message: "正在提交操作，请勿重复点击。" },
  });
  assert.equal(f.seen.length, 1);
  f.reply(receipt);
  assert.equal((await pending).ok, true);
});
test("a receipt the hub already recorded survives a gate change mid-request", async () => {
  for (const boundary of ["role", "quit", "document"]) {
    const f = fixture();
    const pending = f.ipc(f.event, answer);
    if (boundary === "role") {
      f.setState({ status: "running", role: "worker", ownership: "owned", pendingSync: 0, error: null });
      f.p.changed();
    } else if (boundary === "quit") {
      f.gates.phase = "quitting";
      f.p.changed();
    } else {
      f.p.invalidateDocument();
      f.p.finishDocument(f.p.beginDocument(), "file:///trusted");
    }
    f.reply(receipt);
    const result = await pending;
    assert.equal(result.ok, true, boundary);
  }
});
test("non-200 statuses map to fixed codes and never expose backend text", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [403, "auth"],
    [404, "not-found"],
    [400, "rejected"],
    [409, "rejected"],
    [422, "rejected"],
    [500, "uncertain"],
    [502, "uncertain"],
  ] as const) {
    const f = fixture();
    const pending = f.ipc(f.event, answer);
    f.respond(new Response("secret backend text", { status }));
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, code);
      assert.doesNotMatch(result.error.message, /secret/);
    }
  }
});
test("thrown fetch, malformed and mismatched receipts become uncertain instead of a claimed success", async () => {
  const broken = fixture();
  broken.setFetch(async () => {
    throw new Error("secret");
  });
  const failed = await broken.ipc(broken.event, answer);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "uncertain");
  for (const value of [null, { changed: true }, { ...receipt, state: "never" }, { ...receipt, extra: 1 }, "secret"]) {
    const f = fixture();
    const pending = f.ipc(f.event, answer);
    f.reply(value);
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "uncertain");
      assert.doesNotMatch(result.error.message, /secret/);
    }
  }
});
test("cleanup observers cannot rewrite an acknowledged receipt", async () => {
  const f = fixture();
  const ipc = createTaskActionIpc({
    assertSender: () => {},
    presentation: {
      acquireTaskLease: () => f.p.acquireTaskLease(),
      checkTaskLease: (lease) => f.p.checkTaskLease(lease),
      releaseTaskLease() {
        throw Error("cleanup");
      },
    },
    source: createTaskActionSource({
      home: "unused",
      getState: () => f.p.snapshot(),
      readConfig: () => ({ hub: { listen: "127.0.0.1:43210" }, owner: "memory-owner" }),
      fetchImpl: async () => new Response(JSON.stringify(receipt), { status: 200 }),
    }),
  });
  const result = await ipc(f.event, answer);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action, "answer");
    assert.equal(result.cardId, 7);
    assert.equal(result.result.changed, true);
  }
});
