// Exercises production handlers with an in-memory DOM semantics fixture, not a browser DOM.
// Text inputs strip CR/LF; textareas preserve LF and normalize CR, matching relevant HTML value semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_RULES_MESSAGES, type DesktopRuleEntry } from "../../host/desktop-rules-contract.ts";
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
    return prevented;
  }
  click() {
    if (!this.disabled && !this.hidden) this.emit("click");
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
const ready = (rulesSeq = 10, entries: readonly DesktopRuleEntry[] = [original]) => ({
  version: 3,
  ok: true,
  data: { entries, agents: [{ id: "a", name: "<svg onload=evil>", use: "edit" }], seq: 50, rulesSeq },
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
  // The refresh button is created only when the error path needs it, so tests reach it lazily.
  const refresh = () => find((node) => node.tag === "button" && node.className === "rules-refresh");
  const clickRefresh = () => {
    refresh().hidden = false;
    refresh().click();
  };
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
    clickRefresh,
    form: () => find((node) => node.tag === "form"),
    // The editor is an in-page section now; its visibility replaces the dialog's open flag.
    editor: () => find((node) => node.tag === "section" && node.className.includes("rules-editor-panel")),
    editorOpen: () => !find((node) => node.tag === "section" && node.className.includes("rules-editor-panel")).hidden,
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
    assert.equal(f.editorOpen(), true);
    assert.equal(f.id("group").value, "组");
    assert.equal(f.id("tell").value, "never");
    assert.equal(f.id("emits-source").value, "app");
    assert.equal(f.id("emits-types").value, "done.*");
    f.id("name").value = "新名";
    // One confirm is one save: no standing draft bar, the PUT leaves immediately.
    f.form().emit("submit");
    assert.equal(f.editorOpen(), false);
    assert.equal(f.inputs.length, 1);
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

test("an unchanged confirm saves nothing and leaves no draft behind", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.form().emit("submit");
    assert.equal(f.editorOpen(), false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.controller.getState().draft, null);
    assert.equal(f.controller.getState().saving, false);
    assert.ok(!f.text().includes("放弃本地修改"));
  }));

test("a confirm mid-save is refused, but the saving PUT keeps the page locked", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.id("name").value = "第一笔";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.button("编辑").disabled, true);
    // A second confirm during the flight neither sends nor mutates anything.
    f.button("编辑").emit("click");
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().saving, true);
    f.answer(ready(19));
    await flush();
    assert.equal(f.controller.getState().save.kind, "confirmed");
    assert.equal(f.controller.getState().saving, false);
    assert.equal(f.button("编辑").disabled, false);
  }));

test("cancel does not submit; the reopen reads the saved values", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.id("name").value = "未提交";
    f.button("取消").click();
    assert.equal(f.editorOpen(), false);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.controller.getState().draft, null);
    f.button("编辑").click();
    assert.equal(f.id("name").value, original.name);
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
      f.id("name").value = "改动";
      f.form().emit("submit");
      f.answer(desktopRulesCasPutFailure(code, code === "conflict" ? "rejected" : "uncertain"));
      await flush();
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      f.version(22);
      f.clickRefresh();
      await flush();
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      // The failed save keeps its draft as the review barrier; the save button stays disabled.
      assert.ok(f.controller.getState().draft);
      assert.equal(f.button("保存到本机中台").disabled, true);
      f.button("编辑").click();
      f.id("name").value = "仍需核对";
      f.form().emit("submit");
      assert.equal(f.inputs.length, 1);
      // The review barrier routes the same discard button to discard-and-reload.
      f.button("放弃本地修改").click();
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
    // The pre-seeded edit differs from the baseline, so this confirm saves right away.
    assert.deepEqual(f.inputs[0], { entries: [multiline], rulesSeq: 10 });
    // The hub answers with the saved value, so the reopened editor reads the multiline entry back.
    f.answer(ready(19, [multiline]));
    await flush();
    assert.equal(f.controller.getState().draft, null);
    f.button("编辑").click();
    f.id("types").value = "task.one\ntask.two";
    f.id("emits-types").value = "done.one\ndone.two";
    // One confirm sends the PUT directly.
    f.form().emit("submit");
    assert.deepEqual(f.inputs[1], {
      entries: [
        {
          ...multiline,
          types: ["task.one", "task.two"],
          emits: { ...multiline.emits, types: ["done.one", "done.two"] },
        },
      ],
      rulesSeq: 19,
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
  test(`CR/CRLF semantic values survive editor submission: ${change}`, () =>
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
      assert.equal(f.editorOpen(), false);
      assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
      // The confirm saves whatever the draft holds against the read baseline: the seeded
      // carriageEntry is already a change, so none/restore send it too; edit sends its own.
      assert.equal(f.inputs.length, 1);
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
    const expected: DesktopRuleEntry = {
      name: carriageEntry.name,
      types: ["task.one", "task.two"],
      to: carriageEntry.to,
      cwd: carriageEntry.cwd,
      group: carriageEntry.group,
      emits: { source: carriageEntry.emits.source, types: ["done.new", "done.last"] },
    };
    assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
    // The changed confirm sent its PUT; re-confirming the same values sends nothing new.
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.inputs[0], { entries: [expected], rulesSeq: 10 });
    f.answer(ready(19, [expected]));
    await flush();
    assert.equal(f.controller.getState().draft, null);
    // A contract-invalid confirm is caught inside the editor: the form stays open with the error.
    f.button("编辑").click();
    f.id("emits-source").value = "";
    const before = f.controller.getState().draft;
    f.form().emit("submit");
    assert.equal(f.editorOpen(), true);
    assert.equal(f.controller.getState().draft, before);
    f.id("emits-types").value = "";
    f.id("group").value = "";
    f.form().emit("submit");
    const { group: _group, emits: _emits, ...cleared } = expected as typeof original;
    assert.deepEqual(f.controller.getState().draft?.entries[0], cleared);
  }));

test("CR baseline is isolated across cancelled, expired, reopened and add editors", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.controller.beginEdit();
    f.controller.updateEntry(0, carriageEntry);
    f.button("编辑").click();
    f.id("prompt").value = "未提交";
    // Cancel owns nothing: the whole draft goes, the page stays as it was read.
    f.button("取消").click();
    assert.equal(f.controller.getState().draft, null);
    f.button("编辑").click();
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.button("编辑").click();
    f.form().emit("submit");
    // An unchanged confirm leaves the page as read: no PUT, no draft.
    assert.equal(f.controller.getState().draft, null);
    assert.equal(f.inputs.length, 0);
    const next = { ...carriageEntry, name: "另\r入口", prompt: "不同\r\n提示", group: "不同\r组" };
    f.controller.beginEdit();
    f.controller.updateEntry(0, next);
    f.button("编辑").click();
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], next);
    // The confirmed change is a save in flight; a new editor waits for it to settle.
    f.answer(ready(11, [next]));
    await flush();
    f.button("＋ 添加入口").click();
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

test("a confirm that fails validation never sends and keeps the draft in the editor", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.id("name").value = "改动";
    const encode = TextEncoder.prototype.encode;
    try {
      TextEncoder.prototype.encode = function () {
        throw new Error("private");
      };
      // The confirm parses the entry itself: a failure there never opens a PUT flight,
      // and the editor stays open with the draft for the operator to fix or cancel.
      assert.doesNotThrow(() => f.form().emit("submit"));
    } finally {
      TextEncoder.prototype.encode = encode;
    }
    assert.equal(f.inputs.length, 0);
    assert.equal(f.editorOpen(), true);
    assert.ok(f.controller.getState().draft);
    // The editor names the failure instead of silently swallowing it.
    const formError = f.find((node) => node.className === "setup-error");
    assert.equal(formError.hidden, false);
    assert.ok(formError.textContent.length > 0);
  }));

test("obsolete uncertain PUT disables a new draft save without labelling its outcome", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.id("name").value = "改动";
    f.form().emit("submit");
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.answer(desktopRulesCasPutFailure("uncertain", "uncertain"));
    await flush();
    assert.equal(f.controller.getState().save.kind, "idle");
    assert.equal(f.button("保存到本机中台").disabled, true);
    assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES.uncertain));
    f.button("放弃本地修改").click();
    await flush();
    assert.equal(f.controller.getState().needsReview, false);
  }));

test("form validation, add/remove and explicit clearing use the existing full contract", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("＋ 添加入口").click();
    f.form().emit("submit");
    assert.equal(f.editorOpen(), true);
    for (const [name, value] of [
      ["name", "添加"],
      ["types", "task.one,task.two"],
      ["to", "a"],
      ["cwd", "~/x"],
    ])
      f.id(name).value = value;
    // A confirmed add is a save in flight: the draft holds both entries until the PUT settles.
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().draft?.entries.length, 2);
    f.answer(ready(19));
    await flush();
    assert.equal(f.controller.getState().draft, null);
    f.button("编辑").click();
    for (const name of ["prompt", "skill", "parallel", "group", "tell", "emits-source", "emits-types"])
      f.id(name).value = "";
    f.form().emit("submit");
    const { group: _g, emits: _e, prompt: _p, skill: _s, tell: _t, ...clearedEntry } = original;
    const landed: DesktopRuleEntry = { ...clearedEntry, parallel: undefined };
    f.answer(ready(20, [landed]));
    await flush();
    assert.deepEqual(f.controller.getState().snapshot?.entries[0], {
      name: original.name,
      types: original.types,
      to: original.to,
      cwd: original.cwd,
    });
  }));

test("the page names what it does not own before any edit starts", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    // The boundary is visible without opening a draft: this list is the local slots only.
    assert.ok(f.text().includes("只编辑本机入口；其他规则在中台网页控制台修改"));
  }));

test("the preview states only what the save hands over for the local slots", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const preview = f.find((node) => /\brules-preview\b/.test(node.className));
    // No draft without a dialog: the preview only appears while a confirmed change is unsaved.
    assert.equal(preview.hidden, true);
    f.button("编辑").click();
    assert.equal(preview.hidden, true);
    f.id("name").value = "改动";
    f.form().emit("submit");
    // The confirm sent the PUT; until it settles the preview says what is being handed over.
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, `本次保存将提交 1 条本机入口：修改 1 条。`);
  }));

test("the preview compares every entry field, so an unchanged draft reports no change", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const preview = f.find((node) => /\brules-preview\b/.test(node.className));
    // A confirmed change is a save in flight: the preview names exactly what the PUT hands over.
    f.button("编辑").click();
    f.id("name").value = "改动";
    f.form().emit("submit");
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, `本次保存将提交 1 条本机入口：修改 1 条。`);
    f.answer(ready(19, [{ ...original, name: "改动" }]));
    await flush();
    assert.equal(preview.hidden, true);
  }));
