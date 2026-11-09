// Prevent close/Escape from cancelling or resending a pending/uncertain task and losing its draft.
// The actual task view/controller run on a bounded memory DOM; no browser, files, timers or process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererTask } from "../src/renderer/task-controller.ts";
import { mountTaskDialog } from "../src/renderer/task-view.ts";
import { DESKTOP_TASK_MESSAGES, type DesktopTaskOutcome } from "../../host/desktop-task-contract.ts";

class MemoryElement {
  tag: string;
  id = ""; className = ""; textContent = ""; value = ""; type = ""; placeholder = "";
  hidden = false; disabled = false; required = false; open = false; rows = 0;
  children: MemoryElement[] = [];
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  constructor(tag: string) { this.tag = tag; }
  append(...children: MemoryElement[]) { this.children.push(...children); }
  replaceChildren(...children: MemoryElement[]) { this.children = children; if (this.tag === "select") this.value = children[0]?.value ?? ""; }
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  emit(name: string) { let prevented = false; for (const callback of this.listeners.get(name) ?? []) callback({ preventDefault() { prevented = true; } }); return prevented; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit("close"); }
  find(predicate: (element: MemoryElement) => boolean): MemoryElement | undefined { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function withView(callback: (f: {
  controller: ReturnType<typeof createRendererTask>;
  panel: ReturnType<typeof mountTaskDialog>;
  body: MemoryElement;
  calls(): number;
  answer(value: DesktopTaskOutcome): void;
  setGate(value: boolean): void;
  createdCalls(): number;
  onCreated(callback: () => void): void;
}) => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new MemoryElement("body");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body, createElement: (tag: string) => new MemoryElement(tag) } });
  try {
    let calls = 0; let eligible = true; let createdCalls = 0; let created = () => {};
    const replies: ((value: DesktopTaskOutcome) => void)[] = [];
    let panel: ReturnType<typeof mountTaskDialog> | undefined;
    const controller = createRendererTask({ taskEntries: async () => ({ version: 2, ok: true, data: { entries: [{ name: "入口", types: ["task.ops"], to: "worker" }] } }), taskCreate: () => { calls++; return new Promise<DesktopTaskOutcome>(resolve => replies.push(resolve)); } }, () => panel?.update(), () => eligible);
    panel = mountTaskDialog(controller, () => { createdCalls++; created(); });
    await callback({ controller, panel, body, calls: () => calls, answer: value => { const resolve = replies.shift(); assert.ok(resolve); resolve(value); }, setGate: (value) => { eligible = value; controller.gateChanged(); }, createdCalls: () => createdCalls, onCreated: callback => { created = callback; } });
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document");
  }
}

test("real view pending close/reopen and Escape preserve draft and single bridge call", async () => {
  await withView(async f => {
    f.panel.open(); await flush();
    const summary = f.body.find(e => e.id === "task-summary")!; const detail = f.body.find(e => e.id === "task-detail")!;
    summary.value = "冻结目标"; detail.value = "保留详情"; f.body.find(e => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1); assert.equal(summary.disabled, true);
    const dialog = f.body.find(e => e.tag === "dialog")!;
    assert.equal(dialog.emit("cancel"), false); dialog.close();
    summary.value = "tampered"; f.panel.open(); assert.equal(f.calls(), 1); assert.equal(summary.value, "冻结目标");
    assert.equal(f.controller.operation?.draft.summary, "冻结目标");
    assert.equal(f.body.find(e => e.textContent === "显式另建一条")!.hidden, true);
    f.answer({ version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain }); await flush();
    dialog.close(); f.panel.open(); f.body.find(e => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1); assert.equal(f.controller.submitState.kind, "uncertain"); assert.equal(f.createdCalls(), 0);
    assert.equal(summary.disabled, true); assert.equal(f.body.find(e => e.textContent === "显式另建一条")!.hidden, true);
  });
});
test("real view gate disables submission and accepted offers explicit another only when eligible", async () => {
  await withView(async f => {
    f.panel.open(); await flush(); f.setGate(false);
    const submit = f.body.find(e => e.type === "submit")!; assert.equal(submit.disabled, true);
    f.body.find(e => e.id === "task-summary")!.value = "目标"; f.body.find(e => e.tag === "form")!.emit("submit"); assert.equal(f.calls(), 0);
    f.setGate(true); f.body.find(e => e.tag === "form")!.emit("submit"); assert.equal(f.calls(), 1);
    f.setGate(false); f.answer({ version: 3, outcome: "accepted", receipt: { version: 2, ok: true, result: { event: 2, duplicate: false, routed: ["入口"] } } }); await flush();
    const another = f.body.find(e => e.textContent === "显式另建一条")!;
    assert.equal(another.hidden, false); assert.equal(another.disabled, true);
    another.emit("click"); assert.ok(f.controller.operation);
    f.setGate(true); another.emit("click"); assert.equal(f.controller.operation, null); await flush();
    assert.equal(f.body.find(e => e.id === "task-summary")!.value, "");
  });
});
test("accepted refresh is exactly once per result even after close/reopen and another accepted", async () => {
  await withView(async f => {
    f.panel.open(); await flush();
    const form = f.body.find(e => e.tag === "form")!;
    const dialog = f.body.find(e => e.tag === "dialog")!;
    const summary = f.body.find(e => e.id === "task-summary")!;
    summary.value = "第一条"; form.emit("submit");
    f.onCreated(() => { f.panel.update(); });
    f.answer({ version: 3, outcome: "accepted", receipt: { version: 2, ok: true, result: { event: 1, duplicate: false, routed: ["入口"] } } }); await flush();
    const first = f.controller.submitState; assert.equal(first.kind, "done"); assert.equal(f.createdCalls(), 1);
    f.panel.update(); f.panel.update(); dialog.close(); f.panel.open(); f.panel.update();
    assert.equal(f.createdCalls(), 1); assert.equal(f.controller.submitState, first); assert.equal(f.calls(), 1);
    f.body.find(e => e.textContent === "显式另建一条")!.emit("click"); await flush();
    summary.value = "第二条"; form.emit("submit"); assert.equal(f.calls(), 2);
    f.answer({ version: 3, outcome: "accepted", receipt: { version: 2, ok: true, result: { event: 2, duplicate: true, routed: ["入口"] } } }); await flush();
    assert.equal(f.createdCalls(), 2); f.panel.update(); dialog.close(); f.panel.open(); assert.equal(f.createdCalls(), 2);
  });
});
test("throwing refresh callback cannot rewrite accepted or repeat on later update", async () => {
  await withView(async f => {
    f.panel.open(); await flush(); f.body.find(e => e.id === "task-summary")!.value = "目标";
    f.onCreated(() => { throw new Error("refresh failed"); }); f.body.find(e => e.tag === "form")!.emit("submit");
    f.answer({ version: 3, outcome: "accepted", receipt: { version: 2, ok: true, result: { event: 3, duplicate: false, routed: ["入口"] } } }); await flush();
    const receipt = f.controller.submitState; assert.equal(receipt.kind, "done"); assert.equal(f.createdCalls(), 1);
    f.panel.update(); f.body.find(e => e.tag === "dialog")!.close(); f.panel.open();
    assert.equal(f.controller.submitState, receipt); assert.equal(f.createdCalls(), 1); assert.equal(f.calls(), 1);
  });
});
