// Local-only channel configuration, key provisioning, Feishu open_id binding, and test-send service
// for the Desktop App. Runs strictly in the main process on the local hub machine; secrets never
// cross /v1/ui/config or leave the device.
import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  inferChannelPreset,
  parseChannelConfigSaveInput,
  parseChannelFeishuBindInput,
  parseChannelTestInput,
  type ChannelConfigReadResponse,
  type ChannelConfigRemoveResponse,
  type ChannelConfigSaveInput,
  type ChannelConfigSaveResponse,
  type ChannelFeishuBindResponse,
  type ChannelPreset,
  type ChannelTestResponse,
  type LocalChannelConfigSummary,
} from "../../host/desktop-channel-contract.ts";
import { notifyCommand } from "../../plugins/desktop/channel.ts";
import { accepted, payload } from "../../plugins/webhook/templates.ts";

type ConfigJson = {
  url?: string;
  hub?: { listen?: string; publicUrl?: string };
  channels?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type ChannelConfigSourceOptions = {
  home: string;
  runtimeResources?: () => Promise<{ nodePath: string; entryPath: string; helperPath: string }>;
  createKey?: (id: string) => Promise<string>;
  runHelper?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  restartHub?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  execImpl?: typeof execFile;
};

function readLocalConfig(home: string): ConfigJson {
  const file = join(home, "config.json");
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
    throw new Error("本机尚未初始化配置");
  }
  return JSON.parse(readFileSync(file, "utf8")) as ConfigJson;
}

function writeLocalConfig(home: string, config: ConfigJson) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, "config.json");
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error("拒绝写入符号链接配置文件");
  }
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}

const RESULT_PREFIX = "CHANNEL_HELPER_RESULT:";

export function parseHelperStdout(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(RESULT_PREFIX)) {
      return JSON.parse(lines[i].slice(RESULT_PREFIX.length)) as Record<string, unknown>;
    }
  }
  return JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeChannel(id: string, raw: Record<string, unknown>): LocalChannelConfigSummary {
  const preset = inferChannelPreset(id, raw);
  const hasKey = isNonEmptyString(raw.key);
  if (preset === "feishu") {
    const appId = isNonEmptyString(raw.appId) ? raw.appId.trim() : undefined;
    const hasSecret = isNonEmptyString(raw.appSecret);
    const user = isNonEmptyString(raw.user) ? raw.user.trim() : undefined;
    const userName = isNonEmptyString(raw.userName) ? raw.userName.trim() : undefined;
    const domain = raw.domain === "lark" ? "lark" : "feishu";
    return {
      id,
      preset,
      hasKey,
      configured: Boolean(hasKey && appId && hasSecret && user),
      ...(appId && { appId }),
      hasSecret,
      ...(user && { user }),
      ...(userName && { userName }),
      domain,
    };
  }
  if (
    preset === "dingtalk" ||
    preset === "wecom" ||
    preset === "slack" ||
    preset === "discord" ||
    preset === "webhook"
  ) {
    const url = isNonEmptyString(raw.url) ? raw.url.trim() : undefined;
    const body = raw.body !== undefined ? JSON.stringify(raw.body, null, 2) : undefined;
    return {
      id,
      preset,
      hasKey,
      configured: Boolean(hasKey && url),
      ...(url && { url }),
      ...(body && { body }),
    };
  }
  return { id, preset, hasKey, configured: hasKey };
}

function fillTemplate(template: unknown, text: string): unknown {
  if (typeof template === "string") return template.replaceAll("{text}", () => text);
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, text));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillTemplate(v, text)]));
  }
  return template;
}

export function createChannelConfigSource(options: ChannelConfigSourceOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const execImpl = options.execImpl ?? execFile;

  async function defaultCreateKey(id: string): Promise<string> {
    if (!options.runtimeResources) throw new Error("缺少内置运行时资源");
    const { nodePath, entryPath } = await options.runtimeResources();
    const stdout = await new Promise<string>((resolve, reject) => {
      execImpl(
        nodePath,
        ["--disable-warning=ExperimentalWarning", entryPath, "key", "new", "channel", id],
        {
          cwd: options.home,
          env: { ...process.env, AGENT_AUTOLOOP_HOME: options.home },
          timeout: 15_000,
          maxBuffer: 256 * 1024,
        },
        (err, out, stderr) => {
          if (err) reject(new Error(stderr?.trim() || err.message || "生成通道密钥失败"));
          else resolve(out);
        },
      );
    });
    const key = stdout.trim();
    if (!key) throw new Error("生成的通道密钥为空");
    return key;
  }

  async function defaultRunHelper(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!options.runtimeResources) throw new Error("缺少内置运行时资源");
    const { nodePath, helperPath } = await options.runtimeResources();
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execImpl(
        nodePath,
        ["--disable-warning=ExperimentalWarning", helperPath],
        {
          cwd: options.home,
          env: { ...process.env, AGENT_AUTOLOOP_HOME: options.home },
          timeout: 65_000,
          maxBuffer: 256 * 1024,
        },
        (err, out, stderr) => {
          if (err && !out?.trim()) reject(new Error(stderr?.trim() || err.message || "飞书操作无响应"));
          else resolve(out);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(input));
    });
    if (!stdout.trim()) throw new Error("飞书操作无响应");
    return parseHelperStdout(stdout);
  }

  const createKey = options.createKey ?? defaultCreateKey;
  const runHelper = options.runHelper ?? defaultRunHelper;

  function buildChannelRecord(
    input: ChannelConfigSaveInput,
    key: string,
    existing: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (input.preset === "desktop") return { key };
    if (input.preset === "feishu") {
      const appId = input.appId ?? (isNonEmptyString(existing?.appId) ? existing.appId.trim() : undefined);
      const appSecret =
        input.appSecret ?? (isNonEmptyString(existing?.appSecret) ? existing.appSecret.trim() : undefined);
      const user = input.user ?? (isNonEmptyString(existing?.user) ? existing.user.trim() : undefined);
      const userName =
        input.userName ??
        (input.user && input.user === existing?.user && isNonEmptyString(existing?.userName)
          ? existing.userName.trim()
          : undefined);
      if (!appId) throw new Error("请填写飞书 App ID");
      if (!appSecret) throw new Error("请填写飞书 App Secret");
      if (!user) throw new Error("请填写接收人 Open ID（或点击配对获取）");
      return {
        use: "feishu",
        key,
        appId,
        appSecret,
        user,
        ...(userName && { userName }),
        ...(input.domain === "lark" ? { domain: "lark" } : {}),
      };
    }
    if (
      input.preset === "dingtalk" ||
      input.preset === "wecom" ||
      input.preset === "slack" ||
      input.preset === "discord"
    ) {
      return { use: "webhook", platform: input.preset, key, url: input.url };
    }
    if (input.preset === "webhook") {
      return {
        use: "webhook",
        key,
        url: input.url,
        ...(input.body ? { body: JSON.parse(input.body) } : {}),
      };
    }
    return { ...(existing ?? {}), key };
  }

  return {
    read(): ChannelConfigReadResponse {
      try {
        const config = readLocalConfig(options.home);
        const channels = Object.entries(config.channels ?? {}).map(([id, raw]) =>
          summarizeChannel(id, (raw ?? {}) as Record<string, unknown>),
        );
        return {
          version: 1,
          ok: true,
          data: {
            channels,
            ...(config.hub?.publicUrl ? { publicUrl: config.hub.publicUrl } : {}),
            hubUrl: config.url ?? "http://127.0.0.1:4040",
          },
        };
      } catch (error) {
        return {
          version: 1,
          ok: false,
          error: { code: "error", message: error instanceof Error ? error.message : String(error) },
        };
      }
    },

    async save(rawInput: unknown): Promise<ChannelConfigSaveResponse> {
      let input: ChannelConfigSaveInput;
      try {
        input = parseChannelConfigSaveInput(rawInput);
      } catch (error) {
        return {
          version: 1,
          ok: false,
          error: { code: "invalid", message: error instanceof Error ? error.message : "配置无效" },
        };
      }
      try {
        const config = readLocalConfig(options.home);
        const existing = config.channels?.[input.id] as Record<string, unknown> | undefined;
        const key = isNonEmptyString(existing?.key) ? existing.key.trim() : await createKey(input.id);
        const nextEntry = buildChannelRecord(input, key, existing);
        config.channels = { ...(config.channels ?? {}), [input.id]: nextEntry };
        writeLocalConfig(options.home, config);
        const restarted = options.restartHub ? await options.restartHub().catch(() => false) : false;
        return {
          version: 1,
          ok: true,
          data: { channel: summarizeChannel(input.id, nextEntry), restarted },
        };
      } catch (error) {
        return {
          version: 1,
          ok: false,
          error: { code: "invalid", message: error instanceof Error ? error.message : String(error) },
        };
      }
    },

    async remove(id: string): Promise<ChannelConfigRemoveResponse> {
      try {
        const config = readLocalConfig(options.home);
        if (config.channels && Object.hasOwn(config.channels, id)) {
          delete config.channels[id];
          writeLocalConfig(options.home, config);
          if (options.restartHub) await options.restartHub().catch(() => false);
        }
        return { version: 1, ok: true };
      } catch (error) {
        return {
          version: 1,
          ok: false,
          error: { code: "error", message: error instanceof Error ? error.message : String(error) },
        };
      }
    },

    async bindFeishu(rawInput: unknown): Promise<ChannelFeishuBindResponse> {
      try {
        const input = parseChannelFeishuBindInput(rawInput);
        let appSecret = input.appSecret;
        if (!appSecret && input.id) {
          const config = readLocalConfig(options.home);
          const existing = config.channels?.[input.id];
          if (isNonEmptyString(existing?.appSecret)) appSecret = existing.appSecret.trim();
        }
        if (!appSecret) return { version: 1, ok: false, message: "请先填写 App Secret" };
        const result = await runHelper({
          action: "feishu-bind",
          appId: input.appId,
          appSecret,
          domain: input.domain ?? "feishu",
          ...(input.pairingCode && { pairingCode: input.pairingCode }),
        });
        if (result.ok === true && typeof result.openId === "string" && result.openId.trim()) {
          const userName =
            typeof result.userName === "string" && result.userName.trim() ? result.userName.trim() : undefined;
          return {
            version: 1,
            ok: true,
            openId: result.openId.trim(),
            ...(userName && { userName }),
          };
        }
        return {
          version: 1,
          ok: false,
          message: typeof result.message === "string" ? result.message : "未能获取飞书 Open ID",
        };
      } catch (error) {
        return { version: 1, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    async testChannel(rawInput: unknown): Promise<ChannelTestResponse> {
      try {
        const input = parseChannelTestInput(rawInput);
        if (input.preset === "desktop") {
          const [program, args] = notifyCommand("测试通知：桌面通知已启用");
          await new Promise<void>((resolve, reject) => {
            execImpl(program, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
          });
          return { version: 1, ok: true, message: "桌面通知已发送，请查看系统弹窗" };
        }
        if (input.preset === "feishu") {
          const config = readLocalConfig(options.home);
          const existing = config.channels?.[input.id];
          const appId = input.appId ?? (isNonEmptyString(existing?.appId) ? existing.appId.trim() : undefined);
          const appSecret =
            input.appSecret ?? (isNonEmptyString(existing?.appSecret) ? existing.appSecret.trim() : undefined);
          const user = input.user ?? (isNonEmptyString(existing?.user) ? existing.user.trim() : undefined);
          const domain = input.domain ?? (existing?.domain === "lark" ? "lark" : "feishu");
          if (!appId || !appSecret || !user) {
            return { version: 1, ok: false, message: "请先填写完整的 App ID、App Secret 和接收人 Open ID" };
          }
          const result = await runHelper({
            action: "feishu-test",
            appId,
            appSecret,
            user,
            domain,
          });
          if (result.ok === true) {
            return {
              version: 1,
              ok: true,
              message: typeof result.message === "string" ? result.message : "测试卡片已发送到飞书",
            };
          }
          return {
            version: 1,
            ok: false,
            message: typeof result.message === "string" ? result.message : "发送测试通知失败",
          };
        }
        const preset: ChannelPreset = input.preset;
        const url = input.url;
        if (!url) return { version: 1, ok: false, message: "请先填写 Webhook 地址" };
        const text = "测试通知：Agent 自动化中台通知通道已连接。";
        const platform = preset === "webhook" ? "" : preset;
        const body = platform
          ? payload(platform, text)
          : fillTemplate(input.body ? JSON.parse(input.body) : { text: "{text}" }, text);
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        await accepted(platform, response);
        return { version: 1, ok: true, message: "测试消息已发送，请到对应群聊查看" };
      } catch (error) {
        return { version: 1, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
