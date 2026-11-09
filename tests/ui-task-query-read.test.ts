// Guards against task-query routes bypassing real owner auth, stale/revoked keys, pre-auth
// validation and transport rewriting. Behavior uses only pure modules and empty/evolve memory DBs.
// ui/server/runtime are read as source text only: these are not live uiRoutes integration tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { digest, whose } from "../kernel/credentials.ts";
import { AuthError } from "../kernel/errors.ts";
import { empty, evolve, keyOf, snapshot, type Row, type Table, type View } from "../kernel/evolve.ts";
import { requireOwner, uiRead } from "../host/ui-read.ts";
import { taskQueryHttp } from "../host/task-query-http.ts";
import { listRuns, readRunDetail, pageRunEvents, pageRunCards, pageRelatedRuns } from "../host/desktop-task-query.ts";
import { LIST_MAX_BYTES, DETAIL_MAX_BYTES } from "../host/desktop-task-query-contract.ts";

const root = "http://fixture.invalid/v1/ui/task-runs";
const owner = "fake-owner-key";
const ui = readFileSync(new URL("../host/ui.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../host/server.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../host/runtime.ts", import.meta.url), "utf8");
const read = () => readFileSync(new URL("../host/ui-read.ts", import.meta.url), "utf8");
function apply(view: View, entries: [Table, Row][]) {
  return evolve(view, [
    {
      version: 1,
      seq: view.seq + 1,
      at: 0,
      type: "fixture",
      changes: entries.map(([table, row]) => ({ table, key: keyOf(table, row), row })),
    },
  ]);
}
function fixture() {
  return apply(empty(), [
    ...["owner", "worker", "source", "channel"].map((kind): [Table, Row] => [
      "keys",
      { kind, name: kind, hash: digest(`fake-${kind}-key`) },
    ]),
    ...[1, 2, 9].map((id): [Table, Row] => [
      "runs",
      { id, rule: "r", lane: "", agent: "a", state: "done", summary: `run ${id}` },
    ]),
    ...[2, 10].flatMap((id): [Table, Row][] => [
      ["events", { id, source: "s", type: "t", summary: "summary", detail: "detail" }],
      ["run_events", { run_id: 1, event_id: id }],
      ["cards", { id, run_id: 1, kind: "ask", state: "open", title: "question", text: "text", options: '["yes"]' }],
    ]),
  ]);
}
function fake(url = root, method = "GET", token: string | null = owner, extra: Record<string, string> = {}): Request {
  return {
    url,
    method,
    headers: new Headers({ ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra }),
    text() {
      throw new Error("must-not-read-body");
    },
    json() {
      throw new Error("must-not-read-body");
    },
    get body() {
      throw new Error("must-not-read-body");
    },
  } as unknown as Request;
}
// A pure composition only, not a replacement router or an execution of host/ui.ts.
function authenticatedRead(request: Request, latest: View) {
  requireOwner(request, latest);
  return uiRead(request, latest);
}
async function errorIs(response: Response | null, status: number, error: string) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error });
}
function ownerDenied(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof AuthError && error.message === "要用本人的密钥（Bearer）");
}

test("real requireOwner preserves legacy Bearer parsing and credential-kind authorization", () => {
  const view = fixture();
  try {
    assert.equal(requireOwner(fake(), view), "owner");
    for (const token of [null, "", "wrong", "fake-worker-key", "fake-source-key", "fake-channel-key"])
      ownerDenied(() => requireOwner(fake(root, "GET", token), view));
    for (const authorization of ["bearer " + owner, "Bearer", "Basic " + owner, "Bearer  " + owner])
      ownerDenied(() => requireOwner(fake(root, "GET", null, { authorization }), view));
    // Business whose deliberately differs from the newer strict identity endpoints.
    const updated = apply(view, [
      ["keys", { kind: "owner", name: "space-owner", hash: digest("fake key with spaces") }],
    ]);
    assert.equal(requireOwner(fake(root, "GET", "fake key with spaces"), updated), "space-owner");
    assert.equal(whose(updated, "owner", owner), requireOwner(fake(), updated));
    const ambiguous = apply(updated, [["keys", { kind: "worker", name: "same-hash", hash: digest(owner) }]]);
    assert.equal(requireOwner(fake(), ambiguous), "owner");
  } finally {
    view.close();
  }
});

test("latest keys rotate and revoke immediately; auth reads keys exactly once", () => {
  let view = fixture();
  try {
    const original = view.select.bind(view);
    let keysReads = 0;
    view.select = (...args) => {
      if (args[0] === "keys") keysReads++;
      return original(...args);
    };
    assert.equal(authenticatedRead(fake(), view)!.status, 200);
    assert.equal(keysReads, 1);
    view = apply(view, [["keys", { kind: "owner", name: "owner", hash: digest("fake-rotated-key") }]]);
    ownerDenied(() => authenticatedRead(fake(), view));
    assert.equal(authenticatedRead(fake(root, "GET", "fake-rotated-key"), view)!.status, 200);
    view = evolve(view, [
      {
        version: 1,
        seq: view.seq + 1,
        at: 0,
        type: "fixture-revoke",
        changes: [{ table: "keys", key: "owner:owner", row: null }],
      },
    ]);
    ownerDenied(() => authenticatedRead(fake(root, "GET", "fake-rotated-key"), view));
  } finally {
    view.close();
  }
});

test("auth rejection precedes method, body, query and ID validation without reading streams", async () => {
  const view = fixture();
  try {
    for (const token of [null, "fake-worker-key", "fake-source-key", "fake-channel-key"]) {
      for (const method of ["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS"])
        ownerDenied(() =>
          authenticatedRead(fake(root + "/01?unknown=x", method, token, { "content-length": "1" }), view),
        );
    }
    for (const method of ["POST", "HEAD", "PUT", "DELETE", "OPTIONS", "get"]) {
      for (const url of [root + "?unknown=x", root + "/01?section=bad"])
        await errorIs(
          authenticatedRead(fake(url, method, owner, { "transfer-encoding": "chunked" }), view),
          405,
          "method-not-allowed",
        );
      assert.equal(authenticatedRead(fake(root, method), view)!.headers.get("allow"), "GET");
    }
    for (const [url, headers] of [
      [root, { "content-length": "1" }],
      [root, { "transfer-encoding": "chunked" }],
      [root + "?limit=01", {}],
      [root + "?limit=1&limit=2", {}],
      [root + "/01", {}],
    ] as [string, Record<string, string>][])
      await errorIs(authenticatedRead(fake(url, "GET", owner, headers), view), 400, "invalid-task-query");
  } finally {
    view.close();
  }
});

test("exact paths delegate only root or one nonempty segment, without early ID validation", async () => {
  const view = fixture();
  try {
    for (const path of [
      "/v1/state",
      "/v1/ui/tasks",
      "/v1/ui/task-runs/",
      "/v1/ui/task-runs/1/",
      "/v1/ui/task-runs//",
      "/v1/ui/task-runs/1/events",
      "/v1/ui/task-runs-extra",
      "/v1/ui/%74ask-runs",
    ])
      assert.equal(uiRead(fake("http://fixture.invalid" + path), view), null);
    for (const id of ["0", "01", "-1", "1.0", "1e1", "9007199254740992", "%31", "abc"])
      await errorIs(authenticatedRead(fake(root + "/" + id), view), 400, "invalid-task-query");
    await errorIs(authenticatedRead(fake(root + "/999"), view), 404, "run-not-found");
  } finally {
    view.close();
  }
});

test("pure composition returns query DTOs and section cursors unchanged on the supplied View", async () => {
  const view = fixture();
  try {
    const before = snapshot(view);
    const meta = view.db.prepare("SELECT * FROM projection_meta").all();
    const changes = view.db.prepare("SELECT total_changes() AS n").get();
    const cases: [string, unknown][] = [
      [root, listRuns(view)],
      [root + "?limit=1&before=9", listRuns(view, { limit: 1, before: 9 })],
      [root + "/1", readRunDetail(view, 1)],
      [root + "/1?section=events&limit=1", pageRunEvents(view, 1, { limit: 1 })],
      [root + "/1?section=cards&limit=1", pageRunCards(view, 1, { limit: 1 })],
      [root + "/1?section=related&limit=1", pageRelatedRuns(view, 1, { limit: 1 })],
    ];
    for (const [url, expected] of cases) {
      const actual = authenticatedRead(fake(url), view)!;
      const direct = taskQueryHttp(fake(url), view)!;
      assert.equal(actual.status, direct.status);
      assert.deepEqual([...actual.headers], [...direct.headers]);
      const text = await actual.text();
      assert.equal(text, await direct.text());
      assert.deepEqual(JSON.parse(text), expected);
    }
    for (const section of ["events", "cards", "related"] as const) {
      const page = { events: pageRunEvents, cards: pageRunCards, related: pageRelatedRuns }[section];
      const first = page(view, 1, { limit: 1 });
      assert.equal(first.hasMore, true);
      const url = `${root}/1?section=${section}&limit=1&cursor=${first.nextCursor}`;
      assert.deepEqual(
        await authenticatedRead(fake(url), view)!.json(),
        page(view, 1, { limit: 1, cursor: first.nextCursor! }),
      );
      await errorIs(
        authenticatedRead(fake(`${root}/2?section=${section}&cursor=${first.nextCursor}`), view),
        400,
        "invalid-task-query",
      );
    }
    assert.deepEqual(snapshot(view), before);
    assert.deepEqual(view.db.prepare("SELECT * FROM projection_meta").all(), meta);
    assert.deepEqual(view.db.prepare("SELECT total_changes() AS n").get(), changes);
    const blank = empty();
    try {
      assert.deepEqual(await uiRead(fake(root), blank)!.json(), listRuns(blank));
    } finally {
      blank.close();
    }
  } finally {
    view.close();
  }
});

test("budget-bounded pages and continuation survive uiRead without another trim", async () => {
  const view = fixture();
  const entries: [Table, Row][] = [];
  for (let id = 11; id <= 70; id++) {
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
        token: "fake-hidden-capability",
      },
    ]);
    if (id <= 50)
      entries.push(
        ["events", { id, source: "s", type: "t", summary: "".repeat(500), detail: "😀".repeat(3000) }],
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
          },
        ],
      );
  }
  const latest = apply(view, entries);
  try {
    const expectedList = listRuns(latest, { limit: 60 });
    assert.ok(expectedList.items.length < 60 && expectedList.hasMore);
    for (const [url, expected, max] of [
      [root + "?limit=60", expectedList, LIST_MAX_BYTES],
      [root + "/1", readRunDetail(latest, 1), DETAIL_MAX_BYTES],
      [root + "/1?section=events&limit=40", pageRunEvents(latest, 1, { limit: 40 }), DETAIL_MAX_BYTES],
      [root + "/1?section=cards&limit=40", pageRunCards(latest, 1, { limit: 40 }), DETAIL_MAX_BYTES],
    ] as [string, unknown, number][]) {
      const text = await authenticatedRead(fake(url), latest)!.text();
      assert.ok(new TextEncoder().encode(text).byteLength <= max);
      assert.deepEqual(JSON.parse(text), expected);
      assert.ok(!text.includes("fake-hidden-capability"));
    }
    const detail = readRunDetail(latest, 1);
    assert.ok(detail.events.hasMore && detail.cards.hasMore);
    for (const section of ["events", "cards"] as const) {
      const cursor = detail[section].nextCursor!;
      const page = section === "events" ? pageRunEvents : pageRunCards;
      assert.deepEqual(
        await authenticatedRead(fake(`${root}/1?section=${section}&cursor=${cursor}`), latest)!.json(),
        page(latest, 1, { cursor }),
      );
    }
  } finally {
    view.close();
  }
});

test("STATIC api wiring captures latest, authenticates once, immediately returns the original read Response", () => {
  const api = ui.slice(ui.indexOf("async function api("), ui.indexOf("/** The page and its doors;"));
  assert.match(ui, /import \{ requireOwner, uiRead \} from "\.\/ui-read\.ts";/);
  assert.doesNotMatch(ui, /function requireOwner\(/);
  const denied = ui.slice(ui.indexOf("const denied ="), ui.indexOf("// Original declarations"));
  assert.match(denied, /error instanceof AuthError\s*\? 401/);
  assert.match(
    api,
    /const latest = hub\.getView\(\);\s*requireOwner\(request, latest\);\s*const read = uiRead\(request, latest\);\s*if \(read !== null\) return read;/,
  );
  // One view is captured for the whole prologue and feeds both auth and the pure read. A later capture is
  // allowed only as the save reply's version after the write; it must never re-authenticate or re-read.
  const prologue = api.slice(0, api.indexOf("if (read !== null) return read;"));
  assert.equal((prologue.match(/hub\.getView\(/g) ?? []).length, 1);
  assert.equal((api.match(/requireOwner\(/g) ?? []).length, 1);
  assert.equal((api.match(/uiRead\(/g) ?? []).length, 1);
  assert.ok(api.indexOf("if (read !== null) return read;") < api.indexOf('pathname === "/v1/ui/rules"'));
  assert.match(
    server,
    /const handle = async \(request: Request\) => \(await uiRoutes\(request\)\) \?\? kernel\(request\);/,
  );
  assert.match(runtime, /export const whose = \(kind: string, key: string\) => keyHolder\(getView\(\), kind, key\);/);
});

test("STATIC route predicate has exact task paths, no method/ID checks; pure module has fixed dependency and response flow", () => {
  const routes = ui.slice(ui.indexOf("export async function uiRoutes("));
  const guard = routes.slice(
    routes.indexOf("if (", routes.indexOf("return asset(pathname);")),
    routes.indexOf("try {"),
  );
  assert.ok(guard.includes('pathname === "/v1/ui/task-runs"'));
  assert.ok(guard.includes("/^\\/v1\\/ui\\/task-runs\\/([^/]+)$/.test(pathname)"));
  assert.doesNotMatch(guard, /request\.method|\[0-9\]|\\d|runId|parse/);
  const source = read();
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(
    imports,
    ["../kernel/credentials.ts", "../kernel/errors.ts", "../kernel/evolve.ts", "./task-query-http.ts"].sort(),
  );
  assert.ok(source.includes('const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");'));
  assert.match(source, /given && whose\(latest, "owner", given\[1\]\)/);
  assert.match(
    source,
    /export function uiRead\(request: Request, latest: View\): Response \| null \{\s*return taskQueryHttp\(request, latest\);\s*\}/,
  );
  assert.doesNotMatch(source, /\bawait\b|hub\.|getView|tick|ingest|Response\.|cursor|runtime|home\.ts|plugins/);
});
