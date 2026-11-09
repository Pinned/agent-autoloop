// Exercises production handlers with an in-memory DOM semantics fixture, not a browser DOM.
// Text inputs strip CR/LF; textareas preserve LF and normalize CR, matching relevant HTML value semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_RULES_CAS_MESSAGES, desktopRulesCasPutFailure } from "../../host/desktop-rules-cas-contract.ts";
import { createRendererRulesCas } from "../src/renderer/rules-cas-controller.ts";
import { mountRulesCasView } from "../src/renderer/rules-cas-view.ts";

class Element {
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  textContent = "";
  private given = "";
  get value() {
    return this.given;
  }
  set value(value: string) {
    this.given =
      this.tag === "input" && (this.type === "" || this.type === "text")
        ? value.replace(/[\r\n]/g, "")
        : this.tag === "textarea"
          ? value.replace(/\r\n?/g, "\n")
          : value;
  }
  open = false;
  children: Element[] = [];
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  classList = { toggle() {} };
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  set innerHTML(_value: string) {
    throw new Error("unsafe markup");
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(name: string, value: string) {
    if (name === "type") this.type = value;
  }
  querySelector(tag: string) {
    return all(this).find((node) => node !== this && node.tag === tag) ?? null;
  }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string) {
    let prevented = false;
    for (const listener of this.listeners.get(name) ?? [])
      listener({
        preventDefault() {
          prevented = true;
        },
      });
    if (name === "cancel" && !prevented) this.close();
    return prevented;
  }
  click() {
    if (!this.disabled && !this.hidden) this.emit("click");
  }
  close() {
    this.open = false;
    this.emit("close");
  }
  showModal() {
    this.open = true;
  }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const original = {
  name: "<img onerror=evil>",
  types: ["task.*"],
  to: "a",
  cwd: "~/x",
  prompt: "<script>evil</script>",
  skill: "技能",
  parallel: 2,
  group: "组",
  tell: "never" as const,
  emits: { source: "app", types: ["done.*"] },
};
const ready = (rulesSeq = 10) => ({
  version: 3,
  ok: true,
  data: { entries: [original], agents: [{ id: "a", name: "<svg onload=evil>", use: "edit" }], seq: 50, rulesSeq },
});
async function dom(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new Element("body");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, createElement: (tag: string) => new Element(tag) },
  });
  try {
    await run(fixture(body));
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function fixture(body: Element) {
  const inputs: unknown[] = [];
  let answer!: (value: unknown) => void;
  let version = 10;
  let gets = 0;
  const controller = createRendererRulesCas({
    rulesGet() {
      gets++;
      return Promise.resolve(ready(version));
    },
    rulesPut(input) {
      inputs.push(input);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  const view = mountRulesCasView(controller);
  body.append(view.root as unknown as Element);
  const find = (predicate: (node: Element) => boolean) => {
    const node = all(body).find(predicate);
    assert.ok(node);
    return node;
  };
  const button = (text: string) => find((node) => node.tag === "button" && node.textContent === text);
  const id = (name: string) => find((node) => node.id === `rules-${name}`);
  return {
    body,
    controller,
    view,
    inputs,
    answer: (value: unknown) => answer(value),
    version: (value: number) => {
      version = value;
    },
    gets: () => gets,
    button,
    id,
    find,
    form: () => find((node) => node.tag === "form"),
    dialog: () => find((node) => node.tag === "dialog"),
    text: () =>
      all(body)
        .map((node) => node.textContent)
        .join("\n"),
  };
}

test("production click/submit preserves advanced fields and safely displays hostile text", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    assert.equal(f.dialog().open, true);
    assert.equal(f.id("group").value, "组");
    assert.equal(f.id("tell").value, "never");
    assert.equal(f.id("emits-source").value, "app");
    assert.equal(f.id("emits-types").value, "done.*");
    f.id("name").value = "新名";
    f.form().emit("submit");
    assert.equal(f.dialog().open, false);
    f.button("保存到本机中台").click();
    assert.deepEqual(f.inputs[0], { entries: [{ ...original, name: "新名" }], rulesSeq: 10 });
    assert.ok(f.text().includes("<svg onload=evil>"));
    assert.equal(
      all(f.body).some((node) => node.tag === "img" || node.tag === "script" || node.tag === "svg"),
      false,
    );
    f.answer(ready(19));
    await flush();
    assert.ok(f.text().includes("已确认保存到本机中台"));
  }));

test("saving locks edit/remove/save handlers but cancel keeps the physical PUT occupied", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.form().emit("submit");
    const edit = f.button("编辑");
    const remove = f.button("移除");
    const save = f.button("保存到本机中台");
    save.click();
    assert.equal(f.inputs.length, 1);
    assert.equal(f.button("编辑").disabled, true);
    assert.equal(f.button("移除").disabled, true);
    edit.emit("click");
    remove.emit("click");
    save.emit("click");
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().draft?.entries.length, 1);
    assert.ok(f.text().includes("放弃本地修改不会撤回已发出的请求"));
    f.button("放弃本地修改").click();
    assert.equal(f.controller.getState().draft, null);
    assert.equal(f.controller.getState().saving, true);
    f.button("刷新数据").click();
    f.button("刷新数据").click();
    assert.equal(f.gets(), 1);
    f.answer(ready(20));
    await flush();
    assert.equal(f.gets(), 2);
    assert.equal(f.controller.getState().save.kind, "idle");
  }));

test("native dialog cancel does not submit; expired dialog cannot update a new draft", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    const before = f.controller.getState().draft;
    f.id("name").value = "未提交";
    f.dialog().emit("cancel");
    assert.equal(f.dialog().open, false);
    assert.deepEqual(f.controller.getState().draft, before);
    f.button("编辑").click();
    f.id("name").value = "过期";
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.form().emit("submit");
    assert.equal(f.controller.getState().draft?.entries[0].name, original.name);
  }));

for (const code of ["conflict", "uncertain"] as const)
  test(`${code} shows fixed Chinese, frozen versions and explicit discard recovery`, () =>
    dom(async (f) => {
      f.view.init();
      await flush();
      f.button("编辑").click();
      f.form().emit("submit");
      f.button("保存到本机中台").click();
      f.answer(desktopRulesCasPutFailure(code, code === "conflict" ? "rejected" : "uncertain"));
      await flush();
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      f.version(22);
      f.button("刷新数据").click();
      await flush();
      assert.ok(f.text().includes("服务器规则版本 R22"));
      assert.ok(f.text().includes("草稿基线 R10"));
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      assert.equal(f.button("保存到本机中台").disabled, true);
      f.button("编辑").click();
      f.id("name").value = "仍需核对";
      f.form().emit("submit");
      f.button("保存到本机中台").emit("click");
      assert.equal(f.inputs.length, 1);
      f.button("丢弃草稿并重新读取").click();
      await flush();
      assert.equal(f.controller.getState().draft, null);
      f.button("编辑").click();
      assert.equal(f.controller.getState().draft?.rulesSeq, 22);
    }));

test("legal multiline fields round trip without text-input newline loss", () =>
  dom(async (f) => {
    const multiline = {
      ...original,
      name: "甲\n乙",
      to: "a\nb",
      cwd: "~/甲\n乙",
      skill: "技\n能",
      group: "甲\n乙",
      prompt: "提\n示",
      emits: { source: "app\nsource", types: ["done.*"] },
    };
    const probe = new Element("input");
    probe.value = "甲\n乙";
    assert.equal(probe.value, "甲乙");
    f.view.init();
    await flush();
    f.controller.beginEdit();
    f.controller.updateEntry(0, multiline);
    f.button("编辑").click();
    for (const [field, value] of [
      ["name", multiline.name],
      ["to", multiline.to],
      ["cwd", multiline.cwd],
      ["skill", multiline.skill],
      ["group", multiline.group],
      ["emits-source", multiline.emits.source],
    ])
      assert.equal(f.id(field).value, value);
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], multiline);
    f.button("编辑").click();
    f.id("types").value = "task.one\ntask.two";
    f.id("emits-types").value = "done.one\ndone.two";
    f.form().emit("submit");
    f.button("保存到本机中台").click();
    assert.deepEqual(f.inputs[0], {
      entries: [
        {
          ...multiline,
          types: ["task.one", "task.two"],
          emits: { ...multiline.emits, types: ["done.one", "done.two"] },
        },
      ],
      rulesSeq: 10,
    });
  }));

const carriageEntry = {
  ...original,
  name: "甲\r\n乙",
  to: "a\rb",
  cwd: "~/甲\r\n乙",
  prompt: "第一行\r第二行",
  skill: "技\r\n能",
  group: "甲\r\n乙",
  emits: { source: "app\r\nsource", types: ["done.one", "done.two"] },
};

for (const change of ["none", "other", "restore", "edit"] as const)
  test(`CR/CRLF semantic values survive dialog submission: ${change}`, () =>
    dom(async (f) => {
      f.view.init();
      await flush();
      f.controller.beginEdit();
      f.controller.updateEntry(0, carriageEntry);
      f.button("编辑").click();
      assert.equal(f.id("group").value, "甲\n乙");
      assert.equal(f.id("prompt").value, "第一行\n第二行");
      let expected = carriageEntry;
      if (change === "other") {
        f.id("name").value = "另一个名称";
        expected = { ...carriageEntry, name: "另一个名称" };
      }
      if (change === "restore") {
        for (const field of ["name", "to", "cwd", "prompt", "skill", "group", "emits-source"]) {
          const initial = f.id(field).value;
          f.id(field).value = "临时编辑";
          f.id(field).emit("input");
          f.id(field).value = initial;
          f.id(field).emit("input");
        }
      }
      if (change === "edit") {
        f.id("prompt").value = "修改\r\n后的提示";
        f.id("group").value = "新\r分组";
        expected = { ...carriageEntry, prompt: "修改\n后的提示", group: "新\n分组" };
      }
      f.form().emit("submit");
      assert.equal(f.dialog().open, false);
      assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
      f.button("保存到本机中台").click();
      assert.deepEqual(f.inputs[0], { entries: [expected], rulesSeq: 10 });
    }));

test("CR baseline retains optional absence, explicit group and independent emits edits", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.controller.beginEdit();
    f.controller.updateEntry(0, carriageEntry);
    f.button("编辑").click();
    f.id("types").value = "task.one\r\ntask.two";
    f.id("emits-types").value = "done.new,done.last";
    for (const field of ["prompt", "skill", "parallel", "tell"]) f.id(field).value = "";
    f.form().emit("submit");
    const expected = {
      name: carriageEntry.name,
      types: ["task.one", "task.two"],
      to: carriageEntry.to,
      cwd: carriageEntry.cwd,
      group: carriageEntry.group,
      emits: { source: carriageEntry.emits.source, types: ["done.new", "done.last"] },
    };
    assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
    f.button("编辑").click();
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
    f.button("编辑").click();
    f.id("emits-source").value = "";
    const before = f.controller.getState().draft;
    f.form().emit("submit");
    assert.equal(f.dialog().open, true);
    assert.equal(f.controller.getState().draft, before);
    f.id("emits-types").value = "";
    f.id("group").value = "";
    f.form().emit("submit");
    const { group: _group, emits: _emits, ...cleared } = expected;
    assert.deepEqual(f.controller.getState().draft?.entries[0], cleared);
  }));

test("CR baseline is isolated across cancelled, expired, reopened and add dialogs", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.controller.beginEdit();
    f.controller.updateEntry(0, carriageEntry);
    f.button("编辑").click();
    f.id("prompt").value = "未提交";
    f.dialog().emit("cancel");
    assert.deepEqual(f.controller.getState().draft?.entries[0], carriageEntry);
    f.button("编辑").click();
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], original);
    const next = { ...carriageEntry, name: "另\r入口", prompt: "不同\r\n提示", group: "不同\r组" };
    f.controller.updateEntry(0, next);
    f.button("编辑").click();
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], next);
    f.button("添加入口").click();
    for (const [field, value] of [
      ["name", "新增"],
      ["types", "task.new"],
      ["to", "a"],
      ["cwd", "~/new"],
    ])
      f.id(field).value = value;
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[1], {
      name: "新增",
      types: ["task.new"],
      to: "a",
      cwd: "~/new",
    });
  }));

test("save click contains validation failure and shows fixed text without sending", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.form().emit("submit");
    const encode = TextEncoder.prototype.encode;
    try {
      TextEncoder.prototype.encode = function () {
        throw new Error("private");
      };
      assert.doesNotThrow(() => f.button("保存到本机中台").click());
    } finally {
      TextEncoder.prototype.encode = encode;
    }
    assert.equal(f.inputs.length, 0);
    assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES.invalid));
    assert.ok(f.controller.getState().draft);
  }));

test("obsolete uncertain PUT disables a new draft save without labelling its outcome", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.form().emit("submit");
    f.button("保存到本机中台").click();
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.answer(desktopRulesCasPutFailure("uncertain", "uncertain"));
    await flush();
    assert.equal(f.controller.getState().save.kind, "idle");
    assert.equal(f.button("保存到本机中台").disabled, true);
    assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES.uncertain));
    f.button("丢弃草稿并重新读取").click();
    await flush();
    assert.equal(f.controller.getState().needsReview, false);
  }));

test("form validation, add/remove and explicit clearing use the existing full contract", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("添加入口").click();
    f.form().emit("submit");
    assert.equal(f.dialog().open, true);
    for (const [name, value] of [
      ["name", "添加"],
      ["types", "task.one,task.two"],
      ["to", "a"],
      ["cwd", "~/x"],
    ])
      f.id(name).value = value;
    f.form().emit("submit");
    assert.equal(f.controller.getState().draft?.entries.length, 2);
    f.button("移除").click();
    assert.equal(f.controller.getState().draft?.entries.length, 1);
    f.controller.cancelEdit();
    f.button("编辑").click();
    for (const name of ["prompt", "skill", "parallel", "group", "tell", "emits-source", "emits-types"])
      f.id(name).value = "";
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], {
      name: original.name,
      types: original.types,
      to: original.to,
      cwd: original.cwd,
    });
  }));

const COUNTED = "仅描述将提交的本机入口；不代表中台已接受，也不代表路由结果；非 local 规则不会被改动。";
const second = { ...original, name: "第二个", types: ["task.other"], to: "a", cwd: "~/y" };

test("the preview states only what the save hands over for the local slots", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const preview = f.find((node) => /\brules-preview\b/.test(node.className));
    assert.equal(preview.hidden, true);
    f.button("编辑").click();
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, `本次保存将提交的本机入口与当前一致（共 1 条）。 ${COUNTED}`);
    // A new entry is appended after the last local slot by the hub's own merge; the count says so.
    f.controller.addEntry(second);
    assert.equal(preview.textContent, `本次保存将提交 2 条本机入口：新增 1 条。 ${COUNTED}`);
    // Changing any displayed field counts as a modification of that slot.
    f.controller.updateEntry(0, { ...original, prompt: "改了" });
    assert.equal(preview.textContent, `本次保存将提交 2 条本机入口：新增 1 条、修改 1 条。 ${COUNTED}`);
    f.controller.removeEntry(1);
    assert.equal(preview.textContent, `本次保存将提交 1 条本机入口：修改 1 条。 ${COUNTED}`);
    // Removing every entry is the door's "clear all local entries" case, stated plainly.
    f.controller.removeEntry(0);
    assert.equal(preview.textContent, `本次保存将提交 0 条本机入口：删除全部 1 条。 ${COUNTED}`);
    // Discarding the draft hides it; the preview never outlives the draft it describes.
    f.button("放弃本地修改").click();
    assert.equal(preview.hidden, true);
  }));

test("the preview compares every entry field, so an unchanged draft reports no change", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const preview = f.find((node) => /\brules-preview\b/.test(node.className));
    f.controller.beginEdit();
    for (const field of ["name", "to", "cwd", "prompt", "skill", "group", "tell", "parallel"] as const)
      f.controller.updateEntry(0, { ...original, [field]: original[field] });
    f.controller.updateEntry(0, { ...original, types: [...original.types] });
    f.controller.updateEntry(0, { ...original, emits: { ...original.emits, types: [...original.emits.types] } });
    assert.equal(preview.textContent, `本次保存将提交的本机入口与当前一致（共 1 条）。 ${COUNTED}`);
    for (const changed of [
      { types: ["task.new"] },
      { emits: { source: "app", types: ["done.other"] } },
      { parallel: 3 },
      { tell: "always" as const },
      { group: "另一组" },
    ])
      f.controller.updateEntry(0, { ...original, ...changed });
    assert.equal(preview.textContent, `本次保存将提交 1 条本机入口：修改 1 条。 ${COUNTED}`);
    f.controller.updateEntry(0, original);
    assert.equal(preview.textContent, `本次保存将提交的本机入口与当前一致（共 1 条）。 ${COUNTED}`);
  }));
