// Local-only contract for managing channel credentials and connectivity in the Desktop App.
// Unlike /v1/ui/config, this never leaves the local hub machine: it stays behind main-process IPC
// so appSecret, webhook URLs, and channel keys are never transmitted over the remote UI door.

export const CHANNEL_PRESETS = Object.freeze([
  "desktop",
  "feishu",
  "dingtalk",
  "wecom",
  "slack",
  "discord",
  "webhook",
  "custom",
] as const);

export type ChannelPreset = (typeof CHANNEL_PRESETS)[number];
export type FeishuDomain = "feishu" | "lark";

export type LocalChannelConfigSummary = {
  id: string;
  preset: ChannelPreset;
  hasKey: boolean;
  configured: boolean;
  appId?: string;
  hasSecret?: boolean;
  user?: string;
  userName?: string;
  domain?: FeishuDomain;
  url?: string;
  body?: string;
};

export type ChannelConfigReadData = {
  channels: LocalChannelConfigSummary[];
  publicUrl?: string;
  hubUrl: string;
};

export type ChannelConfigReadResponse =
  | { version: 1; ok: true; data: ChannelConfigReadData }
  | { version: 1; ok: false; error: { code: "unavailable" | "no-hub" | "error"; message: string } };

export type ChannelConfigSaveInput = {
  id: string;
  preset: ChannelPreset;
  appId?: string;
  appSecret?: string;
  user?: string;
  userName?: string;
  domain?: FeishuDomain;
  url?: string;
  body?: string;
};

export type ChannelConfigSaveResponse =
  | { version: 1; ok: true; data: { channel: LocalChannelConfigSummary; restarted: boolean } }
  | { version: 1; ok: false; error: { code: "unavailable" | "no-hub" | "invalid" | "error"; message: string } };

export type ChannelConfigRemoveInput = { id: string };
export type ChannelConfigRemoveResponse =
  | { version: 1; ok: true }
  | { version: 1; ok: false; error: { code: "unavailable" | "no-hub" | "invalid" | "error"; message: string } };

export type ChannelFeishuBindInput = {
  id?: string;
  appId: string;
  appSecret?: string;
  domain?: FeishuDomain;
  pairingCode?: string;
};

export type ChannelFeishuBindResponse =
  { version: 1; ok: true; openId: string; userName?: string } | { version: 1; ok: false; message: string };

export type ChannelTestInput = {
  id: string;
  preset: ChannelPreset;
  appId?: string;
  appSecret?: string;
  user?: string;
  userName?: string;
  domain?: FeishuDomain;
  url?: string;
  body?: string;
};

export type ChannelTestResponse =
  { version: 1; ok: true; message: string } | { version: 1; ok: false; message: string };

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

export function inferChannelPreset(id: string, raw: Record<string, unknown>): ChannelPreset {
  const use = trimmed(raw.use);
  const platform = trimmed(raw.platform);
  if (id === "desktop" && !use) return "desktop";
  if (id === "feishu" || use === "feishu") return "feishu";
  if (use === "webhook" || id === "webhook" || platform) {
    if (platform === "dingtalk" || platform === "wecom" || platform === "slack" || platform === "discord") {
      return platform;
    }
    return "webhook";
  }
  return "custom";
}

export function parseChannelConfigSaveInput(value: unknown): ChannelConfigSaveInput {
  if (!isPlainObject(value)) throw new Error("配置格式无效");
  const id = trimmed(value.id);
  if (!id || !ID_PATTERN.test(id)) throw new Error("通道标识只能用小写字母、数字和 -，且以字母开头");
  const preset = value.preset as ChannelPreset;
  if (!CHANNEL_PRESETS.includes(preset)) throw new Error("不支持的通道类型");

  const domain =
    value.domain === undefined
      ? undefined
      : value.domain === "lark"
        ? "lark"
        : value.domain === "feishu"
          ? "feishu"
          : null;
  if (domain === null) throw new Error("飞书区域只能选 feishu 或 lark");

  const appId = trimmed(value.appId);
  const appSecret = trimmed(value.appSecret);
  const user = trimmed(value.user);
  const userName = trimmed(value.userName);
  const url = trimmed(value.url);
  const body = trimmed(value.body);

  if (
    preset === "dingtalk" ||
    preset === "wecom" ||
    preset === "slack" ||
    preset === "discord" ||
    preset === "webhook"
  ) {
    if (!url) throw new Error("请填写 Webhook 地址");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Webhook 地址格式不正确");
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("Webhook 地址必须以 http:// 或 https:// 开头");
    }
    if (body) {
      try {
        JSON.parse(body);
      } catch {
        throw new Error("自定义消息模板必须是合法的 JSON");
      }
    }
  }

  return {
    id,
    preset,
    ...(appId && { appId }),
    ...(appSecret && { appSecret }),
    ...(user && { user }),
    ...(userName && { userName }),
    ...(domain && { domain }),
    ...(url && { url }),
    ...(body && { body }),
  };
}

export function parseChannelFeishuBindInput(value: unknown): ChannelFeishuBindInput {
  if (!isPlainObject(value)) throw new Error("参数格式无效");
  const id = trimmed(value.id);
  const appId = trimmed(value.appId);
  const appSecret = trimmed(value.appSecret);
  if (!appId) throw new Error("请先填写 App ID");
  const domain = value.domain === "lark" ? "lark" : "feishu";
  const pairingCode = trimmed(value.pairingCode);
  if (pairingCode !== undefined && !/^\d{6}$/.test(pairingCode)) {
    throw new Error("配对码必须是 6 位数字");
  }
  return {
    ...(id && { id }),
    appId,
    ...(appSecret && { appSecret }),
    domain,
    ...(pairingCode && { pairingCode }),
  };
}

export function parseChannelTestInput(value: unknown): ChannelTestInput {
  if (!isPlainObject(value)) throw new Error("参数格式无效");
  const id = trimmed(value.id);
  if (!id || !ID_PATTERN.test(id)) throw new Error("通道标识不正确");
  const preset = value.preset as ChannelPreset;
  if (!CHANNEL_PRESETS.includes(preset)) throw new Error("不支持的通道类型");
  const domain = value.domain === "lark" ? "lark" : "feishu";
  return {
    id,
    preset,
    ...(trimmed(value.appId) && { appId: trimmed(value.appId) }),
    ...(trimmed(value.appSecret) && { appSecret: trimmed(value.appSecret) }),
    ...(trimmed(value.user) && { user: trimmed(value.user) }),
    domain,
    ...(trimmed(value.url) && { url: trimmed(value.url) }),
    ...(trimmed(value.body) && { body: trimmed(value.body) }),
  };
}
