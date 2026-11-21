// Antigravity CLI (agy): runs non-interactively with stream-json output, capturing conversation_id early for session
// continuation and receipt repair.
import { homedir } from "node:os";
import path from "node:path";
import { findProgram, tail, type Adapter, type Turn, type Usage } from "../../worker/agents.ts";
import { readAgyHistory } from "./history.ts";

const MODE = { read: "plan", edit: "accept-edits", full: "auto" } as const;

function launcher(turn: Turn) {
  const [head, ...rest] = turn.command ?? [];
  return head ? [findProgram(head), ...rest] : [findProgram("agy", () => [path.join(homedir(), ".local/bin/agy")])];
}

function usageOf(raw: any): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    ...(typeof raw.input_tokens === "number" && { input: raw.input_tokens }),
    ...(typeof raw.output_tokens === "number" && { output: raw.output_tokens }),
    ...(typeof raw.cache_read_tokens === "number" && { cached: raw.cache_read_tokens }),
  };
}

export default {
  history: {
    reference: (turn) =>
      turn.command?.length ? null : { cwd: path.resolve(turn.cwd), session: turn.resume ?? turn.session },
    read: readAgyHistory,
  },
  command: (turn) => [
    ...launcher(turn),
    "--output-format",
    "stream-json",
    "--mode",
    MODE[turn.access],
    ...(turn.access === "read" ? ["--sandbox"] : []),
    ...(turn.access === "full" ? ["--dangerously-skip-permissions"] : []),
    ...(turn.resume ? ["--conversation", turn.resume] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--effort", turn.effort] : []),
    "--add-dir",
    turn.folder,
    `-p=${turn.prompt}`,
  ],
  read(stdout, code, stderr) {
    let session: string | undefined;
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const id = event?.conversation_id ?? event?.step_update?.conversation_id ?? event?.result?.conversation_id;
      if (typeof id === "string" && id) session = id;
      if (event?.event !== "result" || !event.result) continue;
      const result = event.result;
      const usage = usageOf(result.usage);
      const said = String(result.response ?? "");
      if (result.status !== "SUCCESS" || result.error) {
        const error = String(result.error || said.split("\n")[0] || result.status || "没留下结果").split("\n")[0];
        return { ...(session && { session }), ...(usage && { usage }), finished: true, error };
      }
      return { text: said, ...(session && { session }), ...(usage && { usage }), finished: true };
    }
    if (code === null) return session ? { session } : {};
    return { ...(session && { session }), error: tail(stderr || stdout) || "没留下结果" };
  },
  link: (session) => `agy://conversation/${session}`,
  check(command?: string[]) {
    const program = command?.[0] ?? "agy";
    try {
      if (command?.length) findProgram(command[0]);
      else findProgram("agy", () => [path.join(homedir(), ".local/bin/agy")]);
      return null;
    } catch {
      return `找不到 ${program}：先装好它`;
    }
  },
} satisfies Adapter;
