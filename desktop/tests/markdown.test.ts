// Prevent XSS, unsafe URLs, corrupted block structures, and broken inline rendering in Markdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInlineMarkdown, renderMarkdown } from "../src/renderer/markdown.ts";

class TestElement {
  readonly tag: string;
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  type = "";
  className = "";
  attributes = new Map<string, string>();
  children: TestElement[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...children: (TestElement | string)[]) {
    for (const child of children) {
      if (typeof child === "string") {
        const span = new TestElement("span");
        span.textContent = child;
        this.children.push(span);
      } else {
        this.children.push(child);
      }
    }
  }

  replaceChildren(...children: (TestElement | string)[]) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  find(predicate: (e: TestElement) => boolean): TestElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
  }

  findAll(predicate: (e: TestElement) => boolean): TestElement[] {
    const results: TestElement[] = [];
    if (predicate(this)) results.push(this);
    for (const child of this.children) {
      results.push(...child.findAll(predicate));
    }
    return results;
  }
}

function withDOM(fn: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new TestElement("body");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body,
      createElement: (tag: string) => new TestElement(tag),
    },
  });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

const asTest = (el: unknown): TestElement => el as TestElement;

test("empty markdown renders placeholder without throwing", () => {
  withDOM(() => {
    const el = asTest(renderMarkdown(""));
    assert.equal(el.className, "markdown-body");
    const empty = el.find((e: TestElement) => e.className.includes("markdown-empty"));
    assert.ok(empty);
    assert.equal(empty.textContent, "暂无详情内容可预览");
  });
});

test("headings H1 through H3 parse with text and inline formatting", () => {
  withDOM(() => {
    const md = "# 标题一\n## 标题二与**加粗**\n### 标题三与`代码`";
    const el = asTest(renderMarkdown(md));
    const h1 = el.find((e: TestElement) => e.tag === "h1");
    assert.ok(h1);
    const h2 = el.find((e: TestElement) => e.tag === "h2");
    assert.ok(h2);
    assert.ok(h2.find((e: TestElement) => e.tag === "strong"));
    const h3 = el.find((e: TestElement) => e.tag === "h3");
    assert.ok(h3);
    assert.ok(h3.find((e: TestElement) => e.tag === "code"));
  });
});

test("fenced code blocks preserve lines and language metadata", () => {
  withDOM(() => {
    const md = "```typescript\nconst x = 1;\nconst y = 2;\n```";
    const el = asTest(renderMarkdown(md));
    const pre = el.find((e: TestElement) => e.tag === "pre");
    assert.ok(pre);
    const code = pre.find((e: TestElement) => e.tag === "code");
    assert.ok(code);
    assert.equal(code.getAttribute("data-language"), "typescript");
    assert.equal(code.textContent, "const x = 1;\nconst y = 2;");
  });
});

test("blockquotes parse and preserve multi-line content", () => {
  withDOM(() => {
    const md = "> 第一行引用\n> 第二行引用";
    const el = asTest(renderMarkdown(md));
    const bq = el.find((e: TestElement) => e.tag === "blockquote");
    assert.ok(bq);
    const br = bq.find((e: TestElement) => e.tag === "br");
    assert.ok(br);
  });
});

test("lists with task checkboxes and ordered items", () => {
  withDOM(() => {
    const md = "- [ ] 未完成\n- [x] 已完成\n- 常规项\n\n1. 步骤一\n2. 步骤二";
    const el = asTest(renderMarkdown(md));
    const ul = el.find((e: TestElement) => e.tag === "ul");
    assert.ok(ul);
    const checkboxes = ul.findAll((e: TestElement) => e.tag === "input" && e.type === "checkbox");
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[0].checked, false);
    assert.equal(checkboxes[1].checked, true);
    assert.equal(checkboxes[0].disabled, true);

    const ol = el.find((e: TestElement) => e.tag === "ol");
    assert.ok(ol);
    const lis = ol.findAll((e: TestElement) => e.tag === "li");
    assert.equal(lis.length, 2);
  });
});

test("links with safe protocols are anchors, unsafe protocols degrade to text", () => {
  withDOM(() => {
    const md = "[安全链接](https://example.com) 和 [恶意链接](javascript:alert(1))";
    const el = asTest(renderMarkdown(md));
    const links = el.findAll((e: TestElement) => e.tag === "a");
    assert.equal(links.length, 1);
    assert.equal(links[0].getAttribute("href"), "https://example.com");
    assert.equal(links[0].getAttribute("target"), "_blank");
    assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");

    // The javascript: link must NOT be an <a> element
    const allLinks = el.findAll((e: TestElement) => e.tag === "a");
    assert.ok(!allLinks.some((a: TestElement) => (a.getAttribute("href") ?? "").includes("javascript")));
  });
});

test("raw HTML tags are treated strictly as text, never parsed as DOM nodes", () => {
  withDOM(() => {
    const md = "<script>alert('xss')</script> 和 <img src=x onerror=alert(1)>";
    const el = asTest(renderMarkdown(md));
    assert.equal(el.findAll((e: TestElement) => e.tag === "script").length, 0);
    assert.equal(el.findAll((e: TestElement) => e.tag === "img").length, 0);
  });
});

test("inline formatting: bold, italic, bold-italic, code, strikethrough", () => {
  withDOM(() => {
    const host = new TestElement("p");
    parseInlineMarkdown("**加粗** *斜体* ***粗斜*** `代码` ~~删除~~", host as unknown as HTMLElement);
    assert.ok(host.find((e: TestElement) => e.tag === "strong"));
    assert.ok(host.find((e: TestElement) => e.tag === "em"));
    assert.ok(host.find((e: TestElement) => e.tag === "code"));
    assert.ok(host.find((e: TestElement) => e.tag === "del"));
  });
});
