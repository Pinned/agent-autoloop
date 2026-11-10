// The reconnect page is the only honest statement that this hub is not ours and is not answering.
// It exists because every other page behind the menu would be a read of a hub that is not there.
//
// What it may promise is decided here, not by the caller: the command and its copy button are facts
// the app can always provide, while "reconnect now" and "use the embedded hub" are capabilities of
// a controller that may not exist yet. A button is drawn only when its action is supplied, so this
// page can never show a control that silently does nothing.
import { LAUNCH_COMMAND } from "../launch-command.ts";

export type ReconnectActions = {
  /** Copies the command through the main process; a sandboxed page has no clipboard of its own. */
  copy?: () => Promise<void>;
  /** Probe the attached hub again now, without starting or switching anything. */
  reconnect?: () => Promise<unknown> | void;
  /** Move this app to its own embedded hub. Only ever a user choice, never automatic. */
  useEmbedded?: () => Promise<unknown> | void;
  /** Leave the app; while this page is up there is no workspace behind it to return to. */
  exit?: () => void;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

export function mountReconnectView(root: HTMLElement, actions: ReconnectActions = {}) {
  // A copy that settles after the page is gone must not write into a detached document.
  let closed = false;
  let copying = false;
  let reconnecting = false;
  let switching = false;

  root.replaceChildren();
  root.setAttribute("aria-labelledby", "reconnect-title");

  const header = element("header", "", "page-head");
  const title = element("h1", "本机中台未响应");
  title.id = "reconnect-title";
  title.tabIndex = -1;
  const copy = element("div", "", "page-head-copy");
  copy.append(
    element("div", "桌面应用 / 本机中台", "eyebrow"),
    title,
    element(
      "p",
      "应用连接的本机中台由终端中的 agent-autoloop 运行并管理。它当前没有响应，应用会按原有配置继续重连，不会改用应用内置中台。",
    ),
  );
  header.append(copy);
  root.append(header);

  const panel = element("section", "", "panel setup-panel reconnect-panel");
  panel.setAttribute("aria-labelledby", "reconnect-title");
  root.append(panel);

  const status = element("p", "", "setup-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.append(status);

  panel.append(element("h2", "在终端启动它"));
  const command = element("div", "", "reconnect-command");
  command.append(element("code", LAUNCH_COMMAND));
  if (actions.copy) {
    const copyButton = element("button", "复制命令");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => {
      if (copying) return;
      copying = true;
      copyButton.disabled = true;
      status.textContent = "正在复制命令，请稍等。";
      void actions
        .copy!()
        .then(
          () => {
            if (!closed) status.textContent = "命令已复制，可以直接粘贴到终端执行。";
          },
          () => {
            if (!closed) status.textContent = "复制失败，请手动选择命令复制。";
          },
        )
        .finally(() => {
          copying = false;
          if (!closed) copyButton.disabled = false;
        });
    });
    command.append(copyButton);
  }
  panel.append(command);
  panel.append(
    element("p", "如果它已经在运行，请确认它监听在原来的回环地址与端口；应用不会停止或接管它。", "muted"),
  );

  // An empty action row is still a row: it would leave a gap under the note for buttons that were
  // never drawn. The container exists only when something can go in it.
  if (actions.reconnect || actions.useEmbedded || actions.exit) {
    const buttons = element("div", "", "setup-actions");
    if (actions.reconnect) {
      const reconnect = element("button", "已启动，重连");
      reconnect.type = "button";
      reconnect.addEventListener("click", () => {
        if (reconnecting) return;
        reconnecting = true;
        reconnect.disabled = true;
        status.textContent = "正在重新检查本机中台，请稍等。";
        void Promise.resolve()
          .then(() => actions.reconnect!())
          .then(
            () => {
              // The page removes itself when the hub answers; if it is still here, say only what
              // was actually confirmed — one more check ran and the page did not move.
              if (!closed) status.textContent = "已完成一次重连检查；如仍未连接，请确认启动命令已在终端执行。";
            },
            () => {
              if (!closed) status.textContent = "重连检查未完成，请稍后重试。";
            },
          )
          .finally(() => {
            reconnecting = false;
            if (!closed) reconnect.disabled = false;
          });
      });
      buttons.append(reconnect);
    }
    if (actions.useEmbedded) {
      const embedded = element("button", "使用 App 内置");
      embedded.type = "button";
      embedded.addEventListener("click", () => {
        if (switching) return;
        switching = true;
        embedded.disabled = true;
        status.textContent = "正在启动 App 内置中台，请稍等。";
        void Promise.resolve()
          .then(() => actions.useEmbedded!())
          .catch(() => {
            // The action reports its own failures; this page only restores the button so the user
            // is never left with a dead control and no statement about what happened.
            if (!closed) status.textContent = "切换到 App 内置中台未完成，请稍后重试。";
          })
          .finally(() => {
            switching = false;
            if (!closed) embedded.disabled = false;
          });
      });
      buttons.append(embedded);
    }
    if (actions.exit) {
      const exit = element("button", "退出应用…");
      exit.type = "button";
      exit.addEventListener("click", () => actions.exit!());
      buttons.append(exit);
    }
    panel.append(buttons);
  }

  title.focus();
  return {
    dispose() {
      closed = true;
    },
  };
}
