import { DESKTOP_TASK_MESSAGES, DESKTOP_TASK_TYPE_PATTERN } from "../../../host/desktop-task-contract.ts";
import type { DesktopTaskInput } from "../../../host/desktop-task-contract.ts";
import type { createRendererTask } from "./task-controller.ts";
import { renderMarkdown } from "./markdown.ts";

/**
 * The task dispatch subpage view: a panel whose fields are built once with createElement and only
 * ever updated by value — no markup injection anywhere. Entry choice comes from the hub's real
 * rule entries, so a task is never offered a type nothing will take.
 */
export function mountTaskView(
  controller: ReturnType<typeof createRendererTask>,
  onCreated: () => void,
  onBack?: () => void,
): {
  root: HTMLElement;
  open(): void;
  update(): void;
  close(): void;
  syncDraft(): void;
} {
  const root = document.createElement("section");
  root.className = "task-panel task-subpage-panel";
  root.id = "task-subpage";
  root.hidden = true;

  const form = document.createElement("form");
  form.className = "task-form";

  // Title and route controls share a single focus-within bar so routing stays visible without
  // taking a separate form row away from the editor viewport.
  const titleRouteBar = document.createElement("div");
  titleRouteBar.className = "task-title-route-bar";

  const summaryField = document.createElement("label");
  summaryField.className = "task-summary-field";
  const summaryLabel = document.createElement("span");
  summaryLabel.className = "task-summary-label";
  summaryLabel.textContent = "任务标题";
  const summaryInput = document.createElement("input");
  summaryInput.id = "task-summary";
  summaryInput.placeholder = "一句话概括任务目标，例如：排查线上支付超时并输出修复方案";
  summaryInput.required = true;
  summaryField.append(summaryLabel, summaryInput);

  const headerSep = document.createElement("span");
  headerSep.className = "task-header-sep";
  headerSep.setAttribute("aria-hidden", "true");

  const routeControls = document.createElement("div");
  routeControls.className = "task-route-controls";

  const entryField = document.createElement("label");
  entryField.className = "task-route-field";
  const entryLabel = document.createElement("span");
  entryLabel.className = "task-route-label";
  entryLabel.textContent = "入口";
  const entrySelect = document.createElement("select");
  entrySelect.id = "task-entry";
  entryField.append(entryLabel, entrySelect);

  const routeDivider = document.createElement("span");
  routeDivider.className = "task-route-divider";
  routeDivider.setAttribute("aria-hidden", "true");
  routeDivider.textContent = "/";

  const typeField = document.createElement("label");
  typeField.className = "task-route-field";
  const typeLabel = document.createElement("span");
  typeLabel.className = "task-route-label";
  typeLabel.textContent = "类型";
  const typeSelect = document.createElement("select");
  typeSelect.id = "task-type";
  const concreteInput = document.createElement("input");
  concreteInput.id = "task-concrete-type";
  concreteInput.className = "task-concrete-input";
  concreteInput.placeholder = "具体类型，如 task.release";
  typeField.append(typeLabel, typeSelect, concreteInput);

  const routeSummary = document.createElement("span");
  routeSummary.id = "task-route-summary";
  routeSummary.className = "task-route-summary";
  routeSummary.textContent = "正在读取可用入口……";

  routeControls.append(entryField, routeDivider, typeField, routeSummary);
  titleRouteBar.append(summaryField, headerSep, routeControls);

  const needsConcrete = () => typeSelect.value.includes("*");
  function updateRouteSummary() {
    const state = controller.entriesState;
    if (state.kind !== "ready" || state.entries.length === 0) {
      routeSummary.textContent = state.kind === "loading" ? "正在读取可用入口……" : "暂无可用入口";
      return;
    }
    const currentEntry = state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0];
    const activeType = needsConcrete()
      ? concreteInput.value.trim() || typeSelect.value
      : typeSelect.value || currentEntry.types[0] || "";
    routeSummary.textContent = `${currentEntry.name} → ${currentEntry.to}${activeType ? ` · ${activeType}` : ""}`;
  }

  function updateConcrete() {
    concreteInput.hidden = !needsConcrete();
    concreteInput.required = needsConcrete();
    updateRouteSummary();
  }

  const composeSection = document.createElement("div");
  composeSection.className = "task-compose-section";

  const detailField = document.createElement("div");
  detailField.className = "task-detail-field";

  const editorBox = document.createElement("div");
  editorBox.className = "task-editor-box task-wysiwyg-box";

  const detailHeader = document.createElement("div");
  detailHeader.className = "task-detail-header";
  const detailLabelGroup = document.createElement("div");
  detailLabelGroup.className = "task-detail-label-group";
  const detailLabel = document.createElement("span");
  detailLabel.className = "task-detail-label";
  detailLabel.textContent = "任务详情";
  const detailBadge = document.createElement("span");
  detailBadge.className = "task-md-badge";
  detailBadge.textContent = "Markdown · 所见即所得";
  detailLabelGroup.append(detailLabel, detailBadge);

  const toolsGroup = document.createElement("div");
  toolsGroup.className = "task-md-tools";

  // Backing textarea (#task-detail) holds the canonical full Markdown text for form submission & tests
  const detailInput = document.createElement("textarea");
  detailInput.id = "task-detail";
  detailInput.className = "task-detail-backing";
  detailInput.rows = 1;
  detailInput.setAttribute("aria-hidden", "true");
  detailInput.setAttribute("tabindex", "-1");

  const previewContainer = document.createElement("div");
  previewContainer.id = "task-detail-preview";
  previewContainer.className = "task-markdown-preview task-wysiwyg-canvas";

  // Persistent child slots inside previewContainer so activeEditor is never detached from the DOM
  // during line transitions (detaching a focused textarea in Chromium fires a synchronous blur event).
  const beforeWrap = document.createElement("div");
  beforeWrap.className = "task-wysiwyg-slice task-wysiwyg-before";

  const activeEditor = document.createElement("textarea");
  activeEditor.className = "task-wysiwyg-active-input";
  activeEditor.rows = 1;
  activeEditor.placeholder =
    "直接输入内容，支持 Markdown 实时排版（如 # 标题、- 列表、- [ ] 待办、**粗体**、``` 代码块），回车即刻渲染……";

  const afterWrap = document.createElement("div");
  afterWrap.className = "task-wysiwyg-slice task-wysiwyg-after";

  const tail = document.createElement("div");
  tail.className = "task-wysiwyg-tail";

  previewContainer.append(beforeWrap, activeEditor, afterWrap, tail);

  let activeLine: number | null = 0;
  let fullSelectMode = false;
  let isTransitioning = false;

  interface EditableUnit {
    startLine: number;
    endLine: number;
    text: string;
    isCode: boolean;
  }

  function buildUnits(lines: string[]): EditableUnit[] {
    const units: EditableUnit[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim().startsWith("```")) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim().startsWith("```")) {
          j++;
        }
        const end = j < lines.length ? j : lines.length - 1;
        units.push({
          startLine: i,
          endLine: end,
          text: lines.slice(i, end + 1).join("\n"),
          isCode: true,
        });
        i = end + 1;
      } else {
        units.push({
          startLine: i,
          endLine: i,
          text: lines[i],
          isCode: false,
        });
        i++;
      }
    }
    if (units.length === 0) {
      units.push({ startLine: 0, endLine: 0, text: "", isCode: false });
    }
    return units;
  }

  function findUnitForLine(units: EditableUnit[], lineIdx: number): EditableUnit {
    const clamped = Math.max(0, lineIdx);
    for (const unit of units) {
      if (clamped >= unit.startLine && clamped <= unit.endLine) return unit;
    }
    return units[units.length - 1];
  }

  function detectBlockType(text: string): string {
    const firstLine = text.split("\n")[0] ?? "";
    if (/^#\s+/.test(firstLine)) return "h1";
    if (/^##\s+/.test(firstLine)) return "h2";
    if (/^###\s+/.test(firstLine)) return "h3";
    if (/^#{4,6}\s+/.test(firstLine)) return "h4";
    if (firstLine.trim().startsWith("```")) return "code";
    if (firstLine.trim().startsWith(">")) return "quote";
    if (/^\s*([-*+]\s+|\d+\.\s+)/.test(firstLine)) return "list";
    return "p";
  }

  function syncActiveEditorAppearance() {
    const lineCount = Math.max(1, activeEditor.value.split("\n").length);
    activeEditor.rows = lineCount;
    activeEditor.setAttribute("data-block-type", detectBlockType(activeEditor.value));
    if (activeEditor.style) {
      activeEditor.style.height = "auto";
      if (typeof activeEditor.scrollHeight === "number" && activeEditor.scrollHeight > 0) {
        activeEditor.style.height = `${activeEditor.scrollHeight}px`;
      }
    }
  }

  interface RenderSegment {
    startLine: number;
    endLine: number;
    markdown: string;
  }

  function groupRenderSegments(lines: string[], offset: number): RenderSegment[] {
    const segments: RenderSegment[] = [];
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        i++;
        continue;
      }
      if (lines[i].trim().startsWith("```")) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim().startsWith("```")) j++;
        const end = j < lines.length ? j : lines.length - 1;
        segments.push({
          startLine: offset + i,
          endLine: offset + end,
          markdown: lines.slice(i, end + 1).join("\n"),
        });
        i = end + 1;
        continue;
      }
      segments.push({
        startLine: offset + i,
        endLine: offset + i,
        markdown: lines[i],
      });
      i++;
    }
    return segments;
  }

  function renderSegmentSlice(lines: string[], offset: number, target: HTMLElement) {
    const segments = groupRenderSegments(lines, offset);
    for (const seg of segments) {
      const rendered = renderMarkdown(seg.markdown);
      rendered.className = "markdown-body task-wysiwyg-block";
      rendered.addEventListener("mousedown", (ev: Event) => {
        if (detailInput.disabled) return;
        const rawTarget = (ev as { target?: { tag?: string; tagName?: string; type?: string } }).target;
        const tagName = (rawTarget?.tagName ?? rawTarget?.tag ?? "").toLowerCase();
        if (tagName === "a" || (tagName === "input" && rawTarget?.type === "checkbox")) return;
        ev.preventDefault();
      });
      rendered.addEventListener("click", (ev: Event) => {
        if (detailInput.disabled) return;
        const rawTarget = (ev as { target?: { tag?: string; tagName?: string; type?: string } }).target;
        const tagName = (rawTarget?.tagName ?? rawTarget?.tag ?? "").toLowerCase();
        if (tagName === "input" && rawTarget?.type === "checkbox") {
          const docLines = detailInput.value.split(/\r?\n/);
          const line = docLines[seg.startLine] ?? "";
          if (/\[ \]/.test(line)) {
            docLines[seg.startLine] = line.replace("[ ]", "[x]");
          } else if (/\[[xX]\]/.test(line)) {
            docLines[seg.startLine] = line.replace(/\[[xX]\]/, "[ ]");
          }
          detailInput.value = docLines.join("\n");
          refreshLivePreview();
          saveCurrentDraft();
          return;
        }
        if (tagName === "a") return;
        if (activeLine !== null) {
          commitActiveEditorToBacking();
        }
        activateLine(seg.startLine, null);
      });
      target.append(rendered);
    }
  }

  tail.addEventListener("mousedown", (e: Event) => {
    if (detailInput.disabled) return;
    e.preventDefault();
  });

  tail.addEventListener("click", () => {
    if (detailInput.disabled) return;
    if (activeLine !== null) {
      commitActiveEditorToBacking();
    }
    const currentLines = detailInput.value.split(/\r?\n/);
    const lastIdx = currentLines.length - 1;
    if (activeLine !== null && currentLines[lastIdx]?.trim() !== "") {
      currentLines.push("");
      detailInput.value = currentLines.join("\n");
      saveCurrentDraft();
    }
    activateLine(currentLines.length - 1, activeLine !== null ? 0 : null);
  });

  function activateLine(lineIdx: number, cursorOffset: number | null = null) {
    if (detailInput.disabled) return;
    isTransitioning = true;
    try {
      fullSelectMode = false;
      const lines = detailInput.value.split(/\r?\n/);
      const units = buildUnits(lines);
      const unit = findUnitForLine(units, lineIdx);
      activeLine = unit.startLine;
      refreshLivePreview();
      activeEditor.focus?.();
      const pos =
        cursorOffset !== null
          ? Math.max(0, Math.min(cursorOffset, activeEditor.value.length))
          : activeEditor.value.length;
      activeEditor.setSelectionRange?.(pos, pos);
    } finally {
      isTransitioning = false;
    }
  }

  function commitActiveEditorToBacking() {
    const lines = detailInput.value.split(/\r?\n/);
    if (fullSelectMode) {
      detailInput.value = activeEditor.value;
      return;
    }
    if (activeLine === null) return;
    const units = buildUnits(lines);
    const unit = findUnitForLine(units, activeLine);
    const replacementLines = activeEditor.value.split(/\r?\n/);
    lines.splice(unit.startLine, unit.endLine - unit.startLine + 1, ...replacementLines);
    detailInput.value = lines.join("\n");
  }

  let lastPreviewKey: string | null = null;
  function previewStateKey(): string {
    return `${fullSelectMode ? "full" : String(activeLine)}:${String(detailInput.disabled)}:${detailInput.value}`;
  }

  function refreshLivePreview(force = true) {
    if (!force && lastPreviewKey === previewStateKey()) return;
    const raw = detailInput.value;
    const lines = raw.split(/\r?\n/);

    if (fullSelectMode) {
      beforeWrap.replaceChildren();
      beforeWrap.hidden = true;
      afterWrap.replaceChildren();
      afterWrap.hidden = true;
      tail.hidden = true;
      activeEditor.hidden = false;
      if (activeEditor.value !== raw) activeEditor.value = raw;
      syncActiveEditorAppearance();
      lastPreviewKey = previewStateKey();
      return;
    }

    if (activeLine !== null && !detailInput.disabled) {
      const units = buildUnits(lines);
      const unit = findUnitForLine(units, activeLine);
      activeLine = unit.startLine;

      beforeWrap.replaceChildren();
      if (unit.startLine > 0) {
        renderSegmentSlice(lines.slice(0, unit.startLine), 0, beforeWrap);
      }
      beforeWrap.hidden = beforeWrap.children.length === 0;

      activeEditor.hidden = false;
      if (activeEditor.value !== unit.text) activeEditor.value = unit.text;
      syncActiveEditorAppearance();

      afterWrap.replaceChildren();
      if (unit.endLine + 1 < lines.length) {
        renderSegmentSlice(lines.slice(unit.endLine + 1), unit.endLine + 1, afterWrap);
      }
      afterWrap.hidden = afterWrap.children.length === 0;
      tail.hidden = false;
      lastPreviewKey = previewStateKey();
      return;
    }

    // When not actively editing a specific line (or when disabled), render all blocks
    beforeWrap.replaceChildren();
    afterWrap.replaceChildren();
    afterWrap.hidden = true;
    if (raw.trim()) {
      renderSegmentSlice(lines, 0, beforeWrap);
      beforeWrap.hidden = beforeWrap.children.length === 0;
      activeEditor.hidden = true;
    } else {
      beforeWrap.hidden = true;
      activeLine = 0;
      activeEditor.hidden = false;
      if (activeEditor.value !== "") activeEditor.value = "";
      syncActiveEditorAppearance();
    }
    tail.hidden = false;
    lastPreviewKey = previewStateKey();
  }

  activeEditor.addEventListener("input", () => {
    syncActiveEditorAppearance();
    commitActiveEditorToBacking();
    // Mark the current backing value as already reflected in the active editor so a background
    // gateChanged() -> update() does not reassign activeEditor.value and reset a mid-line caret.
    lastPreviewKey = previewStateKey();
    saveCurrentDraft();
  });

  activeEditor.addEventListener("blur", () => {
    if (isTransitioning) return;
    commitActiveEditorToBacking();
    if (detailInput.value.trim()) {
      activeLine = null;
      fullSelectMode = false;
      refreshLivePreview();
    }
  });

  function wrapSelection(wrapStart: string, wrapEnd: string = wrapStart) {
    if (activeLine === null) {
      const lines = detailInput.value.split(/\r?\n/);
      activeLine = Math.max(0, lines.length - 1);
      refreshLivePreview();
    }
    const start = activeEditor.selectionStart ?? activeEditor.value.length;
    const end = activeEditor.selectionEnd ?? activeEditor.value.length;
    const sel = activeEditor.value.slice(start, end) || "文本";
    const before = activeEditor.value.slice(0, start);
    const after = activeEditor.value.slice(end);
    activeEditor.value = `${before}${wrapStart}${sel}${wrapEnd}${after}`;
    const newCursorStart = start + wrapStart.length;
    const newCursorEnd = newCursorStart + sel.length;
    commitActiveEditorToBacking();
    refreshLivePreview();
    activeEditor.focus?.();
    activeEditor.setSelectionRange?.(newCursorStart, newCursorEnd);
    saveCurrentDraft();
  }

  function createToolBtn(label: string, title: string, wrapStart: string, wrapEnd: string = wrapStart) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task-md-tool-btn";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("mousedown", (e: Event) => {
      e.preventDefault();
    });
    btn.addEventListener("click", () => {
      if (detailInput.disabled) return;
      wrapSelection(wrapStart, wrapEnd);
    });
    return btn;
  }

  toolsGroup.append(
    createToolBtn("B", "粗体 (Ctrl+B / Cmd+B)", "**"),
    createToolBtn("I", "斜体 (Ctrl+I / Cmd+I)", "*"),
    createToolBtn("H", "标题 (Ctrl+H / Cmd+H)", "### ", ""),
    createToolBtn("`", "行内代码", "`"),
    createToolBtn("```", "代码块", "```\n", "\n```"),
    createToolBtn("•", "无序列表", "- ", ""),
    createToolBtn("1.", "有序列表", "1. ", ""),
    createToolBtn("☑", "任务清单", "- [ ] ", ""),
    createToolBtn("❝", "引用块", "> ", ""),
  );

  detailHeader.append(detailLabelGroup, toolsGroup);

  // Single-column WYSIWYG keyboard navigation & live block transitions
  activeEditor.addEventListener("keydown", (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;

    if (isMod && (e.key === "a" || e.key === "A")) {
      if (!fullSelectMode && detailInput.value.includes("\n")) {
        e.preventDefault();
        commitActiveEditorToBacking();
        fullSelectMode = true;
        refreshLivePreview();
        activeEditor.focus?.();
        activeEditor.setSelectionRange?.(0, activeEditor.value.length);
        return;
      }
    }

    if (e.key === "Escape" && fullSelectMode) {
      e.preventDefault();
      commitActiveEditorToBacking();
      fullSelectMode = false;
      activeLine = 0;
      refreshLivePreview();
      activeEditor.focus?.();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const start = activeEditor.selectionStart ?? 0;
      const end = activeEditor.selectionEnd ?? 0;
      const val = activeEditor.value;
      if (e.shiftKey) {
        if (val.slice(start - 2, start) === "  ") {
          activeEditor.value = val.slice(0, start - 2) + val.slice(start);
          activeEditor.setSelectionRange?.(start - 2, end - 2);
        }
      } else {
        activeEditor.value = val.slice(0, start) + "  " + val.slice(end);
        activeEditor.setSelectionRange?.(start + 2, start + 2);
      }
      commitActiveEditorToBacking();
      saveCurrentDraft();
      return;
    }

    if (isMod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      wrapSelection("**");
      return;
    }
    if (isMod && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      wrapSelection("*");
      return;
    }
    if (isMod && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      wrapSelection("### ", "");
      return;
    }

    if (fullSelectMode) return;

    const cursor = activeEditor.selectionStart ?? 0;
    const selEnd = activeEditor.selectionEnd ?? cursor;
    const val = activeEditor.value;
    const isCodeBlock = val.trim().startsWith("```");

    if (e.key === "Enter" && !e.shiftKey) {
      if (isCodeBlock) {
        const codeLines = val.split("\n");
        const hasClosingFence = codeLines.length > 1 && codeLines[codeLines.length - 1].trim().startsWith("```");
        if (hasClosingFence && cursor === val.length) {
          e.preventDefault();
          commitActiveEditorToBacking();
          const docLines = detailInput.value.split(/\r?\n/);
          const units = buildUnits(docLines);
          const unit = findUnitForLine(units, activeLine ?? 0);
          docLines.splice(unit.endLine + 1, 0, "");
          detailInput.value = docLines.join("\n");
          saveCurrentDraft();
          activateLine(unit.endLine + 1, 0);
          return;
        }
        return;
      }

      e.preventDefault();
      const before = val.slice(0, cursor);
      const after = val.slice(selEnd);
      const listMatch = before.match(/^(\s*)([-*] \[[ xX]\] |[-*] |\d+\. )/);

      commitActiveEditorToBacking();
      const docLines = detailInput.value.split(/\r?\n/);
      const currentIdx = activeLine ?? 0;

      if (listMatch) {
        if (before.trim() === listMatch[2].trim() && after.trim() === "") {
          docLines[currentIdx] = "";
          detailInput.value = docLines.join("\n");
          saveCurrentDraft();
          activateLine(currentIdx, 0);
          return;
        }
        let nextMarker = listMatch[2];
        const numMatch = listMatch[2].match(/^(\d+)\. /);
        if (numMatch) {
          nextMarker = `${parseInt(numMatch[1], 10) + 1}. `;
        } else if (listMatch[2].includes("[")) {
          nextMarker = "- [ ] ";
        }
        const nextLinePrefix = `${listMatch[1]}${nextMarker}`;
        docLines[currentIdx] = before;
        docLines.splice(currentIdx + 1, 0, `${nextLinePrefix}${after}`);
        detailInput.value = docLines.join("\n");
        saveCurrentDraft();
        activateLine(currentIdx + 1, nextLinePrefix.length);
        return;
      }

      docLines[currentIdx] = before;
      docLines.splice(currentIdx + 1, 0, after);
      detailInput.value = docLines.join("\n");
      saveCurrentDraft();
      activateLine(currentIdx + 1, 0);
      return;
    }

    if (e.key === "Backspace" && cursor === 0 && selEnd === 0 && (activeLine ?? 0) > 0) {
      e.preventDefault();
      commitActiveEditorToBacking();
      const docLines = detailInput.value.split(/\r?\n/);
      const units = buildUnits(docLines);
      const unit = findUnitForLine(units, activeLine ?? 0);
      if (unit.startLine > 0) {
        const prevUnit = findUnitForLine(units, unit.startLine - 1);
        const joinCol = docLines[prevUnit.endLine].length;
        docLines[prevUnit.endLine] = docLines[prevUnit.endLine] + docLines[unit.startLine];
        docLines.splice(unit.startLine, 1);
        detailInput.value = docLines.join("\n");
        saveCurrentDraft();
        activateLine(prevUnit.startLine, joinCol);
      }
      return;
    }

    if (e.key === "ArrowUp" && !val.slice(0, cursor).includes("\n") && (activeLine ?? 0) > 0) {
      e.preventDefault();
      commitActiveEditorToBacking();
      const docLines = detailInput.value.split(/\r?\n/);
      const units = buildUnits(docLines);
      const unit = findUnitForLine(units, activeLine ?? 0);
      if (unit.startLine > 0) {
        const prevUnit = findUnitForLine(units, unit.startLine - 1);
        activateLine(prevUnit.startLine, cursor);
      }
      return;
    }

    if (e.key === "ArrowDown" && !val.slice(cursor).includes("\n")) {
      commitActiveEditorToBacking();
      const docLines = detailInput.value.split(/\r?\n/);
      const units = buildUnits(docLines);
      const unit = findUnitForLine(units, activeLine ?? 0);
      if (unit.endLine < docLines.length - 1) {
        e.preventDefault();
        const nextUnit = findUnitForLine(units, unit.endLine + 1);
        activateLine(nextUnit.startLine, cursor);
      }
    }
  });

  const mdHint = document.createElement("p");
  mdHint.className = "muted task-detail-hint";
  mdHint.textContent =
    "单栏所见即所得：输入 # 标题、**粗体**、- 列表、- [ ] 待办、``` 代码块后回车即刻渲染，点击任意已渲染段落可直接原位修改";

  refreshLivePreview();
  editorBox.append(detailHeader, detailInput, previewContainer, mdHint);
  detailField.append(editorBox);
  composeSection.append(detailField);

  const footer = document.createElement("div");
  footer.className = "task-footer";

  const status = document.createElement("p");
  status.className = "task-dialog-status";
  status.id = "task-dialog-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const error = document.createElement("p");
  error.className = "setup-error task-dialog-error";
  error.id = "task-dialog-error";
  error.setAttribute("role", "alert");
  error.tabIndex = -1;
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "setup-actions task-actions";

  let renderedEntries: unknown;
  let notifiedResult: unknown;
  let focusedError: string | null = null;

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "task-cancel-button";
  cancelButton.textContent = "取消并返回";

  const primaryGroup = document.createElement("div");
  primaryGroup.className = "task-primary-actions";

  const anotherButton = document.createElement("button");
  anotherButton.type = "button";
  anotherButton.textContent = "显式另派一条";
  anotherButton.hidden = true;

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "setup-primary task-submit-button";
  submitButton.textContent = "派发并入队";

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "setup-primary task-submit-button";
  doneButton.textContent = "完成";
  doneButton.hidden = true;

  primaryGroup.append(anotherButton, submitButton, doneButton);
  actions.append(cancelButton, primaryGroup);
  footer.append(status, error, actions);
  form.append(titleRouteBar, composeSection, footer);
  root.append(form);

  function saveCurrentDraft() {
    if (controller.operation) return;
    controller.saveDraft?.({
      entry: entrySelect.value,
      pattern: typeSelect.value,
      concrete: concreteInput.value,
      summary: summaryInput.value,
      detail: detailInput.value,
    });
  }

  summaryInput.addEventListener("input", saveCurrentDraft);
  detailInput.addEventListener("input", () => {
    fullSelectMode = false;
    activeLine = detailInput.value.trim() ? null : 0;
    refreshLivePreview();
    saveCurrentDraft();
  });
  concreteInput.addEventListener("input", () => {
    updateRouteSummary();
    saveCurrentDraft();
  });
  typeSelect.addEventListener("change", () => {
    updateConcrete();
    saveCurrentDraft();
  });

  function fillEntries() {
    const state = controller.entriesState;
    const entries = state.kind === "ready" ? state.entries : [];
    const selected = entrySelect.value;
    entrySelect.replaceChildren(
      ...entries.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.name;
        option.textContent = `${entry.name} → ${entry.to}`;
        return option;
      }),
    );
    if (entries.some((entry) => entry.name === selected)) entrySelect.value = selected;
    fillTypes();
    const usable = state.kind === "ready" && entries.length > 0;
    entrySelect.disabled = !usable;
    summaryInput.disabled = !usable;
    detailInput.disabled = !usable;
    activeEditor.disabled = !usable;
    submitButton.disabled = !usable;
  }

  function fillTypes() {
    const state = controller.entriesState;
    const entry =
      state.kind === "ready"
        ? (state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0])
        : undefined;
    const types = entry?.types ?? [];
    const selected = typeSelect.value;
    typeSelect.replaceChildren(
      ...types.map((type) => {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        return option;
      }),
    );
    if (types.includes(selected)) typeSelect.value = selected;
    typeField.hidden = false;
    typeSelect.hidden = false;
    updateConcrete();
  }

  entrySelect.addEventListener("change", () => {
    fillTypes();
    saveCurrentDraft();
  });

  function update() {
    const state = controller.entriesState;
    if (renderedEntries !== state && !controller.operation) {
      renderedEntries = state;
      fillEntries();
    }
    const operation = controller.operation;
    if (operation) {
      fillEntries();
      entrySelect.value = operation.draft.entry || entrySelect.value;
      fillTypes();
      typeSelect.value = operation.draft.pattern;
      concreteInput.value = operation.draft.concrete;
      summaryInput.value = operation.draft.summary;
      detailInput.value = operation.draft.detail;
      activeLine = null;
      fullSelectMode = false;
      updateConcrete();
    } else if (controller.draft) {
      const draft = controller.draft;
      if (draft.entry && (!entrySelect.value || entrySelect.value !== draft.entry)) {
        entrySelect.value = draft.entry;
        fillTypes();
      }
      if (draft.pattern && (!typeSelect.value || typeSelect.value !== draft.pattern)) {
        typeSelect.value = draft.pattern;
      }
      if (draft.concrete !== undefined && !concreteInput.value) {
        concreteInput.value = draft.concrete;
      }
      if (draft.summary !== undefined && !summaryInput.value) {
        summaryInput.value = draft.summary;
      }
      if (draft.detail !== undefined && !detailInput.value) {
        detailInput.value = draft.detail;
        if (draft.detail.trim()) activeLine = null;
      }
      updateConcrete();
    } else {
      updateRouteSummary();
    }

    for (const field of [entrySelect, typeSelect, concreteInput, summaryInput, detailInput, activeEditor])
      field.disabled = !!operation || !controller.canSubmit || state.kind !== "ready";

    refreshLivePreview(false);
    anotherButton.hidden =
      !operation || controller.submitState.kind === "busy" || controller.submitState.kind === "uncertain";
    anotherButton.disabled = !controller.canBeginAnother;
    if (state.kind === "loading") status.textContent = "正在读取任务入口。";
    else if (state.kind === "ready") status.textContent = state.entries.length ? "" : DESKTOP_TASK_MESSAGES.noEntry;
    else status.textContent = state.message;
    status.hidden = state.kind === "ready" && state.entries.length > 0;

    const submission = controller.submitState;
    status.classList.toggle("is-done", submission.kind === "done");
    if (submission.kind === "idle") {
      error.hidden = true;
      focusedError = null;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled =
        !controller.canSubmit ||
        controller.entriesState.kind !== "ready" ||
        controller.entriesState.entries.length === 0;
      submitButton.textContent = "派发并入队";
    } else if (submission.kind === "busy") {
      error.hidden = true;
      focusedError = null;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled = true;
      submitButton.textContent = "正在派发……";
    } else if (submission.kind === "done") {
      error.hidden = true;
      focusedError = null;
      submitButton.hidden = true;
      doneButton.hidden = false;
      const routed = submission.result.routed;
      status.textContent = submission.result.duplicate
        ? "这条任务之前已提交过，没有重复入队。"
        : routed.length
          ? `已入队，交给规则：${routed.join("、")}。`
          : "已记录，但没有规则接住这个类型。";
      status.hidden = false;
      if (notifiedResult !== submission.result) {
        notifiedResult = submission.result;
        try {
          onCreated();
        } catch {
          /* A refresh failure is not a failed submission. */
        }
      }
    } else {
      error.textContent = submission.message;
      error.hidden = false;
      if (focusedError !== submission.message) {
        focusedError = submission.message;
        error.focus?.();
      }
      submitButton.hidden = !!operation;
      doneButton.hidden = !operation;
      submitButton.disabled = !controller.canSubmit;
      submitButton.textContent = "派发并入队";
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = controller.entriesState;
    if (state.kind !== "ready" || !state.entries.length) return;
    const entry = state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0];
    const pattern = entry.types.includes(typeSelect.value) ? typeSelect.value : entry.types[0];
    const type = pattern.includes("*") ? concreteInput.value.trim() : pattern;
    const matches =
      pattern === "*" || (pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern);
    if (!DESKTOP_TASK_TYPE_PATTERN.test(type) || !matches) {
      error.textContent = "请填写符合所选模式的具体事件类型；不能提交通配符。";
      error.hidden = false;
      focusedError = error.textContent;
      error.focus?.();
      return;
    }
    const input: DesktopTaskInput = { type, summary: summaryInput.value, detail: detailInput.value };
    if (!controller.canSubmit) return;
    controller.submitTask(input, {
      entry: entrySelect.value,
      pattern: typeSelect.value,
      concrete: concreteInput.value,
      summary: summaryInput.value,
      detail: detailInput.value,
    });
  });

  cancelButton.addEventListener("click", () => {
    saveCurrentDraft();
    onBack?.();
  });

  doneButton.addEventListener("click", () => {
    onBack?.();
  });

  anotherButton.addEventListener("click", () => {
    if (!controller.canBeginAnother) return;
    controller.reset();
    controller.clearDraft?.();
    if (controller.operation) return;
    summaryInput.value = "";
    detailInput.value = "";
    activeEditor.value = "";
    concreteInput.value = "";
    activeLine = 0;
    fullSelectMode = false;
    refreshLivePreview();
    controller.loadEntries();
    update();
  });

  function open() {
    root.hidden = false;
    if (document.body && !root.parentElement) {
      document.body.append(root);
    }
    if (!controller.operation) {
      controller.loadEntries();
      if (controller.draft) {
        const draft = controller.draft;
        if (draft.summary) summaryInput.value = draft.summary;
        if (draft.detail) {
          detailInput.value = draft.detail;
          activeLine = draft.detail.trim() ? null : 0;
        }
        if (draft.concrete) concreteInput.value = draft.concrete;
      }
    }
    update();
  }

  function close() {
    saveCurrentDraft();
    root.hidden = true;
    onBack?.();
  }

  // Double compatibility for memory DOM tests expecting showModal/close on the root
  (root as unknown as { showModal?: () => void }).showModal = () => open();
  (root as unknown as { close?: () => void }).close = () => close();

  return {
    root,
    open,
    update,
    close,
    syncDraft: saveCurrentDraft,
  };
}

export const mountTaskDialog = mountTaskView;
