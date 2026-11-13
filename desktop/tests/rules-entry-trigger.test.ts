// The automation page's entry editor offers two trigger kinds: an event entry (types) and a timed
// entry (cron). The form must switch what it asks for — one field set visible at a time — and the
// read must send exactly the trigger the form shows: a timed entry carries cron and no types, an
// event entry carries types and no cron. The list row shows the cron in plain view instead of an
// empty type-chip strip, and the identity comparison counts cron so a cron edit is a real change.
// Failure modes: a form that sends both triggers or neither; a timed row rendered with no trigger
// at all; a cron edit that compares as "unchanged" and silently saves nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
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
const timedEntry = { name: "早报", cron: "0 9 * * *", to: "a", cwd: "~/x", prompt: "写。" } as const;
const eventEntry = { name: "修复", types: ["task.fix"], to: "a", cwd: "~/x" } as const;
const ready = (entries: readonly unknown[]) => ({
  version: 3,
  ok: true,
  data: { entries, agents: [{ id: "a", name: "甲", use: "edit" }], seq: 5, rulesSeq: 10 },
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
  const controller = createRendererRulesCas({
    rulesGet: () => Promise.resolve(ready([timedEntry, eventEntry])),
    rulesPut(input) {
      inputs.push(input);
      return Promise.resolve(ready(input.entries));
    },
  });
  const view = mountRulesCasView(controller);
  body.append(view.root as unknown as Element);
  const find = (predicate: (node: Element) => boolean) => {
    const node = all(body).find(predicate);
    assert.ok(node);
    return node;
  };
  return {
    body,
    controller,
    view,
    inputs,
    button: (text: string) => find((node) => node.tag === "button" && node.textContent === text),
    id: (name: string) => find((node) => node.id === `rules-${name}`),
    find,
    form: () => find((node) => node.tag === "form"),
    text: () =>
      all(body)
        .map((node) => node.textContent)
        .join("\n"),
  };
}

test("editing a timed entry shows the cron, saves it, and never sends types", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    // The first row is the timed one; its row shows the cron where event rows show type chips.
    const rows = all(f.body).filter((node) => node.className.includes("entry-item"));
    assert.ok(rows[0].children.length > 0);
    assert.ok(f.text().includes("0 9 * * *"));
    // The editor of a timed entry starts in the timed mode with the cron bound.
    const editButtons = all(f.body).filter((node) => node.tag === "button" && node.textContent === "编辑");
    editButtons[0].click();
    assert.equal(f.id("cron").value, "0 9 * * *");
    f.id("cron").value = "30 8 * * *";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    const saved = (f.inputs[0] as { entries: unknown[] }).entries[0] as Record<string, unknown>;
    assert.equal(saved.cron, "30 8 * * *");
    assert.equal(saved.types, undefined);
  }));

test("a new entry can be timed: the switch asks for a cron instead of types", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    f.button("＋ 添加规则").click();
    // The form starts as an event entry; switching the trigger kind asks for the cron instead.
    const trigger = f.id("trigger");
    trigger.value = "cron";
    trigger.emit("change");
    f.id("name").value = "巡检";
    f.id("to").value = "a";
    f.id("cwd").value = "~/y";
    f.id("cron").value = "*/5 * * * *";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
    const added = (f.inputs[0] as { entries: unknown[] }).entries.at(-1) as Record<string, unknown>;
    assert.equal(added.cron, "*/5 * * * *");
    assert.equal(added.types, undefined);
  }));

test("an unchanged timed entry saves nothing; a cron-only change is a real change", () =>
  dom(async (f) => {
    f.view.init();
    await flush();
    const editButtons = all(f.body).filter((node) => node.tag === "button" && node.textContent === "编辑");
    editButtons[0].click();
    f.form().emit("submit");
    assert.equal(f.inputs.length, 0);
    editButtons[0].click();
    f.id("cron").value = "15 9 * * *";
    f.form().emit("submit");
    assert.equal(f.inputs.length, 1);
  }));
