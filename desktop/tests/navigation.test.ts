// The role → page projection is the product rule the prototype fixes: a pure worker sees this
// machine's work, this machine's environment, and the connection — never a workspace it cannot
// speak for. An unknown role resolves to the full workspace, because claiming a role the process
// has not confirmed would show the wrong pages to an owner. Whether a menu may be shown at all is a
// separate question decided by the launch record (see shell-mode.test.ts): an unconfigured machine
// never reaches this projection's output, so "unknown role, full workspace" cannot leak a menu.
import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationSignature, ownerPages, pagesFor, workerPages } from "../src/renderer/navigation.ts";

test("an unresolved role projects the full workspace, which only a configured machine may see", () => {
  assert.deepEqual(
    pagesFor(null).map((page) => page.nav),
    ["今天", "任务", "规则", "执行机", "设置"],
  );
  assert.equal(pagesFor(null), ownerPages);
});

test("an owner machine keeps the full workspace too", () => {
  assert.equal(pagesFor("hub-worker"), ownerPages);
  assert.deepEqual(
    pagesFor("hub-worker").map((page) => page.id),
    ["today", "tasks", "automation", "workers", "settings"],
  );
});

test("a pure worker is offered only this machine's three pages", () => {
  assert.equal(pagesFor("worker"), workerPages);
  assert.deepEqual(
    pagesFor("worker").map((page) => page.nav),
    ["本机任务", "本机环境", "连接与设置"],
  );
  // The ids stay the same, so a controller mounted for one role keeps working in the other.
  assert.deepEqual(
    pagesFor("worker").map((page) => page.id),
    ["tasks", "workers", "settings"],
  );
  for (const hidden of ["today", "automation"])
    assert.equal(
      pagesFor("worker").some((page) => page.id === hidden),
      false,
    );
});

test("worker copy never promises hub-side powers", () => {
  const worker = pagesFor("worker");
  assert.match(worker.find((page) => page.id === "tasks")!.description, /不可创建或管理全局任务/);
  assert.match(worker.find((page) => page.id === "workers")!.description, /不展示其他执行机/);
  assert.doesNotMatch(worker.map((page) => page.description).join(" "), /新建任务/);
});

test("identity follows the role and nothing else", () => {
  assert.equal(navigationSignature(null), navigationSignature("hub-worker"));
  assert.notEqual(navigationSignature("worker"), navigationSignature(null));
});

test("every page the projection can return has a title and an icon key", () => {
  for (const page of [...ownerPages, ...workerPages]) {
    assert.ok(page.title.length > 0, page.id);
    assert.ok(page.icon.length > 0, page.id);
    assert.ok(page.description.length > 0, page.id);
  }
});
