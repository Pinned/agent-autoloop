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
import { createRendererSettings } from "../src/renderer/settings-controller.ts";
import { mountSettingsView } from "../src/renderer/settings-view.ts";

function fakeDom() {
  const make = (tag: string): any => {
    const el: any = {
      tagName: tag.toUpperCase(),
      className: "",
      id: "",
      textContent: "",
      value: "",
      type: "text",
      hidden: false,
      disabled: false,
      checked: false,
      open: false,
      children: [] as any[],
      dataset: {} as Record<string, string>,
      style: {} as Record<string, string>,
      listeners: new Map<string, Array<(e?: any) => void>>(),
      setAttribute(name: string, val: string) {
        if (name.startsWith("data-")) this.dataset[name.slice(5)] = val;
        this[name] = val;
      },
      getAttribute(name: string) {
        return this[name] ?? null;
      },
      append(...nodes: any[]) {
        for (const n of nodes) if (n && typeof n === "object") this.children.push(n);
      },
      replaceChildren(...nodes: any[]) {
        this.children = [];
        this.append(...nodes);
      },
      addEventListener(type: string, fn: (e?: any) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      },
      dispatch(type: string, event: any = {}) {
        for (const fn of this.listeners.get(type) ?? []) fn(event);
      },
      click() {
        this.dispatch("click", { stopPropagation() {} });
      },
      focus() {},
      remove() {},
      querySelector(selector: string) {
        if (selector.startsWith("#")) {
          const targetId = selector.slice(1);
          return findAll(this, (n) => n.id === targetId)[0] ?? null;
        }
        return null;
      },
      classList: {
        set: new Set<string>(),
        toggle(cls: string, force?: boolean) {
          if (force === undefined) {
            if (this.set.has(cls)) this.set.delete(cls);
            else this.set.add(cls);
          } else if (force) this.set.add(cls);
          else this.set.delete(cls);
        },
        contains(cls: string) {
          return this.set.has(cls);
        },
      },
    };
    return el;
  };
  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement: (tag: string) => make(tag),
    createElementNS: (_ns: string, tag: string) => make(tag),
  };
  return () => {
    (globalThis as any).document = prevDoc;
  };
}

function findAll(node: any, pred: (el: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, pred, out);
  return out;
}

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

test("channels tab fetches local config once (no render loop), opens edit, and deletes row", async () => {
  const restore = fakeDom();
  try {
    let localGetCalls = 0;
    const removedIds: string[] = [];
    const savedRules: unknown[] = [];
    let view: ReturnType<typeof mountSettingsView>;
    const controller = createRendererSettings(
      {
        settingsGet: async () => ({
          version: 1,
          ok: true,
          data: {
            timezone: "Asia/Shanghai",
            askFirst: [],
            workerIds: ["local"],
            agents: [],
            sources: [],
            channels: [{ id: "feishu", name: "飞书", answerers: ["ou_1"], links: false }],
            seq: 1,
            rulesSeq: 1,
          },
        }),
        settingsPut: async (input) => {
          savedRules.push(input);
          return {
            version: 1,
            ok: true,
            data: { section: input.section, value: input.value, seq: 2, rulesSeq: 2 },
          };
        },
      },
      () => view.update(),
    );
    view = mountSettingsView(controller, {
      role: () => "hub-worker",
      legacyConfig: () => false,
      theme: () => "system",
      setTheme: () => {},
      openSetup: () => {},
      channelBridge: {
        get: async () => {
          localGetCalls++;
          return {
            version: 1,
            ok: true,
            data: {
              channels: [
                {
                  id: "feishu",
                  preset: "feishu",
                  hasKey: true,
                  configured: true,
                  appId: "cli_1",
                  hasSecret: true,
                  user: "ou_1",
                  userName: "张三",
                },
              ],
              hubUrl: "http://127.0.0.1:4040",
            },
          };
        },
        save: async () => ({ version: 1, ok: false, error: { code: "error", message: "unused" } }),
        remove: async ({ id }) => {
          removedIds.push(id);
          return { version: 1, ok: true };
        },
        bindFeishu: async () => ({ version: 1, ok: false, message: "unused" }),
        test: async () => ({ version: 1, ok: false, message: "unused" }),
      },
    });
    view.init();
    await new Promise((r) => setTimeout(r, 20));
    const channelsTab = findAll(view.root, (el) => el.dataset?.tab === "channels")[0];
    channelsTab.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(localGetCalls, 1, "channelBridge.get must not trigger an infinite render loop");

    // Click 编辑 -> opens Feishu edit subpage (minimalist: no 取消/保存/删除 footer buttons).
    const editBtn = findAll(view.root, (el) => el.tagName === "BUTTON" && el.textContent === "编辑")[0];
    assert.ok(editBtn);
    editBtn.click();
    const title = findAll(view.root, (el) => el.id === "settings-editor-title")[0];
    assert.equal(title?.textContent, "编辑通知通道");
    assert.equal(findAll(view.root, (el) => String(el.className).includes("settings-form-footer")).length, 0);
    assert.equal(findAll(view.root, (el) => el.tagName === "BUTTON" && el.textContent === "保存并启用").length, 0);

    // Back button returns to list, then click 删除 -> opens danger confirmation dialog -> click 确认删除.
    const backBtn = findAll(view.root, (el) => el.tagName === "BUTTON" && el.textContent === "← 返回")[0];
    backBtn.click();
    const delBtn = findAll(view.root, (el) => el.tagName === "BUTTON" && el.textContent === "删除")[0];
    assert.ok(delBtn);
    delBtn.click();
    assert.deepEqual(removedIds, [], "delete must wait for confirmation dialog");
    const confirmBtn = findAll(view.root, (el) => el.tagName === "BUTTON" && el.textContent === "确认删除")[0];
    assert.ok(confirmBtn);
    confirmBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(removedIds, ["feishu"]);
    assert.equal(savedRules.length, 1);
    const statusEl = findAll(view.root, (el) => el.id === "settings-status")[0];
    assert.equal(statusEl?.textContent, "", "delete must not show '已保存' status text");
    const rowsAfterDelete = findAll(view.root, (el) => el.tagName === "LI");
    assert.equal(rowsAfterDelete.length, 0, "channel list must refresh immediately after deletion");
  } finally {
    restore();
  }
});
