// Failure mode: a bare snapshot is not the versioned push event the renderer accepts.
import { desktopRuntimeSnapshotOf, type DesktopRuntimeEvent } from "../../host/desktop-run-contract.ts";

type RuntimeState = Parameters<typeof desktopRuntimeSnapshotOf>[0];

export function desktopRuntimeEventOf(state: RuntimeState): DesktopRuntimeEvent {
  return {
    version: 1,
    state: desktopRuntimeSnapshotOf({
      status: state.status,
      role: state.role,
      ownership: state.ownership,
      pendingSync: state.pendingSync,
      error: state.error,
    }),
  };
}
