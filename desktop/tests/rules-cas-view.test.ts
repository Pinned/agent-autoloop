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
  parentElement: Element | null = null;
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
    for (const node of nodes) node.parentElement = this;
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
  data: { entries, agents: [{ id: "a", name: "<svg onload=evil>", use: "command" }], seq: 50, rulesSeq },
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
  // The folder picker stands in for the main-process dialog: tests set what the OS "chose".
  let picked: string | null = null;
  let picks = 0;
  // Tests may swap the list the read serves (the empty state needs a hub with no entries).
  let served: readonly DesktopRuleEntry[] = [original];
  let use = "command";
  const controller = createRendererRulesCas({
    rulesGet() {
      gets++;
      const response = ready(version, served);
      response.data.agents[0].use = use;
      return Promise.resolve(response);
    },
    rulesPut(input) {
      inputs.push(input);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  const view = mountRulesCasView(controller, {
    goEntry: () => {},
    pickWorkingDir: () => {
      picks++;
      return Promise.resolve(picked);
    },
  });
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
    entries: (value: readonly DesktopRuleEntry[]) => {
      served = value;
    },
    gets: () => gets,
    use: (value: string) => {
      use = value;
    },
    // The picker stub: null is a cancelled OS dialog.
    pick: (value: string | null) => {
      picked = value;
    },
    picks: () => picks,
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
    // One confirm is one direct CAS save: the editor stays open until the hub confirms.
    f.form().emit("submit");
    assert.equal(f.editorOpen(), true);
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.inputs[0], { entries: [{ ...original, name: "新名" }], rulesSeq: 10 });
    assert.ok(f.text().includes("<svg onload=evil>"));
    assert.equal(
      all(f.body).some((node) => node.tag === "img" || node.tag === "script" || node.tag === "svg"),
      false,
    );
    f.answer(ready(19, [{ ...original, name: "新名" }]));
    await flush();
    assert.equal(f.editorOpen(), false);
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
    assert.equal(f.editorOpen(), true);
    assert.equal(f.button("保存中…").disabled, true);
    // A second confirm during the flight neither sends nor mutates anything.
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().saving, true);
    f.answer(ready(19));
    await flush();
    assert.equal(f.editorOpen(), false);
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
    assert.equal(f.inputs.length, 0);
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
      // Editor stays open with the typed value and locks writes behind explicit discard-and-reload.
      assert.equal(f.editorOpen(), true);
      assert.equal(f.id("name").value, "改动");
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      f.version(22);
      f.clickRefresh();
      await flush();
      assert.ok(f.text().includes(DESKTOP_RULES_CAS_MESSAGES[code]));
      assert.ok(f.controller.getState().draft);
      assert.equal(f.button("保存修改").disabled, true);
      f.id("name").value = "仍需核对";
      f.form().emit("submit");
      assert.equal(f.inputs.length, 1);
      // Explicit recovery discards the draft, reloads fresh data from the hub, and closes the editor.
      f.button("丢弃修改并重新读取").click();
      await flush();
      assert.equal(f.editorOpen(), false);
      assert.equal(f.controller.getState().draft, null);
      assert.equal(f.controller.getState().needsReview, false);
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
    assert.equal(f.editorOpen(), false);
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
      assert.equal(f.editorOpen(), true);
      assert.deepEqual(f.controller.getState().draft?.entries[0], expected);
      // The confirm saves whatever the draft holds against the read baseline directly.
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
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.inputs[0], { entries: [expected], rulesSeq: 10 });
    f.answer(ready(19, [expected]));
    await flush();
    assert.equal(f.editorOpen(), false);
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
    // Cancel discards this form's typing, not the draft that existed before it opened.
    f.button("取消").click();
    assert.deepEqual(f.controller.getState().draft?.entries[0], carriageEntry);
    f.controller.cancelEdit();
    f.button("编辑").click();
    f.controller.cancelEdit();
    f.controller.beginEdit();
    f.button("编辑").click();
    f.form().emit("submit");
    // An unchanged confirm leaves the page as read: no PUT, no draft.
    assert.equal(f.controller.getState().draft, null);
    assert.equal(f.inputs.length, 0);
    const next = { ...carriageEntry, name: "另\r规则", prompt: "不同\r\n提示", group: "不同\r组" };
    f.controller.beginEdit();
    f.controller.updateEntry(0, next);
    f.button("编辑").click();
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[0], next);
    // The confirmed change is a save in flight; a new editor waits for it to settle.
    f.answer(ready(11, [next]));
    await flush();
    f.button("＋ 添加规则").click();
    for (const [field, value] of [
      ["name", "新增"],
      ["types", "task.new"],
      ["to", "a"],
      ["cwd", "/work/new"],
    ])
      f.id(field).value = value;
    f.form().emit("submit");
    assert.deepEqual(f.controller.getState().draft?.entries[1], {
      name: "新增",
      types: ["task.new"],
      to: "a",
      cwd: "/work/new",
      autoGroup: true,
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
    f.button("丢弃修改并重新读取").click();
    await flush();
    assert.equal(f.controller.getState().needsReview, false);
  }));

test("form validation, add/remove and explicit clearing use the existing full contract", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("＋ 添加规则").click();
    f.form().emit("submit");
    assert.equal(f.editorOpen(), true);
    for (const [name, value] of [
      ["name", "添加"],
      ["types", "task.one,task.two"],
      ["to", "a"],
      ["cwd", "~/x"],
    ])
      f.id(name).value = value;
    // New rules opt into automatic grouping; a remote home cannot be inferred by the hub.
    assert.equal(f.id("autoGroup").value, "true");
    f.form().emit("submit");
    assert.equal(f.inputs.length, 0);
    assert.ok(f.text().includes("绝对路径"));
    f.id("cwd").value = "/work/x";
    // A confirmed add is a save in flight: the draft holds both entries until the PUT settles.
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().draft?.entries.length, 2);
    f.answer(ready(19));
    await flush();
    assert.equal(f.editorOpen(), false);
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
    // The boundary lives in the page head (app.ts renders it), not repeated inside the view; the
    // list body itself carries no standing instruction line — that was the demo feel this page shed.
    assert.ok(!f.text().includes("只编辑本机入口"));
  }));

test("an empty list shows an empty-state card with a way in, not a bare status sentence", () =>
  dom(async (f) => {
    f.entries([]);
    f.view.init();
    await flush();
    const empty = f.find((node) => /\brules-empty\b/.test(node.className));
    assert.ok(!empty.hidden);
    // The card's own subtree carries the title and the line (the fixture keeps text on leaves).
    assert.ok(all(empty).some((node) => node.textContent.includes("还没有规则")));
    assert.ok(f.button("＋ 添加规则") !== undefined);
  }));

test("the working directory is picked, not typed: a choice fills it, a cancel keeps it", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    // The field is read-only from birth: no free-typed path and no paste into it.
    assert.equal(f.id("cwd").disabled, false);
    // A cancelled OS dialog changes nothing: the old value stays, one door call happened.
    f.pick(null);
    f.button("选择文件夹").click();
    await flush();
    assert.equal(f.picks(), 1);
    assert.equal(f.id("cwd").value, original.cwd);
    // A chosen folder fills the field, and the confirm saves exactly what was picked.
    f.pick("/Users/演示/项目");
    f.button("选择文件夹").click();
    await flush();
    assert.equal(f.picks(), 2);
    assert.equal(f.id("cwd").value, "/Users/演示/项目");
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.deepEqual((f.inputs[0] as { entries: DesktopRuleEntry[] }).entries[0], {
      ...original,
      cwd: "/Users/演示/项目",
    });
    // A fresh add starts empty and the pick is the only way to fill it.
    f.answer(ready(19, [{ ...original, cwd: "/Users/演示/项目" }]));
    await flush();
    f.button("＋ 添加规则").click();
    assert.equal(f.id("cwd").value, "");
    f.pick("/tmp/新目录");
    f.button("选择文件夹").click();
    await flush();
    assert.equal(f.id("cwd").value, "/tmp/新目录");
  }));

test("the picker button stays idle while a save is in flight", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.pick("/新/路径");
    f.button("选择文件夹").click();
    await flush();
    f.form().emit("submit");
    // The confirm is saving; the picker cannot open a second OS dialog over the flight.
    assert.equal(f.button("选择文件夹").disabled, true);
    f.answer(ready(19));
    await flush();
    // The save settled and the editor closed with it: no edit session, no OS dialog. The button
    // waits for the next open, the same lock it held before the form ever appeared.
    assert.equal(f.button("选择文件夹").disabled, true);
  }));

test("the preview states only what the save hands over for the local slots", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const preview = f.find((node) => /\brules-preview\b/.test(node.className));
    // No draft without an edit: the preview only appears while a confirmed change is saving or staged.
    assert.equal(preview.hidden, true);
    f.button("编辑").click();
    assert.equal(preview.hidden, true);
    f.id("name").value = "改动";
    f.form().emit("submit");
    // The confirm sent the PUT; until it settles the preview says what is being handed over.
    assert.equal(preview.hidden, false);
    assert.equal(preview.textContent, `本次保存将提交 1 条本机规则：修改 1 条。`);
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
    assert.equal(preview.textContent, `本次保存将提交 1 条本机规则：修改 1 条。`);
    f.answer(ready(19, [{ ...original, name: "改动" }]));
    await flush();
    assert.equal(preview.hidden, true);
  }));

// Prevent instruction-free non-command tasks and loss of omitted-versus-explicit parallel semantics.
test("non-command requires instructions; omitted parallel survives and draft groups are checked", () =>
  dom(async (f) => {
    f.use("claude");
    f.entries([{ ...original, parallel: undefined }]);
    f.view.init();
    await flush();
    f.button("编辑").click();
    f.id("prompt").value = "";
    f.id("skill").value = "";
    f.form().emit("submit");
    assert.equal(f.editorOpen(), true);
    assert.match(f.text(), /至少填写一项/);
    f.id("prompt").value = "执行任务";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.getState().draft?.entries[0].parallel, undefined);
    f.answer(ready(11, [{ ...original, parallel: undefined, prompt: "执行任务" }]));
    await flush();
    f.button("＋ 添加规则").click();
    for (const [field, value] of [
      ["name", "新增"],
      ["types", "task.new"],
      ["cwd", "/tmp/new"],
      ["prompt", "执行任务"],
      ["group", "组"],
      ["parallel", "1"],
    ])
      f.id(field).value = value;
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    assert.match(f.text(), /留空与填写 1 不同/);
    f.id("parallel").value = "";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 2);
    assert.equal((f.inputs[1] as { entries: DesktopRuleEntry[] }).entries[1].parallel, undefined);
  }));

// Prevent duplicate creation, premature navigation and loss of form input after failed direct saves.
for (const outcome of ["success", "not-sent", "conflict", "uncertain"] as const)
  test(`new rule saves directly and preserves the editor until confirmed: ${outcome}`, () =>
    dom(async (f) => {
      f.view.init();
      await flush();
      f.button("＋ 添加规则").click();
      assert.equal(f.view.editorTitle(), "添加规则");
      assert.equal(f.button("保存规则").disabled, false);
      assert.equal(f.find((node) => node.className.includes("rule-delete")).hidden, true);
      for (const [field, value] of [
        ["name", "新增"],
        ["types", "task.new"],
        ["cwd", "/tmp/new"],
      ])
        f.id(field).value = value;
      f.form().emit("submit");
      assert.equal(f.inputs.length, 1);
      assert.equal(f.editorOpen(), true);
      assert.equal(f.button("保存中…").disabled, true);
      f.form().emit("submit");
      assert.equal(f.inputs.length, 1);
      f.answer(
        outcome === "success"
          ? ready(11)
          : desktopRulesCasPutFailure(
              outcome === "not-sent" ? "unavailable" : outcome,
              outcome === "conflict" ? "rejected" : outcome,
            ),
      );
      await flush();
      assert.equal(f.editorOpen(), outcome !== "success");
      if (outcome !== "success") {
        assert.equal(f.id("name").value, "新增");
        assert.equal(f.id("cwd").value, "/tmp/new");
        if (outcome === "not-sent") {
          f.form().emit("submit");
          assert.equal(f.inputs.length, 2);
          assert.equal((f.inputs[1] as { entries: unknown[] }).entries.length, 2);
        } else {
          f.form().emit("submit");
          assert.equal(f.inputs.length, 1);
          assert.equal(f.find((node) => node.className.includes("rule-recover")).hidden, false);
        }
      }
    }));

// Prevent silent or accidental deletion, and guarantee failed delete retries never remove a second entry.
test("deleting an existing rule requires two-step arming inside edit subpage and retries safely", () =>
  dom(async (f) => {
    const second = { ...original, name: "保留项", types: ["task.keep"], cwd: "/work/keep" };
    f.entries([original, second]);
    f.view.init();
    await flush();
    f.button("编辑").click();
    assert.equal(f.view.editorTitle(), "编辑规则");
    // First click arms deletion without issuing a PUT.
    f.button("删除").click();
    assert.equal(f.inputs.length, 0);
    assert.equal(f.button("确认删除").hidden, false);
    assert.equal(f.button("取消删除").hidden, false);
    // Cancel disarms safely.
    f.button("取消删除").click();
    assert.equal(f.button("删除").hidden, false);
    // Second arm + confirm issues a direct CAS PUT removing only index 0.
    f.button("删除").click();
    f.button("确认删除").click();
    assert.equal(f.inputs.length, 1);
    assert.deepEqual(f.inputs[0], { entries: [second], rulesSeq: 10 });
    assert.equal(f.editorOpen(), true);
    // A not-sent failure keeps the editor open and retrying never deletes the second rule.
    f.answer(desktopRulesCasPutFailure("unavailable", "not-sent"));
    await flush();
    assert.equal(f.editorOpen(), true);
    f.button("删除").click();
    f.button("确认删除").click();
    assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.inputs[1], { entries: [second], rulesSeq: 10 });
    f.answer(ready(12, [second]));
    await flush();
    assert.equal(f.editorOpen(), false);
    assert.equal(f.controller.getState().snapshot?.entries.length, 1);
    assert.equal(f.controller.getState().snapshot?.entries[0].name, "保留项");
  }));

// Prevent header back navigation from leaking an orphan draft onto the list page.
test("closing an unsubmitted editor cleans up its owned draft", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("编辑").click();
    assert.ok(f.controller.getState().draft);
    f.view.closeEditor();
    assert.equal(f.editorOpen(), false);
    assert.equal(f.controller.getState().draft, null);
  }));

// A complete pre-write rejection permits correction, unlike conflict/uncertain review barriers.
test("direct save validation rejection shows reasons and retries without adding twice", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("＋ 添加规则").click();
    for (const [field, value] of [
      ["name", "新增"],
      ["types", "task.new"],
      ["cwd", "/tmp/new"],
    ])
      f.id(field).value = value;
    f.form().emit("submit");
    f.answer({
      version: 3,
      ok: false,
      error: {
        code: "validation",
        outcome: "rejected",
        message: DESKTOP_RULES_CAS_MESSAGES.validation,
        issues: ["规则名重复"],
      },
    });
    await flush();
    assert.equal(f.editorOpen(), true);
    assert.equal(f.controller.getState().needsReview, false);
    assert.match(f.find((node) => node.className === "setup-error").textContent, /规则名重复/);
    f.id("name").value = "新名称";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 2);
    assert.equal((f.inputs[1] as { entries: unknown[] }).entries.length, 2);
  }));

// Prevent cancelling an edit form from dropping a pre-existing external controller draft.
test("cancelling a form preserves an externally seeded controller draft", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.controller.beginEdit();
    f.controller.updateEntry(0, { ...original, name: "第一条修改" });
    const draft = f.controller.getState().draft;
    f.button("编辑").click();
    f.id("name").value = "不要这条修改";
    f.button("取消").click();
    assert.equal(f.controller.getState().draft, draft);
    f.button("保存到本机中台").click();
    assert.equal((f.inputs[0] as { entries: DesktopRuleEntry[] }).entries[0].name, "第一条修改");
  }));

// Prevent notification enum loss or resetting configured folds on background updates.
test("common fields and notification declarations survive independent folds", () =>
  dom(async (f) => {
    f.entries([{ name: "简单", types: ["task.*"], to: "a", cwd: "~/x" }]);
    f.view.init();
    await flush();
    f.button("编辑").click();
    const folds = all(f.body).filter((node) => node.tag === "details");
    assert.deepEqual(
      folds.map((node) => node.open),
      [false, false],
    );
    for (const name of ["prompt", "skill", "tell"])
      assert.equal(
        folds.some((fold) => all(fold).includes(f.id(name))),
        false,
      );
    assert.deepEqual(
      f.id("tell").children.map((node) => node.value),
      ["", "always", "needed", "never"],
    );
    folds[0].open = true;
    f.view.update();
    assert.equal(folds[0].open, true);
    f.button("取消").click();
    f.entries([original]);
    f.controller.refresh();
    await flush();
    f.button("编辑").click();
    assert.deepEqual(
      folds.map((node) => node.open),
      [true, true],
    );
  }));

// Prevent display normalization or long-path clipping from altering copied filesystem data.
test("copy uses the complete original path, not normalized display text", () =>
  dom(async (f) => {
    const path = "/Users/demo/" + "long-directory/".repeat(10) + "folder\r\nname";
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let copied = "";
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copied = text;
          },
        },
      },
    });
    try {
      f.entries([{ ...original, cwd: path }]);
      f.view.init();
      await flush();
      f.button("编辑").click();
      f.button("复制完整路径").click();
      await flush();
      assert.equal(copied, path);
      assert.equal(f.inputs.length, 0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  }));

// Prevent unreadable list rows, dead row clicks, missing empty-state CTA, or broken filter-index mapping.
test("list view supports trigger filtering, whole-row click, friendly labels and empty-state CTA", () =>
  dom(async (f) => {
    const timed = {
      name: "早报",
      cron: "0 9 * * *",
      to: "a",
      cwd: "/work/daily",
      prompt: "写早报",
      tell: "always" as const,
      autoGroup: true,
    };
    const eventRule = {
      name: "修缺陷",
      types: ["task.fix"],
      to: "a",
      cwd: "/work/fix",
      prompt: "修",
      tell: "never" as const,
    };
    f.entries([timed, eventRule]);
    f.view.init();
    await flush();
    const text = f.text();
    // Friendly Chinese labels replace raw enum values and raw cron-only chips.
    assert.ok(text.includes("每天 09:00"));
    assert.ok(text.includes("0 9 * * *"));
    assert.ok(text.includes("通知 总是"));
    assert.ok(text.includes("通知 从不"));
    assert.ok(!text.includes("通知 never"));
    assert.ok(!text.includes("通知 always"));
    assert.ok(text.includes("→ <svg onload=evil>"));
    // Filter toolbar lets the user narrow to event rules and still opens the true original index.
    f.button("事件触发 (1)").click();
    const eventRows = all(f.body).filter((node) => node.className.includes("entry-item"));
    assert.equal(eventRows.length, 1);
    assert.ok(all(eventRows[0]).some((node) => node.textContent === "修缺陷"));
    // Clicking the row body opens the editor for that exact filtered rule (index 1, not 0).
    eventRows[0].click();
    assert.equal(f.editorOpen(), true);
    assert.equal(f.id("name").value, "修缺陷");
    f.button("取消").click();
    assert.equal(f.editorOpen(), false);
    // Filtering to timed rules and clicking add pre-selects timed trigger mode.
    f.button("定时触发 (1)").click();
    f.button("＋ 添加规则").click();
    assert.equal(f.id("trigger").value, "cron");
    f.button("取消").click();
    // Empty list hides filter toolbar and shows an actionable CTA inside the empty card.
    f.entries([]);
    f.controller.refresh();
    await flush();
    const toolbar = f.find((node) => node.className.includes("rules-toolbar"));
    assert.equal(toolbar.hidden, true);
    const empty = f.find((node) => /\brules-empty\b/.test(node.className));
    assert.equal(empty.hidden, false);
    assert.ok(all(empty).some((node) => node.tag === "button" && node.textContent === "＋ 添加第一条规则"));
  }));
