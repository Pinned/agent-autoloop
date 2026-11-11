import type { createRendererSetup } from "./setup-controller.ts";
import type { SetupLink } from "./setup-controller.ts";
import { DESKTOP_SETUP_ERROR_MESSAGES, parseDesktopJoinInput } from "../../../host/desktop-setup-contract.ts";

type Controller = ReturnType<typeof createRendererSetup>;
const roles = { "hub-worker": "中台＋执行机", worker: "纯执行机" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** The role is written down once the machine is no longer merely being shown a form. */
function settled(link: SetupLink | null): boolean {
  return link !== null && (link.kind === "embedding" || link.kind === "embedded" || link.kind === "joined");
}

/** What the door's own refusal means for the user's next action. */
function doorCopy(reason: string): string {
  switch (reason) {
    case "credential-rejected":
      return "中台不接受这份 owner 凭证。请在中台重新生成后重试。";
    case "redirect":
      return "中台地址发生了跳转。请确认地址指向本机中台后重试。";
    case "timeout":
      return "连接中台超时。";
    case "config-changed":
      return "本机连接配置在读取时发生了变化。请重新读取。";
    case "invalid-response":
      return "中台返回了无法识别的响应，可能不是本应用支持的中台版本。";
    default:
      return "中台没有响应。请先在终端启动中台服务，然后重试。";
  }
}

/** The one line that tells the user where step 2 stands. */
function linkCopy(link: SetupLink | null, role: "hub-worker" | "worker"): string {
  if (link === null) return role === "worker" ? "填写中台地址、本机名称与加入密钥，然后连接。" : "";
  switch (link.kind) {
    case "probing":
      return "正在读取本机配置并连接中台，请等待。";
    case "attached":
      return `已连接到本机中台 127.0.0.1:${link.port}。点击完成进入主页面。`;
    case "failed": {
      const problem = link.problem;
      if (problem.kind === "door") return `未连接到中台 127.0.0.1:${problem.port}。${doorCopy(problem.reason)}`;
      return DESKTOP_SETUP_ERROR_MESSAGES[problem.code];
    }
    case "embedding":
      // Why the CLI config did not point at a hub decides what this sentence may claim: absent
      // means there is none to find, worker and invalid mean one exists but is not a hub address.
      return link.reason === "absent"
        ? "未找到终端中台，正在配置并启动本机中台，请等待。"
        : "终端配置没有指向可用中台（纯执行机或配置无法读取），本应用将使用自己的中台；正在配置并启动，请等待。";
    case "embedded":
      return link.reason === "absent"
        ? "本机中台已配置完成。点击完成进入主页面。"
        : "已为本机配置专属中台。点击完成进入主页面。";
    case "joined":
      return "已连接到中台，配置已保存。点击完成进入主页面。";
  }
}

type Options = {
  /** Whether a workspace exists behind this page for the user to return to. */
  canDismiss?: () => boolean;
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
      element("p", "选择此电脑的角色并建立连接，完成后进入主页面。"),
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
    // Before a machine has a workspace there is nothing to dismiss this page back to, and the app's
    // own quit door lives in the status bar, so no leave button is drawn at all — one beside the
    // primary path would carry its weight and duplicate the status bar's door. Once the workspace
    // exists - re-entered from settings, or a first run that just completed - leaving is normal.

    if (state.kind === "wizard" || state.kind === "submitting") {
      const wizard = state.kind === "wizard" ? state : state.wizard;
      const busy = control.busy;
      const link = wizard.link;
      const locked = settled(link);
      const joined = wizard.role === "worker" && link?.kind === "joined";
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
          // Step 2 is not a form: entering it already asked whether this machine's hub answers.
          const entry = element("p", linkCopy(link, wizard.role), "setup-link");
          entry.setAttribute("role", "status");
          entry.setAttribute("aria-live", "polite");
          form.append(entry);
          if (link?.kind === "failed") {
            form.append(
              element(
                "p",
                "也可以改用本机中台：清空本机 CLI 的中台配置后点「重试」，应用会自行配置并启动内置中台。",
                "muted",
              ),
            );
          }
          if (link?.kind === "embedded" || link?.kind === "embedding")
            form.append(
              element(
                "p",
                "原任务与记录保留在原中台，不会自动迁移。内置中台只在启动后可用，完成时会一并请求启动。",
                "muted",
              ),
            );
        } else if (joined) {
          form.append(element("p", linkCopy(link, wizard.role), "setup-link"));
          form.append(element("p", "角色已锁定为本机配置，不能再返回上一步。完成会请求启动运行服务。", "muted"));
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
            "使用独立执行机凭证，不要填写中台管理凭证。连接成功才会保存配置。",
            true,
          );
        }
      }
      if (wizard.error) {
        const error = element("p", wizard.error, "setup-error");
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        form.append(error);
      }
      status.textContent =
        state.kind === "submitting"
          ? wizard.role === "worker"
            ? "正在验证连接并保存本机配置，请等待。隐藏窗口不会取消操作。"
            : "正在配置本机中台，请等待。隐藏窗口不会取消操作。"
          : "";
      if (wizard.step > 1 && !joined)
        actions.append(
          button(
            "上一步",
            () => {
              clearKey();
              control.back();
            },
            busy || locked,
          ),
        );
      if (wizard.step === 1) {
        const next = element("button", "下一步");
        next.type = "submit";
        next.disabled = busy;
        next.className = "setup-primary";
        actions.append(next);
        if (canDismiss()) actions.append(button("暂不配置", cancel, control.submitting));
      } else if (wizard.role === "hub-worker") {
        const connected = link?.kind === "attached" || link?.kind === "embedded";
        const done = element("button", "完成");
        done.type = "submit";
        done.disabled = busy || !connected;
        done.className = "setup-primary";
        if (link?.kind === "failed") actions.append(button("重试", () => control.retry(), busy));
        actions.append(done);
        if (canDismiss()) actions.append(button("暂不配置", cancel, control.submitting));
      } else {
        const done = element("button", joined ? "完成" : "连接");
        done.type = "submit";
        done.disabled = busy;
        done.className = "setup-primary";
        actions.append(done);
        if (canDismiss()) actions.append(button("暂不配置", cancel, control.submitting));
      }
      form.append(actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (control.busy) return;
        if (wizard.step === 1) {
          control.next();
          return;
        }
        if (wizard.role === "hub-worker" || joined) {
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
          // Only reached when an earlier first run wrote the configuration but not the policy.
          status.textContent = "上次首次配置未完成：本机配置已保存，启动策略尚未写入。";
          panel.append(
            element(
              "p",
              "点击完成后会写入自动启动策略并请求启动，随后进入主页面。安装与登录情况不因完成配置而改变。",
              "muted",
            ),
          );
          actions.append(button("完成并进入主页面", () => control.complete(), control.busy));
        } else if (state.kind === "completing") {
          status.textContent = "正在完成首次配置并请求启动，请等待。不要重复初始化或强制退出。";
          panel.setAttribute("aria-busy", "true");
        } else {
          status.textContent = "首次配置已完成，已请求启动，正在进入主页面。";
        }
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
      if (canDismiss()) actions.append(button("返回工作空间", cancel, control.submitting));
      // An empty action row is still a row: it would leave a gap under the note for buttons that
      // were never drawn. The container goes in only when something is in it.
      if (actions.children.length > 0) panel.append(actions);
    }
    if (focus) (root.querySelector<HTMLElement>(".setup-error") ?? title).focus();
  }
  return { render, dispose: clearKey };
}
