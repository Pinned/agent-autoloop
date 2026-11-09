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

export function mountSetupView(root: HTMLElement, control: Controller, close: () => void) {
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
    const currentWizard =
      state.kind === "wizard"
        ? state
        : state.kind === "checking" || state.kind === "submitting" || state.kind === "probing"
          ? state.wizard
          : undefined;
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
      element("p", "先选择此电脑的角色并保存配置，再明确完成首次配置并请求启动。保存本身不会启动。"),
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

    if (
      state.kind === "wizard" ||
      state.kind === "checking" ||
      state.kind === "submitting" ||
      state.kind === "probing"
    ) {
      const wizard = state.kind === "wizard" ? state : state.wizard;
      const busy = control.busy;
      panel.setAttribute("aria-busy", String(busy));
      const steps = element("ol", "", "setup-steps");
      ["选择角色", "配置本机", "检查与确认"].forEach((text, index) => {
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
      } else if (wizard.step === 2) {
        form.append(element("h2", roles[wizard.role]));
        if (wizard.role === "hub-worker") {
          form.append(
            element("p", "先只读检查有限的本机回环地址；不会扫描旧安装配置或读取密钥，不停止或接管已有服务。", "muted"),
            element("p", "内置中台使用应用独立数据目录与可用端口。原任务与记录保留在原中台，不会自动迁移。", "muted"),
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
          form.append(element("p", "本步不连接中台。密钥在最后确认前填写。", "muted"));
        }
      } else {
        form.append(element("h2", "确认本机配置"), element("p", `角色：${roles[wizard.role]}`, "muted"));
        if (wizard.role === "worker") {
          form.append(
            element("p", `中台：${wizard.draft.url}`, "muted"),
            element("p", `本机：${wizard.draft.worker}`, "muted"),
          );
        }
        if (wizard.role === "hub-worker") {
          form.append(button("检查本机已有中台", () => control.probe(), busy));
          if (control.probeResult) {
            const outcomes = {
              unavailable: "未获得响应（可能未运行或超时，不代表本机没有中台）",
              unrecognized: "响应不是可识别的中台协议",
              "credentials-required": "需要显式凭证，尚未认证（不代表没有中台）",
              incompatible: "协议不兼容",
            };
            const list = element("ul", "", "setup-checks");
            for (const candidate of control.probeResult.candidates)
              list.append(element("li", `${candidate.url}：${outcomes[candidate.outcome]}`));
            form.append(
              list,
              element(
                "p",
                "目前尚不支持本次接入已有中台。继续会准备应用独立内置中台，不读取已有凭证、不接管外部服务。",
                "muted",
              ),
              element("p", "下次启动使用应用独立中台；原任务与记录保留在原中台，不会自动迁移。", "muted"),
            );
          }
        }
        form.append(button("检查执行程序安装", () => control.check(), busy));
        form.append(element("p", "只检查受限目录中的安装。未发现可能是漏报；Claude / Codex 登录均未验证。", "muted"));
        if (wizard.check && wizard.check !== "skipped") {
          const list = element("ul", "", "setup-checks");
          for (const agent of wizard.check.agents)
            list.append(
              element(
                "li",
                `${agent.id === "claude" ? "Claude" : "Codex"}：${agent.installation === "found" ? "已发现安装" : "未发现安装"} · 登录未验证`,
              ),
            );
          form.append(list);
        } else if (wizard.check === "skipped") {
          form.append(element("p", "你已确认跳过安装检查；安装与登录均未验证。", "muted"));
        }
        if (wizard.checkError === "operation-failed") {
          const skip = element("label", "", "setup-skip");
          const checkbox = element("input");
          checkbox.type = "checkbox";
          checkbox.disabled = busy;
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) control.skipCheck();
          });
          skip.append(checkbox, document.createTextNode("我了解安装检查未完成，确认跳过此次检查。"));
          form.append(skip);
        }
        if (wizard.role === "worker" && wizard.check && !busy) {
          keyInput = field(
            form,
            "setup-key",
            "执行机加入密钥",
            "",
            "使用独立执行机凭证，不要填写中台管理凭证。仅用于保存；提交后立即清空，不在此验证远端有效性。",
            true,
          );
        }
        form.append(
          element("p", "保存不会启动运行服务。纯执行机配置保存后，请前往执行机页启动并检查运行状态。", "muted"),
        );
      }
      if (wizard.checkError === "unavailable")
        form.append(
          element("p", "此检查只使用已有运行资源，不会自动下载。运行资源不可用时，无法确认 Agent 安装情况。", "muted"),
        );
      if (wizard.error) {
        const error = element("p", wizard.error, "setup-error");
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        form.append(error);
      }
      status.textContent =
        state.kind === "probing"
          ? "正在只读检查指定回环地址，不会接管或停止已有服务。"
          : state.kind === "checking"
            ? "正在检查安装，请等待。离开页面不会取消检查。"
            : state.kind === "submitting"
              ? "正在保存本机配置，请等待。隐藏窗口不会取消操作。"
              : "";
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
      const submit = element("button", wizard.step === 3 ? "确认保存本机配置" : "下一步");
      submit.type = "submit";
      submit.disabled =
        busy || (wizard.step === 3 && (!wizard.check || (wizard.role === "hub-worker" && !control.probeResult)));
      submit.className = "setup-primary";
      actions.append(submit, button("暂不配置", cancel, control.submitting));
      form.append(actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (control.busy) return;
        if (wizard.step === 3) {
          const input = keyInput;
          try {
            control.submit(input?.value);
          } finally {
            // submit() may synchronously redraw and install a new secret control.
            // Only erase the old captured control; never discard the new reference.
            if (input) input.value = "";
          }
        } else {
          const url = form.querySelector<HTMLInputElement>("#setup-url")?.value;
          const worker = form.querySelector<HTMLInputElement>("#setup-worker")?.value;
          control.next(url !== undefined && worker !== undefined ? { url, worker } : undefined);
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
          panel.append(element("p", "本次及下次使用应用独立中台。原任务与记录保留在原中台，不会自动迁移。", "muted"));
      } else if (state.kind === "configured") {
        status.textContent = state.created ? "本机配置已保存。" : "这台电脑已有配置，本轮不提供覆盖或切换角色。";
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
      actions.append(button("返回工作空间", cancel, control.submitting));
      panel.append(actions);
    }
    if (focus) (root.querySelector<HTMLElement>(".setup-error") ?? title).focus();
  }
  return { render, dispose: clearKey };
}
