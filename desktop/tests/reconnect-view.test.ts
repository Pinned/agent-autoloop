// The reconnect page only exists to say one true thing: this app is attached to a hub a terminal
// owns, and that hub is not answering. These cases pin what it may promise — a fixed command, a copy
// that goes through the main process, and nothing else unless its action really exists.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mountReconnectView } from "../src/renderer/reconnect-view.ts";
import { LAUNCH_COMMAND } from "../src/launch-command.ts";

class Element {
  className = "";
  id = "";
  type = "";
  disabled = false;
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
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
  replaceChildren(...children: Element[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  querySelector(selector: string): Element | null {
    return (
      all(this).find((node) =>
        selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) : node.tagName === selector,
      ) ?? null
    );
  }
  focus() {}
  fire(name: string) {
    if (!this.disabled) this.listeners.get(name)?.();
  }
}
function all(root: Element): Element[] {
  return [root, ...root.children.flatMap(all)];
}
function buttons(root: Element): string[] {
  return all(root)
    .filter((node) => node.tagName === "button")
    .map((node) => node.textContent);
}
function withDocument(action: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new Element(tag) },
  });
  try {
    action();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
/** Let a copy promise settle before asserting on what the page says about it. */
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

test("the page names the one documented command, not a paraphrase of it", () => {
  assert.equal(LAUNCH_COMMAND, "agent-autoloop up");
  withDocument(() => {
    const root = new Element("main");
    mountReconnectView(root as unknown as HTMLElement);
    assert.match(root.textContent, /agent-autoloop up/);
    // The command lives in one place: main writes the very same constant to the clipboard.
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /clipboard\.writeText\(LAUNCH_COMMAND\)/);
    assert.doesNotMatch(main, /writeText\(["'`]/);
  });
});

test("only the actions that exist are drawn; a copy button needs a copy action", () => {
  withDocument(() => {
    const withoutCopy = new Element("main");
    mountReconnectView(withoutCopy as unknown as HTMLElement, { exit: () => {} });
    assert.deepEqual(buttons(withoutCopy), ["退出应用…"]);
    assert.doesNotMatch(withoutCopy.textContent, /复制命令/);

    const full = new Element("main");
    mountReconnectView(full as unknown as HTMLElement, {
      copy: async () => {},
      reconnect: () => {},
      useEmbedded: () => {},
      exit: () => {},
    });
    assert.deepEqual(buttons(full), ["复制命令", "已启动，重连", "使用 App 内置", "退出应用…"]);

    // No action at all leaves no action row behind: an empty flex row is a visible gap promising
    // controls that were deliberately not drawn.
    const bare = new Element("main");
    mountReconnectView(bare as unknown as HTMLElement);
    assert.equal(all(bare).some((node) => node.className.split(" ").includes("setup-actions")), false);
  });
});

test("copy reports success and failure, and disables itself only while the write is in flight", async () => {
  let release!: () => void;
  let attempts = 0;
  withDocument(() => {
    const root = new Element("main");
    mountReconnectView(root as unknown as HTMLElement, {
      copy: () => {
        attempts++;
        return new Promise<void>((resolve, reject) => {
          release = () => (attempts === 1 ? resolve() : reject(new Error("clipboard")));
        });
      },
    });
    const copy = all(root).find((node) => node.tagName === "button")!;
    copy.fire("click");
    assert.equal(copy.disabled, true, "a second click must not stack a second write");
    assert.match(root.textContent, /正在复制/);
    copy.fire("click");
    assert.equal(attempts, 1);
    release();
    return (async () => {
      await settle();
      assert.equal(copy.disabled, false);
      assert.match(root.textContent, /已复制/);
      copy.fire("click");
      release();
      await settle();
      assert.match(root.textContent, /复制失败/);
    })();
  });
  await settle();
});

test("the command reads as one line of shell, not as prose", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = css.slice(css.indexOf(".reconnect-command code {"));
  assert.ok(rule.length > 0, "the command block must have its own rule");
  const body = rule.slice(0, rule.indexOf("}"));
  // Monospace is what makes a command look like something to paste rather than to read.
  assert.match(body, /font-family:\s*var\(--mono\)/);
  // A failed copy is not a dead end: the text must stay selectable by hand.
  assert.match(body, /user-select:\s*text/);
  // Long paths and flags wrap instead of scrolling the panel sideways.
  assert.match(body, /overflow-wrap:\s*anywhere/);
});

test("the page never promises start, stop or an automatic mode switch", () => {
  const source = readFileSync(new URL("../src/renderer/reconnect-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(source, /runtimeStart|runtimeStop/);
  // A disconnect is repaired by the same endpoint; switching to the embedded hub is a user choice.
  assert.match(source, /不会改用应用内置中台/);
  withDocument(() => {
    const root = new Element("main");
    mountReconnectView(root as unknown as HTMLElement);
    assert.doesNotMatch(root.textContent, /启动运行服务|停止本机运行服务/);
  });
});
