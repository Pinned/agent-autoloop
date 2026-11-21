// Local channel config source & contract tests: protects against leaking appSecret to the renderer,
// losing an existing appSecret on partial edit, regenerating keys unnecessarily, or accepting bad URLs/JSON.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createChannelConfigSource, parseHelperStdout } from "../desktop/src/channel-config-source.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-channel-cfg-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("channel config source saves feishu without exposing appSecret and preserves secret on edit", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:4040", channels: {} }));
  let keysCreated = 0;
  let restarted = 0;
  const source = createChannelConfigSource({
    home,
    createKey: async (id) => {
      keysCreated++;
      return `key-${id}`;
    },
    restartHub: async () => {
      restarted++;
      return true;
    },
  });

  const saved = await source.save({
    id: "feishu",
    preset: "feishu",
    appId: "cli_123",
    appSecret: "sec_super_secret",
    user: "ou_me",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.data.restarted, true);
  assert.equal(saved.data.channel.configured, true);
  assert.equal(saved.data.channel.hasSecret, true);
  assert.equal("appSecret" in saved.data.channel, false, "never echo appSecret back to renderer");
  assert.equal(keysCreated, 1);
  assert.equal(restarted, 1);

  const read = source.read();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.data.channels.length, 1);
  assert.equal(read.data.channels[0].appId, "cli_123");
  assert.equal(read.data.channels[0].hasSecret, true);
  assert.equal("appSecret" in read.data.channels[0], false);

  // Editing user without re-entering appSecret preserves the existing secret and key.
  const updated = await source.save({
    id: "feishu",
    preset: "feishu",
    appId: "cli_123",
    user: "ou_updated",
  });
  assert.equal(updated.ok, true);
  assert.equal(keysCreated, 1);
  const disk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(disk.channels.feishu.appSecret, "sec_super_secret");
  assert.equal(disk.channels.feishu.user, "ou_updated");
  assert.equal(disk.channels.feishu.key, "key-feishu");
});

test("channel config source validates webhooks, tests sending, and binds feishu open_id", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:4040", channels: {} }));
  const fetched: Array<{ url: string; body: unknown }> = [];
  const helperCalls: Array<Record<string, unknown>> = [];
  const source = createChannelConfigSource({
    home,
    createKey: async (id) => `key-${id}`,
    runHelper: async (input) => {
      helperCalls.push(input);
      if (input.action === "feishu-bind") return { ok: true, openId: "ou_bound", userName: "张三" };
      return { ok: true, message: "测试卡片已发送" };
    },
    fetchImpl: (async (url: string, init?: RequestInit) => {
      fetched.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }) as typeof fetch,
  });

  const badUrl = await source.save({ id: "dingtalk", preset: "dingtalk", url: "ftp://bad" });
  assert.equal(badUrl.ok, false);

  const savedDing = await source.save({
    id: "dingtalk",
    preset: "dingtalk",
    url: "https://oapi.dingtalk.com/robot/send?access_token=abc",
  });
  assert.equal(savedDing.ok, true);

  const testDing = await source.testChannel({
    id: "dingtalk",
    preset: "dingtalk",
    url: "https://oapi.dingtalk.com/robot/send?access_token=abc",
  });
  assert.equal(testDing.ok, true);
  assert.equal(fetched.length, 1);
  assert.equal((fetched[0].body as { msgtype: string }).msgtype, "text");

  const badCode = await source.bindFeishu({ appId: "cli_1", appSecret: "sec_1", pairingCode: "12ab" });
  assert.equal(badCode.ok, false);

  const bound = await source.bindFeishu({ appId: "cli_1", appSecret: "sec_1", pairingCode: "482910" });
  assert.deepEqual(bound, { version: 1, ok: true, openId: "ou_bound", userName: "张三" });
  assert.equal(helperCalls[0].action, "feishu-bind");
  assert.equal(helperCalls[0].pairingCode, "482910");

  const testFeishu = await source.testChannel({
    id: "feishu",
    preset: "feishu",
    appId: "cli_1",
    appSecret: "sec_1",
    user: "ou_bound",
  });
  assert.equal(testFeishu.ok, true);
  assert.equal(helperCalls[1].action, "feishu-test");
});

test("parseHelperStdout ignores SDK info logs on stdout and extracts the marked JSON result", () => {
  const noisy = `[info]: [ 'ws connect success' ]\n[info]: [ 'receive message' ]\nCHANNEL_HELPER_RESULT:{"ok":true,"openId":"ou_real"}\n`;
  assert.deepEqual(parseHelperStdout(noisy), { ok: true, openId: "ou_real" });
});

test("cancelBindFeishu aborts an in-flight pairing listener immediately", async () => {
  const home = mkdtempSync(join(dir, "home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:4040", channels: {} }));
  const source = createChannelConfigSource({
    home,
    runHelper: async () => await new Promise<Record<string, unknown>>(() => {}),
  });
  const pending = source.bindFeishu({ appId: "cli_1", appSecret: "sec_1", pairingCode: "123456" });
  source.cancelBindFeishu();
  const res = await pending;
  assert.deepEqual(res, { version: 1, ok: false, message: "已取消配对" });
});
