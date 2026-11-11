import assert from "node:assert/strict";
import { test } from "node:test";
import { mountSetupView } from "../src/renderer/setup-view.ts";
import { createRendererSetup, type SetupBridge, type SetupState } from "../src/renderer/setup-controller.ts";
import { desktopSetupFailure, type DesktopJoinInput } from "../../host/desktop-setup-contract.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

class Element {
  className = "";
  id = "";
  type = "";
  value = "";
  disabled = false;
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  private text = "";
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join(" ");
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  prepend(...children: Element[]) {
    this.children.unshift(...children);
  }
  replaceChildren(...children: Element[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name, listener);
  }
  querySelector(selector: string): Element | null {
    return (
      all(this).find((node) =>
        selector.startsWith("#")
          ? node.id === selector.slice(1)
          : selector.startsWith(".")
            ? node.className.split(" ").includes(selector.slice(1))
            : node.tagName === selector,
      ) ?? null
    );
  }
  focus() {}
  fire(name: string) {
    if (!this.disabled) this.listeners.get(name)?.({ preventDefault() {} });
  }
}
function all(root: Element): Element[] {
  return [root, ...root.children.flatMap(all)];
}
function input(root: Element, id: string): Element {
  const result = root.querySelector(`#${id}`);
  assert.ok(result, id);
  return result;
}
function withDocument(action: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => {
        const node = new Element("text");
        node.textContent = text;
        return node;
      },
    },
  });
  try {
    action();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function fixture(step: 1 | 2 = 2) {
  const root = new Element("main");
  const control = {
    state: {
      kind: "wizard",
      step,
      role: "worker",
      draft: { url: "", worker: "" },
      error: null,
    } as SetupState,
    busy: false,
    submitting: false,
    chooseRole() {},
    next() {},
    back() {},
    draft() {
      return true;
    },
    open() {},
    recheck() {},
    complete() {
      return true;
    },
    submit(_key?: string) {
      return true;
    },
  };
  const view = mountSetupView(
    root as unknown as HTMLElement,
    control as unknown as Parameters<typeof mountSetupView>[1],
    () => {},
  );
  return { root, control, view };
}

async function realFixture() {
  const root = new Element("main");
  const joins: DesktopJoinInput[] = [];
  const bridge: SetupBridge = {
    setupStatus: async () => ({
      version: 1,
      operation: "status",
      ok: true,
      data: { configuration: "unconfigured", role: null },
    }),
    joinWorker: (value) => {
      joins.push(value);
      return new Promise(() => {});
    },
    initHub: async () => desktopSetupFailure("init", "operation-failed"),
    launchStatus: async () => desktopSetupFailure("launch-status", "operation-failed"),
    completeSetup: async () => desktopSetupFailure("complete", "operation-failed"),
  };
  let view: ReturnType<typeof mountSetupView>;
  const control = createRendererSetup(bridge, () => withDocument(() => view.render(false)));
  view = mountSetupView(root as unknown as HTMLElement, control, () => {});
  control.open();
  await Promise.resolve();
  await Promise.resolve();
  control.chooseRole("worker");
  control.next();
  return { root, joins, control, view };
}

test("real controller synchronous invalid-key redraw permits a legal retry without extra redraw", async () => {
  const f = await realFixture();
  withDocument(() => {
    input(f.root, "setup-url").value = "https://example.test/hub";
    input(f.root, "setup-worker").value = "machine-1";
    f.root.querySelector("form")!.fire("submit");
  });
  await Promise.resolve();
  await Promise.resolve();
  withDocument(() => {
    assert.equal(f.joins.length, 0, "an incomplete key never reaches the bridge");
    const old = input(f.root, "setup-key");
    old.value = "invalid\nsynthetic-key";
    f.root.querySelector("form")!.fire("submit");
    assert.equal(old.value, "");
    assert.equal(f.joins.length, 0);
    const retry = input(f.root, "setup-key");
    assert.notEqual(old, retry);
    retry.value = "valid-synthetic-key";
    f.root.querySelector("form")!.fire("submit");
    assert.equal(f.joins.length, 1);
    assert.equal(f.joins[0].key, "valid-synthetic-key");
    assert.equal(retry.value, "");
    assert.equal(JSON.stringify(f.control.state).includes("synthetic-key"), false);
  });
});

test("real controller sanitized empty draft never restores credential-bearing URL to DOM", async () => {
  const f = await realFixture();
  withDocument(() => {
    input(f.root, "setup-url").value = "https://user:synthetic-secret@example.test/hub";
    input(f.root, "setup-worker").value = "";
    f.root.querySelector("form")!.fire("submit");
    assert.equal(f.control.state.kind, "wizard");
    if (f.control.state.kind !== "wizard") throw new Error("expected wizard");
    assert.deepEqual(f.control.state.draft, { url: "", worker: "" });
    assert.equal(input(f.root, "setup-url").value, "");
    assert.equal(JSON.stringify(f.control.state).includes("synthetic-secret"), false);
    assert.equal(
      all(f.root).some((node) => node.value.includes("synthetic-secret")),
      false,
    );
  });
});

test("real app setup callback presents failed launch reads with explicit retry and no automatic bridge retry", async () => {
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  const callback = app.slice(
    app.indexOf("() => {", app.indexOf("const setup = createRendererSetup")),
    app.indexOf("\n// The automation page"),
  );
  for (const code of ["busy", "unavailable", "operation-failed", "unknown"] as const) {
    let calls = 0,
      mounts = 0;
    const root = new Element("main");
    const bridge: SetupBridge = {
      launchStatus: async () => {
        calls++;
        return desktopSetupFailure("launch-status", code);
      },
      setupStatus: async () => {
        throw new Error("unexpected status retry");
      },
      initHub: async () => {
        throw new Error("unexpected init");
      },
      joinWorker: async () => {
        throw new Error("unexpected join");
      },
      completeSetup: async () => {
        throw new Error("unexpected complete");
      },
    };
    const context: Record<string, unknown> = {
      main: root,
      initialSetupPresented: false,
      setupView: undefined,
      navigation: { querySelectorAll: () => [] },
      // The real callback re-projects the navigation on every setup change; the stub keeps that
      // path inert so this test observes only the setup read, never the page shell.
      currentRole: () => null,
      syncNavigation: () => {},
      navigationDisabled: false,
      // The shell projection decides whether a page may be drawn; the stub mirrors the rule the
      // real callback applies so this test stays about the setup read.
      shellMode: () => "setup",
      applyShell: () => {},
      document: { querySelector: () => ({ textContent: "", hidden: true }) },
      mountSetupPage: () => {
        mounts++;
        return mountSetupView(root as unknown as HTMLElement, context.setup as ReturnType<typeof createRendererSetup>, () => {});
      },
      render: () => {},
      currentPage: "today",
      run: { refresh() {} },
      // The real callback re-gates the new-task dialog on every setup change; the stub keeps
      // that path inert so this test observes only the setup read, never a task side effect.
      taskControl: { gateChanged() {} },
    };
    const notify = runInNewContext(
      stripTypeScriptTypes(`(${callback.slice(0, callback.lastIndexOf("});"))}})`),
      context,
    ) as () => void;
    const control = createRendererSetup(bridge, () => withDocument(notify));
    context.setup = control;
    control.bootstrap();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(mounts, 1, code);
    assert.equal(calls, 1);
    assert.equal(control.launch, null);
    if (code === "unknown") assert.match(root.textContent, /锁定.*人工检查/);
    else {
      assert.match(root.textContent, /重新核查本机状态/);
      withDocument(() =>
        all(root)
          .find((node) => node.tagName === "button" && node.textContent === "重新核查本机状态")!
          .fire("click"),
      );
      assert.equal(calls, 2);
    }
  }
});

test("setup uses Chinese execution-machine role terminology and states that saving requires a connection", () =>
  withDocument(() => {
    const f = fixture(1);
    f.view.render();
    assert.match(f.root.textContent, /中台＋执行机/);
    assert.match(f.root.textContent, /执行机/);
    assert.doesNotMatch(f.root.textContent, /worker|AUTOLOOP/);
    f.control.state = { ...f.control.state, step: 2 } as SetupState;
    f.view.render();
    assert.match(f.root.textContent, /连接成功才会保存/);
    assert.match(f.root.textContent, /保存不会启动/);
    assert.doesNotMatch(f.root.textContent, /安装检查/);
  }));

test("ordinary setup redraw preserves unsent non-secret fields without retaining them in controller state", () =>
  withDocument(() => {
    const f = fixture();
    f.view.render();
    input(f.root, "setup-url").value = "https://example.test/hub";
    input(f.root, "setup-worker").value = "machine-1";
    f.view.render(false);
    assert.equal(input(f.root, "setup-url").value, "https://example.test/hub");
    assert.equal(input(f.root, "setup-worker").value, "machine-1");
    assert.equal(JSON.stringify(f.control.state).includes("example.test"), false);
  }));

test("saved configuration and explicit first completion have separate truthful view actions", () =>
  withDocument(() => {
    const f = fixture();
    f.control.state = { kind: "prepared", mode: "embedded" };
    let completions = 0;
    f.control.complete = () => {
      completions++;
      return true;
    };
    f.view.render();
    assert.match(f.root.textContent, /配置已保存.*尚未.*启动/);
    assert.match(f.root.textContent, /原任务与记录.*不会自动迁移/);
    assert.equal(completions, 0);
    const complete = all(f.root).find(
      (node) => node.tagName === "button" && node.textContent === "完成首次配置并请求启动",
    );
    assert.ok(complete);
    complete.fire("click");
    assert.equal(completions, 1);
    f.control.state = { kind: "completed", mode: "worker" };
    f.view.render();
    assert.match(f.root.textContent, /已请求启动.*实际是否运行/);
    assert.doesNotMatch(f.root.textContent, /启动成功|已登录|已连接中台/);
  }));

test("controller validation overrides unsent fields, step changes do not restore stale input", () =>
  withDocument(() => {
    const f = fixture();
    f.view.render();
    input(f.root, "setup-url").value = "https://example.test/hub";
    input(f.root, "setup-worker").value = "machine-1";
    f.control.state = { ...f.control.state, draft: { url: "https://validated.test", worker: "fixed-1" } } as SetupState;
    f.view.render(false);
    assert.equal(input(f.root, "setup-url").value, "https://validated.test");
    f.control.state = { ...f.control.state, step: 1 } as SetupState;
    f.view.render(false);
    f.control.state = { ...f.control.state, step: 2, draft: { url: "", worker: "" } } as SetupState;
    f.view.render(false);
    assert.equal(input(f.root, "setup-url").value, "");
  }));

test("the setup page offers a way out only when there is a workspace to return to", () =>
  withDocument(() => {
    // No workspace yet: dismissing would strand the user on an empty window, so the only honest
    // exit is the app's own quit, which keeps its confirmation and its runtime drain.
    const first = fixture(1);
    let exits = 0;
    let closes = 0;
    const locked = mountSetupView(
      first.root as unknown as HTMLElement,
      first.control as unknown as Parameters<typeof mountSetupView>[1],
      () => closes++,
      { canDismiss: () => false, exit: () => exits++ },
    );
    locked.render();
    const quit = all(first.root).find((node) => node.tagName === "button" && node.textContent === "退出应用…");
    assert.ok(quit);
    assert.equal(all(first.root).some((node) => node.textContent === "暂不配置"), false);
    quit.fire("click");
    assert.equal(exits, 1);
    assert.equal(closes, 0);

    // A workspace exists (re-entered from settings, or a first run that just completed): leaving is
    // normal and must not quit the app.
    const second = fixture(1);
    let closesAgain = 0;
    let exitsAgain = 0;
    const open = mountSetupView(
      second.root as unknown as HTMLElement,
      second.control as unknown as Parameters<typeof mountSetupView>[1],
      () => closesAgain++,
      { canDismiss: () => true, exit: () => exitsAgain++ },
    );
    open.render();
    const back = all(second.root).find((node) => node.tagName === "button" && node.textContent === "暂不配置");
    assert.ok(back);
    back.fire("click");
    assert.equal(closesAgain, 1);
    assert.equal(exitsAgain, 0);
  }));

test("app wires one inert singleton bootstrap; launch status precedes automatic wizard and legacy has no start call", () => {
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  assert.equal((app.match(/createRendererSetup\(/g) ?? []).length, 1);
  assert.equal((app.match(/setup\.bootstrap\(\)/g) ?? []).length, 1);
  assert.match(app, /!initialSetupPresented &&/);
  assert.match(
    app,
    /!setup\.launch && \(setup\.state\.kind === "blocked" \|\| setup\.state\.kind === "unknown-locked"\)/,
  );
  assert.match(app, /setup\.state\.kind !== "reading-status" &&\s*setup\.state\.kind !== "reading-launch"/);
  assert.match(app, /initialSetupPresented = true;[\s\S]*?setupView\.render\(\)/);
  assert.match(app, /completion === "legacy"/);
  // The shell decision and the setup page's one exit are wired in the same place.
  assert.match(app, /const mode = shellMode\(setup\.launch, setup\.state\.kind\);/);
  assert.match(app, /canDismiss: \(\) => shell === "workspace"/);
  assert.doesNotMatch(app, /runtimeStart\(|completeSetup\(|initHub\(|joinWorker\(/);
});

test("secret controls are cleared on redraw, submission and disposal including detached nodes", () =>
  withDocument(() => {
    const f = fixture(2);
    f.view.render();
    const first = input(f.root, "setup-key");
    first.value = "synthetic-only-key";
    f.view.render(false);
    assert.equal(first.value, "");
    const second = input(f.root, "setup-key");
    second.value = "synthetic-only-key";
    let handed = "";
    f.control.submit = (key) => {
      handed = key ?? "";
      return true;
    };
    f.root.querySelector("form")!.fire("submit");
    assert.equal(handed, "synthetic-only-key");
    assert.equal(second.value, "");
    f.view.render();
    const third = input(f.root, "setup-key");
    third.value = "synthetic-only-key";
    f.view.dispose();
    assert.equal(third.value, "");
    assert.equal(JSON.stringify(f.control.state).includes("synthetic-only-key"), false);
  }));
