export function createLifecycle(actions: { hide(): void; restore(): void; exit(): void; confirm(): Promise<boolean> }) {
  let quitting = false;
  let pending: Promise<void> | undefined;
  return {
    get quitting() {
      return quitting;
    },
    close() {
      if (quitting) return true;
      actions.hide();
      return false;
    },
    restore() {
      actions.restore();
    },
    requestQuit(): Promise<void> {
      if (quitting) return Promise.resolve();
      if (pending) return pending;
      pending = actions
        .confirm()
        .then((confirmed) => {
          if (confirmed) {
            quitting = true;
            actions.exit();
          }
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
