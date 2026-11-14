// Business identity is validated in both processes; no runtime or transport imports here.
import {
  parseBusinessTaskListInput,
  parseBusinessTaskDetailInput,
  parseBusinessTimeline,
  parseBusinessTaskList,
  parseBusinessTaskDetail,
  type BusinessTaskList,
  type BusinessTaskDetail,
  type BusinessTimeline,
} from "../../host/business-task-contract.ts";
import type { TaskQueryError } from "./task-query-source.ts";
export type BusinessRequest =
  | { operation: "list"; input: ReturnType<typeof parseBusinessTaskListInput> }
  | { operation: "detail" | "timeline"; input: ReturnType<typeof parseBusinessTaskDetailInput> };
export type BusinessResponse =
  { ok: true; data: BusinessTaskList | BusinessTaskDetail | BusinessTimeline } | { ok: false; error: TaskQueryError };
const errors = [
  "unavailable",
  "no-hub",
  "invalid",
  "unauthorized",
  "not-found",
  "unsupported",
  "timeout",
  "aborted",
  "error",
];
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((k) => typeof k !== "string" || !fields.includes(k)))
    throw new Error("invalid");
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid");
  }
  return value as Record<string, unknown>;
}
export function parseBusinessRequest(value: unknown): BusinessRequest {
  const r = record(value, ["operation", "input"]);
  if (r.operation === "list") return { operation: "list", input: parseBusinessTaskListInput(r.input) };
  if (r.operation !== "detail" && r.operation !== "timeline") throw new Error("invalid");
  const input = parseBusinessTaskDetailInput(r.input);
  if (r.operation === "detail" && (input.limit !== undefined || input.before !== undefined)) throw new Error("invalid");
  if (r.operation === "timeline" && input.before === undefined) throw new Error("invalid");
  return { operation: r.operation, input };
}
export function parseBusinessResponse(value: unknown, request: BusinessRequest): BusinessResponse {
  if (!value || typeof value !== "object") throw new Error("invalid");
  const d = Object.getOwnPropertyDescriptor(value, "ok");
  if (!d || !("value" in d)) throw new Error("invalid");
  if (d.value === false) {
    const r = record(value, ["ok", "error"]);
    if (typeof r.error !== "string" || !errors.includes(r.error)) throw new Error("invalid");
    return { ok: false, error: r.error as TaskQueryError };
  }
  const r = record(value, ["ok", "data"]);
  if (r.ok !== true) throw new Error("invalid");
  const data =
    request.operation === "list"
      ? parseBusinessTaskList(r.data)
      : request.operation === "timeline"
        ? parseBusinessTimeline(r.data)
        : parseBusinessTaskDetail(r.data);
  if (request.operation === "detail" && (data as BusinessTaskDetail).task.key !== request.input.key)
    throw new Error("wrong-task");
  return { ok: true, data };
}
export function createBusinessTaskIpc(options: {
  assertSender(event: unknown): void;
  read(request: BusinessRequest, canRead: () => boolean): Promise<BusinessResponse>;
  presentation: {
    acquireTaskLease(): object | undefined;
    checkTaskLease(lease: object): boolean;
    releaseTaskLease(lease: object): void;
  };
}) {
  return {
    async read(event: unknown, args: readonly unknown[]): Promise<BusinessResponse> {
      options.assertSender(event);
      let request: BusinessRequest;
      try {
        if (args.length !== 1) throw new Error("invalid");
        request = parseBusinessRequest(args[0]);
      } catch {
        return { ok: false, error: "invalid" };
      }
      let lease: object | undefined;
      try {
        lease = options.presentation.acquireTaskLease();
      } catch {
        /* Fail closed. */
      }
      if (!lease) return { ok: false, error: "unavailable" };
      const own = lease;
      const canRead = () => {
        try {
          return options.presentation.checkTaskLease(own);
        } catch {
          return false;
        }
      };
      try {
        if (!canRead()) return { ok: false, error: "aborted" };
        const response = parseBusinessResponse(await options.read(request, canRead), request);
        return canRead() ? response : { ok: false, error: "aborted" };
      } catch {
        return { ok: false, error: canRead() ? "error" : "aborted" };
      } finally {
        try {
          options.presentation.releaseTaskLease(own);
        } catch {
          /* Independent cleanup. */
        }
      }
    },
  };
}
