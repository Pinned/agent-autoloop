// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  contextFile: string;
  folder: string;
};
export type Reading = { text?: string; session?: string; usage?: Usage; error?: string; finished?: boolean };
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. `command` is the
   * agent's configured launcher when one replaces the usual program. */
  check?(command?: string[]): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

const found = new Map<string, string | null>();

/** Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  // An explicit path needs no shell PATH or login configuration; resolve relative paths from the caller's cwd.
  if (name.includes(path.sep)) {
    const program = path.resolve(name);
    try {
      if (statSync(program).isFile()) {
        // Windows does not enforce POSIX execute bits; still require an accessible regular file.
        accessSync(program, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return program;
      }
    } catch {}
    throw new Error(`找不到 ${name}：先装好并登录`);
  }
  if (!found.has(name)) {
    const shell = process.env.SHELL ?? "/bin/sh";
    let onPath: string | null = null;
    try {
      // Keep the program name in argv, never in shell source. fish puts both trailing arguments in $argv;
      // POSIX-style shells use the sentinel as $0 and the name as $1. Both retain the login shell's PATH.
      const query = path.basename(shell) === "fish" ? 'command --search -- "$argv[2]"' : 'command -v -- "$1"';
      const printed = execFileSync(shell, ["-lc", query, "agent-autoloop-lookup", name], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      onPath = printed.trim().split("\n").at(-1) || null;
    } catch {}
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
