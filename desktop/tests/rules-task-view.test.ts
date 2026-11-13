// Accepted dispatch must return once and erase submitted fields before close can cache them again.
// Prevent wildcard/concrete-type regressions in the production new-task dialog.
// The rule editor's advanced-field preservation lives in rules-cas-view.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("accepted dispatch returns once and close never restores submitted text", () =>
  dom((body) => {
    let returns = 0;
    const drafts: { summary: string; detail: string }[] = [];
    const control = {
      entriesState: { kind: "ready", entries: [{ name: "规则", types: ["task.ops"], to: "a" }] },
      submitState: { kind: "idle" } as unknown,
      operation: null,
      canSubmit: true,
      canBeginAnother: false,
      busy: false,
      reset() {},
      loadEntries() {},
      submitTask() {},
      saveDraft(draft: { summary: string; detail: string }) {
        drafts.push(draft);
      },
      completeAccepted() {
        control.submitState = { kind: "idle" };
      },
    };
    const view = mountTaskDialog(
      control as unknown as Parameters<typeof mountTaskDialog>[0],
      () => {},
      () => {
        returns++;
      },
    );
    view.open();
    id(body, "task-summary").value = "已提交标题";
    id(body, "task-detail").value = "已提交正文";
    control.submitState = { kind: "uncertain", message: "结果不明" };
    view.update();
    assert.equal(returns, 0);
    assert.equal(id(body, "task-detail").value, "已提交正文");
    control.submitState = { kind: "done", result: { event: 1, duplicate: false, routed: ["规则"] } };
    view.update();
    assert.equal(returns, 1);
    assert.equal(id(body, "task-summary").value, "");
    assert.equal(id(body, "task-detail").value, "");
    view.update();
    assert.equal(returns, 1);
    view.close();
    assert.ok(drafts.every((draft) => !draft.summary && !draft.detail));
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
