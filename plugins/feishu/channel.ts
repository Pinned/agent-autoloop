// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connection that brings
// clicks back, so this machine needs no public address. Only one listener can hold an app's card clicks, so run this in
// one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import type { Card, ChannelContext } from "../../host/channels.ts";

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  const supplement = card.choice !== null && card.answer ? `补充说明：${card.answer}。` : "";
  if (card.state === "decided") return `你选了「${chosen}」，${supplement}已记录，等待处理。`;
  if (card.state === "done")
    return `你选了「${chosen}」。${supplement}${card.result ? `已执行：${card.result}` : "已执行。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card) {
  const outcome = outcomeOf(card);
  const plain = (content: string) => ({ tag: "div", text: { tag: "plain_text", content } });
  const form = {
    tag: "form",
    name: "answer",
    elements: [
      ...card.options.map((label, index) =>
        plain(`${index + 1}. ${label}${index === card.recommend ? "（推荐）" : ""}`),
      ),
      ...(card.options.length
        ? [
            {
              tag: "select_static",
              name: "choice",
              placeholder: { tag: "plain_text", content: "选择一个选项（也可以只写说明）" },
              required: false,
              options: card.options.map((content, index) => ({
                text: { tag: "plain_text", content },
                value: String(index),
              })),
              behaviors: [{ type: "callback", value: { card: card.id } }],
            },
          ]
        : []),
      {
        tag: "input",
        name: "text",
        placeholder: { tag: "plain_text", content: "补充说明或其他要求" },
        required: false,
      },
      {
        tag: "button",
        name: "submit",
        text: { tag: "plain_text", content: "提交回答" },
        form_action_type: "submit",
        behaviors: [{ type: "callback", value: { card: card.id, submit: true } }],
      },
    ],
  };
  const afterwards = outcome ? [plain(outcome)] : [];
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...(card.text ? [plain(card.text)] : []),
        ...(card.state === "open"
          ? card.kind === "ask"
            ? [form]
            : card.options.map((label, choice) => ({
                tag: "interactive_container",
                width: "fill",
                has_border: true,
                border_color: choice === card.recommend ? "blue" : "grey",
                corner_radius: "8px",
                padding: "8px 12px 8px 12px",
                behaviors: [{ type: "callback", value: { card: card.id, choice } }],
                elements: [plain(label)],
              }))
          : afterwards),
      ],
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const lark = async (args: string[], input: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(program, args, { encoding: "utf8", timeout: 60_000, signal }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  async function sendMessage(cardId: number, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    // The key is the card alone, not its version: a report that got lost must not make a second message.
    const once = ["--idempotency-key", `agent-autoloop-card-${cardId}`];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", "-"], content)).data
      .message_id as string;
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) await updateMessage(ref, content);
        else ref = await sendMessage(card.id, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Only the owner's click on the card that was sent counts; the hub checks both. */
  async function clicked(line: string) {
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const event = JSON.parse(line);
    if (!object(event) || typeof event.action_value !== "string") throw new Error("invalid event");
    const value = JSON.parse(event.action_value);
    if (!object(value) || !Number.isSafeInteger(value.card) || (value.card as number) <= 0)
      throw new Error("invalid card");
    if (
      typeof event.operator_id !== "string" ||
      !event.operator_id.trim() ||
      typeof event.message_id !== "string" ||
      !event.message_id.trim()
    )
      throw new Error("missing identity");
    let choice: number | undefined;
    let text: string | undefined;
    if (value.submit === true) {
      if (
        Object.keys(value).some((key) => key !== "card" && key !== "submit") ||
        event.action_tag !== "button" ||
        event.action_name !== "submit" ||
        typeof event.form_value !== "string"
      )
        throw new Error("invalid submit");
      const form = JSON.parse(event.form_value);
      if (!object(form) || Object.keys(form).some((key) => key !== "choice" && key !== "text"))
        throw new Error("invalid form");
      if (form.choice !== undefined && form.choice !== "") {
        if (
          typeof form.choice !== "string" ||
          !/^(0|[1-9]\d*)$/.test(form.choice) ||
          !Number.isSafeInteger(Number(form.choice))
        )
          throw new Error("invalid choice");
        choice = Number(form.choice);
      }
      if (form.text !== undefined) {
        if (typeof form.text !== "string") throw new Error("invalid text");
        if (form.text.trim()) text = form.text;
      }
      if (choice === undefined && text === undefined) throw new Error("empty answer");
    } else {
      if (Object.keys(value).some((key) => key !== "card" && key !== "choice"))
        throw new Error("invalid legacy action");
      if (value.choice === undefined) return; // Selection callbacks are not form submissions.
      if (!Number.isSafeInteger(value.choice) || (value.choice as number) < 0) throw new Error("invalid choice");
      choice = value.choice as number;
    }
    const answer = await hub.answer(value.card as number, {
      ...(choice !== undefined ? { choice } : {}),
      ...(text !== undefined ? { text } : {}),
      by: event.operator_id,
      ref: event.message_id,
    });
    log(`card ${value.card}: answered by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      const consume = spawn(program, ["event", "consume", "card.action.trigger", "--as", "bot"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      readline.createInterface({ input: consume.stderr }).on("line", (line) => log(line));
      readline
        .createInterface({ input: consume.stdout })
        .on(
          "line",
          (line) => void clicked(line).catch(() => log("飞书回答未处理，请检查填写内容或确认回答权限后重试。")),
        );
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
