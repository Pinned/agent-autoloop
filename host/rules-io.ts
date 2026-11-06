// rules.json from the owner's own side. The console never rewrites the whole file: it hands over one section at a
// time — the agents roster, the rules, a channel — and only that section is replaced; the rest of the file is kept
// as it is. The merged whole is checked before anything reaches the disk, so what runs never sees a mistake.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { parseRules } from "../protocol/rules.ts";
import { InputError } from "../kernel/errors.ts";

// The sections of rules.json the console may replace, as the page sends them. Keyed by the id the page asks for;
// each reader gathers its own fields, so a value that is not on the list is dropped rather than stored unknown.
export type Section =
  | { kind: "agents"; agents: Record<string, Entry> }
  | { kind: "rules"; rules: Entry[] }
  | { kind: "sources"; sources: Record<string, Entry> }
  | { kind: "channels"; channels: Record<string, Entry> }
  | { kind: "elsewhere"; elsewhere: Entry[] }
  | { kind: "settings"; timezone: string; askFirst: string[] };

/** One thing as the console sends it: a plain record of fields the page could have shown. */
export type Entry = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A rule that takes events the person sends by hand, as opposed to one fed by a cron or an outside source. */
export const takesLocal = (rule: unknown) => isObject(rule) && isObject(rule.when) && rule.when.source === "local";

function readWhole(): Record<string, unknown> {
  const whole: unknown = JSON.parse(readFileSync(RULES_FILE, "utf8"));
  if (!isObject(whole)) throw new InputError("rules.json 不是一个对象");
  return whole;
}

/** One section swapped in, the rest kept, the whole checked, then the file atomically replaced. */
export function writeSection(section: Section) {
  const whole = readWhole();
  if (!Array.isArray(whole.rules) || !isObject(whole.sources)) {
    throw new InputError("rules.json 缺少 rules 或 sources，先把它修好再用网页改");
  }
  switch (section.kind) {
    case "agents":
      whole.agents = section.agents;
      break;
    case "rules":
      whole.rules = section.rules;
      break;
    case "sources":
      // The reserved id is not the owner's to take; dropping it here keeps the check's wording the only story.
      delete section.sources.schedule;
      whole.sources = { ...section.sources, schedule: whole.sources.schedule };
      break;
    case "channels":
      whole.channels = section.channels;
      break;
    case "elsewhere":
      whole.elsewhere = section.elsewhere;
      break;
    case "settings":
      whole.timezone = section.timezone;
      whole.askFirst = section.askFirst;
      break;
  }
  const json = `${JSON.stringify(whole, null, 2)}\n`;
  parseRules(json, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  mkdirSync(dirname(RULES_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(`${RULES_FILE}.tmp`, json, { mode: 0o600 });
  renameSync(`${RULES_FILE}.tmp`, RULES_FILE);
}

/** Replace the local-source rules with these entries, keep the rest of the file, check the whole, then swap it in. */
export function writeLocalEntries(entries: Entry[]) {
  const whole = readWhole();
  if (!Array.isArray(whole.rules) || !isObject(whole.sources)) {
    throw new InputError("rules.json 缺少 rules 或 sources，先把它修好再用网页改");
  }
  const kept = (whole.rules as unknown[]).filter((rule) => !takesLocal(rule)) as unknown[] as Entry[];
  if (!("local" in whole.sources)) whole.sources = { ...whole.sources, local: { name: "本机" } };
  writeSection({
    kind: "rules",
    rules: [
      ...kept,
      ...entries.map((entry) => {
        const rule: Entry = {
          name: entry.name,
          when: { source: "local", types: entry.types },
          to: entry.to,
          cwd: entry.cwd,
        };
        if (entry.prompt) rule.prompt = entry.prompt;
        if (entry.skill) rule.skill = entry.skill;
        if (entry.parallel) rule.parallel = entry.parallel;
        return rule;
      }),
    ],
  });
}
