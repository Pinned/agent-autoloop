/**
 * Safe, zero-dependency Markdown parser and DOM renderer.
 * Strictly uses document.createElement and textContent. Never uses innerHTML or insertAdjacentHTML.
 */

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("#")
  );
}

/**
 * Parses inline formatting: bold, italic, bold-italic, code, strikethrough, links.
 * All nodes are appended directly to target using createElement, avoiding innerHTML.
 */
export function parseInlineMarkdown(text: string, target: HTMLElement): void {
  const pattern =
    /(`[^`]+`|\*\*\*[^*]+\*\*\*|___[^_]+___|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/;

  let remaining = text;
  while (remaining.length > 0) {
    const match = remaining.match(pattern);
    if (!match || match.index === undefined) {
      if (remaining.length > 0) {
        const span = document.createElement("span");
        span.textContent = remaining;
        target.append(span);
      }
      break;
    }

    const before = remaining.slice(0, match.index);
    if (before.length > 0) {
      const span = document.createElement("span");
      span.textContent = before;
      target.append(span);
    }

    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = raw.slice(1, -1);
      target.append(code);
    } else if ((raw.startsWith("***") && raw.endsWith("***")) || (raw.startsWith("___") && raw.endsWith("___"))) {
      const strong = document.createElement("strong");
      const em = document.createElement("em");
      strong.append(em);
      parseInlineMarkdown(raw.slice(3, -3), em);
      target.append(strong);
    } else if ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) {
      const strong = document.createElement("strong");
      parseInlineMarkdown(raw.slice(2, -2), strong);
      target.append(strong);
    } else if ((raw.startsWith("*") && raw.endsWith("*")) || (raw.startsWith("_") && raw.endsWith("_"))) {
      const em = document.createElement("em");
      parseInlineMarkdown(raw.slice(1, -1), em);
      target.append(em);
    } else if (raw.startsWith("~~") && raw.endsWith("~~")) {
      const del = document.createElement("del");
      parseInlineMarkdown(raw.slice(2, -2), del);
      target.append(del);
    } else if (raw.startsWith("[")) {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch && isSafeUrl(linkMatch[2])) {
        const a = document.createElement("a");
        a.setAttribute?.("href", linkMatch[2].trim());
        a.setAttribute?.("target", "_blank");
        a.setAttribute?.("rel", "noopener noreferrer");
        parseInlineMarkdown(linkMatch[1], a);
        target.append(a);
      } else {
        const span = document.createElement("span");
        span.textContent = raw;
        target.append(span);
      }
    }

    remaining = remaining.slice(match.index + raw.length);
  }
}

/**
 * Parses block markdown and returns an HTMLElement container.
 */
export function renderMarkdown(markdown: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "markdown-body";

  if (!markdown || !markdown.trim()) {
    const empty = document.createElement("p");
    empty.className = "muted markdown-empty";
    empty.textContent = "暂无详情内容可预览";
    container.append(empty);
    return container;
  }

  const lines = markdown.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++; // skip closing ```
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.setAttribute?.("data-language", lang);
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = document.createElement(`h${level}`);
      parseInlineMarkdown(headingMatch[2], heading);
      container.append(heading);
      index++;
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      container.append(document.createElement("hr"));
      index++;
      continue;
    }

    // Blockquote
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      for (let i = 0; i < quoteLines.length; i++) {
        if (i > 0) p.append(document.createElement("br"));
        parseInlineMarkdown(quoteLines[i], p);
      }
      bq.append(p);
      container.append(bq);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const itemLine = lines[index].replace(/^\s*[-*+]\s+/, "");
        const li = document.createElement("li");
        const taskMatch = itemLine.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.disabled = true;
          checkbox.checked = taskMatch[1].toLowerCase() === "x";
          li.append(checkbox);
          const space = document.createElement("span");
          space.textContent = " ";
          li.append(space);
          parseInlineMarkdown(taskMatch[2], li);
        } else {
          parseInlineMarkdown(itemLine, li);
        }
        ul.append(li);
        index++;
      }
      container.append(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement("ol");
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const itemLine = lines[index].replace(/^\s*\d+\.\s+/, "");
        const li = document.createElement("li");
        parseInlineMarkdown(itemLine, li);
        ol.append(li);
        index++;
      }
      container.append(ol);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      index++;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !lines[index].match(/^#{1,6}\s+/) &&
      !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[index]) &&
      !lines[index].trim().startsWith(">") &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paraLines.push(lines[index]);
      index++;
    }
    if (paraLines.length > 0) {
      const p = document.createElement("p");
      for (let i = 0; i < paraLines.length; i++) {
        if (i > 0) p.append(document.createElement("br"));
        parseInlineMarkdown(paraLines[i], p);
      }
      container.append(p);
    }
  }

  return container;
}
