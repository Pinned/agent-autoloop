// Reuse the bounded transport engine, not run identity or run-shaped DTOs.
import { createTaskQuerySource, type TaskQuerySourceOptions } from "./task-query-source.ts";
import { parseBusinessRequest, type BusinessRequest, type BusinessResponse } from "./business-task-ipc.ts";
import {
  parseBusinessTaskListBytes,
  parseBusinessTaskDetailBytes,
  parseBusinessTimeline,
} from "../../host/business-task-contract.ts";
export function createBusinessTaskSource(options: TaskQuerySourceOptions) {
  const transport = createTaskQuerySource(options);
  return {
    async read(raw: BusinessRequest, canRead?: () => boolean): Promise<BusinessResponse> {
      let request: BusinessRequest;
      try {
        request = parseBusinessRequest(raw);
      } catch {
        return { ok: false, error: "invalid" };
      }
      const root = "/v1/ui/business-tasks";
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(request.input)) {
        if (key !== "key" && value !== undefined) {
          try {
            if (typeof value === "string") encodeURIComponent(value);
          } catch {
            return { ok: false, error: "invalid" };
          }
          params.set(key, String(value));
        }
      }
      const query = params.size ? `?${params}` : "";
      if (new TextEncoder().encode(query).byteLength > 2048) return { ok: false, error: "invalid" };
      if (request.operation === "list")
        return transport.businessRead(root + query, parseBusinessTaskListBytes, true, canRead);
      const path = `${root}/${request.input.key.replace(":", "/")}${query}`;
      if (request.operation === "timeline")
        return transport.businessRead(
          path,
          (bytes) => parseBusinessTimeline(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
          false,
          canRead,
        );
      return transport.businessRead(
        path,
        (bytes) => {
          const data = parseBusinessTaskDetailBytes(bytes);
          if (data.task.key !== request.input.key) throw new Error("wrong-task");
          return data;
        },
        false,
        canRead,
      );
    },
    cancelAll: () => transport.cancelAll(),
  };
}
