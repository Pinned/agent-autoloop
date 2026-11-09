// Prevent loss of advanced rule fields and wildcard/concrete-type regressions in production views.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountRulesView } from "../src/renderer/rules-view.ts";
import { mountTaskDialog } from "../src/renderer/task-view.ts";

// A small DOM double exercises production event handlers, without Electron or any service.
class Element {
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  required = false;
  type = "";
  textContent = "";
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  classList = { toggle() {} };
  private given: string | undefined;
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  get value(): string {
    return this.given ?? (this.tag === "select" ? (this.children[0]?.value ?? "") : "");
  }
  set value(value: string) {
    this.given = value;
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    this.given = undefined;
  }
  setAttribute() {}
  querySelector(tag: string): Element | null {
    return all(this).find((node) => node !== this && node.tag === tag) ?? null;
  }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name, listener);
  }
  emit(name: string) {
    this.listeners.get(name)?.({ preventDefault() {} });
  }
  close() {
    this.emit("close");
  }
  showModal() {}
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
function dom(run: (body: Element) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new Element("body");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, createElement: (tag: string) => new Element(tag) },
  });
  try {
    run(body);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function id(body: Element, name: string): Element {
  const found = all(body).find((node) => node.id === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

test("the full rule form preserves every advanced field, then explicitly clears them", () =>
  dom((body) => {
    const original = {
      name: "旧名",
      types: ["task.*"],
      to: "a1",
      cwd: "~/x",
      prompt: "提示",
      skill: "技能",
      parallel: 2,
      group: "旧名",
      tell: "never",
      emits: { source: "app", types: ["result.*"] },
    };
    let updated: Record<string, unknown> | undefined;
    const control = {
      loadState: { kind: "ready", data: { entries: [original], agents: [], seq: 0 } },
      saveState: { kind: "idle" },
      draft: [original],
      busy: false,
      refresh() {},
      beginEdit() {},
      save() {},
      cancelEdit() {},
      removeEntry() {},
      addEntry() {},
      updateEntry(_index: number, raw: Record<string, unknown>) {
        updated = raw;
      },
    };
    const view = mountRulesView(control as unknown as Parameters<typeof mountRulesView>[0]);
    body.append(view.root as unknown as Element);
    view.update();
    all(body)
      .find((node) => node.tag === "button" && node.textContent === "编辑")!
      .emit("click");
    assert.equal(id(body, "rules-group").value, "旧名");
    assert.equal(id(body, "rules-tell").value, "never");
    assert.equal(id(body, "rules-emits-source").value, "app");
    assert.equal(id(body, "rules-emits-types").value, "result.*");
    id(body, "rules-name").value = "新名";
    const form = all(body).find((node) => node.tag === "form")!;
    form.emit("submit");
    assert.deepEqual(updated, { ...original, name: "新名" });
    for (const name of ["prompt", "skill", "parallel", "group", "tell", "emits-source", "emits-types"])
      id(body, `rules-${name}`).value = "";
    form.emit("submit");
    assert.deepEqual(updated, {
      name: "新名",
      types: ["task.*"],
      to: "a1",
      cwd: "~/x",
      prompt: "",
      skill: "",
      group: "",
      tell: "",
    });
  }));

test("a wildcard needs a matching concrete type, preserves selection on refresh and never guesses a suffix", () =>
  dom((body) => {
    const calls: unknown[] = [];
    const control = {
      entriesState: {
        kind: "ready",
        entries: [
          { name: "普通", types: ["plain"], to: "a" },
          { name: "通配", types: ["task.*", "*"], to: "a" },
        ],
      },
      submitState: { kind: "idle" },
      operation: null,
      canSubmit: true,
      canBeginAnother: false,
      busy: false,
      reset() {},
      loadEntries() {},
      submitTask(input: unknown) {
        calls.push(input);
      },
    };
    const view = mountTaskDialog(control as unknown as Parameters<typeof mountTaskDialog>[0], () => {});
    view.open();
    id(body, "task-entry").value = "通配";
    id(body, "task-entry").emit("change");
    assert.equal(id(body, "task-concrete-type").hidden, false);
    assert.equal(id(body, "task-concrete-type").value, "");
    id(body, "task-summary").value = "目标";
    const form = all(body).find((node) => node.tag === "form")!;
    form.emit("submit");
    assert.deepEqual(calls, []);
    id(body, "task-concrete-type").value = "other.type";
    form.emit("submit");
    assert.deepEqual(calls, []);
    id(body, "task-concrete-type").value = "task.release";
    view.update();
    assert.equal(id(body, "task-entry").value, "通配");
    assert.equal(id(body, "task-type").value, "task.*");
    form.emit("submit");
    assert.deepEqual(calls, [{ type: "task.release", summary: "目标", detail: "" }]);
    id(body, "task-type").value = "*";
    id(body, "task-type").emit("change");
    id(body, "task-concrete-type").value = "any.event";
    form.emit("submit");
    assert.deepEqual(calls.at(-1), { type: "any.event", summary: "目标", detail: "" });
  }));
