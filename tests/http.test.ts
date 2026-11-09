// The doors. Failure cases: a request without a key, with another kind's key, or with a made-up one gets in; a source posts
// as another source or tells under another's name; a worker waiting for work isn't handed what arrives while it waits, or
// waits forever when nothing comes; a lost answer to a claim loses the work; a run token is refused for its own run or taken
// in place of a worker key; an oversized or non-JSON body is read; health doesn't say which commit is running; state is open
// to anyone; a worker tells as a task that isn't its own, or one matter twice; a channel answers without being on the list;
// a cookie or a sign-in opens anything; someone other than the owner reads everything, answers, resolves or stops; looking
// at a card's link answers it; a card's words run as markup or the page loads a script; Enter in the text box picks the first
// option; a card link answers more than its card; a webhook with a bad signature is taken, or one without an adapter; a
// webhook's secret leaks into anything it returns; the owner's key opens the worker's door; a page other than a card's exists.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("http");
mkdirSync(join(home, "plugins", "echo"), { recursive: true });
writeFileSync(
  join(home, "plugins", "echo", "source.ts"),
  `
import { createHmac, timingSafeEqual } from "node:crypto";
export default function ({ headers, body, secret }) {
  const sign = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const given = String(headers["x-sign"] ?? "");
  if (given.length !== sign.length || !timingSafeEqual(Buffer.from(given), Buffer.from(sign))) throw new Error("bad signature");
  return JSON.parse(body).items;
}`,
);
process.env.AGENT_AUTOLOOP_SECRET_HOOKS = "hook-secret";
const { serve } = await import("../host/http.ts");
const { addKey } = await import("../host/runtime.ts");
const { all, one } = await import("../host/runtime.ts");

const keys = {
  app: addKey("source", "app"),
  ops: addKey("source", "ops"),
  w1: addKey("worker", "w1"),
  w2: addKey("worker", "w2"),
  chat: addKey("channel", "chat"),
  plain: addKey("channel", "plain"),
  owner: addKey("owner", "owner"),
};
const server = serve(0, "127.0.0.1", { commit: "abc123" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

type Options = {
  key?: string;
  body?: unknown;
  raw?: string;
  method?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
};
async function call(path: string, { key, body, raw, method, headers, redirect }: Options = {}) {
  const response = await fetch(base + path, {
    method: method ?? (body !== undefined || raw !== undefined ? "POST" : "GET"),
    redirect,
    headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json", ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, headers: response.headers };
}
const note = (n: number) => ({ id: `n:${n}`, type: "feedback.new", subject: `#${n}` });

test("health says which commit is running, and nothing else is open", async () => {
  assert.deepEqual((await call("/healthz")).json, { ok: true, commit: "abc123" });
  for (const path of ["/v1/state", "/v1/work", "/v1/cards/next"]) assert.equal((await call(path)).status, 401, path);
  assert.equal((await call("/v1/nope", { key: keys.owner })).status, 404);
});

test("each door takes its own kind of key and no other", async () => {
  assert.equal((await call("/v1/events", { body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: "made-up", body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: keys.w1, body: note(1) })).status, 401);
  assert.equal((await call("/v1/events", { key: keys.owner, body: note(1) })).status, 401);
  assert.equal((await call("/v1/work?claim=x&wait=0", { key: keys.app })).status, 401);
  assert.equal((await call("/v1/work?claim=x&wait=0", { key: keys.owner })).status, 401);
  assert.equal((await call("/v1/cards/next?wait=0", { key: keys.w1 })).status, 401);
  assert.equal((await call("/v1/state", { key: keys.w1 })).status, 401);
  assert.equal((await call("/v1/state", { key: keys.owner })).status, 200);
  const taken = await call("/v1/events", { key: keys.app, body: note(1) });
  assert.equal(taken.status, 200);
  assert.deepEqual(taken.json.routed, ["意见"]);
  assert.equal(all<{ source: string }>("SELECT source FROM events")[0].source, "app", "the key says who it's from");
});

test("a bad body is refused", async () => {
  assert.equal((await call("/v1/events", { key: keys.app, raw: "{not json" })).status, 400);
  assert.equal(
    (
      await call("/v1/events", {
        key: keys.app,
        raw: JSON.stringify({ id: "x", type: "y", detail: "z".repeat(2 * 1024 * 1024) }),
      })
    ).status,
    413,
  );
  assert.equal((await call("/v1/events", { key: keys.app, body: { type: "no.id" } })).status, 400);
});

test("a worker's wait: what arrives while it waits comes at once; nothing comes, it ends; a lost answer gets the work back", async () => {
  const empty = await call("/v1/work?claim=empty&wait=0&running=", { key: keys.w2 });
  assert.deepEqual(empty.json, { job: null, cancel: [] });
  const waiting = call("/v1/work?claim=c-2&wait=5", { key: keys.w2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call("/v1/events", { key: keys.ops, body: { id: "a:1", type: "alert.raised", subject: "x" } });
  const started = Date.now();
  const got = await waiting;
  assert.ok(Date.now() - started < 2000);
  assert.equal(got.json.job.rule.name, "告警");
  const again = await call("/v1/work?claim=c-2&wait=0", { key: keys.w2 });
  assert.equal(again.json.job.run, got.json.job.run, "the same claim gets the same work back");
  // Only the latest token holds the run.
  const refused = await call(`/v1/runs/${got.json.job.run}/result`, {
    key: got.json.job.token,
    body: { outcome: "done" },
  });
  assert.equal(refused.status, 401);
  assert.equal(
    (await call(`/v1/runs/${again.json.job.run}/started`, { key: keys.w2, body: { link: "x://y" } })).status,
    401,
    "a worker key isn't a run's token",
  );
  assert.equal(
    (
      await call(`/v1/runs/${again.json.job.run}/started`, {
        key: again.json.job.token,
        body: { session: "s", link: "x://y" },
      })
    ).status,
    200,
  );
  const result = { outcome: "done", summary: "好了", ask: [{ title: "问", text: "怎么办", options: ["甲", "乙"] }] };
  const done = await call(`/v1/runs/${again.json.job.run}/result`, { key: again.json.job.token, body: result });
  assert.deepEqual(done.json, { rejected: [] });
  const replay = await call(`/v1/runs/${again.json.job.run}/result`, { key: again.json.job.token, body: result });
  assert.equal(replay.json.duplicate, true);
  const conflict = await call(`/v1/runs/${again.json.job.run}/result`, {
    key: again.json.job.token,
    body: { outcome: "done", summary: "别的" },
  });
  assert.equal(conflict.status, 409);
  const bad = await call(`/v1/work?claim=${"x".repeat(201)}&wait=0`, { key: keys.w2 });
  assert.equal(bad.status, 400);
});

test("a source tells under its own name, once per key; a worker only as its own task", async () => {
  const told = await call("/v1/tell", { key: keys.app, body: { key: "weekly-44", text: "周报" } });
  assert.deepEqual([told.status, told.json.duplicate], [200, false]);
  assert.equal(one<{ title: string }>("SELECT title FROM cards WHERE id = ?", [told.json.card])!.title, "应用");
  assert.equal(
    (await call("/v1/tell", { key: keys.app, body: { key: "weekly-44", text: "周报" } })).json.duplicate,
    true,
  );
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "Bad Key", text: "x" } })).status, 400);
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "k", text: " " } })).status, 400);
  assert.equal((await call("/v1/tell", { key: keys.app, body: { key: "k", text: "x", oops: 1 } })).status, 400);
  assert.equal((await call("/v1/tell", { body: { key: "k", text: "x" } })).status, 401);
  const task = await call("/v1/tell", { key: keys.w1, body: { task: "每周清理", key: "m", text: "要你看一眼" } });
  assert.equal(task.status, 200);
  assert.equal(one<{ title: string }>("SELECT title FROM cards WHERE id = ?", [task.json.card])!.title, "每周清理");
  assert.equal(
    (await call("/v1/tell", { key: keys.w2, body: { task: "每周清理", key: "m2", text: "x" } })).status,
    401,
    "not a task of its agents",
  );
  assert.equal(
    (await call("/v1/tell", { key: keys.w1, body: { task: "没有这个", key: "m3", text: "x" } })).status,
    401,
  );
});

test("a channel comes for cards, reports them, and passes on who answered; the list decides", async () => {
  // Everything so far for this channel, oldest first, then an empty wait.
  const seen: any[] = [];
  for (;;) {
    const { json } = await call("/v1/cards/next?wait=0", { key: keys.chat });
    if (!json.card) break;
    seen.push(json.card);
    assert.equal(
      (
        await call(`/v1/cards/${json.card.id}/delivered`, {
          key: keys.chat,
          body: { version: json.card.version, ref: `om_${json.card.id}` },
        })
      ).status,
      200,
    );
  }
  const ask = seen.find((c) => c.kind === "ask");
  assert.deepEqual(ask.options, ["甲", "乙"]);
  const url = `/v1/cards/${ask.id}/answer`;
  assert.equal((await call(url, { key: keys.w1, body: { choice: 0, by: "me", ref: `om_${ask.id}` } })).status, 401);
  assert.equal(
    (await call(url, { key: keys.chat, body: { choice: 0, by: "stranger", ref: `om_${ask.id}` } })).status,
    401,
  );
  assert.equal((await call(url, { key: keys.chat, body: { choice: 0, by: "me", ref: "om_other" } })).status, 401);
  assert.equal((await call(url, { key: keys.chat, body: { choice: 9, by: "me", ref: `om_${ask.id}` } })).status, 400);
  const yes = await call(url, { key: keys.chat, body: { choice: 1, by: "me", ref: `om_${ask.id}` } });
  assert.deepEqual([yes.status, yes.json.changed], [200, true]);
  assert.equal(
    (await call(url, { key: keys.chat, body: { choice: 0, by: "me", ref: `om_${ask.id}` } })).json.changed,
    false,
  );
  const next = await call("/v1/work?claim=c-3&wait=0", { key: keys.w2 });
  assert.equal(next.json.job.context.answers[0].choice, 1);
  await call(`/v1/runs/${next.json.job.run}/result`, {
    key: next.json.job.token,
    body: { outcome: "done", summary: "选了乙" },
  });
  assert.equal(
    (await call(`/v1/cards/${ask.id}/failed`, { key: keys.chat, body: { version: 1, error: "x" } })).status,
    200,
  );
  assert.equal(
    (await call("/v1/cards/99999/delivered", { key: keys.chat, body: { version: 1, ref: "x" } })).status,
    404,
  );
});

test("the owner's key reads everything, answers, resolves and stops; nothing else does, and there's no sign-in", async () => {
  assert.equal((await call("/v1/login/code", { key: keys.owner, body: {} })).status, 404);
  assert.equal((await call("/login?code=x", { redirect: "manual" })).status, 404);
  assert.equal((await call("/v1/state", { headers: { cookie: "agent_autoloop_session=x" } })).status, 401);
  assert.ok(Array.isArray((await call("/v1/state", { key: keys.owner })).json.runs));

  await call("/v1/events", { key: keys.app, body: note(50) });
  const job = (await call("/v1/work?claim=c-9&wait=0", { key: keys.w1 })).json.job;
  const asked = {
    outcome: "done",
    ask: [{ title: "本人答", text: "选一个", options: ["甲", "乙"], key: "own" }],
    notice: [{ title: "看看", text: "这个" }],
  };
  await call(`/v1/runs/${job.run}/result`, { key: job.token, body: asked });
  const [card, notice] = (await call("/v1/state", { key: keys.owner })).json.cards
    .sort((a: any, b: any) => a.id - b.id)
    .slice(-2);
  assert.equal(card.link, null, "a link only goes to a channel allowed to have one");
  const url = `/v1/cards/${card.id}/answer`;
  assert.equal((await call(url, { body: { choice: 0 } })).status, 401);
  assert.equal((await call(url, { key: keys.w1, body: { choice: 0 } })).status, 401);
  assert.equal((await call(url, { key: keys.owner, body: { choice: 0 } })).json.changed, true);
  assert.equal(one<{ by: string }>("SELECT by FROM cards WHERE id = ?", [card.id])!.by, "本人");
  assert.equal((await call(`/v1/cards/${notice.id}/resolve`, { body: { reason: "处理了" } })).status, 401);
  assert.equal((await call(`/v1/cards/${notice.id}/resolve`, { key: keys.owner, body: { reason: " " } })).status, 400);
  const resolved = await call(`/v1/cards/${notice.id}/resolve`, { key: keys.owner, body: { reason: "处理了" } });
  assert.deepEqual([resolved.status, resolved.json.changed], [200, true]);
  const waiting = await call("/v1/work?claim=c-10&wait=0", { key: keys.w1 });
  assert.equal((await call(`/v1/runs/${waiting.json.job.run}/cancel`, { body: {} })).status, 401);
  assert.equal((await call(`/v1/runs/${waiting.json.job.run}/cancel`, { key: keys.owner, body: {} })).status, 200);
  assert.deepEqual((await call("/v1/work?claim=c-11&wait=0", { key: keys.w1 })).json.cancel, [waiting.json.job.run]);
  const memoed = await call(`/v1/runs/${waiting.json.job.run}/memo`, { key: keys.owner, body: { text: "x" } });
  assert.equal((await call(`/v1/runs/${waiting.json.job.run}/memo`, { body: { text: "x" } })).status, 401);
  assert.equal(
    (await call(`/v1/runs/${waiting.json.job.run}/memo`, { key: keys.w1, body: { text: "x" } })).status,
    401,
  );
  assert.equal(memoed.status, 400); // claimed but never started: no session to correct
  assert.match(memoed.json.error, /没有可接的会话/);
});

const form = (path: string, fields: string) =>
  call(path, { raw: fields, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
/** Has the agent ask this, and gets the link the channel that's only allowed to send words was given. */
async function linkFor(n: number, receipt: Record<string, unknown>) {
  await call("/v1/events", { key: keys.app, body: note(n) });
  const job = (await call(`/v1/work?claim=c-${n}&wait=0`, { key: keys.w1 })).json.job;
  await call(`/v1/runs/${job.run}/result`, { key: job.token, body: { outcome: "done", ...receipt } });
  let given: any;
  for (;;) {
    const { json } = await call("/v1/cards/next?wait=0", { key: keys.plain });
    if (!json.card) break;
    given = json.card;
    await call(`/v1/cards/${json.card.id}/delivered`, {
      key: keys.plain,
      body: { version: json.card.version, ref: "p" },
    });
  }
  return { id: given.id as number, path: new URL(given.link).pathname };
}
const stored = (id: number) =>
  one<{ state: string; choice: number | null; answer: string | null; by: string }>(
    "SELECT state, choice, answer, by FROM cards WHERE id = ?",
    [id],
  )!;

test("a card's link is a plain page: it shows that card as words, runs nothing, and only a press answers", async () => {
  const title = "<script>alert(1)</script>链接答";
  const { id, path } = await linkFor(60, {
    ask: [{ title, text: "选一个 & <b>别的</b>", options: ["甲", "乙<i>"], recommend: 0 }],
  });
  const page = await call(path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/html/);
  assert.ok(!/<script|<b>|<i>/.test(page.text), page.text);
  assert.ok(page.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;链接答"));
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(stored(id).state, "open", "looking at it, as a chat app previewing the link does, answers nothing");
  const forms = page.text.split("<form").slice(1);
  assert.equal(forms.length, 2);
  assert.ok(!forms[1].includes('name="choice"'), "Enter in the text box doesn't pick an option");

  assert.equal((await call("/c/made-up")).status, 404);
  assert.equal((await form("/c/made-up", "choice=0")).status, 404);
  assert.equal((await form(path, "choice=9")).status, 400);
  assert.equal((await form(path, "text=")).status, 400);
  assert.match((await form(path, "choice=9")).text, /没有这个选项/, "a person is told in words, not JSON");
  const yes = await form(path, "choice=1");
  assert.deepEqual([yes.status, yes.headers.get("location")], [303, path]);
  assert.deepEqual([stored(id).choice, stored(id).by], [1, "链接"]);
  assert.ok((await call(path)).text.includes("你选了「乙&lt;i&gt;」"));
  assert.ok(!(await call(path)).text.includes("<form"), "nothing left to press");
  assert.equal((await form(path, "choice=0")).status, 303);
  assert.equal(stored(id).choice, 1, "only the first press counts");
  assert.equal((await call(`${path}.json`)).status, 404);
});

test("a card's link takes words of your own, and a notice has one button", async () => {
  const asked = await linkFor(61, {
    ask: [{ title: "别的想法", text: "选一个", options: ["甲", "乙"], key: "words" }],
  });
  assert.equal((await form(asked.path, `text=${encodeURIComponent("都不要")}`)).status, 303);
  assert.deepEqual([stored(asked.id).choice, stored(asked.id).answer], [null, "都不要"]);
  assert.ok((await call(asked.path)).text.includes("你选了「都不要」"));
  const told = await linkFor(62, { notice: [{ title: "留意一下", text: "磁盘快满了", key: "disk" }] });
  const page = await call(told.path);
  assert.equal(page.text.split("<form").length - 1, 1);
  assert.ok(page.text.includes("已处理"));
  assert.equal((await form(told.path, "choice=0")).status, 303);
  assert.equal(stored(told.id).state, "closed");
});

test("someone else's webhook goes through its source's adapter: signed, or not taken", async () => {
  const items = JSON.stringify({
    items: [
      { id: "h1", type: "push.done", subject: "main" },
      { id: "h2", type: "push.done" },
    ],
  });
  const sign = (body: string) => "sha256=" + createHmac("sha256", "hook-secret").update(body).digest("hex");
  const taken = await call("/v1/in/hooks", { raw: items, headers: { "x-sign": sign(items) } });
  assert.equal(taken.status, 200);
  assert.deepEqual(
    taken.json.events.map((e: any) => e.duplicate),
    [false, false],
  );
  assert.equal(
    (await call("/v1/in/hooks", { raw: items, headers: { "x-sign": sign(items) } })).json.events[0].duplicate,
    true,
  );
  const refused = await call("/v1/in/hooks", { raw: items, headers: { "x-sign": "sha256=00" } });
  assert.equal(refused.status, 401);
  assert.ok(!refused.text.includes("hook-secret"));
  assert.equal((await call("/v1/in/app", { raw: items })).status, 404, "a source without an adapter takes no webhooks");
  assert.equal((await call("/v1/in/nowhere", { raw: items })).status, 404);
});

test("a rating of a delivered run is the owner's alone, and only after the run ended as done", async () => {
  await call("/v1/events", { key: keys.app, body: note(60) });
  const job = (await call("/v1/work?claim=c-fb&wait=0", { key: keys.w1 })).json.job;
  const path = `/v1/runs/${job.run}/feedback`;
  const rating = { kind: "交付满意", text: "做得对" };
  assert.equal((await call(path, { body: rating })).status, 401, "no key");
  assert.equal((await call(path, { key: keys.w1, body: rating })).status, 401, "a worker's key is not the owner's");
  assert.equal((await call(path, { key: keys.app, body: rating })).status, 401, "a source's key is not the owner's");
  assert.equal((await call(path, { key: keys.owner, body: rating })).status, 400, "claimed but not delivered");
  await call(`/v1/runs/${job.run}/result`, { key: job.token, body: { outcome: "done", summary: "做了" } });
  assert.equal((await call(path, { key: keys.owner, body: { kind: "随便", text: "x" } })).status, 400);
  assert.equal((await call(path, { key: keys.owner, body: { kind: "交付满意", text: " " } })).status, 400);
  const saved = await call(path, { key: keys.owner, body: rating });
  assert.deepEqual([saved.status, saved.json.ok], [200, true]);
  assert.ok(Number.isSafeInteger(saved.json.id));
  assert.deepEqual(
    all<{ run_id: number; kind: string; text: string }>("SELECT run_id,kind,text FROM feedback WHERE id = ?", [
      saved.json.id,
    ]),
    [{ run_id: job.run, kind: "交付满意", text: "做得对" }],
  );
  // The run keeps the outcome it had; a rating is a record, not a new turn.
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.equal((await call("/v1/runs/99999/feedback", { key: keys.owner, body: rating })).status, 404);
});

test("the console is the only page: everything else is read through the doors", async () => {
  for (const path of ["/", "/app.js", "/style.css"]) {
    const page = await call(path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/, path);
  }
  for (const path of ["/index.html", "/../package.json", "/nope.js"])
    assert.equal((await call(path)).status, 404, path);
  assert.equal((await call("/v1/state")).status, 401);
});
