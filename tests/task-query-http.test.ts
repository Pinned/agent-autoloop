// Guards against route ambiguity, pre-auth side effects, reading rejected streams, permissive URL
// parsing, leaked SQL errors and re-truncated query DTOs. Only fake Requests and empty/evolve memory DBs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, evolve, keyOf, snapshot, type Row, type Table } from "../kernel/evolve.ts";
import { taskQueryHttp } from "../host/task-query-http.ts";
import {
  listRuns,
  readRunDetail,
  pageRunEvents,
  pageRunCards,
  pageRelatedRuns,
  pageRunFeedback,
} from "../host/desktop-task-query.ts";
import { encodeRunCursor, LIST_MAX_BYTES, DETAIL_MAX_BYTES } from "../host/desktop-task-query-contract.ts";
const root = "http://fixture.invalid/v1/ui/task-runs";
const at = "2026-11-08T00:00:00.000Z";
function fixture() {
  const entries: [Table, Row][] = [
    ["runs", { id: 1, rule: "r", lane: "", agent: "a", state: "done", summary: "100% task", created_at: at }],
    ["runs", { id: 9, rule: "r", lane: "", agent: "a", state: "queued", created_at: at }],
    ["events", { id: 2, source: "s", type: "t", subject: "x", summary: "summary", detail: "detail", received_at: at }],
    ["events", { id: 10, source: "s", type: "t", summary: "summary", received_at: at }],
    ["run_events", { run_id: 1, event_id: 2 }],
    ["run_events", { run_id: 1, event_id: 10 }],
    [
      "cards",
      {
        id: 3,
        run_id: 1,
        kind: "ask",
        state: "open",
        title: "question",
        text: "text",
        options: '["yes"]',
        created_at: at,
      },
    ],
    ["feedback", { id: 5, run_id: 1, kind: "交付满意", text: "做得好", created_at: at }],
    ["feedback", { id: 6, run_id: 1, kind: "需要改善", text: "再快一点", created_at: at }],
  ];
  return evolve(empty(), [
    {
      version: 1,
      seq: 4,
      at: 0,
      type: "fixture",
      changes: entries.map(([table, row]) => ({ table, key: keyOf(table, row), row })),
    },
  ]);
}
function fake(url: string, method = "GET", headers = new Headers()): Request {
  return {
    url,
    method,
    headers,
    text() {
      throw new Error("must-not-read-stream");
    },
    json() {
      throw new Error("must-not-read-stream");
    },
    get body() {
      throw new Error("must-not-read-stream");
    },
  } as unknown as Request;
}
async function errorIs(response: Response | null, status: number, code: string) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: code });
}

test("pure helper ignores other paths without resolving View, exact routes only", () => {
  for (const path of [
    "/v1/state",
    "/v1/ui/tasks",
    "/v1/ui/task-runs/",
    "/v1/ui/task-runs/1/",
    "/v1/ui/task-runs/1/events",
    "/v1/ui/task-runs-extra",
    "/v1/ui/%74ask-runs",
  ]) {
    assert.equal(
      taskQueryHttp(fake(`http://fixture.invalid${path}`), () => {
        throw new Error("must-not-resolve");
      }),
      null,
    );
  }
});

test("GET list, initial detail and sections reuse query DTO without second trimming", async () => {
  const view = fixture();
  try {
    const cases: [string, unknown][] = [
      [root, listRuns(view)],
      [
        root + "?limit=1&before=10&state=queued&rule=r&agent=a",
        listRuns(view, { limit: 1, before: 10, state: "queued", rule: "r", agent: "a" }),
      ],
      [root + "?q=100%25&source=s&type=t", listRuns(view, { q: "100%", source: "s", type: "t" })],
      [root + "/1", readRunDetail(view, 1)],
      [root + "/1?section=events&limit=1", pageRunEvents(view, 1, { limit: 1 })],
      [root + "/1?section=cards&limit=1", pageRunCards(view, 1, { limit: 1 })],
      [root + "/1?section=related&limit=1", pageRelatedRuns(view, 1, { limit: 1 })],
      [root + "/1?section=feedback&limit=1", pageRunFeedback(view, 1, { limit: 1 })],
    ];
    for (const [url, expected] of cases) {
      let reads = 0;
      const response = taskQueryHttp(new Request(url), () => {
        reads++;
        return view;
      });
      assert.ok(response);
      assert.equal(response.status, 200);
      assert.equal(reads, 1);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type")!, /application\/json/);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), expected);
      assert.ok(
        new TextEncoder().encode(text).byteLength <= (url.startsWith(root + "/") ? DETAIL_MAX_BYTES : LIST_MAX_BYTES),
      );
    }
    const first = pageRunEvents(view, 1, { limit: 1 });
    const response = taskQueryHttp(fake(`${root}/1?section=events&cursor=${first.nextCursor}`), view)!;
    assert.deepEqual(await response.json(), pageRunEvents(view, 1, { cursor: first.nextCursor! }));
    const emptyView = empty();
    try {
      assert.deepEqual(await taskQueryHttp(fake(root), emptyView)!.json(), listRuns(emptyView));
    } finally {
      emptyView.close();
    }
  } finally {
    view.close();
  }
});

test("recognized non-GET methods return fixed 405 before View resolution", async () => {
  for (const method of ["POST", "HEAD", "PUT", "DELETE", "OPTIONS", "get"]) {
    const response = taskQueryHttp(fake(root, method), () => {
      throw new Error("must-not-resolve");
    });
    await errorIs(response, 405, "method-not-allowed");
    assert.equal(response!.headers.get("allow"), "GET");
  }
});

test("declared body and TE reject without touching stream or View", async () => {
  const declared: Record<string, string>[] = [
    { "content-length": "1" },
    { "content-length": "-1" },
    { "content-length": "01" },
    { "content-length": "abc" },
    { "content-length": "0, 0" },
    { "transfer-encoding": "chunked" },
    { "transfer-encoding": "" },
  ];
  for (const headers of declared) {
    await errorIs(
      taskQueryHttp(fake(root, "GET", new Headers(headers)), () => {
        throw new Error("must-not-resolve");
      }),
      400,
      "invalid-task-query",
    );
  }
  const view = empty();
  try {
    assert.equal(taskQueryHttp(fake(root, "GET", new Headers({ "content-length": "0" })), view)!.status, 200);
  } finally {
    view.close();
  }
});

test("strict query whitelist, duplicates, canonical numbers and 2KiB raw query cap", async () => {
  const invalid = [
    "?limit=0",
    "?limit=61",
    "?limit=01",
    "?limit=+1",
    "?limit=1.0",
    "?limit=1e1",
    "?before=-1",
    "?before=0",
    "?before=9007199254740992",
    "?limit=1&limit=2",
    "?%6cimit=1&limit=2",
    "?unknown=x",
    "?state=bogus",
    "?states=done",
    "?source=",
    "?q=",
    "?q=" + "x".repeat(201),
    "?q=%ZZ",
    "?q=%FF",
    "?q=x&&limit=1",
    "?q=x&",
    "?limit",
    "?" + "x".repeat(2049),
  ];
  for (const suffix of invalid)
    await errorIs(
      taskQueryHttp(fake(root + suffix), () => {
        throw new Error("must-not-resolve");
      }),
      400,
      "invalid-task-query",
    );
  const view = fixture();
  try {
    assert.equal(taskQueryHttp(fake(root + "?q=" + "x".repeat(200)), view)!.status, 200);
    // Raw query reaches exactly 2048 bytes while decoded q stays below its 200-code-point contract.
    const exact =
      "?q=" +
      "%78".repeat(200) +
      "&rule=" +
      "%72".repeat(200) +
      "&agent=" +
      "%61".repeat(200) +
      "&source=" +
      "%73".repeat(75);
    assert.equal(new TextEncoder().encode(exact.slice(1)).byteLength, 2048);
    assert.equal(taskQueryHttp(fake(root + exact), view)!.status, 200);
    await errorIs(taskQueryHttp(fake(root + exact + "s"), view), 400, "invalid-task-query");
  } finally {
    view.close();
  }
});

test("detail has no implicit pagination; only explicit valid section and bound cursor", async () => {
  const view = fixture();
  try {
    for (const suffix of [
      "?limit=1",
      "?cursor=x",
      "?q=x",
      "?section=bad",
      "?section=events&limit=41",
      "?section=events&before=2",
      "?section=cards&section=events",
      "?section=events&cursor=x",
    ]) {
      await errorIs(taskQueryHttp(fake(root + "/1" + suffix), view), 400, "invalid-task-query");
    }
    const wrongRun = encodeRunCursor({ version: 1, run: 9, section: "events", lastKey: "9:2" });
    const wrongSection = encodeRunCursor({ version: 1, run: 1, section: "cards", lastId: 3 });
    for (const cursor of [wrongRun, wrongSection])
      await errorIs(taskQueryHttp(fake(`${root}/1?section=events&cursor=${cursor}`), view), 400, "invalid-task-query");
    for (const id of ["0", "01", "-1", "1.0", "1e1", "9007199254740992", "%31", "abc"]) {
      await errorIs(taskQueryHttp(fake(root + "/" + id), view), 400, "invalid-task-query");
    }
  } finally {
    view.close();
  }
});

test("missing run is 404; underlying failures are fixed 500, never exposed", async () => {
  const view = empty();
  try {
    await errorIs(taskQueryHttp(fake(root + "/1"), view), 404, "run-not-found");
    await errorIs(taskQueryHttp(fake(root + "/1?section=events"), view), 404, "run-not-found");
    await errorIs(
      taskQueryHttp(fake(root), () => {
        throw new Error("SECRET /private/path https://token");
      }),
      500,
      "task-query-failed",
    );
    // Resolver failures are not request errors even when their text resembles a known validation error.
    await errorIs(
      taskQueryHttp(fake(root), () => {
        throw new Error("invalid-task-query");
      }),
      500,
      "task-query-failed",
    );
    view.db.close();
    await errorIs(taskQueryHttp(fake(root), view), 500, "task-query-failed");
  } finally {
    /* Already closed deliberately to reproduce a failed SQLite read. */
  }
});

test("HTTP preserves query budget continuation and excludes capabilities from huge fixtures", async () => {
  const view = empty();
  const entries: [Table, Row][] = [];
  for (let id = 1; id <= 60; id++) {
    entries.push([
      "runs",
      {
        id,
        rule: "r",
        lane: "",
        agent: "a",
        state: "done",
        summary: "".repeat(500),
        error: "".repeat(500),
        session: "SECRET",
        link: "https://SECRET",
        token: "SECRET",
      },
    ]);
    if (id <= 40)
      entries.push(
        [
          "events",
          { id, source: "s", type: "t", summary: "".repeat(500), detail: "😀".repeat(10000), link: "https://SECRET" },
        ],
        ["run_events", { run_id: 1, event_id: id }],
        [
          "cards",
          {
            id,
            run_id: 1,
            kind: "ask",
            state: "open",
            title: "title",
            text: "".repeat(2000),
            answer: "".repeat(2000),
            options: "[]",
            token: "SECRET",
          },
        ],
      );
  }
  const committed = evolve(view, [
    {
      version: 1,
      seq: 1,
      at: 0,
      type: "budget-fixture",
      changes: entries.map(([table, row]) => ({ table, key: keyOf(table, row), row })),
    },
  ]);
  try {
    const expected = listRuns(committed, { limit: 60 });
    assert.ok(expected.items.length < 60);
    const response = taskQueryHttp(fake(root + "?limit=60"), committed)!;
    const text = await response.text();
    assert.ok(new TextEncoder().encode(text).byteLength <= LIST_MAX_BYTES);
    assert.deepEqual(JSON.parse(text), expected);
    assert.ok(!text.includes("SECRET"));
    const detail = readRunDetail(committed, 1);
    const detailText = await taskQueryHttp(fake(root + "/1"), committed)!.text();
    assert.ok(new TextEncoder().encode(detailText).byteLength <= DETAIL_MAX_BYTES);
    assert.deepEqual(JSON.parse(detailText), detail);
    assert.ok(!detailText.includes("SECRET"));
  } finally {
    view.close();
  }
});

test("production response validation blocks malformed projection shapes and remains read-only", async () => {
  const view = fixture();
  try {
    const before = snapshot(view),
      meta = view.db.prepare("SELECT * FROM projection_meta").all();
    const changes = view.db.prepare("SELECT total_changes() AS n").get();
    for (const url of [
      root,
      root + "/1",
      root + "/1?section=events",
      root + "/1?section=cards",
      root + "/1?section=related",
      root + "/1?section=feedback",
    ]) {
      assert.equal(taskQueryHttp(fake(url), view)!.status, 200);
    }
    assert.deepEqual(snapshot(view), before);
    assert.deepEqual(view.db.prepare("SELECT * FROM projection_meta").all(), meta);
    assert.deepEqual(view.db.prepare("SELECT total_changes() AS n").get(), changes);
    assert.equal(view.seq, 4);
    const malformed = evolve(view, [
      {
        version: 1,
        seq: 5,
        at: 0,
        type: "bad-fixture",
        changes: [{ table: "runs", key: "1", row: { id: 1, rule: "r", lane: "", agent: "a", state: "SECRET_STATE" } }],
      },
    ]);
    await errorIs(taskQueryHttp(fake(root), malformed), 500, "task-query-failed");
  } finally {
    view.close();
  }
});
