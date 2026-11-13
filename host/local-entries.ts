// Pure production logic. Filesystem paths, runtime state and side effects belong to adapters.
import { parseCron } from "../kernel/cron.ts";
import { InputError } from "../kernel/errors.ts";
import { RulesError, TYPE_PATTERN } from "../protocol/rules.ts";
import {
  matchesRulesDeclaration,
  parseRulesDeclaration,
  runSynchronousHook,
  sameRulesBaseline,
  type RulesBaseline,
  type RulesParser,
} from "./rules-baseline.ts";

export type Entry = Record<string, unknown>;
const isObject = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// The two shapes a local slot may take: an event entry carries when.source === "local", a timed one
// carries when.cron plus the local mark. Both belong to the desktop's entry list; neither is a trigger.
export const takesLocal = (rule: unknown) =>
  isObject(rule) &&
  isObject(rule.when) &&
  (rule.when.source === "local" || (typeof rule.when.cron === "string" && rule.when.local === true));

export type LocalEntriesReaderOptions = {
  read(): string;
  parse(json: string): unknown;
  applied(): unknown;
  baseline?(): RulesBaseline;
};

export function createLocalEntriesReader(options: LocalEntriesReaderOptions) {
  function declaration(applied: RulesBaseline): { rules: Entry[]; baseline: RulesBaseline } | null {
    try {
      const json = options.read();
      const parsed = parseRulesDeclaration(json, options.parse as RulesParser);
      if (
        options.baseline
          ? !matchesRulesDeclaration(parsed, applied)
          : JSON.stringify(parsed.effective) !== JSON.stringify(applied.effective)
      )
        return null;
      return { rules: parsed.raw.rules, baseline: applied };
    } catch {
      return null;
    }
  }
  const current = (): RulesBaseline =>
    options.baseline?.() ?? { rulesSeq: 0, effective: options.applied() as RulesBaseline["effective"] };
  let snapshot = declaration(current());
  const read = (applied = current()) => {
    snapshot = declaration(applied) ?? snapshot;
    if (!snapshot || !sameRulesBaseline(snapshot.baseline, applied) || (options.baseline && !applied.declarationHash))
      throw new InputError("无法读取已生效规则的原始声明，请先修复 rules.json");
    return snapshot.rules.filter(takesLocal).map((rule) => {
      const when = rule.when as { types?: string[]; cron?: string };
      const entry: Entry = {
        name: rule.name,
        ...(when.cron !== undefined ? { cron: when.cron } : { types: [...((when.types ?? []) as string[])] }),
        to: rule.to,
        cwd: rule.cwd,
      };
      for (const field of ["prompt", "skill", "parallel", "group", "autoGroup", "pauseOnAsk", "tell", "emits"])
        if (rule[field] !== undefined)
          entry[field] = field === "emits" ? JSON.parse(JSON.stringify(rule[field])) : rule[field];
      return entry;
    });
  };
  return read;
}

/** The unchanged HTTP entry checker: full reference validation happens on the merged file. */
export function checkedLocalEntry(given: unknown): Entry {
  if (!isObject(given)) throw new InputError("每个入口要是一个对象");
  const entry = given;
  for (const name of Object.keys(entry))
    if (
      ![
        "name",
        "types",
        "cron",
        "to",
        "cwd",
        "prompt",
        "skill",
        "parallel",
        "group",
        "autoGroup",
        "pauseOnAsk",
        "tell",
        "emits",
      ].includes(name)
    )
      throw new InputError(`入口有不认识的字段 ${name}`);
  const text = (name: string, optional = false) => {
    const value = entry[name];
    if (value === undefined || value === "") {
      if (optional) return undefined;
      throw new InputError(`入口缺少 ${name}`);
    }
    if (typeof value !== "string" || !value.trim()) throw new InputError(`入口的 ${name} 要是文字`);
    return value.trim();
  };
  const name = text("name")!;
  // Exactly one trigger: an event entry lists types, a timed one names a cron. Anything else would
  // write a rule that never runs (or runs by surprise) under one of the two when shapes.
  const types = entry.types;
  const cron = text("cron", true);
  let checkedTypes: string[] | undefined;
  if (cron === undefined) {
    if (
      !Array.isArray(types) ||
      !types.length ||
      !types.every((type) => typeof type === "string" && TYPE_PATTERN.test(type))
    )
      throw new InputError(`入口「${name}」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配`);
    checkedTypes = types;
  } else if (types !== undefined) throw new InputError(`入口「${name}」的 types 和 cron 只能选一个`);
  else if (parseCron(cron) === null) throw new InputError(`入口「${name}」的 cron 不是有效的写法`);
  for (const field of ["autoGroup", "pauseOnAsk"])
    if (entry[field] !== undefined && typeof entry[field] !== "boolean")
      throw new InputError(`入口的 ${field} 要是 true 或 false`);
  const parallel = entry.parallel;
  if (parallel !== undefined && (!Number.isInteger(parallel) || (parallel as number) <= 0))
    throw new InputError(`入口「${name}」的 parallel 要是正整数`);
  const tell = text("tell", true);
  if (tell !== undefined && !["always", "needed", "never"].includes(tell))
    throw new InputError(`入口「${name}」的 tell 只能是 always、needed、never`);
  let emits: Entry | undefined;
  if (entry.emits !== undefined) {
    const where = `入口「${name}」的 emits `;
    if (!isObject(entry.emits)) throw new InputError(`${where}要是一个对象`);
    const filter = entry.emits;
    for (const field of Object.keys(filter))
      if (!["source", "types"].includes(field)) throw new InputError(`${where}有不认识的字段 ${field}`);
    for (const field of ["source", "types"])
      if (filter[field] === undefined || filter[field] === "") throw new InputError(`${where}缺少 ${field}`);
    const source = typeof filter.source === "string" ? filter.source.trim() : "";
    if (!Array.isArray(filter.types) || !filter.types.every((word) => typeof word === "string" && word.trim()))
      throw new InputError(`入口「${name}」的 emits.types要是文字的列表`);
    const patterns = filter.types.map((word: string) => word.trim());
    if (source === "schedule" || !patterns.length || !patterns.every((type) => TYPE_PATTERN.test(type)))
      throw new InputError(`入口「${name}」的 emits 要是非保留来源和事件类型列表`);
    emits = { source, types: patterns };
  }
  return {
    name,
    ...(cron !== undefined ? { cron } : { types: checkedTypes! }),
    to: text("to")!,
    cwd: text("cwd")!,
    ...(text("group", true) && { group: text("group", true) }),
    ...(entry.autoGroup !== undefined && { autoGroup: entry.autoGroup }),
    ...(entry.pauseOnAsk !== undefined && { pauseOnAsk: entry.pauseOnAsk }),
    ...(tell !== undefined && { tell }),
    ...(emits !== undefined && { emits }),
    ...(text("prompt", true) && { prompt: text("prompt", true) }),
    ...(text("skill", true) && { skill: text("skill", true) }),
    ...(parallel !== undefined && { parallel: parallel as number }),
  };
}

export function checkedLocalEntriesBody(given: unknown): { entries: Entry[]; rulesSeq?: number } {
  if (Array.isArray(given)) return { entries: given.map(checkedLocalEntry) };
  if (
    !isObject(given) ||
    Object.keys(given).some((key) => !["entries", "rulesSeq"].includes(key)) ||
    !Object.hasOwn(given, "entries") ||
    !Object.hasOwn(given, "rulesSeq") ||
    !Array.isArray(given.entries) ||
    !Number.isSafeInteger(given.rulesSeq) ||
    (given.rulesSeq as number) < 1
  )
    throw new InputError("入口要是列表，或带 entries 和有效 rulesSeq 的对象");
  return { entries: given.entries.map(checkedLocalEntry), rulesSeq: given.rulesSeq as number };
}

export type LocalEntriesWriteIO = {
  read(): string;
  validate(json: string): unknown;
  write(json: string): void;
  rename(): void;
  beforeMerge?(text: string): undefined;
  afterRename?(): undefined;
};

export class LocalEntriesValidationError extends InputError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super("规则校验未通过");
    this.issues = issues
      .slice(0, 8)
      .map((issue) => [...issue.replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, 300).join(""));
  }
}

export function writeLocalEntriesWith(entries: Entry[], io: LocalEntriesWriteIO): void {
  const text = io.read();
  if (io.beforeMerge) runSynchronousHook(() => io.beforeMerge!(text));
  const whole: unknown = JSON.parse(text);
  if (!isObject(whole)) throw new InputError("rules.json 不是一个对象");
  if (!Array.isArray(whole.rules) || !isObject(whole.sources))
    throw new InputError("rules.json 缺少 rules 或 sources，先把它修好再用网页改");
  const previous = whole.rules as Entry[];
  if (!("local" in whole.sources)) whole.sources = { ...whole.sources, local: { name: "本机" } };
  const replacements = entries.map((entry) => {
    const rule: Entry = {
      name: entry.name,
      when: entry.cron !== undefined ? { cron: entry.cron, local: true } : { source: "local", types: entry.types },
      to: entry.to,
      cwd: entry.cwd,
    };
    for (const field of ["prompt", "skill", "parallel", "group", "autoGroup", "pauseOnAsk", "tell", "emits"])
      if (entry[field] !== undefined) rule[field] = entry[field];
    return rule;
  });
  const lastLocal = previous.findLastIndex(takesLocal);
  let next = 0;
  whole.rules = previous.flatMap((rule, index) => {
    if (!takesLocal(rule)) return [rule];
    if (index === lastLocal) return replacements.slice(next);
    return next < replacements.length ? [replacements[next++]] : [];
  });
  if (lastLocal === -1) (whole.rules as Entry[]).push(...replacements);
  const json = `${JSON.stringify(whole, null, 2)}\n`;
  try {
    io.validate(json);
  } catch (error) {
    // Only this phase proves no write has started; reload errors must remain uncertain.
    if (error instanceof RulesError) throw new LocalEntriesValidationError(error.issues);
    throw error;
  }
  io.write(json);
  io.rename();
  if (io.afterRename) runSynchronousHook(io.afterRename);
}
