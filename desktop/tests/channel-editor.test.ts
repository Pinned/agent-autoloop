// Tests the beginner-friendly channel preset picker, Feishu auto-bind/test flow, and helper utilities.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChannelSavePayload,
  channelStatusLabel,
  inferPresetFromId,
  isLocalhostUrl,
  nextAvailableId,
} from "../src/renderer/channel-editor.ts";

test("nextAvailableId avoids colliding with existing channel ids", () => {
  assert.equal(nextAvailableId("feishu", []), "feishu");
  assert.equal(nextAvailableId("feishu", ["desktop", "feishu"]), "feishu-2");
  assert.equal(nextAvailableId("feishu", ["feishu", "feishu-2"]), "feishu-3");
  assert.equal(nextAvailableId("", ["feishu"]), "");
});

test("inferPresetFromId and channelStatusLabel map presets and readiness clearly", () => {
  assert.equal(inferPresetFromId("desktop"), "desktop");
  assert.equal(inferPresetFromId("feishu"), "feishu");
  assert.equal(inferPresetFromId("feishu-2"), "feishu");
  assert.equal(inferPresetFromId("dingtalk"), "dingtalk");
  assert.equal(inferPresetFromId("my-custom"), "custom");

  assert.equal(channelStatusLabel(undefined), null);
  assert.deepEqual(channelStatusLabel({ id: "feishu", preset: "feishu", hasKey: true, configured: true }), {
    text: "已就绪",
    tone: "ok",
  });
  assert.deepEqual(channelStatusLabel({ id: "feishu", preset: "feishu", hasKey: false, configured: false }), {
    text: "待完善凭据",
    tone: "warn",
  });
});

test("buildChannelSavePayload trims fields and preserves domain selection", () => {
  assert.deepEqual(
    buildChannelSavePayload("feishu", {
      id: " feishu ",
      appId: " cli_1 ",
      appSecret: " sec_1 ",
      user: " ou_1 ",
      domain: "lark",
    }),
    {
      id: "feishu",
      preset: "feishu",
      appId: "cli_1",
      appSecret: "sec_1",
      user: "ou_1",
      domain: "lark",
    },
  );
  assert.equal(isLocalhostUrl("http://127.0.0.1:4040"), true);
  assert.equal(isLocalhostUrl("https://hub.example.com"), false);
});
