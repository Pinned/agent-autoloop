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
import feishu, { render } from "../plugins/feishu/channel.ts";
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

test("feishu CLI calls leave the HTTP loop available", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lark = join(dir, "async-lark");
  writeFileSync(
    lark,
    `#!${process.execPath}
if (process.argv[2] === 'event') { setInterval(() => {}, 1000); }
else {
  (async () => {
    if (process.argv[2] !== 'auth') for await (const chunk of process.stdin) {}
    await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(2000) });
    console.log(JSON.stringify({ ok: true, identities: { user: { openId: 'ou_me' } }, data: { message_id: 'om_5' } }));
  })().catch(() => process.exit(1));
}
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards = [base, { ...base, version: 2, ref: "om_5" }];
  let delivered = 0;
  const failed: unknown[] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift() ?? null;
      if (!card) stop.abort();
      return { card };
    },
    async delivered() {
      delivered++;
    },
    async failed(...args: unknown[]) {
      failed.push(args);
    },
  };
  try {
    await feishu({ hub: hub as any, options: { lark }, log: () => {}, signal: stop.signal });
    assert.deepEqual(failed, []);
    assert.equal(delivered, 2);
    assert.equal(requests, 3, "user lookup, send and patch each allowed HTTP to respond");
  } finally {
    stop.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("feishu: sends once per card, updates in place, reports failure, and only real clicks count", async () => {
  const log = join(dir, "lark.log");
  const lark = join(dir, "lark-cli");
  // A stand-in for lark-cli: records each call; `event consume` prints two clicks and waits to be stopped.
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*)
    echo '{"action_value":"{\\"card\\":5,\\"choice\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    echo '{"action_value":"{\\"other\\":1}","operator_id":"ou_me","message_id":"om_5"}'
    exec sleep 30 ;;
  *fail-me*) exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_5"}}' ;;
esac
`,
  );
  chmodSync(lark, 0o755);
  const stop = new AbortController();
  const cards: (Card | null)[] = [
    base,
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, id: 6, title: "fail-me", ref: null },
  ];
  const calls: unknown[][] = [];
  let answered!: () => void;
  const clickHandled = new Promise<void>((resolve) => {
    answered = resolve;
  });
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
  // A card that can't be sent: lark-cli is told to fail by the words in it.
  writeFileSync(
    lark,
    readFileSync(lark, "utf8").replace(
      "*fail-me*) exit 1 ;;",
      '*+messages-send*) body=$(cat); case "$body" in *fail-me*) exit 1 ;; esac; echo \'{"ok":true,"data":{"message_id":"om_5"}}\' ;;',
    ),
  );
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sends = lines.filter((l) => l.includes("+messages-send"));
  assert.ok(sends[0].includes("--idempotency-key agent-autoloop-card-5"), "the key doesn't change with the version");
  assert.ok(sends[0].includes("--user-id ou_me"));
  assert.ok(
    lines.some((l) => l.includes("messages patch --message-id om_5")),
    "an update changes the message that was sent",
  );
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
    const event = (value: unknown, form: unknown = {}, extra: object = {}) =>
      JSON.stringify({
        action_value: JSON.stringify(value),
        form_value: JSON.stringify(form),
        action_tag: "button",
        action_name: "submit",
        operator_id: "ou_other",
        message_id: "om_other",
        ...extra,
      });
    const combined = event({ card: 5, submit: true }, { choice: "1", text: "先备份\n再处理" });
    const lines = [
      combined,
      combined,
      event({ card: 5, submit: true }, { text: "归档" }),
      event({ card: 5, submit: true }, { choice: "0", text: "" }),
      event({ card: 5, choice: 1 }),
      event({ card: 5 }, { choice: "1" }, { action_tag: "select_static", action_name: "choice" }),
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
      ].map((form) => event({ card: 5, submit: true }, form)),
      event({ card: 5, submit: true }, { text: "ok" }, { form_value: "not-json-secret" }),
      event({ card: 5, submit: true }, { text: "ok" }, { action_name: "choice" }),
      event({ card: 5, submit: true }, { text: "ok" }, { action_tag: "select_static" }),
      event({ card: 5, submit: true }, { text: "ok" }, { operator_id: null }),
      event({ card: 5, submit: true }, { text: "ok" }, { message_id: "" }),
      "not-json-secret",
    ];
    const lark = join(dir, "form-lark");
    writeFileSync(
      lark,
      `#!${process.execPath}\nif (process.argv[2] === 'event') {\nfor (const line of ${JSON.stringify(lines)}) console.log(line);\nsetInterval(() => {}, 1000);\n}\n`,
      { mode: 0o755 },
    );
    const stop = new AbortController();
    const calls: unknown[][] = [];
    const logs: string[] = [];
    let finish!: () => void;
    const handled = new Promise<void>((resolve) => {
      finish = resolve;
    });
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
        options: { user: "ou_me", lark },
        log: (line) => {
          logs.push(line);
          if (logs.length === lines.length - 1) finish();
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
