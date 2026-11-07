import { DESKTOP_TASK_MESSAGES } from "../../../host/desktop-task-contract.ts";
import type { DesktopTaskInput } from "../../../host/desktop-task-contract.ts";
import type { createRendererTask } from "./task-controller.ts";

/**
 * The new-task dialog: a native <dialog> whose fields are built once with createElement and only
 * ever updated by value — no markup injection anywhere. Entry choice comes from the hub's real
 * rule entries, so a task is never offered a type nothing will take.
 */
export function mountTaskDialog(
  controller: ReturnType<typeof createRendererTask>,
  onCreated: () => void,
): { open(): void; update(): void } {
  const dialog = document.createElement("dialog");
  dialog.className = "task-dialog";
  const form = document.createElement("form");
  form.className = "task-form";
  const title = document.createElement("h2");
  title.textContent = "新建任务";
  const intro = document.createElement("p");
  intro.className = "muted task-intro";
  intro.textContent = "选择一个真实入口，写清目标；提交后会交给本机中台排队推进。";
  const entryField = document.createElement("label");
  entryField.className = "setup-field";
  const entryLabel = document.createElement("span");
  entryLabel.textContent = "任务入口";
  const entrySelect = document.createElement("select");
  entrySelect.id = "task-entry";
  entryField.append(entryLabel, entrySelect);
  const typeField = document.createElement("label");
  typeField.className = "setup-field";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = "事件类型";
  const typeSelect = document.createElement("select");
  typeSelect.id = "task-type";
  typeField.append(typeLabel, typeSelect);
  const summaryField = document.createElement("label");
  summaryField.className = "setup-field";
  const summaryLabel = document.createElement("span");
  summaryLabel.textContent = "标题";
  const summaryInput = document.createElement("input");
  summaryInput.id = "task-summary";
  summaryInput.required = true;
  summaryField.append(summaryLabel, summaryInput);
  const detailField = document.createElement("label");
  detailField.className = "setup-field";
  const detailLabel = document.createElement("span");
  detailLabel.textContent = "详情";
  const detailInput = document.createElement("textarea");
  detailInput.id = "task-detail";
  detailInput.rows = 5;
  detailField.append(detailLabel, detailInput);
  const status = document.createElement("p");
  status.className = "task-dialog-status";
  status.id = "task-dialog-status";
  const error = document.createElement("p");
  error.className = "setup-error task-dialog-error";
  error.id = "task-dialog-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "setup-actions";
  let lastDone: { event: number; duplicate: boolean; routed: string[] } | null = null;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "setup-primary";
  submitButton.textContent = "创建并入队";
  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "setup-primary";
  doneButton.textContent = "完成";
  doneButton.hidden = true;
  actions.append(cancelButton, submitButton, doneButton);
  form.append(title, intro, entryField, typeField, summaryField, detailField, status, error, actions);
  dialog.append(form);
  document.body.append(dialog);

  function fillEntries() {
    const state = controller.entriesState;
    const entries = state.kind === "ready" ? state.entries : [];
    entrySelect.replaceChildren(
      ...entries.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.name;
        option.textContent = `${entry.name} → ${entry.to}`;
        return option;
      }),
    );
    fillTypes();
    const usable = state.kind === "ready" && entries.length > 0;
    entrySelect.disabled = !usable;
    summaryInput.disabled = !usable;
    detailInput.disabled = !usable;
    submitButton.disabled = !usable;
  }
  function fillTypes() {
    const state = controller.entriesState;
    const entry =
      state.kind === "ready"
        ? (state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0])
        : undefined;
    const types = entry?.types ?? [];
    typeSelect.replaceChildren(
      ...types.map((type) => {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        return option;
      }),
    );
    typeField.hidden = types.length <= 1;
  }
  entrySelect.addEventListener("change", fillTypes);
  function update() {
    fillEntries();
    const state = controller.entriesState;
    if (state.kind === "loading") status.textContent = "正在读取任务入口。";
    else if (state.kind === "ready") status.textContent = state.entries.length ? "" : DESKTOP_TASK_MESSAGES.noEntry;
    else status.textContent = state.message;
    status.hidden = state.kind === "ready" && state.entries.length > 0;
    const submission = controller.submitState;
    if (submission.kind === "done" && submission.result !== lastDone) {
      // A fresh success is exactly the moment today's data changed on its own.
      lastDone = submission.result;
      onCreated();
    }
    if (submission.kind === "idle") {
      error.hidden = true;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled = controller.entriesState.kind !== "ready" || controller.entriesState.entries.length === 0;
      submitButton.textContent = "创建并入队";
    } else if (submission.kind === "busy") {
      error.hidden = true;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled = true;
      submitButton.textContent = "正在创建……";
    } else if (submission.kind === "done") {
      error.hidden = true;
      submitButton.hidden = true;
      doneButton.hidden = false;
      const routed = submission.result.routed;
      status.textContent = submission.result.duplicate
        ? "这条任务之前已提交过，没有重复入队。"
        : routed.length
          ? `已入队，交给规则：${routed.join("、")}。`
          : "已记录，但没有规则接住这个类型。";
      status.hidden = false;
    } else {
      error.textContent = submission.message;
      error.hidden = false;
      submitButton.disabled = false;
      submitButton.textContent = "创建并入队";
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = controller.entriesState;
    if (state.kind !== "ready" || !state.entries.length) return;
    const entry = state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0];
    const type = entry.types.includes(typeSelect.value) ? typeSelect.value : entry.types[0];
    const input: DesktopTaskInput = { type, summary: summaryInput.value, detail: detailInput.value };
    controller.submitTask(input);
  });
  cancelButton.addEventListener("click", () => dialog.close());
  doneButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    controller.reset();
    summaryInput.value = "";
    detailInput.value = "";
  });
  dialog.addEventListener("cancel", (event) => {
    if (controller.submitState.kind === "busy") event.preventDefault();
  });
  return {
    open() {
      controller.reset();
      controller.loadEntries();
      update();
      dialog.showModal();
    },
    /** Called by the controller's own notification; updating a closed dialog is a no-op visually. */
    update,
  };
}
