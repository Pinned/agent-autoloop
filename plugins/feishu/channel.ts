// Feishu (Lark) channel powered by @larksuiteoapi/node-sdk: holds the app's credentials and a WebSocket long
// connection that brings card clicks back, so this machine needs no public address.
//   "channels": { "feishu": { "key": "…", "appId": "cli_xxx", "appSecret": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import * as lark from "@larksuiteoapi/node-sdk";
import type { Card, ChannelContext } from "../../host/channels.ts";

export type FeishuTransport = {
  sendCard(cardId: number, user: string, content: string): Promise<string>;
  updateCard(ref: string, content: string): Promise<void>;
  listen(onCardAction: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<void>;
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function parseJsonOrRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}

/** Validates a Feishu card.action.trigger payload and extracts card id, answer, operator, and message ref. */
export function parseCardAction(event: unknown): {
  card: number;
  choice?: number;
  text?: string;
  by: string;
  ref: string;
} | null {
  if (!isRecord(event)) throw new Error("invalid event");
  const action = isRecord(event.action) ? event.action : null;
  const operator = isRecord(event.operator) ? event.operator : null;
  const context = isRecord(event.context) ? event.context : null;

  const rawValue = action ? action.value : event.action_value;
  const value = parseJsonOrRecord(rawValue, "action_value");
  if (!Number.isSafeInteger(value.card) || (value.card as number) <= 0) throw new Error("invalid card");

  const by = operator ? operator.open_id : event.operator_id;
  const ref = context?.open_message_id ?? event.open_message_id ?? event.message_id;
  if (typeof by !== "string" || !by.trim() || typeof ref !== "string" || !ref.trim()) {
    throw new Error("missing identity");
  }

  let choice: number | undefined;
  let text: string | undefined;
  if (value.submit === true) {
    const tag = action ? action.tag : event.action_tag;
    const name = action ? action.name : event.action_name;
    const rawForm = action ? (action.form_value ?? event.form_value) : event.form_value;
    if (Object.keys(value).some((key) => key !== "card" && key !== "submit") || tag !== "button" || name !== "submit") {
      throw new Error("invalid submit");
    }
    const form = parseJsonOrRecord(rawForm, "form_value");
    if (Object.keys(form).some((key) => key !== "choice" && key !== "text")) throw new Error("invalid form");
    if (form.choice !== undefined && form.choice !== "") {
      if (
        typeof form.choice !== "string" ||
        !/^(0|[1-9]\d*)$/.test(form.choice) ||
        !Number.isSafeInteger(Number(form.choice))
      ) {
        throw new Error("invalid choice");
      }
      choice = Number(form.choice);
    }
    if (form.text !== undefined) {
      if (typeof form.text !== "string") throw new Error("invalid text");
      if (form.text.trim()) text = form.text;
    }
    if (choice === undefined && text === undefined) throw new Error("empty answer");
  } else {
    if (Object.keys(value).some((key) => key !== "card" && key !== "choice")) throw new Error("invalid legacy action");
    if (value.choice === undefined) return null;
    if (!Number.isSafeInteger(value.choice) || (value.choice as number) < 0) throw new Error("invalid choice");
    choice = value.choice as number;
  }

  return {
    card: value.card as number,
    ...(choice !== undefined ? { choice } : {}),
    ...(text !== undefined ? { text } : {}),
    by,
    ref,
  };
}

function sdkDomain(domain: unknown) {
  return domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

const silentLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

export function createSdkTransport(config: {
  appId: string;
  appSecret: string;
  domain?: unknown;
  log?: (line: string) => void;
}): FeishuTransport {
  const domain = sdkDomain(config.domain);
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.error,
  });

  return {
    async sendCard(cardId, user, content) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: user,
          msg_type: "interactive",
          content,
          // The key is the card alone, not its version: a report that got lost must not make a second message.
          uuid: `agent-autoloop-card-${cardId}`,
        },
      });
      if (response.code !== 0 || !response.data?.message_id) {
        throw new Error(`飞书发送失败：${response.msg ?? response.code ?? "未知错误"}`);
      }
      return response.data.message_id;
    },
    async updateCard(ref, content) {
      const response = await client.im.v1.message.patch({
        path: { message_id: ref },
        data: { content },
      });
      if (response.code !== 0) {
        throw new Error(`飞书更新失败：${response.msg ?? response.code ?? "未知错误"}`);
      }
    },
    async listen(onCardAction, signal) {
      if (signal.aborted) return;
      const wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain,
        loggerLevel: lark.LoggerLevel.error,
      });
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "card.action.trigger": async (data: unknown) => {
          try {
            await onCardAction(data);
          } catch (error) {
            config.log?.(`飞书回答未处理：${error}`);
          }
          return {};
        },
      });
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          try {
            wsClient.close();
          } catch {
            // Ignore close errors during shutdown.
          }
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(wsClient.start({ eventDispatcher })).catch((error) => {
          signal.removeEventListener("abort", onAbort);
          try {
            wsClient.close();
          } catch {
            // Ignore close errors on failed start.
          }
          reject(error);
        });
      });
    },
  };
}

export default async function feishu({ hub, options, log, signal }: ChannelContext) {
  const customTransport = options.transport as FeishuTransport | undefined;
  const owner = typeof options.user === "string" ? options.user.trim() : "";
  const appId = typeof options.appId === "string" ? options.appId.trim() : "";
  const appSecret = typeof options.appSecret === "string" ? options.appSecret.trim() : "";

  if (!customTransport && (!appId || !appSecret || !owner)) {
    throw new Error("飞书通道需要配置 appId、appSecret 和 user（请在桌面端设置或 config.json 中填写）");
  }
  if (!owner) {
    throw new Error("飞书通道需要配置 user（接收人的 open_id）");
  }

  const transport = customTransport ?? createSdkTransport({ appId, appSecret, domain: options.domain, log });

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
        if (ref) await transport.updateCard(ref, content);
        else ref = await transport.sendCard(card.id, owner, content);
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  async function clicked(event: unknown) {
    const parsed = parseCardAction(event);
    if (!parsed) return;
    const answer = await hub.answer(parsed.card, {
      ...(parsed.choice !== undefined ? { choice: parsed.choice } : {}),
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      by: parsed.by,
      ref: parsed.ref,
    });
    log(`card ${parsed.card}: answered by ${parsed.by}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      try {
        await transport.listen(
          (event) =>
            clicked(event).catch(() => {
              log("飞书回答未处理，请检查填写内容或确认回答权限后重试。");
            }),
          signal,
        );
      } catch (error) {
        if (!signal.aborted) log(`飞书长连接中断：${error}`);
      }
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}

/** Sends a one-off test card to verify Feishu credentials and bot reachability. */
export async function sendTestCard(config: {
  appId: string;
  appSecret: string;
  user: string;
  domain?: unknown;
}): Promise<string> {
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: sdkDomain(config.domain),
    loggerLevel: lark.LoggerLevel.error,
  });
  const card = {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: { title: { tag: "plain_text", content: "测试通知：飞书通道已连接" }, template: "green" },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: "如果你在飞书收到这条消息，说明 App ID、App Secret 和接收人已配置成功。",
          },
        },
      ],
    },
  };
  const response = await client.im.v1.message.create({
    params: { receive_id_type: "open_id" },
    data: {
      receive_id: config.user,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
  if (response.code !== 0 || !response.data?.message_id) {
    throw new Error(friendlyFeishuError(response.code, response.msg));
  }
  return response.data.message_id;
}

/** Checks whether an incoming Feishu message is a text message matching the 6-digit pairing code. */
export function matchesPairingMessage(
  message: { message_type?: string; content?: string } | undefined,
  pairingCode: string,
): boolean {
  if (!message || message.message_type !== "text" || typeof message.content !== "string") return false;
  try {
    const parsed = JSON.parse(message.content) as { text?: unknown };
    if (typeof parsed.text !== "string") return false;
    // Strip optional @mention placeholders (e.g. "@_user_1 123456") when sent in a group chat.
    const clean = parsed.text.replace(/@_user_\d+/g, "").trim();
    return clean === pairingCode;
  } catch {
    return false;
  }
}

/** Listens for the first matching user message over WebSocket to capture the sender's open_id. */
export async function waitForUserOpenId(config: {
  appId: string;
  appSecret: string;
  domain?: unknown;
  pairingCode?: string;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = config.timeoutMs ?? 60_000;
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: sdkDomain(config.domain),
    loggerLevel: lark.LoggerLevel.error,
    logger: silentLogger,
  });
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        wsClient.close();
      } catch {
        // Ignore close errors.
      }
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              config.pairingCode
                ? `等待超时：请在飞书里给机器人发送配对码 ${config.pairingCode} 后重试`
                : "等待超时：请在飞书里给机器人发送任意一条消息后重试",
            ),
          ),
        ),
      timeoutMs,
    );
    const eventDispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: {
        sender?: { sender_type?: string; sender_id?: { open_id?: string } };
        message?: { message_type?: string; content?: string };
      }) => {
        const openId = data?.sender?.sender_id?.open_id?.trim();
        if (data?.sender?.sender_type === "user" && openId) {
          if (!config.pairingCode || matchesPairingMessage(data.message, config.pairingCode)) {
            finish(() => resolve(openId));
          }
        }
        return {};
      },
    });
    Promise.resolve(wsClient.start({ eventDispatcher })).catch((error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

function friendlyFeishuError(code?: number, msg?: string): string {
  if (code === 10003 || code === 20001 || code === 99991663) return "App ID 或 App Secret 不正确，请核对飞书应用凭据";
  if (code === 230001 || code === 230002) return "找不到该接收人，请确认 Open ID 正确且用户已启用该应用";
  if (code === 230013) return "应用尚未开启机器人能力或未发布版本，请到飞书开放平台检查";
  return `飞书返回错误${code !== undefined ? `（${code}）` : ""}：${msg ?? "请检查应用配置"}`;
}
