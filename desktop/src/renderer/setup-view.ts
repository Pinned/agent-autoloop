import type { createRendererSetup } from "./setup-controller.ts";
import { parseDesktopJoinInput } from "../../../host/desktop-setup-contract.ts";

type Controller = ReturnType<typeof createRendererSetup>;
const roles = { "hub-worker": "中台＋执行机", worker: "纯执行机" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

type Options = {
  /** Whether a workspace exists behind this page for the user to return to. */
  canDismiss?: () => boolean;
  /** The way out when it does not: the app's own quit, with its confirmation. */
  exit?: () => void;
};

export function mountSetupView(root: HTMLElement, control: Controller, close: () => void, options: Options = {}) {
  const canDismiss = options.canDismiss ?? (() => true);
  let keyInput: HTMLInputElement | undefined;
  let draftScope = "";
  let renderedDraft: { url: string; worker: string } | undefined;
  function clearKey() {
    if (keyInput) keyInput.value = "";
    keyInput = undefined;
  }
  function button(text: string, action: () => void, disabled = false) {
    const node = element("button", text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function field(form: HTMLElement, id: string, title: string, value: string, hint: string, password = false) {
    const group = element("div", "", "setup-field");
    const label = element("label", title);
    label.htmlFor = id;
    const input = element("input");
    input.id = id;
    input.type = password ? "password" : "text";
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = true;
    input.maxLength = password ? 4096 : id === "setup-url" ? 2048 : 128;
    const help = element("p", hint, "muted");
    help.id = `${id}-hint`;
    input.setAttribute("aria-describedby", help.id);
    group.append(label, input, help);
    form.append(group);
    return input;
  }
  function render(focus = true) {
    const state = control.state;
    // A wizard is its own state at rest, and nested while its write is in flight; both render the
    // same step so a redraw never loses the user's place.
    const currentWizard = state.kind === "wizard" ? state : state.kind === "submitting" ? state.wizard : undefined;
    const scope = currentWizard ? `${currentWizard.role}:${currentWizard.step}` : "";
    // Keep unsent non-secret input only while redrawing the same unchanged draft.
    // A controller validation result or a step/role change remains authoritative.
    const preserveDraft =
      scope === draftScope &&
      renderedDraft &&
      currentWizard &&
      renderedDraft.url === currentWizard.draft.url &&
      renderedDraft.worker === currentWizard.draft.worker;
    let urlValue = preserveDraft ? root.querySelector<HTMLInputElement>("#setup-url")?.value : undefined;
    // Unsent addresses are not necessarily non-secret. Reuse the authoritative URL
    // grammar before restoring a DOM draft, even when sanitization left state unchanged.
    if (urlValue) {
      try {
        parseDesktopJoinInput({ url: urlValue, worker: "validation-only", key: "validation-only" });
      } catch {
        urlValue = currentWizard?.draft.url;
      }
    }
    const workerValue = preserveDraft ? root.querySelector<HTMLInputElement>("#setup-worker")?.value : undefined;
    draftScope = scope;
    renderedDraft = currentWizard ? { ...currentWizard.draft } : undefined;
    clearKey();
    root.replaceChildren();
    root.setAttribute("aria-labelledby", "setup-title");
    const header = element("header", "", "page-head");
    const title = element("h1", "配置此电脑");
    title.id = "setup-title";
    title.tabIndex = -1;
    const copy = element("div", "", "page-head-copy");
    copy.append(
      element("div", "桌面应用 / 本机配置", "eyebrow"),
      title,
      element("p", "先选择此电脑的角色并连接中台，再明确完成首次配置并请求启动。保存不会启动运行服务。"),
    );
    header.append(copy);
    root.append(header);
    const panel = element("section", "", "panel setup-panel");
    panel.setAttribute("aria-labelledby", "setup-title");
    root.append(panel);
    const status = element("p", "", "setup-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    panel.append(status);
    const actions = element("div", "", "setup-actions");
    const cancel = () => {
      clearKey();
      close();
    };
    // Before a machine has a workspace there is nothing to dismiss the page back to, so the only
    // honest way out is the app's own quit (which still asks for confirmation). Once the workspace
    // exists - re-entered from settings, or a first run that just completed - leaving is normal.
    const leave = () => {
      if (canDismiss()) cancel();
      else options.exit?.();
    };

    if (state.kind === "wizard" || state.kind === "submitting") {
      const wizard = state.kind === "wizard" ? state : state.wizard;
      const busy = control.busy;
      panel.setAttribute("aria-busy", String(busy));
      const steps = element("ol", "", "setup-steps");
      ["选择角色", "连接"].forEach((text, index) => {
        const item = element("li", `${index + 1}. ${text}`);
        if (wizard.step === index + 1) item.setAttribute("aria-current", "step");
        steps.append(item);
      });
      panel.prepend(steps);
      const form = element("form", "", "setup-form");
      panel.append(form);
      if (wizard.step === 1) {
        form.append(element("h2", "这台电脑承担什么角色？"));
        const choices = element("div", "", "setup-choices");
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", "本机角色");
        for (const role of ["hub-worker", "worker"] as const) {
          const choice = button(roles[role], () => control.chooseRole(role), busy);
          choice.className = "setup-choice";
          choice.setAttribute("aria-pressed", String(wizard.role === role));
          choice.append(
            element(
              "span",
              role === "hub-worker" ? "在本机管理工作，也由本机执行。" : "保存已有中台的连接配置，由这台电脑执行。",
              "muted",
            ),
          );
          choices.append(choice);
        }
        form.append(choices);
      } else {
        form.append(element("h2", roles[wizard.role]));
        if (wizard.role === "hub-worker") {
          form.append(
            element(
              "p",
              "应用启动时会读取本机 CLI 的连接配置（回环地址与本机认证所需的 owner）；owner 只在每次请求时从该配置读取，不存入应用状态、页面或日志。该配置指向中台时，应用直接接入，不会另起一个；连不上则显示重连页。",
              "muted",
            ),
            element("p", "本机 CLI 未配置中台、配置为纯执行机或未安装时，应用使用自己的内置中台；原任务与记录保留在原中台，不会自动迁移。", "muted"),
          );
        } else {
          field(
            form,
            "setup-url",
            "中台地址",
            urlValue ?? wizard.draft.url,
            "使用 http:// 或 https://，不要包含用户名、密码、查询参数或片段。",
          );
          field(
            form,
            "setup-worker",
            "本机名称",
            workerValue ?? wizard.draft.worker,
            "以小写字母开头，仅使用小写字母、数字与连字符，例如 worker-1。",
          );
          keyInput = field(
            form,
            "setup-key",
            "执行机加入密钥",
            "",
            "使用独立执行机凭证，不要填写中台管理凭证。提交后先验证能否操作中台，再保存配置。",
            true,
          );
          form.append(element("p", "连接成功才会保存。连接失败时本机不留任何配置，可修改后重试。", "muted"));
        }
      }
      if (wizard.error) {
        const error = element("p", wizard.error, "setup-error");
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        form.append(error);
      }
      status.textContent =
        state.kind === "submitting" ? "正在连接并保存本机配置，请等待。隐藏窗口不会取消操作。" : "";
      if (wizard.step > 1)
        actions.append(
          button(
            "上一步",
            () => {
              clearKey();
              control.back();
            },
            busy,
          ),
        );
      const label = wizard.step === 1 ? "下一步" : wizard.role === "worker" ? "连接并保存" : "保存本机配置";
      const submit = element("button", label);
      submit.type = "submit";
      submit.disabled = busy;
      submit.className = "setup-primary";
      actions.append(submit, button(canDismiss() ? "暂不配置" : "退出应用…", leave, control.submitting));
      form.append(actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (control.busy) return;
        if (wizard.step === 1) {
          control.next();
          return;
        }
        if (wizard.role === "hub-worker") {
          control.submit();
          return;
        }
        const url = form.querySelector<HTMLInputElement>("#setup-url")?.value;
        const worker = form.querySelector<HTMLInputElement>("#setup-worker")?.value;
        const input = keyInput;
        // Read the key before validating: a validation redraw clears the control it came from.
        const key = input?.value;
        try {
          // An incomplete draft cannot connect, so it never becomes a network attempt.
          if (url === undefined || worker === undefined || !control.draft({ url, worker })) return;
          control.submit(key);
        } finally {
          // submit() may synchronously redraw and install a new secret control.
          // Only erase the old captured control; never discard the new reference.
          if (input) input.value = "";
        }
      });
    } else {
      if (state.kind === "prepared" || state.kind === "completing" || state.kind === "completed") {
        panel.append(element("h2", state.mode === "embedded" ? roles["hub-worker"] : roles.worker));
        if (state.kind === "prepared") {
          status.textContent = "本机配置已保存，运行服务尚未因保存而启动。";
          panel.append(
            element(
              "p",
              "明确完成首次配置后，将请求启动；以后打开应用会按已保存策略启动。安装与登录情况不因完成配置而改变。",
              "muted",
            ),
          );
          actions.append(button("完成首次配置并请求启动", () => control.complete(), control.busy));
        } else if (state.kind === "completing") {
          status.textContent = "正在完成首次配置并请求启动，请等待。不要重复初始化或强制退出。";
          panel.setAttribute("aria-busy", "true");
        } else {
          status.textContent = "首次配置已完成，已请求启动。实际是否运行请查看执行机页。";
          panel.append(
            element("p", "如果启动失败，可在执行机页重试启动；不要重新初始化。执行程序登录仍未验证。", "muted"),
          );
        }
        if (state.mode === "embedded")
          panel.append(
            element(
              "p",
              "中台从哪来每次启动都重新判断：本机 CLI 配置了中台时，应用只接入它，连不上就显示重连页；CLI 未配置中台、配置为纯执行机或未安装时，才启动这里的这个内置中台。原任务与记录保留在原中台，不会自动迁移。",
              "muted",
            ),
          );
      } else if (state.kind === "configured") {
        status.textContent = "这台电脑已有配置，本轮不提供覆盖或切换角色。";
        panel.append(
          element("h2", roles[state.role]),
          element("p", "本次未启动服务；Agent 登录未验证。这里不判断运行服务当前是否在线。", "muted"),
        );
        if (state.role === "worker") panel.append(element("p", "本次未连接中台、未验证密钥有效性。", "muted"));
      } else if (state.kind === "reading-status" || state.kind === "reading-launch") {
        status.textContent = "正在核查本机配置，请等待。";
        panel.setAttribute("aria-busy", "true");
      } else if (state.kind === "unknown-locked") {
        status.textContent =
          "无法确认操作已安全完成。本次会话已锁定配置操作，请保留现场并人工检查；不要重复初始化或强制退出。";
      } else if (state.kind === "mutation-unresolved") {
        status.textContent = state.message;
        actions.append(button("核查本机状态", () => control.recheck(), control.busy));
      } else if (state.kind === "blocked") {
        status.textContent = state.message;
        if (state.retry) {
          panel.append(
            element(
              "p",
              "核查只使用已有运行资源，不会自动下载。运行资源不可用时无法核查本机配置；此检查不验证远端连接。",
              "muted",
            ),
          );
          actions.append(button("重新核查本机状态", () => control.recheck(), control.busy));
        }
      } else {
        status.textContent = "本机配置尚未检查。";
      }
      actions.append(button(canDismiss() ? "返回工作空间" : "退出应用…", leave, control.submitting));
      panel.append(actions);
    }
    if (focus) (root.querySelector<HTMLElement>(".setup-error") ?? title).focus();
  }
  return { render, dispose: clearKey };
}
