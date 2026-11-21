// Beginner-friendly channel preset picker & per-channel form for the Desktop Settings page.
import type {
  ChannelConfigReadResponse,
  ChannelConfigRemoveInput,
  ChannelConfigRemoveResponse,
  ChannelConfigSaveInput,
  ChannelConfigSaveResponse,
  ChannelFeishuBindInput,
  ChannelFeishuBindResponse,
  ChannelPreset,
  ChannelTestInput,
  ChannelTestResponse,
  FeishuDomain,
  LocalChannelConfigSummary,
} from "../../../host/desktop-channel-contract.ts";

export type ChannelBridge = {
  get(): Promise<ChannelConfigReadResponse>;
  save(input: ChannelConfigSaveInput): Promise<ChannelConfigSaveResponse>;
  remove(input: ChannelConfigRemoveInput): Promise<ChannelConfigRemoveResponse>;
  bindFeishu(input: ChannelFeishuBindInput): Promise<ChannelFeishuBindResponse>;
  cancelBindFeishu?(): Promise<void>;
  test(input: ChannelTestInput): Promise<ChannelTestResponse>;
};

export type ChannelPresetMeta = {
  preset: ChannelPreset;
  title: string;
  defaultId: string;
  defaultName: string;
  badge?: string;
  summary: string;
  defaultLinks?: boolean;
};

export const CHANNEL_PRESET_CARDS: readonly ChannelPresetMeta[] = [
  {
    preset: "feishu",
    title: "飞书",
    defaultId: "feishu",
    defaultName: "飞书",
    badge: "推荐",
    summary: "发送交互式卡片，在飞书里直接点击选项和补充说明。",
  },
  {
    preset: "desktop",
    title: "桌面通知",
    defaultId: "desktop",
    defaultName: "桌面通知",
    summary: "本机系统弹窗提醒，零外部账号配置，一键启用。",
  },
  {
    preset: "dingtalk",
    title: "钉钉群机器人",
    defaultId: "dingtalk",
    defaultName: "钉钉群",
    summary: "向钉钉群发消息，可附带卡片链接直接打开回答。",
    defaultLinks: true,
  },
  {
    preset: "wecom",
    title: "企业微信群机器人",
    defaultId: "wecom",
    defaultName: "企业微信",
    summary: "向企微群发消息，可附带卡片链接直接打开回答。",
    defaultLinks: true,
  },
  {
    preset: "slack",
    title: "Slack",
    defaultId: "slack",
    defaultName: "Slack",
    summary: "通过 Incoming Webhook 发送消息到指定频道。",
    defaultLinks: true,
  },
  {
    preset: "discord",
    title: "Discord",
    defaultId: "discord",
    defaultName: "Discord",
    summary: "通过频道 Webhook 发送提醒消息。",
    defaultLinks: true,
  },
  {
    preset: "webhook",
    title: "自定义 Webhook",
    defaultId: "webhook",
    defaultName: "自定义 Webhook",
    summary: "对接任意接收 JSON POST 的 HTTP 服务。",
    defaultLinks: true,
  },
  {
    preset: "custom",
    title: "自定义插件",
    defaultId: "",
    defaultName: "",
    summary: "手动指定自己编写的 plugins/<名称>/channel.ts 插件。",
  },
];

export function presetLabel(preset: ChannelPreset): string {
  return CHANNEL_PRESET_CARDS.find((item) => item.preset === preset)?.title ?? preset;
}

export function inferPresetFromId(id: string): ChannelPreset {
  if (id === "desktop") return "desktop";
  if (id === "feishu" || id.startsWith("feishu-")) return "feishu";
  if (id === "dingtalk" || id.startsWith("dingtalk-")) return "dingtalk";
  if (id === "wecom" || id.startsWith("wecom-")) return "wecom";
  if (id === "slack" || id.startsWith("slack-")) return "slack";
  if (id === "discord" || id.startsWith("discord-")) return "discord";
  if (id === "webhook" || id.startsWith("webhook-")) return "webhook";
  return "custom";
}

export function nextAvailableId(baseId: string, existingIds: readonly string[]): string {
  if (!baseId) return "";
  if (!existingIds.includes(baseId)) return baseId;
  let index = 2;
  while (existingIds.includes(`${baseId}-${index}`)) index++;
  return `${baseId}-${index}`;
}

export function buildChannelSavePayload(
  preset: ChannelPreset,
  row: Record<string, string | boolean>,
): ChannelConfigSaveInput {
  const str = (key: string) => {
    const val = String(row[key] ?? "").trim();
    return val ? val : undefined;
  };
  return {
    id: String(row.id ?? "").trim(),
    preset,
    ...(str("appId") && { appId: str("appId") }),
    ...(str("appSecret") && { appSecret: str("appSecret") }),
    ...(str("user") && { user: str("user") }),
    ...(str("userName") && { userName: str("userName") }),
    ...(row.domain === "lark" ? { domain: "lark" as FeishuDomain } : { domain: "feishu" as FeishuDomain }),
    ...(str("url") && { url: str("url") }),
    ...(str("body") && { body: str("body") }),
  };
}

export function renderPresetPicker(
  existingIds: readonly string[],
  onPick: (meta: ChannelPresetMeta, suggestedId: string) => void,
  existingPresets: readonly ChannelPreset[] = [],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "channel-preset-wrap";

  const lead = document.createElement("p");
  lead.className = "muted channel-preset-lead";
  lead.textContent = "选择要接入的通知渠道，系统会自动填充默认配置和生成密钥。";
  wrap.append(lead);

  const singletonTaken = (preset: ChannelPreset) =>
    (preset === "feishu" || preset === "desktop") && (existingPresets.includes(preset) || existingIds.includes(preset));

  const grid = document.createElement("div");
  grid.className = "channel-preset-grid";
  for (const meta of CHANNEL_PRESET_CARDS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "channel-preset-card";
    card.setAttribute("data-preset", meta.preset);
    const taken = singletonTaken(meta.preset);
    if (taken) card.disabled = true;

    const top = document.createElement("div");
    top.className = "channel-preset-top";
    const title = document.createElement("strong");
    title.textContent = meta.title;
    top.append(title);
    if (taken) {
      const badge = document.createElement("span");
      badge.className = "channel-preset-badge";
      badge.textContent = "已添加";
      top.append(badge);
    } else if (meta.badge) {
      const badge = document.createElement("span");
      badge.className = "channel-preset-badge";
      badge.textContent = meta.badge;
      top.append(badge);
    }

    const desc = document.createElement("p");
    desc.className = "channel-preset-desc";
    desc.textContent = taken ? "已添加过该通道，请在列表中直接编辑现有配置。" : meta.summary;

    card.append(top, desc);
    if (!taken) {
      card.addEventListener("click", () => {
        onPick(meta, nextAvailableId(meta.defaultId, existingIds));
      });
    }
    grid.append(card);
  }
  wrap.append(grid);
  return wrap;
}

export function isLocalhostUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return true;
  }
}

export function feishuChecklistNode(): HTMLElement {
  const details = document.createElement("details");
  details.className = "channel-guide-details";
  const summary = document.createElement("summary");
  summary.textContent = "第一次接飞书？查看开放平台 3 步准备清单";
  const list = document.createElement("ol");
  list.className = "channel-guide-list";
  const steps = [
    "在飞书开放平台创建一个「企业自建应用」，并在「应用能力」中开启「机器人」。",
    "在「事件与回调」将接收方式设为「使用长连接接收事件/回调」，并订阅卡片回传（card.action.trigger）和接收消息（im.message.receive_v1）。",
    "在「版本管理与发布」中创建并发布一个版本，然后把下面的 App ID 和 App Secret 填进来。",
  ];
  for (const text of steps) {
    const li = document.createElement("li");
    li.textContent = text;
    list.append(li);
  }
  details.append(summary, list);
  return details;
}

export function channelStatusLabel(local: LocalChannelConfigSummary | undefined): {
  text: string;
  tone: "ok" | "warn";
} | null {
  if (!local) return null;
  if (local.configured) return { text: "已就绪", tone: "ok" };
  return { text: "待完善凭据", tone: "warn" };
}
