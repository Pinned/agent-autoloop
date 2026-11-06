// rules.json from the owner's own side: the task entries the web console may add, merged into the file the host
// already watches. Only the rules that take events from the local source are replaced; everything else in the file is
// kept as it is. The merged whole is checked before anything reaches the disk, so what runs never sees a mistake.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { parseRules } from "../protocol/rules.ts";
import { InputError } from "../kernel/errors.ts";

/** A task entry as the console sends it: what may be set from the web page, and nothing else. */
export type Entry = {
  name: string;
  types: string[];
  to: string;
  cwd: string;
  prompt?: string;
  skill?: string;
  parallel?: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A rule that takes events the person sends by hand, as opposed to one fed by a cron or an outside source. */
export const takesLocal = (rule: unknown) => isObject(rule) && isObject(rule.when) && rule.when.source === "local";

function readWhole(): Record<string, unknown> {
  const whole: unknown = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  if (!isObject(whole)) throw new InputError("rules.json 不是一个对象");
  return whole;
}

/** Replace the local-source rules with these entries, keep the rest of the file, check the whole, then swap it in. */
export function writeLocalEntries(entries: Entry[]) {
  const whole = readWhole();
  if (!Array.isArray(whole.rules) || !isObject(whole.sources)) {
    throw new InputError("rules.json 缺少 rules 或 sources，先把它修好再用网页改");
  }
  const kept = whole.rules.filter((rule) => !takesLocal(rule));
  if (!("local" in whole.sources)) whole.sources = { ...whole.sources, local: { name: "本机" } };
  whole.rules = [
    ...kept,
    ...entries.map((entry) => ({
      name: entry.name,
      when: { source: "local", types: entry.types },
      to: entry.to,
      cwd: entry.cwd,
      ...(entry.prompt && { prompt: entry.prompt }),
      ...(entry.skill && { skill: entry.skill }),
      ...(entry.parallel && { parallel: entry.parallel }),
    })),
  ];
  const json = `${JSON.stringify(whole, null, 2)}\n`;
  parseRules(json, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  mkdirSync(dirname(RULES_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(`${RULES_FILE}.tmp`, json, { mode: 0o600 });
  renameSync(`${RULES_FILE}.tmp`, RULES_FILE);
}
