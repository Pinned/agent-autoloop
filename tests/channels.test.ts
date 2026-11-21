// The channels that ship and the webhook adapter. No real listener runs here: only one can hold an app's card clicks.
// Failure cases: a first send uses a key that changes with the version, or an update sends a new message; a failed send
// isn't reported; a click that isn't a card's is taken; a card's options don't show while it's open or still show after;
// the listener dying isn't started again. A GitHub webhook with a bad signature, or with none, is taken; what isn't an
// identifier reaches the subject; a ping makes an event; replacement tokens in card text rewrite a webhook template.
// A slow CLI call must not block the hub's HTTP loop while looking up a user, sending or updating a card.
// Feishu forms must submit choice and text together, reject malformed/empty submissions, never submit a select callback,
// preserve legacy clicks and identity/ref for hub validation, and display untrusted text without markup.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu, { matchesPairingMessage, render, type FeishuTransport } from "../plugins/feishu/channel.ts";
import webhook from "../plugins/webhook/channel.ts";
import github from "../plugins/github/source.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channels-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

test("a card shows its options while it's open, and what became of it after", () => {
  const open = render(base);
  const form = open.body.elements.find((e) => e.tag === "form") as any;
  assert.equal(form.name, "answer");
  const select = form.elements.find((e: any) => e.tag === "select_static");
  assert.equal(select.name, "choice");
  assert.equal(select.required, false);
  assert.deepEqual(
    select.options,
    base.options.map((content, i) => ({ text: { tag: "plain_text", content }, value: String(i) })),
  );
  assert.deepEqual(select.behaviors, [{ type: "callback", value: { card: 5 } }]);
  const input = form.elements.find((e: any) => e.tag === "input");
  assert.equal(input.name, "text");
  assert.equal(input.required, false);
  assert.deepEqual(input.placeholder, { tag: "plain_text", content: "补充说明或其他要求" });
  const button = form.elements.find((e: any) => e.tag === "button");
  assert.equal(button.name, "submit");
  assert.equal(button.form_action_type, "submit");
  assert.deepEqual(button.behaviors, [{ type: "callback", value: { card: 5, submit: true } }]);
  const literal = "**正文** <at id=all>所有人</at>\n第二行";
  const safe = render({ ...base, text: literal, state: "decided", choice: 1, answer: literal });
  assert.ok(!JSON.stringify(safe).includes('"tag":"markdown"'));
  assert.deepEqual(safe.body.elements[0], { tag: "div", text: { tag: "plain_text", content: literal } });
  assert.match(JSON.stringify(safe), /留着[\s\S]*补充说明/);
  assert.equal(
    render({ ...base, options: [] }).body.elements.some((e: any) => e.tag === "form"),
    true,
  );
  assert.equal(
    render({ ...base, kind: "notice", options: [] }).body.elements.some((e: any) => e.tag === "form"),
    false,
  );
  const notice = render({ ...base, kind: "notice", options: ["已处理"] });
  const noticeButton = notice.body.elements.find((element) => element.tag === "interactive_container") as any;
  assert.ok(noticeButton, "an open notice keeps its acknowledgement entry");
  assert.deepEqual(noticeButton.behaviors, [{ type: "callback", value: { card: 5, choice: 0 } }]);
  assert.deepEqual(noticeButton.elements, [{ tag: "div", text: { tag: "plain_text", content: "已处理" } }]);
  const said = (card: Card) => JSON.stringify(render(card).body.elements);
  assert.match(said({ ...base, state: "decided", choice: 1 }), /你选了「留着」，已记录/);
  assert.ok(!said({ ...base, state: "decided", choice: 1 }).includes("callback"));
  assert.match(said({ ...base, state: "done", choice: 0, result: "删了" }), /你选了「删」。已执行：删了/);
  assert.match(said({ ...base, state: "decided", answer: "归档" }), /你选了「归档」/);
  assert.match(said({ ...base, state: "closed", result: "问题自己好了" }), /不用决定了：问题自己好了/);
  assert.match(said({ ...base, kind: "notice", state: "closed", options: [], result: "已处理" }), /已处理/);
});

test("feishu pairing code matcher accepts exact 6-digit text and group mentions, rejects others", () => {
  assert.equal(
    matchesPairingMessage({ message_type: "text", content: JSON.stringify({ text: "482910" }) }, "482910"),
    true,
  );
  assert.equal(
    matchesPairingMessage({ message_type: "text", content: JSON.stringify({ text: "@_user_1  482910 " }) }, "482910"),
    true,
  );
  assert.equal(
    matchesPairingMessage({ message_type: "text", content: JSON.stringify({ text: "hello" }) }, "482910"),
    false,
  );
  assert.equal(
    matchesPairingMessage({ message_type: "text", content: JSON.stringify({ text: "482911" }) }, "482910"),
    false,
  );
  assert.equal(
    matchesPairingMessage({ message_type: "image", content: JSON.stringify({ text: "482910" }) }, "482910"),
    false,
  );
  assert.equal(matchesPairingMessage({ message_type: "text", content: "not-json" }, "482910"), false);
});

test("feishu rejects missing credentials when no custom transport is supplied", async () => {
  const stop = new AbortController();
  await assert.rejects(
    () => feishu({ hub: {} as any, options: {}, log: () => {}, signal: stop.signal }),
    /appId.*appSecret.*user/,
  );
});

test("feishu SDK transport sends once per card, updates in place, reports failure, and closes listener on abort", async () => {
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  const sent: Array<{ cardId: number; user: string; content: string }> = [];
  const patched: Array<{ ref: string; content: string }> = [];
  let closed = false;
  let answered!: () => void;
  const clickHandled = new Promise<void>((resolve) => {
    answered = resolve;
  });
  const transport: FeishuTransport = {
    async sendCard(cardId, user, content) {
      sent.push({ cardId, user, content });
      if (content.includes("fail-me")) throw new Error("send failed");
      return "om_5";
    },
    async updateCard(ref, content) {
      patched.push({ ref, content });
    },
    async listen(onCardAction, signal) {
      await onCardAction({
        operator: { open_id: "ou_me" },
        context: { open_message_id: "om_5" },
        action: { value: { card: 5, choice: 1 } },
      });
      await onCardAction({
        operator: { open_id: "ou_me" },
        context: { open_message_id: "om_5" },
        action: { value: { other: 1 } },
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          closed = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            closed = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      await clickHandled;
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer(...args: unknown[]) {
      calls.push(["answer", ...args]);
      answered();
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", transport }, log: () => {}, signal: stop.signal });
  assert.equal(closed, true);
  assert.equal(sent[0].cardId, 5);
  assert.equal(sent[0].user, "ou_me");
  assert.equal(patched.length, 1);
  assert.equal(patched[0].ref, "om_5");
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 1),
    ["delivered", 5, 1, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "delivered" && c[2] === 2),
    ["delivered", 5, 2, "om_5"],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === "failed"),
    ["failed", 6, 1],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "answer"),
    [["answer", 5, { choice: 1, by: "ou_me", ref: "om_5" }]],
  );
});

test(
  "feishu forms forward combined answers and identities, reject bad submissions, and leave duplicates to the hub",
  { timeout: 15_000 },
  async () => {
    const sdkEvent = (value: unknown, form: unknown = {}, extra: Record<string, unknown> = {}) => ({
      operator: { open_id: "operator_id" in extra ? (extra.operator_id as string) : "ou_other" },
      context: { open_message_id: "message_id" in extra ? (extra.message_id as string) : "om_other" },
      action: {
        value,
        form_value: "form_value" in extra ? extra.form_value : form,
        tag: (extra.action_tag as string | undefined) ?? "button",
        name: (extra.action_name as string | undefined) ?? "submit",
      },
    });
    const combined = sdkEvent({ card: 5, submit: true }, { choice: "1", text: "先备份\n再处理" });
    const events: unknown[] = [
      combined,
      combined,
      sdkEvent({ card: 5, submit: true }, { text: "归档" }),
      sdkEvent({ card: 5, submit: true }, { choice: "0", text: "" }),
      sdkEvent({ card: 5, choice: 1 }),
      sdkEvent({ card: 5 }, { choice: "1" }, { action_tag: "select_static", action_name: "choice" }),
      ...[
        {},
        { text: "  " },
        { choice: 1 },
        { choice: "-1" },
        { choice: "01" },
        { choice: "1.2" },
        { choice: "9007199254740992" },
        { text: {} },
        { text: "ok", admin: true },
        null,
        [],
      ].map((form) => sdkEvent({ card: 5, submit: true }, form)),
      sdkEvent({ card: 5, submit: true }, { text: "ok" }, { form_value: "not-json-secret" }),
      sdkEvent({ card: 5, submit: true }, { text: "ok" }, { action_name: "choice" }),
      sdkEvent({ card: 5, submit: true }, { text: "ok" }, { action_tag: "select_static" }),
      sdkEvent({ card: 5, submit: true }, { text: "ok" }, { operator_id: null }),
      sdkEvent({ card: 5, submit: true }, { text: "ok" }, { message_id: "" }),
      "not-json-secret",
    ];
    const stop = new AbortController();
    const calls: unknown[][] = [];
    const logs: string[] = [];
    let finish!: () => void;
    const handled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const transport: FeishuTransport = {
      async sendCard() {
        return "om_5";
      },
      async updateCard() {},
      async listen(onCardAction, signal) {
        for (const ev of events) {
          await onCardAction(ev);
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const hub = {
      async nextCard() {
        await handled;
        stop.abort();
        return { card: null };
      },
      async answer(...args: unknown[]) {
        calls.push(args);
        if (calls.length === 5) throw new Error("private-token-secret");
        return { changed: calls.length !== 2 };
      },
    };
    try {
      await feishu({
        hub: hub as any,
        options: { user: "ou_me", transport },
        log: (line) => {
          logs.push(line);
          if (logs.length === events.length - 1) finish();
        },
        signal: stop.signal,
      });
    } finally {
      stop.abort();
    }
    assert.deepEqual(calls, [
      [5, { choice: 1, text: "先备份\n再处理", by: "ou_other", ref: "om_other" }],
      [5, { choice: 1, text: "先备份\n再处理", by: "ou_other", ref: "om_other" }],
      [5, { text: "归档", by: "ou_other", ref: "om_other" }],
      [5, { choice: 0, by: "ou_other", ref: "om_other" }],
      [5, { choice: 1, by: "ou_other", ref: "om_other" }],
    ]);
    assert.ok(logs.some((line) => line.includes("already settled")));
    assert.ok(logs.some((line) => line.includes("未处理")));
    assert.ok(!logs.join("\n").includes("secret"));
  },
);

test("a webhook channel posts words and the link once, and has nothing to do for an update", async () => {
  const seen: any[] = [];
  const target = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      seen.push(JSON.parse(text));
      res.statusCode = seen.length === 2 ? 500 : 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const stop = new AbortController();
  const literal = '$& $` $\' {text} "},"admin":true';
  const cards: Card[] = [
    { ...base, text: literal },
    { ...base, version: 2, ref: "sent-5", state: "decided", choice: 0 },
    { ...base, id: 7 },
  ];
  const calls: unknown[][] = [];
  const hub = {
    async nextCard() {
      if (cards.length) return { card: cards.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      calls.push(["delivered", ...args]);
      return {};
    },
    async failed(...args: unknown[]) {
      calls.push(["failed", args[0], args[1]]);
      return {};
    },
    async answer() {
      return {};
    },
  };
  await webhook({
    hub: hub as any,
    options: {
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      body: { msgtype: "text", text: { content: "{text}" } },
    },
    log: () => {},
    signal: stop.signal,
  });
  target.close();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].text.content, `${base.title}\n\n${literal}\n\n1. 删\n2. 留着\n\n${base.link}`);
  assert.match(seen[0].text.content, /要不要删[\s\S]*1\. 删[\s\S]*https:\/\/hub\.test\/c\/x/);
  assert.deepEqual(calls, [
    ["delivered", 5, 1, "sent-5"],
    ["delivered", 5, 2, "sent-5"],
    ["failed", 7, 1],
  ]);
});

test("GitHub: signed or not taken, and what it says becomes a plain event", () => {
  const secret = "s3cret";
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "首页打不开", body: "详情", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const headers = (b: string, over: object = {}) => ({
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`,
    "x-github-event": "issues",
    "x-github-delivery": "d-1",
    ...over,
  });
  assert.deepEqual(github({ headers: headers(body), body, secret }), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "首页打不开",
      detail: "详情",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
  assert.throws(() => github({ headers: headers(body, { "x-hub-signature-256": "sha256=00" }), body, secret }));
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body, secret }));
  assert.throws(() => github({ headers: headers(body), body, secret: "" }), "no secret set up takes nothing");
  assert.deepEqual(github({ headers: headers("{}", { "x-github-event": "ping" }), body: "{}", secret }), []);
  const odd = JSON.stringify({ repository: { full_name: "a/b c" } });
  assert.match(
    (github({ headers: headers(odd, { "x-github-event": "push" }), body: odd, secret }) as any)[0].subject,
    /^a\/b-c$/,
  );
});
